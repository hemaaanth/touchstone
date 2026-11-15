// Live capture: mitmproxy in FRONT of the scope gate, on a real confinement
// boundary. The claim is not "capture works" (intercept.test.mjs covers that)
// but "capture does not weaken the gate":
//
//   1. a GRANTED host is recorded through mitm -> gate -> origin;
//   2. a NON-GRANTED host is refused by the gate (403) and recorded as refused;
//   3. a raw IP still has to cross the gate. mitm sits on the client network
//      only, which has no route to the targets network, so the address is only
//      reachable at all because the gate dials it -- and strict mode then
//      refuses it, because the grant names hosts, not addresses.
//
// Topology mirrors reach-confine-exec.test.mjs: two origins on a controlled
// `--internal` targets network, a grant for one, the gate bridging them.
// mitm joins the client network only, so every byte still crosses the gate.
//
//   node --test spike/test/live-capture.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerReady, confineReach, containerIp } from "../lib/reach-confine.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";
import { captureThrough, MITM_IMAGE } from "../lib/intercept.mjs";

const NODE_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const have = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const ready = await dockerReady();
const skip = !ready.ok ? ready.reason : !have(MITM_IMAGE) ? `missing image ${MITM_IMAGE}` : !have(NODE_IMAGE) ? `missing image ${NODE_IMAGE}` : false;

const tag = randomBytes(4).toString("hex");
const netTargets = `touchstone-cap-targets-${tag}`;
const grantedName = `touchstone-cap-granted-${tag}`;
const evilName = `touchstone-cap-evil-${tag}`;
const GRANTED = "granted.test";
const EVIL = "evil.test";
const PORT = 8080;

// The client goes to MITM with an absolute request line, and names the target in
// the Host header -- exactly what a proxy client does. It never names the gate.
const clientScript = (paths) => `
const http = require("node:http");
const call = (url) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const r = http.request({ host: "mitm", port: 8080, path: url, method: "GET", headers: { host: u.host } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  r.on("error", reject);
  r.end();
});
(async () => { for (const p of ${JSON.stringify(paths)}) { try { const r = await call(p); console.log(p, r.status); } catch (e) { console.log(p, "unreachable"); } } })();
`;

const origin = (marker) => `require('http').createServer((q,s)=>{s.writeHead(200);s.end('${marker}')}).listen(${PORT},'0.0.0.0')`;

async function startOrigin(name, alias, marker) {
  const r = await docker([
    "run", "-d", "--name", name, "--network", netTargets, "--network-alias", alias,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", origin(marker),
  ]);
  if (r.code !== 0) throw new Error(`start ${name} failed: ${r.stderr}`);
}

test("a live capture is recorded through the gate, and the gate still refuses a non-granted host", { skip, timeout: 240_000 }, async () => {
  await createLabNetwork(netTargets, ["--internal"], { docker });
  await startOrigin(grantedName, GRANTED, "granted-answer");
  await startOrigin(evilName, EVIL, "evil-answer");
  const evilIp = await containerIp(evilName, netTargets);
  const confine = await confineReach({ allowedHosts: [GRANTED], allowPrivate: true, egressNetwork: netTargets });
  const dir = mkdtempSync(join(tmpdir(), "cap-live-"));
  try {
    const run = await captureThrough(
      { net: confine.netClient, upstream: confine.gateUrl, origin: `http://${GRANTED}:${PORT}` },
      { image: NODE_IMAGE, cmd: ["-e", clientScript([
        `http://${GRANTED}:${PORT}/ok`,
        `http://${EVIL}:${PORT}/nope`,
        `http://${evilIp}:${PORT}/raw-ip`,
      ])] },
      { dir, timeoutMs: 60_000 },
    );

    const granted = run.transcript.find((e) => e.path === "/ok");
    assert.ok(granted, `the granted call must be recorded: ${JSON.stringify(run.transcript.map((e) => [e.path, e.status]))}`);
    assert.equal(granted.status, 200);
    assert.equal(granted.resBody, "granted-answer");

    // The gate answers 403 itself; mitm records that exchange, so a refused host
    // is visible in the capture instead of vanishing.
    const refused = run.transcript.find((e) => e.path === "/nope");
    assert.ok(refused, "the refused call is recorded");
    assert.equal(refused.status, 403, `gate refusal expected, got ${refused.status}`);
    assert.match(JSON.stringify(refused.resBody ?? ""), /not|allow|denied/i);

    // The raw IP crosses the gate (mitm has no other route) and is refused there.
    // So the grant, not the network, stays the decider.
    const raw = run.transcript.find((e) => e.path === "/raw-ip");
    assert.ok(raw, "the raw-IP call crosses the gate and is recorded");
    assert.equal(raw.status, 403);
    assert.match(run.stdout, new RegExp(`${evilIp.replace(/\./g, "\\.")}:${PORT}/raw-ip 403`));

    assert.match(readFileSync(run.harPath, "utf8"), /granted-answer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", grantedName, evilName]);
    await removeLabNetwork(netTargets, { docker });
  }
});

// The pack path: a live workspace, the real tool, the real gate. Proves the tool
// no longer refuses live, and that a matched live capture backs a finding.
test("capture_traffic on a live workspace goes through the gate and backs a finding", { skip, timeout: 240_000 }, async () => {
  const { makeWorkspace, writeTouchstone } = await import("../lib/sandbox.mjs");
  const { bindLive } = await import("../lib/live.mjs");
  const web = (await import("../packs/web/pack.mjs")).default;

  const netName = `touchstone-cap-win-${tag}`;
  const siteName = `touchstone-cap-site-${tag}`;
  await createLabNetwork(netName, ["--internal"], { docker });
  const site = `require('http').createServer((q,s)=>{
    if (q.url.startsWith("/explorer")) { s.writeHead(200,{"content-type":"text/html"}); return s.end("<html><body>"+decodeURIComponent(new URL(q.url,"http://x").searchParams.get("q"))+"</body></html>"); }
    s.writeHead(200,{"content-type":"application/json"}); s.end("{}");
  }).listen(${PORT},'0.0.0.0')`;
  const up = await docker(["run", "-d", "--name", siteName, "--network", netName, "--network-alias", GRANTED,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", site]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [GRANTED], allowPrivate: true, egressNetwork: netName });

  const src = mkdtempSync(join(tmpdir(), "cap-live-src-"));
  writeTouchstone(src, { pack: "web", kind: "live", baseUrl: `http://${GRANTED}:${PORT}` });
  const ws = makeWorkspace(src);
  bindLive(ws, { net: confine.netClient, gate: confine.gateUrl, baseUrl: `http://${GRANTED}:${PORT}`, image: "touchstone/web-lab:dev" });
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));
    const run = await tools.capture_traffic.execute({ label: "live-xss", script: 'await request("GET", "/explorer?q=" + encodeURIComponent("<img src=x onerror=alert(1)>"));' });
    assert.ok(!run.isError, run.output?.[0]?.text);
    assert.match(run.output[0].text, /MATCH: reflected-xss/, run.output[0].text);
    assert.equal(state.passed.get("live-xss")?.oracleName, "reflected-xss");
    assert.match(run.output[0].text, /HAR saved: captures\/live-xss\.har/);
    const sub = await tools.submit_finding.execute({ title: "live xss", severity: "medium", label: "live-xss", explanation: "x. Fix: x" });
    assert.ok(!sub.isError, sub.output?.[0]?.text);
    assert.equal(state.found.length, 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", siteName]);
    await removeLabNetwork(netName, { docker });
  }
});

// Session injection: the operator's headers ride on same-origin calls only, and
// the script can still override them. A second granted host must not see the
// cookie, so a redirect or a cross-origin call cannot leak it.
test("operator session headers are injected for the scope origin only, and a caller can override", { skip, timeout: 240_000 }, async () => {
  const { makeWorkspace, writeTouchstone } = await import("../lib/sandbox.mjs");
  const { bindLive, runLiveCapture } = await import("../lib/live.mjs");
  const netName = `touchstone-cap-sess-${tag}`;
  const aName = `touchstone-cap-a-${tag}`;
  const bName = `touchstone-cap-b-${tag}`;
  const OTHER = "other.test";
  await createLabNetwork(netName, ["--internal"], { docker });
  const echo = `require('http').createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify(q.headers))}).listen(${PORT},'0.0.0.0')`;
  for (const [name, alias] of [[aName, GRANTED], [bName, OTHER]]) {
    const r = await docker(["run", "-d", "--name", name, "--network", netName, "--network-alias", alias,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
      "--entrypoint", "node", NODE_IMAGE, "-e", echo]);
    if (r.code !== 0) throw new Error(r.stderr);
  }
  const confine = await confineReach({ allowedHosts: [GRANTED, OTHER], allowPrivate: true, egressNetwork: netName });
  const src = mkdtempSync(join(tmpdir(), "cap-sess-src-"));
  writeTouchstone(src, { pack: "web", kind: "live", baseUrl: `http://${GRANTED}:${PORT}`, session: { headers: { cookie: "sid=op-session", "x-api-key": "k1" } } });
  const ws = makeWorkspace(src);
  bindLive(ws, { net: confine.netClient, gate: confine.gateUrl, baseUrl: `http://${GRANTED}:${PORT}`, image: "touchstone/web-lab:dev" });
  try {
    const run = await runLiveCapture(ws, `
      await request("GET", "/same");
      await request("GET", "/override", { headers: { cookie: "sid=caller" } });
      await request("GET", "http://${OTHER}:${PORT}/cross");
    `);
    const same = run.transcript.find((e) => e.path === "/same");
    assert.equal(same.reqHeaders.cookie, "sid=op-session", "the operator session is injected");
    assert.equal(same.reqHeaders["x-api-key"], "k1");
    assert.equal(same.resBody.cookie, "sid=op-session", "the origin really received it");

    const over = run.transcript.find((e) => e.path === "/override");
    assert.equal(over.reqHeaders.cookie, "sid=caller", "a caller header wins");

    const cross = run.transcript.find((e) => e.path === "/cross");
    assert.equal(cross.reqHeaders.cookie, undefined, "a cross-origin call gets no cookie");
    assert.equal(cross.reqHeaders["x-api-key"], undefined);
  } finally {
    rmSync(src, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", aName, bName]);
    await removeLabNetwork(netName, { docker });
  }
});
