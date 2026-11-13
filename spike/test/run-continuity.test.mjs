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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- fake engine --------------------------------------------------------------

// One script per spawn:
//   events   EVENT lines to print whole
//   torn     a `settled` event: whole in the engine's events file, cut on stdout
//   act      (call) => void, runs first; call is { args, env }
//   stderr, code, signal   how the process ends (default: exit 0)
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
    setTimeout(() => (script.signal ? exit(null, script.signal) : exit(script.code ?? 0, null)), 20);
  });
  return child;
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "run-continuity-"));
const RESULTS = path.join(dir, "results");
process.env.TOUCHSTONE_RESULTS_DIR = RESULTS;
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
const made = []; // workspaces a test deleted from the record's view; removed at the end
after(() => {
  for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
    if (f.endsWith(".workspace.json")) made.push(JSON.parse(readFileSync(path.join(RESULTS, f), "utf8")).ws);
  }
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const { addScope, removeScope } = await import("../lib/scopes-store.mjs");
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
        const lab = mkdtempSync(path.join(tmpdir(), "genlab-test-"));
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
  assert.ok(existsSync(path.join(spawns.at(-1).args[4], "BRIEF.md")), "the new workspace is the same scope's brief");
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
