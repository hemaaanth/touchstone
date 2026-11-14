// A run must never lose its chat, its sources or its follow-up.
//
//   node --experimental-test-module-mocks --test spike/test/run-continuity.test.mjs
//
// This drives the real app run orchestrator (app/server/runs.mjs). spawn is
// mocked: the "engine" is a fake child that prints the EVENT lines a test names,
// writes the files a test names into the run's workspace, and exits. No real
// engine starts, so no model is called and nothing is spent.
//
// The faults, from one real run:
//   1. The engine ended fine, but its long `settled` line was cut on the pipe.
//      The run showed "The run stopped unexpectedly" (no-settle).
//   2. Every follow-up, and "Run again", got a fresh workspace. The agent said
//      "Sandbox is fresh: sources are gone".
//   3. A run on a generated lab refused every follow-up.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- fake engine --------------------------------------------------------------

// One script per spawn:
//   events   EVENT lines to print whole
//   torn     a `settled` event: whole in the engine's events file, cut on stdout
//   act      (call) => void, runs first; call is { args, env }
//   stderr, code, signal   how the process ends (default: exit 0)
//   hang     the process never ends
const scripts = [];
const spawns = [];
function spawn(cmd, args, opts = {}) {
  if (forbidExternal) {
    assert.equal(cmd, process.execPath);
    assert.equal(args[0], path.resolve(import.meta.dirname, "../agent-run.mjs"));
  }
  const script = scripts.shift() ?? { events: [] };
  const call = { args, env: opts.env ?? {} };
  spawns.push(call);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = Object.assign(new EventEmitter(), { writable: true, write() {} });
  child.exitCode = null;
  child.signalCode = null;
  const exit = (code, signal) => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => child.emit("exit", code, signal));
  };
  child.kill = (sig) => exit(null, sig ?? "SIGTERM");
  setImmediate(() => {
    script.act?.(call);
    for (const e of script.events ?? []) child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
    if (script.torn) {
      const line = JSON.stringify({ t: Date.now(), ...script.torn });
      appendFileSync(call.env.EVENTS_FILE, line + "\n");
      child.stdout.write(`EVENT ${line.slice(0, line.length >> 1)}`); // no newline: the exit cut it
    }
    if (script.stderr) child.stderr.write(script.stderr);
    if (!script.hang) setTimeout(() => (script.signal ? exit(null, script.signal) : exit(script.code ?? 0, null)), 20);
  });
  return child;
}
let forbidExternal = false;
const externalCalls = [];
const external = Object.fromEntries(["exec", "execFile", "execSync", "execFileSync", "spawnSync", "fork"].map((name) => [name, (...args) => {
  if (forbidExternal) { externalCalls.push(name); throw new Error(`Unexpected external operation: ${name}`); }
  return realChild[name](...args);
}]));
mock.module("node:child_process", { exports: { ...realChild, ...external, default: { ...realChild, ...external, spawn }, spawn } });
// rmSync with one extra: a test can act at the moment a delete fails part way, as
// a process that still runs in the workspace could.
let onRmFail = null;
const rmSyncHooked = (target, opts) => {
  try {
    return realFs.rmSync(target, opts);
  } catch (err) {
    onRmFail?.(target);
    throw err;
  }
};
let beforeWrite = null;
const writeHooked = (...args) => { beforeWrite?.(...args); return realFs.writeFileSync(...args); };
const existsHooked = (file) => String(file).endsWith("/.env.local") ? false : realFs.existsSync(file);
const fsHooks = { rmSync: rmSyncHooked, writeFileSync: writeHooked, existsSync: existsHooked };
mock.module("node:fs", { exports: { ...realFs, default: { ...realFs.default, ...fsHooks }, ...fsHooks } });
// A live run opens a Docker boundary. These tests have no live target, so a live
// scope gets an inert gate. Every other scope keeps the real one.
const realReach = await import("../lib/reach.mjs");
// One extra: a test can act while the reach opens (a boot that resumes a run waits here).
let reachHook = null;
const reachCalls = [];
const openReach = async (target, opts) => {
  reachCalls.push({ target, opts });
  await reachHook?.();
  return target.kind === "live" ? { env: {}, stop: async () => {} } : realReach.openReach(target, opts);
};
mock.module("../lib/reach.mjs", { exports: { ...realReach, openReach } });
// No DNS: the server's restore of a fetched source asks for github.com's address.
const realDns = await import("node:dns/promises");
const lookup = async () => [{ address: "140.82.112.3", family: 4 }];
mock.module("node:dns/promises", { exports: { ...realDns, default: { ...realDns, lookup }, lookup } });
// A fetch with no network: it writes the tree the real one would.
const realFetch = await import("../lib/fetch.mjs");
const fetchClones = [];
// The server's restore of a fetched source, with one extra: a test can stand in
// front of it (to stop the run, to hang, or to give another commit).
let restoreHook = null;
mock.module("../lib/fetch.mjs", {
  exports: {
    ...realFetch,
    restoreSource: (ws, url) => (restoreHook ? restoreHook(ws, url, realFetch.restoreSource) : realFetch.restoreSource(ws, url)),
    fetchSource: async (ws, url) => {
      fetchClones.push({ ws, url });
      mkdirSync(path.join(ws, "vendor", "acme__lib", "src"), { recursive: true });
      writeFileSync(path.join(ws, "vendor", "acme__lib", "src", "Vault.sol"), "contract Vault {}\n");
      writeFileSync(path.join(ws, "vendor", "acme__lib", "src", "app.ts"), "export const a = 1\n");
      return { where: path.join("vendor", "acme__lib"), files: [{ path: "vendor/acme__lib/src/Vault.sol", pragmas: [] }], note: "fetched" };
    },
  },
});

const dir = mkdtempSync(path.join(tmpdir(), "run-continuity-"));
const RESULTS = path.join(dir, "results");
process.env.TOUCHSTONE_RESULTS_DIR = RESULTS;
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
process.env.SPEND_LEDGER = path.join(dir, "spend.json");
process.env.PROVIDER = "near";
process.env.NEARAI_API_KEY = "synthetic-key-for-mocked-engine";
const made = []; // workspaces a test deleted from the record's view; removed at the end
after(() => {
  for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
    if (!f.endsWith(".workspace.json")) continue;
    try {
      made.push(JSON.parse(readFileSync(path.join(RESULTS, f), "utf8"))?.ws);
    } catch {
      // a record a test damaged on purpose
    }
  }
  for (const ws of made) if (ws) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// The workspace build with one extra: a test can act on a new workspace before
// the server binds it, as a copied source folder that brings its own files does.
let afterBuild = null;
const realTargets = await import("../lib/targets.mjs");
const prepareRunWorkspace = async (...args) => {
  const ws = await realTargets.prepareRunWorkspace(...args);
  afterBuild?.(ws);
  return ws;
};
const prepareMultiWorkspace = async (...args) => {
  const ws = await realTargets.prepareMultiWorkspace(...args);
  afterBuild?.(ws);
  return ws;
};
mock.module("../lib/targets.mjs", { exports: { ...realTargets, prepareRunWorkspace, prepareMultiWorkspace } });
const { addScope, addLiveScope, removeScope } = await import("../lib/scopes-store.mjs");
const { PACKS } = await import("../packs/index.mjs");
const runs = await import("../../app/server/runs.mjs");
const { createRun, getRun, steerRun, deleteRun, archiveRun } = runs;

// Exercise the HTTP route with real registration and a deliberately blocked setup.
const { handleRuns } = await import("../../app/server/runs-http.mjs");
async function postRun(body) {
  const req = new PassThrough();
  Object.assign(req, {
    method: "POST", url: "/api/runs",
    headers: { "content-type": "application/json", host: "localhost:5173", origin: "http://localhost:5173", "x-touchstone-grant-token": "test-grant-token" },
  });
  const res = { statusCode: 0, setHeader() {}, end(text) { this.json = JSON.parse(text); } };
  const handled = handleRuns(req, res);
  req.end(JSON.stringify(body));
  await handled;
  return res;
}

for (const outcome of ["success", "failure", "stop"]) test(`HTTP run creation returns before setup: ${outcome}`, async () => {
  const live = addLiveScope({ title: "Slow setup", hosts: ["https://example.com"], permission: true, pack: "web" });
  let release;
  const gate = new Promise((resolve, reject) => { release = outcome === "failure" ? () => reject(new Error("setup failed")) : resolve; });
  const prepass = PACKS.web.prepass;
  PACKS.web.prepass = undefined;
  reachHook = () => gate;
  const pending = postRun({ targetId: live.id, pack: "web", mode: "solo" });
  let response;
  try {
    response = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve(null)))]);
    assert.ok(response, "POST must answer while setup is still blocked");
    assert.equal(response.statusCode, 201);
    assert.equal(response.json.status, "starting");
    assert.equal(getRun(response.json.id).status, "starting");
    assert.ok(runs.listRuns().some((r) => r.id === response.json.id));
    if (outcome === "stop") runs.stopRun(response.json.id);
    if (outcome === "success") scripts.push({ events: [done] });
  } finally {
    reachHook = null;
    release();
    await pending;
  }
  const result = await settle(response.json.id);
  PACKS.web.prepass = prepass;
  if (outcome === "failure") {
    assert.equal(result.status, "error");
    assert.equal(result.error, "setup failed");
    assert.ok(result.events.some((e) => e.ev === "status" && e.error === "setup failed"));
  } else if (outcome === "stop") {
    assert.ok(result.events.some((e) => e.ev === "stopped"));
  } else {
    assert.ok(result.events.some((e) => e.ev === "status" && e.status === "running"));
  }
});

test("HTTP run validation still refuses before creating a run", async () => {
  const before = runs.listRuns().length;
  const response = await postRun({ targetId: "does-not-exist", pack: "web" });
  assert.equal(response.statusCode, 400);
  assert.equal(runs.listRuns().length, before);
});

const REPO = "https://github.com/acme/lib";
const WHERE = "vendor/acme__lib";
const scope = addScope({ title: "Acme lib", members: [{ kind: "repo", url: REPO }] });
const fetched = { ev: "source-fetch", url: REPO, ok: true, where: WHERE, files: 3 };
const done = { ev: "settled", status: "done", summary: { final: { text: "I found no exploitable issue." } }, findings: [] };

// What a real engine leaves behind: its saved session, a fetched source, a note.
const SOURCE = path.join(WHERE, "Lib.sol");
function work({ args }) {
  const [, , , db, ws] = args;
  writeFileSync(db, "");
  mkdirSync(path.join(ws, WHERE), { recursive: true });
  writeFileSync(path.join(ws, SOURCE), "// fetched source");
  writeFileSync(path.join(ws, "notes.md"), "lead: unchecked send");
}
// What a follow-up worker finds when it starts.
const look = (call) => {
  const ws = call.args[4];
  call.saw = { source: existsSync(path.join(ws, SOURCE)), note: existsSync(path.join(ws, "notes.md")) };
};

async function settle(id, closedAfter = 0, api = runs) {
  for (let i = 0; i < 500; i++) {
    const r = api.getRun(id);
    const closes = r.events.filter((e) => e.ev === "closed").length;
    if (closes > closedAfter && ["recorded", "denied", "error", "no-finding"].includes(r.status) && !r.replying) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`run ${id} did not settle: ${api.getRun(id).status}`);
}
const start = (extra = {}) => createRun({ targetId: scope.id, pack: "review", mode: "solo", ...extra });
const closes = (id, api = runs) => api.getRun(id).events.filter((e) => e.ev === "closed").length;
const kept = (id) => JSON.parse(readFileSync(path.join(RESULTS, `run-${id}.workspace.json`), "utf8"));
// One finished run with a session, a fetched source and a note.
async function finished(extra) {
  scripts.push({ act: work, events: [fetched, done] });
  const { id } = await start(extra);
  const r = await settle(id);
  assert.equal(r.status, "no-finding");
  return { id, call: spawns.at(-1) };
}
// Every error the operator can read: a full sentence that starts with a capital.
const sentence = /^[A-Z][^\n]*[.]$/;

// ---- A1: the run ends when the engine ends --------------------------------------

test("A1: a settled line cut on the pipe is read from the engine's events file, so the run ends clean", async () => {
  scripts.push({ act: work, events: [fetched], torn: done });
  const { id } = await start();
  const r = await settle(id);
  assert.equal(r.status, "no-finding", "not the no-settle error card");
  assert.equal(r.errorInfo ?? null, null);
  assert.equal(r.events.find((e) => e.ev === "no-finding")?.final, "I found no exploitable issue.");
});

test("A1: a follow-up whose settled line was cut still gives its answer, not 'exited early'", async () => {
  const { id } = await finished();
  scripts.push({ torn: done });
  steerRun(id, "What did you check?");
  const r = await settle(id, 1);
  assert.ok(!r.events.some((e) => e.ev === "reply-error"));
  assert.equal(r.status, "no-finding");
});

test("A1: when the engine really dies, the card says how it ended and what to do", async () => {
  scripts.push({ act: work, stderr: "TypeError: boom\n", code: 1 });
  let r = await settle((await start()).id);
  assert.equal(r.status, "error");
  assert.equal(r.errorInfo?.reason, "no-settle");
  assert.match(r.errorInfo.detail, /^The engine process ended before it reported a result: it exited with the code 1\./);
  assert.match(r.errorInfo.detail, /TypeError: boom/);
  assert.match(r.errorInfo.hint, /Run again/);
  scripts.push({ signal: "SIGKILL" });
  r = await settle((await start()).id);
  assert.match(r.errorInfo.detail, /it was killed by the signal SIGKILL\.$/);
  assert.match(r.errorInfo.message, sentence, "with no error output, the message is still a sentence");
});

// ---- A2: a follow-up keeps the workspace ----------------------------------------

test("A2: a follow-up runs in the workspace the agent left: sources and notes are still there", async () => {
  const { id, call } = await finished();
  const ws = call.args[4];
  assert.ok(existsSync(path.join(ws, SOURCE)), "the run's end did not delete the workspace");
  assert.equal(kept(id).ws, ws);

  scripts.push({ act: look, events: [done] });
  assert.deepEqual(steerRun(id, "Look at Lib.sol again."), { ok: true, followUp: true });
  const r = await settle(id, 1);
  const next = spawns.at(-1);
  assert.equal(next.args[2], "chat");
  assert.equal(next.args[3], call.args[3], "the same saved session: the chat history");
  assert.equal(next.args[4], ws, "the same workspace, not a rebuilt one");
  assert.deepEqual(next.saw, { source: true, note: true });
  assert.ok(!r.events.some((e) => e.ev === "workspace"), "nothing was lost, so nothing is announced");
  assert.equal(next.env.WORKSPACE_NOTE, undefined);
  assert.ok(existsSync(path.join(ws, SOURCE)), "and it is kept for the next follow-up too");
});

for (const duringFollowUp of [false, true]) {
  test(`A2: an unparseable lab config at ${duringFollowUp ? "follow-up" : "initial"} close keeps the workspace and saved files`, async () => {
    const tear = (call) => {
      writeFileSync(path.join(call.args[4], ".touchstone.json"), '{"kind":');
      writeFileSync(path.join(call.args[4], "notes2.md"), "second note");
    };
    scripts.push({ act: (call) => { work(call); if (!duringFollowUp) tear(call); }, events: [fetched, done] });
    const { id } = await start();
    await settle(id);
    const ws = spawns.at(-1).args[4];
    made.push(ws);
    if (duringFollowUp) {
      scripts.push({ act: tear, events: [done] });
      steerRun(id, "Write a second note.");
      await settle(id, 1);
    }
    assert.ok(existsSync(ws), "a torn config must not delete the workspace");
    assert.equal(kept(id).ws, ws);
    assert.equal(readFileSync(path.join(ws, ".touchstone.json"), "utf8"), '{"kind":', "the torn config is not rewritten");
    scripts.push({ act: look, events: [done] });
    steerRun(id, "Read the saved files.");
    const r = await settle(id, duringFollowUp ? 2 : 1);
    const next = spawns.at(-1);
    assert.equal(next.args[4], ws, "the next follow-up uses the kept workspace");
    assert.deepEqual(next.saw, { source: true, note: true });
    assert.equal(readFileSync(path.join(ws, "notes2.md"), "utf8"), "second note");
    assert.equal(readFileSync(path.join(ws, ".touchstone.json"), "utf8"), '{"kind":');
    assert.ok(!r.events.some((e) => e.ev === "reply-error" || e.ev === "workspace"));
    assert.equal(next.env.WORKSPACE_NOTE, undefined);
  });
}

test("A2: when the workspace is really gone, one event tells the operator and the agent the same truth", async () => {
  const { id, call } = await finished();
  rmSync(call.args[4], { recursive: true, force: true });

  scripts.push({ act: look, events: [done] });
  steerRun(id, "Look at Lib.sol again.");
  let r = await settle(id, 1);
  const next = spawns.at(-1);
  assert.notEqual(next.args[4], call.args[4]);
  assert.deepEqual(next.saw, { source: false, note: false });
  const told = r.events.filter((e) => e.ev === "workspace");
  assert.equal(told.length, 1, "one event, not a silent fresh sandbox");
  assert.equal(told[0].state, "rebuilt");
  assert.match(told[0].message, /^The earlier workspace of this run is gone/);
  assert.ok(told[0].message.includes(`${REPO} (was in ${WHERE})`), "it names the fetched source that is gone");
  assert.ok(next.env.WORKSPACE_NOTE.includes(told[0].message), "the agent reads the same text");
  assert.ok(r.events.indexOf(told[0]) > r.events.findLastIndex((e) => e.ev === "reply-start"));

  // The new workspace is kept like the first one: no second notice.
  scripts.push({ events: [done] });
  steerRun(id, "And again.");
  r = await settle(id, 2);
  assert.equal(spawns.at(-1).args[4], next.args[4]);
  assert.equal(r.events.filter((e) => e.ev === "workspace").length, 1);
});

// ---- A4: "Run again" ------------------------------------------------------------

test("A4: Run again after a crash stays in the same run, with its history and its sources", async () => {
  scripts.push({ act: work, events: [fetched], code: 1 });
  const { id } = await start();
  let r = await settle(id);
  assert.equal(r.errorInfo?.reason, "no-settle");
  const first = spawns.at(-1);
  const before = r.events.length;
  const history = JSON.stringify(r.events);

  scripts.push({ act: look, events: [done] });
  steerRun(id, "Continue the audit from where it stopped."); // what the Run again button sends
  r = await settle(id, 1);
  const again = spawns.at(-1);
  assert.equal(again.args[3], first.args[3], "the same session");
  assert.equal(again.args[4], first.args[4], "the same workspace");
  assert.deepEqual(again.saw, { source: true, note: true });
  assert.equal(r.id, id);
  assert.equal(JSON.stringify(r.events.slice(0, before)), history, "every earlier event is still there, unchanged");
  assert.ok(r.events.length > before && r.events[before].ev === "reply-start", "the reply is appended to the same chat");
  assert.equal(r.status, "no-finding", "the old failure is cleared");
  const stream = readFileSync(path.join(RESULTS, `run-${id}.stream.jsonl`), "utf8");
  assert.ok(stream.includes('"source-fetch"') && stream.includes('"reply-start"'), "the saved stream holds both");
});

// ---- A3: a generated lab --------------------------------------------------------

test("A3: a finished run on a generated lab takes a follow-up in the same lab; a lost lab is made again and said so", async () => {
  let makes = 0;
  let teardowns = 0;
  PACKS.genfake = {
    id: "genfake", title: "Gen fake", tier: "P", proof: "evidence",
    teardown: async () => void teardowns++,
    lab: {
      title: "Generated lab", blurb: "Made per run.",
      make: async () => {
        makes++;
        const lab = mkdtempSync(path.join(tmpdir(), "touchstone-supply-"));
        made.push(lab);
        writeFileSync(path.join(lab, ".touchstone.json"), JSON.stringify({ pack: "genfake", kind: "lab" }));
        return lab;
      },
    },
  };
  try {
    scripts.push({ act: work, events: [done] });
    const { id } = await createRun({ targetId: "genfake/lab", pack: "genfake", mode: "solo" });
    await settle(id);
    const lab = spawns.at(-1).args[4];
    assert.equal(makes, 1);
    assert.equal(teardowns, 1, "the run's end still stops what the pack started");

    scripts.push({ act: look, events: [done] });
    assert.deepEqual(steerRun(id, "Show the leaked key again."), { ok: true, followUp: true });
    let r = await settle(id, 1);
    assert.equal(spawns.at(-1).args[4], lab, "the same lab");
    assert.equal(makes, 1, "not generated again");
    assert.equal(spawns.at(-1).saw.note, true);
    assert.equal(teardowns, 2);
    assert.ok(!r.events.some((e) => e.ev === "workspace" || e.ev === "reply-error"));

    rmSync(lab, { recursive: true, force: true });
    scripts.push({ events: [done] });
    steerRun(id, "And now?");
    r = await settle(id, 2);
    assert.equal(makes, 2);
    assert.notEqual(spawns.at(-1).args[4], lab);
    const told = r.events.filter((e) => e.ev === "workspace");
    assert.equal(told.length, 1);
    assert.match(told[0].message, /The lab was generated again with new throwaway keys/);
    assert.equal(teardowns, 3, "nothing of the rebuilt lab is left running");

    // The lab is lost again and cannot be made: the reply says so, and the run stays open.
    rmSync(spawns.at(-1).args[4], { recursive: true, force: true });
    const make = PACKS.genfake.lab.make;
    PACKS.genfake.lab.make = async () => {
      throw new Error("Docker is not running.");
    };
    const before = spawns.length;
    steerRun(id, "Once more.");
    r = await settle(id, 3);
    assert.equal(spawns.length, before, "no agent starts without a workspace");
    assert.equal(r.events.findLast((e) => e.ev === "reply-error").error, "The workspace of this run is gone, and a new one could not be built: Docker is not running. Fix the cause, then send the message again.");
    PACKS.genfake.lab.make = make;
    scripts.push({ events: [done] });
    steerRun(id, "Once more.");
    r = await settle(id, 4);
    assert.equal(makes, 3, "the next message builds the lab");
    assert.equal(r.events.filter((e) => e.ev === "reply-error").length, 1);
  } finally {
    delete PACKS.genfake;
  }
});

// ---- Safety ---------------------------------------------------------------------

test("safety: a follow-up gets no route to a target, and spend carries forward once", async () => {
  scripts.push({ act: work, events: [fetched, { ev: "spend", usd: 0.5 }, done] });
  const { id } = await start({ budgetUsd: 1 });
  await settle(id);
  const first = spawns.at(-1);

  scripts.push({ events: [{ ev: "spend", usd: 0.7 }, done] }); // the engine reports the running total
  steerRun(id, "One more check.");
  await settle(id, 1);
  let next = spawns.at(-1);
  for (const k of ["TOUCHSTONE_SCOPE_PROXY", "TOUCHSTONE_SCOPE_ALLOW"]) assert.equal(next.env[k], undefined, `${k} is not set`);
  assert.equal(Number(next.env.RUN_SPENT_USD), 0.5);
  assert.equal(next.env.RUN_BUDGET_USD, first.env.RUN_BUDGET_USD, "the same budget");
  assert.equal(next.env.SPEND_CAP_USD, first.env.SPEND_CAP_USD, "the same total cap");

  scripts.push({ events: [{ ev: "spend", usd: 1 }, done] });
  steerRun(id, "And one more.");
  await settle(id, 2);
  next = spawns.at(-1);
  assert.equal(Number(next.env.RUN_SPENT_USD), 0.7, "0.5 then 0.7 is 0.7 spent, not 1.2");

  // The budget is spent now: the next message is refused, in a full sentence.
  const count = spawns.length;
  assert.throws(() => steerRun(id, "More."), (err) => /spent its budget of \$1\b/.test(err.message) && sentence.test(err.message));
  assert.equal(spawns.length, count, "no worker starts");
});

test("safety: after a restart the run keeps its workspace and its own scope, even when the library scope is gone", async () => {
  const own = addScope({ title: "Acme lib, soon deleted", members: [{ kind: "repo", url: REPO }] });
  scripts.push({ act: work, events: [fetched, done] });
  const { id } = await createRun({ targetId: own.id, pack: "review", mode: "solo" });
  await settle(id);
  const ws = spawns.at(-1).args[4];
  assert.equal(kept(id).target.id, own.id, "the record holds the run's own scope");
  removeScope(own.id);

  // A new server process: an empty registry, and the module evaluated again.
  delete globalThis.__touchstoneRuns;
  const server = await import(`../../app/server/runs.mjs?restart-${Date.now()}`);
  assert.equal(server.getRun(id).status, "no-finding");

  scripts.push({ act: look, events: [done] });
  server.steerRun(id, "Still there?");
  await settle(id, closes(id, server), server);
  assert.equal(spawns.at(-1).args[4], ws);
  assert.deepEqual(spawns.at(-1).saw, { source: true, note: true });

  // Now the workspace is lost too. The scope comes from the run's record.
  rmSync(ws, { recursive: true, force: true });
  scripts.push({ events: [done] });
  server.steerRun(id, "And now?");
  const r = await settle(id, closes(id, server), server);
  assert.equal(r.events.filter((e) => e.ev === "workspace").length, 1);
  assert.ok(!r.events.some((e) => e.ev === "reply-error"));
  assert.equal(kept(id).target.id, own.id);
  assert.ok(!existsSync(path.join(spawns.at(-1).args[4], "BRIEF.md")), "the scope text is not a workspace file");
  assert.match(spawns.at(-1).env.SCOPE_NOTES, /Acme lib, soon deleted/, "the new worker gets the same scope");
});

test("safety: kept workspaces are capped; a run that lost its workspace this way still takes a follow-up", async () => {
  process.env.TOUCHSTONE_KEEP_WORKSPACES = "1";
  try {
    const a = await finished();
    await new Promise((res) => setTimeout(res, 20)); // the record times must differ
    const b = await finished();
    assert.ok(!existsSync(a.call.args[4]), "the older workspace is removed");
    assert.ok(existsSync(b.call.args[4]), "the newest is kept");
    scripts.push({ events: [done] });
    steerRun(a.id, "Still with me?");
    const r = await settle(a.id, 1);
    assert.equal(r.events.filter((e) => e.ev === "workspace").length, 1);
  } finally {
    delete process.env.TOUCHSTONE_KEEP_WORKSPACES;
  }
});

test("deleting a run deletes its kept workspace", async () => {
  const { id, call } = await finished();
  assert.ok(existsSync(call.args[4]));
  deleteRun(id);
  assert.ok(!existsSync(call.args[4]));
  assert.ok(existsSync(path.join(RESULTS, "trash", `run-${id}.workspace.json`)));
});

// A stored replay file, as a proven finding leaves it (replay/<sha256>.json). With
// an id, that run's record names it.
const replayFile = (c) => path.join(RESULTS, "replay", `${c.repeat(64)}.json`);
function storeReplay(c, id) {
  mkdirSync(path.join(RESULTS, "replay"), { recursive: true });
  writeFileSync(replayFile(c), "{}");
  if (!id) return;
  const file = path.join(RESULTS, `run-${id}.json`);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  rec.result.findings = [...(rec.result.findings ?? []), { title: "T", proof: { replay: { store: { sha256: c.repeat(64) } } } }];
  writeFileSync(file, JSON.stringify(rec));
}

test("deleting a run removes the replay files only it named; nothing goes while a record cannot be read or another run works", async () => {
  const [a, b, c, d] = [await finished(), await finished(), await finished(), await finished()];
  for (const [letter, run] of [["a", a], ["b", b], ["c", c], ["d", d]]) storeReplay(letter, run.id);
  deleteRun(a.id);
  assert.ok(!existsSync(replayFile("a")), "the deleted run's replay file is gone");
  assert.ok(["b", "c", "d"].every((l) => existsSync(replayFile(l))), "a file that another record names stays");

  // A record that cannot be read: the prune removes nothing.
  const torn = path.join(RESULTS, "run-torn.json");
  writeFileSync(torn, '{"result": ');
  try {
    deleteRun(c.id);
    assert.ok(existsSync(replayFile("c")));
  } finally {
    rmSync(torn);
  }

  // Run B works. Its proof check has stored a replay file that no record names yet.
  scripts.push({ hang: true });
  steerRun(b.id, "Go on.");
  storeReplay("e");
  deleteRun(d.id);
  assert.ok(existsSync(replayFile("e")), "a working run's new replay file is not removed");
  assert.ok(existsSync(replayFile("d")), "so this prune waits");
  // B's record names the file, then B ends: the prune that was owed runs.
  storeReplay("e", b.id);
  runs.stopRun(b.id);
  await settle(b.id, 1);
  assert.deepEqual(readdirSync(path.join(RESULTS, "replay")).sort(), [`${"b".repeat(64)}.json`, `${"e".repeat(64)}.json`]);
  deleteRun(b.id);
  assert.deepEqual(readdirSync(path.join(RESULTS, "replay")), []);
});

// ---- Safety: the record's path is checked before a delete or a reuse --------------

const record = (id) => path.join(RESULTS, `run-${id}.workspace.json`);
const point = (id, ws) => writeFileSync(record(id), JSON.stringify({ ...kept(id), ws }));

test("safety: a record that names another run's workspace does not delete it", async () => {
  const a = await finished();
  const b = await finished();
  made.push(a.call.args[4]);
  point(a.id, b.call.args[4]);
  deleteRun(a.id);
  assert.ok(existsSync(path.join(b.call.args[4], "notes.md")), "run B keeps its workspace");
  scripts.push({ act: look, events: [done] });
  steerRun(b.id, "Still there?");
  await settle(b.id, 1);
  assert.equal(spawns.at(-1).args[4], b.call.args[4]);
  assert.deepEqual(spawns.at(-1).saw, { source: true, note: true });
});

test("safety: a record that names some other temp folder does not delete it, by delete or by the cap", async () => {
  // One folder that carries the run's mark but has no workspace name, and one
  // with the name but no mark: no run kept it.
  const other = mkdtempSync(path.join(tmpdir(), "not-a-workspace-"));
  const unbound = mkdtempSync(path.join(tmpdir(), "redteam-run-"));
  made.push(other, unbound);
  for (const folder of [other, unbound]) {
    writeFileSync(path.join(folder, "keep.txt"), "not the run's file");
    const a = await finished();
    made.push(a.call.args[4]);
    if (folder === other) writeFileSync(path.join(folder, ".touchstone-run"), a.id);
    point(a.id, folder);
    deleteRun(a.id);
    assert.ok(existsSync(path.join(folder, "keep.txt")), `${path.basename(folder)} is left alone`);
  }
  process.env.TOUCHSTONE_KEEP_WORKSPACES = "1";
  try {
    const a = await finished();
    made.push(a.call.args[4]);
    point(a.id, other);
    await new Promise((res) => setTimeout(res, 20)); // the record times must differ
    await finished(); // its end runs the cap, and run A's record is over it
    assert.ok(existsSync(path.join(other, "keep.txt")), "the cap leaves the folder alone");
    assert.equal(kept(a.id).ws, undefined, "the record no longer names the path");
  } finally {
    delete process.env.TOUCHSTONE_KEEP_WORKSPACES;
  }
});

test("safety: a link under the temp folder does not lead a delete outside it", async () => {
  // The temp folder for this test is dir/tmp, so dir/outside is outside it.
  const before = process.env.TMPDIR;
  process.env.TMPDIR = path.join(dir, "tmp");
  const outside = path.join(dir, "outside");
  mkdirSync(process.env.TMPDIR);
  mkdirSync(outside);
  try {
    const a = await finished();
    // The victim even carries the run's mark. Its parent is not the temp folder.
    const victim = path.join(outside, "redteam-run-abc123");
    mkdirSync(victim);
    writeFileSync(path.join(victim, "keep.txt"), "outside the temp folder");
    writeFileSync(path.join(victim, ".touchstone-run"), a.id);
    symlinkSync(outside, path.join(tmpdir(), "link"));
    point(a.id, path.join(tmpdir(), "link", "redteam-run-abc123"));
    deleteRun(a.id);
    assert.ok(existsSync(path.join(victim, "keep.txt")), "a link parent is not followed");

    // A link is refused even when it leads to a marked directory in the temp folder.
    const b = await finished();
    const inside = path.join(tmpdir(), "redteam-run-def456");
    mkdirSync(inside);
    writeFileSync(path.join(inside, ".touchstone-run"), b.id);
    const link = path.join(tmpdir(), "redteam-run-linked");
    symlinkSync(inside, link);
    point(b.id, link);
    scripts.push({ events: [done] });
    steerRun(b.id, "Where am I?");
    const r = await settle(b.id, 1);
    assert.ok(![link, inside].includes(spawns.at(-1).args[4]), "a link is not reused");
    assert.equal(r.events.filter((e) => e.ev === "workspace").length, 1);

    // The temp folder itself can be named through a link (macOS does this). The
    // check compares canonical paths, so the workspace is still kept and reused.
    symlinkSync(path.join(dir, "tmp"), path.join(dir, "tmp-link"));
    process.env.TMPDIR = path.join(dir, "tmp-link");
    const c = await finished();
    assert.equal(kept(c.id).ws, realpathSync(c.call.args[4]), "the record holds the canonical path");
    scripts.push({ act: look, events: [done] });
    steerRun(c.id, "Still there?");
    await settle(c.id, 1);
    assert.deepEqual(spawns.at(-1).saw, { source: true, note: true });
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test("safety: a follow-up does not reuse another run's workspace; it gets a new one and says so", async () => {
  const a = await finished();
  const b = await finished();
  made.push(a.call.args[4]);
  point(a.id, b.call.args[4]);
  scripts.push({ act: (call) => writeFileSync(path.join(call.args[4], "from-a.txt"), "run A wrote this"), events: [done] });
  steerRun(a.id, "Carry on.");
  const r = await settle(a.id, 1);
  const ws = spawns.at(-1).args[4];
  assert.notEqual(ws, b.call.args[4]);
  assert.ok(!existsSync(path.join(b.call.args[4], "from-a.txt")), "run A's agent did not write into run B's workspace");
  const events = r.events.filter((e) => e.ev === "workspace");
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "rebuilt");
  assert.equal(kept(a.id).ws, ws, "the record names the new workspace");
});

// ---- Safety: a kept workspace holds no credential ---------------------------------

// Every file under a folder that holds one of the texts.
function holding(folder, texts) {
  const hits = [];
  for (const e of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    const body = readFileSync(file, "latin1");
    if (texts.some((t) => body.includes(t))) hits.push(path.relative(folder, file));
  }
  return hits;
}

// Synthetic values. No real credential is used.
const TOKEN = "synthetic-reader-token-0001";
const ADMIN = "synthetic-admin-token-0002";
const GONE = "The access token of this run's scope is no longer in the scope library, so this follow-up runs without it.";
const liveScope = () => addLiveScope({ title: "MCP lab", hosts: ["127.0.0.1"], pack: "ai-mcp", permission: true, allowPrivate: true, token: TOKEN, tokens: { [TOKEN]: ["read"], [ADMIN]: ["admin"] }, toolScope: { echo: "read" } });
// What the agent can read when a worker starts. The scope text is in the
// instructions of every agent (SCOPE_NOTES), never a workspace file, and never
// holds a token. The token reaches the root agent only, in the pack's first
// message, which reads it from the config (as BRIEF.md did before).
const read = (call) => {
  const ws = call.args[4];
  assert.ok(!existsSync(path.join(ws, "BRIEF.md")));
  assert.ok(![TOKEN, ADMIN].some((t) => Object.values(call.env).some((v) => String(v).includes(t))), "no worker env value holds a token");
  call.brief = PACKS["ai-mcp"].kickoff(ws, {});
  call.mcp = JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8")).mcp;
  call.note = existsSync(path.join(ws, "notes.md")) ? readFileSync(path.join(ws, "notes.md"), "utf8") : null;
};
// A new server process: no copy in memory. The old one holds its run locks
// until a test closes them, as the OS does when a process dies.
let boots = 0;
const restart = async () => {
  delete globalThis.__touchstoneRuns;
  return import(`../../app/server/runs.mjs?restart-${++boots}`);
};
const lockOf = (id) => globalThis.__touchstoneRuns.runs.get(id).owner;
// The live AI/MCP pack with no pre-pass: there is no live target to scan.
async function withLivePack(fn) {
  const real = { prepass: PACKS["ai-mcp"].prepass, teardown: PACKS["ai-mcp"].teardown };
  PACKS["ai-mcp"].prepass = undefined;
  PACKS["ai-mcp"].teardown = undefined;
  try {
    await fn();
  } finally {
    Object.assign(PACKS["ai-mcp"], real);
  }
}

test("safety: a kept live AI/MCP workspace holds no credential; a follow-up gets it back from the scope library, or is told it is gone", async () => {
  const live = liveScope();
  await withLivePack(async () => {
    scripts.push({
      act: (call) => {
        read(call);
        writeFileSync(call.args[3], "");
        writeFileSync(path.join(call.args[4], "notes.md"), `curl -H "Authorization: Bearer ${ADMIN}" works`);
      },
      events: [done],
    });
    const { id } = await createRun({ targetId: live.id, pack: "ai-mcp", mode: "solo" });
    await settle(id);
    const first = spawns.at(-1);
    const ws = first.args[4];
    assert.ok(first.brief.includes(TOKEN), "the run itself has the token");
    assert.deepEqual(Object.keys(first.mcp.tokens), [TOKEN, ADMIN]);

    // After the run: no kept file holds a credential.
    assert.ok(existsSync(path.join(ws, "notes.md")), "the workspace is kept");
    assert.deepEqual(holding(ws, [TOKEN, ADMIN]), [], "no file in the kept workspace");
    assert.ok(![TOKEN, ADMIN].some((t) => readFileSync(record(id), "utf8").includes(t)), "not the record");
    assert.deepEqual(kept(id).target.mcp, { toolScope: { echo: "read" } }, "the record keeps what the token may do, not the token");
    assert.deepEqual(holding(RESULTS, [TOKEN, ADMIN]), [], "no file of the run in the results folder");

    // The scope is in the library: the follow-up gets the credential again.
    let server = await restart();
    scripts.push({ act: read, events: [done] });
    server.steerRun(id, "Try the admin token again.");
    let r = await settle(id, closes(id, server), server);
    const second = spawns.at(-1);
    assert.equal(second.args[4], ws);
    assert.equal(second.brief, first.brief);
    assert.deepEqual(second.mcp, first.mcp);
    assert.ok(second.note.includes(ADMIN), "the agent's own note has the token back");
    assert.ok(!r.events.some((e) => e.ev === "workspace"), "nothing to tell the operator");
    assert.deepEqual(holding(ws, [TOKEN, ADMIN]), [], "and it leaves again when the follow-up ends");
    assert.ok(![TOKEN, ADMIN].some((t) => readFileSync(record(id), "utf8").includes(t)));

    // The scope is gone: the follow-up runs without the credential and says so.
    removeScope(live.id);
    server = await restart();
    scripts.push({ act: read, events: [done] });
    server.steerRun(id, "And now?");
    r = await settle(id, closes(id, server), server);
    const third = spawns.at(-1);
    assert.equal(third.args[4], ws);
    assert.ok(![TOKEN, ADMIN].some((t) => third.brief.includes(t) || third.note.includes(t)));
    assert.deepEqual(third.mcp, { toolScope: { echo: "read" } });
    const told = r.events.filter((e) => e.ev === "workspace");
    assert.equal(told.length, 1);
    assert.equal(told[0].message, "The access token of this run's scope is no longer in the scope library, so this follow-up runs without it.");
    assert.ok(third.env.WORKSPACE_NOTE.includes(told[0].message), "the agent is told the same");
    assert.match(third.env.WORKSPACE_NOTE, /Live requests are unavailable/, "the credential note and live limitation both survive");
    assert.ok(!r.events.some((e) => e.ev === "reply-error"));

    // The same when the workspace is gone too: one event, both facts.
    rmSync(ws, { recursive: true, force: true });
    scripts.push({ act: read, events: [done] });
    server.steerRun(id, "And without the files?");
    r = await settle(id, closes(id, server), server);
    const fourth = spawns.at(-1);
    made.push(fourth.args[4]);
    assert.ok(!fourth.brief.includes("Bearer token"));
    assert.equal(fourth.mcp.token, undefined);
    const again = r.events.filter((e) => e.ev === "workspace");
    assert.equal(again.length, 2);
    assert.equal(again[1].state, "rebuilt");
    assert.ok(again[1].message.endsWith(told[0].message));
  });
});


// ---- Safety: a JOINED run's credential, whatever the module order -------------

// A joined scope: the site module and the MCP module in ONE run. The credential
// lives in the ai-mcp module and nowhere else.
const livePair = (packs) => addLiveScope({ title: "Site and MCP", hosts: ["127.0.0.1"], pack: packs, permission: true, allowPrivate: true, token: TOKEN, tokens: { [TOKEN]: ["read"], [ADMIN]: ["admin"] }, toolScope: { echo: "read" } });
// What a worker can read: the ai-mcp module's own config. The token reaches the
// root agent only, in that module's first message, which reads the config.
const readJoined = (call) => {
  const ws = call.args[4];
  assert.ok(!existsSync(path.join(ws, "modules", "ai-mcp", "BRIEF.md")), "no old scope file");
  call.brief = PACKS["ai-mcp"].kickoff(path.join(ws, "modules", "ai-mcp"), {});
  call.mcp = JSON.parse(readFileSync(path.join(ws, "modules", "ai-mcp", ".touchstone.json"), "utf8")).mcp;
};

for (const packs of [["web", "ai-mcp"], ["ai-mcp", "web"]]) {
  test(`safety: a joined run (${packs.join(", ")}) keeps no credential, and scrubs it again after a follow-up`, async () => {
    await withLivePack(async () => {
      const live = livePair(packs);
      // The engine child reads the workspace while the run is live, before the
      // end scrubs it.
      scripts.push({ act: (call) => {
        readJoined(call);
        writeFileSync(call.args[3], "");
        writeFileSync(path.join(call.args[4], "notes.md"), `curl -H "Authorization: Bearer ${ADMIN}" works`);
      }, events: [done] });
      const { id } = await createRun({ targetId: live.id, packs, mode: "solo" });
      await settle(id);
      const first = spawns.at(-1);
      const ws = first.args[4];
      // One workspace, one part per module.
      assert.deepEqual(readdirSync(path.join(ws, "modules")), [...packs].sort());
      const root = JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8"))
      assert.equal(root.pack, "multi");
      assert.deepEqual(root.packs, packs);
      assert.deepEqual(kept(id).packs, packs, "the record keeps the modules");
      assert.deepEqual(runs.getRun(id).packs, packs, "and so does the view");
      assert.ok(first.env.SCOPE_NOTES.includes("127.0.0.1"), "the scope notes reach the agent");
      // The run itself had the token in the ai-mcp module only.
      assert.ok(first.brief.includes(TOKEN), "the module that needs it had it");
      assert.deepEqual(Object.keys(first.mcp.tokens), [TOKEN, ADMIN]);
      assert.ok(!existsSync(path.join(ws, "modules", "web", "BRIEF.md")));
      // After the end: no file under the kept workspace holds a credential, and
      // no config holds it either.
      assert.deepEqual(holding(ws, [TOKEN, ADMIN]), [], "no file in the kept workspace");
      const cfg = readFileSync(path.join(ws, "modules", "ai-mcp", ".touchstone.json"), "utf8");
      assert.ok(!cfg.includes(TOKEN) && !cfg.includes(ADMIN), "the config is scrubbed as JSON too");
      assert.deepEqual(JSON.parse(cfg).mcp, { toolScope: { echo: "read" } });
      assert.deepEqual(kept(id).target.mcp, { toolScope: { echo: "read" } });
      assert.deepEqual(holding(RESULTS, [TOKEN, ADMIN]), []);

      // A follow-up gets the credential back in the ai-mcp module, and it leaves again.
      const server = await restart();
      scripts.push({ act: readJoined, events: [done] });
      server.steerRun(id, "Try the admin token again.");
      const r = await settle(id, closes(id, server), server);
      const second = spawns.at(-1);
      assert.equal(second.args[4], ws);
      assert.ok(second.brief.includes(TOKEN), "the module that needs it has it back");
      assert.deepEqual(Object.keys(second.mcp.tokens), [TOKEN, ADMIN]);
      assert.ok(!r.events.some((e) => e.ev === "workspace"), "nothing to tell the operator");
      assert.deepEqual(holding(ws, [TOKEN, ADMIN]), [], "and it leaves again when the follow-up ends");
    });
  });
}

// A path under `modules/` that is a link out of the workspace. The real thing is
// moved outside, under a name no run owns, and a link stands in its place. A
// scrub or a restore that follows it writes into the outside copy.
let outside = 0;
function linkOut(ws, rel, empty = false) {
  const from = path.join(ws, rel);
  const to = path.join(dir, `outside-${++outside}`);
  if (empty) mkdirSync(to);
  else cpSync(from, to, { recursive: true });
  rmSync(from, { recursive: true, force: true });
  symlinkSync(to, from, lstatSync(to).isDirectory() ? "dir" : "file");
  return to;
}
const outsideBytes = (p) => lstatSync(p).isDirectory()
  ? [...readdirSync(p, { withFileTypes: true, recursive: true })].filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath, e.name), "latin1")).join("\u0000")
  : readFileSync(p, "latin1");

for (const [rel, empty] of [["modules", false], ["modules", true], ["modules/ai-mcp", false], ["modules/ai-mcp/.touchstone.json", false]]) {
  test(`safety: a link at ${rel}${empty ? " (an empty folder)" : ""} sends no write outside; the follow-up rebuilds`, async () => {
    await withLivePack(async () => {
      const live = livePair(["web", "ai-mcp"]);
      scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [done] });
      const { id } = await createRun({ targetId: live.id, packs: ["web", "ai-mcp"], mode: "solo" });
      await settle(id);
      const ws = spawns.at(-1).args[4];
      made.push(ws);
      assert.deepEqual(holding(ws, [TOKEN, ADMIN]), []);
      const out = linkOut(ws, rel, empty);
      const before = outsideBytes(out);
      const server = await restart();
      scripts.push({ act: readJoined, events: [done] });
      server.steerRun(id, "Go on.");
      const r = await settle(id, closes(id, server), server);
      const fresh = spawns.at(-1).args[4];
      made.push(fresh);
      // The folder went and a new one was built, joined and clean.
      assert.notEqual(fresh, ws, "the linked workspace is not reused");
      assert.ok(!existsSync(ws), "it is removed");
      assert.ok(existsSync(path.join(fresh, "modules", "ai-mcp")), "both modules are built again");
      assert.deepEqual(r.events.filter((e) => e.ev === "workspace").map((e) => e.state), ["rebuilt"]);
      assert.deepEqual(holding(fresh, [TOKEN, ADMIN]), []);
      // Nothing outside changed: no token, no rewrite.
      assert.equal(outsideBytes(out), before, `nothing outside the workspace changed (${rel})`);
    });
  });
}

// A worker that submits a finding and then dies: the finding must still record,
// unproven. A one-module run does that today through `run.submitted`; a joined
// run used to drop it because the row had no module.
test("a joined worker that dies after submitting still records the finding, unproven", async () => {
  await withLivePack(async () => {
    const live = livePair(["web", "ai-mcp"]);
    scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [
      // No `pack`: an older engine, or a worker that died before the stamp.
      { t: 1, ev: "finding-submitted", n: 1, title: "IDOR on /api/orders", severity: "high", poc: "replay-1" },
      { t: 2, ev: "status", status: "running" },
    ], code: 1 });
    const { id } = await createRun({ targetId: live.id, packs: ["web", "ai-mcp"], mode: "solo" });
    const r = await settle(id);
    assert.deepEqual(r.submitted.map((f) => f.title), ["IDOR on /api/orders"]);
    const rec = JSON.parse(readFileSync(path.join(RESULTS, `run-${id}.json`), "utf8")).result;
    assert.equal(rec.findings.length, 1, "the finding is in the record");
    assert.equal(rec.findings[0].pack, undefined, "it names no module, and is kept anyway");
    assert.equal(rec.findings[0].pocProved, false, "and it is not proven without a replay");
    // A second worker names its module: the record and the finding event carry
    // it, so the Findings page shows the right pill. Domains' own prepass and
    // replay need a live capture, so they are stubbed here.
    const real = { prepass: PACKS.domains.prepass, prove: PACKS.domains.prove };
    PACKS.domains.prepass = undefined;
    PACKS.domains.prove = async (ws, found) => found.map((f) => ({ ...f, pocProved: true }));
    try {
      scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [
        { t: 1, ev: "finding-submitted", pack: "domains", n: 1, title: "Dangling CNAME", severity: "high", poc: "cdn-1" },
      ], code: 1 });
      const second = await createRun({ targetId: live.id, packs: ["web", "domains"], mode: "solo" });
      const r2 = await settle(second.id);
      made.push(spawns.at(-1).args[4]);
      const rec2 = JSON.parse(readFileSync(path.join(RESULTS, `run-${second.id}.json`), "utf8")).result;
      assert.deepEqual(rec2.findings.map((f) => f.pack), ["domains"]);
      assert.ok(r2.events.some((e) => e.ev === "finding" && e.pack === "domains"), `${r2.status} | ${r2.error}`);
    } finally {
      Object.assign(PACKS.domains, real);
    }
  });
});

test("a joined run the SERVER builds plans fetch, holds the fetch tools, and both modules can read", async () => {
  const { packFor } = await import("../packs/index.mjs");
  const { readTouchstone } = await import("../lib/sandbox.mjs");
  fetchClones.length = 0;
  scripts.push({
    act: async (call) => {
      writeFileSync(call.args[3], "");
      const ws = call.args[4];
      const pack = packFor(readTouchstone(ws));
      const tools = new Map(pack.tools(ws, { poc: 0, found: [], passed: new Map() }).map((t) => [t.name, t]));
      call.tools = [...tools.keys()];
      await tools.get("fetch_source_review").execute({ url: REPO });
      call.reviewList = (await tools.get("list_sources_review").execute({})).output.map((o) => o.text).join("");
      call.contractsList = (await tools.get("list_sources_contracts").execute({})).output.map((o) => o.text).join("");
    },
    events: [fetched, done],
  });
  const { id } = await createRun({ targetId: scope.id, packs: ["review", "contracts"], mode: "solo" });
  const r = await settle(id);
  made.push(spawns.at(-1).args[4]);
  // The server's plan has the fetch step, as a one-module run does.
  const plan = r.events.find((e) => e.ev === "modules").modules;
  assert.equal(plan.find((m) => m.id === "fetch")?.on, true, "the server plan turns fetch on");
  // The tools are the run's own, suffixed.
  assert.ok(spawns.at(-1).tools.includes("fetch_source_review") && spawns.at(-1).tools.includes("fetch_source_contracts"));
  // One clone, and both modules list the fetched file.
  assert.equal(fetchClones.length, 1);
  assert.match(spawns.at(-1).reviewList, /vendor\/acme__lib\/src\/app\.ts/);
  assert.match(spawns.at(-1).contractsList, /vendor\/acme__lib\/src\/Vault\.sol/);
});

test("a joined run that read its scope is not a coverage error; one that did not is", async () => {
  // 2d removed BRIEF.md, so the coverage count is the only honest "was it read".
  scripts.push({ act: work, events: [fetched, done] });
  const read = await createRun({ targetId: scope.id, packs: ["review", "contracts"], mode: "solo" });
  const r = await settle(read.id);
  made.push(spawns.at(-1).args[4]);
  assert.equal(r.status === "error", false, r.error ?? "");
  assert.notEqual(r.errorInfo?.kind, "coverage");

  scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [done] });
  const unread = await createRun({ targetId: scope.id, packs: ["review", "contracts"], mode: "solo" });
  const r2 = await settle(unread.id);
  made.push(spawns.at(-1).args[4]);
  assert.equal(r2.status, "error");
  assert.equal(r2.errorInfo?.kind, "coverage");
  assert.match(r2.error, /1 of 1 scope member was not read/);
});

test("a joined follow-up refuses a duplicate of a finding the run already holds", async () => {
  await withLivePack(async () => {
    const live = livePair(["web", "ai-mcp"]);
    scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [
      { t: 1, ev: "finding-submitted", pack: "web", n: 1, title: "IDOR on /api/orders", severity: "high", poc: "replay-1" },
      // An older row: no module. Both must reach the worker named.
      { t: 2, ev: "finding-submitted", n: 2, title: "Old claim", severity: "low", poc: "replay-2" },
      done,
    ] });
    const { id } = await createRun({ targetId: live.id, packs: ["web", "ai-mcp"], mode: "solo" });
    const r = await settle(id);
    made.push(spawns.at(-1).args[4]);
    assert.deepEqual(r.submitted.map((f) => f.poc), ["replay-1", "replay-2"]);
    // The prior list the worker gets names the module, so web's own duplicate
    // check sees the earlier finding.
    const server = await restart();
    scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [done] });
    server.steerRun(id, "Anything else?");
    await settle(id, closes(id, server), server);
    const call = spawns.at(-1);
    assert.deepEqual(JSON.parse(call.env.PRIOR_FOUND).map((f) => [f.poc, f.pack]), [["replay-1", "web"], ["replay-2", undefined]]);
  });
});

test("safety: a joined run rebuilt from nothing is rebuilt joined, with no credential", async () => {
  await withLivePack(async () => {
    const live = livePair(["web", "ai-mcp"]);
    scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [done] });
    const { id } = await createRun({ targetId: live.id, packs: ["web", "ai-mcp"], mode: "solo" });
    await settle(id);
    const ws = spawns.at(-1).args[4];
    made.push(ws);
    rmSync(ws, { recursive: true, force: true });
    const server = await restart();
    scripts.push({ act: readJoined, events: [done] });
    server.steerRun(id, "Start the files again.");
    const r = await settle(id, closes(id, server), server);
    const fresh = spawns.at(-1).args[4];
    made.push(fresh);
    assert.notEqual(fresh, ws);
    assert.ok(existsSync(path.join(fresh, "modules", "web")) && existsSync(path.join(fresh, "modules", "ai-mcp")), "both modules are built again");
    assert.deepEqual(r.events.filter((e) => e.ev === "workspace").map((e) => e.state), ["rebuilt"]);
    assert.deepEqual(holding(fresh, [TOKEN, ADMIN]), []);
  });
});

// ---- Safety: a server stop during a follow-up --------------------------------------

// A finished live run on a new server. Its agent wrote the admin token into a note.
async function liveEnded(server) {
  const live = liveScope();
  scripts.push({
    act: (call) => {
      writeFileSync(call.args[3], "");
      writeFileSync(path.join(call.args[4], "notes.md"), `curl -H "Authorization: Bearer ${ADMIN}" works`);
    },
    events: [done],
  });
  const { id } = await server.createRun({ targetId: live.id, pack: "ai-mcp", mode: "solo" });
  await settle(id, 0, server);
  const ws = spawns.at(-1).args[4];
  made.push(ws); // removed at the end, also when a test fails before the server deletes it
  assert.deepEqual(holding(ws, [TOKEN, ADMIN]), []);
  return { id, ws, live };
}
// Then a follow-up whose worker never exits. The server "stops" in the middle of
// the turn: the credential is back in the files, and nothing ended the turn.
async function stoppedMidTurn(server) {
  const run = await liveEnded(server);
  scripts.push({ hang: true });
  server.steerRun(run.id, "Go on.");
  assert.deepEqual(holding(run.ws, [TOKEN, ADMIN]).sort(), [".touchstone.json", "notes.md"], "the turn has the credential");
  assert.equal(kept(run.id).restored, true, "and the record says so");
  return { ...run, lock: lockOf(run.id) };
}

test("safety: a server that stops during a follow-up leaves no credential: the next boot scrubs the workspace, or deletes it when the scope is gone", async () => {
  await withLivePack(async () => {
    let server = await restart();
    const a = await stoppedMidTurn(server);
    const b = await stoppedMidTurn(server);
    removeScope(b.live.id);
    a.lock.close(); // the old server is dead
    b.lock.close();
    server = await restart();

    // Run A: its scope still has the credential, so the boot finds every copy.
    assert.deepEqual(holding(a.ws, [TOKEN, ADMIN]), [], "no file holds the token after the boot");
    assert.ok(existsSync(path.join(a.ws, "notes.md")), "the workspace is kept");
    assert.equal(kept(a.id).restored, undefined);
    assert.deepEqual(holding(RESULTS, [TOKEN, ADMIN]), []);
    scripts.push({ act: read, events: [done] });
    server.steerRun(a.id, "Go on.");
    await settle(a.id, closes(a.id, server), server);
    assert.ok(spawns.at(-1).brief.includes(TOKEN) && spawns.at(-1).note.includes(ADMIN), "the next follow-up has it back");
    assert.deepEqual(holding(a.ws, [TOKEN, ADMIN]), []);

    // Run B: nobody knows the credential now, so the files cannot be trusted.
    assert.ok(!existsSync(b.ws), "the workspace is deleted");
    assert.deepEqual([kept(b.id).ws, kept(b.id).restored], [undefined, undefined]);
    scripts.push({ act: read, events: [done] });
    server.steerRun(b.id, "Go on.");
    const r = await settle(b.id, closes(b.id, server), server);
    const told = r.events.filter((e) => e.ev === "workspace");
    assert.deepEqual(told.map((e) => e.state), ["rebuilt"]);
    assert.ok(told[0].message.endsWith(GONE));
    assert.deepEqual(holding(spawns.at(-1).args[4], [TOKEN, ADMIN]), []);
  });
});

test("safety: a follow-up that finds a restored credential does not hand it on: without the scope it gets a new workspace, with the scope the files are scrubbed when it ends", async () => {
  await withLivePack(async () => {
    let server = await restart();
    const a = await stoppedMidTurn(server);
    const b = await stoppedMidTurn(server);
    // The old server still runs at the boot, so the boot leaves both runs alone.
    server = await restart();
    assert.equal(holding(a.ws, [TOKEN, ADMIN]).length, 2); // .touchstone.json and notes.md; no BRIEF.md any more
    removeScope(a.live.id);
    assert.throws(() => server.steerRun(a.id, "Go on."), /Another server is already answering this run/);
    assert.ok(existsSync(a.ws), "a run that another server answers keeps its workspace");
    a.lock.close(); // now the old server is dead
    b.lock.close();

    // Run A: no scope, and a folder the server cannot delete. The refusal says so.
    const locked = path.join(a.ws, "locked");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "file"), "x");
    chmodSync(locked, 0o500);
    try {
      assert.throws(() => server.steerRun(a.id, "Go on."), (err) => sentence.test(err.message) && err.message.includes(`could not be removed. Delete the folder ${a.ws},`));
      assert.equal(kept(a.id).restored, true, "the record still says what the folder holds");
    } finally {
      chmodSync(locked, 0o700);
    }
    // Now it can be deleted: the follow-up gets a new workspace and the true sentence.
    scripts.push({ act: read, events: [done] });
    server.steerRun(a.id, "Go on.");
    let r = await settle(a.id, closes(a.id, server), server);
    const fresh = spawns.at(-1);
    assert.ok(!existsSync(a.ws), "the workspace with the token is gone");
    assert.notEqual(fresh.args[4], a.ws);
    assert.ok(![TOKEN, ADMIN].some((t) => fresh.brief.includes(t)) && fresh.note === null, "the agent got no token");
    const told = r.events.filter((e) => e.ev === "workspace");
    assert.deepEqual(told.map((e) => e.state), ["rebuilt"]);
    assert.ok(told[0].message.endsWith(GONE));
    assert.deepEqual(holding(fresh.args[4], [TOKEN, ADMIN]), []);
    assert.deepEqual(holding(RESULTS, [TOKEN, ADMIN]), []);

    // Run B: the scope is there. The follow-up has the credential, and it leaves at the end.
    scripts.push({ act: read, events: [done] });
    server.steerRun(b.id, "Go on.");
    r = await settle(b.id, closes(b.id, server), server);
    assert.equal(spawns.at(-1).args[4], b.ws);
    assert.ok(spawns.at(-1).brief.includes(TOKEN));
    assert.ok(!r.events.some((e) => e.ev === "workspace"));
    assert.deepEqual(holding(b.ws, [TOKEN, ADMIN]), [], "scrubbed with the credential the follow-up put back");
    assert.ok(existsSync(path.join(b.ws, "notes.md")));
    assert.equal(kept(b.id).restored, undefined);
  });
});

test("safety: a credential that cannot be put back gives one reply error and no worker, and a workspace that cannot be scrubbed is deleted", async () => {
  await withLivePack(async () => {
    const server = await restart();
    const { id, ws } = await liveEnded(server);
    writeFileSync(path.join(ws, "locked.bin"), "x");
    chmodSync(path.join(ws, "locked.bin"), 0); // the server cannot read it, so it cannot look for the token in it
    const before = spawns.length;
    server.steerRun(id, "Go on.");
    const r = await settle(id, 1, server);
    const errors = r.events.filter((e) => e.ev === "reply-error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /^The access token could not be put back into the workspace: .* Send the message again to retry\.$/);
    assert.equal(spawns.length, before, "no worker started");
    assert.equal(kept(id).restored, true, "the record was marked before the first file was written");
    assert.ok(!existsSync(ws), "the scrub failed too, so the workspace is deleted");
  });
});

test("safety: a scope store that cannot be read is not a scope that is gone: the boot leaves a marked workspace alone, and a follow-up is refused and changes nothing", async () => {
  await withLivePack(async () => {
    let server = await restart();
    const a = await stoppedMidTurn(server); // marked: the token is in its files
    const c = await liveEnded(server); // kept and clean
    a.lock.close();
    const store = process.env.TOUCHSTONE_SCOPES_FILE;
    const good = readFileSync(store);
    writeFileSync(store, "{ this is not a list");
    try {
      server = await restart();
      assert.equal(holding(a.ws, [TOKEN, ADMIN]).length, 2, "the boot leaves the workspace alone"); // .touchstone.json and notes.md
      assert.equal(kept(a.id).restored, true, "and the mark stays for the next boot");
      const before = spawns.length;
      const refused = (run) => {
        const rec = readFileSync(record(run.id), "utf8");
        const events = server.getRun(run.id).events.length;
        assert.throws(() => server.steerRun(run.id, "Go on."), { message: "The scope library cannot be read, so this follow-up did not start. Repair the scope store file, then send the message again." });
        assert.equal(readFileSync(record(run.id), "utf8"), rec, "the record is not changed");
        assert.equal(server.getRun(run.id).events.length, events, "the chat gets no event");
      };
      refused(a);
      refused(c);
      assert.equal(holding(a.ws, [TOKEN, ADMIN]).length, 2);
      assert.ok(existsSync(path.join(c.ws, "notes.md")), "no workspace is deleted");
      rmSync(c.ws, { recursive: true, force: true });
      refused(c); // also when the record names a path that fails the check
      assert.equal(spawns.length, before, "no worker started");
    } finally {
      writeFileSync(store, good);
    }
    // The store is repaired: the next boot scrubs, and a follow-up has the token again.
    server = await restart();
    assert.deepEqual(holding(a.ws, [TOKEN, ADMIN]), []);
    assert.equal(kept(a.id).restored, undefined);
    scripts.push({ act: read, events: [done] });
    server.steerRun(a.id, "Go on.");
    await settle(a.id, closes(a.id, server), server);
    assert.ok(spawns.at(-1).brief.includes(TOKEN));
  });
});

test("safety: the boot clean-up does not touch a workspace that is not the run's own, with the scope present or gone", async () => {
  await withLivePack(async () => {
    let server = await restart();
    const a = await stoppedMidTurn(server); // its scope stays
    const g = await stoppedMidTurn(server); // its scope goes
    const b = await liveEnded(server);
    const canary = path.join(b.ws, "canary.txt");
    writeFileSync(canary, `run B's own file: ${TOKEN}`); // a scrub would change it
    point(a.id, b.ws);
    point(g.id, b.ws);
    assert.equal(kept(a.id).restored, true);
    removeScope(g.live.id);
    a.lock.close();
    g.lock.close();
    server = await restart();
    assert.equal(readFileSync(canary, "utf8"), `run B's own file: ${TOKEN}`, "not scrubbed");
    assert.ok(existsSync(path.join(b.ws, "notes.md")), "not deleted");
    for (const run of [a, g]) assert.deepEqual([kept(run.id).ws, kept(run.id).restored], [undefined, undefined], "the path leaves the record");
  });
});

test("safety: the mark put back after a failed delete does not write through a link", async () => {
  const a = await finished();
  const ws = a.call.args[4];
  made.push(ws); // its mark becomes a link, so the cap can take it out of the record
  const locked = path.join(ws, "locked");
  mkdirSync(locked);
  writeFileSync(path.join(locked, "file"), "x");
  chmodSync(locked, 0o500); // the delete fails part way
  const victim = path.join(dir, "victim.txt");
  writeFileSync(victim, "untouched");
  // At that moment a link stands where the mark was.
  onRmFail = (folder) => {
    rmSync(path.join(folder, ".touchstone-run"), { force: true });
    symlinkSync(victim, path.join(folder, ".touchstone-run"));
  };
  try {
    assert.throws(() => deleteRun(a.id));
    assert.equal(readFileSync(victim, "utf8"), "untouched");
  } finally {
    onRmFail = null;
    chmodSync(locked, 0o700);
  }
});

test("safety: a workspace whose record says it holds a credential that nobody knows is not kept", async () => {
  const a = await finished();
  writeFileSync(record(a.id), JSON.stringify({ ...kept(a.id), restored: true }));
  scripts.push({ events: [done] });
  steerRun(a.id, "Go on.");
  await settle(a.id, 1);
  assert.ok(!existsSync(a.call.args[4]));
});

// ---- K4: orphan workspaces ---------------------------------------------------------

const markOf = (ws) => readFileSync(path.join(ws, ".touchstone-run"), "utf8");
// A temp folder with a workspace name, one file, and the mark text given.
function folder(mark) {
  const ws = mkdtempSync(path.join(tmpdir(), "redteam-run-"));
  made.push(ws);
  writeFileSync(path.join(ws, "keep.txt"), "a file");
  if (mark) writeFileSync(path.join(ws, ".touchstone-run"), mark);
  return ws;
}
// Boot a new server and collect what it logs about the temp folder.
async function boot() {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    return { server: await restart(), swept: lines.filter((l) => l.includes("temp folders with a workspace name")) };
  } finally {
    console.warn = warn;
  }
}

test("the boot removes a temp folder that carries this server's mark and that no run record names; every other folder is left alone", async () => {
  const a = await finished();
  const c = await finished();
  const wsA = a.call.args[4];
  const ghost = markOf(wsA).replace(a.id, "ghost-2611130900-1");
  assert.notEqual(ghost, markOf(wsA));
  // Orphans: the mark names a run that no record names, or a run whose record points elsewhere.
  const gone = { "no record names the run": folder(ghost), "the run's record points elsewhere": folder(markOf(wsA)) };
  // Not ours to touch.
  const outside = path.join(dir, "outside-sweep", "redteam-run-abc124");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, ".touchstone-run"), ghost);
  const link = path.join(tmpdir(), "redteam-run-lnk0k4");
  symlinkSync(outside, link);
  made.push(link);
  const linkedMark = folder();
  writeFileSync(path.join(dir, "a-mark"), ghost);
  symlinkSync(path.join(dir, "a-mark"), path.join(linkedMark, ".touchstone-run"));
  const stays = {
    "no mark": folder(),
    "a mark of the older form": folder("ghost-2611130900-1"),
    "a mark of another results folder": folder(`ghost-2611130900-1\n${"0".repeat(32)}`),
    "a mark that is a link": linkedMark,
    "a link to a marked folder outside the temp folder": outside,
    "the kept workspace of a run": wsA,
  };
  // A run whose record is there but cannot be read: the record may name the folder.
  const idOf = (name) => `ghost-${name}-2611130900-1`;
  const markFor = (name) => markOf(wsA).replace(a.id, idOf(name));
  for (const [name, text] of [["torn", '{"ws":'], ["closed", "{}"], ["null", "null"], ["list", "[]"]]) {
    stays[`its run's record cannot be read (${name})`] = folder(markFor(name));
    writeFileSync(record(idOf(name)), text);
  }
  chmodSync(record(idOf("closed")), 0);
  // A record that names the folder by another spelling of its path.
  const spelled = folder(markFor("spelled"));
  writeFileSync(record(idOf("spelled")), JSON.stringify({ ws: `${path.dirname(spelled)}/./${path.basename(spelled)}` }));
  stays["its run's record names it by another spelling"] = spelled;
  // A lock file that cannot be opened says nothing about who works on the run.
  stays["its run's lock cannot be read"] = folder(markFor("badlock"));
  writeFileSync(path.join(RESULTS, `run-${idOf("badlock")}.owner.sqlite`), "this is not a database");
  // A mark whose first line is not a run id: it would go into file paths.
  const trav = "../../../outside-sweep/trav";
  stays["a mark that holds a path, not a run id"] = folder(markOf(wsA).replace(a.id, trav));
  const lure = path.join(dir, "outside-sweep", "run-trav.owner.sqlite"); // where that id would lead
  new DatabaseSync(lure).close();
  // An orphan that cannot be deleted in one go: a part stays, and the delete took its mark.
  const stuck = folder(markFor("stuck"));
  mkdirSync(path.join(stuck, "locked"));
  writeFileSync(path.join(stuck, "locked", "file"), "x");
  chmodSync(path.join(stuck, "locked"), 0o500);
  onRmFail = (target) => target === stuck && rmSync(path.join(stuck, ".touchstone-run"), { force: true });
  // Another live server answers run C right now, so a folder with C's mark waits.
  const busy = folder(markOf(c.call.args[4]));
  const otherServer = new DatabaseSync(path.join(RESULTS, `run-${c.id}.owner.sqlite`));
  otherServer.exec("BEGIN IMMEDIATE");
  try {
    // A folder of another user is never touched. Here every folder looks like one.
    const getuid = process.getuid;
    process.getuid = () => getuid() + 1;
    try {
      await boot();
    } finally {
      process.getuid = getuid;
    }
    for (const [why, ws] of Object.entries(gone)) assert.ok(existsSync(path.join(ws, "keep.txt")), `another user's folder stays (${why})`);

    const { swept } = await boot();
    for (const [why, ws] of Object.entries(gone)) assert.ok(!existsSync(ws), `removed: ${why}`);
    for (const [why, ws] of Object.entries(stays)) assert.ok(existsSync(ws), `left alone: ${why}`);
    assert.ok(existsSync(path.join(wsA, "notes.md")) && existsSync(link));
    assert.ok(existsSync(path.join(busy, "keep.txt")), "a run that another server answers keeps the folder for now");
    assert.ok(!existsSync(`${lure}-journal`) && readdirSync(path.dirname(lure)).length === 2, "nothing outside the results folder was opened");
    // The part that stayed has its mark back, in the same form, so the next boot finds it.
    assert.ok(existsSync(path.join(stuck, "locked", "file")));
    assert.equal(markOf(stuck), markFor("stuck"));
    // One log line with the counts.
    assert.equal(swept.length, 1);
    const [, removed, unread, unmarked, foreign] = /: (\d+) with this server's mark and no run record were removed; (\d+) with a run record that cannot be read, (\d+) with no mark and (\d+) with another mark were left alone\.$/.exec(swept[0]).map(Number);
    assert.ok(removed === 2 && unread === 4 && unmarked >= 2 && foreign >= 3, swept[0]);
  } finally {
    otherServer.close();
    onRmFail = null;
    chmodSync(path.join(stuck, "locked"), 0o700);
    chmodSync(record(idOf("closed")), 0o600);
  }
  // A reload of the module in the same process does not sweep again.
  const late = folder(ghost);
  await import(`../../app/server/runs.mjs?reload-${Date.now()}`);
  assert.ok(existsSync(late), "one sweep per server process");
  // The next boot: the other server is gone, so its folder goes too. The kept workspaces stay.
  await boot();
  assert.ok(!existsSync(busy) && !existsSync(late) && !existsSync(stuck));
  assert.ok(existsSync(c.call.args[4]) && existsSync(wsA));
});

test("a workspace that a follow-up built belongs to the run at once: after a server stop the next boot scrubs it, or deletes it when the scope is gone, and a later follow-up reuses it", async () => {
  await withLivePack(async () => {
    let server = await restart();
    // A follow-up whose workspace is gone gets a new one. Its worker never exits, and the server stops.
    const rebuilt = async (run) => {
      rmSync(run.ws, { recursive: true, force: true });
      scripts.push({ hang: true });
      const before = spawns.length;
      server.steerRun(run.id, "Go on.");
      for (let i = 0; i < 300 && spawns.length === before; i++) await new Promise((res) => setTimeout(res, 10));
      const ws = spawns.at(-1).args[4];
      made.push(ws);
      assert.notEqual(ws, run.ws);
      assert.equal(kept(run.id).ws, ws, "the record names the new workspace before the worker ends");
      assert.equal(markOf(ws).split("\n")[0], run.id, "and the folder carries the run's mark");
      return { ...run, ws, lock: lockOf(run.id) };
    };
    const a = await rebuilt(await liveEnded(server));
    const b = await rebuilt(await liveEnded(server));
    scripts.push({ act: work, events: [fetched, done] });
    const plain = await server.createRun({ targetId: scope.id, pack: "review", mode: "solo" });
    await settle(plain.id, 0, server);
    const p = await rebuilt({ id: plain.id, ws: spawns.at(-1).args[4] });
    for (const run of [a, b]) {
      assert.deepEqual(holding(run.ws, [TOKEN, ADMIN]), [".touchstone.json"], "the new workspace has the credential");
      assert.equal(kept(run.id).restored, true, "and the record says so");
    }
    assert.equal(kept(p.id).restored, undefined, "a scope without a credential needs no such mark");
    removeScope(b.live.id);
    for (const run of [a, b, p]) run.lock.close(); // the old server is dead
    server = await restart();

    // Run A: the scope has the credential, so the boot takes every copy out. The workspace stays.
    assert.deepEqual(holding(a.ws, [TOKEN, ADMIN]), []);
    assert.equal(kept(a.id).restored, undefined);
    // Run B: nobody knows the credential now, so the workspace is deleted.
    assert.ok(!existsSync(b.ws));
    // A later follow-up works in the same workspace: no second rebuild.
    for (const run of [a, p]) {
      const events = server.getRun(run.id).events.filter((e) => e.ev === "workspace").length;
      scripts.push({ events: [done] });
      server.steerRun(run.id, "Go on.");
      const r = await settle(run.id, closes(run.id, server), server);
      assert.equal(spawns.at(-1).args[4], run.ws);
      assert.equal(r.events.filter((e) => e.ev === "workspace").length, events, "no new workspace event");
    }
    assert.deepEqual(holding(a.ws, [TOKEN, ADMIN]), []);
  });
});

test("a mark that a new workspace already holds does not stop the bind: the run's own mark replaces it, a link is not followed, and the next boot takes the credential out", async () => {
  await withLivePack(async () => {
    let server = await restart();
    const victim = path.join(dir, "bind-victim.txt");
    writeFileSync(victim, "untouched");
    const plants = {
      file: (ws) => writeFileSync(path.join(ws, ".touchstone-run"), "what the copied source brought"),
      link: (ws) => symlinkSync(victim, path.join(ws, ".touchstone-run")),
    };
    const runsOf = {};
    for (const [kind, plant] of Object.entries(plants)) {
      const run = await liveEnded(server);
      rmSync(run.ws, { recursive: true, force: true });
      scripts.push({ hang: true });
      const before = spawns.length;
      afterBuild = plant;
      try {
        server.steerRun(run.id, "Go on.");
        for (let i = 0; i < 300 && spawns.length === before; i++) await new Promise((res) => setTimeout(res, 10));
      } finally {
        afterBuild = null;
      }
      const ws = spawns.at(-1).args[4];
      made.push(ws);
      assert.equal(kept(run.id).ws, ws);
      assert.ok(readdirSync(ws, { withFileTypes: true }).find((e) => e.name === ".touchstone-run").isFile(), `${kind}: the mark is a real file`);
      assert.equal(markOf(ws).split("\n")[0], run.id, `${kind}: the folder carries the run's mark`);
      runsOf[kind] = { ...run, ws, lock: lockOf(run.id) };
    }
    assert.equal(readFileSync(victim, "utf8"), "untouched", "nothing was written through the link");
    for (const run of Object.values(runsOf)) run.lock.close(); // the old server is dead
    server = await restart();
    for (const [kind, run] of Object.entries(runsOf)) {
      assert.deepEqual(holding(run.ws, [TOKEN, ADMIN]), [], `${kind}: the boot took the credential out`);
      assert.equal(kept(run.id).ws, run.ws, `${kind}: the run keeps the workspace`);
    }
  });
});

// ---- A6: a workspace that is built again gets the code this run read ------------------

// Local git repos that stand for https://github.com/<owner>/<repo>. Real git, no network.
const GIT_REMOTE = path.join(dir, "git-remote");
const gitEnv = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: `url.file://${GIT_REMOTE}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/", GIT_CONFIG_KEY_1: "protocol.file.allow", GIT_CONFIG_VALUE_1: "always" };
const git = (repo, ...args) => realChild.execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
function gitCommit(repo, files) {
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}
async function withGit(fn) {
  Object.assign(process.env, gitEnv);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(gitEnv)) delete process.env[k];
  }
}
// A finished run on a repo scope whose agent fetched the repo at `commit`.
async function fetchedAt(url, where, commit, extra = {}) {
  const pinned = addScope({ title: `Scope ${where}`, members: [{ kind: "repo", url }] });
  scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [{ ev: "source-fetch", url, ok: true, where, files: 1, ...(commit === undefined ? {} : { commit }) }, done] });
  const { id } = await createRun({ targetId: pinned.id, pack: "review", mode: "solo", ...extra });
  await settle(id);
  return { id, ws: spawns.at(-1).args[4] };
}
// A follow-up after the workspace was lost. Returns the new workspace, its event and what the agent was told.
async function lostAndRebuilt(run, read = () => {}) {
  rmSync(run.ws, { recursive: true, force: true });
  const n = closes(run.id);
  scripts.push({ act: read, events: [done] });
  steerRun(run.id, "Look again.");
  const r = await settle(run.id, n);
  const ws = spawns.at(-1).args[4];
  made.push(ws);
  run.ws = ws;
  return { ws, told: r.events.findLast((e) => e.ev === "workspace"), note: spawns.at(-1).env.WORKSPACE_NOTE, call: spawns.at(-1) };
}
const pinsOf = (ws) => JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8")).pins;

test("A6: a lost workspace is built again with the code this run read, at the same commit, also after the branch moved on", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/pinned";
    const where = "vendor/acme__pinned";
    const repo = path.join(GIT_REMOTE, "acme", "pinned.git");
    const first = gitCommit(repo, { "src/Lib.ts": "export const v = 1\n" });
    const run = await fetchedAt(url, where, first);
    gitCommit(repo, { "src/Lib.ts": "export const v = 2\n" }); // the branch moves on
    const read = (call) => (call.code = readFileSync(path.join(call.args[4], where, "src", "Lib.ts"), "utf8"));
    const { ws, told, note, call } = await lostAndRebuilt(run, read);
    assert.equal(call.code, "export const v = 1\n", "the agent finds the code this run read, not the head of today");
    assert.equal(told.state, "rebuilt");
    assert.ok(told.message.includes(`These fetched sources are in it again, as this run read them before: ${url} (commit ${first.slice(0, 12)}, in ${where}).`), told.message);
    assert.ok(!told.message.includes("newest version"));
    assert.ok(note.includes(told.message), "the agent reads the same text");
    // The pin stays in the workspace: a later fetch of the member reads the same commit.
    assert.deepEqual(pinsOf(ws), { [url]: { commit: first } });
    assert.equal((await realFetch.restoreSource(ws, url)).commit, first);
    assert.equal(readFileSync(path.join(ws, where, "src", "Lib.ts"), "utf8"), "export const v = 1\n");
  });
});

test("A6: a commit that is gone is named to the operator and the agent, and no other code takes its place", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/moved";
    const where = "vendor/acme__moved";
    const repo = path.join(GIT_REMOTE, "acme", "moved.git");
    const first = gitCommit(repo, { "src/Lib.ts": "export const v = 1\n" });
    const run = await fetchedAt(url, where, first);
    // A force-push: the commit is no longer in the repository.
    git(repo, "checkout", "-q", "--orphan", "fresh");
    gitCommit(repo, { "src/Lib.ts": "export const v = 99\n" });
    git(repo, "branch", "-q", "-M", "main");
    git(repo, "reflog", "expire", "--expire=now", "--all");
    git(repo, "gc", "-q", "--prune=now");
    const { ws, told, note } = await lostAndRebuilt(run);
    const said = `These fetched sources could not be put back, so they are not in it: ${url}: could not fetch commit ${first.slice(0, 12)} of acme/moved, the commit this run read before: `;
    assert.ok(told.message.includes(said), told.message);
    assert.match(told.message, /The fetch is refused, so this run does not read other code in its place\. If the commit is gone \(a force-push, or a deleted repository\), start a new run/);
    assert.ok(note.includes(told.message), "the agent reads the same text");
    assert.ok(!existsSync(path.join(ws, where)), "the code of today is not in the workspace");
    // The follow-up went on, but a fetch of that member stays refused in this run.
    assert.deepEqual(pinsOf(ws), { [url]: { commit: first } });
    await assert.rejects(realFetch.restoreSource(ws, url), /could not fetch commit/);
    assert.ok(!existsSync(path.join(ws, where)));
  });
});

test("A6: a run from before commits were recorded is rebuilt as before and says the code can differ; a commit that cannot be read is not 'no commit'", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/older";
    const where = "vendor/acme__older";
    gitCommit(path.join(GIT_REMOTE, "acme", "older.git"), { "src/Lib.ts": "export const v = 1\n" });
    // No commit in the event: an older record.
    const old = await fetchedAt(url, where, undefined);
    let got = await lostAndRebuilt(old);
    assert.ok(got.told.message.includes(`These fetched sources are not in it: ${url} (was in ${where}). A new fetch gets the newest version, which can differ from the one read before.`), got.told.message);
    assert.equal(pinsOf(got.ws), undefined, "no pin: a new fetch is as before");
    assert.ok(!existsSync(path.join(got.ws, where)), "the server fetches nothing it cannot pin");
    // A commit field that is there but is not a commit: refused, not fetched at the head.
    const bad = await fetchedAt(url, where, "not-a-commit");
    got = await lostAndRebuilt(bad);
    assert.ok(got.told.message.includes(`could not be put back, so they are not in it: ${url}: refused ${url}: the record of what this run read before for this source cannot be read`), got.told.message);
    assert.ok(!got.told.message.includes("newest version"));
    assert.ok(!existsSync(path.join(got.ws, where)));
  });
});

test("A6: when the new workspace cannot take the pins, the follow-up does not start", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/nopins";
    const first = gitCommit(path.join(GIT_REMOTE, "acme", "nopins.git"), { "src/Lib.ts": "export const v = 1\n" });
    const run = await fetchedAt(url, "vendor/acme__nopins", first);
    rmSync(run.ws, { recursive: true, force: true });
    const before = spawns.length;
    const n = closes(run.id);
    afterBuild = (ws) => {
      made.push(ws);
      writeFileSync(path.join(ws, ".touchstone.json"), '{"links":');
    };
    try {
      steerRun(run.id, "Look again.");
      const r = await settle(run.id, n);
      assert.equal(spawns.length, before, "no worker started");
      assert.match(r.events.findLast((e) => e.ev === "reply-error").error, /^The workspace of this run is gone, and the new one could not be told which code this run read before: .* So this follow-up did not start\. Send the message again to retry\.$/);
      assert.ok(!r.events.some((e) => e.ev === "workspace"));
    } finally {
      afterBuild = null;
    }
  });
});

// A restore that failed before it wrote the pins. The workspace has no sources. The
// next message must not use it as it is: the server puts the sources back first.
async function failsBeforePins(name, breakConfig, repairConfig) {
  const url = `https://github.com/acme/${name}`;
  const where = `vendor/acme__${name}`;
  const first = gitCommit(path.join(GIT_REMOTE, "acme", `${name}.git`), { "src/Lib.ts": "export const v = 1\n" });
  const run = await fetchedAt(url, where, first);
  rmSync(run.ws, { recursive: true, force: true });
  let ws = null;
  let good = null;
  afterBuild = (built) => {
    ws = built;
    made.push(built);
    good = readFileSync(path.join(built, ".touchstone.json"), "utf8");
    breakConfig(path.join(built, ".touchstone.json"));
  };
  let before = spawns.length;
  try {
    steerRun(run.id, "Look again.");
    const r = await settle(run.id, 1);
    assert.equal(spawns.length, before, "no worker started");
    assert.match(r.events.findLast((e) => e.ev === "reply-error").error, /could not be told which code this run read before/);
  } finally {
    afterBuild = null;
  }
  assert.equal(kept(run.id).ws, ws, "the new workspace is the run's workspace now");
  assert.ok(!existsSync(path.join(ws, where)), "and it has no sources");
  assert.equal(kept(run.id).restoring, true, "the record says the sources are not back");
  // The same fault is still there: the next message starts no worker and says why.
  steerRun(run.id, "Look again.");
  let r = await settle(run.id, 2);
  assert.equal(spawns.length, before, "no worker in a workspace without its sources");
  assert.match(r.events.findLast((e) => e.ev === "reply-error").error, /^The fetched sources of this run's workspace could not be put back: .* So this follow-up did not start\. Send the message again to retry\.$/);
  assert.equal(kept(run.id).restoring, true);
  // The fault is gone: the next message puts the sources back first, and says so.
  repairConfig(path.join(ws, ".touchstone.json"), good);
  scripts.push({ act: (call) => (call.code = readFileSync(path.join(call.args[4], where, "src", "Lib.ts"), "utf8")), events: [done] });
  before = spawns.length;
  steerRun(run.id, "Look again.");
  r = await settle(run.id, 3);
  const call = spawns.at(-1);
  assert.equal(spawns.length, before + 1);
  assert.equal(call.args[4], ws);
  assert.equal(call.code, "export const v = 1\n", "the worker finds the source, at its commit");
  const told = r.events.findLast((e) => e.ev === "workspace");
  assert.equal(told.state, "kept");
  assert.ok(told.message.includes(`${url} (commit ${first.slice(0, 12)}, in ${where})`), told.message);
  assert.ok(call.env.WORKSPACE_NOTE.includes(told.message));
  assert.equal(kept(run.id).restoring, undefined);
}

test("A6: a restore that fails because the new workspace's config cannot be read is not forgotten: the next message puts the sources back first", async () => {
  await withGit(() => failsBeforePins("torncfg", (file) => writeFileSync(file, '{"links":'), (file, good) => writeFileSync(file, good)));
});

test("A6: a restore that fails because the pins cannot be written is not forgotten: the next message puts the sources back first", async () => {
  // The config can be read but not written, as on a full disk.
  await withGit(() => failsBeforePins("nowrite", (file) => chmodSync(file, 0o400), (file) => chmodSync(file, 0o600)));
});

test("A6: a joined run gets the restored code in the run's tree and in each module that reads code", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/joined";
    const where = "vendor/acme__joined";
    const repo = path.join(GIT_REMOTE, "acme", "joined.git");
    const first = gitCommit(repo, { "src/Lib.ts": "export const v = 1\n" });
    const run = await fetchedAt(url, where, first, { pack: undefined, packs: ["review", "contracts"] });
    gitCommit(repo, { "src/Lib.ts": "export const v = 2\n" });
    const { ws, told } = await lostAndRebuilt(run);
    assert.ok(told.message.includes(`(commit ${first.slice(0, 12)}, in ${where})`), told.message);
    for (const at of [".", "modules/review", "modules/contracts"]) {
      assert.equal(readFileSync(path.join(ws, at, where, "src", "Lib.ts"), "utf8"), "export const v = 1\n", at);
    }
  });
});

// ---- A6 minors ------------------------------------------------------------------

test("A6: the pin is found whatever the event's spelling of the URL, and a fetch that gives another commit is not 'the same'", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/spelled";
    const where = "vendor/acme__spelled";
    const repo = path.join(GIT_REMOTE, "acme", "spelled.git");
    const first = gitCommit(repo, { "src/Lib.ts": "export const v = 1\n" });
    gitCommit(repo, { "src/Lib.ts": "export const v = 2\n" });
    // The event spells the member with a trailing slash, or with .git.
    for (const spelled of [`${url}/`, `${url}.git`]) {
      const scopeOf = addScope({ title: `Scope ${spelled}`, members: [{ kind: "repo", url }] });
      scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [{ ev: "source-fetch", url: spelled, ok: true, where, files: 1, commit: first }, done] });
      const { id } = await createRun({ targetId: scopeOf.id, pack: "review", mode: "solo" });
      await settle(id);
      const { ws, told } = await lostAndRebuilt({ id, ws: spawns.at(-1).args[4] });
      assert.deepEqual(pinsOf(ws), { [url]: { commit: first } }, "the pin is under the member's own URL");
      assert.equal(readFileSync(path.join(ws, where, "src", "Lib.ts"), "utf8"), "export const v = 1\n", `${spelled}: the commit this run read, not the head of today`);
      assert.ok(told.message.includes(`in it again, as this run read them before: ${url} (commit ${first.slice(0, 12)}, in ${where}).`), told.message);
    }
    // A fetch that comes back with another commit: the code does not stay, and the event does not call it the same.
    const run = await fetchedAt(url, where, first);
    restoreHook = async (ws, u, real) => ({ ...(await real(ws, u)), commit: "f".repeat(40) });
    try {
      const { ws, told } = await lostAndRebuilt(run);
      assert.ok(told.message.includes(`could not be put back, so they are not in it: ${url}: the fetch did not give what this run read before, so its result was taken out again.`), told.message);
      assert.ok(!told.message.includes("in it again"));
      assert.ok(!existsSync(path.join(ws, where)));
    } finally {
      restoreHook = null;
    }
  });
});

// A finished run whose agent fetched two repos, each at its first commit. The branches moved on since.
async function twoFetched(api, name, count = 2) {
  const members = Array.from({ length: count }, (_, k) => k + 1).map((n) => ({ url: `https://github.com/acme/${name}${n}`, where: `vendor/acme__${name}${n}`, repo: path.join(GIT_REMOTE, "acme", `${name}${n}.git`) }));
  for (const m of members) {
    m.commit = gitCommit(m.repo, { "src/Lib.ts": "export const v = 1\n" });
    gitCommit(m.repo, { "src/Lib.ts": "export const v = 2\n" });
  }
  const scopeOf = addScope({ title: `Scope ${name}`, members: members.map((m) => ({ kind: "repo", url: m.url })) });
  scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [...members.map((m) => ({ ev: "source-fetch", url: m.url, ok: true, where: m.where, files: 1, commit: m.commit })), done] });
  const { id } = await api.createRun({ targetId: scopeOf.id, pack: "review", mode: "solo" });
  await settle(id, 0, api);
  return { id, ws: spawns.at(-1).args[4], members };
}
const codeOf = (ws, m) => (existsSync(path.join(ws, m.where, "src", "Lib.ts")) ? readFileSync(path.join(ws, m.where, "src", "Lib.ts"), "utf8") : null);

test("A6: the restore says what it does, one event per source, and Stop ends it before the next source; the next follow-up finishes it", async () => {
  await withGit(async () => {
    const run = await twoFetched(runs, "prog");
    const [m1, m2] = run.members;
    rmSync(run.ws, { recursive: true, force: true });
    const before = spawns.length;
    // The operator presses Stop while the first source is fetched.
    let stop = null;
    restoreHook = async (ws, u, real) => {
      stop ??= runs.stopRun(run.id);
      return real(ws, u);
    };
    let r;
    try {
      steerRun(run.id, "Look again.");
      r = await settle(run.id, 1);
    } finally {
      restoreHook = null;
    }
    assert.deepEqual(stop, { ok: true }, "Stop is taken while the workspace is prepared");
    assert.equal(spawns.length, before, "no worker started");
    const said = r.events.filter((e) => e.ev === "workspace");
    assert.deepEqual(said.map((e) => [e.state, e.message]), [
      ["restoring", "The fetched sources of this run are put back into its workspace, as this run read them before: 2 to fetch. Each one can take up to 90 seconds."],
      ["restoring", "Fetching acme/prog1 (1 of 2)."],
      ["restoring", "The restore stopped after 1 of 2 sources. The next message to this run puts the sources back first."],
    ], "one event before, one per source, none for the source after the Stop, and one that says it stopped");
    assert.ok(!said.some((e) => e.message.includes(tmpdir()) || e.message.includes(dir)), "no path of this host");
    assert.deepEqual(r.events.slice(-4).map((e) => e.ev), ["stop-requested", "workspace", "stopped", "closed"]);
    const ws = kept(run.id).ws;
    made.push(ws);
    assert.deepEqual([codeOf(ws, m1), codeOf(ws, m2)], ["export const v = 1\n", null], "the first source is there, the second is not");
    assert.equal(kept(run.id).restoring, true, "the record says the restore is not done");

    // The next follow-up works in the same workspace, after the server put the rest back.
    scripts.push({ act: (call) => (call.code = codeOf(call.args[4], m2)), events: [done] });
    steerRun(run.id, "Go on.");
    r = await settle(run.id, 2);
    const call = spawns.at(-1);
    assert.equal(call.args[4], ws);
    assert.equal(call.code, "export const v = 1\n", "the worker finds the second source, at its commit");
    const told = r.events.findLast((e) => e.ev === "workspace");
    assert.equal(told.state, "kept");
    assert.ok(told.message.startsWith("The fetched sources of this workspace were not all put back when its last follow-up ended, so the server did that now. These fetched sources are in it again, as this run read them before: "), told.message);
    assert.ok(told.message.includes(`${m2.url} (commit ${m2.commit.slice(0, 12)}, in ${m2.where})`));
    assert.ok(call.env.WORKSPACE_NOTE.includes(told.message), "the agent reads the same text");
    assert.equal(kept(run.id).restoring, undefined);
    assert.deepEqual(r.events.filter((e) => e.ev === "workspace" && e.state === "restoring").map((e) => e.message).slice(-2), ["Fetching acme/prog1 (1 of 2).", "Fetching acme/prog2 (2 of 2)."]);
    // Done: a later follow-up says nothing more and fetches nothing.
    const events = r.events.filter((e) => e.ev === "workspace").length;
    scripts.push({ events: [done] });
    steerRun(run.id, "And again.");
    r = await settle(run.id, 3);
    assert.equal(r.events.filter((e) => e.ev === "workspace").length, events);
  });
});

test("A6: a server stop while the sources are put back is not hidden: the next follow-up puts them back and names them", async () => {
  await withGit(async () => {
    let server = await restart();
    const run = await twoFetched(server, "half");
    const [m1, m2] = run.members;
    rmSync(run.ws, { recursive: true, force: true });
    // The fetch of the second source never ends, and the server dies.
    let hung;
    const waiting = new Promise((res) => (hung = res));
    restoreHook = (ws, u, real) => (u === m2.url ? (hung(), new Promise(() => {})) : real(ws, u));
    server.steerRun(run.id, "Look again.");
    await waiting;
    restoreHook = null;
    const ws = kept(run.id).ws;
    made.push(ws);
    assert.deepEqual([codeOf(ws, m1), codeOf(ws, m2), kept(run.id).restoring], ["export const v = 1\n", null, true]);
    lockOf(run.id).close();
    server = await restart();

    scripts.push({ act: (call) => (call.code = codeOf(call.args[4], m2)), events: [done] });
    server.steerRun(run.id, "Go on.");
    const r = await settle(run.id, closes(run.id, server), server);
    const call = spawns.at(-1);
    assert.equal(call.args[4], ws, "the same workspace");
    assert.equal(call.code, "export const v = 1\n", "the source that was missing is there when the worker starts");
    const told = r.events.findLast((e) => e.ev === "workspace");
    assert.equal(told.state, "kept");
    for (const m of [m1, m2]) assert.ok(told.message.includes(`${m.url} (commit ${m.commit.slice(0, 12)}, in ${m.where})`), told.message);
    assert.ok(call.env.WORKSPACE_NOTE.includes(told.message));
    assert.ok(!call.env.WORKSPACE_NOTE.includes("the sources you fetched are still there"));
    assert.equal(kept(run.id).restoring, undefined);
  });
});

test("A6: a joined run whose stream has no packs event still gets the restored code in its modules", async () => {
  await withGit(async () => {
    const url = "https://github.com/acme/joined2";
    const where = "vendor/acme__joined2";
    const first = gitCommit(path.join(GIT_REMOTE, "acme", "joined2.git"), { "src/Lib.ts": "export const v = 1\n" });
    const run = await fetchedAt(url, where, first, { pack: undefined, packs: ["review", "contracts"] });
    assert.deepEqual(kept(run.id).packs, ["review", "contracts"]);
    // An older stream: the record knows the modules, the stream does not.
    const stream = path.join(RESULTS, `run-${run.id}.stream.jsonl`);
    writeFileSync(stream, readFileSync(stream, "utf8").split("\n").filter((l) => !l.includes('"ev":"packs"')).join("\n"));
    rmSync(run.ws, { recursive: true, force: true });
    const server = await restart();
    scripts.push({ events: [done] });
    server.steerRun(run.id, "Look again.");
    await settle(run.id, closes(run.id, server), server);
    const ws = spawns.at(-1).args[4];
    made.push(ws);
    for (const at of [".", "modules/review", "modules/contracts"]) {
      assert.equal(readFileSync(path.join(ws, at, where, "src", "Lib.ts"), "utf8"), "export const v = 1\n", at);
    }
  });
});

// ---- A Stop that was taken starts no worker ---------------------------------------

// The run's lock is free: this process can take it.
function lockFree(id) {
  const db = new DatabaseSync(path.join(RESULTS, `run-${id}.owner.sqlite`), { timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
// After a Stop that was taken while a follow-up prepared its workspace.
function stoppedClean(api, id, workersBefore, why) {
  const r = api.getRun(id);
  assert.equal(spawns.length, workersBefore, `${why}: no worker started`);
  assert.ok(r.events.slice(-2).map((e) => e.ev).join() === "stopped,closed", `${why}: the run is stopped (${r.events.slice(-4).map((e) => e.ev)})`);
  assert.ok(["no-finding", "recorded", "error"].includes(r.status) && r.replying === false, `${why}: the run is idle`);
  assert.ok(lockFree(id), `${why}: the run's lock is free`);
  const ws = kept(id).ws;
  if (ws) {
    made.push(ws);
    assert.deepEqual(holding(ws, [TOKEN, ADMIN]), [], `${why}: no credential in the kept workspace`);
  }
  assert.equal(kept(id).restored, undefined, `${why}: the record does not say a credential is in the files`);
  return r;
}

test("a Stop taken during the only source of a restore, or during the last of several, starts no worker", async () => {
  await withGit(async () => {
    for (const [name, count] of [["only", 1], ["last", 3]]) {
      const run = await twoFetched(runs, name, count);
      rmSync(run.ws, { recursive: true, force: true });
      const before = spawns.length;
      const n = closes(run.id);
      let stop = null;
      // The operator presses Stop while the last source is fetched.
      restoreHook = async (ws, u, real) => {
        if (u === run.members.at(-1).url) stop = runs.stopRun(run.id);
        return real(ws, u);
      };
      try {
        steerRun(run.id, "Look again.");
        await settle(run.id, n);
      } finally {
        restoreHook = null;
      }
      assert.deepEqual(stop, { ok: true }, `${name}: the Stop was taken`);
      stoppedClean(runs, run.id, before, name);
      // Every source came back before the stop was seen, so nothing is left to restore.
      assert.equal(kept(run.id).restoring, undefined);
    }
  });
});

test("a Stop taken while a lost workspace is built, with nothing to restore, starts no worker: one module and a joined run, with a credential", async () => {
  await withLivePack(async () => {
    const server = await restart();
    // One module (ai-mcp), and a joined run (web, ai-mcp). Each has the scope's access token.
    const one = await liveEnded(server);
    const pair = livePair(["web", "ai-mcp"]);
    scripts.push({ act: (call) => writeFileSync(call.args[3], ""), events: [done] });
    const joined = await server.createRun({ targetId: pair.id, packs: ["web", "ai-mcp"], mode: "solo" });
    await settle(joined.id, 0, server);
    for (const [why, run] of [["one module", one], ["a joined run", { id: joined.id, ws: spawns.at(-1).args[4] }]]) {
      rmSync(run.ws, { recursive: true, force: true });
      const before = spawns.length;
      const n = closes(run.id, server);
      let stop = null;
      let built = null;
      // The operator presses Stop while the new workspace is built. It holds the token at that moment.
      afterBuild = (ws) => {
        if (stop) return; // a joined run builds each module through the same step
        built = ws;
        stop = server.stopRun(run.id);
      };
      try {
        server.steerRun(run.id, "Look again.");
        await settle(run.id, n, server);
      } finally {
        afterBuild = null;
      }
      assert.deepEqual(stop, { ok: true }, `${why}: the Stop was taken`);
      assert.ok(built);
      made.push(built);
      stoppedClean(server, run.id, before, why);
      if (existsSync(built)) assert.deepEqual(holding(built, [TOKEN, ADMIN]), [], `${why}: the built workspace holds no credential`);
    }
  });
});

test("a Stop taken while the boot resumes a run starts no worker", async () => {
  // A solo run whose worker is running when the server dies.
  let server = await restart();
  scripts.push({ act: work, hang: true });
  const { id } = await server.createRun({ targetId: scope.id, pack: "review", mode: "solo" });
  for (let i = 0; i < 300 && server.getRun(id).status !== "running"; i++) await new Promise((res) => setTimeout(res, 10));
  for (let i = 0; i < 300 && !existsSync(path.join(RESULTS, `run-${id}.state.json`)); i++) await new Promise((res) => setTimeout(res, 10));
  const ws = spawns.at(-1).args[4];
  made.push(ws);
  const before = spawns.length;
  lockOf(id).close();
  // The next boot resumes it. The operator presses Stop while the reach opens, before the worker starts.
  let ready;
  const booted = new Promise((res) => (ready = res));
  let stop = null;
  reachHook = async () => {
    const api = await booted;
    reachHook = null;
    stop = api.stopRun(id);
  };
  try {
    server = await restart();
    ready(server);
    await settle(id, 0, server);
  } finally {
    reachHook = null;
  }
  assert.deepEqual(stop, { ok: true });
  assert.equal(spawns.length, before, "no worker started");
  const r = server.getRun(id);
  assert.deepEqual(r.events.slice(-3).map((e) => e.ev), ["stopped", "status", "closed"]);
  assert.ok(lockFree(id));
});

// ---- A workspace record that cannot be read is not a record that is not there --------

test("a follow-up whose workspace record cannot be read is refused and changes nothing; with no record file it gets a new workspace as before", async () => {
  const a = await finished();
  const ws = a.call.args[4];
  made.push(ws);
  const good = readFileSync(record(a.id), "utf8");
  const before = spawns.length;
  const refused = (text) => {
    const events = getRun(a.id).events.length;
    assert.throws(() => steerRun(a.id, "Go on."), (err) => sentence.test(err.message) && err.message.startsWith(`The workspace record of this run cannot be read, so this follow-up did not start. Repair the file ${record(a.id)}, or delete it`));
    if (text !== null) assert.equal(readFileSync(record(a.id), "utf8"), text, "the record is not changed");
    assert.equal(getRun(a.id).events.length, events, "the chat gets no event: no 'the earlier workspace is gone'");
    assert.ok(existsSync(path.join(ws, "notes.md")), "the old folder stays");
  };
  for (const text of ['{"ws":', "null", "[]"]) {
    writeFileSync(record(a.id), text);
    refused(text);
  }
  writeFileSync(record(a.id), good);
  chmodSync(record(a.id), 0); // whole, but closed to the server
  try {
    refused(null);
  } finally {
    chmodSync(record(a.id), 0o600);
  }
  assert.equal(spawns.length, before, "no worker started, so no new workspace was built");
  // The operator repairs the record: the follow-up works in the old workspace.
  scripts.push({ act: look, events: [done] });
  steerRun(a.id, "Go on.");
  let r = await settle(a.id, 1);
  assert.equal(spawns.at(-1).args[4], ws);
  assert.deepEqual(spawns.at(-1).saw, { source: true, note: true });
  assert.deepEqual(r.events.filter((e) => e.ev === "workspace"), []);
  // The operator deletes the record instead: a new workspace, and the true sentence, as before.
  rmSync(record(a.id));
  scripts.push({ events: [done] });
  steerRun(a.id, "Go on.");
  r = await settle(a.id, 2);
  assert.notEqual(spawns.at(-1).args[4], ws);
  assert.deepEqual(r.events.filter((e) => e.ev === "workspace").map((e) => e.state), ["rebuilt"]);
});

test("a workspace record that is damaged while a follow-up works is not taken as no record when the follow-up ends", async () => {
  const damage = (id) => () => writeFileSync(record(id), '{"ws":');
  // No credential is known for this run, so nobody can say the files are clean: the workspace is not kept.
  const a = await finished();
  scripts.push({ act: damage(a.id), events: [done] });
  steerRun(a.id, "Go on.");
  await settle(a.id, 1);
  assert.ok(!existsSync(a.call.args[4]), "not kept on the word of a record nobody can read");
  assert.equal(readFileSync(record(a.id), "utf8"), '{"ws":', "and the damaged record is not written over");
  // The credential is known: every copy leaves, and the record is written again from what the server knows.
  await withLivePack(async () => {
    const server = await restart();
    const b = await liveEnded(server);
    scripts.push({ act: damage(b.id), events: [done] });
    server.steerRun(b.id, "Go on.");
    await settle(b.id, 1, server);
    assert.deepEqual(holding(b.ws, [TOKEN, ADMIN]), []);
    assert.deepEqual([kept(b.id).ws, kept(b.id).credential, kept(b.id).restored], [b.ws, true, undefined]);
  });
});

// ---- Messages -------------------------------------------------------------------

test("messages: every refusal and every reply error is a full sentence that says what to do", async () => {
  const refusal = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.message;
    }
    assert.fail("no refusal");
  };
  const { id } = await finished();
  const said = [
    refusal(() => steerRun("no-such-run", "Hi.")),
    refusal(() => steerRun(id, "   ")),
  ];
  archiveRun(id, true);
  said.push(refusal(() => steerRun(id, "Hi.")));
  assert.match(said[2], /Unarchive/);
  archiveRun(id, false);

  // A run with no saved session cannot chat.
  scripts.push({ events: [fetched, done] });
  const bare = await start();
  await settle(bare.id);
  said.push(refusal(() => steerRun(bare.id, "Hi.")));

  // A follow-up worker that dies.
  scripts.push({ code: 1 });
  steerRun(id, "Hi.");
  let r = await settle(id, closes(id));
  said.push(r.events.findLast((e) => e.ev === "reply-error").error);
  assert.match(said.at(-1), /^The agent process ended before it gave an answer: it exited with the code 1\. Send the message again to retry\.$/);
  scripts.push({ code: 1, stderr: "TypeError: boom\n" });
  steerRun(id, "Hi.");
  r = await settle(id, closes(id));
  const withOutput = r.events.findLast((e) => e.ev === "reply-error").error;
  assert.match(withOutput, /Send the message again to retry\.\n\nTypeError: boom$/, "the error output follows the sentence");

  for (const text of said) assert.match(text, sentence, text);
  assert.equal(said.length, 5);
});

// No live endpoint, container or inference: only saved binding lifetimes.
const staleBinding = { net: "stopped-network", gate: "http://stopped-gate:8080", baseUrl: "https://app.example.com", image: "synthetic-image" };
const configFile = (ws) => path.join(ws, ".touchstone.json");
const configsFor = (ws, packs) => [ws, ...(packs.length > 1 ? packs.map((p) => path.join(ws, "modules", p)) : [])];
function putStale(ws) {
  const file = configFile(ws);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), live: staleBinding }));
}
async function offlineLiveFixture(packs, fn) {
  const saved = packs.map((p) => [p, PACKS[p].prepass, PACKS[p].teardown]);
  const fetch = globalThis.fetch;
  const reachesBefore = reachCalls.length;
  externalCalls.length = 0;
  forbidExternal = true;
  globalThis.fetch = () => { externalCalls.push("fetch"); throw new Error("Unexpected network fetch"); };
  for (const p of packs) {
    PACKS[p].prepass = async (ws) => { putStale(ws); return {}; };
    PACKS[p].teardown = async () => {};
  }
  try {
    const live = addLiveScope({ hosts: ["app.example.com"], pack: packs, permission: true });
    scripts.push({ act: ({ args }) => { writeFileSync(args[3], ""); writeFileSync(path.join(args[4], "notes.md"), "saved observation"); }, events: [done] });
    const { id } = await createRun({ targetId: live.id, packs, mode: "solo" });
    await settle(id);
    await fn({ id, ws: spawns.at(-1).args[4] });
    assert.equal(reachCalls.length, reachesBefore + 1, "only the initial run opens reach");
    assert.deepEqual(externalCalls, [], "no external execution, even if a caller catches its error");
  } finally {
    beforeWrite = null;
    forbidExternal = false;
    globalThis.fetch = fetch;
    for (const [p, prepass, teardown] of saved) Object.assign(PACKS[p], { prepass, teardown });
  }
}

for (const packs of [["web"], ["web", "ai-mcp"], ["ai-mcp", "web"]]) {
  test(`offline live follow-up: clears closed and legacy bindings (${packs.join(",")})`, async () => {
    await offlineLiveFixture(packs, async ({ id, ws }) => {
      for (const part of configsFor(ws, packs)) assert.equal(JSON.parse(readFileSync(configFile(part), "utf8")).live, undefined, "closed workspace has no live binding");
      // An older release retained these fields, including a root in a joined run.
      for (const part of configsFor(ws, packs)) putStale(part);
      const keys = ["TOUCHSTONE_SCOPE_PROXY", "TOUCHSTONE_SCOPE_ALLOW"];
      const env = keys.map((k) => process.env[k]);
      try {
        for (const k of keys) process.env[k] = "inherited-stale-route";
        scripts.push({ act: (call) => {
          call.configs = configsFor(call.args[4], packs).map((part) => JSON.parse(readFileSync(configFile(part), "utf8")));
          call.note = readFileSync(path.join(call.args[4], "notes.md"), "utf8");
          call.requests = Promise.all(packs.map((p) => {
            const part = packs.length > 1 ? path.join(call.args[4], "modules", p) : call.args[4];
            const tool = PACKS[p].tools(part, { poc: 0, found: [], passed: new Map() }).find((t) => t.name === "run_request_script");
            return tool.execute({ label: "old-route", script: 'await request("GET", "/")' });
          }));
        }, events: [done] });
        steerRun(id, "Explain the saved observation.");
        await settle(id, 1);
        const call = spawns.at(-1);
        assert.equal(call.args[4], ws);
        assert.equal(call.note, "saved observation");
        for (const result of await call.requests) {
          assert.equal(result.isError, true);
          assert.match(result.output[0].text, /Live requests are unavailable/);
          assert.doesNotMatch(result.output[0].text, /Keep investigating|No known harm pattern/);
        }
        assert.ok(call.configs.every((cfg) => cfg.live === undefined));
        for (const k of keys) assert.equal(call.env[k], undefined);
        assert.match(call.env.WORKSPACE_NOTE, /Live requests are unavailable/);
        assert.match(call.env.WORKSPACE_NOTE, /Start a new run/);
      } finally {
        keys.forEach((k, i) => { if (env[i] === undefined) delete process.env[k]; else process.env[k] = env[i]; });
      }
    });
  });
}

test("offline live follow-up: rebuilt workspace preserves the rebuild note and adds the limitation", async () => {
  await offlineLiveFixture(["web", "ai-mcp"], async ({ id, ws }) => {
    rmSync(ws, { recursive: true, force: true });
    scripts.push({ events: [done] });
    steerRun(id, "Explain the earlier result.");
    await settle(id, 1);
    const call = spawns.at(-1);
    assert.notEqual(call.args[4], ws);
    assert.match(call.env.WORKSPACE_NOTE, /new workspace built from the same scope/);
    assert.match(call.env.WORKSPACE_NOTE, /Live requests are unavailable/);
    for (const part of configsFor(call.args[4], ["web", "ai-mcp"])) assert.equal(JSON.parse(readFileSync(configFile(part), "utf8")).live, undefined);
  });
});

for (const packs of [["web"], ["web", "ai-mcp"], ["ai-mcp", "web"]]) {
  test(`offline live follow-up: invalidation failure closes the reply and allows another message (${packs.join(",")})`, async () => {
    await offlineLiveFixture(packs, async ({ id, ws }) => {
      for (const part of configsFor(ws, packs)) putStale(part);
      const failedConfig = configFile(packs.length > 1 ? path.join(ws, "modules", "web") : ws);
      const count = spawns.length;
      beforeWrite = (file, text) => {
        if (file === failedConfig && !JSON.parse(text).live) throw new Error("synthetic config write failure");
      };
      try {
        steerRun(id, "Explain the result.");
        const r = await settle(id, 1);
        assert.equal(spawns.length, count);
        assert.equal(r.replying, false);
        assert.match(r.events.findLast((e) => e.ev === "reply-error")?.error ?? "", /live|workspace/i);
        assert.ok(!existsSync(ws), "unsafe-to-keep workspace is cleaned up");
      } finally { beforeWrite = null; }
      scripts.push({ events: [done] });
      steerRun(id, "Explain it now.");
      const r = await settle(id, 2);
      assert.equal(r.replying, false);
      assert.equal(spawns.length, count + 1, "run ownership was released");
    });
  });
}
