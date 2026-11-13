import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { drawMermaid } from "@/lib/mermaid"
import { CopyButton } from "@/components/proof-parts"

// A fenced `mermaid` block in agent text, drawn as a diagram.
//
// - While the fence is open (the agent is still writing it), or while the
//   source does not parse, it shows `fallback`: the normal code block. Nothing
//   flashes and nothing jumps on each streamed tick.
// - When the closed source parses, the diagram replaces the code block.
// - When a newer snapshot fails, the last good diagram stays.
// - A closed source that never parsed stays a code block, with Pele's reason
//   under it as plain text.
// - "Diagram | Source" switches between the picture and its text; Copy copies
//   the source.
export function MermaidBlock({ source, closed, fallback }: { source: string; closed: boolean; fallback: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [font, setFont] = useState<{ sans: string; mono: string } | null>(null)
  const [good, setGood] = useState<{ source: string; svg: string; width: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<"diagram" | "source">("diagram")

  // The column width, in 16px steps so a small resize does not redraw.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setWidth(Math.floor(el.clientWidth / 16) * 16)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Pele measures labels, so it needs the app's fonts loaded first.
  useEffect(() => {
    let live = true
    const el = box.current
    if (!el) return
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (!live) return
      const css = getComputedStyle(el)
      setFont({ sans: css.fontFamily, mono: css.getPropertyValue("--font-mono").trim() || "monospace" })
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!closed || !width || !font) return
    let live = true
    // The frame has 12px of padding on each side.
    void drawMermaid(source, { maxWidth: width - 24, fontFamily: font.sans, fontFamilyMono: font.mono }).then((r) => {
      if (!live) return
      if (r.ok) {
        setGood({ source, svg: r.svg, width: r.width })
        setError(null)
      } else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [source, closed, width, font])

  return (
    <div ref={box} className="my-2 min-w-0 first:mt-0 last:mb-0">
      {good ? (
        <div className="overflow-hidden rounded-lg bg-muted/60">
          <div className="flex items-center gap-1 px-2 pt-1 text-xs text-muted-foreground">
            {(["diagram", "source"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "focus-ring rounded px-1.5 py-0.5 transition-colors hover:text-foreground",
                  view === v && "text-foreground",
                )}
              >
                {v === "diagram" ? "Diagram" : "Source"}
              </button>
            ))}
            <span className="ml-auto">
              <CopyButton value={source} />
            </span>
          </div>
          {view === "diagram" ? (
            <div className="mermaid-frame overflow-x-auto px-3 pt-1 pb-3">
              {/* A diagram shrinks to fit down to 70% of its size; a wider one
                  scrolls sideways instead of turning its text unreadable. */}
              <div
                className="flex justify-center [&>svg]:h-auto [&>svg]:min-w-0 [&>svg]:max-w-full"
                style={{ minWidth: Math.round(good.width * 0.7) }}
                // Pele's own output only, after quietColors (src/lib/mermaid.ts).
                dangerouslySetInnerHTML={{ __html: good.svg }}
              />
            </div>
          ) : (
            <pre className="overflow-x-auto px-3 pt-1 pb-2 font-mono text-[0.85em] leading-relaxed">
              <code>{source}</code>
            </pre>
          )}
        </div>
      ) : (
        <>
          {fallback}
          {closed && error ? <p className="-mt-1 mb-2 text-xs text-muted-foreground">Not drawn: {error}</p> : null}
        </>
      )}
    </div>
  )
}
