// A fleet run and a server restart. The run's stream file is the store thread
// 1a made durable; the boot recovery (loadSavedRuns) reads it back. This file
// shows what a fleet run keeps and what it loses when the server process goes
// away while the coordinator and its children work.
// No model call and no Docker: the worker, the packs and the workspace are fakes.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "fleet-restart-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
process.env.SPEND_LEDGER = join(dir, "spend.json");
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };

const realTargets = await import("../lib/targets.mjs");
mock.module("../lib/targets.mjs", { exports: { ...realTargets, prepareRunWorkspace: async () => workspace("rebuilt") } });
const realPacks = await import("../packs/index.mjs");
const proved = [];
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async () => ({ record: { pack: "web", coverage: [], leads: [] }, env: {} }),
  teardown: async () => {},
  prove: async (_ws, found) => { proved.push(...found); return found.map((f) => ({ ...f, proof: { kind: "http", status: "pass" } })); },
}) } });
// Every worker the server starts is recorded. A fleet that a restart interrupted
// must start none by itself: a worker is a paid model session.
const workers = [];
const realChild = await import("node:child_process");
mock.module("node:child_process", { exports: { ...realChild, spawn: (_cmd, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit("exit", null, "SIGTERM");
  workers.push({ args, env: opts.env, child });
  return child;
} } });

// A run workspace as the server knows it: directly in the temp folder, with a
// workspace name, so the kept-workspace check accepts it.
const made = [];
function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  writeFileSync(join(ws, "notes.md"), "the agent wrote this before the restart\n");
  made.push(ws);
  return ws;
}

const head = (mode = "fleet") => [
  { t: 1, ev: "scope", scope: target },
  { t: 2, ev: "budget", usd: 5 },
  { t: 3, ev: "mode", mode },
  { t: 4, ev: "provider", provider: "boundless", model: "fake-model" },
  { t: 5, ev: "status", status: "starting" },
  { t: 6, ev: "status", status: "running" },
];
// What a fleet shows the operator by the time the server stops: two children,
// their messages, a Bulletin lead, a submitted finding, and the spend. Alpha
// finished its first task. Beta and the coordinator are mid-turn.
const fleetWork = [
  { t: 10, ev: "thinking-delta", conv: "root", attempt: 0, text: "Split the scope into two areas." },
  { t: 11, ev: "subagent-spawned", id: "a-2", name: "Alpha", title: "Map the login flow", area: "auth", tier: "T1", parent: null, conv: "2" },
  { t: 12, ev: "agent-status", agent: "a-2", id: "a-2", state: "working" },
  { t: 13, ev: "subagent-spawned", id: "a-3", name: "Beta", title: "Map the upload flow", area: "upload", tier: "T1", parent: null, conv: "3" },
  { t: 14, ev: "agent-status", agent: "a-3", id: "a-3", state: "working" },
  { t: 15, ev: "assistant-delta", agent: "a-2", conv: "2", attempt: 0, text: "Reading the login handler." },
  { t: 16, ev: "bulletin-post", agent: "a-2", id: "b-1", author: "a-2", lane: "trusted", kind: "lead", severity: "high", text: "Session cookie has no HttpOnly flag", tags: ["auth"] },
  { t: 17, ev: "agent-message", agent: "a-2", id: "m-1", from: "a-2", to: "a-3", text: "Check the upload path for the same cookie." },
  { t: 18, ev: "agent-spend", agent: "a-2", id: "a-2", usd: 0.21 },
  { t: 19, ev: "spend", agent: "a-2", usd: 0.3 },
  { t: 20, ev: "finding-submitted", agent: "a-2", n: 1, title: "Login accepts a forged session", severity: "high", poc: "forged_session" },
  { t: 21, ev: "status", status: "running", pending: { n: 1, title: "Login accepts a forged session", severity: "high", poc: "forged_session" } },
  { t: 22, ev: "subagent-done", agent: "a-2", id: "a-2", status: "done" },
  { t: 23, ev: "agent-message", agent: "a-2", id: "m-report-1", from: "a-2", to: "coordinator", text: "Alpha completed: one finding submitted." },
  { t: 24, ev: "assistant-delta", agent: "a-3", conv: "3", attempt: 0, text: "Tracing the upload handler." },
  { t: 25, ev: "agent-spend", agent: "a-3", id: "a-3", usd: 0.12 },
  { t: 26, ev: "spend", agent: "a-3", usd: 0.47 },
  { t: 27, ev: "assistant-delta", conv: "root", attempt: 0, text: "Alpha is done. Waiting for Beta." },
];

function onStream(id) {
  return readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
function save(name, events, { state, session = true, audit } = {}) {
  const id = `${name}-2611130900-1`;
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  if (state) writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ target, mode: "fleet", budget: 5, provider: "boundless", model: "fake-model", modules: [], ...state }));
  if (session) writeFileSync(join(dir, `run-${id}.sqlite`), "the agent session");
  if (audit) writeFileSync(join(dir, `run-${id}.sqlite.audit.json`), JSON.stringify(audit));
  return id;
}
const record = (id, findings) => writeFileSync(join(dir, `run-${id}.json`), JSON.stringify({ result: { outcome: "recorded", findings } }));
const submitted = { n: 1, title: "Login accepts a forged session", severity: "high", poc: "forged_session", source: "the exact passing test" };
const noFinding = fleetWork.filter((e) => e.ev !== "finding-submitted" && !e.pending);

// 1. The server stopped while the fleet worked. Nothing was submitted yet.
const cutWs = workspace();
const cutId = save("fleet-cut", [...head(), ...noFinding], { state: { ws: cutWs, phase: "agent" } });
// 2. The same, and one agent had submitted a finding. Its passing source is in
// the engine's audit file.
const liveId = save("fleet-live", [...head(), ...fleetWork], { state: { ws: workspace(), phase: "agent" }, audit: { poc: 3, found: [submitted], passed: [["forged_session", submitted.source]] } });
// Three children mid-turn: the card names them all.
const threeId = save("fleet-three", [...head(), ...["a-2", "a-3", "a-4"].map((id, i) => ({ t: 10 + i, ev: "subagent-spawned", id, name: ["Alpha", "Beta", "Gamma"][i], title: "Task", area: "area", tier: "T1", parent: null, conv: String(i + 2) }))], { state: { ws: workspace(), phase: "agent" } });
// A finding was submitted, but the workspace is gone (a reboot emptied the temp
// folder). The proof check has nothing to run in.
const goneId = save("fleet-gone", [...head(), ...fleetWork], { state: { ws: join(tmpdir(), "redteam-run-gone00"), phase: "agent" }, audit: { poc: 3, found: [submitted], passed: [] } });
// 3. The server stopped before any child started (the tool scan).
const earlyId = save("fleet-early", head(), { state: { ws: workspace(), phase: "prepass" }, session: false });
// 4. The server stopped during the proof check: every agent had ended.
const proofId = save("fleet-proof", [
  ...head(), ...fleetWork,
  { t: 28, ev: "subagent-done", agent: "a-3", id: "a-3", status: "done" },
  { t: 29, ev: "settled", summary: { final: { text: "Coverage complete." } } },
  { t: 30, ev: "status", status: "deciding" },
], { state: { ws: workspace(), phase: "proof", settled: { status: "done", findings: [submitted], summary: { calls: [] } } } });
// 5. A fleet that finished. One finding the replay proved, one it did not.
const doneId = save("fleet-done", [
  ...head(), ...fleetWork,
  { t: 28, ev: "subagent-done", agent: "a-3", id: "a-3", status: "done" },
  { t: 29, ev: "settled", summary: { final: { text: "Coverage complete." } } },
  { t: 30, ev: "status", status: "deciding" },
  { t: 31, ev: "finding", id: "fleet-done-2611130900-1.1", runId: "fleet-done-2611130900-1", title: "Login accepts a forged session", severity: "high", poc: "forged_session", proofKind: "http", proven: true },
  { t: 32, ev: "finding", id: "fleet-done-2611130900-1.2", runId: "fleet-done-2611130900-1", title: "Upload keeps the file name", severity: "low", poc: "upload_name", proofKind: "http", proven: false },
  { t: 33, ev: "status", status: "recorded", decision: "approve", findingId: "fleet-done-2611130900-1.1", findingIds: ["fleet-done-2611130900-1.1", "fleet-done-2611130900-1.2"] },
  { t: 34, ev: "closed" },
]);
record(doneId, [
  { title: "Login accepts a forged session", severity: "high", poc: "forged_session", proof: { kind: "http", status: "pass" } },
  { title: "Upload keeps the file name", severity: "low", poc: "upload_name", proof: { kind: "http", status: "fail" } },
]);
// 6. A stream that says "proven" for findings whose stored replay record does
// not: the replay failed, the record has no such finding, the event names
// another run, or the event has no `proven` field (the view reads that as proven).
const claimId = save("fleet-claim", [
  ...head(),
  { t: 30, ev: "status", status: "deciding" },
  { t: 31, ev: "finding", id: "fleet-claim-2611130900-1.1", title: "Replay failed", severity: "critical", poc: "claimed", proven: true },
  { t: 32, ev: "finding", id: "fleet-claim-2611130900-1.2", title: "No record entry", severity: "critical", poc: "none", proven: true },
  { t: 32, ev: "finding", id: "fleet-done-2611130900-1.1", title: "Another run's id", severity: "critical", poc: "other", proven: true },
  { t: 32, ev: "finding", id: "fleet-claim-2611130900-1.1x", title: "Not a number", severity: "critical", poc: "nan", proven: true },
  { t: 32, ev: "finding", id: "fleet-claim-2611130900-1.0", title: "No field", severity: "critical", poc: "zero" },
  { t: 33, ev: "status", status: "recorded", decision: "approve", findingId: "fleet-claim-2611130900-1.1", findingIds: ["fleet-claim-2611130900-1.1"] },
  { t: 34, ev: "closed" },
]);
record(claimId, [{ title: "Replay failed", severity: "critical", poc: "claimed", proof: { kind: "http", status: "fail" } }]);
// 7. The same claim with a replay record that cannot be read.
const tornId = save("fleet-torn", [
  ...head(),
  { t: 31, ev: "finding", id: "fleet-torn-2611130900-1.1", title: "Claimed", severity: "critical", poc: "claimed", proven: true },
  { t: 33, ev: "status", status: "recorded", decision: "approve", findingId: "fleet-torn-2611130900-1.1", findingIds: ["fleet-torn-2611130900-1.1"] },
  { t: 34, ev: "closed" },
]);
writeFileSync(join(dir, `run-${tornId}.json`), '{"result":{"findings":[');
// An older record holds one finding, and its id is the run id. Its proof is in
// the record's own fields. One such run proved it, one did not.
const oldId = save("fleet-old", [...head(), { t: 31, ev: "finding", id: "fleet-old-2611130900-1", title: "Old form", severity: "high", proven: true }, { t: 33, ev: "status", status: "recorded" }, { t: 34, ev: "closed" }]);
writeFileSync(join(dir, `run-${oldId}.json`), JSON.stringify({ result: { finding: { title: "Old form", severity: "high" }, pocProved: true, proof: { status: "pass", pass: true } } }));
const oldFailId = save("fleet-oldfail", [...head(), { t: 31, ev: "finding", id: "fleet-oldfail-2611130900-1", title: "Old form", severity: "high", proven: true }, { t: 33, ev: "status", status: "recorded" }, { t: 34, ev: "closed" }]);
writeFileSync(join(dir, `run-${oldFailId}.json`), JSON.stringify({ result: { finding: { title: "Old form", severity: "high" }, pocProved: true, proof: { status: "fail", pass: false } } }));
// 8. A stream file with a damaged line in the middle and a torn last line, and
// a state file that is not JSON. Neither may stop the boot or hide a run.
const damagedId = save("fleet-damaged", [...head(), ...fleetWork], { state: { ws: workspace(), phase: "agent" } });
writeFileSync(join(dir, `run-${damagedId}.stream.jsonl`), [...head(), ...fleetWork].map((e, i) => (i === 8 ? "{not json" : JSON.stringify(e)) + "\n").join("") + '{"t":99,"ev":"assistant-de');
writeFileSync(join(dir, `run-${damagedId}.state.json`), '{"phase":"agent",');
// 9. A fleet that had finished, and the server stopped during a later follow-up
// in which the coordinator had put Alpha back to work.
const replyId = save("fleet-reply", [
  ...head(), ...noFinding,
  { t: 28, ev: "subagent-done", agent: "a-3", id: "a-3", status: "done" },
  { t: 29, ev: "status", status: "no-finding" },
  { t: 30, ev: "closed" },
  { t: 31, ev: "reply-start" },
  { t: 32, ev: "operator-message", text: "Retry Alpha." },
  { t: 33, ev: "agent-status", agent: "a-2", id: "a-2", state: "working" },
]);
// 10. A fleet that another live server still owns. Its agents may be working.
const ownedId = save("fleet-owned", [...head(), ...noFinding], { state: { ws: workspace(), phase: "agent" } });
const otherServer = new DatabaseSync(join(dir, `run-${ownedId}.owner.sqlite`));
otherServer.exec("BEGIN IMMEDIATE");
// 11. The same as 9, but another live server answers that follow-up right now.
const replyOwnedId = save("fleet-reply-owned", onStream(replyId));
const otherReply = new DatabaseSync(join(dir, `run-${replyOwnedId}.owner.sqlite`));
otherReply.exec("BEGIN IMMEDIATE");
// 12. A stream that keeps the id of a proven finding and names another one. The
// record's replay passed for every entry. Only the last line is the record's own.
const relabelId = save("fleet-relabel", [
  ...head(),
  { t: 31, ev: "finding", id: "fleet-relabel-2611130900-1.1", title: "Remote code execution", severity: "critical", poc: "rce", proven: true },
  { t: 32, ev: "finding", id: "fleet-relabel-2611130900-1.2", title: "Remote code execution", severity: "low", poc: "upload_name", proven: true },
  { t: 32, ev: "finding", id: "fleet-relabel-2611130900-1.3", title: "Cookie has no flag", severity: "critical", poc: "cookie_flag", proven: true },
  { t: 32, ev: "finding", id: "fleet-relabel-2611130900-1.4", title: "Open redirect", severity: "low", poc: "other_test", proven: true },
  { t: 32, ev: "finding", id: "fleet-relabel-2611130900-1.5", title: "Login accepts a forged session", severity: "high", poc: "forged_session", proven: true },
  { t: 33, ev: "status", status: "recorded", decision: "approve" },
  { t: 34, ev: "closed" },
]);
record(relabelId, [
  { title: "Missing header", severity: "low", poc: "header", proof: { kind: "http", status: "pass" } },
  { title: "Upload keeps the file name", severity: "low", poc: "upload_name", proof: { kind: "http", status: "pass" } },
  { title: "Cookie has no flag", severity: "low", poc: "cookie_flag", proof: { kind: "http", status: "pass" } },
  { title: "Open redirect", severity: "low", poc: "open_redirect", proof: { kind: "http", status: "pass" } },
  { title: "Login accepts a forged session", severity: "high", poc: "forged_session", proof: { kind: "http", status: "pass" } },
]);
// The older record form: its one finding has the run id. A line with another
// title, and a line with another id, do not get its proof.
const oldClaimId = save("fleet-oldclaim", [
  ...head(),
  { t: 31, ev: "finding", id: "fleet-oldclaim-2611130900-1", title: "Old form", severity: "high", proven: true },
  { t: 32, ev: "finding", id: "fleet-oldclaim-2611130900-1", title: "Remote code execution", severity: "high", proven: true },
  { t: 32, ev: "finding", id: "fleet-oldclaim-2611130900-1.1", title: "Old form", severity: "high", proven: true },
  { t: 32, ev: "finding", id: "fleet-old-2611130900-1", title: "Old form", severity: "high", proven: true },
  { t: 33, ev: "status", status: "recorded" },
  { t: 34, ev: "closed" },
]);
writeFileSync(join(dir, `run-${oldClaimId}.json`), JSON.stringify({ result: { finding: { title: "Old form", severity: "high" }, pocProved: true, proof: { status: "pass", pass: true } } }));
// 13. A solo run that stopped while its one agent worked, with a finding
// submitted. Only a fleet takes the proof check here: a solo run starts its agent again.
const soloId = save("solo-agent", [...head("solo"), fleetWork.find((e) => e.ev === "finding-submitted")], { state: { ws: workspace(), phase: "agent", mode: "solo" }, audit: { poc: 3, found: [submitted], passed: [["forged_session", submitted.source]] } });
const before = Object.fromEntries([cutId, liveId, earlyId, proofId, doneId, claimId, tornId, replyId, ownedId, replyOwnedId].map((id) => [id, readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8")]));

const logged = [];
const consoleError = console.error;
console.error = (...args) => logged.push(args.join(" "));
// The restart: this import is a new server process reading the results folder.
const { getRun, listRuns, steerRun } = await import("../../app/server/runs.mjs");
console.error = consoleError;
after(() => {
  otherServer.close();
  otherReply.close();
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const closed = async (id, api = { getRun }) => {
  for (let i = 0; i < 300 && !api.getRun(id)?.events.some((e) => e.ev === "closed"); i++) await new Promise((r) => setTimeout(r, 10));
  return api.getRun(id);
};
const onDisk = (id) => readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ends = (events) => events.filter((e) => e.ev === "subagent-done" && e.interrupted);
// The children that still read as working: spawned or set to work, with no
// later end. This is how the run view reads the stream.
function working(events) {
  const state = new Map();
  for (const e of events) {
    if (e.ev === "subagent-spawned") state.set(e.id, "working");
    if (e.ev === "agent-status") state.set(e.id, e.state === "idle" ? "idle" : "working");
    if (e.ev === "subagent-done") state.set(e.id, e.status);
  }
  return [...state].filter(([, s]) => s === "working").map(([id]) => id);
}
const startedFor = (id) => workers.filter((w) => w.env.EVENTS_FILE?.includes(id));

test("a fleet run keeps its structure, messages, Bulletin, findings and spend across a restart", async () => {
  const run = await closed(liveId);
  assert.ok(listRuns().some((r) => r.id === liveId));
  // Every event that was shown before the restart is still there, in order.
  assert.deepEqual(run.events.slice(0, head().length + fleetWork.length), [...head(), ...fleetWork]);
  assert.equal(run.mode, "fleet");
  assert.equal(run.model, "fake-model");
  assert.deepEqual(run.events.filter((e) => e.ev === "subagent-spawned").map((e) => [e.id, e.name, e.area, e.tier]), [["a-2", "Alpha", "auth", "T1"], ["a-3", "Beta", "upload", "T1"]]);
  assert.equal(run.events.filter((e) => e.ev === "agent-message").length, 2);
  assert.deepEqual(run.events.filter((e) => e.ev === "bulletin-post").map((e) => [e.author, e.lane, e.kind]), [["a-2", "trusted", "lead"]]);
  assert.equal(run.events.findLast((e) => e.ev === "spend").usd, 0.47);
  assert.deepEqual(run.events.filter((e) => e.ev === "agent-spend").map((e) => [e.id, e.usd]), [["a-2", 0.21], ["a-3", 0.12]]);
  assert.deepEqual(run.submitted.map((f) => f.title), ["Login accepts a forged session"]);
  assert.equal(run.pending.title, "Login accepts a forged session");
});

test("an agent that was mid-turn at the restart is ended with a plain reason, and no agent is started again", async () => {
  const run = await closed(cutId);
  // Not running: no child reads as working, and the run is not live.
  assert.deepEqual(working(run.events), []);
  assert.equal(run.status, "error");
  // Beta was mid-turn. Alpha had finished before the restart and stays done.
  assert.deepEqual(ends(run.events).map((e) => [e.id, e.agent, e.status]), [["a-3", "a-3", "failed"]]);
  assert.equal(ends(run.events)[0].error, "The server restarted while this agent was working. It was not started again.");
  // Its time is the run's last event before the restart, not the boot.
  assert.equal(ends(run.events)[0].t, 27);
  assert.equal(run.events.filter((e) => e.ev === "subagent-done" && e.id === "a-2").length, 1);
  // The run's own card: what happened, who was cut off, what it cost, what to do.
  assert.equal(run.errorInfo.kind, "cutoff");
  assert.equal(run.errorInfo.reason, "interrupted");
  assert.equal(run.errorInfo.retryable, true);
  assert.equal(run.errorInfo.title, "This fleet run stopped at the server restart");
  assert.match(run.errorInfo.hint, /Beta was cut off mid-turn/);
  assert.doesNotMatch(run.errorInfo.hint, /Alpha/);
  assert.match(run.errorInfo.hint, /No agent was started again/);
  assert.match(run.errorInfo.hint, /Press Run again to continue in this chat/);
  assert.equal(run.errorInfo.spentUsd, 0.47);
  assert.match(run.error, /fleet run stopped at the server restart/);
  assert.equal(run.events.findLast((e) => e.ev === "status").errorInfo.title, run.errorInfo.title);
  // Not started again: the boot started no worker and restarted no phase.
  assert.equal(startedFor(cutId).length, 0);
  assert.equal(run.events.filter((e) => e.ev === "phase-restarted").length, 0);
  // The end of the child is in the stream file, after everything shown before.
  assert.equal(readFileSync(join(dir, `run-${cutId}.stream.jsonl`), "utf8").startsWith(before[cutId]), true);
  assert.deepEqual(ends(onDisk(cutId)), ends(run.events));
  assert.equal(JSON.parse(readFileSync(join(dir, `run-${cutId}.json`), "utf8")).result.errorInfo.reason, "interrupted");
});

test("the card names every agent that was cut off, or none when only the coordinator worked", async () => {
  assert.match((await closed(threeId)).errorInfo.hint, /^The server restarted while this fleet was working, and Alpha, Beta and Gamma were cut off mid-turn\. No agent was started again, so nothing more was spent\. Press Run again to continue in this chat\. The run keeps its history, its agents and its files\.$/);
  assert.deepEqual(ends((await closed(threeId)).events).map((e) => e.id), ["a-2", "a-3", "a-4"]);
});

test("a second restart keeps the same history: the end of a child is written once", async () => {
  await closed(cutId);
  const shared = globalThis.__touchstoneRuns;
  delete globalThis.__touchstoneRuns;
  let second;
  try {
    second = await import(`../../app/server/runs.mjs?second-boot-${Date.now()}`);
  } finally {
    globalThis.__touchstoneRuns = shared;
  }
  const again = second.getRun(cutId);
  assert.equal(again.status, "error");
  assert.deepEqual(ends(again.events).map((e) => e.id), ["a-3"]);
  assert.deepEqual(ends(onDisk(cutId)).map((e) => e.id), ["a-3"]);
  // The card still names the agent that was cut off.
  assert.match(again.errorInfo.hint, /Beta was cut off mid-turn/);
  // The workspace was kept at the first boot, so the card may still say "its files".
  assert.match(again.errorInfo.hint, /The run keeps its history, its agents and its files\.$/);
  assert.equal(startedFor(cutId).length, 0);
});

test("the operator continues a cut-off fleet with a message, in the same workspace and agent session", async () => {
  await closed(cutId);
  assert.equal(readFileSync(join(cutWs, "notes.md"), "utf8"), "the agent wrote this before the restart\n");
  assert.deepEqual(steerRun(cutId, "Continue the audit from where it stopped."), { ok: true, followUp: true });
  const [w] = startedFor(cutId);
  assert.deepEqual(w.args.slice(1, 3), ["child", "chat"]);
  assert.equal(w.args[3], join(dir, `run-${cutId}.sqlite`));
  assert.equal(w.args[4], cutWs);
  assert.equal(w.env.FLEET, "1");
  // The spend so far counts against the same budget.
  assert.equal(w.env.RUN_SPENT_USD, "0.47");
  assert.equal(w.env.RUN_BUDGET_USD, "5");
  assert.equal(getRun(cutId).replying, true);
  // The reopened session puts Beta back to work, and Beta ends.
  const say = (e) => w.child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
  say({ ev: "agent-status", agent: "a-3", id: "a-3", state: "working" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(working(getRun(cutId).events), ["a-3"]);
  say({ ev: "subagent-done", agent: "a-3", id: "a-3", status: "done" });
  say({ ev: "settled", status: "done", summary: { final: { text: "Coverage complete." }, calls: [] }, findings: [], usage: { usd: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  w.child.emit("exit", 0, null);
  for (let i = 0; i < 300 && getRun(cutId).replying; i++) await new Promise((r) => setTimeout(r, 10));
  const run = getRun(cutId);
  assert.equal(run.status, "no-finding");
  assert.equal(run.errorInfo, null);
  assert.deepEqual(working(run.events), []);
  assert.deepEqual(ends(run.events).map((e) => e.id), ["a-3"]);
});

test("what the agents had submitted gets its proof check at the restart, from the saved passing source", async () => {
  const run = await closed(liveId);
  // The agents were not started again: only the free replay ran.
  assert.equal(startedFor(liveId).length, 0);
  assert.deepEqual(ends(run.events).map((e) => e.id), ["a-3"]);
  assert.deepEqual(working(run.events), []);
  assert.deepEqual(run.events.filter((e) => e.ev === "phase-restarted").map((e) => e.phase), ["proof"]);
  // The replay got the exact source that had passed before the restart.
  assert.ok(proved.length > 0 && proved.every((f) => f.poc === "forged_session" && f.source === "the exact passing test"));
  assert.equal(run.status, "recorded");
  // The verdict is the replay's: the record on disk says the same as the event.
  const rec = JSON.parse(readFileSync(join(dir, `run-${liveId}.json`), "utf8")).result;
  assert.deepEqual(rec.findings.map((f) => [f.title, f.proof.status]), [["Login accepts a forged session", "pass"]]);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding").map((e) => [e.id, e.proven]), [[`${liveId}.1`, true]]);
  assert.equal(existsSync(join(dir, `run-${liveId}.state.json`)), false);
});

test("with the workspace gone there is no proof check: the fleet gets its card, and the finding stays submitted", async () => {
  const run = await closed(goneId);
  assert.equal(run.status, "error");
  assert.equal(run.errorInfo.title, "This fleet run stopped at the server restart");
  assert.deepEqual(run.events.filter((e) => e.ev === "phase-restarted"), []);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding"), []);
  assert.deepEqual(run.submitted.map((f) => f.poc), ["forged_session"]);
  assert.deepEqual(ends(run.events).map((e) => e.id), ["a-3"]);
});

test("the card says the run keeps its files only when the workspace is there", async () => {
  const gone = await closed(goneId);
  assert.match(gone.errorInfo.hint, /Press Run again to continue in this chat\. The run keeps its history and its agents\.$/);
  assert.doesNotMatch(gone.errorInfo.hint, /files/);
  assert.match((await closed(cutId)).errorInfo?.hint ?? "its files.", /its files\.$/);
});

test("a fleet that stopped during its proof check finishes the check; no agent runs", async () => {
  const run = await closed(proofId);
  assert.equal(run.status, "recorded");
  assert.equal(startedFor(proofId).length, 0);
  assert.deepEqual(ends(run.events), []);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding").map((e) => e.proven), [true]);
});

test("a fleet that stopped before its agents started says so, and says a new run is needed", async () => {
  const run = await closed(earlyId);
  assert.equal(run.status, "error");
  assert.equal(run.errorInfo.reason, "interrupted");
  assert.equal(run.errorInfo.retryable, false);
  assert.match(run.errorInfo.hint, /before the agents of this fleet started\. Start a new run/);
  assert.deepEqual(ends(run.events), []);
  assert.equal(startedFor(earlyId).length, 0);
  assert.throws(() => steerRun(earlyId, "continue"), /before its agent session started/);
});

test("a restart during a follow-up ends the children it had put back to work", async () => {
  const run = getRun(replyId);
  assert.equal(run.status, "no-finding");
  assert.deepEqual(working(run.events), []);
  assert.deepEqual(ends(run.events).map((e) => e.id), ["a-2"]);
  assert.deepEqual(ends(onDisk(replyId)).map((e) => e.id), ["a-2"]);
  assert.match(run.events.findLast((e) => e.ev === "reply-error").error, /server restarted during this reply/);
  assert.equal(startedFor(replyId).length, 0);
});

test("a fleet that another live server owns is left alone: nothing is written to its stream", async () => {
  assert.equal(readFileSync(join(dir, `run-${ownedId}.stream.jsonl`), "utf8"), before[ownedId]);
  assert.equal(existsSync(join(dir, `run-${ownedId}.state.json`)), true);
  assert.equal(startedFor(ownedId).length, 0);
});

test("a follow-up that another live server answers is left alone: no end is written to its stream", async () => {
  assert.equal(readFileSync(join(dir, `run-${replyOwnedId}.stream.jsonl`), "utf8"), before[replyOwnedId]);
  assert.equal(startedFor(replyOwnedId).length, 0);
});

test("a stream line that keeps a proven finding's id but names another finding is not proven", async () => {
  // Another title, severity and test; another title; another severity; another test; the record's own.
  assert.deepEqual(getRun(relabelId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [false, false, false, false, true]);
  // The older record form: its own line; another title; another id of the same run; another run's id.
  assert.deepEqual(getRun(oldClaimId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [true, false, false, false]);
});

test("a solo run that stopped while its agent worked starts its agent again; its submitted finding is not sent to the proof check alone", async () => {
  for (let i = 0; i < 300 && !startedFor(soloId).length; i++) await new Promise((r) => setTimeout(r, 10));
  const [w] = startedFor(soloId);
  assert.ok(w, "the agent was started again");
  assert.deepEqual(w.args.slice(1, 3), ["child", "run"]);
  const run = getRun(soloId);
  assert.deepEqual(run.events.filter((e) => e.ev === "phase-restarted").map((e) => e.phase), ["agent"]);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding"), []);
  assert.equal(run.status, "running");
  w.child.emit("exit", 0, null); // end the worker, so the run closes
  await closed(soloId);
});

test("a finished fleet comes back whole, and a finding is proven only when its stored replay record says so", async () => {
  const done = getRun(doneId);
  assert.equal(done.status, "recorded");
  assert.deepEqual(working(done.events), []);
  assert.deepEqual(ends(done.events), []);
  assert.deepEqual(done.events.filter((e) => e.ev === "finding").map((e) => e.proven), [true, false]);
  assert.equal(done.events.filter((e) => e.ev === "agent-message").length, 2);
  assert.equal(readFileSync(join(dir, `run-${doneId}.stream.jsonl`), "utf8"), before[doneId]);
  // The stream says proven. The replay record says the replay failed, or has no
  // such finding, or cannot be read: not proven.
  assert.deepEqual(getRun(claimId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [false, false, false, false, false]);
  assert.deepEqual(getRun(tornId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [false]);
  assert.equal(getRun(tornId).status, "recorded");
  // An older record with one finding is read by its own fields.
  assert.deepEqual(getRun(oldId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [true]);
  assert.deepEqual(getRun(oldFailId).events.filter((e) => e.ev === "finding").map((e) => e.proven), [false]);
  // The files keep what they said. The check is made again at every load.
  assert.equal(readFileSync(join(dir, `run-${claimId}.stream.jsonl`), "utf8"), before[claimId]);
});

test("loading a run never sets proven: every proven finding has a passing replay in its record", async () => {
  for (const id of [cutId, liveId, earlyId, proofId, doneId, claimId, tornId, damagedId, replyId, ownedId]) {
    if (id !== ownedId) await closed(id); // the other server's run never closes here
    let findings = [];
    try { findings = JSON.parse(readFileSync(join(dir, `run-${id}.json`), "utf8")).result.findings ?? []; } catch { /* no record */ }
    for (const e of getRun(id).events.filter((x) => x.ev === "finding" && x.proven !== false)) {
      const k = Number(e.id.slice(id.length + 1));
      assert.equal(findings[k - 1]?.proof?.status, "pass", `${e.id} is shown as proven`);
    }
  }
  // The stream file of a loaded run gains no `proven`: nothing is written there but the ends of cut-off children.
  for (const [id, text] of Object.entries(before)) {
    const added = readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8").slice(text.length).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if ([cutId, liveId, proofId].includes(id)) continue; // these went on: a follow-up, or the proof check
    assert.deepEqual(added.filter((e) => e.ev !== "subagent-done" && e.ev !== "closed"), [], `${id} got new events at load`);
  }
});

test("a damaged record does not stop the boot and does not hide the other runs", async () => {
  const ids = listRuns().map((r) => r.id);
  for (const id of [cutId, liveId, earlyId, proofId, doneId, claimId, tornId, damagedId, replyId, ownedId]) assert.ok(ids.includes(id), `${id} is listed`);
  const run = await closed(damagedId);
  // The damaged line and the torn last line are skipped; the rest is kept.
  assert.equal(run.events.filter((e) => e.ev === "subagent-spawned").length, 2);
  assert.equal(run.status, "error");
  assert.match(run.error, /saved recovery state is unreadable/);
  assert.deepEqual(working(run.events), []);
  assert.equal(logged.filter((line) => line.includes(damagedId)).length, 1);
  // The end of the cut-off child starts on its own line, after the torn one, so the next boot reads it.
  const lines = readFileSync(join(dir, `run-${damagedId}.stream.jsonl`), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  assert.deepEqual(ends(lines).map((e) => e.id), ["a-3"]);
  assert.deepEqual(working(lines), []);
  // Written once, at the first boot: no end is lost inside the torn line and made again later.
  assert.equal(readFileSync(join(dir, `run-${damagedId}.stream.jsonl`), "utf8").split('"interrupted":true').length - 1, 1);
});
