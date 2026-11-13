// An older run has a record (run-<id>.json) but no stream file. The server
// rebuilds its events from the record (rebuildEvents in app/server/runs.mjs).
// A coverage gap in the record must survive the rebuild: a run whose scope was
// not read must not come back as a clean no-finding (largerepo-delta-review
// Minor 3).
//
//   node --experimental-test-module-mocks --test spike/test/run-legacy-rebuild.test.mjs
//
// The records are fixtures in a throwaway results folder, written before the
// server module loads them. spawn is mocked: a legacy run starts no engine.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realChild from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceCoverage, coverageFailure } from "../lib/source-coverage.mjs";

const spawn = () => {
  throw new Error("a legacy run must not start an engine");
};
mock.module("node:child_process", { exports: { ...realChild, default: { ...realChild, spawn }, spawn } });

const dir = mkdtempSync(path.join(tmpdir(), "run-legacy-"));
const RESULTS = path.join(dir, "results");
mkdirSync(RESULTS, { recursive: true });
process.env.TOUCHSTONE_RESULTS_DIR = RESULTS;
after(() => rmSync(dir, { recursive: true, force: true }));

const REPO = "https://github.com/cosmos/cosmos-sdk";
const refused = { ev: "source-fetch", url: REPO, ok: false, error: "cosmos/cosmos-sdk would bring this scope to 3053 source files (the cap is 200) after filtering — refused" };
const fetched = { ev: "source-fetch", url: REPO, ok: true, where: "vendor/cosmos__cosmos-sdk", files: 120 };
const unread = sourceCoverage([REPO], [refused]);
const read = sourceCoverage([REPO], [fetched]);
const target = { title: "Cosmos SDK", pack: "review", links: [REPO] };
const final = "I found no exploitable issue.";
const finding = { title: "Unchecked send", severity: "high", poc: "x/bank/keeper/send.go" };
const crash = { kind: "crash", retryable: true, reason: "no-settle", spentUsd: 0.12, title: "The run stopped unexpectedly", hint: "Press Run again.", detail: "The engine process ended before it reported a result: signal SIGKILL.", message: "The engine process ended before it reported a result: signal SIGKILL." };

// Each record has the fields persistRun writes; no stream file, no engine file.
const fixtures = {
  "legacy-gap-0000000001-1": { target, outcome: "error", error: coverageFailure(unread).message, errorInfo: coverageFailure(unread), sourceCoverage: unread, final, findings: [] },
  // A record written before the gate: outcome no-finding, but its coverage says a member was not read.
  "legacy-old-0000000002-1": { target, outcome: "no-finding", error: null, errorInfo: null, sourceCoverage: unread, final, findings: [] },
  "legacy-found-0000000003-1": { target, outcome: "recorded", error: null, errorInfo: null, sourceCoverage: unread, final, findings: [finding], recorded: true },
  "legacy-clean-0000000004-1": { target, outcome: "no-finding", error: null, errorInfo: null, sourceCoverage: read, final, findings: [] },
  // From before sourceCoverage existed: nothing says a member was unread.
  "legacy-plain-0000000005-1": { target, outcome: "no-finding", final, findings: [] },
  // A run that failed for another reason (a crash). Its scope was read, so
  // only its own errorInfo can say why it ended.
  "legacy-crash-0000000006-1": { target, outcome: "error", error: crash.message, errorInfo: crash, sourceCoverage: read, final: null, findings: [] },
};
for (const [id, result] of Object.entries(fixtures)) writeFileSync(path.join(RESULTS, `run-${id}.json`), JSON.stringify({ result }));

const { getRun } = await import("../../app/server/runs.mjs");
const lastStatus = (r) => r.events.findLast((e) => e.ev === "status");

test("a rebuilt run whose record is a coverage error ends as that error, with the agent's final answer", () => {
  const r = getRun("legacy-gap-0000000001-1");
  assert.equal(r.status, "error");
  assert.equal(lastStatus(r).errorInfo?.kind, "coverage");
  assert.match(lastStatus(r).errorInfo?.detail ?? "", /Not read:\n- https:\/\/github\.com\/cosmos\/cosmos-sdk: .*3053 source files/);
  assert.equal(r.events.find((e) => e.ev === "no-finding")?.final, final, "the agent's answer is kept");
});

test("a rebuilt no-finding run whose coverage says a member was not read is not clean", () => {
  const r = getRun("legacy-old-0000000002-1");
  assert.equal(r.status, "error");
  assert.equal(lastStatus(r).errorInfo?.kind, "coverage");
  assert.match(lastStatus(r).errorInfo?.message ?? "", /not a clean result/);
});

test("a rebuilt recorded run with a gap stays recorded and keeps its coverage note", () => {
  const r = getRun("legacy-found-0000000003-1");
  assert.equal(r.status, "recorded");
  const note = r.events.find((e) => e.ev === "coverage");
  assert.ok(note, "the coverage note is rebuilt");
  assert.equal(note.info?.kind, "coverage");
  assert.match(note.info?.message ?? "", /finding was recorded/i);
  assert.ok(r.events.indexOf(note) < r.events.indexOf(lastStatus(r)), "the note comes before the recorded status");
});

test("a rebuilt run that read its scope, or that has no coverage record, is still no-finding", () => {
  for (const id of ["legacy-clean-0000000004-1", "legacy-plain-0000000005-1"]) {
    const r = getRun(id);
    assert.equal(r.status, "no-finding", id);
    assert.ok(!r.events.some((e) => e.ev === "coverage"), id);
    assert.equal(r.events.find((e) => e.ev === "no-finding")?.final, final, id);
  }
});

test("a rebuilt run whose record is another error ends on its own reason, not a generic one", () => {
  const r = getRun("legacy-crash-0000000006-1");
  assert.equal(r.status, "error");
  assert.equal(lastStatus(r).errorInfo?.kind, "crash", "the record's own errorInfo, not the generic 'did not complete'");
  assert.equal(lastStatus(r).error, crash.message);
  assert.ok(!r.events.some((e) => e.ev === "coverage"), "a run that read its scope gets no coverage note");
});
