// The bypass-blocked test — the proof of option (b) over option (a).
//
// WHAT IT PROVES. A live run with a grant for host A ONLY cannot reach host B,
// even when the run does NOT cooperate with the scope proxy. The scope proxy
// alone (lib/scope-proxy.mjs) only confines a client that routes through it; a
// raw socket skips it. lib/reach-confine.mjs removes the skip: the client runs on
// a Docker `--internal` network whose only egress is the proxy sidecar, so a
// bypass has no route. This test stands up that topology and shows, from inside
// the client, that:
//
//   1. THROUGH the gate, the granted host answers (200).          — reach works
//   2. THROUGH the gate, a non-granted host is blocked (403).      — gate enforces
//   3. AROUND the gate, by name, the granted host does not resolve.— no off-net DNS
//   4. AROUND the gate, by its real IP, the host has no route.     — THE BOUNDARY
//
// Test 4 is the one that separates option (b) from option (a): the client KNOWS
// the target's address and still cannot reach it, because the network — not a
// policy the client could ignore — stops it.
//
// Honest skip: if docker or node:20-slim is absent, the test skips with a reason
// rather than passing vacuously (the pattern in sandbox-isolation.test.mjs).
//
//   node --test spike/test/reach-confine.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { docker, dockerReady, confineReach, containerIp } from "../lib/reach-confine.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";

const ready = await dockerReady();
const skip = ready.ok ? false : ready.reason;

const tag = randomBytes(4).toString("hex");
const netTargets = `touchstone-reach-targets-${tag}`;
const grantedName = `touchstone-granted-${tag}`;
const evilName = `touchstone-evil-${tag}`;
const GRANTED_ALIAS = "granted.test";
const EVIL_ALIAS = "evil.test";
const ORIGIN_PORT = 8080;

let confine = null;
let grantedIp = null;

// A one-line http origin on a high port (no privileged bind, so --cap-drop ALL
// is fine). It answers every request with a fixed marker, so the client can tell
// which origin it reached.
function originScript(marker) {
  return `require('http').createServer((q,s)=>{s.writeHead(200);s.end('${marker}')}).listen(${ORIGIN_PORT},'0.0.0.0')`;
}

async function startOrigin(name, alias, marker) {
  const r = await docker([
    "run", "-d", "--name", name,
    "--network", netTargets, "--network-alias", alias,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", "node:20-slim", "-e", originScript(marker),
  ]);
  if (r.code !== 0) throw new Error(`start ${name} failed: ${r.stderr}`);
}

before(async () => {
  if (skip) return;
  // The targets network is --internal too: the origins have no internet either,
  // which keeps the test hermetic. The proxy bridges the client network to THIS
  // network, so the only reach the run gets is to the origins named here.
  const nt = await createLabNetwork(netTargets, ["--internal"], { docker });
  if (nt.code !== 0) throw new Error(`targets network create failed: ${nt.stderr}`);
  await startOrigin(grantedName, GRANTED_ALIAS, "GRANTED-ORIGIN");
  await startOrigin(evilName, EVIL_ALIAS, "EVIL-ORIGIN");
  grantedIp = await containerIp(grantedName, netTargets);

  // Confine: a grant allow-list of the granted host ONLY. allowPrivate because
  // Docker container IPs are private; egressNetwork is the targets network, so
  // the proxy reaches the origins and nothing else.
  confine = await confineReach({
    allowedHosts: [GRANTED_ALIAS],
    allowPrivate: true,
    egressNetwork: netTargets,
    proxyPort: 8080,
  });
}, { timeout: 120_000 });

after(async () => {
  if (confine) await confine.stop();
  await docker(["rm", "-f", grantedName]);
  await docker(["rm", "-f", evilName]);
  await removeLabNetwork(netTargets, { docker });
}, { timeout: 60_000 });

// The boundary is the network flag, so read it from Docker, not from our code.
// A call site that drops --internal fails here (labnet-review Major 1).
const isInternal = async (net) => (await docker(["network", "inspect", "-f", "{{.Internal}}", net])).stdout.trim();

test("0. the client network and the targets network are --internal in Docker", { skip, timeout: 60_000 }, async () => {
  assert.ok(confine?.netClient, "confineReach returns its client network");
  assert.equal(await isInternal(confine.netClient), "true", "the confine client network has no route off the host");
  assert.equal(await isInternal(netTargets), "true");
});

test("1. THROUGH the gate, the granted host answers (200)", { skip, timeout: 60_000 }, async () => {
  const gate = confine.gateUrl;
  const r = await confine.runClient(["-e",
    `fetch(${JSON.stringify(gate)},{headers:{'x-touchstone-url':'http://${GRANTED_ALIAS}:${ORIGIN_PORT}/'}})` +
    `.then(async r=>{const t=await r.text();` +
    `if(r.status===200&&t.includes('GRANTED-ORIGIN')){console.log('OK-ALLOWED');process.exit(0)}` +
    `console.log('BAD '+r.status+' '+t);process.exit(1)})` +
    `.catch(e=>{console.log('ERR '+e.message);process.exit(2)})`,
  ]);
  assert.equal(r.code, 0, `expected the granted host to answer through the gate; got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /OK-ALLOWED/);
});

test("2. THROUGH the gate, a non-granted host is blocked (403)", { skip, timeout: 60_000 }, async () => {
  const gate = confine.gateUrl;
  const r = await confine.runClient(["-e",
    `fetch(${JSON.stringify(gate)},{headers:{'x-touchstone-url':'http://${EVIL_ALIAS}:${ORIGIN_PORT}/'}})` +
    `.then(async r=>{const t=await r.text();` +
    `if(r.status===403){console.log('OK-BLOCKED');process.exit(0)}` +
    `console.log('LEAK '+r.status+' '+t);process.exit(1)})` +
    `.catch(e=>{console.log('ERR '+e.message);process.exit(2)})`,
  ]);
  assert.equal(r.code, 0, `expected the non-granted host to be blocked at the gate; got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /OK-BLOCKED/);
});

test("3. AROUND the gate, by name, the non-granted host does not even resolve", { skip, timeout: 60_000 }, async () => {
  // A raw request straight to evil.test, skipping the proxy. The name is not on
  // the client network, so Docker DNS cannot resolve it: the bypass fails before
  // a single packet is addressed.
  const r = await confine.runClient(["-e",
    `const http=require('http');` +
    `const req=http.get('http://${EVIL_ALIAS}:${ORIGIN_PORT}/',{timeout:5000},res=>{console.log('LEAK '+res.statusCode);process.exit(1)});` +
    `req.on('timeout',()=>{console.log('NOREACH timeout');req.destroy();process.exit(0)});` +
    `req.on('error',e=>{console.log('NOREACH '+e.code);process.exit(0)})`,
  ]);
  assert.equal(r.code, 0, `expected no route to evil.test by name; got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /NOREACH/);
});

test("4. AROUND the gate, by its real IP, the host has no route — THE BOUNDARY", { skip, timeout: 60_000 }, async () => {
  // The clincher. The client is handed the granted origin's REAL IP on the
  // targets network and tries a raw socket straight to it, skipping the proxy.
  // It still cannot reach it: the client network is --internal and has no route
  // to the targets subnet. Bypass is refused by the ABSENCE OF A ROUTE, not by a
  // policy the client could ignore. This is option (b): even a cooperating-proxy
  // skip cannot escape the boundary.
  assert.ok(grantedIp, "could not read the granted origin's IP for the bypass test");
  const r = await confine.runClient(["-e",
    `const http=require('http');` +
    `const req=http.get('http://${grantedIp}:${ORIGIN_PORT}/',{timeout:6000},res=>{console.log('LEAK '+res.statusCode);process.exit(1)});` +
    `req.on('timeout',()=>{console.log('NOREACH timeout');req.destroy();process.exit(0)});` +
    `req.on('error',e=>{console.log('NOREACH '+e.code);process.exit(0)})`,
  ], { timeoutMs: 20_000 });
  assert.equal(r.code, 0, `expected no route to the granted host's raw IP from the confined client; got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /NOREACH/);
});
