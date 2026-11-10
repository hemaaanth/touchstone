import { useCallback, useEffect, useState } from "react"
import type {
  Finding,
  FindingSummary,
  ModelChoice,
  PendingApproval,
  ProviderInfo,
  RunStatus,
  RunSummary,
  SpendState,
  TargetChoice,
} from "@/lib/types"
import { dismissFinding, fetchFinding, fetchFindings, fetchModels, fetchRuns, startRun } from "@/lib/api"
import { Sidebar } from "@/components/Sidebar"
import { ActivityList, type Selection } from "@/components/ActivityList"
import { RunLauncher } from "@/components/RunLauncher"
import { RunView } from "@/components/RunView"
import { FindingDrawer } from "@/components/FindingDrawer"

const TERMINAL: RunStatus[] = ["recorded", "denied", "no-finding", "error"]

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [targets, setTargets] = useState<TargetChoice[]>([])
  const [spend, setSpend] = useState<SpendState | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [findings, setFindings] = useState<FindingSummary[]>([])
  const [selected, setSelected] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<Finding | null>(null)

  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [dismissBusy, setDismissBusy] = useState(false)

  const refreshModels = useCallback(() => {
    fetchModels()
      .then(({ models, targets, spend, provider }) => {
        setModels(models)
        setTargets(targets)
        setSpend(spend)
        setProvider(provider)
      })
      .catch(() => {})
  }, [])

  const refreshFindings = useCallback(
    () => fetchFindings().then(setFindings).catch(() => {}),
    [],
  )

  // Load everything once. Land on the newest live run if there is one, else the
  // newest recorded finding, so the stage is never empty when there is work.
  useEffect(() => {
    let live = true
    refreshModels()
    Promise.all([fetchRuns().catch(() => [] as RunSummary[]), fetchFindings().catch(() => [] as FindingSummary[])]).then(
      ([runList, findingList]) => {
        if (!live) return
        setRuns(runList)
        setFindings(findingList)
        setSelected((cur) => {
          if (cur) return cur
          if (runList.length > 0) return { kind: "run", id: runList[0].id }
          if (findingList.length > 0) return { kind: "finding", id: findingList[0].id }
          return null
        })
      },
    )
    return () => {
      live = false
    }
  }, [refreshModels])

  // Load the full proof for a selected recorded finding.
  useEffect(() => {
    if (selected?.kind !== "finding") {
      setDetail(null)
      return
    }
    let live = true
    fetchFinding(selected.id)
      .then((f) => live && setDetail(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [selected])

  const onStart = useCallback(
    (alias: string, targetId?: string) => {
      setBusy(true)
      setStartError(null)
      startRun(alias, targetId)
        .then((run) => {
          setRuns((prev) => [
            { id: run.id, alias: run.alias, status: run.status, startedAt: run.startedAt, title: null, severity: null },
            ...prev.filter((r) => r.id !== run.id),
          ])
          setSelected({ kind: "run", id: run.id })
          refreshModels()
        })
        .catch((err: unknown) => setStartError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    },
    [refreshModels],
  )

  // Flip the open finding to dismissed (or restore it) and refresh so its row
  // and the sidebar count follow. The proof is untouched — this is ledger only.
  const onToggleDismiss = useCallback(
    (next: boolean) => {
      if (selected?.kind !== "finding") return
      const id = selected.id
      setDismissBusy(true)
      dismissFinding(id, next)
        .then(() => fetchFinding(id))
        .then(setDetail)
        .catch(() => {})
        .finally(() => {
          setDismissBusy(false)
          refreshFindings()
        })
    },
    [selected, refreshFindings],
  )

  // The selected run's live stream flows through RunView; it reports each status
  // change here so the activity row, spend meter, and history stay current.
  const onRunStatus = useCallback(
    (id: string, status: RunStatus, pending: PendingApproval | null) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status, title: pending?.title ?? r.title, severity: pending?.severity ?? r.severity }
            : r,
        ),
      )
      if (TERMINAL.includes(status)) {
        refreshModels()
        if (status === "recorded") refreshFindings()
      }
    },
    [refreshModels, refreshFindings],
  )

  const activeDetail = detail && selected?.kind === "finding" && detail.id === selected.id ? detail : null

  return (
    <div className="operator-shell">
      <Sidebar findingCount={findings.filter((f) => !f.dismissed).length} spend={spend} provider={provider} />
      <main className="operator-workspace" aria-label="Activity workspace">
        <ActivityList
          launcher={
            <RunLauncher
              models={models}
              targets={targets}
              spend={spend}
              busy={busy}
              error={startError}
              onStart={onStart}
            />
          }
          runs={runs}
          findings={findings}
          selected={selected}
          onSelect={setSelected}
        />
        {selected?.kind === "run" ? (
          <RunView
            key={selected.id}
            runId={selected.id}
            initialStatus={runs.find((r) => r.id === selected.id)?.status ?? null}
            onStatus={(status, pending) => onRunStatus(selected.id, status, pending)}
            onDismissChanged={refreshFindings}
          />
        ) : selected?.kind === "finding" ? (
          <FindingDrawer finding={activeDetail} dismissBusy={dismissBusy} onToggleDismiss={onToggleDismiss} />
        ) : (
          <aside className="detail-pane grid place-items-center p-(--space-xl)">
            <p className="type-xs text-(--cte-text-muted)">Start a run to watch the agent work.</p>
          </aside>
        )}
      </main>
    </div>
  )
}
