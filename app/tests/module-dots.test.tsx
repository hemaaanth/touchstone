import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { motionValue } from "motion/react"
import { ModuleDots, ModuleDotsPillBody, ModuleDotsStack, type Module } from "../src/components/module-dots"
import {
  DOT,
  EDGE,
  ITEM_GAP_X,
  MAX_OPEN_W,
  MIN_OPEN_W,
  NAME_GAP,
  OPEN_PAD_X,
  PAD,
  STEP,
  openLayout,
  pillLeft,
  pillMaxWidth,
  restWidth,
} from "../src/lib/module-dots-layout"
import { SCROLL_QUIET, dropOnOwnScroll, mayHoverOpen, noteScroll, routePillWheel, swallowTapClick } from "../src/lib/module-dots-rules"

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

// Each module title's width at 12 px, as the browser measured it (px).
const NAME_W: Record<string, number> = {
  contracts: 55, "supply-chain": 137, domains: 118, surface: 44, keys: 94, "chain-watch": 66,
  web: 84, "infra-cloud": 86, "ai-mcp": 62, review: 68, phishing: 165,
}
const mods = (ids: string[]): Module[] => ids.map((id) => packs.find((p) => p.id === id)!)
const layoutOf = (ms: Module[], max = 1200) => openLayout(ms.map((m) => NAME_W[m.id]), pillMaxWidth(1440 - EDGE - max, 1440))

describe("the row and the pill", () => {
  test("the row's stack is empty while the pill is out, so no dot is drawn twice", () => {
    const four = mods(["domains", "surface", "web", "phishing"])
    const out = renderToStaticMarkup(<ModuleDotsStack modules={four} hidden />)
    const rest = renderToStaticMarkup(<ModuleDotsStack modules={four} hidden={false} />)
    expect(dots(out)).toEqual(["domains", "surface", "web", "phishing"])
    expect(out.match(/opacity:0/g)?.length).toBe(4)
    expect(rest).not.toContain("opacity")
  })
  test("the Findings page can take the mark out of the tab order; it still names its module", () => {
    const h = renderToStaticMarkup(<ModuleDots ids={["web"]} packs={packs} tabStop={false} />)
    expect(h).toContain('tabindex="-1"')
    expect(h).toContain('role="img"')
    expect(label(h)).toBe("Module: Web and sign-in")
  })
})

describe("ModuleDots open", () => {
  const four = mods(["domains", "surface", "web", "phishing"])
  const layout = layoutOf(four)
  const body = (p: number) => renderToStaticMarkup(<ModuleDotsPillBody modules={four} layout={layout} p={motionValue(p)} ring="red" />)
  // Each dot's x, and each name's x and width, from the drawn styles.
  const parts = (h: string) => ({
    dots: [...h.matchAll(/data-slot="module-dot"[^>]*transform:\s*translateX\(([\d.]+)px\)/g)].map((m) => Number(m[1])),
    names: [...h.matchAll(/data-slot="module-dots-name"[^>]*style="([^"]*)"/g)].map((m) => ({
      x: Number(/translateX\(([\d.]+)px\)/.exec(m[1])?.[1]),
      w: Number(/width:\s*([\d.]+)px/.exec(m[1])?.[1]),
    })),
  })

  test("each dot once and each name once, as real text", () => {
    const h = body(1)
    expect(dots(h)).toEqual(["domains", "surface", "web", "phishing"])
    for (const m of four) expect(h.split(`>${m.title}<`).length - 1).toBe(1)
    expect([...h.matchAll(/data-slot="module-dots-name"/g)].length).toBe(4)
    // The names are read, not hidden.
    expect(/data-slot="module-dots-name"[^>]*aria-hidden/.test(h)).toBe(false)
  })
  test("progress 0 is the stack at rest; 1 is each dot at its place", () => {
    expect(parts(body(0)).dots).toEqual([4, 9, 14, 19])
    expect(parts(body(1)).dots).toEqual(layout.dots.map((d) => d.x))
  })
  test("in the middle of the movement no name reaches the next dot", () => {
    for (const p of [0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const { dots: xs, names } = parts(body(p))
      // A folded name (width 0) draws nothing; a shown one ends before the next dot.
      names.slice(0, -1).forEach((n, i) => n.w > 0 && expect(n.x + n.w).toBeLessThanOrEqual(xs[i + 1] - ITEM_GAP_X + 0.5))
      // Mid-movement, at least one name is partly shown (the test is not empty).
      if (p >= 0.5 && p < 0.95) expect(names.some((n, i) => n.w > 0 && n.w < NAME_W[four[i].id])).toBe(true)
    }
    // Open, every name has its full width.
    parts(body(1)).names.forEach((n, i) => expect(n.w).toBeGreaterThanOrEqual(NAME_W[four[i].id]))
  })
})

describe("the open pill's lines", () => {
  test("four modules: one line, under the largest width", () => {
    const l = layoutOf(mods(["domains", "surface", "web", "phishing"]))
    expect(l.h).toBe(20)
    expect(l.w).toBeLessThanOrEqual(MAX_OPEN_W)
    expect(new Set(l.dots.map((d) => d.y)).size).toBe(1)
  })
  test("six and eleven modules: the fewest lines under the largest width, balanced", () => {
    for (const ids of [packs.slice(0, 6).map((p) => p.id), packs.map((p) => p.id)]) {
      const l = layoutOf(mods(ids))
      expect(l.w).toBeLessThanOrEqual(MAX_OPEN_W)
      const rows = [...new Set(l.dots.map((d) => d.y))].map((y) => l.dots.filter((d) => d.y === y))
      expect(rows.length).toBeGreaterThan(1)
      // No line holds a single name while another holds three or more.
      const counts = rows.map((r) => r.length)
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
      // Each line's right edge stays within the pill.
      for (const r of rows) {
        const last = r[r.length - 1]
        expect(last.x + DOT + NAME_GAP + last.nameW).toBeLessThanOrEqual(l.w - OPEN_PAD_X + 0.5)
      }
    }
  })
  test("a name too long for the pill is cut, with the cut marked", () => {
    const l = openLayout([1000], 200)
    expect(l.dots[0].cut).toBe(true)
    expect(l.w).toBe(200)
  })
})

describe("what closes it, and when hover may open it", () => {
  const ev = (type: string) => new Event(type, { cancelable: true })
  test("wheel over the visible pill beyond the list routes to that list, but outside or over the list stays native", () => {
    const pill = { left: 206, right: 729, top: 64, bottom: 84 } as DOMRect
    const inList = new EventTarget()
    const inChat = new EventTarget()
    const moves: ScrollToOptions[] = []
    const list = {
      contains: (target: EventTarget) => target === inList,
      scrollBy: (delta: ScrollToOptions) => moves.push(delta),
      clientHeight: 196,
      clientWidth: 256,
    } as unknown as HTMLElement
    const wheel = (target: EventTarget, x: number, y: number, deltaY = 120, deltaMode = 0) => {
      const e = Object.assign(ev("wheel"), { clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode }) as WheelEvent
      target.dispatchEvent(e)
      return e
    }
    const acrossBoundary = wheel(inChat, 310, 76)
    expect(routePillWheel(acrossBoundary, pill, list)).toBe(true)
    expect(acrossBoundary.defaultPrevented).toBe(true)
    expect(moves).toEqual([{ left: 0, top: 120 }])
    const sidebarSegment = wheel(inList, 210, 76)
    expect(routePillWheel(sidebarSegment, pill, list)).toBe(false)
    expect(sidebarSegment.defaultPrevented).toBe(false)
    const outside = wheel(inChat, 310, 100)
    expect(routePillWheel(outside, pill, list)).toBe(false)
    expect(outside.defaultPrevented).toBe(false)
    expect(moves).toHaveLength(1)
    const page = wheel(inChat, 310, 76, -1, 2)
    expect(routePillWheel(page, pill, list)).toBe(true)
    expect(moves[1]).toEqual({ left: 0, top: -196 })
    const zoom = wheel(inChat, 310, 76)
    Object.assign(zoom, { ctrlKey: true })
    expect(routePillWheel(zoom, pill, list)).toBe(false)
    expect(zoom.defaultPrevented).toBe(false)
  })
  test("a scroll of another container (a live chat) does not drop the pill; its own list does", () => {
    const list = new EventTarget()
    const chat = new EventTarget()
    let dropped = 0
    const stop = dropOnOwnScroll([list, new EventTarget()], () => dropped++)
    chat.dispatchEvent(ev("scroll"))
    expect(dropped).toBe(0)
    list.dispatchEvent(ev("scroll"))
    expect(dropped).toBe(1)
    stop()
    list.dispatchEvent(ev("scroll"))
    expect(dropped).toBe(1)
  })
  test("hover opens nothing right after its own list scrolled, but a chat that scrolls does not block it", () => {
    const list = new EventTarget()
    const chat = new EventTarget()
    noteScroll(chat, 1000)
    expect(mayHoverOpen({ over: true, shut: false, containers: [list], now: 1010 })).toBe(true)
    noteScroll(list, 1000)
    expect(mayHoverOpen({ over: true, shut: false, containers: [list], now: 1000 + SCROLL_QUIET - 10 })).toBe(false)
    expect(mayHoverOpen({ over: true, shut: false, containers: [list], now: 1000 + SCROLL_QUIET + 10 })).toBe(true)
    expect(mayHoverOpen({ over: false, shut: false, containers: [], now: 0 })).toBe(false)
    expect(mayHoverOpen({ over: true, shut: true, containers: [], now: 0 })).toBe(false)
  })
  test("the tap that closes the pill does not reach what lies under the finger; the next one does", async () => {
    const page = new EventTarget()
    swallowTapClick(page)
    const first = ev("click")
    page.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    const second = ev("click")
    page.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    // A tap that became a scroll gesture leaves no trap behind.
    swallowTapClick(page)
    page.dispatchEvent(ev("pointercancel"))
    const third = ev("click")
    page.dispatchEvent(third)
    expect(third.defaultPrevented).toBe(false)
    // After the finger lifts, only the click of that tap is stopped.
    swallowTapClick(page)
    page.dispatchEvent(ev("pointerup"))
    await new Promise((r) => setTimeout(r, 5))
    const fourth = ev("click")
    page.dispatchEvent(fourth)
    expect(fourth.defaultPrevented).toBe(false)
  })
})

describe("where the open pill goes", () => {
  test("it keeps the mark's left edge and grows right when there is room", () => {
    expect(pillMaxWidth(180, 1440)).toBe(MAX_OPEN_W)
    expect(pillMaxWidth(1000, 1440)).toBe(1440 - EDGE - 1000)
    expect(pillLeft(180, 600, 1440)).toBe(180)
  })
  test("too little room to the right: it may be MIN_OPEN_W wide and moves left only enough to fit", () => {
    expect(pillMaxWidth(330, 412)).toBe(MIN_OPEN_W)
    expect(pillLeft(330, 150, 412)).toBe(412 - EDGE - 150)
    expect(pillLeft(330, 60, 412)).toBe(330)
  })
})
