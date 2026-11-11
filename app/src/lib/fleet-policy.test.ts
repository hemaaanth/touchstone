// Proof-gate + quarantine policy tests — the core claim encoded as assertions.
// Runs under the app's test runner (vitest, to be wired; the app uses vite and
// extensionless imports, so native `node --test` can't resolve them directly).
// These assertions were verified green (13/13) by compiling the three lib files
// to ESM and running them with node — see the fleet track's validation log.
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Lead } from "./fleet"
import { leadStatus } from "./fleet"
import {
  laneForTier,
  validateLeadPost,
  applyOracleVerdict,
  isOracleVerdict,
  corroborate,
  markVerifying,
  earnsSuccessSignal,
  fromBulletinClaim,
  toBulletinPost,
} from "./fleet-policy"

const base = (over: Partial<Lead> = {}): Lead => ({
  id: "L1",
  lane: "evidence",
  author: "h7",
  tier: 2,
  module: "web",
  toolkit: ["x"],
  claim: "reentrancy in withdraw",
  mechanism: "external call before state update",
  evidenceRef: null,
  severity: "high",
  status: "proposed",
  transitions: [],
  replyTo: null,
  reactions: [],
  ...over,
})

// --- quarantine ---
test("Tier-2 is forced to the evidence lane; Tier-1 to the trusted lane", () => {
  assert.equal(laneForTier(2), "evidence")
  assert.equal(laneForTier(1), "bulletin")
  assert.equal(laneForTier(0), "bulletin")
})

test("a valid Tier-2 proposed evidence post passes", () => {
  const v = validateLeadPost(base(), 2)
  assert.ok(v.ok, v.errors.join("; "))
  assert.equal(v.lane, "evidence")
})

test("Tier-2 cannot claim the trusted bulletin lane", () => {
  assert.ok(!validateLeadPost(base({ lane: "bulletin" }), 2).ok)
})

test("a post cannot self-declare an adjudicated status", () => {
  const v = validateLeadPost(
    base({
      tier: 1,
      lane: "bulletin",
      status: "proven",
      transitions: [{ status: "proven", at: 1, by: "h7" }],
    }),
    1,
  )
  assert.ok(!v.ok)
})

test("a post cannot spoof a higher tier than the registry", () => {
  assert.ok(!validateLeadPost(base({ tier: 1, lane: "bulletin" }), 2).ok)
})

// --- the proof gate: the core claim ---
test("corroboration NEVER reaches proven", () => {
  const l = corroborate(base({ tier: 1, lane: "bulletin", author: "a1" }), "a2", 1, 10)
  assert.equal(leadStatus(l), "corroborated")
  assert.ok(!earnsSuccessSignal(l))
})

test("Tier-2 cannot corroborate (untrusted gives no social credit)", () => {
  const l = base({ author: "a1" })
  assert.equal(corroborate(l, "w2", 2, 10), l)
})

test("an oracle proof graduates to proven and out of quarantine", () => {
  let l = markVerifying(base(), "coord", 5)
  assert.equal(leadStatus(l), "verifying")
  l = applyOracleVerdict(l, { proven: true, evidenceRef: "replay#42", at: 9, reason: null })
  assert.equal(leadStatus(l), "proven")
  assert.equal(l.lane, "bulletin") // graduated out of the evidence lane
  assert.equal(l.evidenceRef, "replay#42")
  assert.equal(l.transitions.at(-1)!.by, null) // harness/oracle, never an agent
  assert.ok(earnsSuccessSignal(l))
})

test("an unproven verdict dismisses and KEEPS the lead quarantined", () => {
  const l = applyOracleVerdict(base(), { proven: false, evidenceRef: null, at: 9, reason: "no harm" })
  assert.equal(leadStatus(l), "dismissed")
  assert.equal(l.lane, "evidence") // still quarantined
  assert.ok(!earnsSuccessSignal(l))
})

test("the gate is idempotent on a terminal lead", () => {
  const proven = applyOracleVerdict(base(), { proven: true, evidenceRef: "r", at: 1, reason: null })
  assert.equal(
    applyOracleVerdict(proven, { proven: false, evidenceRef: null, at: 2, reason: "x" }),
    proven,
  )
})

// --- the proof gate is strict: only a real boolean `true` promotes ---
test("a truthy-but-non-true verdict NEVER reaches proven", () => {
  for (const bad of ["false", "true", 1, {}, [], "yes"] as unknown[]) {
    const l = applyOracleVerdict(base(), {
      // deliberately wrong-typed proven, as malformed cross-process JSON would be
      proven: bad as unknown as boolean,
      evidenceRef: "replay#1",
      at: 1,
      reason: null,
    })
    assert.equal(leadStatus(l), "dismissed", `truthy ${JSON.stringify(bad)} must not prove`)
    assert.ok(!earnsSuccessSignal(l))
  }
})

test("isOracleVerdict fails closed on malformed / hostile payloads", () => {
  assert.ok(isOracleVerdict({ proven: true, evidenceRef: "r", at: 1, reason: null }))
  assert.ok(isOracleVerdict({ proven: false, evidenceRef: null, at: 1, reason: "no harm" }))
  assert.ok(!isOracleVerdict({ proven: "false", evidenceRef: "r", at: 1, reason: null }))
  assert.ok(!isOracleVerdict({ proven: true, evidenceRef: null, at: 1, reason: null })) // proof w/o evidence
  assert.ok(!isOracleVerdict({ proven: true, evidenceRef: "", at: 1, reason: null }))
  assert.ok(!isOracleVerdict({ proven: true, at: 1, reason: null })) // missing evidenceRef
  assert.ok(!isOracleVerdict({ proven: true, evidenceRef: "r", at: "1", reason: null }))
  assert.ok(!isOracleVerdict(null))
  assert.ok(!isOracleVerdict("proven"))
})

// --- board round-trip ---
test("a Lead round-trips through a bulletin claim payload", () => {
  const l = base({ tier: 1, lane: "bulletin" })
  assert.deepEqual(fromBulletinClaim(toBulletinPost("run:R:bulletin", l).claim), l)
})

test("a non-JSON board post is ignored, not trusted", () => {
  assert.equal(fromBulletinClaim("hello from another tool"), null)
})
