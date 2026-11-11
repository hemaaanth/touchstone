import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ModelChoice,
  ProviderInfo,
  RunSummary,
  SpendState,
  TargetChoice,
  PackChoice,
  Playbook,
  RunMode,
} from "@/lib/types"
import type { CatalogState } from "@/lib/catalog"
import { archiveRun, deleteRun, fetchModels, fetchRuns, renameRun, startRun } from "@/lib/api"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type View } from "@/components/app-sidebar"
import { RunChat } from "@/components/run-chat"
import { ModulesPage } from "@/components/modules-page"
import { ScopesPage } from "@/components/scopes-page"
import { PlaybooksPage } from "@/components/playbooks-page"
import { SettingsPage } from "@/components/settings-page"
import { NewRunDialog } from "@/components/new-run-dialog"
import { loadRun, onRunSettled, reloadRun, useRunBriefs } from "@/lib/runModel"
import { useStoredWidth } from "@/components/resize-handle"

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [targets, setTargets] = useState<TargetChoice[]>([])
  const [packs, setPacks] = useState<PackChoice[]>([])
  const [spend, setSpend] = useState<SpendState | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  // Whether /api/models has answered, so a page can tell "none" from "unknown".
  const [catalog, setCatalog] = useState<CatalogState>("loading")
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [view, setView] = useState<View | null>(null)
  const [sidebarWidth, setSidebarWidth, sidebarDefault] = useStoredWidth("ts.sidebarWidth", 256, 208, 480)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const refreshModels = useCallback(() => {
    fetchModels()
      .then(({ models, targets, packs, spend, provider }) => {
        setModels(models)
        setTargets(targets)
        setPacks(packs ?? [])
        setSpend(spend)
        setProvider(provider)
        setCatalog("ready")
      })
      .catch(() => setCatalog("error"))
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
    (alias: string, targetId?: string, budgetUsd?: number, pack?: string, mode?: RunMode) => {
      setBusy(true)
      setStartError(null)
      startRun(alias, targetId, budgetUsd, pack, mode)
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

  // Rename a run from the rail or its top bar. The list holds the name, so the
  // rail and the top bar change together, at once. An empty name clears it.
  // On failure, fetch the list again so the old name comes back.
  const onRename = useCallback((id: string, name: string) => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120) || null
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, name: clean } : r)))
    renameRun(id, clean ?? "")
      .then(() => reloadRun(id))
      .catch(() => fetchRuns().then(setRuns).catch(() => {}))
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

  // Start a run from a playbook with the same call New run makes.
  // TODO(backend): startRun takes no module list, so a playbook's pipeline
  // choice is not sent yet; the server plans the modules from the scope.
  const onRunPlaybook = useCallback(
    (p: Playbook) => onStart(p.model ?? models[0]?.alias ?? "", p.targetId, p.budgetUsd ?? undefined, p.pack),
    [onStart, models],
  )
  const openRun = useCallback((id: string) => setView({ kind: "run", id }), [])

  const activeRun = view?.kind === "run" ? rows.find((r) => r.id === view.id) ?? null : null
  const page = view?.kind === "page" ? view.id : null

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
        onRename={onRename}
        spend={spend}
        provider={provider}
      />

      <main className="flex h-svh min-w-0 flex-1 flex-col">
        {activeRun ? (
          <RunChat key={activeRun.id} run={activeRun} onArchive={onArchive} onRename={onRename} onDelete={onDelete} />
        ) : page === "settings" ? (
          <SettingsPage onChanged={refreshModels} />
        ) : page === "modules" ? (
          <ModulesPage catalog={catalog} packs={packs} targets={targets} runs={rows} briefs={briefs} onOpenRun={openRun} />
        ) : page === "scopes" ? (
          <ScopesPage
            catalog={catalog}
            packs={packs}
            targets={targets}
            runs={rows}
            briefs={briefs}
            onOpenRun={openRun}
            onChanged={refreshModels}
          />
        ) : page === "playbooks" ? (
          <PlaybooksPage
            packs={packs}
            targets={targets}
            runs={rows}
            briefs={briefs}
            busy={busy}
            error={dialogOpen ? null : startError}
            onOpenRun={openRun}
            onRun={onRunPlaybook}
          />
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
        packs={packs}
        busy={busy}
        error={startError}
        onStart={onStart}
      />
    </SidebarProvider>
  )
}
