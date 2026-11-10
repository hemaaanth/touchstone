import { useCallback, useState } from "react"
import { cn } from "@/lib/utils"

// A side panel width the operator can drag, kept across reloads.
export function useStoredWidth(key: string, initial: number, min: number, max: number) {
  const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max])
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key))
    return saved > 0 ? clamp(saved) : initial
  })
  const set = useCallback(
    (w: number) => {
      const next = clamp(w)
      setWidth(next)
      localStorage.setItem(key, String(next))
    },
    [key, clamp],
  )
  return [width, set, initial] as const
}

// A thin drag strip on one edge of a panel. `edge` is the panel edge it sits
// on: "right" grows the panel as it moves right (the left sidebar), "left"
// grows it as it moves left (the artifact pane). Double-click resets.
// Desktop only: on a phone both panels are full-screen overlays.
export function ResizeHandle({
  edge,
  width,
  onWidth,
  initial,
  label,
}: {
  edge: "left" | "right"
  width: number
  onWidth: (w: number) => void
  initial: number
  label: string
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = width
    // While dragging: no width transitions, no text selection, one cursor.
    document.documentElement.dataset.resizing = ""
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      onWidth(edge === "right" ? startW + dx : startW - dx)
    }
    const up = () => {
      delete document.documentElement.dataset.resizing
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(initial)}
      className={cn(
        "group/resize absolute inset-y-0 z-30 hidden w-2 cursor-col-resize touch-none md:block",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover/resize:bg-foreground/20 group-active/resize:bg-foreground/35" />
    </div>
  )
}
