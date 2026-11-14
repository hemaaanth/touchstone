import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditState } from "../lib/audit-state.mjs";
import { checkCandidate, ideaTool, makeAgentFinding } from "../lib/candidate.mjs";
import { isProven } from "../lib/proof-view.mjs";
import { agentFindingsOf, candidateEvents, trackCandidate, writeCandidates } from "../../app/server/candidates.mjs";
import { REPORT } from "./helpers/agent-report.mjs";
import { AGENT_FINDING_CAP } from "../lib/agent-report.mjs";

const line = "GET /private/export -> 200 customer records";
const args = (poc, extra = {}) => ({ poc, title: `Unauthenticated private export ${poc}`, severity: "high", explanation: "An unauthenticated request disclosed customer records.\nFix: enforce authorization.", evidence_lines: [line], ...extra });
const lookup = (poc) => poc === "matched" ? { proved: true } : poc === "absent" ? null : { text: line, evidence: { kind: "transcript", poc, result: line }, rootCause: `export:${poc}` };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-findings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "audit.json");
  return { root, file, state: auditState(file) };
}

test("unlimited ideas need a next test, not a claim of harm", async (t) => {
  const { state } = fixture(t), tool = ideaTool(state);
  for (let n = 0; n < 12; n++) assert.ok(!(await tool.execute({ title: `Possible authorization gap ${n}`, hypothesis: "A private export might lack authorization.", next_test: "Compare an authenticated and unauthenticated request." })).isError);
  assert.equal(state.candidates.length, 12);
  assert.equal(state.agentFindings.length, 0);
  assert.ok((await tool.execute({ title: "Too short", hypothesis: "maybe", next_test: "test" })).isError);
});

test("structured evidence promotes a candidate; the report cap binds across modules and restart", async (t) => {
  const { file, state } = fixture(t);
  await ideaTool(state).execute({ title: "Possible export disclosure", hypothesis: "A private export might lack authorization.", next_test: "Try the export without an authenticated session." });
  const candidate = state.candidates[0];
  const first = await checkCandidate({ pack: "web", state, lookup, args: args("p1", { report: REPORT, candidate_poc: candidate.poc }) });
  assert.equal(first.finding.kind, "agent-finding");
  assert.equal(first.finding.verification, "agent");
  assert.equal(first.finding.proven, false);
  assert.equal(first.finding.candidate, false);
  assert.equal(state.candidates.length, 0);
  assert.equal(state.found.length, 0, "agent evidence never enters the oracle replay queue");
  const restarted = auditState(file);
  // Fill to the cap across modules, then one more is refused as a report.
  for (let n = 2; n <= AGENT_FINDING_CAP; n++) {
    assert.ok((await checkCandidate({ pack: n % 2 ? "contracts" : "domains", state: restarted, lookup, args: args(`p${n}`, { report: REPORT }) })).finding);
  }
  const resumed = auditState(file);
  assert.equal(resumed.agentFindings.length, AGENT_FINDING_CAP);
  const over = `p${AGENT_FINDING_CAP + 1}`;
  assert.equal((await checkCandidate({ pack: "web", state: resumed, lookup, args: args(over, { report: REPORT }) })).reason, "finding-cap");
  assert.ok((await checkCandidate({ pack: "web", state: resumed, lookup, args: args(over) })).candidate);
  assert.equal(resumed.candidates.length, 1);
  for (let n = 0; n < 5; n++) resumed.found.push({ n: n + 1, poc: `verified${n}`, proof: { kind: "http", status: "pass" } });
  assert.equal(resumed.found.length, 5, "deterministic findings remain uncapped");
});

test("a finding needs recorded evidence, exact citations, and a complete report", async (t) => {
  const { state } = fixture(t);
  for (const [poc, extra, reason] of [
    ["p1", { report: { harm: "Spam already exists on the site" } }, "bad-report"],
    ["absent", { report: REPORT }, "no-attempt"],
    ["matched", { report: REPORT }, "proved"],
    ["p1", { report: REPORT, evidence_lines: ["Invented exploit result"] }, "bad-cite"],
    ["p1", { report: REPORT, candidate_poc: "missing" }, "no-candidate"],
  ]) assert.equal((await checkCandidate({ pack: "web", state, lookup, args: args(poc, extra) })).reason, reason);
  assert.equal(state.agentFindings.length, 0);
  const forged = makeAgentFinding({ ...args("p1"), report: REPORT, proven: true, pocProved: true, proof: { kind: "http", status: "pass" } });
  assert.equal(forged.proven, false);
  assert.equal(isProven(forged), false);
  assert.equal(isProven({ ...forged, pocProved: true, proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } }), false);
  assert.equal(forged.provedBy, null);
});

test("reports survive server events, saved records, replay, and deterministic supersession", async (t) => {
  const { root, state } = fixture(t);
  const { finding } = await checkCandidate({ pack: "web", state, lookup, args: args("p1", { report: REPORT }) });
  const ev = { t: 1, ev: "agent-finding-submitted", finding };
  const run = { candidates: [], agentFindings: [] };
  assert.equal(trackCandidate(run, ev), true);
  assert.equal(trackCandidate(run, ev), false);
  const file = join(root, "run.json"); writeFileSync(file, JSON.stringify({ result: { findings: [] } }));
  assert.equal(writeCandidates(file, run), true);
  const result = JSON.parse(readFileSync(file)).result;
  assert.equal(result.agentFindings.length, 1);
  assert.equal(result.findings.length, 0);
  const replay = candidateEvents(result, [], 2);
  assert.equal(agentFindingsOf(replay).length, 1);
  assert.equal(candidateEvents(result, replay, 3).length, 0);
  trackCandidate(run, { ev: "agent-finding-superseded", poc: finding.poc });
  assert.equal(run.agentFindings.length, 0);
  state.found.push({ n: 1, poc: finding.poc, pack: "web", proof: { kind: "evidence", status: "pass", check: "weak-csp" } });
  assert.equal(state.agentFindings.length, 1, "a repeated measurement cannot supersede an agent report");
  state.found.push({ n: 2, poc: finding.poc, pack: "web", proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } });
  assert.equal(state.agentFindings.length, 0);
});

test("concurrent children cannot overrun the shared report limit", async (t) => {
  const { state } = fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const delayed = async (poc) => { await held; return lookup(poc); };
  // Two more children than the cap allows: the surplus must be refused, never
  // slipped in by the concurrent pass.
  const extra = 2;
  const calls = Array.from({ length: AGENT_FINDING_CAP + extra }, (_, n) => checkCandidate({ pack: `module-${n}`, state, lookup: delayed, args: args(`p${n}`, { report: REPORT }) }));
  release();
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r.finding).length, AGENT_FINDING_CAP);
  assert.equal(results.filter((r) => r.reason === "finding-cap").length, extra);
});
