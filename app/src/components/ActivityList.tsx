import type { ReactNode } from "react"
import { ScrollArea, ThemedIcon } from "@graphical"
import type { FindingSummary, RunStatus, RunSummary, Severity } from "@/lib/types"
import { SeverityChip, formatDuration } from "./bits"

export interface Selection {
  kind: "run" | "finding"
  id: string
}

// Every row in the list is one thread, whether it is a live run still streaming
// or an older run we only have the recorded finding for. One shape, one row,
// one visual weight — like a chat harness where each thread is a conversation.
interface Thread {
  id: string
  code: string // the short mono handle shown under the title
  title: string
  status: RunStatus | null // null = history-only, no live stream to reattach
  severity: Severity | null
  proven: boolean
  dismissed: boolean
  ms: number | null
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  starting: "Starting…",
  running: "Agent working…",
  "awaiting-approval": "Proving…",
  deciding: "Recording…",
  recorded: "Recorded",
  denied: "Denied",
  "no-finding": "No exploit proven",
  error: "Did not finish",
}

function threadSub(t: Thread): string {
  if (t.dismissed) return "Dismissed"
  if (t.status && t.status !== "recorded") return RUN_STATUS_LABEL[t.status]
  if (t.proven) return "Proven by replay"
  return "Unproven"
}

// One mark vocabulary for every row: spinning while live, green check when the
// run is a counted finding, muted otherwise.
function ThreadMark({ t }: { t: Thread }) {
  const live = t.status === "starting" || t.status === "running" || t.status === "deciding" || t.status === "awaiting-approval"
  const counted = t.proven && !t.dismissed
  const color = live
    ? "text-(--cte-text-muted)"
    : counted
      ? "text-(--success)"
      : "text-(--cte-text-muted)"
  const icon = live
    ? "loader"
    : counted
      ? "check"
      : t.status === "error"
        ? "info"
        : t.dismissed
          ? "minus"
          : "document"
  return (
    <span className={`grid size-(--space-xl) shrink-0 place-items-center ${color}`}>
      <span className={live ? "motion-safe:animate-spin" : undefined}>
        <ThemedIcon name={icon} />
      </span>
    </span>
  )
}

function Row({ selected, onSelect, t }: {
  selected: boolean
  onSelect: () => void
  t: Thread
}) {
  const muted = t.dismissed
  return (
    <button
      type="button"
      onClick={onSelect}
      className="focus-ring flex w-full min-w-0 items-center gap-(--space-s) rounded-(--radius-m) p-(--space-m) text-left hover:bg-(--neutral-3)"
      style={selected ? { background: "var(--neutral-3)" } : undefined}
      aria-pressed={selected}
    >
      <ThreadMark t={t} />
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
        <span className={`type-s weight-medium truncate ${muted ? "text-(--cte-text-muted)" : "text-(--cte-text)"}`}>
          {t.title}
        </span>
        <span className="flex min-w-0 items-center gap-x-(--space-s) type-xxs text-(--cte-text-muted)">
          <span className="font-data shrink-0">{t.code}</span>
          <span className="truncate">{threadSub(t)}</span>
        </span>
      </span>
      {/* Fixed trailing columns so the duration and the severity pill sit at the
          same x on every row — the pill never shifts with the title's length. */}
      <span className="flex shrink-0 items-center justify-end gap-(--space-s)">
        <span className="w-[44px] text-right font-data type-xxs text-(--cte-text-muted)">
          {t.ms != null ? formatDuration(t.ms) : null}
        </span>
        <span className="flex w-[60px] justify-end">
          {t.severity ? <SeverityChip severity={t.severity} proven={t.proven && !t.dismissed} /> : null}
        </span>
      </span>
    </button>
  )
}

export function ActivityList({ launcher, runs, findings, selected, onSelect }: {
  launcher: ReactNode
  runs: RunSummary[]
  findings: FindingSummary[]
  selected: Selection | null
  onSelect: (sel: Selection) => void
}) {
  const findingById = new Map(findings.map((f) => [f.id, f]))
  const runIds = new Set(runs.map((r) => r.id))

  // Live runs first (newest-first as the app prepends them), then the older
  // recorded runs we only know from history. A live run folds in whatever its
  // recorded finding already knows (title, dismissed) so a reload never changes
  // a row's shape.
  const threads: Thread[] = [
    ...runs.map((r): Thread => {
      const f = findingById.get(r.id)
      return {
        id: r.id,
        code: r.id,
        title: r.title ?? f?.title ?? "Live run",
        status: r.status,
        severity: r.severity ?? f?.severity ?? null,
        proven: f?.proven ?? r.status === "recorded",
        dismissed: f?.dismissed ?? false,
        ms: f?.ms ?? null,
      }
    }),
    ...findings
      .filter((f) => !runIds.has(f.id))
      .map((f): Thread => ({
        id: f.id,
        code: f.id,
        title: f.title,
        status: null,
        severity: f.severity,
        proven: f.proven,
        dismissed: f.dismissed,
        ms: f.ms,
      })),
  ]

  return (
    <section className="activity-pane flex min-h-0 min-w-0 flex-col" aria-label="Runs">
      <div className="divide-bottom p-(--space-xl)">{launcher}</div>
      <ScrollArea.Root className="workspace-scroll min-h-0 flex-1">
        <ScrollArea.Viewport aria-label="Runs" className="h-full">
          <ScrollArea.Content style={{ minWidth: 0 }}>
            <div className="flex flex-col gap-(--space-xs) px-(--space-m) py-(--space-l)">
              {threads.length === 0 ? (
                <p className="px-(--space-m) py-(--space-s) type-xs text-(--cte-text-muted)">
                  No runs yet. Start one above.
                </p>
              ) : (
                threads.map((t) => (
                  <Row
                    key={t.id}
                    selected={selected?.id === t.id}
                    onSelect={() => onSelect({ kind: t.status ? "run" : "finding", id: t.id })}
                    t={t}
                  />
                ))
              )}
            </div>
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </section>
  )
}
