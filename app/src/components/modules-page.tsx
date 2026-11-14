import { useEffect, useMemo, useRef, useState } from "react"
import { Boxes, Loader2, PanelRight } from "lucide-react"
import type { PackChoice, RunSummary, StrixSettingName, StrixSettings, TargetChoice } from "@/lib/types"
import { fetchSettings, setStrixSettings } from "@/lib/api"
import type { RunBrief } from "@/lib/runModel"
import { moduleNote, packOf, proofKind, scopedRuns, type CatalogState, type ScopedRun } from "@/lib/catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ModulePill } from "@/components/module-pill"
import { ScopeIcon } from "@/components/new-run-dialog"
import { Label, ListCard, ListEmpty, ListLoading, ListPage, ListRow, RowMenu, RowMenuItem, RunLinks, TruncatedText } from "@/components/page-parts"

// The modules a scope allows. A scope saved before it could hold several has one.
const modulesOf = (t: TargetChoice) => t.packs ?? [packOf(t)]

// The attack modules a run can use: one row per pack the engine's loader lists
// (GET /api/models `packs`), in its order. A row shows the module's pill, what
// it tests and how its replay proves a finding. A click on a row opens the
// rest in a sheet at the right, so the list never moves. Every row has the
// same parts and the same menu. The only thing the page writes is the Web
// module's Strix limits, in its sheet.
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
            return (
              <ListRow
                key={p.id}
                title={p.title}
                name={<ModulePill id={p.id} label={p.title} />}
                meta={[proofKind(p).label, tests ? <TruncatedText key="tests" text={tests} /> : null]}
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

const blockedBadge = <Badge variant="secondary" className="h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground">Cannot run now</Badge>

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

        {p.id === "web" ? <StrixSection /> : null}

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

// The three Strix limits, in the order they show.
const STRIX_FIELDS: { name: StrixSettingName; label: string; unit: string; hint: string }[] = [
  { name: "turns", label: "Turn cap", unit: "turns", hint: "Strix stops after this many model turns. Leads found before that are kept." },
  { name: "budgetUsd", label: "Budget per scan", unit: "USD", hint: "The most one Strix scan may spend. It is also cut to what is left of the run budget." },
  { name: "timeoutMin", label: "Time limit", unit: "minutes", hint: "Strix stops after this long. Leads found before that are kept." },
]

const SOURCE_WORD = { saved: "Saved", env: "Set by the server", default: "Default" } as const

// The Web module's Strix limits. Strix runs in live mode only, at the same
// time as the tool scan. Its spend counts against the run budget.
function StrixSection() {
  const [state, setState] = useState<StrixSettings | null | "error">(null)
  useEffect(() => {
    let live = true
    fetchSettings().then(
      (s) => live && setState(s.modules?.web?.strix ?? "error"),
      () => live && setState("error"),
    )
    return () => {
      live = false
    }
  }, [])
  return (
    <section className="flex flex-col gap-2">
      <Label>Strix</Label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Live runs only. Strix runs at the same time as the tool scan. Its results are leads, never findings. What it spends counts against the run budget.
      </p>
      {state === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : state === "error" ? (
        <p className="text-xs text-muted-foreground">The server did not send the Strix settings.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {STRIX_FIELDS.map((f) => (
            <StrixField key={`${f.name}:${state[f.name]}`} field={f} state={state} onSaved={setState} />
          ))}
        </ul>
      )}
    </section>
  )
}

function StrixField({
  field: f,
  state,
  onSaved,
}: {
  field: (typeof STRIX_FIELDS)[number]
  state: StrixSettings
  onSaved: (s: StrixSettings) => void
}) {
  const saved = state[f.name]
  const limit = state.limits[f.name]
  const [value, setValue] = useState(String(saved))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = Number(value)
  const valid = value.trim() !== "" && Number.isFinite(n) && n >= limit.min && n <= limit.max && (!limit.integer || Number.isInteger(n))
  const save = async (next: number | null) => {
    setBusy(true)
    setError(null)
    try {
      const s = await setStrixSettings({ [f.name]: next })
      if (s.modules?.web?.strix) onSaved(s.modules.web.strix)
    } catch (err) {
      setError(err instanceof Error ? err.message : "The server did not save it.")
    } finally {
      setBusy(false)
    }
  }
  const source = state.source[f.name]
  return (
    <li className="flex flex-col gap-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && n !== saved && !busy) void save(n)
        }}
      >
        <span className="flex-1 text-xs">{f.label}</span>
        <Input
          aria-label={`Strix ${f.label.toLowerCase()}, in ${f.unit}`}
          className="h-8 w-20 text-xs tabular-nums md:text-xs"
          inputMode={limit.integer ? "numeric" : "decimal"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={!valid}
        />
        <span className="w-14 text-xs text-muted-foreground">{f.unit}</span>
        {valid && n !== saved ? (
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : "Save"}
          </Button>
        ) : source === "saved" ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} title={`Back to ${state.defaults[f.name]} ${f.unit}`}>
            Reset
          </Button>
        ) : null}
      </form>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {error ? (
          <span role="alert">{error}</span>
        ) : !valid ? (
          <span role="alert">
            Enter {limit.integer ? "a whole number " : ""}from {limit.min} to {limit.max}.
          </span>
        ) : (
          <>
            {f.hint} {SOURCE_WORD[source]}.
          </>
        )}
      </p>
    </li>
  )
}
