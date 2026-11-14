import type { PrepassLead, PrepassView } from "@/lib/types"
import { Check, Minus } from "lucide-react"
import { cn } from "cn"
import { DataTable, type DataColumn } from "@/components/assistant-ui/elements/data-table"
import { mono } from "@/components/assistant-ui/elements/surfaces"

// What the pack's tools found before the agent started. It lives inside the
// run's setup card, the same for every pack. Leads are hints for the agent,
// not findings, so it is neutral: no green, no red. Only a replay earns a colour.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// Severity sorts by rank, worst first on the first click. Unknown text sorts last.
const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4, info: 4 }
const rank = (impact: string) => RANK[impact.toLowerCase()] ?? 5

// Severity reads by weight, not colour: a dot that is darker the worse it is.
const DOT = ["bg-foreground", "bg-foreground/80", "bg-foreground/55", "bg-foreground/35", "bg-foreground/20", "bg-foreground/20"]

// A scanner path arrives as "/a/b.js (+6 more)". Split the count off, so the
// path can truncate and the count still shows.
const splitWhere = (where: string) => {
  const m = /^(.*?)\s*\(\+(\d+) more\)$/.exec(where)
  return m ? { path: m[1], more: Number(m[2]) } : { path: where, more: 0 }
}

// "10038 · CWE-693" shows as the CWE on top and the rule id under it.
const splitRule = (rule: string) => {
  const parts = rule.split(" · ")
  const cwe = parts.find((p) => /^CWE-/i.test(p))
  return { cwe, ids: parts.filter((p) => p !== cwe) }
}

const chip = cn(mono, "inline-flex items-center rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[11px] text-muted-foreground dark:bg-foreground/[0.07]")

// One row per lead: the finding, its severity, where it is, the scanner's
// rule id and CWE, and the tool that reported it.
const LEAD_COLUMNS: DataColumn<PrepassLead>[] = [
  {
    key: "check",
    label: "Finding",
    className: "w-full min-w-[14rem]",
    cell: (l) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium leading-snug text-foreground">{l.check || "Lead"}</span>
        {l.detail ? <span className="break-words leading-snug text-muted-foreground">{l.detail}</span> : null}
      </div>
    ),
  },
  {
    key: "impact",
    label: "Severity",
    sortValue: (l) => rank(l.impact),
    className: "whitespace-nowrap",
    cell: (l) =>
      l.impact ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 py-0.5 pr-2 pl-1.5 text-[11px] text-foreground/80">
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[rank(l.impact)])} />
          {l.impact}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "where",
    label: "Path",
    className: "whitespace-nowrap",
    cell: (l) => {
      if (!l.where) return <span className="text-muted-foreground">—</span>
      const { path, more } = splitWhere(l.where)
      return (
        <div className="flex max-w-[16rem] items-center gap-1.5" title={l.where}>
          <span className={cn(mono, "min-w-0 truncate text-foreground/80")}>{path}</span>
          {more > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground">+{more}</span> : null}
        </div>
      )
    },
  },
  {
    key: "rule",
    label: "Rule",
    sortValue: (l) => l.rule ?? "",
    className: "whitespace-nowrap",
    cell: (l) => {
      if (!l.rule) return <span className="text-muted-foreground">—</span>
      const { cwe, ids } = splitRule(l.rule)
      return (
        <div className={cn(mono, "flex flex-col gap-0.5 text-[11px] leading-snug")}>
          {cwe ? <span className="text-foreground/80">{cwe}</span> : null}
          {ids.length ? <span className="text-muted-foreground">{ids.join(" · ")}</span> : null}
        </div>
      )
    },
  },
  {
    key: "tools",
    label: "Tool",
    sortValue: (l) => l.tools.join(" + "),
    className: "whitespace-nowrap",
    cell: (l) => (
      <div className="flex flex-wrap items-center gap-1">
        {l.tools.length ? l.tools.map((t) => <span key={t} className={chip}>{t}</span>) : <span className="text-muted-foreground">—</span>}
        {l.corroborated ? <span className="text-[11px] text-muted-foreground">corroborated</span> : null}
      </div>
    ),
  },
]

// The tool scan's detail, shown inside the run's setup card: one row per tool,
// in the setup card's row style, then the leads table. A scan that did not
// finish says so in one line.
export function PrepassDetail({ prepass }: { prepass: PrepassView }) {
  if (prepass.failed) {
    return (
      <p className="border-t border-foreground/[0.06] px-3.5 py-2.5 text-xs text-muted-foreground">
        Tool scan did not finish. The agent worked from the source alone.
      </p>
    )
  }
  const hidden = prepass.total - prepass.leads.length
  return (
    <div className="flex flex-col border-t border-foreground/[0.06]">
      <ul className="flex flex-col py-1">
        {prepass.tools.map((t, i) => {
          const Icon = t.status === "ran" ? Check : Minus
          return (
            <li key={`${t.name}-${i}`} className="flex items-center gap-2.5 px-3.5 py-1.5">
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <Icon aria-hidden className="size-3 text-muted-foreground" />
              </span>
              <span className={cn(mono, "shrink-0 text-foreground/80")}>{t.pack ? `${t.pack} · ` : ""}{t.name}</span>
              {/* A ran row's caveat ("7 of 8 operations errored") follows the
                  lead count and wraps, so a partial run never reads as clean. */}
              <span className={cn("min-w-0 flex-1 text-xs text-muted-foreground", t.status === "ran" && t.reason ? "break-words" : "truncate")}>
                {t.status === "ran" ? `${plural(t.leads, "lead")}${t.reason ? ` · ${t.reason}` : ""}` : `Unavailable${t.reason ? ` · ${t.reason}` : ""}`}
              </span>
            </li>
          )
        })}
      </ul>
      {(prepass.toolsTotal ?? 0) > prepass.tools.length ? (
        <p className="px-3.5 pb-3 text-[11px] text-muted-foreground">Showing {prepass.tools.length} of {prepass.toolsTotal} tools. Full coverage is kept in the run record.</p>
      ) : null}
      {prepass.leads.length > 0 ? (
        <div className="px-3.5 pb-3">
          <DataTable columns={LEAD_COLUMNS} rows={prepass.leads} rowKey={(_, i) => String(i)} />
        </div>
      ) : null}
      {hidden > 0 ? (
        <p className="px-3.5 pb-3 text-[11px] text-muted-foreground">{plural(hidden, "more lead")} not shown.</p>
      ) : null}
    </div>
  )
}
