import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { Bot, Bug, Check, ChevronRight, FileText, PanelRight, Search, X } from "lucide-react"
import type { Finding, FindingSummary, PackChoice, RunSummary } from "@/lib/types"
import { fetchFinding, fetchFindingText, fetchFindings } from "@/lib/api"
import { runTitle } from "@/lib/format"
import { ALL, DEFAULT_VIEW, filterFindings, isFiltered, moduleOf, scopeOf, SORTS, sortFindings, TOO_LONG, type FindingsView, type SortKey, type StateFilter } from "@/lib/findings-view"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { ProofIcon, SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { StatusMark } from "@/components/assistant-ui/elements/surfaces"
import { ModulePill } from "@/components/module-pill"
import { ReplayProof } from "@/components/replay-proof"
import { Label, ListCard, ListEmpty, ListLoading, ListPage, ListRow, RowMenu, RowMenuItem, RowMenuSeparator, TruncatedText } from "@/components/page-parts"

// Every finding from every run, in one list to scan, filter and share. A row
// opens the finding in a sheet at the right, so the list never moves. The
// proof state comes from the server (`proven`): green only after a replay
// proved it; everything else is neutral. The copied texts come from the
// server's report builder, which redacts secrets; the browser never builds
// them from the stored record.

// ── Saved view ──────────────────────────────────────────────────────────────

// The filters and the sort stay in localStorage, as the sidebar width does,
// so a reload keeps them.
const VIEW_KEY = "ts.findingsView"
function readView(): FindingsView {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Partial<FindingsView>
    const view = { ...DEFAULT_VIEW }
    for (const k of Object.keys(DEFAULT_VIEW) as (keyof FindingsView)[]) {
      if (typeof saved[k] === "string") (view as Record<string, string>)[k] = saved[k]
    }
    if (!SORTS.some((s) => s.value === view.sort)) view.sort = DEFAULT_VIEW.sort
    if (view.dismissed !== "show") view.dismissed = "hide"
    return view
  } catch {
    return { ...DEFAULT_VIEW }
  }
}

// ── Format ──────────────────────────────────────────────────────────────────

const SEVERITIES = ["critical", "high", "medium", "low", "informational"]
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
// "Nov 11, 06:19", with the year when it is not this year.
function when(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const year = d.getFullYear() !== new Date(now).getFullYear()
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hour12: false })
}

// ── Copy ────────────────────────────────────────────────────────────────────

export type CopyFormat = "md" | "agent"
const COPY_LABEL: Record<CopyFormat, string> = { md: "Copy report (Markdown)", agent: "Copy for an agent" }

// Ask the server for the text and put it on the clipboard. The ClipboardItem
// path keeps the click's permission while the fetch runs (Safari needs it).
async function copyFinding(id: string, format: CopyFormat): Promise<{ tooLong: boolean }> {
  const text = fetchFindingText(id, format)
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
  } else {
    await navigator.clipboard.writeText(await text)
  }
  return { tooLong: TOO_LONG.test(await text) }
}

// A copy's result, kept for the finding it was copied from. The list's count
// line shows a short word for a moment; the sheet of that finding shows the
// full line, until another finding opens or another copy starts.
type CopyNote = { id: string; format: CopyFormat; result: "done" | "too-long" | "error" }
const WHAT: Record<CopyFormat, string> = { md: "the report", agent: "the agent brief" }
const shortNote = (n: CopyNote) =>
  n.result === "error" ? "Could not copy." : n.result === "too-long" ? "Copied, with a part left out." : `Copied ${WHAT[n.format]}.`
const fullNote = (n: CopyNote) =>
  n.result === "error"
    ? "Could not copy. The server did not answer, or the browser blocked the clipboard."
    : n.result === "too-long"
      ? `Copied ${WHAT[n.format]}. A part over 64 KB could not be checked for secrets, so it was left out.`
      : `Copied ${WHAT[n.format]}.`

// `onTooLong` opens the finding's sheet: the line that says a part was left
// out is shown there in full, never cut in the count line.
function useCopy(onTooLong: (id: string) => void) {
  const [note, setNote] = useState<CopyNote | null>(null)
  const [flash, setFlash] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const tooLong = useRef(onTooLong)
  useEffect(() => {
    tooLong.current = onTooLong
  })
  // Stable, so a memoised row does not render again when the note changes.
  const copy = useCallback((f: FindingSummary, format: CopyFormat) => {
    clearTimeout(timer.current)
    setNote(null)
    const done = (result: CopyNote["result"]) => {
      setNote({ id: f.id, format, result })
      setFlash(true)
      if (result === "too-long") tooLong.current(f.id)
      timer.current = setTimeout(() => setFlash(false), 5000)
    }
    copyFinding(f.id, format).then(
      ({ tooLong }) => done(tooLong ? "too-long" : "done"),
      () => done("error"),
    )
  }, [])
  // Opening another finding drops the note of the last one.
  const keepOnly = useCallback((id: string) => setNote((n) => (n?.id === id ? n : null)), [])
  return { note, flash: flash ? note : null, copy, keepOnly }
}

// ── The page ────────────────────────────────────────────────────────────────

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; rows: FindingSummary[] }

export function FindingsPage({
  packs,
  runs,
  onOpenRun,
}: {
  packs: PackChoice[]
  runs: RunSummary[]
  onOpenRun: (id: string, findingId?: string) => void
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    fetchFindings().then(
      (rows) => live && setLoad({ state: "ready", rows }),
      () => live && setLoad({ state: "error" }),
    )
    return () => {
      live = false
    }
  }, [attempt])

  const [view, setView] = useState<FindingsView>(readView)
  useEffect(() => localStorage.setItem(VIEW_KEY, JSON.stringify(view)), [view])
  const set = <K extends keyof FindingsView>(k: K, v: FindingsView[K]) => setView((cur) => ({ ...cur, [k]: v }))

  const all = useMemo(() => (load.state === "ready" ? load.rows : []), [load])
  // The list follows the filters a beat behind the input, so typing stays
  // quick with many rows. Rows that stay in the list do not render again.
  const deferred = useDeferredValue(view)
  const shown = useMemo(() => sortFindings(filterFindings(all, deferred), deferred.sort), [all, deferred])
  const packTitle = (id: string) => packs.find((p) => p.id === id)?.title
  const runOf = (f: FindingSummary) => (f.runId ? runs.find((r) => r.id === f.runId) : undefined)

  // The sheet keeps its finding while it slides out, so `open` is its own flag.
  const [detail, setDetail] = useState<{ id: string; open: boolean } | null>(null)
  const open = detail ? all.find((f) => f.id === detail.id) : undefined
  const sheet = useRef<HTMLDivElement>(null)
  const { note, flash, copy, keepOnly } = useCopy((id) => setDetail({ id, open: true }))
  const openDetail = useCallback(
    (f: FindingSummary) => {
      keepOnly(f.id)
      setDetail({ id: f.id, open: true })
    },
    [keepOnly],
  )

  const proven = shown.filter((f) => f.proven).length
  // Dismissed findings are hidden by default; the count line says how many.
  const hiddenDismissed = view.dismissed === "hide" ? all.filter((f) => f.dismissed).length : 0
  // Clear filters keeps the sort and the dismissed choice.
  const clear = () => setView((v) => ({ ...DEFAULT_VIEW, sort: v.sort, dismissed: v.dismissed }))

  return (
    <ListPage
      title="Findings"
      description="Every finding from every run. Proven ones first. Open one to see its proof, or copy it to share."
    >
      {load.state === "loading" ? (
        <ListLoading label="Loading findings…" />
      ) : load.state === "error" ? (
        <ListEmpty
          title="The findings list is unknown"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoad({ state: "loading" })
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </Button>
          }
        >
          The server did not answer.
        </ListEmpty>
      ) : all.length === 0 ? (
        <ListEmpty icon={Bug} title="No findings yet">
          Findings appear here when a run submits one.
        </ListEmpty>
      ) : (
        <>
          <Filters view={view} set={set} rows={all} packTitle={packTitle} />

          <div className="-mt-3 flex min-h-5 items-center gap-3 text-xs text-muted-foreground">
            <span className="shrink-0 tabular-nums">
              {isFiltered(view) ? `${shown.length} of ${all.length - hiddenDismissed} findings` : `${shown.length} findings`}
              {proven ? <span className="text-ok"> · {proven} proven</span> : null}
              {hiddenDismissed ? ` · ${hiddenDismissed} dismissed, hidden` : null}
            </span>
            {/* Here, not in the filter rows, so showing it moves nothing. */}
            {isFiltered(view) && shown.length > 0 ? (
              <Button variant="ghost" size="xs" className="-my-1 text-muted-foreground" onClick={clear}>
                <X /> Clear filters
              </Button>
            ) : null}
            <span role="status" className={cn("ml-auto min-w-0 truncate text-right", flash?.result === "error" && "text-foreground")}>
              {flash ? shortNote(flash) : null}
            </span>
          </div>

          {shown.length === 0 && !isFiltered(view) && hiddenDismissed ? (
            <ListEmpty
              icon={Bug}
              title="Every finding is dismissed"
              action={
                <Button size="sm" variant="outline" onClick={() => set("dismissed", "show")}>
                  Show dismissed
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <ListEmpty
              icon={Search}
              title="No finding matches these filters"
              action={
                <Button size="sm" variant="outline" onClick={clear}>
                  <X /> Clear filters
                </Button>
              }
            />
          ) : (
            <ListCard aria-label="Findings">
              {shown.map((f) => (
                <FindingListRow
                  key={f.id}
                  finding={f}
                  moduleTitle={packTitle(moduleOf(f)) ?? f.module}
                  run={runOf(f)}
                  active={detail?.open === true && detail.id === f.id}
                  onOpen={openDetail}
                  onCopy={copy}
                  onOpenRun={onOpenRun}
                />
              ))}
            </ListCard>
          )}
        </>
      )}

      <Sheet open={detail?.open === true && !!open} onOpenChange={(o) => setDetail((d) => (d ? { ...d, open: o } : d))}>
        <SheetContent ref={sheet} initialFocus={sheet} className="gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {open ? (
            <FindingDetail
              finding={open}
              moduleTitle={packTitle(moduleOf(open)) ?? open.module}
              run={runOf(open)}
              note={note?.id === open.id ? note : null}
              onCopy={(format) => copy(open, format)}
              onOpenRun={onOpenRun}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </ListPage>
  )
}

// ── Filters ─────────────────────────────────────────────────────────────────

function FilterSelect({
  label,
  value,
  items,
  onChange,
  className,
}: {
  label: string
  value: string
  items: { value: string; label: string }[]
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v != null && onChange(String(v))}>
      <SelectTrigger aria-label={label} className={cn("min-w-0 text-[13px]", className)}>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start" className="p-1">
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value} className="text-[13px]">
            <span className="truncate">{i.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Filters({
  view,
  set,
  rows,
  packTitle,
}: {
  view: FindingsView
  set: <K extends keyof FindingsView>(k: K, v: FindingsView[K]) => void
  rows: FindingSummary[]
  packTitle: (id: string) => string | undefined
}) {
  // Each list holds only the values the findings have.
  const scopes = useMemo(() => [...new Set(rows.map(scopeOf))].sort((a, b) => a.localeCompare(b)), [rows])
  const modules = useMemo(() => {
    const seen = new Map<string, string>()
    for (const f of rows) if (moduleOf(f) && !seen.has(moduleOf(f))) seen.set(moduleOf(f), f.module)
    return [...seen].map(([id, title]) => ({ value: id, label: packTitle(id) ?? title })).sort((a, b) => a.label.localeCompare(b.label))
  }, [rows, packTitle])
  const hasDismissed = useMemo(() => rows.some((f) => f.dismissed), [rows])
  const severities = useMemo(() => {
    const has = new Set(rows.map((f) => (f.severity ?? "").toLowerCase()))
    return SEVERITIES.filter((s) => has.has(s))
  }, [rows])
  const date = "h-8 w-[8.5rem] shrink-0 px-2 text-[13px]"

  return (
    <div role="search" aria-label="Filter findings" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={view.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="Search titles"
            aria-label="Search finding titles"
            className="h-8 pl-8! text-[13px]"
          />
        </div>
        <div role="group" aria-label="Run date" className="flex items-center gap-1.5">
          <Input type="date" value={view.from} max={view.to || undefined} onChange={(e) => set("from", e.target.value)} aria-label="From date" className={date} />
          <span aria-hidden className="text-xs text-muted-foreground">–</span>
          <Input type="date" value={view.to} min={view.from || undefined} onChange={(e) => set("to", e.target.value)} aria-label="To date" className={date} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect label="Scope" value={view.scope} items={[{ value: ALL, label: "All scopes" }, ...scopes.map((s) => ({ value: s, label: s }))]} onChange={(v) => set("scope", v)} className="max-w-52" />
        <FilterSelect label="Module" value={view.module} items={[{ value: ALL, label: "All modules" }, ...modules]} onChange={(v) => set("module", v)} className="max-w-48" />
        <FilterSelect label="Severity" value={view.severity} items={[{ value: ALL, label: "All severities" }, ...severities.map((s) => ({ value: s, label: cap(s) }))]} onChange={(v) => set("severity", v)} />
        <FilterSelect
          label="Proof state"
          value={view.state}
          items={[
            { value: "all", label: "Any state" },
            { value: "proven", label: "Proven" },
            { value: "unproven", label: "Not proven" },
          ]}
          onChange={(v) => set("state", v as StateFilter)}
        />
        {/* Shown only when some finding is dismissed, so it never sits there dead. */}
        {hasDismissed ? (
          <Button
            variant="outline"
            aria-pressed={view.dismissed === "show"}
            onClick={() => set("dismissed", view.dismissed === "show" ? "hide" : "show")}
            className="text-[13px] font-normal aria-pressed:bg-muted"
          >
            {view.dismissed === "show" ? <Check /> : null}
            Show dismissed
          </Button>
        ) : null}
        <FilterSelect
          label="Sort by"
          value={view.sort}
          items={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))}
          onChange={(v) => set("sort", v as SortKey)}
          className="ml-auto"
        />
      </div>
    </div>
  )
}

// ── One row ─────────────────────────────────────────────────────────────────

export const FindingListRow = memo(function FindingListRow({
  finding: f,
  moduleTitle,
  run,
  active,
  onOpen,
  onCopy,
  onOpenRun,
}: {
  finding: FindingSummary
  moduleTitle: string
  run: RunSummary | undefined
  active: boolean
  onOpen: (f: FindingSummary) => void
  onCopy: (f: FindingSummary, format: CopyFormat) => void
  onOpenRun: (id: string, findingId?: string) => void
}) {
  const open = () => onOpen(f)
  return (
    <ListRow
      icon={<ProofIcon state={f.proven ? "proven" : "unproven"} className="size-4" />}
      title={f.title || "Untitled finding"}
      badges={
        <>
          <SeverityMark severity={f.severity} proven={f.proven} />
        </>
      }
      meta={[
        // A dismissed finding says so first; its proof state stays true.
        f.dismissed ? <span key="dismissed" className="shrink-0 whitespace-nowrap font-medium text-foreground">Dismissed</span> : null,
        f.proven ? (
          <span key="state" className="shrink-0 whitespace-nowrap text-ok">Proven</span>
        ) : (
          "Not proven"
        ),
        <TruncatedText key="scope" text={scopeOf(f)} />,
        f.at != null ? <span key="at" className="shrink-0 whitespace-nowrap tabular-nums" title="When the run started">{when(f.at)}</span> : "Date not recorded",
      ]}
      trailing={moduleOf(f) ? <ModulePill id={moduleOf(f)} label={moduleTitle} compact /> : null}
      menu={
        <RowMenu label={`Actions for ${f.title}`}>
          <RowMenuItem onClick={open}>
            <PanelRight /> View details
          </RowMenuItem>
          <RowMenuItem disabled={!run} onClick={() => run && onOpenRun(run.id, f.id)}>
            <ChevronRight /> Open in run
          </RowMenuItem>
          <RowMenuSeparator />
          <RowMenuItem onClick={() => onCopy(f, "md")}>
            <FileText /> {COPY_LABEL.md}
          </RowMenuItem>
          <RowMenuItem onClick={() => onCopy(f, "agent")}>
            <Bot /> {COPY_LABEL.agent}
          </RowMenuItem>
        </RowMenu>
      }
      onOpen={open}
      active={active}
      className={f.dismissed ? "[&_[data-row-main]]:text-muted-foreground" : undefined}
    />
  )
})

// ── The sheet ───────────────────────────────────────────────────────────────

// The full record without the run's events, fetched when the sheet opens. The proof and the narrative
// render through the run view's own ReplayProof, so there is one renderer.
function useFullFinding(id: string) {
  const [got, setGot] = useState<{ id: string; finding: Finding | null; failed: boolean } | null>(null)
  useEffect(() => {
    let live = true
    fetchFinding(id, { events: false }).then(
      (finding) => live && setGot({ id, finding, failed: false }),
      () => live && setGot({ id, finding: null, failed: true }),
    )
    return () => {
      live = false
    }
  }, [id])
  return got?.id === id ? got : null
}

function FindingDetail({
  finding: f,
  moduleTitle,
  run,
  note,
  onCopy,
  onOpenRun,
}: {
  finding: FindingSummary
  moduleTitle: string
  run: RunSummary | undefined
  note: CopyNote | null
  onCopy: (format: CopyFormat) => void
  onOpenRun: (id: string, findingId?: string) => void
}) {
  const full = useFullFinding(f.id)
  return (
    <>
      <SheetHeader className="gap-1.5 pr-12">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>Finding</span>
          <SeverityMark severity={f.severity} proven={f.proven} />
          <StatusMark className="tracking-normal normal-case" mark={f.proven ? "proven" : "off"} />
        </div>
        <SheetTitle className="leading-snug text-pretty wrap-anywhere">{f.title || "Untitled finding"}</SheetTitle>
        <SheetDescription className="text-xs">
          {f.dismissed ? "Dismissed by the operator. " : ""}
          {cap(f.severity ?? "unrated")} severity · {f.proven ? "Proven by a replay." : "Not proven. A lead, not a replayed proof."}
        </SheetDescription>
      </SheetHeader>

      {/* min-w-0 and wrap-anywhere: one long unbroken string (a key, a URL)
          wraps instead of making the sheet scroll sideways. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-4 pt-1 pb-6 wrap-anywhere">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-2.5 text-[13px]">
          <dt><Label>Scope</Label></dt>
          <dd className="min-w-0 wrap-anywhere">{scopeOf(f)}</dd>
          <dt><Label>Module</Label></dt>
          <dd className="min-w-0">{moduleOf(f) ? <ModulePill id={moduleOf(f)} label={moduleTitle} /> : <span className="text-muted-foreground">Unknown</span>}</dd>
          <dt><Label>Run</Label></dt>
          <dd className="flex min-w-0 items-center gap-2">
            {run ? <TruncatedText text={runTitle(run)} /> : <TruncatedText mono middle text={f.runId ?? f.id} className="text-muted-foreground" />}
          </dd>
          <dt><Label>Started</Label></dt>
          <dd className="tabular-nums">{f.at != null ? when(f.at) : <span className="text-muted-foreground">Not recorded</span>}</dd>
        </dl>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {run ? (
              <Button size="sm" onClick={() => onOpenRun(run.id, f.id)}>
                Open in run <ChevronRight />
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => onCopy("md")}>
              <FileText /> {COPY_LABEL.md}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onCopy("agent")}>
              <Bot /> {COPY_LABEL.agent}
            </Button>
          </div>
          {run ? null : <p className="text-xs text-muted-foreground">This finding came from a run outside the console, so it has no run view.</p>}
          {note ? <p role="status" className="text-xs leading-relaxed text-muted-foreground">{fullNote(note)}</p> : null}
        </div>

        {full === null ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">Loading the proof…</span>
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        ) : full.finding ? (
          <ReplayProof finding={full.finding} />
        ) : (
          <p className="text-xs text-muted-foreground">The proof did not load. Close the sheet and open it again.</p>
        )}
      </div>
    </>
  )
}
