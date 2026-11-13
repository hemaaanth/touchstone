import "./helpers/isolated-env"
import { describe, expect, test } from "bun:test"
import { PROOF_KIND } from "../src/lib/catalog"
import type { PackChoice } from "../src/lib/types"

// The Modules page says what each module tests, in one sentence: the pack's
// own description, which the loader sends (spike/packs/index.mjs packList).
// @ts-expect-error — plain .mjs module, no types
const { packList } = await import("../../spike/packs/index.mjs")
const packs = packList() as PackChoice[]

describe("what each module tests", () => {
  test("every pack the loader lists has a description", () => {
    for (const p of packs) expect(p.description, p.id).toBeString()
  })

  test("each is one plain sentence and makes no proof claim", () => {
    const proofWords = Object.values(PROOF_KIND).map((k) => k.label.toLowerCase())
    for (const p of packs) {
      expect(p.description, p.id).toMatch(/^[A-Z][^.]*\.$/)
      for (const w of ["proof", "proven", "prove", "replay", ...proofWords]) expect(p.description!.toLowerCase(), p.id).not.toContain(w)
    }
  })

  test("the joined pack is not a module: it is not listed", () => {
    expect(packs.map((p) => p.id)).not.toContain("multi")
  })
})
