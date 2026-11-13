import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ModuleDots } from "../src/components/module-dots"

// A run's modules as up to three overlapping dots in a fixed box, every
// module named in the label (and the reveal), in the server's module order.
const packs = [
  { id: "contracts", title: "Contracts" },
  { id: "supply-chain", title: "Supply chain and Secrets" },
  { id: "domains", title: "Domains and front end" },
  { id: "surface", title: "Surface" },
  { id: "keys", title: "Keys and signing" },
  { id: "web", title: "Web and sign-in" },
  { id: "review", title: "Code review" },
]
const html = (ids: string[]) => renderToStaticMarkup(<ModuleDots ids={ids} packs={packs} />)
const dots = (h: string) => [...h.matchAll(/data-slot="module-dot" data-module="([^"]+)"/g)].map((m) => m[1])
const label = (h: string) => /aria-label="([^"]*)"/.exec(h)?.[1] ?? null
const width = (h: string) => /^<span[^>]*style="[^"]*width:(\d+)px/.exec(h)?.[1]

describe("ModuleDots", () => {
  test("0 modules: an empty box of the same width, nothing to focus", () => {
    const h = html([])
    expect(dots(h)).toEqual([])
    expect(h).not.toContain("tabindex")
    expect(width(h)).toBe(width(html(["web"])))
  })
  test("1 module: one dot, the module named", () => {
    const h = html(["web"])
    expect(dots(h)).toEqual(["web"])
    expect(label(h)).toBe("Module: Web and sign-in")
    expect(h).toContain('tabindex="0"')
  })
  test("3 modules: three dots, in the server's order", () => {
    const h = html(["web", "contracts", "domains"])
    expect(dots(h)).toEqual(["contracts", "domains", "web"])
    expect(label(h)).toBe("Modules: Contracts, Domains and front end, Web and sign-in")
  })
  test("4 and 7 modules: three dots, every module in the label; the box keeps its width", () => {
    const four = html(["web", "contracts", "domains", "surface"])
    expect(dots(four)).toEqual(["contracts", "domains", "surface"])
    expect(label(four)).toBe("Modules: Contracts, Domains and front end, Surface, Web and sign-in")
    const seven = html(packs.map((p) => p.id).reverse())
    expect(dots(seven)).toEqual(["contracts", "supply-chain", "domains"])
    expect(label(seven)?.split(", ").length).toBe(7)
    expect(width(seven)).toBe(width(html(["web"])))
  })
  test("a module the list does not know keeps its id and goes last; duplicates show once", () => {
    const h = html(["new-pack", "web", "web"])
    expect(dots(h)).toEqual(["web", "new-pack"])
    expect(label(h)).toBe("Modules: Web and sign-in, new-pack")
  })
})
