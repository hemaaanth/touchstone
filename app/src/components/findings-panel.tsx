import { ShieldCheck, CircleDot } from "lucide-react"
import type { FindingSummary } from "@/lib/types"
import { severityTone, DOT } from "@/lib/format"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"

// The right rail. Every recorded finding is an artifact card: a proven exploit
// against the operator's own code. Green only ever shows here because a finding
// reaches this list only after a deterministic Foundry replay proved it, so the
// one green accent keeps its single meaning (restraint.md).
export function FindingsPanel({
  findings,
  selectedId,
  onSelect,
}: {
  findings: FindingSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const live = findings.filter((f) => !f.dismissed)

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <ShieldCheck className="size-4 text-emerald-500" />
        <h2 className="text-sm font-semibold">Findings</h2>
        <Badge variant="secondary" className="ml-auto tabular-nums">
          {live.length}
        </Badge>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {live.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No proven findings yet. A finding lands here only after a replay reproduces it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {live.map((f) => (
              <li key={f.id}>
                <FindingCard finding={f} active={f.id === selectedId} onSelect={() => onSelect(f.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

function FindingCard({
  finding,
  active,
  onSelect,
}: {
  finding: FindingSummary
  active: boolean
  onSelect: () => void
}) {
  const tone = severityTone(finding.severity)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
        "hover:bg-accent/50",
        active && "border-primary bg-accent/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", DOT[tone])} />
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug">{finding.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-3.5">
        <Badge variant="outline" className="capitalize">
          {finding.severity}
        </Badge>
        <Badge variant="secondary" className="font-mono text-[11px]">
          {finding.module}
        </Badge>
        {finding.proven ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-500">
            <CircleDot className="size-3" />
            Proven by replay
          </span>
        ) : null}
      </div>
    </button>
  )
}
