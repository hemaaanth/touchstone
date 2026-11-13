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

// One row per lead: the finding, its severity, where it is, the scanner's
// rule id and CWE, and the tool that reported it.
const LEAD_COLUMNS: DataColumn<PrepassLead>[] = [
  {
    key: "check",
    label: "Finding",
    className: "min-w-[12rem]",
    cell: (l) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">{l.check || "Lead"}</span>
        {l.detail ? <span className="break-words text-muted-foreground">{l.detail}</span> : null}
      </div>
    ),
  },
  {
    key: "impact",
    label: "Severity",
    sortValue: (l) => rank(l.impact),
    className: "whitespace-nowrap text-muted-foreground",
    cell: (l) => l.impact || "—",
  },
  {
    key: "where",
    label: "Path",
    className: `${mono} break-all text-muted-foreground`,
    cell: (l) => l.where || "—",
  },
  {
    key: "rule",
    label: "Rule / CWE",
    sortValue: (l) => l.rule ?? "",
    className: `${mono} whitespace-nowrap text-muted-foreground`,
    cell: (l) => l.rule || "—",
  },
  {
    key: "tools",
    label: "Tool",
    sortValue: (l) => l.tools.join(" + "),
    className: "whitespace-nowrap text-muted-foreground",
    cell: (l) => (
      <span>
        {l.tools.join(" + ") || "—"}
        {l.corroborated ? <span className="text-muted-foreground/70"> · corroborated</span> : null}
      </span>
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
              <span className={cn(mono, "shrink-0 text-foreground/80")}>{t.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {t.status === "ran" ? plural(t.leads, "lead") : `Unavailable${t.reason ? ` · ${t.reason}` : ""}`}
              </span>
            </li>
          )
        })}
      </ul>
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
