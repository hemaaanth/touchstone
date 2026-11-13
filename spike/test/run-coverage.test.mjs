// A run must never read as clean when its scope was not read.
//
//   node --experimental-test-module-mocks --test spike/test/run-coverage.test.mjs
//
// This drives the real app run orchestrator (app/server/runs.mjs). spawn is
// mocked: the "engine" is a fake child that prints the EVENT lines a test names
// and exits. No real engine starts, so no model is called and nothing is spent.
// The fault: a repo scope over the file cap was refused by fetch_source, the
// agent settled with nothing to report, and the run ended `no-finding`.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---- fake engine --------------------------------------------------------------

const scripts = []; // one per spawn: { events: [...], hold?: true }
const spawns = [];
function spawn(cmd, args) {
  const script = scripts.shift() ?? { events: [] };
  spawns.push(args);
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
    for (const e of script.events) child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
    if (!script.hold) setTimeout(() => exit(0, null), 20);
  });
  return child;
}
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "run-coverage-"));
process.env.TOUCHSTONE_RESULTS_DIR = path.join(dir, "results");
process.env.TOUCHSTONE_SCOPES_FILE = path.join(dir, "scopes.json");
after(() => {
  // A run with a session keeps its workspace for a follow-up. Remove those too.
  const results = process.env.TOUCHSTONE_RESULTS_DIR;
  for (const f of existsSync(results) ? readdirSync(results) : []) {
    const ws = f.endsWith(".workspace.json") ? JSON.parse(readFileSync(path.join(results, f), "utf8")).ws : null;
    if (ws) rmSync(ws, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
});

const { addScope } = await import("../lib/scopes-store.mjs");
const { createRun, getRun, stopRun, steerRun } = await import("../../app/server/runs.mjs");

const REPO = "https://github.com/cosmos/cosmos-sdk";
const scope = addScope({ title: "Cosmos SDK", members: [{ kind: "repo", url: REPO }] });
const refused = { ev: "source-fetch", url: REPO, ok: false, error: "cosmos/cosmos-sdk would bring this scope to 3053 source files (the cap is 200) after filtering — refused" };
const fetched = { ev: "source-fetch", url: REPO, ok: true, where: "vendor/cosmos__cosmos-sdk", files: 120 };
const done = { ev: "settled", status: "done", summary: { final: { text: "I found no exploitable issue." } }, findings: [] };

async function settle(id, closedAfter = 0) {
  for (let i = 0; i < 500; i++) {
    const r = getRun(id);
    const closes = r.events.filter((e) => e.ev === "closed").length;
    if (closes > closedAfter && ["recorded", "denied", "error", "no-finding"].includes(r.status) && !r.replying) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`run ${id} did not settle: ${getRun(id).status}`);
}
const record = (id) => JSON.parse(readFileSync(path.join(process.env.TOUCHSTONE_RESULTS_DIR, `run-${id}.json`), "utf8")).result;
const start = () => createRun({ targetId: scope.id, pack: "review", mode: "solo" });

test("a run whose repo fetch was refused ends as an error that says the scope was not read, not no-finding", async () => {
  scripts.push({ events: [refused, done] });
  const { id } = await start();
  const r = await settle(id);
  assert.equal(r.status, "error");
  assert.equal(r.errorInfo?.kind, "coverage");
  assert.equal(r.errorInfo?.retryable, false);
  assert.match(r.errorInfo?.title ?? "", /not read/i);
  assert.match(r.errorInfo?.detail ?? "", /3053 source files/);
  assert.match(r.errorInfo?.hint ?? "", /tree\//, "the hint tells the operator to split the repo into folder URLs");
  // The agent's final answer still reaches the operator; the status says error.
  assert.equal(r.events.find((e) => e.ev === "no-finding")?.final, "I found no exploitable issue.");
  assert.ok(r.events.indexOf(r.events.find((e) => e.ev === "no-finding")) < r.events.findLastIndex((e) => e.ev === "status"));
  const rec = record(id);
  assert.equal(rec.outcome, "error");
  assert.equal(rec.errorInfo?.kind, "coverage");
  assert.deepEqual(rec.sourceCoverage?.members?.map((m) => [m.url, m.status]), [[REPO, "refused"]]);
  assert.equal(rec.sourceCoverage?.complete, false);
});

test("a run that never fetched its repo is not clean either", async () => {
  scripts.push({ events: [done] });
  const { id } = await start();
  const r = await settle(id);
  assert.equal(r.status, "error");
  assert.equal(r.errorInfo?.kind, "coverage");
  assert.deepEqual(record(id).sourceCoverage?.members?.map((m) => m.status), ["not-fetched"]);
});

test("a run that read every member still ends no-finding", async () => {
  scripts.push({ events: [fetched, done] });
  const { id } = await start();
  const r = await settle(id);
  assert.equal(r.status, "no-finding");
  assert.ok(r.events.some((e) => e.ev === "no-finding"));
  const rec = record(id);
  assert.equal(rec.outcome, "no-finding");
  assert.deepEqual(rec.sourceCoverage?.members?.map((m) => [m.status, m.where]), [["fetched", "vendor/cosmos__cosmos-sdk"]]);
  assert.equal(rec.sourceCoverage?.complete, true);
});

test("an operator stop after a refused fetch reads as not covered, not no-finding", async () => {
  scripts.push({ events: [refused], hold: true });
  const { id } = await start();
  for (let i = 0; i < 200 && !getRun(id).events.some((e) => e.ev === "source-fetch"); i++) await new Promise((res) => setTimeout(res, 10));
  stopRun(id);
  const r = await settle(id);
  assert.ok(r.events.some((e) => e.ev === "stopped"));
  assert.equal(r.status, "error");
  assert.equal(r.errorInfo?.kind, "coverage");
  assert.equal(record(id).outcome, "error");
});

test("a follow-up that ends without reading the scope keeps the run an error; one that reads it clears it", async () => {
  scripts.push({ events: [refused, done] });
  const { id } = await start();
  await settle(id);
  // A follow-up reopens the saved agent session; the fake engine wrote none.
  writeFileSync(path.join(process.env.TOUCHSTONE_RESULTS_DIR, `run-${id}.sqlite`), "");
  scripts.push({ events: [done] });
  steerRun(id, "Try again.");
  let r = await settle(id, 1);
  assert.equal(r.status, "error");
  assert.equal(r.errorInfo?.kind, "coverage");
  scripts.push({ events: [fetched, done] });
  steerRun(id, "Fetch it now.");
  r = await settle(id, 2);
  assert.equal(r.status, "no-finding");
  assert.equal(r.errorInfo ?? null, null);
});

test("a run that records a finding with part of its scope unread stays recorded but says what was not read", async () => {
  const BANK = "https://github.com/cosmos/cosmos-sdk/tree/main/x/bank";
  const two = addScope({ title: "Cosmos SDK, two members", members: [{ kind: "repo", url: REPO }, { kind: "repo", url: BANK }] });
  const finding = { title: "Unchecked send", severity: "high", poc: "x/bank/keeper/send.go" };
  const found = { ...done, findings: [finding] };
  scripts.push({ events: [refused, { ev: "source-fetch", url: BANK, ok: true, where: "vendor/cosmos__cosmos-sdk@main/x/bank", files: 40 }, found] });
  const { id } = await createRun({ targetId: two.id, pack: "review", mode: "solo" });
  const r = await settle(id);
  assert.equal(r.status, "recorded");
  const note = r.events.find((e) => e.ev === "coverage");
  assert.ok(note, "a coverage note is broadcast");
  assert.equal(note.info?.kind, "coverage");
  assert.equal(note.info?.title, "Part of the scope was not read");
  assert.match(note.info?.message ?? "", /finding was recorded/i);
  assert.match(note.info?.detail ?? "", /Not read:\n- https:\/\/github\.com\/cosmos\/cosmos-sdk: .*3053 source files/);
  assert.ok(r.events.indexOf(note) < r.events.findLastIndex((e) => e.ev === "status"), "the note comes before the recorded status");
  // A run that read everything gets no note.
  scripts.push({ events: [fetched, { ...done, findings: [finding] }] });
  const clean = await settle((await start()).id);
  assert.equal(clean.status, "recorded");
  assert.ok(!clean.events.some((e) => e.ev === "coverage"));
});

test("a follow-up that retries a failed run and still leaves a gap broadcasts the coverage error, not the old one", async () => {
  scripts.push({ events: [{ ev: "settled", status: "unanswered", findings: [] }] });
  const { id } = await start();
  let r = await settle(id);
  assert.equal(r.status, "error");
  assert.notEqual(r.errorInfo?.kind, "coverage", "the first failure is not a coverage error");
  writeFileSync(path.join(process.env.TOUCHSTONE_RESULTS_DIR, `run-${id}.sqlite`), "");
  scripts.push({ events: [done] });
  steerRun(id, "Try again.");
  r = await settle(id, 1);
  const last = r.events.findLast((e) => e.ev === "status");
  assert.equal(last.status, "error");
  assert.equal(last.errorInfo?.kind, "coverage", "the UI and a replay see the coverage error");
});

test("coverageGap is exported, so another end path (for example a restart) can gate on it", async () => {
  const { coverageGap } = await import("../../app/server/runs.mjs");
  assert.equal(typeof coverageGap, "function", "app/server/runs.mjs exports coverageGap");
  const gap = { target: { links: [REPO] }, events: [refused] };
  assert.equal(coverageGap(gap), true);
  assert.equal(gap.errorInfo.kind, "coverage");
  const read = { target: { links: [REPO] }, events: [fetched] };
  assert.equal(coverageGap(read), false);
  assert.equal(read.errorInfo, undefined);
});
