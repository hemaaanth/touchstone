// HOW TO BUILD A LIST PAGE (Scopes, Modules, Settings). Ten lines:
//   <ListPage title="Scopes" description="One muted line."
//             action={<Button size="sm"><Plus />Add scope</Button>}>
//     {loading ? <ListLoading /> : none ? <ListEmpty icon={X} title="No scopes yet">Why.</ListEmpty> : (
//       <ListCard aria-label="Scopes">
//         <ListRow icon={<Globe />} title="example.com" badges={<Badge variant="outline">Demo</Badge>}
//                  meta={[<TruncatedText key="url" mono middle text={url} />, "3 runs"]}
//                  trailing={<ModulePills ids={ids} packs={packs} compact max={2} />}
//                  menu={<RowMenu><RowMenuItem onClick={open}>View details</RowMenuItem></RowMenu>}
//                  onOpen={open} />
//       </ListCard>)}
//   </ListPage>
// Every row has the same parts in the same places. A row never expands in
// place: `onOpen` opens the detail in a Sheet or a Dialog. Give every row the
// same menu. Text that can be long goes in `TruncatedText`, never a hard cut.
// Several lists on one page (Settings): one `ListSection` per list.
// The parts above the "List pattern" line are the old ones. They stay until
// every page has moved.

import { Children, isValidElement, useRef, useState } from "react"
import { Ellipsis, type LucideIcon } from "lucide-react"
import type { ScopedRun } from "@/lib/catalog"
import { ago, DOT, runTitle, statusLabel, statusTone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// Shared parts for the single-item nav pages (Modules, Scopes).

// The top bar. On mobile the sidebar is a Sheet with no always-visible rail,
// so each page carries its own trigger back to the nav.
export function PageHeader({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b px-5 py-3">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <Icon className="size-4" />
      <h1 className="text-sm font-semibold">{title}</h1>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </header>
  )
}

// The scrolling body: one centered column, as on Settings.
export function PageBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-8 md:px-8 md:py-10">{children}</div>
    </div>
  )
}

// A quiet line for a state with nothing to list. It names what is missing and
// why, and never reads as "clean".
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-y py-6 text-center text-xs leading-relaxed text-muted-foreground">{children}</p>
}

// A short list of runs. Each row opens its run.
export function RunLinks({ runs, onOpen, limit = 5 }: { runs: ScopedRun[]; onOpen: (id: string) => void; limit?: number }) {
  const shown = runs.slice(0, limit)
  return (
    <ul className="flex flex-col">
      {shown.map(({ run, brief }) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpen(run.id)}
            className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", DOT[statusTone(brief.status)])} />
            <span className="min-w-0 flex-1 truncate text-xs">{runTitle(run)}</span>
            {brief.proven > 0 ? <span className="shrink-0 text-[11px] text-ok tabular-nums">{brief.proven} proven</span> : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {statusLabel(brief.status)} · {ago(run.startedAt)}
            </span>
          </button>
        </li>
      ))}
      {runs.length > shown.length ? (
        <li className="pt-1 text-[11px] text-muted-foreground">{runs.length - shown.length} more in the sidebar.</li>
      ) : null}
    </ul>
  )
}

// A label over a block inside an open row.
export function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-medium text-muted-foreground">{children}</span>
}

// ── List pattern ────────────────────────────────────────────────────────────

// The page shell: one centred column. At its top the page title, one muted
// line under it, and the primary action at the right. On mobile the sidebar is
// a Sheet, so the shell carries the trigger back to the nav.
export function ListPage({
  title,
  description,
  action,
  children,
}: {
  title: string
  // One muted line under the title.
  description?: React.ReactNode
  // The primary action, top right. One button: `<Button size="sm"><Plus />Add …</Button>`.
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-8 md:px-8 md:py-10">
        <header className="flex items-start gap-3">
          <SidebarTrigger className="-mt-0.5 -ml-1 md:hidden" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-lg leading-7 font-semibold tracking-tight">{title}</h1>
            {description ? <p className="text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
        {children}
      </div>
    </div>
  )
}

// One list of several on a page (Settings): the same head as the page, one
// size down, over its own card.
export function ListSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

const CARD = "overflow-hidden rounded-xl border bg-card"

// The one bordered card that holds the rows. Up and Down move between rows.
// Home and End go to the first and the last row.
export function ListCard({ children, className, ...props }: React.ComponentProps<"ul">) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches("[data-row-main]")) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-main]")]
    const at = rows.indexOf(e.target)
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1
    if (to < 0 || to >= rows.length || to === at) return
    e.preventDefault()
    rows[to].focus()
  }
  return (
    <ul data-slot="list-card" onKeyDown={onKeyDown} className={cn("@container divide-y", CARD, className)} {...props}>
      {children}
    </ul>
  )
}

// One row. Every row of a list has the same parts in the same places: an icon
// tile, the name with its badges, one muted meta line, pills at the right, and
// the "…" menu. The whole row opens the detail (`onOpen`). The name is the
// button a keyboard lands on. The row never expands in place.
// A tooltip that opens only when the text in `ref` is cut.
function useCutTooltip(ref: React.RefObject<HTMLSpanElement | null>) {
  const [open, setOpen] = useState(false)
  const onOpenChange = (next: boolean) => setOpen(next && !!ref.current && ref.current.scrollWidth > ref.current.clientWidth)
  return { open, onOpenChange }
}

// The name of a row. It is the row's one focus stop when the row opens a
// detail. A name too long for the row ends in "…" and shows whole in a tooltip.
function RowTitle({ title, opens }: { title: string; opens: boolean }) {
  const text = useRef<HTMLSpanElement>(null)
  const cut = useCutTooltip(text)
  return (
    <Tooltip open={cut.open} onOpenChange={cut.onOpenChange}>
      <TooltipTrigger
        render={opens ? <button type="button" data-row-main aria-haspopup="dialog" /> : <span />}
        className="flex min-w-0 text-left text-sm leading-5 font-medium outline-none"
      >
        <span ref={text} className="truncate">
          {title}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start">{title}</TooltipContent>
    </Tooltip>
  )
}

export function ListRow({
  icon,
  title,
  name,
  badges,
  meta,
  trailing,
  menu,
  onOpen,
  active = false,
  className,
}: {
  // A lucide icon element. It sits in a neutral tile.
  icon?: React.ReactNode
  title: string
  // Shown as the name in place of `title`, such as a `ModulePill`. `title`
  // stays the row button's accessible name. Without `name` the row shows `title`.
  name?: React.ReactNode
  // Badges after the name: `<Badge variant="outline">Demo</Badge>`.
  badges?: React.ReactNode
  // The one muted line. Items are joined with a dot. A false item is skipped.
  // A JSX item needs a `key` (the lint rule asks for it).
  meta?: React.ReactNode[]
  // Pills at the right (`ModulePills`). They move under the meta line in a narrow card.
  trailing?: React.ReactNode
  // The "…" menu: `<RowMenu>…</RowMenu>`. Give every row of a list the same menu.
  menu?: React.ReactNode
  // Opens the row's detail in a Sheet or a Dialog.
  onOpen?: () => void
  // The row whose detail is open.
  active?: boolean
  className?: string
}) {
  const line = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false && m !== "")
  return (
    <li
      data-slot="list-row"
      data-active={active || undefined}
      onClick={onOpen}
      className={cn(
        "flex items-start gap-3 px-4 py-3 transition-colors first:rounded-t-[calc(var(--radius-xl)-1px)] last:rounded-b-[calc(var(--radius-xl)-1px)] data-active:bg-muted/50",
        onOpen && "cursor-pointer hover:bg-muted/50 has-[[data-row-main]:focus-visible]:bg-muted/50 has-[[data-row-main]:focus-visible]:ring-2 has-[[data-row-main]:focus-visible]:ring-ring/50 has-[[data-row-main]:focus-visible]:ring-inset",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-2 @xl:flex-row @xl:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {name == null ? (
              <RowTitle title={title} opens={!!onOpen} />
            ) : onOpen ? (
              <button type="button" data-row-main aria-haspopup="dialog" aria-label={title} className="flex min-w-0 text-left outline-none">
                {name}
              </button>
            ) : (
              <span className="flex min-w-0">{name}</span>
            )}
            {badges ? <span className="flex shrink-0 items-center gap-1.5">{badges}</span> : null}
          </div>
          {line.length ? (
            <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
              {Children.map(line, (m, i) => (
                <>
                  {i > 0 ? <span aria-hidden className="shrink-0 opacity-60">·</span> : null}
                  {isValidElement(m) ? m : <span className="shrink-0 whitespace-nowrap">{m}</span>}
                </>
              ))}
            </div>
          ) : null}
        </div>
        {trailing ? <div className="flex min-w-0 shrink-0 items-center @xl:max-w-[55%] @xl:justify-end">{trailing}</div> : null}
      </div>
      {menu}
    </li>
  )
}

// The "…" menu at the right of a row. Its children are `RowMenuItem`s. A click
// in the menu does not open the row.
export function RowMenu({ label = "More actions", children }: { label?: string; children: React.ReactNode }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div data-slot="row-menu" className="-mr-1.5 shrink-0 @xl:self-center" onClick={stop} onKeyDown={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground" />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export { DropdownMenuItem as RowMenuItem, DropdownMenuSeparator as RowMenuSeparator }

// Text that may not fit. It ends in "…" (or keeps its last characters with
// `middle`, for a URL, a path or a hash). The full value shows in a tooltip,
// only when the text is cut. A screen reader always gets the full value.
export function TruncatedText({
  text,
  middle = false,
  tail = 14,
  mono = false,
  className,
}: {
  text: string
  // Cut in the middle and keep the last `tail` characters.
  middle?: boolean
  tail?: number
  // A machine value: a URL, a path, a hash, an id.
  mono?: boolean
  className?: string
}) {
  const head = useRef<HTMLSpanElement>(null)
  const cut = useCutTooltip(head)
  const split = middle && text.length > tail * 2
  return (
    <Tooltip open={cut.open} onOpenChange={cut.onOpenChange}>
      <TooltipTrigger render={<span />} data-slot="truncated-text" className={cn("flex min-w-0", mono && "font-mono text-[0.92em]", className)}>
        <span ref={head} className="overflow-hidden text-ellipsis whitespace-pre">
          {split ? text.slice(0, -tail) : text}
        </span>
        {split ? <span className="shrink-0 whitespace-pre">{text.slice(-tail)}</span> : null}
      </TooltipTrigger>
      {/* Under the text and from its left edge: the full value reads as the
          same line, longer. Above, it would cover the row's own title. */}
      <TooltipContent side="bottom" align="start" className={cn("max-w-md break-all", mono && "font-mono text-[11px]")}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

// A list with nothing in it. It names what is missing and why, and never reads
// as "clean". `action` is the same primary action as the page's.
export function ListEmpty({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div data-slot="list-empty" className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
      {Icon ? (
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {children ? <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</p> : null}
      </div>
      {action}
    </div>
  )
}

// The card while the list loads: the row's own shape, so nothing jumps when
// the rows arrive.
export function ListLoading({ rows = 4, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div data-slot="list-loading" role="status" aria-busy="true" className={cn("divide-y", CARD)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="mt-1 size-8 shrink-0 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <Skeleton className="h-3.5" style={{ width: `${[38, 52, 30, 44][i % 4]}%` }} />
            <Skeleton className="h-3" style={{ width: `${[56, 40, 62, 48][i % 4]}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
