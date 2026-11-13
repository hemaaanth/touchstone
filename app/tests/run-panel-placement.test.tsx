import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { SidebarProvider } from "../src/components/ui/sidebar"
import { RunHeader } from "../src/components/run-chat"
import { panelLayerClass } from "../src/lib/run-layout"

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
    expect(panelLayerClass(false)).toBe("top-3 right-3")
    expect(panelLayerClass(false)).not.toContain("top-[7px]")
  })

  test("phone: unchanged, below the bar across the width", () => {
    expect(panelLayerClass(true)).toBe("top-[54px] right-3 left-3")
  })

  test("desktop: the layer is placed in the chat area (below the bar), before the thread, so Tab goes bar, panel, chat", () => {
    const src = readFileSync(path.join(import.meta.dir, "../src/components/run-chat.tsx"), "utf8")
    const chat = src.indexOf('<div className="relative flex min-h-0 flex-1 flex-col">')
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
