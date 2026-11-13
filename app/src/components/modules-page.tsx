import { useMemo } from "react"
import { Boxes, ChevronRight } from "lucide-react"
import type { PackChoice, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { moduleAside, moduleNote, packOf, PLAN_STEP, planStepState, plural, proofKind, scopedRuns, type CatalogState, type ScopedRun } from "@/lib/catalog"
import { ago } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, Label, PageBody, PageHeader, RunLinks, UncountedNote } from "@/components/page-parts"

// The attack modules the agent can run. One row per pack the engine's loader
// lists (GET /api/models `packs`). Closed, a row shows the pack, how it proves
// a finding, and whether its tools stay in the sandbox or can reach a granted
// host. Open, it says that in a sentence, then the pipeline and tools its
// latest run actually used.
export function ModulesPage({
  catalog,
  packs,
  targets,
  runs,
  briefs,
  onOpenRun,
}: {
  catalog: CatalogState
  packs: PackChoice[]
  targets: TargetChoice[]
  runs: RunSummary[]
  briefs: Record<string, RunBrief>
  onOpenRun: (id: string) => void
}) {
  const { scoped, loading, unscoped } = useMemo(() => scopedRuns(runs, briefs), [runs, briefs])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={Boxes} title="Modules" />
      <PageBody>
        <p className="mb-4 text-xs text-muted-foreground">
          Each module brings its own tools. A finding is real only when a replay passes.
        </p>
        {catalog === "loading" ? (
          <Empty>Loading…</Empty>
        ) : catalog === "error" && packs.length === 0 ? (
          <Empty>The server did not answer, so the module list is unknown.</Empty>
        ) : packs.length === 0 ? (
          <Empty>The server lists no modules.</Empty>
        ) : (
          <ul className="divide-y border-y">
            {packs.map((p) => (
              <li key={p.id}>
                <PackRow
                  pack={p}
                  scopes={targets.filter((t) => packOf(t) === p.id)}
                  runs={scoped.filter((r) => packOf(r.brief.scope) === p.id)}
                  onOpenRun={onOpenRun}
                />
              </li>
            ))}
          </ul>
        )}
        <UncountedNote loading={loading} unscoped={unscoped} />
      </PageBody>
    </div>
  )
}

function PackRow({
  pack: p,
  scopes,
  runs,
  onOpenRun,
}: {
  pack: PackChoice
  scopes: TargetChoice[]
  runs: ScopedRun[]
  onOpenRun: (id: string) => void
}) {
  const proof = proofKind(p)
  const aside = moduleAside(p)
  const note = moduleNote(p)
  const runnable = scopes.filter((t) => t.runnable).length
  const proven = runs.reduce((n, r) => n + r.brief.proven, 0)
  // The latest run that recorded each part. A run that predates the event
  // simply does not count.
  const planRun = runs.find((r) => r.brief.modules?.length)
  const toolRun = runs.find((r) => r.brief.tools?.length)

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-3 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{p.title}</span>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {proof.label}
            {aside ? ` · ${aside}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-muted-foreground tabular-nums sm:flex-row sm:gap-3">
          <span title={`${runnable} of ${scopes.length} scopes can run now`}>{plural(scopes.length, "scope")}</span>
          <span>{plural(runs.length, "run")}</span>
          {proven > 0 ? <span className="text-ok">{proven} proven</span> : null}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-5 pb-5 pl-[26px]">
          <div className="flex flex-col gap-1">
            <Label>Proof</Label>
            <p className="text-xs leading-relaxed">{proof.detail}</p>
            {note ? <p className="text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Pipeline{planRun ? ` · from its latest run, ${ago(planRun.run.startedAt)}` : ""}</Label>
            {planRun?.brief.modules ? (
              <ul className="flex flex-col gap-1">
                {planRun.brief.modules.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className={cn("font-medium", !m.on && "text-muted-foreground")}>{PLAN_STEP[m.id] ?? m.id}</span>
                    <span className="text-muted-foreground">{planStepState(m)}</span>
                    {!m.on && m.reason ? <span className="basis-full text-[11px] text-muted-foreground">{m.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No run has recorded a plan for this module yet.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Tools{toolRun ? ` · from its latest scan, ${ago(toolRun.run.startedAt)}` : ""}</Label>
            {toolRun?.brief.tools ? (
              <ul className="flex flex-col gap-1">
                {toolRun.brief.tools.map((t, i) => (
                  <li key={`${t.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-muted-foreground">
                      {t.status === "ran" ? `ran · ${plural(t.leads, "lead")}` : `unavailable${t.reason ? ` · ${t.reason}` : ""}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No run has recorded a tool scan for this module yet.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Runs</Label>
            {runs.length ? (
              <RunLinks runs={runs} onOpen={onOpenRun} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {runnable ? "Not run yet. Pick it in New run." : "Not run yet, and none of its scopes can run now."}
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
