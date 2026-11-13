// The live lane: a real request script, aimed at a live origin through the
// confinement boundary, with its transcript recorded.
//
// WHAT IT PROVES. The live run does not fall back to a lab.
//   1. The workspace carries the exact origin and says "live".
//   2. run_request_script's runner is confined: it reaches the granted origin
//      through the gate, and has NO route to an ungranted one.
//   3. The oracle reads the recorded transcript, so a finding can be proven
//      against a live target.
//
// A container stands in for the website on the default bridge network (so the
// gate's own container can reach it). Honest skip when docker is absent.
//
//   node --test spike/test/live-lane.test.mjs
import "./helpers/isolated-env.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { docker, dockerReady, containerIp } = await import("../lib/reach-confine.mjs");
const { openReach } = await import("../lib/reach.mjs");
const { prepareWorkspace } = await import("../lib/targets.mjs");
const { addGrant } = await import("../lib/grant-store.mjs");
const { bindLive, isLive, liveTarget, liveProof, runLiveScript } = await import("../lib/live.mjs");

const ready = await dockerReady();
const skip = ready.ok ? false : ready.reason;
const tag = randomBytes(4).toString("hex");
const originName = `touchstone-live-origin-${tag}`;
const dir = mkdtempSync(join(tmpdir(), "live-lane-test-"));
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json");
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
const PORT = 8080;

let reach = null;
let ws = null;
let originIp = null;

before(async () => {
  if (skip) return;
  const script = `require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({path:q.url,query:q.url.split('?')[1]??null}))}).listen(${PORT},'0.0.0.0')`;
  const r = await docker([
    "run", "-d", "--name", originName, "--network", "bridge",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
    "--entrypoint", "node", "node:20-slim", "-e", script,
  ]);
  if (r.code !== 0) throw new Error(`origin failed: ${r.stderr}`);
  originIp = await containerIp(originName, "bridge");
});

after(async () => {
  if (reach) await reach.stop();
  if (ws) rmSync(ws, { recursive: true, force: true });
  if (!skip) await docker(["rm", "-f", originName]);
  rmSync(dir, { recursive: true, force: true });
});

test("a live workspace is bound to its exact origin and its boundary", { skip }, async () => {
  const origin = `http://${originIp}:${PORT}`;
  const target = { id: "live-lane", title: "lane", kind: "live", hosts: [originIp], origins: [origin], pack: "web" };
  ws = prepareWorkspace(target, { modules: [] });
  assert.equal(isLive(ws), true);
  // A live workspace cannot run before the platform opened a boundary.
  assert.throws(() => liveTarget(ws), /no confinement boundary/);

  addGrant({ hosts: [originIp], kind: "operator-owned", ownership: true, allowPrivate: true });
  reach = await openReach(target, { mode: "confine" });
  bindLive(ws, { net: reach.confine.netClient, gate: reach.confine.gateUrl, baseUrl: origin, image: "touchstone/web-lab:dev" });

  const t = liveTarget(ws);
  assert.equal(t.baseUrl, origin);
  assert.equal(t.net, reach.confine.netClient);
});

test("the script reaches the granted origin through the gate, not around it", { skip }, async () => {
  const run = await runLiveScript(ws, `
    let direct = "";
    try { const x = await fetch("https://one.one.one.one/"); direct = "REACHED " + x.status; } catch (e) { direct = "NO ROUTE " + (e.cause?.code ?? e.message); }
    console.log("direct:" + direct);
    const ok = await request("GET", "/?x=1");
    console.log("granted:" + ok.status);
  `);
  assert.match(run.stdout, /granted:200/);
  // The boundary has no route off the client network, so a bare fetch cannot
  // reach the internet even with a known address.
  assert.match(run.stdout, /direct:NO ROUTE/);
  assert.equal(run.transcript.length, 1);
  assert.equal(run.transcript[0].path, "/");
  assert.deepEqual(run.transcript[0].resBody, { path: "/?x=1", query: "x=1" });
});

test("a proof replays the script and reads the recorded transcript", { skip }, async () => {
  const proof = await liveProof(ws, `await request("GET", "/?x=1")`, {
    name: "reflect",
    check: (t) => ({ pass: t.some((e) => e.resBody?.query === "x=1"), detail: "the query came back" }),
  });
  assert.equal(proof.status, "pass");
  assert.equal(proof.kind, "http");
  assert.equal(proof.log.length, 1);
  assert.equal(proof.log[0].response.status, 200);
});
