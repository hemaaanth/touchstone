// A fleet child's run_poc never lands in the root transcript: summarize() walks
// only the root conversation. The recorder keeps the replayed test on the
// finding, and a proof that passed the harm gate stays proven when the report
// is read back. A failing or absent proof does not, even if pocProved is set.
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { proveFindings } from "../lib/record.mjs"
import { getFinding, listFindings } from "../../app/server/findings.mjs"
import { buildReport, renderReportHtml } from "../../app/server/report.mjs"

const RESULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../results/agent")
const SOURCE = "contract ChildExploit is Test {\n  function test_pwn() public {\n    assertEq(address(vault).balance, 0);\n  }\n}\n"
const OTHER = "contract OtherTest is Test { function test_other() public { assertTrue(true); } }\n"

function writeRun(stamp, findings, transcript = {}) {
  const file = path.join(RESULTS, `run-${stamp}.json`)
  writeFileSync(file, JSON.stringify({
    result: {
      pack: "contracts",
      target: { title: "Vault.sol", pack: "contracts" },
      findings,
      recorded: true,
      decision: "approved",
      approveMode: "auto",
      calls: [],
    },
    transcript,
  }))
  return file
}

const passing = {
  n: 1,
  title: "Child drained the vault",
  severity: "critical",
  poc: "ChildExploit",
  explanation: "The child replayed the drain.\n\nFix: zero the balance first.",
  pocProved: true,
  source: SOURCE,
  proof: {
    kind: "forge",
    tool: "Foundry",
    source: "engine-replay",
    status: "pass",
    pass: true,
    test: "test_pwn()",
    gasUsed: 4242,
    harm: { ok: true, kind: "funds" },
    transfers: [{ label: "attacker", address: "0xabc", net: "+1 ETH", gained: true }],
    logs: ["drained"],
  },
}

test("proveFindings keeps the submitted test source and drops a blank one", async () => {
  const [kept] = await proveFindings("/tmp/touchstone-no-workspace", [
    { n: 1, title: "kept", severity: "high", poc: "ChildExploit", explanation: "x", source: SOURCE },
  ], [])
  assert.equal(kept.pocProved, false)
  assert.equal(kept.proof, null)
  assert.equal(kept.source, SOURCE)
  const [blank] = await proveFindings("/tmp/touchstone-no-workspace", [
    { n: 2, title: "blank", severity: "low", poc: "Nope", explanation: "x", source: "  " },
  ], [])
  assert.equal(Object.hasOwn(blank, "source"), false)
})

test("a harm-gated forge proof with no root run_poc reads as proven and shows its source", async () => {
  const stamp = "zz-forge-readback-0000000000-1"
  const file = writeRun(stamp, [
    passing,
    {
      ...passing,
      n: 2,
      title: "Passed the gate but the recorder did not",
      poc: "Unmarked",
      pocProved: false,
      source: SOURCE,
    },
    {
      ...passing,
      n: 3,
      title: "Harm gate failed",
      poc: "NoHarm",
      pocProved: true,
      proof: { ...passing.proof, status: "fail", pass: false, harm: { ok: false, reason: "moved no ETH" } },
    },
    {
      n: 4,
      title: "No proof recorded",
      severity: "high",
      poc: "Missing",
      pocProved: true,
      explanation: "claimed",
    },
    {
      n: 5,
      title: "Harm ok but the label is not source",
      severity: passing.severity,
      poc: "NoSource",
      explanation: passing.explanation,
      pocProved: true,
      proof: { ...passing.proof, source: "engine-replay" },
    },
    // Neither half of the harm gate is enough alone.
    { ...passing, n: 6, title: "Pass but no harm verdict", poc: "NoHarmField", proof: (({ harm, ...p }) => p)(passing.proof) },
    { ...passing, n: 7, title: "Harm ok but no pass", poc: "NoPassField", proof: (({ pass, ...p }) => p)(passing.proof) },
  ])
  try {
    const list = await listFindings()
    const rows = list.filter((f) => f.runId === stamp)
    assert.deepEqual(rows.map((f) => f.proven), [true, false, false, false, true, false, false])

    const proved = await getFinding(`${stamp}.1`)
    assert.equal(proved.stages.proven, true)
    assert.equal(proved.stages.reproduced, true)
    assert.equal(proved.proof.pass, true)
    assert.equal(proved.proof.testSource, SOURCE)
    assert.equal(proved.proof.test, "test_pwn()")
    assert.equal(proved.proof.gas, 4242)
    assert.equal(proved.proof.rerunCommand, "forge test --match-test test_pwn()")
    assert.deepEqual(proved.proof.assertions, ["assertEq(address(vault).balance, 0);"])
    assert.equal(proved.proof.transfers[0].net, "+1 ETH")
    const html = renderReportHtml(buildReport(proved))
    assert.match(html, />Proven</)
    assert.doesNotMatch(html, /Not proven/)
    assert.match(html, /A clean Foundry replay reproduced the exploit/)
    assert.match(html, /Test source/)
    assert.ok(html.includes("contract ChildExploit is Test"))
    assert.equal(html.includes("engine-replay"), false)

    const unmarked = await getFinding(`${stamp}.2`)
    assert.equal(unmarked.stages.proven, false)
    assert.equal(unmarked.proof.pass, false)

    const failed = await getFinding(`${stamp}.3`)
    assert.equal(failed.stages.proven, false)
    assert.equal(failed.proof.pass, false)
    assert.match(renderReportHtml(buildReport(failed)), /Not proven/)

    const absent = await getFinding(`${stamp}.4`)
    assert.equal(absent.stages.proven, false)
    assert.equal(absent.proof.pass, false)
    assert.equal(absent.proof.testSource, null)
    assert.match(renderReportHtml(buildReport(absent)), /Not proven/)

    for (const k of [6, 7]) {
      const half = await getFinding(`${stamp}.${k}`)
      assert.equal(half.stages.proven, false)
      assert.equal(half.proof.pass, false)
    }

    const label = await getFinding(`${stamp}.5`)
    assert.equal(label.stages.proven, true)
    assert.equal(label.proof.testSource, null)
    assert.equal(JSON.stringify(label.proof).includes("engine-replay"), false)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a root run_poc for a different contract does not replace the recorded source", async () => {
  const stamp = "zz-forge-readback-0000000000-4"
  const file = writeRun(stamp, [passing], {
    calls: [{ name: "run_poc", args: { contract_name: "OtherTest", test_source: OTHER } }],
    results: [{ name: "run_poc", text: "Solc 0.8.20\n[PASS] test_other() (gas: 10)\nSuite result: ok. 1 passed; 0 failed" }],
  })
  try {
    const found = await getFinding(`${stamp}.1`)
    assert.equal(found.stages.proven, true)
    assert.equal(found.proof.testSource, SOURCE)
    assert.equal(renderReportHtml(buildReport(found)).includes(OTHER), false)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a passing root run_poc does not prove a forge finding the harm gate failed", async () => {
  const stamp = "zz-forge-readback-0000000000-2"
  const file = writeRun(stamp, [{
    title: "Transcript passed, harm did not",
    severity: "high",
    poc: "ChildExploit",
    pocProved: true,
    source: SOURCE,
    explanation: "x",
    proof: {
      kind: "forge",
      status: "pass",
      pass: true,
      harm: { ok: false, reason: "moved no ETH" },
      transfers: [],
      logs: [],
      test: "test_pwn()",
    },
  }], {
    calls: [{ name: "run_poc", args: { contract_name: "ChildExploit", test_source: SOURCE } }],
    results: [{ name: "run_poc", text: "Solc 0.8.20\n[PASS] test_pwn() (gas: 100)\nSuite result: ok. 1 passed; 0 failed" }],
  })
  try {
    const found = await getFinding(`${stamp}.1`)
    assert.equal(found.stages.proven, false)
    assert.equal(found.proof.pass, false)
    assert.equal(found.proof.testSource, SOURCE)
    assert.match(renderReportHtml(buildReport(found)), /Not proven/)
  } finally {
    rmSync(file, { force: true })
  }
})

test("an older forge record with a passing root run_poc and no harm field stays proven", async () => {
  const stamp = "zz-forge-readback-0000000000-3"
  const legacy = "contract LegacyExploit is Test { function test_pwn() public { assertTrue(true); } }\n"
  const file = writeRun(stamp, [{
    title: "Reentrancy",
    severity: "high",
    poc: "LegacyExploit",
    pocProved: true,
    explanation: "x",
    proof: { tool: "Foundry", pass: true, transfers: [], logs: [] },
  }], {
    calls: [{ name: "run_poc", args: { contract_name: "LegacyExploit", test_source: legacy } }],
    results: [{ name: "run_poc", text: "Solc 0.8.20\n[PASS] test_pwn() (gas: 50)\nSuite result: ok. 1 passed; 0 failed" }],
  })
  try {
    const found = await getFinding(`${stamp}.1`)
    assert.equal(found.stages.proven, true)
    assert.equal(found.proof.pass, true)
    assert.equal(found.proof.testSource, legacy)
  } finally {
    rmSync(file, { force: true })
  }
})

// Records from before the recorder stored `source`: the proof is the child's
// replay of the finding's own test, but the root's last run_poc tried a
// different contract. That other test must not stand in as this proof.
test("a proof-only finding does not show the root's last run_poc of another contract", async () => {
  const stamp = "zz-forge-readback-0000000000-5"
  const zeroBurn = "contract RescueZeroBurnTest is Test {\n  function test_zero() public {\n    vault.deposit{value: 10 ether}();\n    assertEq(address(vault).balance, 0);\n    assertGt(attacker.balance, 0);\n  }\n}\n"
  const { source, ...noSource } = passing
  const file = writeRun(stamp, [{ ...noSource, poc: "RescueAccountingTest" }], {
    calls: [{ name: "run_poc", args: { contract_name: "RescueZeroBurnTest", test_source: zeroBurn } }],
    results: [{ name: "run_poc", text: "Solc 0.8.20\n[FAIL] test_zero() (gas: 10)\nSuite result: FAILED. 0 passed; 1 failed" }],
  })
  try {
    const found = await getFinding(`${stamp}.1`)
    assert.equal(found.stages.proven, true)
    assert.equal(found.proof.pass, true)
    assert.equal(found.proof.testSource, null)
    assert.deepEqual(found.proof.assertions, [])
    assert.deepEqual(found.proof.balances, [])
    assert.equal(found.proof.transfers[0].net, "+1 ETH")
    const html = renderReportHtml(buildReport(found))
    // The attempt may still be listed by name under runs; its code may not show.
    assert.equal(html.includes("contract RescueZeroBurnTest"), false)
    assert.equal(html.includes("assertGt"), false)
  } finally {
    rmSync(file, { force: true })
  }
})

// proveFindings always sets proof.contract to the finding's poc, so a mismatch
// means the record was edited. A proof for another test proves nothing here.
test("a stored proof for another contract does not prove the finding", async () => {
  const stamp = "zz-forge-readback-0000000000-6"
  const file = writeRun(stamp, [
    { ...passing, poc: "Mine", proof: { ...passing.proof, contract: "Other" } },
    { ...passing, n: 2, poc: "Mine", proof: { ...passing.proof, contract: "Mine" } },
  ])
  try {
    const other = await getFinding(`${stamp}.1`)
    assert.equal(other.stages.proven, false)
    assert.equal(other.proof.pass, false)
    assert.match(renderReportHtml(buildReport(other)), /Not proven/)
    const mine = await getFinding(`${stamp}.2`)
    assert.equal(mine.stages.proven, true)
    assert.equal(mine.proof.pass, true)
  } finally {
    rmSync(file, { force: true })
  }
})
