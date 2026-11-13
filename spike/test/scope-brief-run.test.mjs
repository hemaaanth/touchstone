// The scope brief on the real run path (app/server/runs.mjs): the first run and
// every follow-up ("Run again" included) get the scope's current brief.
//
//   node --experimental-test-module-mocks --test spike/test/scope-brief-run.test.mjs
//
// spawn is mocked: the "engine" is a fake child that records its env and
// workspace, prints the EVENT lines a test names and exits. No model is called
// and nothing is spent.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  child.kill = () => {};
  setImmediate(() => {
    const [, , , db, ws] = args;
    writeFileSync(db, "");
    call.briefFile = existsSync(path.join(ws, "BRIEF.md"));
    for (const e of script.events ?? []) child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 20);
  });
  return child;
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "scope-brief-run-"));
const RESULTS = path.join(dir, "results");
process.env.TOUCHSTONE_RESULTS_DIR = RESULTS;
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json");
process.env.SPEND_LEDGER = path.join(dir, "spend.json"); // never the real ledger
after(() => {
  for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
    if (f.endsWith(".workspace.json")) rmSync(JSON.parse(readFileSync(path.join(RESULTS, f), "utf8")).ws ?? path.join(dir, "none"), { recursive: true, force: true });
  }
  for (const c of spawns) rmSync(c.args[4], { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const { addScope, setScopeBrief } = await import("../lib/scopes-store.mjs");
const runs = await import("../../app/server/runs.mjs");
const { createRun, getRun, steerRun } = runs;

const done = { ev: "settled", status: "done", summary: { final: { text: "No exploitable issue." } }, findings: [] };
async function settle(id, closedAfter = 0) {
  for (let i = 0; i < 500; i++) {
    const r = getRun(id);
    const closes = r.events.filter((e) => e.ev === "closed").length;
    if (closes > closedAfter && ["recorded", "denied", "error", "no-finding"].includes(r.status) && !r.replying) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`run ${id} did not settle: ${getRun(id).status}`);
}
const closes = (id) => getRun(id).events.filter((e) => e.ev === "closed").length;
const briefs = (id) => getRun(id).events.filter((e) => e.ev === "brief").map((e) => e.text);
async function finished(scope) {
  scripts.push({ events: [done] });
  const { id } = await createRun({ targetId: scope.id, pack: "review", mode: "solo" });
  await settle(id);
  return { id, call: spawns.at(-1) };
}
async function followUp(id, text = "Go on.") {
  scripts.push({ events: [done] });
  steerRun(id, text);
  await settle(id, closes(id) - 0);
  return spawns.at(-1);
}
const scope = (title) => addScope({ title, members: [{ kind: "repo", url: "https://github.com/acme/svc" }] });

test("a run of a scope with a brief: the worker gets it, Run Info gets one event, the workspace gets no file", async () => {
  const s = scope("with brief");
  setScopeBrief(s.id, "Start with the webhook handlers.");
  const { id, call } = await finished(s);
  assert.equal(call.args[2], "run");
  assert.equal(call.env.SCOPE_BRIEF, "Start with the webhook handlers.");
  assert.match(call.env.SCOPE_NOTES, /github\.com\/acme\/svc/);
  assert.equal(call.briefFile, false, "no BRIEF.md in the workspace");
  assert.deepEqual(briefs(id), ["Start with the webhook handlers."]);
  assert.equal(getRun(id).events.find((e) => e.ev === "scope").scope.brief, undefined, "the scope event does not repeat it");
});

test("a run of a scope without a brief: no brief env and no brief event", async () => {
  const { id, call } = await finished(scope("no brief"));
  assert.equal(call.env.SCOPE_BRIEF, undefined);
  assert.ok(call.env.SCOPE_NOTES);
  assert.deepEqual(briefs(id), []);
});

test("a follow-up in the kept workspace uses the scope's current brief, and says so only when it changed", async () => {
  const s = scope("changes");
  setScopeBrief(s.id, "First brief.");
  const { id, call } = await finished(s);
  const ws = call.args[4];

  // Unchanged: nothing new to tell.
  let next = await followUp(id);
  assert.equal(next.args[2], "chat");
  assert.equal(next.args[4], ws, "the kept workspace");
  assert.equal(next.env.BRIEF_CHANGE, undefined);
  assert.equal(next.env.SCOPE_BRIEF, "First brief.");
  assert.deepEqual(briefs(id), ["First brief."]);

  // Changed in the scope settings: the follow-up message carries the new one.
  setScopeBrief(s.id, "Second brief.");
  next = await followUp(id);
  assert.equal(next.args[4], ws);
  assert.match(next.env.BRIEF_CHANGE, /^The operator changed the scope brief\.[\s\S]*<<<scope-brief\nSecond brief\.\nscope-brief>>>$/);
  assert.equal(next.env.SCOPE_BRIEF, "Second brief.", "a new fleet child starts with the current one");
  assert.deepEqual(briefs(id), ["First brief.", "Second brief."]);

  // Removed: the agent is told to drop it.
  setScopeBrief(s.id, "");
  next = await followUp(id);
  assert.equal(next.env.BRIEF_CHANGE, "The operator removed the scope brief. Do not follow the earlier one any more.");
  assert.equal(next.env.SCOPE_BRIEF, undefined);
  assert.deepEqual(briefs(id), ["First brief.", "Second brief.", ""]);
  next = await followUp(id);
  assert.equal(next.env.BRIEF_CHANGE, undefined);
});

test("a follow-up that rebuilds the workspace gets the current brief too, and no file", async () => {
  const s = scope("rebuilt");
  const { id, call } = await finished(s);
  rmSync(call.args[4], { recursive: true, force: true });
  setScopeBrief(s.id, "Added after the run.");
  const next = await followUp(id);
  assert.notEqual(next.args[4], call.args[4], "a new workspace");
  assert.equal(getRun(id).events.filter((e) => e.ev === "workspace").at(-1).state, "rebuilt");
  assert.equal(next.briefFile, false);
  assert.match(next.env.BRIEF_CHANGE, /Added after the run\./);
  assert.equal(next.env.SCOPE_BRIEF, "Added after the run.");
});

test("a kept workspace from before this change loses its old BRIEF.md before the follow-up starts", async () => {
  const s = scope("old file");
  const { id, call } = await finished(s);
  writeFileSync(path.join(call.args[4], "BRIEF.md"), "# old Touchstone brief\n");
  const next = await followUp(id);
  assert.equal(next.args[4], call.args[4]);
  assert.equal(next.briefFile, false);
});

test("a BRIEF.md that is a directory does not stop a follow-up: it ends, and the run is not left replying", async () => {
  const s = scope("dir brief");
  const { id, call } = await finished(s);
  mkdirSync(path.join(call.args[4], "BRIEF.md"));
  const next = await followUp(id);
  assert.equal(next.args[4], call.args[4], "the kept workspace");
  const r = getRun(id);
  assert.ok(!r.replying, "not left replying");
  assert.ok(!r.events.some((e) => e.ev === "reply-error"));
  assert.ok(existsSync(path.join(call.args[4], "BRIEF.md")), "a directory is not Touchstone's file, so it stays");
  // The lock is free again: one more follow-up starts.
  const again = await followUp(id);
  assert.equal(again.args[2], "chat");
});
