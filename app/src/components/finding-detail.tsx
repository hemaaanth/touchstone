import { useEffect, useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import type { Finding, Severity } from "@/lib/types"
import { fetchFinding, dismissFinding } from "@/lib/api"
import { getFixtureFinding } from "@/lib/fixtures"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ReplayProof } from "./replay-proof"

const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
}

// Red is reserved for a proven finding; a high/critical that a replay proved
// earns the danger tone, lower severities stay neutral. One accent meaning.
function SeverityChip({ severity, proven }: { severity: Severity; proven: boolean }) {
  const danger = proven && (severity === "critical" || severity === "high")
  return (
    <Badge
      variant="outline"
      className={cn(danger && "border-destructive/40 bg-destructive/10 text-destructive")}
    >
      {SEV_LABEL[severity]}
    </Badge>
  )
}

// The quiet ledger override. A proven run records itself; this flips a recorded
// finding to "not a finding I count" (or restores it). It never touches the
// proof — only how the finding reads. For a fixture finding it toggles the label
// locally; for a real one it persists through the API and rolls back on failure.
function DismissControl({
  id,
  fixture,
  dismissed,
  onChange,
}: {
  id: string
  fixture: boolean
  dismissed: boolean
  onChange: (next: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const toggle = (next: boolean) => {
    onChange(next)
    if (fixture) return
    setBusy(true)
    dismissFinding(id, next)
      .catch(() => onChange(!next))
      .finally(() => setBusy(false))
  }
  if (dismissed) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Not counted</Badge>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(false)}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Restore to recorded
        </Button>
      </div>
    )
  }
  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(true)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Don't count this finding
    </Button>
  )
}

// The full-column detail for a recorded finding: the restored printed report.
// Opened by clicking a run's proven proof card, it replaces the chat in the same
// column with a back header so the operator never leaves the one workspace — the
// run's conversation sits one click behind it. The report is the proof itself;
// the live chat already is the conversation, so this view is Report-only.
export function FindingDetail({ findingId, onBack }: { findingId: string; onBack: () => void }) {
  const [finding, setFinding] = useState<Finding | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A fixture id resolves to its canned finding and never hits the backend — the
  // ledger write would 404. Real findings load (and dismiss) through the API.
  const fixture = import.meta.env.DEV ? getFixtureFinding(findingId) : null

  useEffect(() => {
    setFinding(null)
    setError(null)
    if (fixture) {
      setFinding(fixture)
      return
    }
    let live = true
    fetchFinding(findingId)
      .then((f) => {
        if (live) setFinding(f)
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
    // fixture is derived from findingId; depending on findingId alone is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingId])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back to run
        </Button>
        <span className="truncate text-sm font-medium">{finding?.title ?? "Finding"}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {finding ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {finding.module} · {finding.target} · {finding.id}
                </span>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-medium text-foreground">{finding.title}</h2>
                  <SeverityChip severity={finding.severity} proven={finding.stages.proven} />
                </div>
              </div>

              <ReplayProof finding={finding} />
              <Separator />
              <DismissControl
                id={finding.id}
                fixture={!!fixture}
                dismissed={finding.dismissed}
                onChange={(next) => setFinding((f) => (f ? { ...f, dismissed: next } : f))}
              />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">Could not load this finding: {error}</p>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading the replay proof…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
