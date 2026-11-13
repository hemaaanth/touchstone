import { describe, expect, test } from "bun:test"
import { MODULE_TESTS, moduleTests, PROOF_KIND } from "../src/lib/catalog"
import type { PackChoice } from "../src/lib/types"

// The Modules page says what each module tests, in one sentence from
// MODULE_TESTS. The loader (GET /api/models) does not send that sentence, so
// this pins the map to the real pack list.
// @ts-expect-error — plain .mjs module, no types
const { packList } = await import("../../spike/packs/index.mjs")
const ids = (packList() as PackChoice[]).map((p) => p.id)

describe("what each module tests", () => {
  test("every pack the loader lists has a sentence", () => {
    for (const id of ids) expect(moduleTests(id), id).toBeString()
  })

  test("no sentence names a pack the loader does not list", () => {
    expect(Object.keys(MODULE_TESTS).sort()).toEqual([...ids].sort())
  })

  test("each is one plain sentence and makes no proof claim", () => {
    const proofWords = Object.values(PROOF_KIND).map((k) => k.label.toLowerCase())
    for (const [id, s] of Object.entries(MODULE_TESTS)) {
      expect(s, id).toMatch(/^[A-Z][^.]*\.$/)
      for (const w of ["proof", "proven", "prove", "replay", ...proofWords]) expect(s.toLowerCase(), id).not.toContain(w)
    }
  })
})
