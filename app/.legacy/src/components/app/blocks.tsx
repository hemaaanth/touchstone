import type { ComponentProps, ReactNode } from "react"
import { Accordion, Collapsible, ScrollArea, ThemedIcon } from "@graphical"
import { cn } from "cn"
import { href, panelHref } from "@/lib/route"
import { SEVERITY_TONE, type DotTone } from "@/lib/tones"
import type { Severity } from "@/data/fixtures"

export type { DotTone } from "@/lib/tones"

/*
 * Shared app blocks. They only compose theme variables, so a mockup and the
 * shipped screen are the same code. Static values never look like controls.
 */

export type Crumb = { label: string; to?: string }

/** One center page: header, scrolling body, optional right rail. */
export function Page({
  crumbs,
  title,
  meta,
  actions,
  rail,
  banner,
  children,
}: {
  crumbs: Crumb[]
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  rail?: ReactNode
  banner?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 divide-bottom">
          <div className="mx-auto flex w-full max-w-(--canvas) items-end gap-(--space-l) px-(--space-xl) pt-(--space-l) pb-(--space-m)">
            <div className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
              <Breadcrumb crumbs={crumbs} />
              <h1 className="truncate type-l weight-medium">{title}</h1>
              {meta ? (
                <div className="flex flex-wrap items-center gap-x-(--space-m) gap-y-(--space-xxs) type-s text-(--cte-text-muted)">
                  {meta}
                </div>
              ) : null}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center gap-(--space-s)">{actions}</div>
            ) : null}
          </div>
        </header>
        {banner}
        <Scroll>
          <div className="mx-auto flex w-full max-w-(--canvas) flex-col gap-(--space-xxl) px-(--space-xl) py-(--space-xl)">
            {children}
          </div>
        </Scroll>
      </div>
      {rail ? (
        <aside className="flex w-[280px] shrink-0 flex-col bg-(--cte-surface) divide-left">
          <Scroll>
            <div className="flex flex-col gap-(--space-xl) px-(--space-l) py-(--space-l)">
              {rail}
            </div>
          </Scroll>
        </aside>
      ) : null}
    </div>
  )
}

/** A pane that scrolls with the theme's scroll area. */
export function Scroll({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // w-full: the library's scroll root defaults to the 320px spec width.
    <ScrollArea.Root className={cn("min-h-0 w-full flex-1", className)}>
      <ScrollArea.Viewport className="h-full">
        <ScrollArea.Content>{children}</ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="vertical">
        <ScrollArea.Thumb />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="type-xs text-(--cte-text-muted)">
      <ol className="flex items-center gap-(--space-xs)">
        {crumbs.map((crumb, index) => (
          <li key={crumb.label} className="flex items-center gap-(--space-xs)">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.to ? (
              <a
                href={href(crumb.to)}
                className="rounded-(--radius-xs) hover:text-(--cte-text) focus-ring"
              >
                {crumb.label}
              </a>
            ) : (
              <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** A titled block in a page or rail. */
export function Section({
  title,
  count,
  action,
  children,
  className,
}: {
  title: ReactNode
  count?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-(--space-s)", className)}>
      <div className="flex min-h-(--line-l) items-center gap-(--space-s)">
        <h2 className="type-s weight-medium">{title}</h2>
        {count !== undefined ? (
          <span className="font-data type-s text-(--cte-text-muted)">{count}</span>
        ) : null}
        {action ? <div className="ml-auto flex items-center gap-(--space-s)">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** A static label in the theme's badge role. Not clickable. */
export function Tag({
  children,
  tone,
  className,
}: {
  children: ReactNode
  tone?: DotTone
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-(--space-xxs) rounded-(--radius-s) bg-(--option-badge-background) px-(--space-xs) type-xs whitespace-nowrap text-(--option-badge-foreground)",
        className,
      )}
    >
      {tone ? <Dot tone={tone} /> : null}
      {children}
    </span>
  )
}

const DOT: Record<DotTone, string> = {
  error: "bg-(--error)",
  warning: "bg-(--warning)",
  // Mixed toward the text colour so the dot keeps 3:1 on every surface in both modes.
  success: "bg-[color-mix(in_srgb,var(--success)_82%,var(--cte-text))]",
  accent: "bg-(--color-1)",
  orange: "bg-[color-mix(in_srgb,var(--color-2)_82%,var(--cte-text))]",
  muted: "bg-(--neutral-7)",
}

/** A small status mark. Colour is never the only signal: text sits next to it. */
export function Dot({ tone, className }: { tone: DotTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-(--space-xs) shrink-0 rounded-(--radius-full)", DOT[tone], className)}
    />
  )
}

export function SeverityLabel({ severity }: { severity: Severity }) {
  return (
    <span className="inline-flex items-center gap-(--space-xs) whitespace-nowrap">
      <Dot tone={SEVERITY_TONE[severity]} />
      {severity}
    </span>
  )
}

/** A static number with its label. */
export function Stat({
  label,
  value,
  note,
}: {
  label: ReactNode
  value: ReactNode
  note?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-(--space-xxs)">
      <span className="type-xs text-(--cte-text-muted)">{label}</span>
      <span className="font-data type-l weight-medium">{value}</span>
      {note ? <span className="type-xs text-(--cte-text-muted)">{note}</span> : null}
    </div>
  )
}

/** Label and value pairs. */
export function KeyValues({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--space-l) gap-y-(--space-xs) type-s">
      {rows.map(([key, value], index) => (
        <div key={index} className="contents">
          <dt className="text-(--cte-text-muted)">{key}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Machine output: hashes, commands, balances. Recessed and in the data role. */
export function ProofBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-(--space-xxs) overflow-x-auto rounded-(--radius-m) bg-(--cte-surface-muted) p-(--space-m) font-data type-s",
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * One quiet row that expands. Default closed. The workhorse of progressive
 * disclosure: reach for this before adding any second always-on block. Put the
 * raw payload, command, stdout, or hash list inside. See docs/restraint.md.
 */
export function Disclosure({
  summary,
  meta,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode
  meta?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("flex min-w-0 flex-col", className)}>
      <Collapsible.Trigger className="flex min-h-(--line-l) w-full items-center gap-(--space-s) type-s weight-medium text-(--cte-text) focus-ring">
        <Collapsible.Indicator className="text-(--cte-text-muted)">
          <ThemedIcon name="chevronRight" />
        </Collapsible.Indicator>
        <span className="min-w-0 flex-1 text-left">{summary}</span>
        {meta !== undefined ? (
          <span className="shrink-0 font-data type-xs text-(--cte-text-muted)">{meta}</span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {/* ui-copy caps content at a 40ch reading measure; this is a layout region, not prose. */}
        <Collapsible.Content className="max-w-none">
          <div className="flex flex-col gap-(--space-m) pt-(--space-s) pl-(--space-l)">{children}</div>
        </Collapsible.Content>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * A stack of folds, all closed by default. For a group of optional sections
 * (a run's plan, agents, sandbox, trace, cleanup). Only the inventory and the
 * one actionable card stay open above it. See docs/restraint.md.
 */
export type Fold = { value: string; title: ReactNode; meta?: ReactNode; children: ReactNode }

export function DetailAccordion({ items, className }: { items: Fold[]; className?: string }) {
  return (
    <Accordion.Root className={cn("flex w-full flex-col", className)}>
      {items.map((item) => (
        <Accordion.Item key={item.value} value={item.value}>
          <Accordion.Header>
            <Accordion.Trigger className="flex min-h-(--line-l) w-full items-center gap-(--space-s) py-(--space-xs) type-s weight-medium text-(--cte-text) focus-ring">
              <Accordion.Indicator className="text-(--cte-text-muted)">
                <ThemedIcon name="chevronRight" />
              </Accordion.Indicator>
              <span className="min-w-0 flex-1 text-left">{item.title}</span>
              {item.meta !== undefined ? (
                <span className="shrink-0 font-data type-xs text-(--cte-text-muted)">{item.meta}</span>
              ) : null}
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Panel>
            {/* ui-copy caps content at a 40ch reading measure; this is a layout region, not prose. */}
            <Accordion.Content className="max-w-none">
              <div className="flex flex-col gap-(--space-m) pt-(--space-xs) pb-(--space-m) pl-(--space-l)">
                {item.children}
              </div>
            </Accordion.Content>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  )
}

/** A raised panel for grouped content. Edges come from the theme shadow. */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-(--radius-m) bg-(--cte-surface) shadow-(--shadow-m)",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Where a link goes. "to" is a route. "panel" is a panel view. Both: the route
 * with that panel open. Only "panel": the panel opens beside the current route.
 */
export type LinkTarget = { to?: string; panel?: string }

function targetHref({ to, panel }: LinkTarget) {
  if (panel) return to ? href(to, panel) : panelHref(panel)
  return href(to ?? "home")
}

/** A table with inset row dividers. A row with to or panel links its first cell. */
export function Table({
  head,
  rows,
  className,
}: {
  head: ReactNode[]
  rows: ({ key: string; cells: ReactNode[] } & LinkTarget)[]
  className?: string
}) {
  return (
    <table className={cn("w-full border-separate border-spacing-0 type-s", className)}>
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th
              key={index}
              scope="col"
              className="py-(--space-xs) pr-(--space-m) text-left type-xs weight-regular text-(--cte-text-muted) divide-bottom"
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {row.cells.map((cell, index) => (
              <td key={index} className="py-(--space-s) pr-(--space-m) align-top divide-bottom">
                {index === 0 && (row.to || row.panel) ? (
                  <a href={targetHref(row)} className="rounded-(--radius-xs) hover:underline focus-ring">
                    {cell}
                  </a>
                ) : (
                  cell
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A full-width notice under a page header, for example the fork banner. */
export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-(--space-s) bg-(--cte-surface-muted) px-(--space-xl) py-(--space-xs) type-xs divide-bottom">
      {children}
    </div>
  )
}

/** Muted helper text. */
export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-(--cte-text-muted)", className)}>{children}</span>
}

/** A link styled as inline text. It goes to a route, a panel view, or both. */
export function TextLink({
  to,
  panel,
  children,
  className,
}: LinkTarget & {
  children: ReactNode
  className?: string
}) {
  return (
    <a
      href={targetHref({ to, panel })}
      className={cn(
        "rounded-(--radius-xs) underline decoration-(--neutral-5) underline-offset-2 hover:decoration-(--cte-text) focus-ring",
        className,
      )}
    >
      {children}
    </a>
  )
}
