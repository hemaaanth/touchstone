import type { PrepassLead, PrepassView } from "@/lib/types"
import { Fold } from "@/components/proof-parts"
import { DataTable, type DataColumn } from "@/components/assistant-ui/elements/data-table"
import { mono } from "@/components/assistant-ui/elements/surfaces"

// What the pack's tools found before the agent started: one closed fold, the
// same for every pack. Leads are hints for the agent, not findings, so the
// fold is neutral: no green, no red. Only a replay earns a colour.

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

export function PrepassFold({ prepass }: { prepass: PrepassView }) {
  if (prepass.failed) {
    return (
      <div className="py-1 text-xs text-muted-foreground">
        Tool scan did not finish. The agent worked from the source alone.
      </div>
    )
  }
  const ran = prepass.tools.filter((t) => t.status === "ran").length
  const label =
    `Tool scan · ${plural(prepass.tools.length, "tool")}` +
    (prepass.tools.length > ran ? ` (${ran} ran)` : "") +
    ` · ${plural(prepass.total, "lead")}`
  const hidden = prepass.total - prepass.leads.length
  return (
    <Fold label={label}>
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-1.5">
          {prepass.tools.map((t, i) => (
            <li key={`${t.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium text-foreground">{t.name}</span>
              <span className="min-w-0 break-words text-muted-foreground">
                {t.status === "ran"
                  ? `ran · ${plural(t.leads, "lead")}${t.reason ? ` · ${t.reason}` : ""}`
                  : `unavailable${t.reason ? ` · ${t.reason}` : ""}`}
              </span>
            </li>
          ))}
        </ul>
        {prepass.leads.length > 0 ? (
          <DataTable columns={LEAD_COLUMNS} rows={prepass.leads} rowKey={(_, i) => String(i)} />
        ) : null}
        {hidden > 0 ? <span className="text-[11px] text-muted-foreground">{plural(hidden, "more lead")} not shown.</span> : null}
      </div>
    </Fold>
  )
}
