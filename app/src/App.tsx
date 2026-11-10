import { useCallback, useEffect, useState } from "react"
import type {
  ModelChoice,
  PendingApproval,
  ProviderInfo,
  RunStatus,
  RunSummary,
  SpendState,
  TargetChoice,
} from "@/lib/types"
import { fetchModels, fetchRuns, startRun } from "@/lib/api"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type View } from "@/components/app-sidebar"
import { RunChat } from "@/components/run-chat"
import { PageStub } from "@/components/page-stub"
import { NewRunDialog } from "@/components/new-run-dialog"
import { fixtureRuns } from "@/lib/fixtures"

const TERMINAL: RunStatus[] = ["recorded", "denied", "no-finding", "error"]

// DEV-only: canned fixture runs offered alongside real runs so the streaming
// cognition UI can be built and visually verified without a server or a live
// model. Their `fixture:` ids route useRun to its deterministic replay path.
// Stamped with a live startedAt so the elapsed clock ticks. Stripped from prod.
const DEV_FIXTURES: RunSummary[] = import.meta.env.DEV
  ? fixtureRuns.map((r) => ({ ...r, startedAt: Date.now() }))
  : []

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [targets, setTargets] = useState<TargetChoice[]>([])
  const [spend, setSpend] = useState<SpendState | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>(DEV_FIXTURES)
  const [view, setView] = useState<View | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

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

  // Load everything once. Land on the newest live run so the stage is never
  // empty when there is work in flight.
  useEffect(() => {
    let live = true
    refreshModels()
    fetchRuns()
      .catch(() => [] as RunSummary[])
      .then((runList) => {
        if (!live) return
        const merged = [...DEV_FIXTURES, ...runList]
        setRuns(merged)
        setView((cur) => cur ?? (merged.length > 0 ? { kind: "run", id: merged[0].id } : null))
      })
    return () => {
      live = false
    }
  }, [refreshModels])

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
          setView({ kind: "run", id: run.id })
          setDialogOpen(false)
          refreshModels()
        })
        .catch((err: unknown) => setStartError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    },
    [refreshModels],
  )

  // The selected run's live stream flows through RunChat; it reports each status
  // change here so the sidebar row, spend meter, and findings stay current.
  const onRunStatus = useCallback(
    (id: string, status: RunStatus, pending: PendingApproval | null) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status, title: pending?.title ?? r.title, severity: pending?.severity ?? r.severity }
            : r,
        ),
      )
      if (TERMINAL.includes(status)) refreshModels()
    },
    [refreshModels],
  )

  const activeRun = view?.kind === "run" ? runs.find((r) => r.id === view.id) ?? null : null

  return (
    <SidebarProvider>
      <AppSidebar
        runs={runs}
        view={view}
        onSelect={setView}
        onNewRun={() => setDialogOpen(true)}
        spend={spend}
        provider={provider}
      />

      <main className="flex h-svh min-w-0 flex-1 flex-col">
        {activeRun ? (
          <RunChat
            key={activeRun.id}
            run={activeRun}
            onStatus={(status, pending) => onRunStatus(activeRun.id, status, pending)}
          />
        ) : view?.kind === "page" ? (
          <PageStub id={view.id} />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <p className="text-sm text-muted-foreground">Start a run to watch the agent work.</p>
          </div>
        )}
      </main>

      <NewRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        models={models}
        targets={targets}
        spend={spend}
        busy={busy}
        error={startError}
        onStart={onStart}
      />
    </SidebarProvider>
  )
}
