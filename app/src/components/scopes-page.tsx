import { useMemo, useState } from "react"
import { ChevronRight, Folder, FolderGit2, Globe, Trash2 } from "lucide-react"
import type { PackChoice, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { removeScope } from "@/lib/api"
import { isOwnScope, packOf, plural, scopedRuns, scopeMeta, type CatalogState, type ScopedRun } from "@/lib/catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AddScope, ScopeIcon } from "@/components/new-run-dialog"
import { Empty, Label, PageBody, PageHeader, RunLinks } from "@/components/page-parts"

// A scope the operator added. The rest are the labs that ship with the app.
const isOwn = (t: TargetChoice) => isOwnScope(t.id) || t.kind === "live"

// What is in a scope: its websites, its GitHub repos, its local folders.
// A lab has none of these; it shows its entry file.
type Item = { kind: "site" | "repo" | "folder" | "file"; text: string; href?: string; note?: string }
const short = (url: string) => url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")
function contents(t: TargetChoice): Item[] {
  const sites = t.origins?.length ? t.origins : (t.hosts ?? [])
  if (sites.length) return sites.map((text) => ({ kind: "site", text }))
  if (t.members?.length) {
    return t.members.map((m) =>
      m.kind === "repo"
        ? { kind: "repo", text: short(m.url), href: m.url }
        : { kind: "folder", text: m.path ?? `${m.name}/`, note: plural(m.files, "file") },
    )
  }
  if (t.links?.length) return t.links.map((l) => ({ kind: "repo", text: short(l), href: l }))
  const entry = scopeMeta(t)
  return entry ? [{ kind: "file", text: entry }] : []
}

// The scopes: everything a run can test. One flat list, in the order App.tsx
// gives: the operator's own scopes first, then the labs that ship with the
// app, each tagged Demo. A row shows the scope's name, what is in it, and the
// modules it allows. A run picks its modules from those in New run.
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
  const { scoped } = useMemo(() => scopedRuns(runs, briefs), [runs, briefs])

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
          <div className="flex flex-col gap-3">
            <div className="-mx-2.5">
              <AddScope packs={packs} onAttached={() => { setError(null); onChanged() }} onError={setError} />
            </div>
            {targets.length === 0 ? (
              <Empty>No scopes yet. Add a GitHub repository, a website, or a local folder.</Empty>
            ) : (
              <ul className="divide-y border-y">
                {targets.map((t) => (
                  <li key={t.id}>
                    <ScopeRow
                      target={t}
                      modules={(t.packs ?? [packOf(t)]).map((id) => packs.find((p) => p.id === id)?.title ?? id)}
                      runs={scoped.filter((r) => r.brief.scope?.id === t.id)}
                      onOpenRun={onOpenRun}
                      onRemove={isOwn(t) ? () => onRemove(t) : undefined}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PageBody>
    </div>
  )
}

function ScopeRow({
  target: t,
  modules,
  runs,
  onOpenRun,
  onRemove,
}: {
  target: TargetChoice
  modules: string[]
  runs: ScopedRun[]
  onOpenRun: (id: string) => void
  // Set for the operator's own scopes. A demo scope cannot be removed.
  onRemove?: () => void
}) {
  const proven = runs.reduce((n, r) => n + r.brief.proven, 0)
  const items = contents(t)

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-start gap-3 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="mt-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
          <ScopeIcon target={t} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{t.title}</span>
            {onRemove ? null : <Badge variant="outline" className="h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground">Demo</Badge>}
          </span>
          {items.length ? <span className="truncate font-mono text-[11px] text-muted-foreground group-data-[panel-open]:hidden">{items.map((i) => i.text).join(", ")}</span> : null}
          <span className="text-[11px] text-muted-foreground">{modules.join(" · ")}</span>
        </div>
        <div className="mt-0.5 flex shrink-0 flex-col items-end gap-1 text-[11px] text-muted-foreground tabular-nums sm:flex-row sm:gap-3">
          {!t.runnable ? <span>Cannot run now</span> : null}
          <span>{plural(runs.length, "run")}</span>
          {proven > 0 ? <span className="text-ok">{proven} proven</span> : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-5 pb-5 pl-[54px]">
          {t.blurb ? <p className="text-xs leading-relaxed">{t.blurb}</p> : null}

          {items.length ? (
            <div className="flex flex-col gap-1.5">
              <Label>In this scope</Label>
              <ul className="flex flex-col gap-1">
                {items.map((i) => (
                  <li key={i.text} className="flex items-center gap-2 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
                    {i.kind === "site" ? <Globe /> : i.kind === "repo" ? <FolderGit2 /> : i.kind === "folder" ? <Folder /> : <ScopeIcon target={t} />}
                    {i.href ? (
                      <a href={i.href} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] underline-offset-2 hover:text-foreground hover:underline">
                        {i.text}
                      </a>
                    ) : (
                      <span className="truncate font-mono text-[11px]">{i.text}</span>
                    )}
                    {i.note ? <span className="shrink-0 text-[11px] tabular-nums">{i.note}</span> : null}
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
              <p className="text-xs text-muted-foreground">{t.runnable ? "No runs yet. Pick it in New run." : "No runs yet."}</p>
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
