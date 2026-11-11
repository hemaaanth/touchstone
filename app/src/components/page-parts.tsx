import type { LucideIcon } from "lucide-react"
import type { ScopedRun } from "@/lib/catalog"
import { ago, DOT, statusLabel, statusTone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"

// Shared parts for the single-item nav pages (Modules, Scopes, Playbooks).

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

// The note under a page that counts runs: which runs it could not place.
export function UncountedNote({ loading, unscoped }: { loading: number; unscoped: number }) {
  if (!loading && !unscoped) return null
  const parts = [
    loading ? `${loading} ${loading === 1 ? "run is" : "runs are"} still loading` : null,
    unscoped ? `${unscoped} older ${unscoped === 1 ? "run records" : "runs record"} no scope` : null,
  ].filter(Boolean)
  return <p className="mt-3 text-[11px] text-muted-foreground">Not counted: {parts.join("; ")}.</p>
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
            <span className="min-w-0 flex-1 truncate text-xs">{(run.title ?? run.alias).replaceAll("`", "")}</span>
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
