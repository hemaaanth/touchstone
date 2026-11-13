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
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });
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
mock.module("node:fs", { exports: { ...realFs, default: { ...realFs.default, rmSync: rmSyncHooked }, rmSync: rmSyncHooked } });
// A live run opens a Docker boundary. These tests have no live target, so a live
// scope gets an inert gate. Every other scope keeps the real one.
const realReach = await import("../lib/reach.mjs");
const openReach = (target, opts) => (target.kind === "live" ? { env: {}, stop: async () => {} } : realReach.openReach(target, opts));
mock.module("../lib/reach.mjs", { exports: { ...realReach, openReach } });
// A fetch with no network: it writes the tree the real one would.
const realFetch = await import("../lib/fetch.mjs");
const fetchClones = [];
mock.module("../lib/fetch.mjs", {
  exports: {
    ...realFetch,
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
const made = []; // workspaces a test deleted from the record's view; removed at the end
after(() => {
  for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
    if (f.endsWith(".workspace.json")) made.push(JSON.parse(readFileSync(path.join(RESULTS, f), "utf8")).ws);
  }
  for (const ws of made) if (ws) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const { addScope, addLiveScope, removeScope } = await import("../lib/scopes-store.mjs");
const { PACKS } = await import("../packs/index.mjs");
const runs = await import("../../app/server/runs.mjs");
const { createRun, getRun, steerRun, deleteRun, archiveRun } = runs;

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
