import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ModelChoice,
  ProviderInfo,
  RunSummary,
  SpendState,
  TargetChoice,
} from "@/lib/types"
import { archiveRun, deleteRun, fetchModels, fetchRuns, startRun } from "@/lib/api"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type View } from "@/components/app-sidebar"
import { RunChat } from "@/components/run-chat"
import { PageStub } from "@/components/page-stub"
import { SettingsPage } from "@/components/settings-page"
import { NewRunDialog } from "@/components/new-run-dialog"
import { loadRun, onRunSettled, reloadRun, useRunBriefs } from "@/lib/runModel"
import { useStoredWidth } from "@/components/resize-handle"

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [targets, setTargets] = useState<TargetChoice[]>([])
  const [spend, setSpend] = useState<SpendState | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [view, setView] = useState<View | null>(null)
  const [sidebarWidth, setSidebarWidth, sidebarDefault] = useStoredWidth("ts.sidebarWidth", 256, 208, 480)

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
        setRuns(runList)
        // Load every run up front, so switching to one is instant and live
        // ones keep streaming in the background.
        for (const r of runList) loadRun(r.id)
        setView((cur) => cur ?? (runList.length > 0 ? { kind: "run", id: runList[0].id } : null))
      })
    return () => {
      live = false
    }
  }, [refreshModels])

  const onStart = useCallback(
    (alias: string, targetId?: string, budgetUsd?: number) => {
      setBusy(true)
      setStartError(null)
      startRun(alias, targetId, budgetUsd)
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

  // Each row shows the run's own state from the run store once it has loaded,
  // and the server's list entry until then. Both say the same thing for a
  // settled run, so a row never flickers when its run is opened.
  const briefs = useRunBriefs()
  const rows = useMemo(
    () =>
      runs.map((r) => {
        const b = briefs[r.id]
        if (!b) return r
        return {
          ...r,
          status: b.status,
          archived: b.archived,
          title: b.pending?.title ?? r.title,
          severity: b.pending?.severity ?? r.severity,
        }
      }),
    [runs, briefs],
  )

  // Archive (or bring back) a run from the rail. The run store holds the flag,
  // so the row moves and the composer locks once the run reloads.
  const onArchive = useCallback((id: string, archived: boolean) => {
    archiveRun(id, archived)
      .then(() => {
        setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, archived } : r)))
        reloadRun(id)
      })
      .catch(() => {})
  }, [])

  // Delete a run from its top bar. The row leaves the list, and the view moves
  // to the next run so the stage is never left on a run that is gone. Errors
  // go back to the caller, which shows them in its confirm dialog.
  const onDelete = useCallback(
    (id: string) =>
      deleteRun(id).then(() => {
        setRuns((prev) => {
          const rest = prev.filter((r) => r.id !== id)
          setView((cur) =>
            cur?.kind === "run" && cur.id === id ? (rest[0] ? { kind: "run", id: rest[0].id } : null) : cur,
          )
          return rest
        })
        refreshModels()
      }),
    [refreshModels],
  )

  // A run that settles while we watch it changes spend and findings.
  useEffect(() => onRunSettled(() => refreshModels()), [refreshModels])

  const activeRun = view?.kind === "run" ? rows.find((r) => r.id === view.id) ?? null : null

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <AppSidebar
        width={sidebarWidth}
        onWidth={setSidebarWidth}
        defaultWidth={sidebarDefault}
        runs={rows}
        view={view}
        onSelect={setView}
        onNewRun={() => { refreshModels(); setStartError(null); setDialogOpen(true) }}
        onArchive={onArchive}
        spend={spend}
        provider={provider}
      />

      <main className="flex h-svh min-w-0 flex-1 flex-col">
        {activeRun ? (
          <RunChat key={activeRun.id} run={activeRun} onArchive={onArchive} onDelete={onDelete} />
        ) : view?.kind === "page" && view.id === "settings" ? (
          <SettingsPage onChanged={refreshModels} />
        ) : view?.kind === "page" ? (
          <PageStub id={view.id} />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <p className="text-sm text-muted-foreground">Start a run to watch the agent work.</p>
          </div>
        )}
      </main>

      <NewRunDialog
        key={dialogOpen ? "open" : "closed"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        models={models}
        targets={targets}
        spend={spend}
        onScopesChanged={refreshModels}
        busy={busy}
        error={startError}
        onStart={onStart}
      />
    </SidebarProvider>
  )
}
