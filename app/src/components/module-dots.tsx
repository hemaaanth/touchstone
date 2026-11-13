import { useState, type ComponentProps } from "react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "cn"
import { moduleStyle, orderModules } from "@/lib/module-colors"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// A run's modules as small coloured dots: one per module, in the module's own
// colour (src/lib/module-colors.ts), in the server's module order. At most
// three show, overlapping; with more, a small grey dot sits behind the stack
// to say "more", and the rest are named in the reveal. The grey dot is no
// module's colour, so it never reads as one. The box has one fixed width
// whatever the count, so a row never moves.
//
// On hover, keyboard focus or a tap, the dots spread apart inside that box and
// a small tooltip names every module. Reduced motion: no movement, the tooltip
// only. An empty list keeps the same empty box.
//
//   <ModuleDots ids={run.packs} packs={packs} />
//   <ModuleDots ids={[finding.pack]} packs={packs} />   // one module, fixed slot

const SHOWN = 3
// Dot size and the step between dots, at rest (overlapping) and open.
const DOT = 8
const REST = 5
const OPEN = 10
// The box fits three open dots, so the spread stays inside it.
const WIDTH = DOT + OPEN * (SHOWN - 1)
// The "more" dot: smaller, behind the stack's left end with a 2 px gap.
const MORE = 5
const MORE_RIGHT = DOT + REST * (SHOWN - 1) + 2
// Hover opens the names sooner than the app's other tooltips (300 ms): the dots
// say little on their own. Focus opens them at once.
const REVEAL_DELAY = 120

type Side = ComponentProps<typeof TooltipContent>["side"]

export function ModuleDots({
  ids,
  packs,
  side = "top",
  sideOffset,
  className,
}: {
  // Module (pack) ids. Duplicates show once.
  ids: readonly string[]
  // The server's module list: each module's title, and the order of the dots.
  packs?: readonly { id: string; title: string }[]
  // Where the names open. Collisions with the viewport flip or shift it.
  side?: Side
  // The gap to the dots, in px (the tooltip's default is 8).
  sideOffset?: number
  className?: string
}) {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const unique = [...new Set(ids.filter(Boolean))]
  const all = packs ? orderModules(unique, packs.map((p) => p.id)) : unique
  const title = (id: string) => packs?.find((p) => p.id === id)?.title ?? id
  const shown = all.slice(0, SHOWN)
  const box = cn("relative inline-flex h-4 shrink-0 items-center justify-end", className)
  if (all.length === 0) return <span data-slot="module-dots" aria-hidden className={box} style={{ width: WIDTH }} />

  const names = all.map(title)
  const spread = open && !reduce
  const step = spread ? OPEN : REST
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={<span />}
        delay={REVEAL_DELAY}
        data-slot="module-dots"
        data-open={open || undefined}
        tabIndex={0}
        role="img"
        aria-label={`${all.length === 1 ? "Module" : "Modules"}: ${names.join(", ")}`}
        // A tap opens and closes it on touch; hover and focus open it as any tooltip.
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={cn(box, "rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring")}
        style={{ width: WIDTH }}
      >
        {all.length > SHOWN ? (
          // Open, the three dots spread over the whole box, so it fades out.
          <motion.span
            aria-hidden
            data-slot="module-dots-more"
            initial={false}
            animate={{ opacity: spread ? 0 : 1 }}
            transition={{ duration: reduce ? 0 : 0.12 }}
            style={{ width: MORE, height: MORE, right: MORE_RIGHT }}
            className="bg-muted-foreground/60 absolute rounded-full"
          />
        ) : null}
        {shown.map((id, i) => {
          // Right-aligned: the last dot sits at the right edge, the others step left.
          const x = -(shown.length - 1 - i) * step
          return (
            <motion.span
              key={id}
              aria-hidden
              data-slot="module-dot"
              data-module={id}
              initial={false}
              animate={{ x }}
              transition={{ duration: reduce ? 0 : 0.16, ease: "easeOut" }}
              style={{ ...moduleStyle(id), width: DOT, height: DOT, zIndex: i + 1 }}
              className="absolute right-0 rounded-full bg-(--module) ring-[1.5px] ring-(--module-dots-ring,var(--background))"
            />
          )
        })}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} className="flex-col items-start gap-1">
        {all.map((id) => (
          <span key={id} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--module)" style={moduleStyle(id)} />
            {title(id)}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
