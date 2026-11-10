import { useEffect, useRef, useState } from "react"
import { ScrollArea, Separator, Tabs, ThemedIcon } from "@graphical"
import type { Finding, PendingApproval, RunStatus } from "@/lib/types"
import { dismissFinding, fetchFinding } from "@/lib/api"
import { useRun } from "@/lib/runModel"
import { DismissControl, SeverityChip } from "./bits"
import { RunTimeline } from "./RunTimeline"
import { ReplayProof } from "./ReplayProof"
import { Composer } from "./Composer"
import { PipelineStrip } from "./PipelineStrip"

const STATUS_LABEL: Record<RunStatus, string> = {
  starting: "Starting",
  running: "Agent working",
  "awaiting-approval": "Proving",
  deciding: "Recording",
  recorded: "Recorded",
  denied: "Denied",
  "no-finding": "No finding",
  error: "Error",
}

// A run is over once it has settled one way or another. Terminal runs open on
// the Report tab and their composer is retired.
const TERMINAL = new Set<RunStatus>(["recorded", "denied", "no-finding", "error"])

function StatusBadge({ status }: { status: RunStatus }) {
  const live =
    status === "running" ||
    status === "starting" ||
    status === "deciding" ||
    status === "awaiting-approval"
  return (
    <span
      className="inline-flex items-center gap-(--space-xs) rounded-(--radius-s) px-(--space-xs) py-(--space-xxs) type-xxs weight-medium"
      style={{
        color: "var(--cte-text-muted)",
        background: "var(--neutral-4)",
      }}
    >
      {live ? (
        <span className="motion-safe:animate-spin">
          <ThemedIcon name="loader" />
        </span>
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  )
}

// The Report tab before there is a report: the agent is still working, so the
// proof has nothing to print yet. A quiet placeholder, not an empty pane.
function ReportPending() {
  return (
    <div className="grid h-full place-items-center p-(--space-xl)">
      <div className="flex max-w-[34ch] flex-col items-center gap-(--space-s) text-center">
        <span className="text-(--cte-text-muted)">
          <ThemedIcon name="info" />
        </span>
        <p className="type-s weight-medium text-(--cte-text)">No report yet</p>
        <p className="type-xs text-(--cte-text-muted)">
          The proof prints here the moment the agent proves an exploit by replay — or rules one out. Watch it work in
          Conversation.
        </p>
      </div>
    </div>
  )
}

export function RunView({
  runId,
  initialStatus,
  onStatus,
  onDismissChanged,
}: {
  runId: string
  // The status the list already knows for this run. Reopening a finished run
  // restarts its event stream, so the reducer reads "starting" for one tick
  // before the replay lands — we show the known status instead of flashing it.
  initialStatus?: RunStatus | null
  // Report every status change upward so the activity list and spend ledger
  // stay current without opening a second event stream for the same run.
  onStatus?: (status: RunStatus, pending: PendingApproval | null) => void
  // A recorded run was dismissed or restored — let the parent refresh the list.
  onDismissChanged?: () => void
}) {
  const run = useRun(runId)
  const seen = useRef<RunStatus | null>(null)
  const liveStatus = run?.status ?? null
  const livePending = run?.pending ?? null
  // Before the stream replays, trust the status the list handed us so a reopened
  // run shows its real state at once instead of a momentary "Starting".
  const effStatus: RunStatus | null =
    liveStatus === "starting" && initialStatus ? initialStatus : liveStatus
  useEffect(() => {
    if (effStatus && effStatus !== seen.current) {
      seen.current = effStatus
      onStatus?.(effStatus, livePending)
    }
  }, [effStatus, livePending, onStatus])

  // Which tab is showing. A run opened already-finished starts on Report; a live
  // run starts on Conversation and auto-advances to Report once, when it settles.
  const startTerminal = Boolean(initialStatus && TERMINAL.has(initialStatus))
  const [tab, setTab] = useState<string>(startTerminal ? "report" : "conversation")
  const advanced = useRef(startTerminal)
  useEffect(() => {
    if (effStatus && TERMINAL.has(effStatus) && !advanced.current) {
      advanced.current = true
      setTab("report")
    }
  }, [effStatus])

  // A proven run records itself, so its full proof lands at /api/findings/:id
  // within a couple of seconds. Load it the moment the run is recorded and show
  // the same replay proof the history shows, in place.
  const [finding, setFinding] = useState<Finding | null>(null)
  const [dismissBusy, setDismissBusy] = useState(false)
  useEffect(() => {
    if (effStatus !== "recorded") {
      setFinding(null)
      return
    }
    let live = true
    const tick = () =>
      fetchFinding(runId)
        .then((f) => live && setFinding(f))
        .catch(() => {
          // The file is written as the decide child exits; retry briefly.
          if (live) setTimeout(tick, 400)
        })
    tick()
    return () => {
      live = false
    }
  }, [effStatus, runId])

  const toggleDismiss = (next: boolean) => {
    setDismissBusy(true)
    dismissFinding(runId, next)
      .then(() => fetchFinding(runId))
      .then(setFinding)
      .catch(() => {})
      .finally(() => {
        setDismissBusy(false)
        onDismissChanged?.()
      })
  }

  if (!run) return null

  const { steps, scope, pending, error, finalText } = run

  // What resource is this run pointed at? A live run learns it from its `scope`
  // event; a recorded finding reopened later (whose saved transcript predates
  // that event) falls back to the stored target label. Never the old hardcoded
  // "Vault.sol" — that was the same-for-every-run lie we are removing.
  const KIND_LABEL: Record<string, string> = {
    lab: "Lab",
    "local-source": "Local source",
    brief: "Brief",
  }
  const resourceLine = scope
    ? `${KIND_LABEL[scope.kind] ?? "Scope"} · ${scope.entry} · ${runId}`
    : finding
      ? `${finding.target} · ${runId}`
      : runId
  const status: RunStatus = run.status === "starting" && initialStatus ? initialStatus : run.status
  const stages = finding ? finding.stages : run.stages
  const steerable = status === "running"
  const recorded = status === "recorded"

  // The quiet line under the transcript when the composer is retired, so a dead
  // control never sits under the cursor — the pane says why instead.
  const transcriptNote =
    status === "awaiting-approval" || status === "deciding"
      ? "The agent is finishing up — steering is paused."
      : TERMINAL.has(status)
        ? "This run has finished. The transcript is read-only."
        : "Warming up the sandbox…"

  return (
    <aside className="detail-pane flex-col" aria-label="Run detail">
      <Tabs.Root
        value={tab}
        onValueChange={(v) => setTab(String(v))}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header className="flex flex-col gap-(--space-s) p-(--space-xl) pb-(--space-m)">
          <span className="font-data type-xxs text-(--cte-text-muted)">
            {resourceLine}
          </span>
          <h2 className="type-l weight-medium text-(--cte-text)">
            {pending?.title ?? finding?.title ?? "Live run"}
          </h2>
          <div className="flex items-center gap-(--space-s)">
            <StatusBadge status={status} />
            {pending ? <SeverityChip severity={pending.severity} proven={stages.proven} /> : null}
          </div>
        </header>

        <PipelineStrip run={run} finding={finding} />

        <div className="px-(--space-xl) pb-(--space-s)">
          <Tabs.List>
            <Tabs.Tab value="conversation">Conversation</Tabs.Tab>
            <Tabs.Tab value="report">Report</Tabs.Tab>
          </Tabs.List>
        </div>

        {/* Conversation — the live transcript, with the steering composer pinned
            at the foot while the agent is working. This is where the messy, raw
            activity belongs; the Report stays pristine. */}
        <Tabs.Panel value="conversation" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea.Root className="workspace-scroll min-h-0 flex-1">
            <ScrollArea.Viewport className="h-full" aria-label="Conversation">
              <ScrollArea.Content style={{ minWidth: 0 }}>
                <div className="flex flex-col gap-(--space-m) px-(--space-xl) py-(--space-m)">
                  <RunTimeline steps={steps} />
                </div>
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical">
              <ScrollArea.Thumb />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
          {steerable ? (
            <Composer runId={runId} />
          ) : (
            <p className="shrink-0 divide-top px-(--space-xl) py-(--space-m) type-xxs text-(--cte-text-muted)">
              {transcriptNote}
            </p>
          )}
        </Tabs.Panel>

        {/* Report — the printed proof. Empty until the run settles, then the
            replay proof (or the honest no-finding / error note) and the one
            quiet ledger override. */}
        <Tabs.Panel value="report" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea.Root className="workspace-scroll min-h-0 flex-1">
            <ScrollArea.Viewport className="h-full" aria-label="Report">
              <ScrollArea.Content style={{ minWidth: 0 }}>
                {error ? (
                  <div className="p-(--space-xl)">
                    <div className="flex items-start gap-(--space-s) rounded-(--radius-m) bg-(--neutral-2) p-(--space-m)">
                      <span className="text-(--cte-text-muted)">
                        <ThemedIcon name="info" />
                      </span>
                      <div className="flex flex-col gap-(--space-xxs)">
                        <span className="type-s weight-medium text-(--cte-text)">The run did not finish</span>
                        <pre className="whitespace-pre-wrap font-data type-xxs text-(--cte-text-muted)">{error}</pre>
                      </div>
                    </div>
                  </div>
                ) : status === "no-finding" ? (
                  <div className="p-(--space-xl)">
                    <div className="flex flex-col gap-(--space-s) rounded-(--radius-m) bg-(--neutral-2) p-(--space-m)">
                      <span className="type-s weight-medium text-(--cte-text)">No exploit proven</span>
                      <p className="type-xs text-(--cte-text-muted)">
                        The agent audited the contract but could not prove a fund-moving exploit. Nothing is recorded —
                        only a passing replay counts.
                      </p>
                      {finalText ? <p className="type-xs text-(--cte-text-muted)">{finalText}</p> : null}
                    </div>
                  </div>
                ) : recorded ? (
                  finding ? (
                    <div className="flex flex-col gap-(--space-l) p-(--space-xl)">
                      <ReplayProof finding={finding} />
                      <Separator />
                      <DismissControl dismissed={finding.dismissed} busy={dismissBusy} onToggle={toggleDismiss} />
                    </div>
                  ) : (
                    <div className="flex items-center gap-(--space-s) p-(--space-xl) type-xs text-(--cte-text-muted)">
                      <span className="motion-safe:animate-spin">
                        <ThemedIcon name="loader" />
                      </span>
                      Writing the finding…
                    </div>
                  )
                ) : (
                  <ReportPending />
                )}
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical">
              <ScrollArea.Thumb />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  )
}
