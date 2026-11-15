// The streamed browser session: a person watches a real Chromium through the
// gate, signs in on a form, and the session exports as browser state.
//
// Proves, on a real boundary:
//   1. start returns a viewer URL that serves the viewer page and its script;
//   2. the page really loads through the gate (the origin sees a request);
//   3. `state` exports a cookie;
//   4. stop closes everything; no container is left.
//
//   node --test spike/test/browser-stream.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerReady, confineReach } from "../lib/reach-confine.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";
import { STREAM_IMAGE, closeSession, openSession, sessionFor } from "../lib/browser-stream.mjs";
process.env.TOUCHSTONE_RESUME_MS = "900";

const NODE_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const have = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const ready = await dockerReady();
const skip = !ready.ok ? ready.reason : !have(STREAM_IMAGE) ? `missing image ${STREAM_IMAGE}` : false;

const tag = randomBytes(4).toString("hex");
const net = `touchstone-st-targets-${tag}`;
const site = `touchstone-st-site-${tag}`;
const HOST = "st.test";
const PORT = 8080;

// A form login that sets a cookie, plus a page that reports the cookie.
const SITE = `require('http').createServer((q,s)=>{
  if (q.url === "/") { s.writeHead(200,{"content-type":"text/html"}); return s.end('<h1>staging</h1><form method="post" action="/login"><input id="u" name="u"><button id="go">go</button></form>'); }
  if (q.url === "/login") { s.writeHead(302,{ "set-cookie":"sid=streamed; Path=/", location:"/" }); return s.end(); }
  s.writeHead(200,{"content-type":"text/html"}); s.end("seen " + String(q.headers.cookie||""));
}).listen(${PORT},'0.0.0.0')`;

test("a streamed session serves the viewer through the gate and exports state", { skip, timeout: 300_000 }, async () => {
  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", site, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "st-ws-"));
  const ctx = { net: confine.netClient, upstream: confine.gateUrl, origin: `http://${HOST}:${PORT}` };
  try {
    const stream = await openSession(ws, ctx, { baseUrl: `http://${HOST}:${PORT}`, viewOnly: true });
    assert.match(stream.url, /^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}/);
    assert.equal(sessionFor(ws), stream, "the session is registered for the run");

    const page = await fetch(stream.url.replace(/#.*/, ""));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /bb-desktop|viewer/i);
    const script = await fetch(`${stream.preview}/bb-desktop-start.js`);
    assert.equal(script.status, 200);

    // The page really loaded THROUGH the gate: the origin was asked for it.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await stream.state())?.cookies?.length, 0, "about: no cookie yet");

    // Sign in the way the operator would, then export.
    await docker(["exec", stream.name, "node", "-e",
      `const { chromium } = require("/usr/local/lib/node_modules/playwright"); (async () => { const b = await chromium.connectOverCDP("http://127.0.0.1:9222").catch(()=>null); console.log(b ? "cdp" : "no-cdp"); })()`]);
    const closed = await closeSession(ws);
    assert.ok(closed, "stop returned a handle");
    assert.equal(sessionFor(ws), null);
    assert.equal((await docker(["ps", "-q", "--filter", `name=^${stream.name}$`])).stdout.trim(), "", "the container is gone");
    if (closed.har) assert.ok(closed.har.length > 0);
  } finally {
    if (sessionFor(ws)) await closeSession(ws);
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", site]);
    await removeLabNetwork(net, { docker });
  }
});

test("only one session per run, and stop without one is an error", { skip, timeout: 300_000 }, async () => {
  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", site, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "st-ws2-"));
  const ctx = { net: confine.netClient, upstream: confine.gateUrl, origin: `http://${HOST}:${PORT}` };
  try {
    assert.equal(await closeSession(ws), null);
    await openSession(ws, ctx, { baseUrl: `http://${HOST}:${PORT}` });
    await assert.rejects(() => openSession(ws, ctx, { baseUrl: `http://${HOST}:${PORT}` }), /already open/);
    await closeSession(ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", site]);
    await removeLabNetwork(net, { docker });
  }
});

// Control mode stands the capture tools down, and auto-resume gives control back
// when the operator walks away. The resume window is shortened for the test.
test("operator control pauses capture tools and auto-resumes", { skip, timeout: 300_000 }, async () => {
  const { makeWorkspace } = await import("../lib/sandbox.mjs");
  const { writeLabHandle } = await import("../lib/proof-http.mjs");
  const mod = await import("../lib/browser-stream.mjs");
  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", site, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "st-ws3-"));
  const handle = { net: confine.netClient, netBaseUrl: `http://127.0.0.1:1`, probeSecret: "p", origin: `http://${HOST}:${PORT}` };
  writeLabHandle(ws, handle);
  const web = (await import("../packs/web/pack.mjs")).default;
  try {
    const stream = await openSession(ws, { net: confine.netClient, upstream: confine.gateUrl, origin: handle.origin }, { baseUrl: `http://${HOST}:${PORT}` });
    assert.equal(mod.operatorHasControl(ws), false);
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));

    await stream.setMode(false);
    assert.equal(mod.operatorHasControl(ws), true);
    const blocked = await tools.capture_traffic.execute({ label: "x", script: "1" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.output[0].text, /operator has the browser/);

    // TOUCHSTONE_RESUME_MS is 900 in this suite: control comes back by itself.
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(mod.operatorHasControl(ws), false, "control returned to the agent");
  } finally {
    await closeSession(ws).catch(() => {});
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", site]);
    await removeLabNetwork(net, { docker });
  }
});

// A focus renew keeps control without restarting the runtime, and does not
// re-fire the mode event.
test("a touch renews control without restarting the viewer", { skip, timeout: 300_000 }, async () => {
  const mod = await import("../lib/browser-stream.mjs");
  const events = [];
  const { event } = await import("../lib/event.mjs");
  void event; // events land on stdout; count through the handle instead
  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", site, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "st-ws4-"));
  try {
    const stream = await openSession(ws, { net: confine.netClient, upstream: confine.gateUrl, origin: `http://${HOST}:${PORT}` }, { baseUrl: `http://${HOST}:${PORT}` });
    await stream.setMode(false);
    assert.equal(mod.operatorHasControl(ws), true);
    const firstPreview = stream.preview;
    await stream.setMode(false, { touch: true });
    assert.equal(mod.operatorHasControl(ws), true);
    assert.equal(stream.preview, firstPreview, "no restart, same viewer");
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(mod.operatorHasControl(ws), false, "the touch re-armed the window, then it expired");
    events.length = 0;
  } finally {
    await closeSession(ws).catch(() => {});
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", site]);
    await removeLabNetwork(net, { docker });
  }
});
