import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react"
import { cn } from "cn"
import { moduleStyle, orderModules } from "@/lib/module-colors"
import {
  DOT,
  ITEM_GAP_X,
  LINE_H,
  NAME_GAP,
  OPEN_PAD_X,
  REST_H,
  openLayout,
  pillLeft,
  pillMaxWidth,
  restDotLeft,
  restWidth,
  type OpenLayout,
} from "@/lib/module-dots-layout"
import { dropOnOwnScroll, mayHoverOpen, noteScroll, routePillWheel, swallowTapClick } from "@/lib/module-dots-rules"

// A run's modules as one mark that grows. At rest it is a small stack with a
// dot for every module, in the module's own colour (src/lib/module-colors.ts)
// and the server's module order. While the pointer is on it, while it has
// keyboard focus, or after a tap, the same mark grows to the right into a pill
// that names every module: each dot slides to its place and its name unfolds
// beside it. Closing is the same movement backwards. Nothing is drawn twice:
// while the pill is out, the stack in the row is empty.
//
// The pill only shows; it takes no pointer events. A wheel over its portion
// beyond the list routes back to that list; clicks reach what lies under it.
// It keeps the mark's left edge and its vertical centre, and lies over the
// right (in the sidebar, past the rail), so it lives in a portal, outside the
// list's clip, and the row's layout never changes. It is at most MAX_OPEN_W
// wide, with balanced lines, and moves left only when not even a short pill
// fits (a phone). A scroll of the mark's own list drops it.
//
// Reduced motion: no movement; the small state is replaced by the large one.
//
//   <ModuleDots ids={run.packs} packs={packs} />
//   <ModuleDots ids={[finding.pack]} packs={packs} tabStop={false} />

// Hover waits a moment, so a pointer that only crosses the mark opens nothing.
const OPEN_DELAY = 120
// Quick and calm: an ease-out with no overshoot.
const DURATION = 0.22
const EASE = [0.32, 0.72, 0, 1] as const

export type Module = { id: string; title: string }
// Where the mark was on the screen when the pill came out.
type Anchor = { left: number; top: number; vw: number; ring: string }

// Every scroll in the page, by the element that scrolled; a mark only asks
// about its own lists (module-dots-rules.ts).
let watching = false
function watchScrolls() {
  if (watching) return
  watching = true
  window.addEventListener("scroll", (e) => e.target && noteScroll(e.target, performance.now()), { capture: true, passive: true })
}

// The mark's own scroll containers: every scrolling ancestor, and the page.
function scrollParents(el: Element): EventTarget[] {
  const out: EventTarget[] = []
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (/(auto|scroll|overlay)/.test(s.overflowY + s.overflowX)) out.push(p)
  }
  out.push(document)
  return out
}

// A menu or a modal that the mark is not inside: the pill must not lie over it.
function underLayer(el: Element) {
  if (document.querySelector('[role="menu"]')) return true
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"]')].some((d) => !d.contains(el))
}

export function ModuleDots({
  ids,
  packs,
  tabStop = true,
  className,
}: {
  // Module (pack) ids. Duplicates show once.
  ids: readonly string[]
  // The server's module list: each module's title, and the order of the dots.
  packs?: readonly { id: string; title: string }[]
  // A keyboard stop of its own. A list whose row already names its module
  // (the Findings page) leaves it out of the tab order.
  tabStop?: boolean
  className?: string
}) {
  const reduce = useReducedMotion() ?? false
  const unique = [...new Set(ids.filter(Boolean))]
  const order = packs ? orderModules(unique, packs.map((p) => p.id)) : unique
  const modules: Module[] = order.map((id) => ({ id, title: packs?.find((p) => p.id === id)?.title ?? id }))

  const [open, setOpen] = useState(false)
  // Set while the pill is out: open, or on its way back.
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const markRef = useRef<HTMLSpanElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef(false)
  // Why it is open: the pointer is on the mark, the mark has keyboard focus,
  // or a tap opened it. It closes when none holds.
  const why = useRef({ over: false, focus: false, tap: false })
  // Closed by hand (Escape): hover and focus do not reopen it until the
  // pointer leaves or focus moves.
  const shut = useRef(false)
  const lists = useRef<EventTarget[]>([])
  useEffect(watchScrolls, [])

  const show = () => {
    window.clearTimeout(timer.current)
    const el = markRef.current
    if (!el || underLayer(el)) return
    if (!anchor) {
      const r = el.getBoundingClientRect()
      const ring = getComputedStyle(el).getPropertyValue("--module-dots-ring").trim()
      lists.current = scrollParents(el)
      setAnchor({ left: r.left, top: r.top, vw: document.documentElement.clientWidth, ring: ring || "var(--background)" })
    }
    setOpen(true)
  }
  const settle = () => {
    const w = why.current
    if (!w.over && !w.focus && !w.tap) {
      window.clearTimeout(timer.current)
      setOpen(false)
    }
  }
  const closeAll = () => {
    window.clearTimeout(timer.current)
    why.current = { over: false, focus: false, tap: false }
    setOpen(false)
  }
  // Gone at once, with no movement back: the mark has moved (a scroll).
  const drop = () => {
    closeAll()
    pending.current = false
    setAnchor(null)
  }
  const hoverLater = () => {
    window.clearTimeout(timer.current)
    pending.current = true
    timer.current = window.setTimeout(() => {
      pending.current = false
      const el = markRef.current
      const ok = el && mayHoverOpen({ over: why.current.over, shut: shut.current, containers: scrollParents(el), now: performance.now() })
      if (ok) show()
    }, OPEN_DELAY)
  }

  // While out: Escape closes it; a tap or click elsewhere closes it (and on
  // touch, that tap does nothing else); a scroll of its own list, a resize,
  // or a context menu drops it.
  const live = useRef({ closeAll, drop })
  useEffect(() => {
    live.current = { closeAll, drop }
  })
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      shut.current = true
      live.current.closeAll()
    }
    const onDown = (e: PointerEvent) => {
      if (markRef.current?.contains(e.target as Node)) return
      live.current.closeAll()
      if (e.pointerType !== "mouse") swallowTapClick(window)
    }
    const onDrop = () => live.current.drop()
    const onWheel = (e: WheelEvent) => {
      const mark = markRef.current
      const pill = pillRef.current
      if (!mark || !pill || underLayer(mark)) return
      const list = lists.current.find((c): c is HTMLElement =>
        c instanceof HTMLElement && (c.scrollHeight > c.clientHeight || c.scrollWidth > c.clientWidth))
      if (list) routePillWheel(e, pill.getBoundingClientRect(), list)
    }
    const stopScroll = dropOnOwnScroll(lists.current, onDrop)
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("wheel", onWheel, { capture: true, passive: false })
    window.addEventListener("contextmenu", onDrop, true)
    window.addEventListener("resize", onDrop)
    return () => {
      stopScroll()
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("wheel", onWheel, true)
      window.removeEventListener("contextmenu", onDrop, true)
      window.removeEventListener("resize", onDrop)
    }
  }, [open])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const width = restWidth(modules.length)
  const box = cn("relative inline-flex shrink-0 items-center", className)
  if (modules.length === 0) {
    return <span data-slot="module-dots" aria-hidden className={box} style={{ width, height: REST_H }} />
  }

  return (
    <>
      <span
        ref={markRef}
        data-slot="module-dots"
        data-open={open || undefined}
        tabIndex={tabStop ? 0 : -1}
        role="img"
        aria-label={`${modules.length === 1 ? "Module" : "Modules"}: ${modules.map((m) => m.title).join(", ")}`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return
          why.current.over = true
          if (!open) hoverLater()
        }}
        // A pointer that rests after a scroll opens it once it moves again.
        onPointerMove={(e) => {
          if (e.pointerType !== "mouse" || open || pending.current) return
          why.current.over = true
          hoverLater()
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse") return
          why.current.over = false
          shut.current = false
          settle()
        }}
        onFocus={(e) => {
          if (!e.currentTarget.matches(":focus-visible") || shut.current) return
          why.current.focus = true
          show()
        }}
        onBlur={() => {
          why.current.focus = false
          shut.current = false
          settle()
        }}
        onClick={(e) => {
          e.stopPropagation()
          // A mouse click only opens: the pointer is on the mark, so hover
          // holds it. A tap opens it and a second tap closes it.
          if ((e.nativeEvent as PointerEvent).pointerType === "mouse" || !("pointerType" in e.nativeEvent)) {
            shut.current = false
            show()
            return
          }
          if (open) {
            closeAll()
          } else {
            why.current.tap = true
            show()
          }
        }}
        className={cn(box, "rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring")}
        style={{ width, height: REST_H }}
      >
        <ModuleDotsStack modules={modules} hidden={anchor !== null} />
      </span>
      {anchor
        ? createPortal(
            <Pill modules={modules} anchor={anchor} open={open} reduce={reduce} pillRef={pillRef} onClosed={() => setAnchor(null)} />,
            document.body,
          )
        : null}
    </>
  )
}

// The mark at rest: a dot for every module, overlapping. Hidden while the pill
// is out, so no dot is ever drawn in the row and in the pill at once.
// Exported for its test.
export function ModuleDotsStack({ modules, hidden }: { modules: readonly Module[]; hidden: boolean }) {
  return modules.map((m, i) => (
    <span
      key={m.id}
      aria-hidden
      data-slot="module-dot"
      data-module={m.id}
      style={{ ...moduleStyle(m.id), width: DOT, height: DOT, left: restDotLeft(i), opacity: hidden ? 0 : undefined }}
      className="absolute rounded-full bg-(--module) ring-[1.5px] ring-(--module-dots-ring,var(--background))"
    />
  ))
}

// The mark grown into a pill. `p` runs 0 (the mark at rest, in its exact place)
// to 1 (open); every part of the pill is drawn from it. It takes no pointer
// events.
function Pill({
  modules,
  anchor,
  open,
  reduce,
  pillRef,
  onClosed,
}: {
  modules: Module[]
  anchor: Anchor
  open: boolean
  reduce: boolean
  pillRef: RefObject<HTMLDivElement | null>
  onClosed: () => void
}) {
  const measureRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<OpenLayout | null>(null)
  const p = useMotionValue(0)

  // Measure each name once, hidden, before the first paint; the lines are laid
  // out from those widths (openLayout).
  useLayoutEffect(() => {
    const m = measureRef.current
    if (!m) return
    const widths = ([...m.children] as HTMLElement[]).map((el) => el.getBoundingClientRect().width)
    setLayout(openLayout(widths, pillMaxWidth(anchor.left, anchor.vw)))
  }, [anchor])

  const done = useRef(onClosed)
  useEffect(() => {
    done.current = onClosed
  })
  useEffect(() => {
    if (!layout) return
    const run = animate(p, open ? 1 : 0, {
      duration: reduce ? 0 : DURATION,
      ease: EASE,
      onComplete: () => !open && done.current(),
    })
    return () => run.stop()
  }, [open, layout, reduce, p])

  const restW = restWidth(modules.length)
  const openLeft = layout ? pillLeft(anchor.left, layout.w, anchor.vw) : anchor.left
  const left = useTransform(p, [0, 1], [anchor.left, openLeft])
  const top = useTransform(p, [0, 1], [anchor.top, anchor.top + (REST_H - LINE_H) / 2])
  const width = useTransform(p, [0, 1], [restW, layout?.w ?? restW])
  const height = useTransform(p, [0, 1], [REST_H, layout?.h ?? REST_H])
  // The surface comes in early, so the open pill is never dots on bare page.
  const surface = useTransform(p, [0, 0.35], [0, 1])

  return (
    <motion.div
      ref={pillRef}
      data-slot="module-dots-pill"
      data-open={open || undefined}
      style={{ left, top, width, height }}
      className="pointer-events-none fixed z-50"
    >
      <motion.div
        aria-hidden
        style={{ opacity: surface }}
        className="bg-popover ring-foreground/10 absolute inset-0 rounded-[10px] shadow-md ring-1"
      />
      {layout ? <ModuleDotsPillBody modules={modules} layout={layout} p={p} ring={anchor.ring} /> : null}
      {/* Each name's own width, measured before the first paint, never seen,
          and gone once measured, so each name is in the page once. */}
      {layout ? null : (
        <div ref={measureRef} aria-hidden className="invisible absolute top-0 left-0 flex flex-col text-xs leading-4">
          {modules.map((m) => (
            <span key={m.id} className="w-max whitespace-nowrap">
              {m.title}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  )
}

// What the open pill draws: each module's dot and its name, at progress `p`.
// Exported for its test, which renders it without a browser.
export function ModuleDotsPillBody({
  modules,
  layout,
  p,
  ring,
}: {
  modules: readonly Module[]
  layout: OpenLayout
  p: MotionValue<number>
  ring: string
}) {
  const from = (i: number) => ({ x: restDotLeft(i), y: (REST_H - DOT) / 2 })
  const restW = restWidth(modules.length)
  return (
    <div className="text-popover-foreground absolute inset-0 overflow-hidden rounded-[10px] text-xs leading-4">
      {modules.map((m, i) => {
        const to = layout.dots[i]
        const next = layout.dots[i + 1]
        // What a name may not cross: the next dot on its line, or the pill's
        // own edge. Both move with p, so a name unfolds from behind its dot
        // as the dots part, and no two names ever overlap.
        const limit: Edge =
          next && next.y === to.y
            ? { from: from(i + 1).x - ITEM_GAP_X, to: next.x - ITEM_GAP_X }
            : { from: restW - OPEN_PAD_X, to: layout.w - OPEN_PAD_X }
        return <PillModule key={m.id} p={p} module={m} ring={ring} from={from(i)} to={to} limit={limit} />
      })}
    </div>
  )
}

type Edge = { from: number; to: number }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// One module in the pill: its dot slides from the stack to its place, and its
// name, real text, unfolds beside it.
function PillModule({
  p,
  module,
  ring,
  from,
  to,
  limit,
}: {
  p: MotionValue<number>
  module: Module
  ring: string
  from: { x: number; y: number }
  to: { x: number; y: number; nameW: number; cut?: boolean }
  limit: Edge
}) {
  const x = useTransform(p, [0, 1], [from.x, to.x])
  const y = useTransform(p, [0, 1], [from.y, to.y])
  const nameX = useTransform(x, (v) => v + DOT + NAME_GAP)
  const nameY = useTransform(y, (v) => v - (16 - DOT) / 2)
  const full = Math.ceil(to.nameW) + 1
  const nameW = useTransform(p, (v) => {
    const room = lerp(limit.from, limit.to, v) - (lerp(from.x, to.x, v) + DOT + NAME_GAP)
    return v >= 1 ? full : Math.max(0, Math.min(full, room))
  })
  const nameOpacity = useTransform(p, [0.1, 0.6], [0, 1])
  // At rest the dots overlap, and a ring in the row's colour keeps them apart;
  // open, they stand apart and the ring goes.
  const shadow = useTransform(p, (v) => `0 0 0 ${(1.5 * Math.max(0, 1 - v * 2)).toFixed(2)}px ${ring}`)
  return (
    <>
      <motion.span
        aria-hidden
        data-slot="module-dot"
        data-module={module.id}
        style={{ ...moduleStyle(module.id), x, y, width: DOT, height: DOT, boxShadow: shadow }}
        className="absolute top-0 left-0 rounded-full bg-(--module)"
      />
      <motion.span
        data-slot="module-dots-name"
        style={{ x: nameX, y: nameY, opacity: nameOpacity, width: nameW }}
        // Clipped while it unfolds; an ellipsis only on a name the open pill
        // itself cannot fit.
        className={cn("absolute top-0 left-0 h-4 overflow-hidden whitespace-nowrap", to.cut && "text-ellipsis")}
      >
        {module.title}
      </motion.span>
    </>
  )
}
