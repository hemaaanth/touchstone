import { Button, ThemedIcon } from "@graphical"
import { Muted, Scroll } from "@/components/app/blocks"
import { resolvePanel } from "@/components/app/panel"
import { closePanel, closePanelHref } from "@/lib/route"
import { useEffect } from "react"

/*
 * The right panel. About 440px. It opens from a link with ?panel=<view>, so a
 * panel is always a shareable URL, and it reflows the canvas beside it instead
 * of floating over it. Close keeps the route.
 */

export function PanelHost({ view }: { view: string }) {
  const panel = resolvePanel(view)
  // Escape closes the panel, like any overlay. Dialogs that handle Escape first win.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closePanel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const title = panel?.title ?? "Unknown panel"
  return (
    <aside
      aria-label={title}
      className="flex min-h-0 w-[440px] max-w-full shrink-0 flex-col bg-(--cte-surface) divide-left"
    >
      <header className="flex shrink-0 items-center gap-(--space-s) px-(--space-l) py-(--space-s) divide-bottom">
        <h2 className="min-w-0 flex-1 truncate type-m weight-medium">{title}</h2>
        <Button variant="ghost" aria-label="Close panel" nativeButton={false} render={<a href={closePanelHref()} />}>
          <ThemedIcon name="close" />
        </Button>
      </header>
      {/* key: a new view mounts a new scroll area, so it starts at the top. */}
      <Scroll key={view} className="bg-(--cte-surface)">
        <div className="flex flex-col gap-(--space-l) px-(--space-l) py-(--space-l)">
          {panel ? panel.body : <Muted>There is no panel called "{view}".</Muted>}
        </div>
      </Scroll>
    </aside>
  )
}
