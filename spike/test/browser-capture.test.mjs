// The browser client of a capture: Playwright drives Chromium through mitm and
// the gate, a login form is filled for real, and the exported storageState logs
// the next browser in without the form.
//
// Topology is the live-capture one: one origin on an `--internal` targets
// network, the scope gate bridging it, mitm between the browser and the gate.
// Skips honestly without the browser image.
//
//   node --test spike/test/browser-capture.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerReady, confineReach } from "../lib/reach-confine.mjs";
import { createLabNetwork, removeLabNetwork } from "../lib/lab-net.mjs";
import { BROWSER_IMAGE, captureBrowser, checkSteps } from "../lib/browser-client.mjs";

const NODE_IMAGE = "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";
const have = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const ready = await dockerReady();
const skip = !ready.ok ? ready.reason : !have(BROWSER_IMAGE) ? `missing image ${BROWSER_IMAGE}` : false;

const tag = randomBytes(4).toString("hex");
const net = `touchstone-br-targets-${tag}`;
const siteName = `touchstone-br-site-${tag}`;
const HOST = "br.test";
const PORT = 8080;

// A real form login: POST sets a cookie, /private wants it.
const SITE = `require('http').createServer((q,s)=>{
  if (q.url === "/login" && q.method === "GET") { s.writeHead(200,{"content-type":"text/html"}); return s.end('<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go">go</button></form>'); }
  if (q.url === "/login") { s.writeHead(302,{ "set-cookie":"sid=abc123; Path=/", location:"/private" }); return s.end(); }
  if (q.url === "/private") { const ok = String(q.headers.cookie||"").includes("sid=abc123"); s.writeHead(ok?200:401,{"content-type":"text/html"}); return s.end(ok?'<p>welcome secret</p>':'<p>denied</p>'); }
  s.writeHead(404); s.end("no");
}).listen(${PORT},'0.0.0.0')`;

test("a browser fills a login form through the proxy and the exported state logs in again", { skip, timeout: 300_000 }, async () => {
  assert.throws(() => checkSteps([{ goto: "/x", click: "#y" }]), /exactly one of/);
  assert.throws(() => checkSteps([]), /at least one/);
  assert.throws(() => checkSteps([{ fill: "v" }]), /target selector/);

  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", siteName, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "br-ws-"));
  const ctx = { net: confine.netClient, upstream: confine.gateUrl, origin: `http://${HOST}:${PORT}` };
  const baseUrl = `http://${HOST}:${PORT}`;
  try {
    const first = await captureBrowser(ctx, ws, { baseUrl, label: "login", saveSession: true, steps: [
      { goto: "/login" },
      { fill: "qa@example.test", target: "#u" },
      { fill: "pw", target: "#p" },
      { screenshot: "form" },
      { click: "#go" },
      { expectText: "welcome" },
    ] });
    assert.equal(first.failed, null, JSON.stringify(first.log));
    assert.equal(first.state?.state?.cookies?.length, 1, "a cookie was exported");
    assert.match(first.state.state.cookies[0].name, /sid/);
    assert.equal(first.shots.length, 1);
    assert.ok(first.harPath, "the HAR was kept");
    assert.match(readFileSync(join(ws, first.harPath), "utf8"), /welcome secret/);
    const post = first.transcript.find((e) => e.method === "POST" && e.path === "/login");
    assert.ok(post, "the form POST is in the recorded transcript");

    // Second browser, no form: the exported state is enough.
    const second = await captureBrowser(ctx, ws, { baseUrl, label: "reuse", storageState: first.state.state, steps: [
      { goto: "/private" },
      { expectText: "welcome" },
    ] });
    assert.equal(second.failed, null, JSON.stringify(second.log));
    assert.equal(second.transcript.at(-1).status, 200);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", siteName]);
    await removeLabNetwork(net, { docker });
  }
});

test("a failing step is reported with its number, and the capture still returns", { skip, timeout: 240_000 }, async () => {
  await createLabNetwork(net, ["--internal"], { docker });
  const up = await docker(["run", "-d", "--name", siteName, "--network", net, "--network-alias", HOST,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", NODE_IMAGE, "-e", SITE]);
  if (up.code !== 0) throw new Error(up.stderr);
  const confine = await confineReach({ allowedHosts: [HOST], allowPrivate: true, egressNetwork: net });
  const ws = mkdtempSync(join(tmpdir(), "br-ws2-"));
  const baseUrl = `http://${HOST}:${PORT}`;
  try {
    const run = await captureBrowser({ net: confine.netClient, upstream: confine.gateUrl, origin: baseUrl }, ws, { baseUrl, label: "miss", steps: [
      { goto: "/login" },
      { expectText: "not on this page" },
    ] });
    assert.equal(run.failed?.step, 2);
    assert.match(run.failed.error, /does not contain/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    await confine.stop();
    await docker(["rm", "-f", siteName]);
    await removeLabNetwork(net, { docker });
  }
});

// The whole loop on the web lab: a browser capture trips an oracle, backs a
// finding, and prove() replays it as a BROWSER run on a fresh lab.
test("a browser finding submits and replays as a browser run", { skip: skip || (!have("touchstone/web-lab:dev") && "lab image not built"), timeout: 400_000 }, async () => {
  const { startLab, stopLab, writeLabHandle } = await import("../lib/proof-http.mjs");
  const { makeWorkspace } = await import("../lib/sandbox.mjs");
  const web = (await import("../packs/web/pack.mjs")).default;
  const ws = makeWorkspace(new URL("../packs/web/lab/dapp", import.meta.url).pathname);
  const handle = await startLab({ image: "touchstone/web-lab:dev" });
  writeLabHandle(ws, handle);
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));
    const q = encodeURIComponent("<img src=x onerror=alert(1)>");
    const run = await tools.capture_browser.execute({ label: "xss-browser", steps: [{ goto: `/explorer?q=${q}` }, { expectText: "onerror" }] });
    assert.ok(!run.isError, run.output?.[0]?.text);
    assert.match(run.output[0].text, /MATCH: reflected-xss/, run.output[0].text);
    const sub = await tools.submit_finding.execute({ title: "reflected xss via browser", severity: "medium", label: "xss-browser", explanation: "x. Fix: x" });
    assert.ok(!sub.isError, sub.output?.[0]?.text);
    assert.ok(state.found[0].steps, "the finding carries the steps, not a script");
    const proved = await web.prove(ws, state.found, [], () => {});
    assert.equal(proved[0].proof.status, "pass", JSON.stringify(proved[0].proof));
    assert.equal(proved[0].proof.oracle.passed, true);
  } finally {
    await stopLab(handle);
    rmSync(ws, { recursive: true, force: true });
  }
});
