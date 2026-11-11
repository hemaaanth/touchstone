import { useMemo } from "react"
import { BookMarked, Play } from "lucide-react"
import type { PackChoice, Playbook, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { PLAN_STEP, scopedRuns } from "@/lib/catalog"
import { ago, formatUsd } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Empty, Label, PageBody, PageHeader, RunLinks } from "@/components/page-parts"

// TODO(backend): no playbook store exists. Replace this with
// GET /api/playbooks -> { playbooks: Playbook[] }. Until then the list is
// empty on purpose: we do not show recipes nobody saved.
const SAVED_PLAYBOOKS: Playbook[] = []

// Saved run recipes: a scope plus a module plan, so a proven attack path is
// one click to repeat. The saved list waits on a backend. The proven runs
// below are real: they are the paths a playbook would be saved from.
export function PlaybooksPage({
  packs,
  targets,
  runs,
  briefs,
  busy,
  error,
  onOpenRun,
  onRun,
}: {
  packs: PackChoice[]
  targets: TargetChoice[]
  runs: RunSummary[]
  briefs: Record<string, RunBrief>
  busy: boolean
  // Why the last playbook run failed to start, if it did.
  error: string | null
  onOpenRun: (id: string) => void
  onRun: (p: Playbook) => void
}) {
  const playbooks = SAVED_PLAYBOOKS
  const proven = useMemo(() => scopedRuns(runs, briefs).scoped.filter((r) => r.brief.proven > 0), [runs, briefs])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={BookMarked} title="Playbooks" />
      <PageBody>
        <section aria-labelledby="playbooks-saved">
          <div className="mb-4">
            <h2 id="playbooks-saved" className="text-sm font-semibold">Saved</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A playbook keeps a scope, a module, its pipeline, a model and a budget, so a proven attack path is one click to repeat.
            </p>
          </div>
          {error ? <p role="alert" className="mb-3 text-xs text-bad">{error}</p> : null}
          {playbooks.length === 0 ? (
            <Empty>No playbooks. Saving one needs a playbook store on the server, and that is not built yet.</Empty>
          ) : (
            <ul className="divide-y border-y">
              {playbooks.map((p) => (
                <li key={p.id}>
                  <PlaybookRow
                    playbook={p}
                    pack={packs.find((x) => x.id === p.pack)}
                    target={targets.find((t) => t.id === p.targetId)}
                    busy={busy}
                    onRun={() => onRun(p)}
                    onOpenRun={onOpenRun}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-9" aria-labelledby="playbooks-proven">
          <h2 id="playbooks-proven" className="text-sm font-semibold">Proven runs</h2>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">Runs whose replay proved a finding. These are the paths a playbook would repeat.</p>
          {proven.length ? (
            <div className="border-y py-2">
              <RunLinks runs={proven} onOpen={onOpenRun} limit={8} />
            </div>
          ) : (
            <Empty>No run has proven a finding yet.</Empty>
          )}
        </section>
      </PageBody>
    </div>
  )
}

function PlaybookRow({
  playbook: p,
  pack,
  target,
  busy,
  onRun,
  onOpenRun,
}: {
  playbook: Playbook
  pack: PackChoice | undefined
  target: TargetChoice | undefined
  busy: boolean
  onRun: () => void
  onOpenRun: (id: string) => void
}) {
  // A recipe whose scope is gone or cannot run now cannot start.
  const runnable = Boolean(target?.runnable)
  const from = p.fromRunId
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{p.title}</span>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {pack?.title ?? p.pack} · {target?.title ?? "Scope removed"}
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <Label>Pipeline</Label>
          <p className="text-xs">{p.modules.length ? p.modules.map((m) => PLAN_STEP[m] ?? m).join(", ") : "Default"}</p>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {p.model ?? "Default model"} · {p.budgetUsd != null ? `${formatUsd(p.budgetUsd)} budget` : "Default budget"} · saved {ago(p.createdAt)}
          {from ? (
            <>
              {" · "}
              <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => onOpenRun(from)}>
                source run
              </button>
            </>
          ) : null}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={!runnable || busy} onClick={onRun} title={runnable ? "Start a run from this playbook" : "Its scope cannot run now"}>
        <Play /> Run
      </Button>
    </div>
  )
}
