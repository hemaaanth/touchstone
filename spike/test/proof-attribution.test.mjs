// A fleet child's run_poc stays in the child conversation. summarize() only
// walks the root, so the saved transcript has no run_poc. The finding still
// carries the harm-gated replay and the test source copied while the workspace
// existed. Reading that record must keep the finding proven, with that source.
// A proof that failed the harm gate, or that predates it, must not become
// proven just because the transcript is missing the call.
import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getFinding, listFindings } from "../../app/server/findings.mjs"
import { buildReport, renderReportHtml } from "../../app/server/report.mjs"
import { proveFindings } from "../lib/record.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.resolve(HERE, "../results/agent")
const FIXTURE = path.join(HERE, "fixtures/fleet-child-proof-run.json")
const STAMP = "zz-fleet-proof-0000000000-1"
const SOURCE = "contract VaultDrainTest is Test {\n  function test_drain() public {\n    assertEq(address(vault).balance, 0);\n  }\n}\n"

test("proveFindings keeps the submitted test source on the finding", async () => {
  const [kept, bare] = await proveFindings("/unused", [
    { n: 1, title: "drain", severity: "high", poc: "VaultDrainTest", explanation: "x", source: SOURCE },
    { n: 2, title: "bare", severity: "low", poc: "Bare", explanation: "y", source: "" },
  ], [])
  assert.equal(kept.testSource, SOURCE)
  assert.equal(kept.pocProved, false)
  assert.equal(bare.testSource, undefined)
})

test("a harm-gated forge proof stays proven when the root transcript has no run_poc", async () => {
  const file = path.join(RESULTS, `run-${STAMP}.json`)
  copyFileSync(FIXTURE, file)
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    const names = [...(raw.transcript.calls ?? []), ...(raw.transcript.results ?? [])].map((c) => c.name)
    assert.equal(names.includes("run_poc"), false)

    const list = await listFindings()
    const rows = list.filter((f) => f.runId === STAMP)
    assert.deepEqual(rows.map((f) => [f.id, f.proven]), [
      [`${STAMP}.1`, true],
      [`${STAMP}.2`, false],
      [`${STAMP}.3`, false],
    ])

    const proved = await getFinding(`${STAMP}.1`)
    assert.equal(proved.stages.proven, true)
    assert.equal(proved.stages.reproduced, true)
    assert.equal(proved.proof.pass, true)
    assert.equal(proved.proof.testSource, SOURCE)
    assert.ok(proved.proof.assertions.includes("assertEq(address(vault).balance, 0);"))
    const report = buildReport(proved)
    assert.equal(report.proven, true)
    assert.match(report.status, /^Proven:/)
    const html = renderReportHtml(report)
    assert.match(html, /Proven/)
    assert.match(html, /assertEq\(address\(vault\)\.balance, 0\);/)
    assert.doesNotMatch(html, /Not proven/)

    const preHarm = await getFinding(`${STAMP}.2`)
    assert.equal(preHarm.stages.proven, false)
    assert.equal(preHarm.proof.pass, false)
    assert.equal(preHarm.proof.testSource, null)

    const noHarm = await getFinding(`${STAMP}.3`)
    assert.equal(noHarm.stages.proven, false)
    assert.equal(noHarm.proof.pass, false)
    assert.match(renderReportHtml(buildReport(noHarm)), /Not proven/)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a root transcript run_poc still proves a pre-harm record and supplies its source", async () => {
  const stamp = "zz-fleet-proof-0000000000-2"
  const file = path.join(RESULTS, `run-${stamp}.json`)
  const transcriptSource = "contract OldTest is Test { function test_old() public { assertTrue(true); } }\n"
  const raw = {
    result: {
      pack: "contracts",
      target: { title: "Vault", pack: "contracts" },
      recorded: true,
      decision: "approved",
      approveMode: "auto",
      findings: [{
        title: "Old transcript proof",
        severity: "high",
        poc: "OldTest",
        pocProved: true,
        proof: { kind: "forge", tool: "Foundry", pass: true, status: "pass", test: "test_old()", transfers: [], logs: [] },
      }],
    },
    transcript: {
      calls: [{ name: "run_poc", args: { contract_name: "OldTest", test_source: transcriptSource } }],
      results: [{ name: "run_poc", text: "Compiling 1 files with Solc 0.8.20\n[PASS] test_old() (gas: 1000)\nSuite result: ok. 1 passed; 0 failed" }],
    },
  }
  writeFileSync(file, JSON.stringify(raw))
  try {
    const found = await getFinding(`${stamp}.1`)
    assert.equal(found.stages.proven, true)
    assert.equal(found.proof.pass, true)
    assert.equal(found.proof.testSource, transcriptSource)
    assert.equal(found.proof.compiler, "Solc 0.8.20")
  } finally {
    rmSync(file, { force: true })
  }
})
