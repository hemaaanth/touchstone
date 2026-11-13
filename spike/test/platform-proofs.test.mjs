// Proof kinds: the run record keeps each finding's proof.kind and the pack's
// prepass, and the app serves a card shape per kind. Secrets never go out whole.
import "./helpers/isolated-env.mjs";
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PACKS } from "../packs/index.mjs"
import { proofKind, isProven, proofView, cell, withProven } from "../lib/proof-view.mjs"
import { getFinding, listCandidates, listFindings } from "../../app/server/findings.mjs"

const RESULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../results/agent")

const http = {
  title: "User B reads user A's order", severity: "high", explanation: "The order id is not checked.",
  proven: true,
  proof: {
    kind: "http", status: "pass",
    oracle: { name: "bola-wallet-idor", detail: "user B's response held user A's email", passed: true },
    log: [{ label: "B reads A's order", request: { method: "GET", url: "/api/orders/1", headers: { authorization: "Bearer abc123", accept: "json" } }, response: { status: 200, headers: { "content-type": "json" }, body: '{"email":"a@x.test"}' } }],
  },
}
const evidence = {
  title: "Key in config", severity: "critical", explanation: "A key is committed.", proven: true,
  evidence: { check: "secret-in-file", where: { file: "config.js", line: 3, apiKey: "sk-live-123" }, snapshotHash: "a".repeat(64) },
  proof: { kind: "evidence", status: "pass", check: "secret-in-file", snapshotHash: "a".repeat(64), commit: "abc1234", detail: "Allowlisted detector confirmed the pinned evidence." },
}
const forgeOld = { title: "Reentrancy", severity: "high", poc: "Exploit", pocProved: true, proof: { tool: "Foundry", pass: true, transfers: [], logs: [] } }

test("proofKind defaults to forge; isProven reads each kind's own pass, and harm", () => {
  assert.equal(proofKind(forgeOld), "forge")
  assert.equal(proofKind(http), "http")
  assert.equal(proofKind({ proof: { kind: "weird" } }), "forge")
  // N3 (B7): an old forge record has no harm verdict, so harm was not judged.
  assert.equal(isProven(forgeOld), false)
  assert.equal(isProven({ pocProved: false }), false)
  assert.equal(isProven(http), true)
  assert.equal(isProven({ ...http, proof: { ...http.proof, status: "fail" } }), false)
  assert.equal(proofView(forgeOld), null)
})

test("a secret is shown redacted with its hash, never whole", () => {
  assert.deepEqual(cell("note", "plain"), { name: "note", redacted: false, value: "plain" })
  const packed = cell("k", { redacted: "[REDACTED]", sha256: "f".repeat(64) })
  assert.equal(packed.redacted, true)
  const named = cell("apiKey", "sk-live-123")
  assert.equal(named.redacted, true)
  assert.match(named.sha256, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(named).includes("sk-live-123"))
})

test("http and evidence proofs become card shapes with caps and no raw secrets", () => {
  const h = proofView(http)
  assert.equal(h.kind, "http")
  assert.equal(h.oracle.passed, true)
  assert.equal(h.exchanges[0].request.url, "/api/orders/1")
  const auth = h.exchanges[0].request.headers.find((c) => c.name === "authorization")
  assert.equal(auth.value, undefined)
  assert.equal(auth.redacted, true)
  const e = proofView(evidence)
  assert.equal(e.kind, "evidence")
  assert.equal(e.commit, "abc1234")
  assert.deepEqual(e.cited.map((c) => [c.name, c.redacted]), [["file", false], ["line", false], ["apiKey", true]])
  assert.ok(!JSON.stringify(e).includes("sk-live-123"))
  const big = proofView({ proof: { kind: "http", status: "pass", log: Array.from({ length: 50 }, () => ({})) } })
  assert.equal(big.exchanges.length, 20)
})

test("the app serves a recorded http, evidence and old forge finding", async () => {
  PACKS.fakeweb = { id: "fakeweb", title: "Fake web", proof: "http" }
  const stamp = "zz-proofs-test-0000000000-1"
  const file = path.join(RESULTS, `run-${stamp}.json`)
  const prepass = { leads: ["/api/orders"] }
  writeFileSync(file, JSON.stringify({ result: { pack: "fakeweb", target: { title: "Fake lab", pack: "fakeweb" }, prepass, findings: [http, evidence, forgeOld], recorded: true, decision: "approved", approveMode: "auto", calls: [] }, transcript: {} }))
  try {
    const list = await listFindings()
    // N3: the evidence row and the old forge row (no harm verdict) are
    // candidates now; only the http finding is a finding.
    assert.equal(list.filter((f) => f.runId === stamp).length, 1)
    assert.deepEqual((await listCandidates()).filter((c) => c.runId === stamp).map((c) => c.measured.reason), ["repeated", "harm-not-judged"])
    const h = await getFinding(`${stamp}.1`)
    assert.equal(h.proofKind, "http")
    assert.equal(h.pack, "fakeweb")
    assert.equal(h.module, "Fake web")
    assert.equal(h.stages.proven, true)
    assert.deepEqual(h.prepass, prepass)
    assert.equal(h.proof.exchanges.length, 1)
    assert.equal(h.staticScan, null)
    // N3: an evidence replay repeats a measurement; it is not proof of harm,
    // so it is no finding (and has no finding view). Nor is the old forge row.
    assert.equal(await getFinding(`${stamp}.2`), null)
    assert.equal(await getFinding(`${stamp}.3`), null)
    assert.ok(!JSON.stringify(await listCandidates()).includes("sk-live-123"))
  } finally {
    delete PACKS.fakeweb
    rmSync(file, { force: true })
  }
})

test("one rule: a finding is proven when its proof passed and shows harm, for every kind", () => {
  const [h, e, hFail] = withProven([http, evidence, { ...http, proof: { ...http.proof, status: "fail" } }])
  assert.equal(h.pocProved, true)
  assert.equal(e.pocProved, true)
  assert.equal(hFail.pocProved, false)
  assert.equal(isProven(h), true)
  // N3: the evidence replay passed (the measurement repeated), but it shows no harm.
  assert.equal(isProven(e), false)
  // A finding that already has pocProved (Contracts) is returned as is, same object.
  const contracts = { ...forgeOld, pocProved: false }
  const [c] = withProven([contracts])
  assert.equal(c, contracts)
  assert.equal(c.pocProved, false)
  assert.deepEqual(withProven(undefined), [])
  // N3: an old record with a passing evidence proof is not proven, whatever pocProved says.
  assert.equal(isProven({ ...evidence, pocProved: false }), false)
  assert.equal(isProven({ ...evidence, pocProved: true }), false)
})
