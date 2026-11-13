import { describe, expect, test } from "bun:test"
import { moduleAside, moduleNote, proofKind } from "../src/lib/catalog"
import type { PackChoice } from "../src/lib/types"

// The Modules page copy, built from the real pack list the loader sends
// (GET /api/models). A pack that changes its reach fields changes its copy here.
// @ts-expect-error — plain .mjs module, no types
const { packList } = await import("../../spike/packs/index.mjs")
const packs = new Map((packList() as PackChoice[]).map((p) => [p.id, p]))

const NOTE: Record<string, string | null> = {
  "contracts": "On the host, it can fetch the GitHub links the scope lists. It can also download the Solidity compilers those files pin. Its other tools work offline.",
  "review": "On the host, it can fetch the GitHub links the scope lists. Its other tools work offline.",
  "supply-chain": "A live run reads a GitHub repo or org you've granted, through the read-only GitHub API.",
  "domains": "It can reach a host you've granted. Its scanners run on an open network.",
  "surface": "It can reach a host you've granted. Its scanners run on an open network.",
  "phishing": "It can reach a host you've granted. Its scanners run on an open network.",
  "web": "It can reach a host you've granted. Its scanners run on an open network.",
  "ai-mcp": "It can reach a host you've granted. Its scanners run on an open network. Its lab target is a rule-based stand-in.",
  "keys": "It runs only in our own offline sandbox.",
  "chain-watch": "It runs only in our own offline sandbox.",
  "infra-cloud": "It runs only in our own offline sandbox. One check also gets an HTTP replay against a private practice cloud.",
}

describe("Modules page copy for each real pack", () => {
  test("every pack has a pinned note", () => {
    expect([...packs.keys()].sort()).toEqual(Object.keys(NOTE).sort())
  })

  for (const [id, note] of Object.entries(NOTE)) {
    test(id, () => expect(moduleNote(packs.get(id)!)).toBe(note))
  }

  test("only packs with no fetch, no live reach and no open scanners claim the offline sandbox", () => {
    for (const p of packs.values()) {
      const claims = moduleNote(p)?.includes("offline sandbox") === true
      expect(claims).toBe(!p.live && !p.fetches && !p.scanNet && p.offline === true)
    }
  })

  test("Surface and Code review say no finding can be proven", () => {
    for (const id of ["surface", "review"]) expect(proofKind(packs.get(id)!).label).toBe("No proof")
    expect(moduleAside(packs.get("surface")!)).toBe("Can reach a granted host · Open-network scanners")
  })
})
