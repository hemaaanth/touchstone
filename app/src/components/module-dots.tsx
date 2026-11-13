import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react"
import { cn } from "cn"
import { moduleStyle, orderModules } from "@/lib/module-colors"
import {
  DOT,
  ITEM_GAP_X,
  ITEM_GAP_Y,
  LINE_H,
  NAME_GAP,
  OPEN_PAD_X,
  OPEN_PAD_Y,
  REST_H,
  pillLeft,
  pillMaxWidth,
  restDotLeft,
  restWidth,
} from "@/lib/module-dots-layout"

// A run's modules as one mark that grows. At rest it is a small stack with a
// dot for every module, in the module's own colour (src/lib/module-colors.ts)
// and the server's module order. On hover, keyboard focus or a tap, the same
// mark grows to the right into a pill that names every module: each dot slides
// to its place and its name appears beside it. Closing is the same movement
// backwards. Nothing is drawn twice: while the pill is out, the stack in the
// row is empty.
//
// The pill keeps the mark's left edge and its vertical centre. It lies over
// whatever is to the right (in the sidebar, past the rail), so it lives in a
// portal, outside the list's clip, and the row's layout never changes. It wraps
// onto more lines when the screen is too narrow, and moves left only when not
// even a short pill fits (a phone). It closes when the page scrolls.
//
// Reduced motion: no movement; the small state is replaced by the large one.
//
//   <ModuleDots ids={run.packs} packs={packs} />
//   <ModuleDots ids={[finding.pack]} packs={packs} />   // one module

// Hover waits a moment, so a pointer that only crosses the mark opens
// nothing; a short grace lets the pointer move from the mark onto the pill.
const OPEN_DELAY = 120
const CLOSE_DELAY = 80
// Quick and calm: an ease-out with no overshoot.
const DURATION = 0.22
const EASE = [0.32, 0.72, 0, 1] as const

export type Module = { id: string; title: string }

// When the page last scrolled. A scroll drops an open pill, and the browser
// then sends a fresh pointer-enter to whatever mark is under the resting
// pointer; a hover that comes right after a scroll opens nothing.
let lastScroll = -Infinity
let watching = false
function watchScroll() {
  if (watching) return
  watching = true
  window.addEventListener("scroll", () => (lastScroll = performance.now()), { capture: true, passive: true })
}
const SCROLL_QUIET = 300
// Where the mark was on the screen when the pill came out.
type Anchor = { left: number; top: number; vw: number; ring: string }
// The open pill, measured: its size, and each dot's place inside it.
export type OpenLayout = { w: number; h: number; dots: { x: number; y: number; nameW: number; cut?: boolean }[] }

export function ModuleDots({
  ids,
  packs,
  className,
}: {
  // Module (pack) ids. Duplicates show once.
  ids: readonly string[]
  // The server's module list: each module's title, and the order of the dots.
  packs?: readonly { id: string; title: string }[]
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
  const over = useRef({ mark: false, pill: false })
  // Closed by hand (a click, a tap, Escape): hover does not reopen it until
  // the pointer has left the mark.
  const shut = useRef(false)
  useEffect(watchScroll, [])

  const show = useCallback(() => {
    window.clearTimeout(timer.current)
    const el = markRef.current
    if (!el) return
    setAnchor((a) => {
      if (a) return a
      const r = el.getBoundingClientRect()
      const ring = getComputedStyle(el).getPropertyValue("--module-dots-ring").trim()
      return { left: r.left, top: r.top, vw: document.documentElement.clientWidth, ring: ring || "var(--background)" }
    })
    setOpen(true)
  }, [setAnchor])
  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }, [])
  // Gone at once, with no movement back: the mark has moved (a scroll).
  const drop = useCallback(() => {
    window.clearTimeout(timer.current)
    pending.current = false
    over.current = { mark: false, pill: false }
    setOpen(false)
    setAnchor(null)
  }, [setAnchor])
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current)
    pending.current = true
    timer.current = window.setTimeout(() => {
      pending.current = false
      fn()
    }, ms)
  }
  const hoverOpen = () => over.current.mark && !shut.current && performance.now() - lastScroll > SCROLL_QUIET && show()
  const close = () => {
    shut.current = true
    hide()
  }
  const leave = () => later(() => !over.current.mark && !over.current.pill && hide(), CLOSE_DELAY)

  // While open: Escape closes, a tap outside closes, a scroll or resize drops it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      shut.current = true
      hide()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!markRef.current?.contains(t) && !pillRef.current?.contains(t)) hide()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("scroll", drop, true)
    window.addEventListener("resize", drop)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", drop, true)
      window.removeEventListener("resize", drop)
    }
  }, [open, hide, drop])
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
        tabIndex={0}
        role="img"
        aria-label={`${modules.length === 1 ? "Module" : "Modules"}: ${modules.map((m) => m.title).join(", ")}`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return
          over.current.mark = true
          if (!open) later(hoverOpen, OPEN_DELAY)
        }}
        // A pointer that rests after a scroll opens it once it moves again.
        onPointerMove={(e) => {
          if (e.pointerType !== "mouse" || open || pending.current) return
          over.current.mark = true
          later(hoverOpen, OPEN_DELAY)
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse") return
          over.current.mark = false
          shut.current = false
          leave()
        }}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show()}
        onBlur={() => !over.current.mark && !over.current.pill && hide()}
        // A tap opens and closes it; so does a click.
        onClick={(e) => {
          e.stopPropagation()
          if (open) close()
          else show()
        }}
        className={cn(box, "rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring")}
        style={{ width, height: REST_H }}
      >
        {modules.map((m, i) => (
          <span
            key={m.id}
            aria-hidden
            data-slot="module-dot"
            data-module={m.id}
            style={{ ...moduleStyle(m.id), width: DOT, height: DOT, left: restDotLeft(i), opacity: anchor ? 0 : undefined }}
            className="absolute rounded-full bg-(--module) ring-[1.5px] ring-(--module-dots-ring,var(--background))"
          />
        ))}
      </span>
      {anchor
        ? createPortal(
            <Pill
              modules={modules}
              anchor={anchor}
              open={open}
              reduce={reduce}
              pillRef={pillRef}
              onClosed={() => {
                over.current.pill = false
                setAnchor(null)
              }}
              onEnter={() => {
                over.current.pill = true
                window.clearTimeout(timer.current)
              }}
              onLeave={() => {
                over.current.pill = false
                leave()
              }}
              onTap={close}
            />,
            document.body,
          )
        : null}
    </>
  )
}

// The mark grown into a pill. `p` runs 0 (the mark at rest, in its exact place)
// to 1 (open); every part of the pill is drawn from it.
function Pill({
  modules,
  anchor,
  open,
  reduce,
  pillRef,
  onClosed,
  onEnter,
  onLeave,
  onTap,
}: {
  modules: Module[]
  anchor: Anchor
  open: boolean
  reduce: boolean
  pillRef: RefObject<HTMLDivElement | null>
  onClosed: () => void
  onEnter: () => void
  onLeave: () => void
  onTap: () => void
}) {
  const measureRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<OpenLayout | null>(null)
  const p = useMotionValue(0)
  const maxWidth = pillMaxWidth(anchor.left, anchor.vw)

  // Lay the open pill out once, hidden, before the first paint.
  useLayoutEffect(() => {
    const m = measureRef.current
    if (!m) return
    const items = [...m.children] as HTMLElement[]
    const right = Math.max(...items.map((el) => el.offsetLeft + el.getBoundingClientRect().width))
    setLayout({
      w: right + OPEN_PAD_X,
      h: m.offsetHeight,
      dots: items.map((el) => ({
        x: el.offsetLeft,
        y: el.offsetTop + (16 - DOT) / 2,
        // The exact width: a rounded-down one cuts the name with an ellipsis.
        nameW: (el.lastElementChild as HTMLElement).getBoundingClientRect().width,
        cut: (el.lastElementChild as HTMLElement).scrollWidth > (el.lastElementChild as HTMLElement).clientWidth,
      })),
    })
  }, [])

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
      onPointerEnter={(e) => e.pointerType === "mouse" && onEnter()}
      onPointerLeave={(e) => e.pointerType === "mouse" && onLeave()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onTap()
      }}
      style={{ left, top, width, height, pointerEvents: open ? "auto" : "none" }}
      className="fixed z-50"
    >
      <motion.div
        aria-hidden
        style={{ opacity: surface }}
        className="bg-popover ring-foreground/10 absolute inset-0 rounded-[10px] shadow-md ring-1"
      />
      {layout ? <ModuleDotsPillBody modules={modules} layout={layout} p={p} ring={anchor.ring} /> : null}
      {/* The open layout, measured before the first paint, never seen, and
          gone once measured, so each name is in the page once. */}
      {layout ? null : (
      <div
        ref={measureRef}
        aria-hidden
        className="invisible absolute top-0 left-0 flex w-max flex-wrap text-xs leading-4"
        style={{ maxWidth, padding: `${OPEN_PAD_Y}px ${OPEN_PAD_X}px`, columnGap: ITEM_GAP_X, rowGap: ITEM_GAP_Y }}
      >
        {modules.map((m) => (
          <span key={m.id} className="inline-flex h-4 max-w-full min-w-0 items-center whitespace-nowrap" style={{ gap: NAME_GAP }}>
            <span className="shrink-0" style={{ width: DOT, height: DOT }} />
            <span className="truncate">{m.title}</span>
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
