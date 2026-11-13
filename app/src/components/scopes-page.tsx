import { useMemo, useRef, useState } from "react"
import { Folder, FolderGit2, Globe, Loader2, PanelRight, Plus, Trash2, TriangleAlert } from "lucide-react"
import type { PackChoice, RunSummary, TargetChoice } from "@/lib/types"
import type { RunBrief } from "@/lib/runModel"
import { removeScope, saveScopeBrief } from "@/lib/api"
import { isOwnScope, packOf, plural, SCOPE_KIND, scopedRuns, scopeMeta, siteEntry, type CatalogState, type ScopedRun } from "@/lib/catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ModulePills } from "@/components/module-pill"
import { AddScope, ScopeIcon } from "@/components/new-run-dialog"
import { Label, ListCard, ListEmpty, ListLoading, ListPage, ListRow, RowMenu, RowMenuItem, RowMenuSeparator, RunLinks, TruncatedText } from "@/components/page-parts"

// A scope the operator added. The rest are the labs that ship with the app.
const isOwn = (t: TargetChoice) => isOwnScope(t.id) || t.kind === "live"

// The modules a scope allows. A scope saved before it could hold several has one.
const modulesOf = (t: TargetChoice) => t.packs ?? [packOf(t)]

// What is in a scope: its websites, its GitHub repos, its local folders.
// A lab has none of these; it shows its entry file.
type Item = { kind: "site" | "repo" | "folder" | "file"; text: string; href?: string; note?: string }
const short = (url: string) => url.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")
function contents(t: TargetChoice): Item[] {
  const sites = t.origins?.length ? t.origins : (t.hosts ?? [])
  if (sites.length) {
    return sites.map((origin) => {
      const e = siteEntry(origin)
      return e.wildcard ? { kind: "site", text: e.text, note: "all subdomains" } : { kind: "site", text: e.text }
    })
  }
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

const demoBadge = <Badge variant="outline" className="h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground">Demo</Badge>
const blockedBadge = <Badge variant="secondary" className="h-[18px] px-1.5 text-[10.5px] font-normal text-muted-foreground">Cannot run now</Badge>

// The scopes: everything a run can test. One flat list, in the order App.tsx
// gives: the operator's own scopes first, then the labs that ship with the
// app, each tagged Demo. Every row has the same parts and the same menu. A
// click on a row opens its detail in a sheet at the right, so the list never
// moves. A run picks its modules from the scope's modules in New run.
export function ScopesPage({
  catalog,
  packs,
  targets,
  runs,
  briefs,
  onOpenRun,
  onChanged,
  storeErrors = [],
}: {
  catalog: CatalogState
  packs: PackChoice[]
  targets: TargetChoice[]
  runs: RunSummary[]
  briefs: Record<string, RunBrief>
  onOpenRun: (id: string) => void
  onChanged: () => void
  // A store file that cannot be read (GET /api/stores). Its scopes are missing
  // from the list, so the page must say why, not show an empty list.
  storeErrors?: string[]
}) {
  const { scoped } = useMemo(() => scopedRuns(runs, briefs), [runs, briefs])
  const runsOf = (t: TargetChoice) => scoped.filter((r) => r.brief.scope?.id === t.id)

  const [adding, setAdding] = useState(false)
  // The sheet keeps its scope while it slides out, so `open` is its own flag.
  const [detail, setDetail] = useState<{ id: string; open: boolean } | null>(null)
  const [removing, setRemoving] = useState<{ scope: TargetChoice; open: boolean } | null>(null)

  const shown = detail ? targets.find((t) => t.id === detail.id) : undefined
  // The sheet takes the focus itself. The first control in it can be "Remove
  // scope", and Enter must not land there.
  const sheet = useRef<HTMLDivElement>(null)
  const openDetail = (t: TargetChoice) => setDetail({ id: t.id, open: true })
  const askRemove = (t: TargetChoice) => setRemoving({ scope: t, open: true })

  const add = (
    <Button size="sm" onClick={() => setAdding(true)}>
      <Plus /> Add scope
    </Button>
  )

  return (
    <ListPage
      title="Scopes"
      description="What a run may test: a website, a GitHub repository or a local folder. A run picks one scope and some of its modules."
      action={catalog === "loading" || (catalog === "error" && targets.length === 0) ? null : add}
    >
      {storeErrors.length ? (
        <div role="alert" className="flex gap-2.5 rounded-lg bg-muted/50 px-3.5 py-3 text-[13px] leading-relaxed">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0">
            <p className="font-medium">Some scopes cannot be shown</p>
            {storeErrors.map((e) => (
              <p key={e} className="mt-1 wrap-anywhere text-muted-foreground">
                {e}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {catalog === "loading" ? (
        <ListLoading label="Loading scopes…" />
      ) : catalog === "error" && targets.length === 0 ? (
        <ListEmpty title="The scope list is unknown">The server did not answer. Reload the page to ask again.</ListEmpty>
      ) : targets.length === 0 ? (
        <ListEmpty icon={FolderGit2} title="No scopes yet" action={add}>
          Add a GitHub repository, a website, or a local folder.
        </ListEmpty>
      ) : (
        <ListCard aria-label="Scopes">
          {targets.map((t) => {
            const own = isOwn(t)
            const items = contents(t)
            const mine = runsOf(t)
            const proven = mine.reduce((n, r) => n + r.brief.proven, 0)
            return (
              <ListRow
                key={t.id}
                icon={<ScopeIcon target={t} />}
                title={t.title}
                badges={
                  own && t.runnable ? null : (
                    <>
                      {own ? null : demoBadge}
                      {t.runnable ? null : blockedBadge}
                    </>
                  )
                }
                meta={[
                  items.length ? (
                    <TruncatedText key="contents" mono middle={items.length === 1} text={items.map((i) => (i.kind === "site" && i.note ? `${i.text} · ${i.note}` : i.text)).join(", ")} />
                  ) : null,
                  plural(mine.length, "run"),
                  proven > 0 ? <span key="proven" className="shrink-0 whitespace-nowrap text-ok tabular-nums">{proven} proven</span> : null,
                ]}
                trailing={<ModulePills ids={modulesOf(t)} packs={packs} compact max={2} className="@xl:flex-nowrap @xl:justify-end" />}
                menu={
                  <RowMenu label={`Actions for ${t.title}`}>
                    <RowMenuItem onClick={() => openDetail(t)}>
                      <PanelRight /> View details
                    </RowMenuItem>
                    <RowMenuSeparator />
                    <RowMenuItem variant="destructive" disabled={!own} onClick={() => askRemove(t)}>
                      <Trash2 /> Remove scope
                    </RowMenuItem>
                    {own ? null : <p className="px-1.5 pt-0.5 pb-1 text-[11px] leading-snug text-muted-foreground">A demo scope ships with the app.</p>}
                  </RowMenu>
                }
                onOpen={() => openDetail(t)}
                active={detail?.open === true && detail.id === t.id}
              />
            )
          })}
        </ListCard>
      )}

      <Sheet open={detail?.open === true && !!shown} onOpenChange={(open) => setDetail((d) => (d ? { ...d, open } : d))}>
        <SheetContent ref={sheet} initialFocus={sheet} className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {shown ? (
            <ScopeDetail
              target={shown}
              own={isOwn(shown)}
              packs={packs}
              runs={runsOf(shown)}
              onOpenRun={onOpenRun}
              onRemove={() => askRemove(shown)}
              onChanged={onChanged}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[calc(100svh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add scope</DialogTitle>
            <DialogDescription>Type a GitHub URL, a website address or a folder path, then press Enter. One scope holds code or websites, not both.</DialogDescription>
          </DialogHeader>
          <AddScopeForm
            packs={packs}
            onClose={() => setAdding(false)}
            onAttached={() => {
              setAdding(false)
              onChanged()
            }}
          />
        </DialogContent>
      </Dialog>

      <RemoveScopeDialog
        scope={removing?.scope ?? null}
        open={removing?.open === true}
        onOpenChange={(open) => setRemoving((r) => (r ? { ...r, open } : r))}
        onRemoved={() => {
          setRemoving((r) => (r ? { ...r, open: false } : r))
          setDetail((d) => (d ? { ...d, open: false } : d))
          onChanged()
        }}
      />
    </ListPage>
  )
}

// One scope, in the sheet. Every scope shows the same blocks in the same order.
function ScopeDetail({
  target: t,
  own,
  packs,
  runs,
  onOpenRun,
  onRemove,
  onChanged,
}: {
  target: TargetChoice
  own: boolean
  packs: PackChoice[]
  runs: ScopedRun[]
  onOpenRun: (id: string) => void
  onRemove: () => void
  onChanged: () => void
}) {
  const items = contents(t)
  return (
    <>
      <SheetHeader className="flex-row items-start gap-3 pr-12">
        <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
          <ScopeIcon target={t} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <SheetTitle className="leading-snug wrap-anywhere">{t.title}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1.5 text-xs">
            {SCOPE_KIND[t.kind]}
            {own ? null : demoBadge}
            {t.runnable ? null : blockedBadge}
          </SheetDescription>
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-6">
        {t.blurb ? <p className="text-[13px] leading-relaxed">{t.blurb}</p> : null}

        <section className="flex flex-col gap-2">
          <Label>Modules</Label>
          <ModulePills ids={modulesOf(t)} packs={packs} className="gap-1.5" />
        </section>

        <section className="flex flex-col gap-2">
          <Label>Brief</Label>
          {own ? (
            <BriefField key={t.id} target={t} onSaved={onChanged} />
          ) : (
            <p className="text-xs text-muted-foreground">A demo scope takes no brief.</p>
          )}
        </section>

        {items.length ? (
          <section className="flex flex-col gap-2">
            <Label>In this scope</Label>
            <ul className="flex flex-col gap-1.5">
              {items.map((i) => (
                <li key={i.text} className="flex items-start gap-2 text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
                  {i.kind === "site" ? <Globe /> : i.kind === "repo" ? <FolderGit2 /> : i.kind === "folder" ? <Folder /> : <ScopeIcon target={t} />}
                  {i.href ? (
                    <a
                      href={i.href}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 rounded-sm font-mono text-[11.5px] leading-[18px] break-all underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      {i.text}
                    </a>
                  ) : (
                    <span className="min-w-0 font-mono text-[11.5px] leading-[18px] break-all">{i.text}</span>
                  )}
                  {i.note ? <span className="ml-auto shrink-0 text-[11px] leading-[18px] tabular-nums">{i.note}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <Label>Runs</Label>
          {runs.length ? (
            <RunLinks runs={runs} onOpen={onOpenRun} />
          ) : (
            <p className="text-xs text-muted-foreground">{t.runnable ? "No runs yet. Pick it in New run." : "No runs yet."}</p>
          )}
        </section>
      </div>

      <SheetFooter className="border-t">
        {own ? (
          <Button variant="outline" size="sm" className="self-start text-muted-foreground hover:text-destructive" onClick={onRemove}>
            <Trash2 /> Remove scope
          </Button>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">A demo scope ships with the app. It cannot be removed.</p>
        )}
      </SheetFooter>
    </>
  )
}

// The add form, inside the Add scope dialog. It starts open, and the dialog
// closes when the form closes itself (Esc in a field, or a saved scope).
function AddScopeForm({ packs, onAttached, onClose }: { packs: PackChoice[]; onAttached: () => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* The dialog has its own close button, so the form's is hidden. So is
          the closed-state button, which would flash while the dialog fades. */}
      <div className="[&_button[aria-label=Cancel]]:hidden [&>button]:hidden [&>div]:mt-0">
        <AddScope packs={packs} defaultOpen onClose={onClose} onAttached={onAttached} onError={setError} />
      </div>
      {error ? <p role="alert" className="text-xs leading-relaxed text-bad">{error}</p> : null}
    </div>
  )
}

// The scope brief: the operator's text for the model. Every run of the scope
// gets it in the agent's instructions, and a follow-up gets the current one.
// The server keeps the limit and refuses more with a sentence; the count shows
// only near it.
const BRIEF_MAX = 8000
function BriefField({ target, onSaved }: { target: TargetChoice; onSaved: () => void }) {
  const saved = target.brief ?? ""
  const [text, setText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const length = text.trim().length
  const dirty = text.trim() !== saved
  const save = () => {
    if (!dirty || busy) return
    setBusy(true)
    setError(null)
    saveScopeBrief(target.id, text)
      .then(() => {
        setDone(true)
        onSaved()
      }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Textarea
        aria-label={`Brief for ${target.title}`}
        value={text}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value)
          setDone(false)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
        }}
        placeholder="Optional. What every run of this scope should know: what matters most, what to look at first, how to report."
        className="max-h-64 min-h-20 overflow-y-auto text-[13px] leading-relaxed md:text-[13px]"
      />
      <div className="flex min-h-7 items-center gap-3">
        <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={save}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {dirty && !text.trim() ? "Clear brief" : "Save brief"}
        </Button>
        {done && !dirty ? <span className="text-xs text-muted-foreground">Saved. The next run and the next follow-up get it.</span> : null}
        {length > BRIEF_MAX - 1000 ? (
          <span className={cn("ml-auto text-[11px] tabular-nums", length > BRIEF_MAX ? "text-warn" : "text-muted-foreground")}>
            {length.toLocaleString("en-US")} / {BRIEF_MAX.toLocaleString("en-US")}
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-warn">
          {error}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">Text for the model only. It never adds a host, a grant or a tool.</p>
      )}
      <p className="-mt-1 text-[11px] leading-relaxed text-muted-foreground">Do not paste secrets here. The brief is saved with each run.</p>
    </>
  )
}

function RemoveScopeDialog({
  scope,
  open,
  onOpenChange,
  onRemoved,
}: {
  scope: TargetChoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = () => {
    if (!scope) return
    setBusy(true)
    setError(null)
    removeScope(scope.id)
      .then(onRemoved, (e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove this scope?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground wrap-anywhere">{scope?.title}</span> leaves the list. Runs against it stay in the sidebar.
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-xs text-bad">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
