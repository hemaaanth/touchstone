import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  ModelChoice,
  RunSummary,
  TargetChoice,
  PackChoice,
  RunMode,
} from "@/lib/types"
import { isOwnScope, type CatalogState } from "@/lib/catalog"
import { archiveRun, deleteRun, fetchModels, fetchRuns, fetchStoreErrors, renameRun, startRun } from "@/lib/api"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type View } from "@/components/app-sidebar"
import { RunChat, type FocusFinding } from "@/components/run-chat"
import { FindingsPage } from "@/components/findings-page"
import { ModulesPage } from "@/components/modules-page"
import { ScopesPage } from "@/components/scopes-page"
import { SettingsPage } from "@/components/settings-page"
import { NewRunDialog } from "@/components/new-run-dialog"
import { loadRun, onRunSettled, reloadRun, useRunBriefs } from "@/lib/runModel"
import { useStoredWidth } from "@/components/resize-handle"
import { ErrorState } from "@/components/assistant-ui/elements/error-state"
import { onStalePage } from "@/lib/console-token"

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([])
  const [targets, setTargets] = useState<TargetChoice[]>([])
  const [packs, setPacks] = useState<PackChoice[]>([])
  // Whether /api/models has answered, so a page can tell "none" from "unknown".
  const [catalog, setCatalog] = useState<CatalogState>("loading")
  // A store file that cannot be read lists as empty: these sentences say so.
  const [storeErrors, setStoreErrors] = useState<string[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [view, setView] = useState<View | null>(null)
  // "Open this finding" in the open run (the Findings page's Open in run).
  const [focus, setFocus] = useState<(FocusFinding & { run: string }) | null>(null)
  const [sidebarWidth, setSidebarWidth, sidebarDefault] = useStoredWidth("ts.sidebarWidth", 256, 208, 480)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // A write the server refused because this page's console token is old (it was
  // rotated in another tab). Shown once, with Reload, for every kind of write:
  // a rename or an archive shows no error of its own.
  const [stalePage, setStalePage] = useState<string | null>(null)
  useEffect(() => onStalePage(setStalePage), [])

  const refreshModels = useCallback(() => {
    fetchStoreErrors().then(setStoreErrors, () => setStoreErrors([]))
    fetchModels()
      .then(({ models, targets, packs }) => {
        setModels(models)
        // The operator's own scopes first, newest on top; then the labs that ship with the app.
        const own = (t: TargetChoice) => isOwnScope(t.id) || t.kind === "live"
        setTargets([...targets.filter(own).reverse(), ...targets.filter((t) => !own(t))])
        setPacks(packs ?? [])
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

  // ONE run for the whole ticked list: the server builds one workspace with a
  // part per module, one budget and one grant. A single tick is today's run.
  const onStart = useCallback(
    async (alias: string, targetId: string | undefined, budgetUsd: number, modules: string[], mode: RunMode) => {
      setBusy(true)
      setStartError(null)
      try {
        const run = await startRun(alias, targetId, budgetUsd, modules, mode)
        setRuns((prev) => [
          {
            id: run.id,
            alias: run.alias,
            status: run.status,
            startedAt: run.startedAt,
            title: null,
            severity: null,
            packs: run.packs,
            scopeTitle: run.scope?.title ?? run.target ?? null,
          },
          ...prev.filter((r) => r.id !== run.id),
        ])
        loadRun(run.id)
        setView({ kind: "run", id: run.id })
        setDialogOpen(false)
      } catch (err: unknown) {
        setStartError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        refreshModels()
      }
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
          scopeTitle: r.scopeTitle ?? b.scope?.title ?? null,
          severity: b.pending?.severity ?? r.severity,
        }
      }),
    [runs, briefs],
  )

  // Archive (or bring back) a run from the rail. The run store holds the flag,
  // so the row moves and the composer locks once the run reloads.
  // A refused rename or archive says why, in the run view's composer line.
  const [refused, setRefused] = useState<{ run: string; title: string; text: string } | null>(null)
  const refuse = (run: string, title: string) => (e: unknown) =>
    setRefused({ run, title, text: e instanceof Error ? e.message : String(e) })
  const done = (run: string) => setRefused((cur) => (cur?.run === run ? null : cur))
  const onArchive = useCallback((id: string, archived: boolean) => {
    archiveRun(id, archived)
      .then(() => {
        setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, archived } : r)))
        reloadRun(id)
        done(id)
      })
      .catch(refuse(id, archived ? "Not archived" : "Not restored"))
  }, [])

  // Rename a run from the rail or its top bar. The list holds the name, so the
  // rail and the top bar change together, at once. An empty name clears it.
  // On failure, fetch the list again so the old name comes back.
  const onRename = useCallback((id: string, name: string) => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120) || null
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, name: clean } : r)))
    renameRun(id, clean ?? "")
      .then(() => {
        reloadRun(id)
        done(id)
      })
      .catch((e: unknown) => {
        refuse(id, "Not renamed")(e)
        fetchRuns().then(setRuns).catch(() => {})
      })
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

  // Open a run, and with a finding id, land on that finding.
  const openRun = useCallback((id: string, finding?: string) => {
    setView({ kind: "run", id })
    setFocus(finding ? { run: id, finding, at: Date.now() } : null)
  }, [])
  const select = useCallback((v: View) => {
    setFocus(null)
    setView(v)
  }, [])

  const activeRun = view?.kind === "run" ? rows.find((r) => r.id === view.id) ?? null : null
  const page = view?.kind === "page" ? view.id : null

  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <AppSidebar
        width={sidebarWidth}
        onWidth={setSidebarWidth}
        defaultWidth={sidebarDefault}
        runs={rows}
        packs={packs}
        view={view}
        onSelect={select}
        onNewRun={() => { refreshModels(); setStartError(null); setDialogOpen(true) }}
        onArchive={onArchive}
        onRename={onRename}
      />

      <main className="relative flex h-svh min-w-0 flex-1 flex-col">
        {activeRun ? (
          <RunChat
            key={activeRun.id}
            run={activeRun}
            onArchive={onArchive}
            onRename={onRename}
            onDelete={onDelete}
            packs={packs}
            focus={focus?.run === activeRun.id ? focus : null}
            actionError={refused?.run === activeRun.id ? refused : null}
          />
        ) : page === "settings" ? (
          <SettingsPage onChanged={refreshModels} />
        ) : page === "findings" ? (
          <FindingsPage packs={packs} runs={rows} onOpenRun={openRun} />
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
            storeErrors={storeErrors}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <p className="text-sm text-muted-foreground">Start a run to watch the agent work.</p>
          </div>
        )}
        {stalePage ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-50 flex justify-center px-4">
            <ErrorState className="pointer-events-auto w-full max-w-md" title={stalePage} onRetry={() => window.location.reload()} retryLabel="Reload" />
          </div>
        ) : null}
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
