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
// - When a newer snapshot fails, the last good diagram stays, with a quiet note.
// - A closed source that never parsed stays a code block, with Pele's reason
//   under it as plain text.
// - `deferred` (past the per-message cap, components/markdown.tsx): the code
//   block with a "Draw diagram" button; nothing is drawn until it is pressed.
// - "Diagram | Source" switches between the picture and its text; Copy copies
//   the source.
export function MermaidBlock({
  source,
  closed,
  fallback,
  deferred = false,
}: {
  source: string
  closed: boolean
  fallback: ReactNode
  deferred?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLDivElement>(null)
  const note = useRef<HTMLParagraphElement>(null)
  // After "Draw diagram", focus goes to the result, not to the page body.
  const focusNext = useRef(false)
  const [width, setWidth] = useState(0)
  const [font, setFont] = useState<{ sans: string; mono: string } | null>(null)
  const [good, setGood] = useState<{ source: string; svg: string; width: number; type: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<"diagram" | "source">("diagram")
  const [asked, setAsked] = useState(false)
  const [more, setMore] = useState(false)
  const draw = closed && (!deferred || asked)

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
    if (!draw || !width || !font) return
    let live = true
    // The frame has 12px of padding on each side.
    void drawMermaid(source, { maxWidth: width - 24, fontFamily: font.sans, fontFamilyMono: font.mono }).then((r) => {
      if (!live) return
      if (r.ok) {
        setGood({ source, svg: r.svg, width: r.width, type: r.type })
        setError(null)
      } else setError(r.error)
    })
    return () => {
      live = false
    }
  }, [source, draw, width, font])

  // A diagram wider than the frame scrolls sideways. A soft right edge says so
  // until the reader reaches the end.
  const readMore = () => {
    const el = frame.current
    setMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }
  useLayoutEffect(readMore, [good, width, view])

  useEffect(() => {
    if (!focusNext.current || (!good && !error)) return
    focusNext.current = false
    ;(good ? picture.current : note.current)?.focus()
  }, [good, error])

  return (
    <div ref={box} data-mermaid="" className="my-2 min-w-0 first:mt-0 last:mb-0">
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
            <div
              ref={frame}
              onScroll={readMore}
              className={cn(
                "mermaid-frame overflow-x-auto px-3 pt-1 pb-3",
                more && "[mask-image:linear-gradient(to_right,black_85%,transparent)]",
              )}
            >
              {/* A diagram shrinks to fit down to 70% of its size; a wider one
                  scrolls sideways instead of turning its text unreadable. */}
              <div
                ref={picture}
                tabIndex={-1}
                role="img"
                aria-label={`Diagram: ${good.type}`}
                className="flex justify-center rounded outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&>svg]:h-auto [&>svg]:min-w-0 [&>svg]:max-w-full"
                style={{ minWidth: Math.round(good.width * 0.7) }}
                // Only the allow-list pass's output (lib/svg-allow.ts).
                dangerouslySetInnerHTML={{ __html: good.svg }}
              />
            </div>
          ) : (
            <pre className="overflow-x-auto px-3 pt-1 pb-2 font-mono text-[0.85em] leading-relaxed">
              <code>{source}</code>
            </pre>
          )}
          {error && good.source !== source ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground">Showing the last version that drew.</p>
          ) : null}
        </div>
      ) : (
        <>
          {fallback}
          {draw && error ? (
            <p ref={note} tabIndex={-1} className="-mt-1 mb-2 text-xs text-muted-foreground outline-none">
              Not drawn: {error}
            </p>
          ) : null}
          {closed && deferred && !asked ? (
            <button
              type="button"
              onClick={() => {
                focusNext.current = true
                setAsked(true)
              }}
              className="focus-ring -mt-1 mb-2 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Draw diagram
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
