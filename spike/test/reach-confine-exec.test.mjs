// The confined-tool-execution test — the proof that a live run's TOOL, not just a
// hand-written probe, runs INSIDE the boundary and is confined by it.
//
// WHAT IT PROVES. reach-confine.test.mjs proves the network boundary with raw
// probes. This test proves the dispatch PRIMITIVE on top of it: `runConfined`
// (lib/reach-confine.mjs) runs a tool container on the client network with the
// gate pre-wired under the standard HTTP_PROXY env — the same shape lib/wrap.mjs
// runTool uses for an offline lab tool, but confined to the grant. A tool run
// this way:
//
//   1. reaches the GRANTED host THROUGH the gate using ONLY the HTTP_PROXY env
//      the seam set (a standard proxy client, not Touchstone's custom header).  — dispatch works
//   2. is BLOCKED from a non-granted host at the gate (403).                     — gate still enforces
//   3. has NO ROUTE to a non-granted host's raw IP, skipping the gate entirely.  — boundary still holds
//   4. can read a mounted workspace at /work and its output stays the caller's.  — runTool-shape parity
//
// Test 1 is the new claim: the tool uses the dispatcher-set proxy env, proving a
// real tool (curl, git, any HTTP_PROXY-honoring client) is confined without
// cooperating. Tests 2-3 re-confirm the boundary holds for tool execution, not
// just raw probes. The topology mirrors reach-confine.test.mjs: controlled
// origins on an --internal targets network, a grant for one of them only.
//
// Honest skip: if docker or node:20-slim is absent, the test skips with a reason
// rather than passing vacuously (the pattern in reach-confine.test.mjs).
//
//   node --test spike/test/reach-confine-exec.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerReady, confineReach, containerIp } from "../lib/reach-confine.mjs";
import { createOwnedNetwork, removeOwnedNetwork } from "../lib/docker-nets.mjs";

const ready = await dockerReady();
const skip = ready.ok ? false : ready.reason;

const tag = randomBytes(4).toString("hex");
const netTargets = `touchstone-exec-targets-${tag}`;
const grantedName = `touchstone-exec-granted-${tag}`;
const evilName = `touchstone-exec-evil-${tag}`;
const GRANTED_ALIAS = "granted.test";
const EVIL_ALIAS = "evil.test";
const ORIGIN_PORT = 8080;

let confine = null;
let evilIp = null;
let ws = null;

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

// A tool that routes ONLY through the standard HTTP_PROXY env var the seam sets,
// the way curl/git do. It forms the absolute-form request a proxy client sends
// (method + full URL to the proxy socket), reads HTTP_PROXY from its env, and
// reports which origin answered. It never names the gate itself — the dispatcher
// did, through the environment. `target` is the URL the tool wants to reach.
function proxyToolScript(target) {
  return (
    `const http=require('http');` +
    `const p=process.env.HTTP_PROXY;` +
    `if(!p){console.log('NOPROXY');process.exit(3)}` +
    `const u=new URL(p);const t=${JSON.stringify(target)};` +
    `const req=http.request({host:u.hostname,port:u.port,method:'GET',path:t,headers:{Host:new URL(t).host}},res=>{` +
    `let b='';res.on('data',d=>b+=d);res.on('end',()=>{console.log('STATUS '+res.statusCode+' BODY '+b);process.exit(0)})});` +
    `req.on('error',e=>{console.log('ERR '+e.code);process.exit(2)});req.end();`
  );
}

// A tool that skips the gate and aims a raw socket straight at an address — the
// bypass. It must have no route off the client network.
function rawToolScript(url) {
  return (
    `const http=require('http');` +
    `const req=http.get(${JSON.stringify(url)},{timeout:6000},res=>{console.log('LEAK '+res.statusCode);process.exit(1)});` +
    `req.on('timeout',()=>{console.log('NOREACH timeout');req.destroy();process.exit(0)});` +
    `req.on('error',e=>{console.log('NOREACH '+e.code);process.exit(0)});`
  );
}

before(async () => {
  if (skip) return;
  const nt = await createOwnedNetwork(netTargets, ["--internal"]);
  if (nt.code !== 0) throw new Error(`targets network create failed: ${nt.stderr}`);
  await startOrigin(grantedName, GRANTED_ALIAS, "GRANTED-ORIGIN");
  await startOrigin(evilName, EVIL_ALIAS, "EVIL-ORIGIN");
  evilIp = await containerIp(evilName, netTargets);

  confine = await confineReach({
    allowedHosts: [GRANTED_ALIAS],
    allowPrivate: true,
    egressNetwork: netTargets,
    proxyPort: 8080,
  });

  // A workspace the confined tool can read, to prove runTool-shape parity.
  ws = mkdtempSync(join(tmpdir(), "touchstone-exec-ws-"));
  writeFileSync(join(ws, "scope.txt"), "WORKSPACE-MARKER\n");
}, { timeout: 120_000 });

after(async () => {
  if (confine) await confine.stop();
  if (!skip) {
    await docker(["rm", "-f", grantedName]);
    await docker(["rm", "-f", evilName]);
    await removeOwnedNetwork(netTargets);
  }
  if (ws) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } }
}, { timeout: 60_000 });

test("1. a confined tool reaches the granted host via the seam's HTTP_PROXY env (200)", { skip, timeout: 60_000 }, async () => {
  const r = await confine.runConfined(["-e", proxyToolScript(`http://${GRANTED_ALIAS}:${ORIGIN_PORT}/`)], { entrypoint: "node" });
  assert.equal(r.code, 0, `tool run failed: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /STATUS 200 BODY GRANTED-ORIGIN/, `expected the granted origin through the seam's proxy env; got: ${r.stdout}`);
});

test("2. a confined tool is blocked from a non-granted host at the gate (403)", { skip, timeout: 60_000 }, async () => {
  const r = await confine.runConfined(["-e", proxyToolScript(`http://${EVIL_ALIAS}:${ORIGIN_PORT}/`)], { entrypoint: "node" });
  assert.equal(r.code, 0, `tool run failed: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /STATUS 403/, `expected the non-granted host blocked at the gate; got: ${r.stdout}`);
  assert.doesNotMatch(r.stdout, /EVIL-ORIGIN/, "the non-granted origin's body must never come back");
});

test("3. a confined tool has no route to a non-granted host's raw IP — the boundary holds for tools", { skip, timeout: 60_000 }, async () => {
  assert.ok(evilIp, "could not read the evil origin's IP for the bypass test");
  const r = await confine.runConfined(["-e", rawToolScript(`http://${evilIp}:${ORIGIN_PORT}/`)], { entrypoint: "node", timeoutMs: 20_000 });
  assert.equal(r.code, 0, `tool run failed: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /NOREACH/, `expected no route to the raw IP from the confined tool; got: ${r.stdout}`);
});

test("4. a confined tool reads its mounted workspace at /work as the caller's user (runTool-shape parity)", { skip, timeout: 60_000 }, async () => {
  // As lib/wrap.mjs runTool does: run as the host user so the container can read
  // the workspace with no capabilities (--cap-drop ALL removes CAP_DAC_OVERRIDE,
  // so container-root could not traverse the host user's private dir) and any
  // output files it writes stay the caller's.
  const user = `${process.getuid()}:${process.getgid()}`;
  const r = await confine.runConfined(
    ["-e", `const fs=require('fs');console.log('READ '+fs.readFileSync('/work/scope.txt','utf8').trim());fs.writeFileSync('/work/out.txt','TOOL-OUTPUT')`],
    { entrypoint: "node", ws, user },
  );
  assert.equal(r.code, 0, `tool run failed: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /READ WORKSPACE-MARKER/, `expected the mounted workspace readable; got: ${r.stdout}`);
  // The tool's output came back on the host, owned by the caller (runTool contract).
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "TOOL-OUTPUT", "the tool's output file must land on the host workspace");
});
