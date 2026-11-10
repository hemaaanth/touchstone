import { useState } from "react"
import { ScrollArea, Separator, Tabs } from "@graphical"
import type { Finding } from "@/lib/types"
import { reduceEvents } from "@/lib/runModel"
import { DismissControl, SeverityChip } from "./bits"
import { ReplayProof } from "./ReplayProof"
import { RunTimeline } from "./RunTimeline"

// The detail panel for a recorded finding. It is a plain surface, not the modal
// @graphical Drawer — the review lives beside the queue, always visible, never a
// popup. It carries the SAME Conversation / Report tabs a live run shows, so
// reopening a finished run is never a dead end: the Report is the printed proof,
// and the Conversation replays the agent's own transcript read-only.
export function FindingDrawer({
  finding,
  dismissBusy = false,
  onToggleDismiss,
}: {
  finding: Finding | null
  dismissBusy?: boolean
  onToggleDismiss: (next: boolean) => void
}) {
  // A finished finding opens on its Report — the proof is the point — and the
  // operator steps back to Conversation to see how the agent got there.
  const [tab, setTab] = useState<string>("report")

  if (!finding) {
    return (
      <aside className="detail-pane grid place-items-center p-(--space-xl)">
        <p className="type-xs text-(--cte-text-muted)">Select a finding to see its replay proof.</p>
      </aside>
    )
  }

  const steps = reduceEvents(finding.events ?? []).steps

  return (
    <aside className="detail-pane flex-col" aria-label="Finding detail">
      <Tabs.Root value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-col gap-(--space-s) p-(--space-xl) pb-(--space-m)">
          <span className="font-data type-xxs text-(--cte-text-muted)">
            {finding.module} · {finding.target} · {finding.id}
          </span>
          <h2 className="type-l weight-medium text-(--cte-text)">{finding.title}</h2>
          <div className="flex items-center gap-(--space-s)">
            <SeverityChip severity={finding.severity} proven={finding.stages.proven} />
          </div>
        </header>

        <div className="px-(--space-xl) pb-(--space-s)">
          <Tabs.List>
            <Tabs.Tab value="conversation">Conversation</Tabs.Tab>
            <Tabs.Tab value="report">Report</Tabs.Tab>
          </Tabs.List>
        </div>

        {/* Conversation — the agent's saved transcript, replayed read-only. */}
        <Tabs.Panel value="conversation" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea.Root className="workspace-scroll min-h-0 flex-1">
            <ScrollArea.Viewport className="h-full" aria-label="Conversation">
              <ScrollArea.Content style={{ minWidth: 0 }}>
                {steps.length > 0 ? (
                  <div className="flex flex-col gap-(--space-m) px-(--space-xl) py-(--space-m)">
                    <RunTimeline steps={steps} />
                  </div>
                ) : (
                  <div className="p-(--space-xl)">
                    <p className="type-xs text-(--cte-text-muted)">No transcript was saved for this run.</p>
                  </div>
                )}
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical">
              <ScrollArea.Thumb />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
          <p className="shrink-0 divide-top px-(--space-xl) py-(--space-m) type-xxs text-(--cte-text-muted)">
            This run has finished. The transcript is read-only.
          </p>
        </Tabs.Panel>

        {/* Report — the printed proof and the one quiet ledger override. */}
        <Tabs.Panel value="report" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea.Root className="workspace-scroll min-h-0 flex-1">
            <ScrollArea.Viewport className="h-full" aria-label="Report">
              <ScrollArea.Content style={{ minWidth: 0 }}>
                <div className="flex flex-col gap-(--space-l) p-(--space-xl)">
                  <ReplayProof finding={finding} />
                  <Separator />
                  <DismissControl dismissed={finding.dismissed} busy={dismissBusy} onToggle={onToggleDismiss} />
                </div>
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
