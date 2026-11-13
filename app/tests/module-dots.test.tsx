import { describe, expect, test } from "bun:test"
import { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ModuleDots } from "../src/components/module-dots"
import { TooltipContent, TooltipTrigger } from "../src/components/ui/tooltip"

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
const more = (h: string) => (h.match(/data-slot="module-dots-more"/g) ?? []).length
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
  test("more than three: one small grey dot says more, inside the same box", () => {
    for (const ids of [[], ["web"], ["web", "contracts", "domains"]]) expect(more(html(ids))).toBe(0)
    for (const n of [4, 7]) {
      const h = html(packs.slice(0, n).map((p) => p.id))
      expect(more(h)).toBe(1)
      expect(dots(h).length).toBe(3)
      expect(width(h)).toBe(width(html(["web"])))
      // Neutral, never a module's colour.
      expect(/data-slot="module-dots-more"[^>]*class="([^"]*)"/.exec(h)?.[1]).toContain("bg-muted-foreground")
    }
  })
})

// What ModuleDots hands its tooltip, read from the element it returns. A probe
// calls it during its own render (so its hooks run), and keeps the tree.
function tooltipProps(props: Parameters<typeof ModuleDots>[0]) {
  let tree: ReactNode = null
  const Probe = () => {
    tree = ModuleDots(props)
    return null
  }
  renderToStaticMarkup(<Probe />)
  const found: { trigger?: Record<string, unknown>; content?: Record<string, unknown> } = {}
  const walk = (n: ReactNode) => {
    if (!isValidElement(n)) return
    const el = n as ReactElement<Record<string, unknown> & { children?: ReactNode }>
    if (el.type === TooltipTrigger) found.trigger = el.props
    if (el.type === TooltipContent) found.content = el.props
    ;([] as ReactNode[]).concat(el.props.children ?? []).forEach(walk)
  }
  walk(tree)
  return found
}

describe("ModuleDots reveal", () => {
  test("hover opens the names in about 120 ms, not the app's 300", () => {
    expect(tooltipProps({ ids: ["web"] }).trigger?.delay).toBe(120)
  })
  test("the side is a prop: top by default, the sidebar's right past the rail", () => {
    expect(tooltipProps({ ids: ["web"] }).content?.side).toBe("top")
    const right = tooltipProps({ ids: ["web"], side: "right", sideOffset: 27 }).content
    expect(right?.side).toBe("right")
    expect(right?.sideOffset).toBe(27)
  })
})
