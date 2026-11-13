// submit_candidate in the evidence-replay packs (supply-chain, infra-cloud,
// domains). The replay and the domains scan are mocked, so no snapshot,
// scanner or Docker runs.
import "./helpers/isolated-env.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HASH = "a".repeat(64);
const pass = new Set(); // lead ids whose replay passes
const realEvidence = await import("../lib/proof-evidence.mjs");
mock.module("../lib/proof-evidence.mjs", {
  exports: {
    ...realEvidence,
    replayEvidence: async (_ws, evidence) => pass.has(evidence.where)
      ? { status: "pass", check: evidence.check, where: evidence.where, snapshotHash: HASH }
      : { status: "fail", check: evidence.check, where: evidence.where, reason: "detector did not confirm the location" },
  },
});
const lead = (id, extra = {}) => ({
  id, check: `rule-${id}`, title: `Rule ${id}`, severity: "high", impact: "High", file: `deploy/${id}.tf`, lines: "3-9", commit: "c0ffee",
  rootCause: `root-${id}`, description: `lead ${id}`, where: id, evidence: { check: `rule-${id}`, where: id, snapshotHash: HASH }, ...extra,
});
const LEADS = ["L1", "L2", "L3", "L4", "L5"].map((id) => lead(id));
LEADS.push(lead("R1", { reviewOnly: true }), lead("L1twin", { rootCause: "root-L1" }));
const realChecks = await import("../packs/domains/checks.mjs");
mock.module("../packs/domains/checks.mjs", {
  exports: { ...realChecks, scanSnapshot: async () => ({ snapshotHash: HASH, leads: LEADS }) },
});

const { default: supplyChain } = await import("../packs/supply-chain/pack.mjs");
const { default: infraCloud } = await import("../packs/infra-cloud/pack.mjs");
const { default: domains } = await import("../packs/domains/pack.mjs");
const { default: surface } = await import("../packs/surface/pack.mjs");

const SPECS = [
  { pack: supplyChain, report: "supply-chain-leads.json", finding: (id) => ({ lead_id: id, severity: "high" }), findingPoc: (id) => `evidence-${id}` },
  { pack: infraCloud, report: "infra-cloud-leads.json", finding: (id) => ({ lead_id: id }), findingPoc: (id) => `infra-evidence-${id}` },
  // domains replays inside submit_finding; a failed submit is the attempt.
  { pack: domains, finding: (id) => ({ lead_id: id, explanation: "Captured. Fix: remove it." }), findingPoc: (id) => id },
];

const candidateArgs = (id) => ({
  title: `Exposed config (${id})`,
  severity: "high",
  poc: id,
  evidence_lines: [`"file":"deploy/${id}.tf"`, `"reason":"detector did not confirm the location"`],
  explanation: "The file exposes an admin endpoint the rule does not cover.\nFix: remove the public binding.",
});

for (const { pack, report, finding, findingPoc } of SPECS) {
  const setup = () => {
    pass.clear();
    const ws = mkdtempSync(join(tmpdir(), `cand-${pack.id}-`));
    if (report) writeFileSync(join(ws, report), JSON.stringify({ leads: LEADS }));
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(pack.tools(ws, state).map((t) => [t.name, t]));
    const attempt = (id) => (tools.check_evidence ? tools.check_evidence.execute({ lead_id: id }) : tools.submit_finding.execute(finding(id)));
    return { state, tools, attempt, done: () => rmSync(ws, { recursive: true, force: true }) };
  };

  test(`${pack.id}: a lead whose replay did not pass becomes an unproven candidate`, async () => {
    const { state, tools, attempt, done } = setup();
    try {
      const out = await attempt("L1");
      assert.equal(out.isError, true);
      assert.match(out.output[0].text, /submit_candidate/, "the no-proof message names submit_candidate");
      const r = await tools.submit_candidate.execute(candidateArgs("L1"));
      assert.ok(!r.isError, r.output[0].text);
      const c = state.candidates[0];
      assert.equal(c.pack, pack.id);
      assert.equal(c.proven, false);
      assert.equal(c.candidate, true);
      assert.equal(c.assertedBy, "agent");
      assert.equal(c.provedBy, null);
      assert.equal(c.evidence.kind, "snapshot-slice");
      assert.equal(c.evidence.file, "deploy/L1.tf");
      assert.equal(c.evidence.replay.status, "fail");
      assert.equal(c.rootCause, "root-L1");
      assert.equal(state.found.length, 0, "a candidate is not a finding");
      // The finding gate is unchanged: the failed lead is still refused there.
      assert.equal((await tools.submit_finding.execute(finding("L1"))).isError, true);
      assert.equal(state.found.length, 0);
    } finally { done(); }
  });

  // Review Minor 3: the candidate's poc is the form a finding for the same
  // lead uses, so the poc guards and the supersede step see the pair.
  test(`${pack.id}: the candidate poc is the finding's poc form, and the poc guard uses it`, async () => {
    const { state, tools, attempt, done } = setup();
    try {
      await attempt("L1");
      await attempt("L2");
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("L1"))).isError);
      assert.equal(state.candidates[0].poc, findingPoc("L1"));
      state.found.push({ n: 1, poc: findingPoc("L2"), title: "found" });
      assert.match((await tools.submit_candidate.execute(candidateArgs("L2"))).output[0].text, /already recorded as finding #1/);
      assert.equal(state.candidates.length, 1);
    } finally { done(); }
  });

  test(`${pack.id}: a bare claim or a review-only lead is refused`, async () => {
    const { state, tools, attempt, done } = setup();
    try {
      assert.match((await tools.submit_candidate.execute(candidateArgs("L2"))).output[0].text, /never a bare claim/);
      if (pack.id === "domains") {
        await attempt("R1");
        assert.match((await tools.submit_candidate.execute(candidateArgs("R1"))).output[0].text, /never a bare claim/);
      }
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: a lead whose replay passed is refused and routed to submit_finding`, async () => {
    const { state, tools, attempt, done } = setup();
    try {
      pass.add("L3");
      if (tools.check_evidence) {
        assert.ok(!(await attempt("L3")).isError);
        const r = await tools.submit_candidate.execute(candidateArgs("L3"));
        assert.equal(r.isError, true);
        assert.match(r.output[0].text, /Call submit_finding with "L3"/);
      } else {
        // domains records only failed replays; a passing one is already a finding.
        assert.ok(!(await attempt("L3")).isError);
        assert.match((await tools.submit_candidate.execute(candidateArgs("L3"))).output[0].text, /already recorded as finding #1/);
      }
      // A lead that failed, then passed on a later check, is no longer a candidate.
      if (tools.check_evidence) {
        pass.delete("L4");
        await attempt("L4");
        pass.add("L4");
        await attempt("L4");
        assert.match((await tools.submit_candidate.execute(candidateArgs("L4"))).output[0].text, /Call submit_finding/);
      }
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: duplicate guards and the cap of 3`, async () => {
    const { state, tools, attempt, done } = setup();
    try {
      for (const id of ["L1", "L1twin", "L2", "L4", "L5"]) await attempt(id);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("L1"))).isError);
      assert.match((await tools.submit_candidate.execute(candidateArgs("L1"))).output[0].text, /already recorded as candidate #1/);
      assert.match((await tools.submit_candidate.execute(candidateArgs("L1twin"))).output[0].text, /root cause is already recorded/);
      state.found.push({ n: 1, poc: "x", title: "found", rootCause: "root-L2" });
      assert.match((await tools.submit_candidate.execute(candidateArgs("L2"))).output[0].text, /root cause is already recorded as finding #1/);
      state.found.length = 0;
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("L2"))).isError);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("L4"))).isError);
      const fourth = await tools.submit_candidate.execute(candidateArgs("L5"));
      assert.equal(fourth.isError, true);
      assert.match(fourth.output[0].text, /already has 3 candidates/);
      assert.equal(state.candidates.length, 3);
      assert.equal(state.found.length, 0);
    } finally { done(); }
  });
}

// Review design decision: supply-chain keeps no model prose (pack.mjs "Do not
// retain model prose"). Its candidate text comes from the lead, as
// submit_finding's does. The other evidence packs keep the agent's write-up.
test("supply-chain: the candidate title and write-up come from the lead, never the agent", async () => {
  pass.clear();
  const ws = mkdtempSync(join(tmpdir(), "cand-sc-prose-"));
  writeFileSync(join(ws, "supply-chain-leads.json"), JSON.stringify({ leads: LEADS }));
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(supplyChain.tools(ws, state).map((t) => [t.name, t]));
    const props = Object.keys(tools.submit_candidate.parameters.properties ?? {});
    assert.ok(!props.includes("title") && !props.includes("explanation"), "the tool asks for no prose");
    await tools.check_evidence.execute({ lead_id: "L1" });
    const r = await tools.submit_candidate.execute({ ...candidateArgs("L1"), title: "The key is funded", explanation: "It holds 40 ETH." });
    assert.ok(!r.isError, r.output[0].text);
    const c = state.candidates[0];
    assert.equal(c.title, "rule-L1");
    assert.equal(c.explanation, "lead L1");
    assert.ok(!JSON.stringify(c).includes("funded") && !JSON.stringify(c).includes("40 ETH"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("surface shares the domains tools but gets no submit_candidate", () => {
  const ws = mkdtempSync(join(tmpdir(), "cand-surface-"));
  try {
    const names = surface.tools(ws, { poc: 0, passed: new Map(), found: [] }).map((t) => t.name);
    assert.ok(!names.includes("submit_candidate"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
