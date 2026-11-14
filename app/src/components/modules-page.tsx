import { useMemo, useRef, useState } from "react"
import { Boxes, PanelRight } from "lucide-react"
import type { PackChoice, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { moduleNote, packOf, proofKind, scopedRuns, type CatalogState, type ScopedRun } from "@/lib/catalog"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ModulePill } from "@/components/module-pill"
import { ScopeIcon } from "@/components/new-run-dialog"
import { Label, ListCard, ListEmpty, ListLoading, ListPage, ListRow, RowMenu, RowMenuItem, RunLinks, TruncatedText } from "@/components/page-parts"

// Shown on a module or scope that cannot run until a need is met.
const blockedBadge = <Badge variant="secondary" className="h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground">Cannot run now</Badge>

// The modules a scope allows. A scope saved before it could hold several has one.
const modulesOf = (t: TargetChoice) => t.packs ?? [packOf(t)]

// The attack modules a run can use: one row per pack the engine's loader lists
// (GET /api/models `packs`), in its order. A row shows the module's pill, what
// it tests and how its replay proves a finding. A click on a row opens the
// rest in a sheet at the right, so the list never moves. Every row has the
// same parts and the same menu. The page writes nothing.
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
  const { scoped } = useMemo(() => scopedRuns(runs, briefs), [runs, briefs])
  // The sheet keeps its module while it slides out, so `open` is its own flag.
  const [detail, setDetail] = useState<{ id: string; open: boolean } | null>(null)
  const shown = detail ? packs.find((p) => p.id === detail.id) : undefined
  const sheet = useRef<HTMLDivElement>(null)
  const openDetail = (p: PackChoice) => setDetail({ id: p.id, open: true })

  return (
    <ListPage title="Modules" description="What a run can test, and how it proves a finding. A run uses the modules its scope allows.">
      {catalog === "loading" ? (
        <ListLoading label="Loading modules…" />
      ) : catalog === "error" && packs.length === 0 ? (
        <ListEmpty title="The module list is unknown">The server did not answer. Reload the page to ask again.</ListEmpty>
      ) : packs.length === 0 ? (
        <ListEmpty icon={Boxes} title="No modules">
          The server lists no modules, so no run can start.
        </ListEmpty>
      ) : (
        <ListCard aria-label="Modules">
          {packs.map((p) => {
            const tests = p.description ?? null
            // A module is ready when at least one of its scopes can run. When none
            // can, the reason is shown on the row: a greyed row with no reason is
            // the worst of both worlds.
            const mine = targets.filter((t) => modulesOf(t).includes(p.id))
            // Per-module needs. A module is blocked when some scope that allows it
            // cannot run it, and its own reason is reported. The first version asked
            // "is EVERY scope blocked", which is never true in practice: the five
            // shipped labs are Contracts scopes with no needs, so a forked scope with
            // no RPC was never reported. The operator wants to know that one of their
            // scopes is blocked, not only that all of them are.
            const unmet = mine.flatMap((t) => t.needsByPack?.[p.id] ?? [])
            const blocked = unmet.length > 0
            const reason = blocked ? (unmet[0]?.label ?? null) : null
            return (
              <ListRow
                key={p.id}
                title={p.title}
                name={<ModulePill id={p.id} label={p.title} />}
                // A row whose module cannot run reads as unavailable. The class is
                // distinct from ListRow's own `opacity-60` meta separator, so a test can
                // tell "unavailable" from "a dot between two items".
                className={blocked ? "opacity-60 [&_[data-row-main]]:cursor-not-allowed" : undefined}
                badges={blocked ? blockedBadge : undefined}
                meta={[
                  proofKind(p).label,
                  reason ? <span key="need" className="text-muted-foreground">{`Needs ${reason}`}</span> : null,
                  tests ? <TruncatedText key="tests" text={tests} /> : null,
                ]}
                menu={
                  <RowMenu label={`Actions for ${p.title}`}>
                    <RowMenuItem onClick={() => openDetail(p)}>
                      <PanelRight /> View details
                    </RowMenuItem>
                  </RowMenu>
                }
                onOpen={() => openDetail(p)}
                active={detail?.open === true && detail.id === p.id}
              />
            )
          })}
        </ListCard>
      )}

      <Sheet open={detail?.open === true && !!shown} onOpenChange={(open) => setDetail((d) => (d ? { ...d, open } : d))}>
        <SheetContent ref={sheet} initialFocus={sheet} className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {shown ? (
            <ModuleDetail
              pack={shown}
              scopes={targets.filter((t) => modulesOf(t).includes(shown.id))}
              runs={scoped.filter((r) => packOf(r.brief.scope) === shown.id)}
              onOpenRun={onOpenRun}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </ListPage>
  )
}


// One module, in the sheet. Every module shows the same blocks in the same order.
function ModuleDetail({
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
  const tests = p.description ?? null
  const note = moduleNote(p)
  const runnable = scopes.some((t) => t.runnable)
  // One entry per distinct need: three forked scopes missing the same RPC is one
  // thing to fix, not three.
  const unmet = [...new Map(scopes.flatMap((t) => t.needsByPack?.[p.id] ?? []).map((n) => [n.id, n])).values()]
  return (
    <>
      <SheetHeader className="flex-row flex-wrap items-center gap-x-2 gap-y-1 pr-12">
        <SheetTitle className="flex min-w-0">
          <ModulePill id={p.id} label={p.title} />
        </SheetTitle>
        <SheetDescription className="text-xs">{proof.label}</SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-6">
        {tests ? <p className="text-[13px] leading-relaxed">{tests}</p> : null}

        <section className="flex flex-col gap-2">
          <Label>Proof</Label>
          <p className="text-xs leading-relaxed">{proof.detail}</p>
        </section>

        {note ? (
          <section className="flex flex-col gap-2">
            <Label>Where it runs</Label>
            <p className="text-xs leading-relaxed">{note}</p>
          </section>
        ) : null}

        {unmet.length ? (
          <section className="flex flex-col gap-2">
            <Label>Needs before it can run</Label>
            <ul className="flex flex-col gap-2">
              {unmet.map((n) => (
                <li key={n.id} className="flex flex-col gap-0.5">
                  <span className="text-[13px]">{n.label}</span>
                  <span className="text-xs text-muted-foreground">{n.detail}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {n.kind === "settings" ? "Fix it in Settings → Chain RPCs." : "Fix it on the scope."}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <Label>Scopes</Label>
          {scopes.length ? (
            <ul className="flex flex-col gap-1.5">
              {scopes.map((t) => (
                <li key={t.id} className="flex min-w-0 items-center gap-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                  <ScopeIcon target={t} />
                  <TruncatedText text={t.title} className="flex-1" />
                  {t.runnable ? null : blockedBadge}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No scope allows this module yet. Add one in Scopes.</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <Label>Runs</Label>
          {runs.length ? (
            <RunLinks runs={runs} onOpen={onOpenRun} />
          ) : (
            <p className="text-xs text-muted-foreground">{runnable ? "No runs yet. Pick a scope that allows it in New run." : "No runs yet."}</p>
          )}
        </section>
      </div>
    </>
  )
}
