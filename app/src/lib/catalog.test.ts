// Module copy is derived from pack fields. A blanket sentence must not outrun them.
// Runs with `bun test`.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { moduleAside, moduleNote, planStepState, proofKind } from "./catalog"
import type { PackChoice } from "./types"

const pack = (over: Partial<PackChoice> & Pick<PackChoice, "id" | "proof">): PackChoice => ({
  title: over.id,
  tier: "P",
  ...over,
})

const SANDBOX = "Passive: it runs only in our own offline sandbox."
const REACH = "It can reach a host you've granted."
const STAND_IN = "Its lab target is a rule-based stand-in."

describe("module copy follows the pack", () => {
  test("an offline passive pack keeps the sandbox sentence", () => {
    const contracts = pack({ id: "contracts", proof: "forge" })
    assert.equal(moduleNote(contracts), SANDBOX)
    assert.equal(moduleAside(contracts), "Passive")
    assert.equal(proofKind(contracts).detail, "A finding is real only when its Foundry test replays green in the offline sandbox.")
  })

  test("a live pack says it can reach a granted host, and does not claim the sandbox", () => {
    for (const id of ["web", "domains", "surface", "supply-chain"]) {
      const live = pack({ id, proof: id === "web" ? "http" : "evidence", live: true })
      assert.equal(moduleNote(live), REACH)
      assert.equal(moduleAside(live), "Can reach a granted host")
      assert.equal(moduleNote(live)?.includes("offline sandbox"), false)
    }
  })

  test("AI/MCP says its lab target is a rule-based stand-in", () => {
    const ai = pack({ id: "ai-mcp", proof: "http", live: true, labTarget: "rule-based" })
    assert.equal(moduleNote(ai), `${REACH} ${STAND_IN}`)
    assert.equal(moduleAside(ai), "Can reach a granted host · Rule-based lab")
  })

  test("a rule-based lab on an offline pack still says so, and keeps the sandbox sentence", () => {
    const offline = pack({ id: "lab", proof: "http", labTarget: "rule-based" })
    assert.equal(moduleNote(offline), `${SANDBOX} ${STAND_IN}`)
    assert.equal(moduleAside(offline), "Passive · Rule-based lab")
  })

  test("an unknown lab target adds no sentence", () => {
    const live = pack({ id: "web", proof: "http", live: true, labTarget: "model" })
    assert.equal(moduleNote(live), REACH)
    assert.equal(moduleAside(live), "Can reach a granted host")
  })

  test("a pack that is not passive and not live has no sandbox sentence", () => {
    const other = pack({ id: "x", proof: "none", tier: "A" })
    assert.equal(moduleNote(other), null)
    assert.equal(moduleAside(other), "A")
  })

  test("HTTP proof names a granted host only when the pack is live", () => {
    const offline = "The replay runs the request script against the practice service. An oracle checks the harm in the responses."
    const live = "The replay runs the request script against a host you've granted, or the practice service. An oracle checks the harm in the responses."
    assert.equal(proofKind(pack({ id: "web", proof: "http" })).detail, offline)
    assert.equal(proofKind(pack({ id: "web", proof: "http", live: true })).detail, live)
    assert.equal(proofKind(pack({ id: "web", proof: "http", live: true })).label, "HTTP replay")
  })

  test("evidence and no-proof details do not change because a pack is live", () => {
    const evidence = pack({ id: "domains", proof: "evidence", live: true })
    assert.equal(proofKind(evidence).detail, "The replay checks the cited evidence again against the pinned snapshot.")
    const review = pack({ id: "review", proof: "none" })
    assert.equal(proofKind(review).detail, "No replay oracle fits this code. The run reports leads. No finding can be proven.")
    assert.equal(moduleNote(review), SANDBOX)
  })

  test("an unknown proof kind is named, not invented", () => {
    assert.deepEqual(proofKind(pack({ id: "x", proof: "ritual" })), {
      label: "ritual",
      detail: "This pack names a proof kind the console does not know yet.",
    })
  })
})

describe("pipeline step words", () => {
  test("a step is on or off, including one the run could not toggle", () => {
    assert.equal(planStepState({ on: true }), "on")
    assert.equal(planStepState({ on: false }), "off")
  })
})
