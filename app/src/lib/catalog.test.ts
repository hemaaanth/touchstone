// Module copy is derived from pack fields. A blanket sentence must not outrun them.
// tests/module-copy.test.ts checks the same functions against the real pack list.
// Runs with `bun test`.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { moduleAside, moduleNote, planStepState, proofKind, REACH_SENTENCE as S, scopeMeta, siteEntry } from "./catalog"
import type { PackChoice, TargetScope } from "./types"

const pack = (over: Partial<PackChoice> & Pick<PackChoice, "id" | "proof">): PackChoice => ({
  title: over.id,
  tier: "P",
  ...over,
})

describe("module copy follows the pack", () => {
  test("an offline pack says it runs only in the offline sandbox", () => {
    const keys = pack({ id: "keys", proof: "forge", offline: true })
    assert.equal(moduleNote(keys), "It runs only in our own offline sandbox.")
    assert.equal(moduleAside(keys), "Passive · Offline")
    assert.equal(proofKind(keys).detail, "A finding is real only when its Foundry test replays green in the offline sandbox.")
  })

  test("a passive pack that does not say offline gets no sandbox sentence", () => {
    const quiet = pack({ id: "x", proof: "forge" })
    assert.equal(moduleNote(quiet), null)
    assert.equal(moduleAside(quiet), "Passive")
  })

  test("a pack that fetches GitHub links says so, and does not claim the sandbox", () => {
    const review = pack({ id: "review", proof: "none", fetches: ["github"] })
    assert.equal(moduleNote(review), "On the host, it can fetch the GitHub links the scope lists. Its other tools work offline.")
    assert.equal(moduleAside(review), "Passive · Fetches GitHub links")
    assert.equal(moduleNote(review)?.includes(S.offline), false)
  })

  test("Contracts also downloads the compilers its fetched files pin", () => {
    const contracts = pack({ id: "contracts", proof: "forge", fetches: ["github", "solc"] })
    assert.equal(
      moduleNote(contracts),
      "On the host, it can fetch the GitHub links the scope lists. It can also download the Solidity compilers those files pin. Its other tools work offline.",
    )
    assert.equal(moduleAside(contracts), "Passive · Fetches GitHub links")
  })

  test("a live pack says it can reach a granted host, and does not claim the sandbox", () => {
    const live = pack({ id: "x", proof: "evidence", live: true })
    assert.equal(moduleNote(live), S.host)
    assert.equal(moduleAside(live), "Can reach a granted host")
  })

  test("a live pack with open-network scanners says so", () => {
    for (const id of ["web", "domains"]) {
      const live = pack({ id, proof: id === "web" ? "http" : "evidence", live: true, scanNet: "open" })
      assert.equal(moduleNote(live), "It can reach a host you've granted. Its scanners run on an open network.")
      assert.equal(moduleAside(live), "Can reach a granted host · Open-network scanners")
    }
  })

  test("a live pack whose grant is a GitHub repo says it reads that repo, not a host", () => {
    const supply = pack({ id: "supply-chain", proof: "evidence", live: true, grants: "github" })
    assert.equal(moduleNote(supply), "A live run reads a GitHub repo or org you've granted, through the read-only GitHub API.")
    assert.equal(moduleAside(supply), "Can read a granted GitHub repo")
  })

  test("a pack with a cloud HTTP replay says one check gets it", () => {
    const infra = pack({ id: "infra-cloud", proof: "evidence", offline: true, extraProof: "cloud-http" })
    assert.equal(moduleNote(infra), "It runs only in our own offline sandbox. One check also gets an HTTP replay against a private practice cloud.")
  })

  test("AI/MCP says its lab target is a rule-based stand-in", () => {
    const ai = pack({ id: "ai-mcp", proof: "http", live: true, scanNet: "open", labTarget: "rule-based" })
    assert.equal(moduleNote(ai), `${S.host} ${S.scanNet} ${S.standIn}`)
    assert.equal(moduleAside(ai), "Can reach a granted host · Open-network scanners · Rule-based lab")
  })

  test("an unknown field value adds no sentence", () => {
    const live = pack({ id: "web", proof: "http", live: true, labTarget: "model", scanNet: "closed", grants: "dns", extraProof: "x", fetches: ["ftp"] })
    assert.equal(moduleNote(live), S.host)
    assert.equal(moduleAside(live), "Can reach a granted host")
  })

  test("a pack that is not passive and sets no reach field has no reach sentence", () => {
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
    const none = "This module has no replay oracle. The run reports leads. No finding can be proven."
    assert.deepEqual(proofKind(pack({ id: "surface", proof: "none", live: true })), { label: "No proof", detail: none })
    assert.equal(proofKind(pack({ id: "review", proof: "none" })).detail, none)
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

test("a *.example.com entry shows as written, with all subdomains, never as an https URL", () => {
  assert.deepEqual(siteEntry("https://*.example.com"), { text: "*.example.com", wildcard: true })
  assert.deepEqual(siteEntry("https://example.com:8443"), { text: "https://example.com:8443", wildcard: false })
  const t = { id: "live-x", title: "x", kind: "live", blurb: "", entry: "example.com", signal: "agent", proofSurface: { kind: "live", note: "" }, origins: ["https://example.com", "https://*.example.com"] } as TargetScope
  assert.equal(scopeMeta(t), "https://example.com, *.example.com · all subdomains")
})
