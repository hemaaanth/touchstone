import type { ReactNode } from "react"
import { cn } from "cn"
import { Dot, Muted, type DotTone } from "@/components/app/blocks"
import { panelHref } from "@/lib/route"

/** A text link that opens a panel view beside the current route. */
export function PanelLink({ view, children, className }: { view: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={panelHref(view)}
      className={cn(
        "rounded-(--radius-xs) underline decoration-(--neutral-5) underline-offset-2 hover:decoration-(--cte-text) focus-ring",
        className,
      )}
    >
      {children}
    </a>
  )
}

/** The honest body of a card whose fixture id is missing. */
export function MissingCard({ kind, id }: { kind: string; id: string }) {
  return <CardFrame title={`No ${kind} with the id "${id}"`} tone="muted" />
}

/*
 * The frame every chat card shares. One look for all ten cards.
 *   title    what the card is, in plain words
 *   meta     one short line under the title (time, run, step)
 *   tone     a status dot next to the title; text always says the same thing
 *   actions  buttons in a row at the bottom
 */

export function CardFrame({
  title,
  meta,
  tone,
  actions,
  children,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  tone?: DotTone
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col rounded-(--radius-m) bg-(--cte-surface) shadow-(--shadow-m)", className)}>
      <header
        className={cn(
          "flex flex-col gap-(--space-xxs) px-(--space-l) pt-(--space-m) pb-(--space-s)",
          (children || actions) && "divide-bottom",
        )}
      >
        <h3 className="flex items-center gap-(--space-xs) type-s weight-medium">
          {tone ? <Dot tone={tone} /> : null}
          {title}
        </h3>
        {meta ? <Muted className="type-xs">{meta}</Muted> : null}
      </header>
      {children ? <div className="flex flex-col gap-(--space-s) px-(--space-l) py-(--space-m) type-s">{children}</div> : null}
      {actions ? (
        <footer className={cn("flex flex-wrap items-center gap-(--space-s) px-(--space-l) py-(--space-s)", children && "divide-top")}>
          {actions}
        </footer>
      ) : null}
    </section>
  )
}
