// A crash in the tool prepass must not turn an unfinished solo run into an error.
// No model calls or Docker: the prepass and worker are controlled by this test.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "run-restart-"));
const ws = join(dir, "workspace");
mkdirSync(ws);
writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
const id = "restart-test-2611122323-1";
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };
const prepasses = [];
const envs = [];
const realTargets = await import("../lib/targets.mjs");
mock.module("../lib/targets.mjs", { exports: { ...realTargets, prepareRunWorkspace: async () => {
  const made = mkdtempSync(join(dir, "prepared-"));
  writeFileSync(join(made, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  return made;
} } });
const realPacks = await import("../packs/index.mjs");
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async (_ws, { emit }) => {
    prepasses.push(_ws);
    emit({ ev: "web-scan-done", leads: 0 });
    return { record: { pack: "web", coverage: [], leads: [] }, env: {} };
  },
  teardown: async () => {},
  prove: async (_ws, found) => found,
}) } });
const realChild = await import("node:child_process");
mock.module("node:child_process", { exports: { ...realChild, spawn: (_cmd, _args, opts) => {
  envs.push(opts.env);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(() => {
    child.stdout.write(`EVENT ${JSON.stringify({ ev: "settled", status: "done", summary: { final: { text: "Finished." }, calls: [] }, findings: [], usage: { usd: 0 } })}\n`);
    queueMicrotask(() => child.emit("exit", 0));
  });
  return child;
} } });

const events = [
  { ev: "scope", t: 1, scope: target },
  { ev: "budget", t: 2, usd: 1 },
  { ev: "mode", t: 3, mode: "solo" },
  { ev: "provider", t: 4, provider: "boundless", model: "fake" },
  { ev: "status", t: 5, status: "running" },
  { ev: "web-scan-started", t: 6 },
];
writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ ws, target, phase: "prepass" }));

function fixture(name, phase, extra = [], state = {}) {
  const runId = `${name}-2611122323-1`;
  const workspace = join(dir, `${name}-workspace`);
  mkdirSync(workspace);
  writeFileSync(join(workspace, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  const runEvents = [...events.slice(0, 5), ...extra];
  writeFileSync(join(dir, `run-${runId}.stream.jsonl`), runEvents.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${runId}.state.json`), JSON.stringify({ ws: workspace, target, phase, ...state }));
  return runId;
}
const setupId = fixture("setup-restart", "setup", [], { ws: null });
const emptySetupId = fixture("setup-no-stream", "setup", [], { ws: null, mode: "solo", modules: [], budget: 1, provider: "boundless", model: "fake" });
writeFileSync(join(dir, `run-${emptySetupId}.stream.jsonl`), "");
const agentId = fixture("agent-restart", "agent", [{ ev: "spend", t: 6, usd: 0.2 }, { ev: "thinking-delta", t: 7, conv: "root", attempt: 2, text: "before the crash" }]);
writeFileSync(join(dir, `run-${agentId}.events`), JSON.stringify({ ev: "spend", usd: 0.35 }) + "\n");
writeFileSync(join(dir, `run-${agentId}.charges.jsonl`), JSON.stringify({ usd: 0.4 }) + "\n");
const proofId = fixture("proof-restart", "proof", [{ ev: "settled", t: 6, summary: { final: { text: "done" } } }, { ev: "status", t: 7, status: "deciding" }], {
  settled: { status: "done", findings: [{ n: 1, title: "Proof", severity: "low", poc: "test" }], summary: { calls: [] } },
});
const committedId = fixture("proof-committed", "proof", [
  { ev: "settled", t: 6, summary: { final: { text: "done" } } },
  { ev: "status", t: 7, status: "deciding" },
  { ev: "finding", t: 8, id: "proof-committed-2611122323-1.1", title: "Proof" },
  { ev: "artifact-open", t: 9, id: "proof-proof-committed-2611122323-1.1" },
], { settled: { status: "done", findings: [{ n: 1, title: "Proof", severity: "low", poc: "test" }] } });
writeFileSync(join(dir, `run-${committedId}.json`), JSON.stringify({ result: { outcome: "recorded", findings: [{ n: 1, title: "Proof", severity: "low", poc: "test", proof: { status: "pass", kind: "http" } }] } }));
const reportId = fixture("report-writing", "proof", [{ ev: "settled", t: 6 }, { ev: "status", t: 7, status: "deciding" }], {
  settled: { status: "done", findings: [{ n: 1, title: "Proof", severity: "low", poc: "test" }], summary: { calls: [] } },
});
writeFileSync(join(dir, `run-${reportId}.json.tmp`), '{"result":');
const terminalId = fixture("terminal-cleanup", "proof", [{ ev: "status", t: 6, status: "no-finding" }]);
const stoppedId = fixture("operator-stopped", "prepass", [{ ev: "stop-requested", t: 6 }]);
const loopId = fixture("restart-loop", "prepass", [1, 2, 3].map((t) => ({ ev: "phase-restarted", t: 5 + t, phase: "prepass" })));
const corruptId = fixture("corrupt-state", "prepass");
writeFileSync(join(dir, `run-${corruptId}.state.json`), '{"phase":"prepass",');
const fleetRestartId = fixture("fleet-restart", "prepass", [{ ev: "mode", t: 6, mode: "fleet" }]);
// A proof-phase restart that settled with no finding, but whose scope has a
// GitHub member the run never fetched: a coverage gap, so it ends as an error.
const coverageGapId = fixture("coverage-gap", "proof", [{ ev: "settled", t: 6, summary: { final: { text: "nothing proven" } } }], {
  target: { ...target, links: ["https://github.com/example/repo"] },
  settled: { status: "done", findings: [], final: { text: "nothing proven" } },
});
// A proof-phase restart whose saved settle is a failure (not "done"): it ends
// as an error with a structured reason, not a bare status.
const settleFailedId = fixture("settle-failed", "proof", [{ ev: "settled", t: 6 }], {
  settled: { status: "error", findings: [] },
});
// A Review lead recorded before the crash is a `lead` event in the stream. The
// reload rebuilds run.events from that stream, so the restart's persisted report
// must still carry the lead (persistRun reads leadsFrom(run.events)).
const leadKeptId = fixture("lead-kept", "proof", [
  { ev: "lead", t: 6, id: "L1", agent: "review", severity: "high", file: "Vault.sol", line: 42, title: "Reentrancy", reason: "withdraw sends before zeroing the balance" },
  { ev: "settled", t: 7, summary: { final: { text: "done" } } },
], { settled: { status: "done", findings: [], final: { text: "done" } } });
const finishedId = fixture("already-finished", "agent", [{ ev: "status", t: 6, status: "no-finding" }, { ev: "closed", t: 7 }]);

const logged = [];
const consoleError = console.error;
console.error = (...args) => logged.push(args.join(" "));
const { getRun, listRuns, subscribe } = await import("../../app/server/runs.mjs");
console.error = consoleError;
after(() => rmSync(dir, { recursive: true, force: true }));

test("boot resumes a solo run killed in prepass without duplicate history", async () => {
    for (let i = 0; i < 100 && !["no-finding", "recorded"].includes(getRun(id)?.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const run = getRun(id);
    assert.equal(run.status, "no-finding");
    assert.equal(prepasses.filter((p) => p === ws).length, 1);
    assert.equal(envs.filter((e) => e.EVENTS_FILE?.includes(id)).length, 1);
    assert.deepEqual(run.events.slice(0, events.length), events);
    assert.equal(run.events.filter((e) => e.ev === "phase-restarted" && e.phase === "prepass").length, 1);
    const saved = readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(saved, run.events);
    const streamed = [];
    subscribe(id, (e) => streamed.push(e), events.length);
    assert.deepEqual(streamed.slice(0, -2), run.events.slice(events.length));
});

test("workspace setup resumes before the prepass", async () => {
  for (let i = 0; i < 100 && (getRun(setupId)?.status !== "no-finding" || getRun(emptySetupId)?.status !== "no-finding"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(setupId);
  assert.equal(run.status, "no-finding");
  assert.equal(run.events.filter((e) => e.ev === "phase-restarted" && e.phase === "setup").length, 1);
  assert.equal(prepasses.filter((p) => p.startsWith(join(dir, "prepared-"))).length, 2);
  assert.equal(getRun(emptySetupId).status, "no-finding");
  assert.equal(getRun(emptySetupId).events[0].ev, "scope");
  assert.equal(getRun(emptySetupId).events.filter((e) => e.ev === "phase-restarted" && e.phase === "setup").length, 1);
});

test("agent and proof phases restart; paid responses are carried forward once", async () => {
  for (let i = 0; i < 100 && (getRun(agentId)?.status !== "no-finding" || getRun(proofId)?.status !== "recorded"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getRun(agentId).status, "no-finding");
  assert.equal(getRun(proofId).status, "recorded");
  assert.equal(getRun(agentId).events.filter((e) => e.ev === "phase-restarted" && e.phase === "agent").length, 1);
  assert.equal(getRun(proofId).events.filter((e) => e.ev === "phase-restarted" && e.phase === "proof").length, 1);
  assert.equal(envs.find((e) => e.EVENTS_FILE?.includes(agentId))?.RUN_SPENT_USD, "0.4");
  // The re-spawned worker numbers its steps after the ones streamed before the crash.
  assert.equal(envs.find((e) => e.EVENTS_FILE?.includes(agentId))?.ATTEMPT_BASE, "3");
  assert.equal(getRun(proofId).events.filter((e) => e.ev === "finding").length, 1);
});

test("a committed proof record survives a crash between finding events and close", async () => {
  for (let i = 0; i < 100 && (getRun(committedId)?.status !== "recorded" || !getRun(committedId)?.events.some((e) => e.ev === "closed")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(committedId);
  assert.equal(run.status, "recorded");
  assert.equal(run.events.filter((e) => e.ev === "finding").length, 1);
  assert.equal(run.events.filter((e) => e.ev === "artifact-open").length, 1);
  assert.equal(run.events.filter((e) => e.ev === "artifact-done").length, 1);
  assert.equal(run.events.filter((e) => e.ev === "closed").length, 1);
  assert.equal(run.events.filter((e) => e.ev === "phase-restarted").length, 0);
  assert.equal(getRun(terminalId).events.filter((e) => e.ev === "closed").length, 1);
});

test("a crash during report writing replaces the partial temporary report", async () => {
  for (let i = 0; i < 100 && getRun(reportId)?.status !== "recorded"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getRun(reportId).status, "recorded");
  assert.equal(JSON.parse(readFileSync(join(dir, `run-${reportId}.json`), "utf8")).result.outcome, "recorded");
  assert.equal(getRun(reportId).events.filter((e) => e.ev === "finding").length, 1);
});

test("a second server cannot restart a run while its owner is alive, then takes it over", async () => {
  const locked = fixture("owned-elsewhere", "prepass");
  const owner = new DatabaseSync(join(dir, `run-${locked}.owner.sqlite`));
  owner.exec("BEGIN IMMEDIATE");
  const fleet = fixture("fleet-owned", "prepass", [{ ev: "mode", t: 7, mode: "fleet" }]);
  const fleetOwner = new DatabaseSync(join(dir, `run-${fleet}.owner.sqlite`));
  fleetOwner.exec("BEGIN IMMEDIATE");
  // A second process has its own registry; only the lock files are shared.
  const shared = globalThis.__touchstoneRuns;
  delete globalThis.__touchstoneRuns;
  let second;
  try {
    second = await import(`../../app/server/runs.mjs?lock-test-${Date.now()}`);
  } finally {
    globalThis.__touchstoneRuns = shared;
  }
  try {
    assert.equal(second.getRun(locked).status, "running");
    assert.equal(second.getRun(locked).events.filter((e) => e.ev === "phase-restarted").length, 0);
    // Owned by a live first server: listed, not hidden, and left for that owner.
    assert.equal(second.getRun(fleet).status, "error");
    assert.match(second.getRun(fleet).error, /fleet run stopped at the server restart/);
    assert.equal(existsSync(join(dir, `run-${fleet}.state.json`)), true);
  } finally {
    owner.close();
    fleetOwner.close();
  }
  // The first owner exits later: the retry timer takes the run over.
  for (let i = 0; i < 200 && second.getRun(locked)?.status !== "no-finding"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(second.getRun(locked).status, "no-finding");
  assert.equal(second.getRun(locked).events.filter((e) => e.ev === "phase-restarted").length, 1);
});

test("operator stop and completed status are not restarted", async () => {
  for (let i = 0; i < 100 && getRun(stoppedId)?.status !== "no-finding"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(getRun(stoppedId).status, "no-finding");
  assert.equal(getRun(stoppedId).events.filter((e) => e.ev === "stopped").length, 1);
  assert.equal(getRun(finishedId).status, "no-finding");
  assert.equal(getRun(finishedId).events.filter((e) => e.ev === "phase-restarted").length, 0);
  assert.equal(envs.filter((e) => e.EVENTS_FILE?.includes(stoppedId) || e.EVENTS_FILE?.includes(finishedId)).length, 0);
});

test("recovery gives up after three restarts of the same run", async () => {
  for (let i = 0; i < 100 && getRun(loopId)?.status !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(loopId);
  assert.equal(run.status, "error");
  assert.match(run.error, /recovery gave up after 3 restarts/);
  assert.equal(run.events.filter((e) => e.ev === "phase-restarted").length, 3);
  assert.equal(prepasses.filter((p) => p.includes("restart-loop")).length, 0);
  for (let i = 0; i < 100 && !getRun(loopId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(join(dir, `run-${loopId}.state.json`)), false);
});

test("an owned fleet run that cannot resume ends as an error and drops its state file", async () => {
  assert.ok(listRuns().some((r) => r.id === fleetRestartId));
  for (let i = 0; i < 100 && !getRun(fleetRestartId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(fleetRestartId);
  assert.equal(run.status, "error");
  assert.match(run.error, /fleet run stopped at the server restart/);
  assert.equal(existsSync(join(dir, `run-${fleetRestartId}.state.json`)), false);
});

test("a restarted run that settled with no finding but did not read its whole scope ends as an error", async () => {
  for (let i = 0; i < 100 && !getRun(coverageGapId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(coverageGapId);
  assert.equal(run.status, "error");
  assert.match(run.error, /not read/);
});

test("a restarted run whose saved settle failed ends with a structured error reason", async () => {
  for (let i = 0; i < 100 && !getRun(settleFailedId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(settleFailedId);
  assert.equal(run.status, "error");
  assert.match(run.error, /did not complete/);
  assert.equal(run.errorInfo?.message, run.error);
});

test("a restarted run keeps the Review leads it recorded before the crash", async () => {
  for (let i = 0; i < 100 && !getRun(leadKeptId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const report = JSON.parse(readFileSync(join(dir, `run-${leadKeptId}.json`), "utf8"));
  assert.equal(report.result.leads.length, 1);
  assert.equal(report.result.leads[0].id, "L1");
  assert.equal(report.result.leads[0].title, "Reentrancy");
  assert.equal(report.result.leads[0].file, "Vault.sol");
});

test("a corrupt state file shows the run as an error and logs once", async () => {
  assert.equal(logged.filter((line) => line.includes(corruptId)).length, 1);
  assert.ok(listRuns().some((r) => r.id === corruptId));
  for (let i = 0; i < 100 && !getRun(corruptId).events.some((e) => e.ev === "closed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = getRun(corruptId);
  assert.equal(run.status, "error");
  assert.match(run.error, /saved recovery state is unreadable/);
  assert.equal(existsSync(join(dir, `run-${corruptId}.state.json`)), false);
});
