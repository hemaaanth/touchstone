import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { motionValue } from "motion/react"
import { ModuleDots, ModuleDotsPillBody, type Module, type OpenLayout } from "../src/components/module-dots"
import { DOT, EDGE, MIN_OPEN_W, PAD, STEP, pillLeft, pillMaxWidth, restWidth } from "../src/lib/module-dots-layout"

// A run's modules as one mark: a dot for every module at rest, in the server's
// module order; open, the same dots with their names, once each.
const packs = [
  { id: "contracts", title: "Contracts" },
  { id: "supply-chain", title: "Supply chain and Secrets" },
  { id: "domains", title: "Domains and front end" },
  { id: "surface", title: "Surface" },
  { id: "keys", title: "Keys and signing" },
  { id: "chain-watch", title: "Chain watch" },
  { id: "web", title: "Web and sign-in" },
  { id: "infra-cloud", title: "Infra and cloud" },
  { id: "ai-mcp", title: "AI and MCP" },
  { id: "review", title: "Code review" },
  { id: "phishing", title: "Phishing and brand lookalikes" },
]
const html = (ids: string[]) => renderToStaticMarkup(<ModuleDots ids={ids} packs={packs} />)
const dots = (h: string) => [...h.matchAll(/data-slot="module-dot" data-module="([^"]+)"/g)].map((m) => m[1])
const label = (h: string) => /aria-label="([^"]*)"/.exec(h)?.[1] ?? null
const width = (h: string) => Number(/^<span[^>]*style="[^"]*width:(\d+)px/.exec(h)?.[1])

describe("ModuleDots at rest", () => {
  test("every module has a dot: no cap, no grey 'more' dot", () => {
    for (const n of [1, 2, 4, 11]) {
      const ids = packs.slice(0, n).map((p) => p.id)
      const h = html([...ids].reverse())
      expect(dots(h)).toEqual(ids)
      expect(h).not.toContain("module-dots-more")
      expect(h).not.toContain("bg-muted-foreground")
    }
  })
  test("the mark is as wide as its dots need", () => {
    expect([1, 2, 4, 11].map((n) => width(html(packs.slice(0, n).map((p) => p.id))))).toEqual([16, 21, 31, 66])
    expect(restWidth(11)).toBe(2 * PAD + DOT + 10 * STEP)
  })
  test("the label names every module, in order", () => {
    expect(label(html(["web"]))).toBe("Module: Web and sign-in")
    expect(label(html(["phishing", "surface", "domains", "web"]))).toBe(
      "Modules: Domains and front end, Surface, Web and sign-in, Phishing and brand lookalikes",
    )
    expect(label(html(packs.map((p) => p.id)))?.split(", ").length).toBe(11)
    expect(html(["web"])).toContain('role="img"')
    expect(html(["web"])).toContain('tabindex="0"')
  })
  test("an empty list keeps the place of one dot, with nothing to focus", () => {
    const h = html([])
    expect(dots(h)).toEqual([])
    expect(h).not.toContain("tabindex")
    expect(width(h)).toBe(width(html(["web"])))
  })
  test("a module the list does not know keeps its id and goes last; duplicates show once", () => {
    const h = html(["new-pack", "web", "web"])
    expect(dots(h)).toEqual(["web", "new-pack"])
    expect(label(h)).toBe("Modules: Web and sign-in, new-pack")
  })
  test("no tooltip: the mark itself is the reveal", () => {
    expect(html(["web", "domains"])).not.toContain("tooltip")
  })
})

describe("ModuleDots open", () => {
  const four: Module[] = ["domains", "surface", "web", "phishing"].map((id) => packs.find((p) => p.id === id)!)
  const layout: OpenLayout = { w: 400, h: 20, dots: four.map((_, i) => ({ x: 8 + i * 90, y: 6, nameW: 70 })) }
  const body = (p: number) => renderToStaticMarkup(<ModuleDotsPillBody modules={four} layout={layout} p={motionValue(p)} ring="red" />)

  test("each dot once and each name once, as real text", () => {
    const h = body(1)
    expect(dots(h)).toEqual(["domains", "surface", "web", "phishing"])
    for (const m of four) expect(h.split(`>${m.title}<`).length - 1).toBe(1)
    expect([...h.matchAll(/data-slot="module-dots-name"/g)].length).toBe(4)
    // The names are read, not hidden.
    expect(/data-slot="module-dots-name"[^>]*aria-hidden/.test(h)).toBe(false)
  })
  test("progress 0 is the stack at rest; 1 is each dot at its place", () => {
    const xs = (h: string) => [...h.matchAll(/data-slot="module-dot"[^>]*transform:\s*translateX\(([\d.]+)px\)/g)].map((m) => Number(m[1]))
    expect(xs(body(0))).toEqual([4, 9, 14, 19])
    expect(xs(body(1))).toEqual([8, 98, 188, 278])
  })
})

describe("where the open pill goes", () => {
  test("it keeps the mark's left edge and grows right when there is room", () => {
    expect(pillMaxWidth(180, 1440)).toBe(1440 - EDGE - 180)
    expect(pillLeft(180, 600, 1440)).toBe(180)
  })
  test("too little room to the right: it may be MIN_OPEN_W wide and moves left only enough to fit", () => {
    expect(pillMaxWidth(330, 412)).toBe(MIN_OPEN_W)
    expect(pillLeft(330, 150, 412)).toBe(412 - EDGE - 150)
    expect(pillLeft(330, 60, 412)).toBe(330)
  })
})
