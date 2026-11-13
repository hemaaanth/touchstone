// Candidates survive a server restart. Three saved runs: one with a stream
// file, one older run with only its record, and one the server lost mid-way.
// Each must load back with its candidates and their evidence, and no candidate
// may count as a finding.
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "run-candidates-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const EVIDENCE = { kind: "forge-trace", contract: "PauseTest", output: "vault paused by stranger: true", harmCheck: { ok: false, reason: "no ETH moved" } };
// The saved fixtures claim proof (review Minor 7). The server must still load
// each as an unproven candidate, so dropping its normalizer fails this file.
const candidate = (poc) => ({
  n: 1, pack: "contracts", title: `Anyone can pause the vault (${poc})`, severity: "high", poc, evidence: EVIDENCE,
  explanation: "A stranger can lock every user.\nFix: restrict pause().", cites: ["vault paused by stranger: true"], rootCause: `src-${poc}`, evidenceHash: "e1",
  kind: "finding", assertedBy: "checker", proven: true, candidate: false, provedBy: "oracle",
});
const jsonl = (evs) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

const STREAM = "test-model-2611120001-1";
writeFileSync(join(dir, `run-${STREAM}.stream.jsonl`), jsonl([
  { t: 1, ev: "status", status: "running" },
  { t: 2, ev: "candidate-submitted", candidate: candidate("PauseTest") },
  { t: 3, ev: "status", status: "no-finding" },
  { t: 4, ev: "closed" },
]));

const OLD = "test-model-2611120002-1";
writeFileSync(join(dir, `run-${OLD}.json`), JSON.stringify({ result: { findings: [], final: "no proven bug", candidates: [candidate("OldTest")] } }));

const LOST = "test-model-2611120003-1";
writeFileSync(join(dir, `run-${LOST}.stream.jsonl`), jsonl([
  { t: 1, ev: "status", status: "running" },
  { t: 2, ev: "candidate-submitted", candidate: candidate("LostTest") },
]));

process.env.TOUCHSTONE_RESULTS_DIR = dir;
const { getRun, listRuns } = await import("../../app/server/runs.mjs");

for (const [id, poc] of [[STREAM, "PauseTest"], [OLD, "OldTest"]]) {
  test(`a saved run loads back with its candidate and evidence (${poc})`, () => {
    const run = getRun(id);
    assert.equal(run.status, "no-finding", "a candidate does not change the run status");
    assert.equal(run.candidates.length, 1);
    const c = run.candidates[0];
    assert.equal(c.poc, poc);
    assert.deepEqual(c.evidence, EVIDENCE);
    assert.equal(c.proven, false);
    assert.equal(c.candidate, true);
    assert.equal(c.assertedBy, "agent");
    assert.equal(c.provedBy, null);
    assert.equal(c.kind, "candidate");
    assert.deepEqual(run.findingIds, []);
    assert.equal(listRuns().find((r) => r.id === id).findings, 0, "a candidate is not in the findings count");
  });
}

test("a run the server lost keeps its candidate in the record it gets at load", () => {
  const { result } = JSON.parse(readFileSync(join(dir, `run-${LOST}.json`), "utf8"));
  assert.equal(result.outcome, "error");
  assert.deepEqual(result.findings, []);
  assert.equal(result.recorded, false);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].evidence, EVIDENCE);
  assert.equal(result.candidates[0].proven, false);
  assert.equal(result.candidates[0].provedBy, null);
  assert.equal(result.candidates[0].kind, "candidate");
  const lost = getRun(LOST).candidates[0];
  assert.equal(lost.poc, "LostTest");
  assert.equal(lost.proven, false);
});
