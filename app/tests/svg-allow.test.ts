import { describe, expect, test } from "bun:test"
import { allowSvg } from "@/lib/svg-allow"
import { miniXml } from "./helpers/mini-xml"
import { namesOffList } from "./helpers/svg-check"
import { HOSTILE } from "./fixtures/svg-hostile"

// The allow-list pass on its own: hand-made SVG strings, no Pele.
describe("allowSvg: hand-made hostile SVG", () => {
  for (const c of HOSTILE) {
    test(c.name, () => {
      const out = allowSvg(c.svg, miniXml)
      if (c.out !== undefined) expect(out).toBe(c.out)
      if (out === null) return
      // Whatever came in, only names on the lists come out, and no tag holds
      // anything live.
      expect(namesOffList(out)).toEqual([])
      const tags = out.match(/<[^>]*>/g) ?? []
      for (const t of tags) {
        expect(t).not.toMatch(/\son[a-z]+\s*=|href|<(script|style|a|image|use|foreignObject|set|animate)\b/i)
        expect(t).not.toMatch(/url\((?!#)/i)
      }
    })
  }

  test("a parser that throws gives null", () => {
    expect(
      allowSvg("<svg/>", () => {
        throw new Error("boom")
      }),
    ).toBeNull()
  })

  test("without a DOMParser (bun), the default parser fails closed", () => {
    expect(allowSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)).toBeNull()
  })
})
