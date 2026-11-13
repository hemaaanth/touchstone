import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { SidebarProvider } from "../src/components/ui/sidebar"
import { RunHeader } from "../src/components/run-chat"
import { composerRoomRef, panelLayerClass } from "../src/lib/run-layout"

// N4: the run panel floats in the chat again, below the top bar, and the bar
// holds only the status mark, the title and the ⋯ menu (owner, 2026-11-13).
// The placement is the one of 68f772a. In the bar, 3708443 put the panel in
// the right corner over a spacer as wide as the panel; that spacer is gone.

describe("the top bar holds no room for the panel", () => {
  const bar = renderToStaticMarkup(
    <SidebarProvider>
      {/* panelWidth is what the old bar took to keep room for the panel; the bar now ignores it. */}
      <RunHeader
        {...({ panelWidth: 320 } as object)}
        state={null}
        status="running"
        title={<h1>Run title</h1>}
        narrow={false}
        control={null}
        actions={<button type="button">Run menu</button>}
      />
    </SidebarProvider>,
  )
  const header = bar.slice(bar.indexOf("<header"), bar.indexOf("</header>") + 9)

  test("no spacer: no element in the bar has a fixed inline width", () => {
    expect(header).not.toMatch(/style="[^"]*width/)
  })

  test("the bar holds the status mark, the title and the menu, and the menu ends it", () => {
    expect(header).toContain('aria-label="Status:')
    expect(header).toContain("Run title")
    expect(header.trimEnd().endsWith("Run menu</button></div></header>")).toBe(true)
  })
})

describe("the panel layer starts below the bar, inside the chat", () => {
  test("desktop: 12 px from the chat area's top and right edges, not inside the bar", () => {
    expect(panelLayerClass(false)).toMatch(/^top-3 right-3 /)
    expect(panelLayerClass(false)).not.toContain("top-[7px]")
  })

  test("phone: unchanged, below the bar across the width", () => {
    expect(panelLayerClass(true)).toBe("top-[54px] right-3 left-3 bottom-28")
  })

  test("desktop: the layer is placed in the chat area (below the bar), before the thread, so Tab goes bar, panel, chat", () => {
    const src = readFileSync(path.join(import.meta.dir, "../src/components/run-chat.tsx"), "utf8")
    const chat = src.indexOf('<div data-run-chat-area className="relative flex min-h-0 flex-1 flex-col">')
    const layer = src.indexOf("{narrow ? null : panelLayer}")
    const thread = src.indexOf("<div ref={mainRef}")
    expect(chat).toBeGreaterThan(-1)
    expect(layer).toBeGreaterThan(chat)
    expect(thread).toBeGreaterThan(layer)
    // Only one desktop layer, and the header no longer takes a panel width.
    expect(src.split("{narrow ? null : panelLayer}")).toHaveLength(2)
    expect(src).not.toMatch(/panelWidth=\{showPanel/)
  })
})

// m1 of the N4 review: a fixed bottom-28 let a tall open panel cover the
// composer's corner (2 px at rest, 138 px at 7 lines). The layer's bottom is
// now the composer's room, measured, plus 12 px.
describe("the open panel stops 12 px above the composer, also when the composer grows", () => {
  test("the composer's ref keeps --composer-room on the chat area; the desktop layer's bottom is that plus 12 px", () => {
    expect(panelLayerClass(false)).toContain("bottom-[calc(var(--composer-room,100px)+12px)]")
    expect(panelLayerClass(false)).not.toContain("bottom-28")
    // A chat area 800 px tall; the composer box's top moves up as it grows.
    const vars = new Map<string, string>()
    const area = { getBoundingClientRect: () => ({ bottom: 800 }), style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) } }
    let boxTop = 690
    const form = { getBoundingClientRect: () => ({ top: boxTop }) }
    const wrapper = { closest: () => area, querySelector: () => form }
    let onResize = () => {}
    let observing = false
    const Real = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) { onResize = cb }
      observe() { observing = true }
      disconnect() { observing = false }
      unobserve() {}
    } as unknown as typeof ResizeObserver
    try {
      const cleanup = composerRoomRef(wrapper as unknown as HTMLElement)
      expect(observing).toBe(true)
      expect(vars.get("--composer-room")).toBe("110px") // one line
      boxTop = 554 // seven lines: the box's top 136 px higher
      onResize()
      expect(vars.get("--composer-room")).toBe("246px")
      cleanup?.()
      expect(observing).toBe(false)
      expect(vars.has("--composer-room")).toBe(false) // a peek has no composer: the 112 px fallback
    } finally {
      globalThis.ResizeObserver = Real
    }
    // The composer's wrapper carries the ref, and the chat area the mark it looks for.
    const thread = readFileSync(path.join(import.meta.dir, "../src/components/run-thread.tsx"), "utf8")
    expect(thread).toMatch(/<div ref=\{composerRoomRef\} className="px-5 pt-2 pb-5/)
  })
})
