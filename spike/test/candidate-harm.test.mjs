// submit_candidate in the harm-execution packs (contracts, keys, chain-watch).
// forge is mocked: run_poc and the replay return fixed results, so no
// compiler or EVM runs.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let forgeResult = { passed: 1, failed: 0, output: "" };
let replay = null; // (contract) => proofDelta result
const realSandbox = await import("../lib/sandbox.mjs");
const realProof = await import("../lib/proof.mjs");
mock.module("../lib/sandbox.mjs", {
  exports: { ...realSandbox, writePoc: () => {}, forgeTest: async () => forgeResult },
});
mock.module("../lib/proof.mjs", {
  exports: { ...realProof, proofDelta: async (_ws, { contract, source }) => replay?.(contract, source) ?? null },
});

const { default: contracts } = await import("../packs/contracts/pack.mjs");
const { supersededBy, watchFindings } = await import("../lib/candidate.mjs");
const { default: keys } = await import("../packs/keys/pack.mjs");
const { default: chainWatch } = await import("../packs/chain-watch/pack.mjs");

const OUTPUT = (name) => `[PASS] test_${name}() (gas: 51234)\nLogs:\n  vault paused by stranger: true\n  owner calls now revert for ${name}`;
const noHarmDelta = (contract, source) => ({ tool: "forge", source, contract, test: `test_${contract}`, status: "pass", pass: true, reason: null, gasUsed: 51234, logs: [{ event: "Paused", args: { by: "0xbad" } }], transfers: [], harm: { ok: false, reason: "no ETH moved and no storage written on a scope target" } });
const fundsDelta = (contract, source) => ({
  ...noHarmDelta(contract, source),
  harm: { ok: true, kind: "funds" },
  transfers: [
    { address: "0x00000000000000000000000000000000000000a1", label: "Deployed contract", netWei: "-1000", gained: false },
    { address: "0x00000000000000000000000000000000000000b2", label: "Attacker", netWei: "1000", gained: true },
  ],
});
const failDelta = (contract, source) => ({ ...noHarmDelta(contract, source), status: "fail", pass: false, reason: "assertion failed" });

const candidateArgs = (name) => ({
  title: `Anyone can pause the vault (${name})`,
  severity: "high",
  poc_contract: undefined,
  poc: name,
  evidence_lines: ["vault paused by stranger: true", `owner calls now revert for ${name}`],
  explanation: "A stranger can pause the vault and lock every user.\nFix: restrict pause() to the owner.",
});

for (const pack of [contracts, keys, chainWatch]) {
  const setup = ({ watched = false } = {}) => {
    const ws = mkdtempSync(join(tmpdir(), `cand-${pack.id}-`));
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "Vault.sol"), "contract Vault {}\n");
    const raw = { poc: 0, passed: new Map(), found: [], candidates: [] };
    const state = watched ? watchFindings(raw) : raw;
    const tools = Object.fromEntries(pack.tools(ws, state).map((t) => [t.name, t]));
    const runPoc = async (name, passed = true) => {
      forgeResult = { passed: passed ? 1 : 0, failed: passed ? 0 : 1, output: OUTPUT(name), timedOut: false };
      return tools.run_poc.execute({ test_source: `contract ${name} { /* ${name} */ }`, contract_name: name });
    };
    return { state, tools, runPoc, done: () => rmSync(ws, { recursive: true, force: true }) };
  };

  test(`${pack.id}: a passing test the harm check does not count becomes an unproven candidate`, async () => {
    const { state, tools, runPoc, done } = setup();
    try {
      replay = noHarmDelta;
      await runPoc("PauseTest");
      const r = await tools.submit_candidate.execute(candidateArgs("PauseTest"));
      assert.ok(!r.isError, r.output[0].text);
      const c = state.candidates[0];
      assert.equal(c.pack, pack.id);
      assert.equal(c.proven, false);
      assert.equal(c.candidate, true);
      assert.equal(c.assertedBy, "agent");
      assert.equal(c.provedBy, null);
      assert.equal(c.evidence.kind, "forge-trace");
      assert.equal(c.evidence.harmCheck.ok, false);
      assert.match(c.evidence.output, /vault paused by stranger/);
      assert.equal(c.evidence.logs[0].event, "Paused");
      assert.equal(state.found.length, 0, "a candidate is not a finding");
    } finally { done(); }
  });

  test(`${pack.id}: the no-proof message names submit_candidate`, async () => {
    const { tools, runPoc, done } = setup();
    try {
      replay = noHarmDelta;
      const out = await runPoc("PauseTest");
      if (pack.id === "contracts") {
        const refused = await tools.submit_finding.execute({ title: "t", severity: "high", poc_contract: "PauseTest", explanation: "x" });
        assert.equal(refused.isError, true, "the finding gate still refuses a no-harm replay");
        assert.match(refused.output[0].text, /shows no harm/);
        assert.match(refused.output[0].text, /submit_candidate/);
      } else {
        assert.match(out.output[0].text, /submit_candidate/);
      }
    } finally { done(); }
  });

  test(`${pack.id}: a bare claim or a test that never passed is refused`, async () => {
    const { state, tools, runPoc, done } = setup();
    try {
      replay = noHarmDelta;
      const bare = await tools.submit_candidate.execute(candidateArgs("NeverRan"));
      assert.match(bare.output[0].text, /never a bare claim/);
      await runPoc("FailTest", false);
      const failed = await tools.submit_candidate.execute(candidateArgs("FailTest"));
      assert.equal(failed.isError, true);
      // A test that passed once but fails on replay has no evidence.
      await runPoc("FlakyTest");
      replay = failDelta;
      const flaky = await tools.submit_candidate.execute(candidateArgs("FlakyTest"));
      assert.match(flaky.output[0].text, /did not pass on replay/);
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: a replay the harm check counts is refused and routed to submit_finding`, async () => {
    const { state, tools, runPoc, done } = setup();
    try {
      replay = fundsDelta;
      await runPoc("DrainTest");
      const r = await tools.submit_candidate.execute(candidateArgs("DrainTest"));
      assert.equal(r.isError, true);
      assert.match(r.output[0].text, /Call submit_finding with "DrainTest"/);
      assert.equal(state.candidates?.length ?? 0, 0);
    } finally { done(); }
  });

  test(`${pack.id}: duplicate guards and the cap of 3`, async () => {
    const { state, tools, runPoc, done } = setup();
    try {
      replay = noHarmDelta;
      for (const n of ["A", "B", "C", "D"]) await runPoc(`Pause${n}`);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("PauseA"))).isError);
      assert.match((await tools.submit_candidate.execute(candidateArgs("PauseA"))).output[0].text, /already recorded as candidate #1/);
      state.found.push({ n: 1, poc: "PauseB", title: "found" });
      assert.match((await tools.submit_candidate.execute(candidateArgs("PauseB"))).output[0].text, /already recorded as finding #1/);
      state.found.length = 0;
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("PauseB"))).isError);
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("PauseC"))).isError);
      const fourth = await tools.submit_candidate.execute(candidateArgs("PauseD"));
      assert.match(fourth.output[0].text, /already has 3 candidates/);
      assert.equal(state.candidates.length, 3);
    } finally { done(); }
  });

  // Delta review Minor 1: a submitted finding for the candidate's test does not
  // take its place. Only the final proof can, and only with pocProved: true.
  test(`${pack.id}: a submitted finding leaves the candidate until the final proof proves it`, async () => {
    const { state, tools, runPoc, done } = setup({ watched: true });
    try {
      replay = noHarmDelta;
      await runPoc("PauseTest");
      assert.ok(!(await tools.submit_candidate.execute(candidateArgs("PauseTest"))).isError);
      // contracts runs a harm replay at submit; keys and chain-watch take a pass.
      replay = fundsDelta;
      const r = await tools.submit_finding.execute({ title: "Drain", severity: "high", poc_contract: "PauseTest", explanation: "x\nFix: y" });
      assert.ok(!r.isError, r.output[0].text);
      assert.equal(state.found.length, 1);
      assert.deepEqual(state.candidates.map((c) => c.poc), ["PauseTest"], "the candidate stays while the finding is unproven");
      const f = state.found[0];
      assert.deepEqual(supersededBy(state.candidates, [{ ...f, pocProved: false, proof: { kind: "forge", pass: true, harm: { ok: false } } }]), []);
      assert.deepEqual(supersededBy(state.candidates, [{ ...f, pocProved: true, proof: { kind: "forge", pass: true, harm: { ok: true } } }]), [{ poc: "PauseTest", by: "PauseTest" }]);
    } finally { done(); }
  });
}

// The forge harm gate (lib/record.mjs proveFindings) replays only findings.
// Its record keeps no `candidate` field, so a candidate that reached the list
// (a forged audit file, a bug) would come out as a finding with pocProved.
test("proveFindings leaves a candidate out, even one whose replay shows harm", async () => {
  const { proveFindings } = await import("../lib/record.mjs");
  const { isProven } = await import("../lib/proof-view.mjs");
  const ws = mkdtempSync(join(tmpdir(), "cand-record-"));
  try {
    replay = fundsDelta;
    const events = ["Drain", "Pause"].map((contract) => ({ ev: "run_poc-done", contract, passed: 1 }));
    const out = await proveFindings(ws, [
      { n: 1, title: "real", severity: "high", poc: "Drain", source: "contract Drain {}" },
      { n: 2, title: "a candidate", severity: "critical", poc: "Pause", source: "contract Pause {}", kind: "candidate", candidate: true, proven: false },
    ], events);
    assert.deepEqual(out.map((f) => [f.poc, isProven(f)]), [["Drain", true]]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
