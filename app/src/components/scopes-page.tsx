import { useMemo, useState } from "react"
import { ChevronRight, FolderGit2, Trash2 } from "lucide-react"
import type { PackChoice, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { removeScope } from "@/lib/api"
import {
  isOwnScope,
  packOf,
  plural,
  SCOPE_KIND,
  scopedRuns,
  scopeMeta,
  type CatalogState,
  type ScopedRun,
} from "@/lib/catalog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AddScope, ScopeIcon } from "@/components/new-run-dialog"
import { Empty, Label, PageBody, PageHeader, RunLinks, UncountedNote } from "@/components/page-parts"

// The scopes: every codebase or project the agent can test, each tested as
// one unit. A scope can hold several GitHub repos or several local folders.
// One row per target the server's library lists (GET /api/models `targets`),
// grouped by the module that attacks it. Adding a scope does not depend on
// a module, so the add row sits above the groups. Each is a checkout the agent attacks inside a sandbox; the row
// says where its proof may run, so the operator can see a run never touches
// anything live. Runs and proven findings come from the recorded runs.
export function ScopesPage({
  catalog,
  packs,
  targets,
  runs,
  briefs,
  onOpenRun,
  onChanged,
}: {
  catalog: CatalogState
  packs: PackChoice[]
  targets: TargetChoice[]
  runs: RunSummary[]
  briefs: Record<string, RunBrief>
  onOpenRun: (id: string) => void
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const { scoped, loading, unscoped } = useMemo(() => scopedRuns(runs, briefs), [runs, briefs])

  // Groups in the order the server lists packs. A target whose pack the server
  // did not list still shows, under its pack id, so nothing is dropped.
  const groups = useMemo(() => {
    const ids = [...packs.map((p) => p.id), ...new Set(targets.map(packOf))]
    const seen = new Set<string>()
    const out: { id: string; title: string; targets: TargetChoice[] }[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const list = targets.filter((t) => packOf(t) === id)
      if (list.length) out.push({ id, title: packs.find((p) => p.id === id)?.title ?? id, targets: list })
    }
    return out
  }, [packs, targets])

  const onRemove = (t: TargetChoice) => {
    if (!window.confirm(`Remove ${t.title}? Runs against it stay in the sidebar.`)) return
    setError(null)
    removeScope(t.id).then(onChanged, (e: Error) => setError(e.message))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={FolderGit2} title="Scopes" />
      <PageBody>
        {error ? <p role="alert" className="mb-4 text-xs text-bad">{error}</p> : null}
        {catalog === "loading" ? (
          <Empty>Loading…</Empty>
        ) : catalog === "error" && targets.length === 0 ? (
          <Empty>The server did not answer, so the scope list is unknown.</Empty>
        ) : (
          <div className="flex flex-col gap-9">
            {/* Adding a scope does not depend on a module. The server files it
                under the pack that fits its content; the new row shows there. */}
            <div className="-mx-2.5 -mb-3">
              <AddScope onAttached={() => { setError(null); onChanged() }} onError={setError} />
            </div>
            {groups.length === 0 ? <Empty>No scopes yet. Add GitHub repositories or local folders.</Empty> : null}
            {groups.map((g) => (
              <section key={g.id} aria-labelledby={`scopes-${g.id}`}>
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 id={`scopes-${g.id}`} className="text-sm font-semibold">{g.title}</h2>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{plural(g.targets.length, "scope")}</span>
                </div>
                <ul className="divide-y border-y">
                  {g.targets.map((t) => (
                    <li key={t.id}>
                      <ScopeRow
                        target={t}
                        runs={scoped.filter((r) => r.brief.scope?.id === t.id)}
                        onOpenRun={onOpenRun}
                        onRemove={isOwnScope(t.id) ? () => onRemove(t) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        <UncountedNote loading={loading} unscoped={unscoped} />
      </PageBody>
    </div>
  )
}

function ScopeRow({
  target: t,
  runs,
  onOpenRun,
  onRemove,
}: {
  target: TargetChoice
  runs: ScopedRun[]
  onOpenRun: (id: string) => void
  onRemove?: () => void
}) {
  const proven = runs.reduce((n, r) => n + r.brief.proven, 0)
  const files = t.files ?? []

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-3 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
          <ScopeIcon target={t} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{t.title}</span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{scopeMeta(t)}</span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-muted-foreground tabular-nums sm:flex-row sm:gap-3">
          {!t.runnable ? <span>Cannot run now</span> : null}
          <span>{plural(runs.length, "run")}</span>
          {proven > 0 ? <span className="text-ok">{proven} proven</span> : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-5 pb-5 pl-[52px]">
          {t.blurb ? <p className="text-xs leading-relaxed">{t.blurb}</p> : null}

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Kind</dt>
            <dd>{SCOPE_KIND[t.kind] ?? t.kind}</dd>
            <dt className="text-muted-foreground">Entry</dt>
            <dd className="truncate font-mono text-[11px]">{t.entry}</dd>
            {t.signal ? (
              <>
                <dt className="text-muted-foreground">First lead</dt>
                <dd>Expected from {t.signal}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Proof runs in</dt>
            <dd>{t.proofSurface?.note || t.proofSurface?.kind || "Not stated"}</dd>
          </dl>

          {files.length ? (
            <div className="flex flex-col gap-1.5">
              <Label>{plural(files.length, "file")}</Label>
              <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
                {files.slice(0, 12).map((f) => <li key={f} className="truncate">{f}</li>)}
                {files.length > 12 ? <li>{files.length - 12} more</li> : null}
              </ul>
            </div>
          ) : null}

          {t.links?.length ? (
            <div className="flex flex-col gap-1.5">
              <Label>Sources</Label>
              <ul className="flex flex-col gap-0.5">
                {t.links.map((l) => (
                  <li key={l} className="truncate">
                    <a href={l} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label>Runs</Label>
            {runs.length ? (
              <RunLinks runs={runs} onOpen={onOpenRun} />
            ) : (
              <p className="text-xs text-muted-foreground">{t.runnable ? "Not attacked yet. Pick it in New run." : "Not attacked yet."}</p>
            )}
          </div>

          {onRemove ? (
            <div>
              <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:text-destructive" onClick={onRemove}>
                <Trash2 /> Remove scope
              </Button>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
