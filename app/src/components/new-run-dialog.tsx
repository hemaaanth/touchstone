import { useRef, useState } from "react"
import { ArrowUp, Blocks, Check, ChevronDown, Cpu, FileCode2, FlaskConical, Folder, FolderGit2, Loader2, Plus, Shuffle, X } from "lucide-react"
import type { ModelChoice, PackChoice, SpendState, TargetChoice } from "@/lib/types"
import { attachScope, removeScope } from "@/lib/api"
import { DEFAULT_PACK, isOwnScope, packOf, scopeMeta } from "@/lib/catalog"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const RANDOM = "random"

// The New Run window, shaped like a composer. The body is the scope list: the
// one real choice, shown in place. Each scope shows its name and its file,
// nothing else. The last row adds a scope from GitHub URLs and local folders,
// for any module. The toolbar holds the model, this run's budget, and the send
// button. There is no free-text box: a run is autonomous, and the operator
// steers it once it is live.
// "Random" omits targetId, so the server picks and repeat runs do not
// re-break one bug.
export function NewRunDialog({
  open,
  onOpenChange,
  models,
  targets,
  packs,
  spend,
  busy,
  error,
  onStart,
  onScopesChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: ModelChoice[]
  targets: TargetChoice[]
  packs: PackChoice[]
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string, targetId?: string, budgetUsd?: number, pack?: string) => void
  onScopesChanged: () => void
}) {
  // The module. Contracts unless the operator picks another; the server sends the
  // list, so a new pack appears here by itself.
  const [packPicked, setPackPicked] = useState("")
  const pack = packs.some((p) => p.id === packPicked) ? packPicked : DEFAULT_PACK
  const runnable = targets.filter((t) => t.runnable && packOf(t) === pack)
  // The operator's pick, else the default model (the server lists it first).
  const [picked, setAlias] = useState("")
  const alias = picked || models[0]?.alias || ""
  const [scopeId, setScopeId] = useState(RANDOM)
  const listRef = useRef<HTMLDivElement>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)

  // A scope can be added under any module. The engine runs operator scopes
  // under their own pack (Contracts today), so the dialog moves there and
  // selects the new scope; it never starts a run the server would refuse.
  const onAttached = (scope: TargetChoice) => {
    setScopeError(null)
    setPackPicked(packOf(scope))
    setScopeId(scope.id)
    onScopesChanged()
  }
  const onRemove = (id: string) => {
    removeScope(id)
      .then(() => {
        if (scopeId === id) setScopeId(RANDOM)
        onScopesChanged()
      })
      .catch((e: Error) => setScopeError(e.message))
  }

  // This run's budget. Blank means the default from Settings.
  const [budget, setBudget] = useState("")
  const budgetN = budget.trim() === "" ? undefined : Number(budget)
  const budgetOk = budgetN === undefined || (Number.isFinite(budgetN) && budgetN >= 0.01 && budgetN <= 1000)
  const canStart = alias !== "" && runnable.length > 0 && !busy && budgetOk
  const ids = [RANDOM, ...runnable.map((t) => t.id)]

  const submit = () => {
    if (!canStart) return
    onStart(alias, scopeId === RANDOM ? undefined : scopeId, budgetN, pack)
  }

  // Arrow keys move the selection (and focus) through the list. Enter starts.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
      return
    }
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = ids[(ids.indexOf(scopeId) + step + ids.length) % ids.length]
    setScopeId(next)
    listRef.current?.querySelector<HTMLElement>(`[data-id="${next}"]`)?.focus()
  }

  // A scope belongs to one module, so a new module starts at Random scope.
  const onPack = (id: string) => {
    setPackPicked(id)
    setScopeId(RANDOM)
  }

  const notice = !budgetOk
    ? "The budget must be between $0.01 and $1,000."
    : scopeError
      ? scopeError
      : runnable.length === 0
        ? "No runnable scopes are available for this module right now."
        : error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-lg"
        initialFocus={() =>
          listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? null
        }
      >
        <DialogTitle className="px-4 pt-3.5 pb-2 text-sm font-medium">New run</DialogTitle>

        <div className="max-h-[min(24rem,60vh)] overflow-y-auto px-2 pb-2">
          <div
            ref={listRef}
            role="radiogroup"
            aria-label="Scope"
            onKeyDown={onListKey}
            className="flex flex-col gap-0.5"
          >
            <ScopeRow
              id={RANDOM}
              selected={scopeId === RANDOM}
              onSelect={setScopeId}
              icon={<Shuffle />}
              title="Random scope"
            />
            {runnable.map((t) => (
              <ScopeRow
                key={t.id}
                id={t.id}
                selected={scopeId === t.id}
                onSelect={setScopeId}
                icon={<ScopeIcon target={t} />}
                title={t.title}
                meta={scopeMeta(t)}
                onRemove={isOwnScope(t.id) ? () => onRemove(t.id) : undefined}
              />
            ))}
          </div>
          <AddScope onAttached={onAttached} onError={setScopeError} />
        </div>

        {notice ? <p className="border-t border-border/60 px-4 py-2 text-xs text-bad">{notice}</p> : null}

        <div className="flex min-w-0 items-center gap-2 border-t border-border/60 px-2 py-2">
          <ModulePill packs={packs} pack={pack} onPack={onPack} />
          <ModelPill models={models} alias={alias} onAlias={setAlias} />
          <span className="flex-1" />
          <label
            className="flex h-8 shrink-0 items-center rounded-full border border-border/60 pr-3 pl-3 text-xs text-muted-foreground focus-within:border-ring focus-within:text-foreground"
            title="Budget for this run. The run stops when it reaches it."
          >
            $
            <input
              className="min-w-3 max-w-16 field-sizing-content bg-transparent px-0.5 tabular-nums text-foreground outline-none placeholder:text-muted-foreground"
              inputMode="decimal"
              value={budget}
              placeholder={spend ? String(spend.budgetUsd) : "5"}
              onChange={(e) => setBudget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-label="Budget for this run in USD"
            />
            <span className="max-sm:hidden">budget</span>
          </label>
          <Button
            size="icon"
            onClick={submit}
            disabled={!canStart}
            aria-label="Start run"
            title="Start run (Enter)"
            className="shrink-0 rounded-full"
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// A scope's kind, as an icon: a lab, local folders, or linked repos.
export function ScopeIcon({ target: t }: { target: Pick<TargetChoice, "kind" | "links"> }) {
  if (t.kind === "lab") return <FlaskConical />
  if (t.kind === "local-source") return <Folder />
  return t.links?.length ? <FolderGit2 /> : <FileCode2 />
}

// One scope: its name and, when it has one, its file. The check column has a
// fixed width so rows do not shift on selection. The remove button is a
// sibling of the radio, not a child, and shows on hover.
function ScopeRow({
  id,
  selected,
  onSelect,
  icon,
  title,
  meta,
  onRemove,
}: {
  id: string
  selected: boolean
  onSelect: (id: string) => void
  icon: React.ReactNode
  title: string
  meta?: string
  onRemove?: () => void
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-id={id}
        tabIndex={selected ? 0 : -1}
        onClick={() => onSelect(id)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none",
          "focus-visible:ring-1 focus-visible:ring-foreground/15",
          selected ? "bg-muted" : "hover:bg-muted/50",
        )}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="truncate text-[13.5px] font-medium">{title}</span>
          {meta ? (
            <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground">{meta}</span>
          ) : null}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center">
          {selected ? <Check className="size-3.5" /> : null}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${title}`}
          title="Remove scope"
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-muted text-muted-foreground opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5"
        >
          <X />
        </button>
      ) : null}
    </div>
  )
}

// Folders that hold dependencies or build output, not the code under audit.
const SKIP_DIRS = new Set(["lib", "node_modules", "out", "cache", "broadcast", "artifacts"])

// Read a picked folder into { path, content }, keeping only Solidity source.
// The folder's own name is dropped from each path and becomes its label.
async function readFolder(list: FileList) {
  const all = Array.from(list)
  const first = all[0]?.webkitRelativePath ?? ""
  const root = first.includes("/") ? first.split("/")[0] : ""
  const files: { path: string; content: string }[] = []
  for (const f of all) {
    const rel = root ? f.webkitRelativePath.slice(root.length + 1) : f.name
    const parts = rel.split("/")
    if (!rel.endsWith(".sol") || parts.some((p) => p.startsWith(".") || SKIP_DIRS.has(p))) continue
    files.push({ path: rel, content: await f.text() })
  }
  return { name: root || "folder", files }
}

// The server takes only HTTPS GitHub repo, folder, or file URLs. Check here
// too, so a bad URL is refused when it is added, not when the scope is saved.
function githubUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const ok =
    u.protocol === "https:" &&
    u.hostname === "github.com" &&
    !u.username &&
    !u.password &&
    !u.port &&
    /^\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/.+)?\/?$/.test(u.pathname)
  if (!ok) return null
  u.search = ""
  u.hash = ""
  return u.href
}

const repoName = (url: string) => new URL(url).pathname.split("/")[2] ?? url

type Source =
  | { kind: "repo"; url: string }
  | { kind: "folder"; name: string; files: { path: string; content: string }[] }

const sourceKey = (s: Source) => (s.kind === "repo" ? s.url : `folder:${s.name}`)
const sourceLabel = (s: Source) => (s.kind === "repo" ? repoName(s.url) : s.name)

// What POST /api/scopes gets for a list of sources. One repo is a repo scope.
// Several repos are one brief that links each of them. Folders are one source
// scope; with more than one folder, each path keeps its folder name. The
// scope store has no kind for repos and folders together, so that mix is
// refused here with a reason.
function scopeBody(sources: Source[], name: string): Parameters<typeof attachScope>[0] | string {
  const repos = sources.flatMap((s) => (s.kind === "repo" ? [s.url] : []))
  const folders = sources.flatMap((s) => (s.kind === "folder" ? [s] : []))
  if (repos.length && folders.length) return "Repos and folders cannot share a scope yet."
  const title = name || sources.map(sourceLabel).join(" + ")
  if (repos.length === 1) return { title, repo: repos[0] }
  if (repos.length) {
    return {
      title,
      brief: `Audit the Solidity code in these repositories as one unit:\n\n${repos.map((r) => `- ${r}`).join("\n")}\n`,
    }
  }
  const files =
    folders.length === 1
      ? folders[0].files
      : folders.flatMap((f) => f.files.map((x) => ({ path: `${f.name}/${x.path}`, content: x.content })))
  return { title, files }
}

// The add row under a scope list. Closed, it is one quiet row. Open, the same
// row becomes the input in place: same height, padding, and text start, so
// nothing moves. A scope holds one or more GitHub repos or local folders; each
// one added shows in a list under the row, and the scope is saved as one unit.
export function AddScope({
  onAttached,
  onError,
}: {
  onAttached: (scope: TargetChoice) => void
  onError: (msg: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const body = sources.length ? scopeBody(sources, name.trim()) : null
  const blocked = typeof body === "string" ? body : null

  const close = () => {
    setOpen(false)
    setUrl("")
    setName("")
    setSources([])
    onError(null)
  }
  const add = (s: Source) => {
    onError(null)
    setSources((list) => (list.some((x) => sourceKey(x) === sourceKey(s)) ? list : [...list, s]))
  }
  const addUrl = () => {
    const href = githubUrl(url)
    if (!href) return onError("Use an HTTPS GitHub repository, folder, or file URL.")
    add({ kind: "repo", url: href })
    setUrl("")
  }
  const save = () => {
    if (!body || typeof body === "string" || busy) return
    setBusy(true)
    onError(null)
    attachScope(body)
      .then((scope) => {
        close()
        onAttached(scope)
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false))
  }

  const onFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    const { name: folder, files } = await readFolder(list)
    e.target.value = ""
    if (!files.length) return onError(`No Solidity files found in ${folder}.`)
    add({ kind: "folder", name: folder, files })
    inputRef.current?.focus()
  }

  // One row box for both states. Only its contents change.
  const row = "flex h-9 w-full items-center gap-3 rounded-lg pr-1 pl-2.5 text-left text-[13.5px] [&_svg]:size-4"

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          row,
          "mt-0.5 text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/15",
        )}
      >
        <Plus className="shrink-0" />
        <span className="leading-none">Add scope</span>
      </button>
    )
  }

  const chip =
    "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
  return (
    <div className="mt-0.5 rounded-lg bg-muted/50">
      <div className={row}>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
        </span>
        <input
          ref={inputRef}
          autoFocus
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              close()
            }
            if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              if (url.trim()) addUrl()
              else save()
            }
          }}
          placeholder={sources.length ? "Add another GitHub URL" : "GitHub URL"}
          aria-label="GitHub repository URL"
          className="h-full min-w-0 flex-1 bg-transparent leading-none outline-none placeholder:text-muted-foreground"
        />
        <button type="button" className={chip} disabled={busy} onClick={() => folderRef.current?.click()}>
          <Folder /> Folder
        </button>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel (Esc)"
          onClick={close}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
        >
          <X />
        </button>
        <input
          ref={folderRef}
          type="file"
          hidden
          onChange={onFolder}
          {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
        />
      </div>

      {sources.length ? (
        <>
          <ul className="flex flex-col border-t border-border/60 py-1" aria-label="Sources in this scope">
            {sources.map((s) => (
              <li key={sourceKey(s)} className="flex h-8 items-center gap-3 pr-1 pl-2.5 [&_svg]:size-4">
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {s.kind === "repo" ? <FolderGit2 /> : <Folder />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {s.kind === "repo" ? s.url.replace(/^https:\/\/github\.com\//, "") : `${s.name}/`}
                </span>
                {s.kind === "folder" ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {s.files.length} {s.files.length === 1 ? "file" : "files"}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${sourceLabel(s)}`}
                  title="Remove from scope"
                  disabled={busy}
                  onClick={() => setSources((list) => list.filter((x) => sourceKey(x) !== sourceKey(s)))}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 border-t border-border/60 py-1.5 pr-1.5 pl-2.5">
            <input
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation()
                  close()
                }
                if (e.key === "Enter") {
                  e.preventDefault()
                  e.stopPropagation()
                  save()
                }
              }}
              maxLength={120}
              placeholder={sources.map(sourceLabel).join(" + ")}
              aria-label="Scope name"
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {blocked ?? `${sources.length} ${sources.length === 1 ? "source" : "sources"}, tested as one unit`}
            </span>
            <Button size="sm" className="h-7 shrink-0" disabled={busy || !!blocked} onClick={save}>
              Add scope
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

// The model, as a pill in the toolbar. With one model there is nothing to
// choose, so it is a static label; with more it opens a menu.
function ModelPill({
  models,
  alias,
  onAlias,
}: {
  models: ModelChoice[]
  alias: string
  onAlias: (alias: string) => void
}) {
  const current = models.find((m) => m.alias === alias)
  const pill =
    "flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-3 font-mono text-xs text-muted-foreground [&_svg]:size-3.5"
  if (models.length <= 1) {
    return (
      <span className={pill} title={current?.id}>
        <Cpu />
        <span className="truncate">{alias || "No model"}</span>
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(pill, "outline-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted")}
      >
        <Cpu />
        <span className="truncate">{alias}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuRadioGroup value={alias} onValueChange={(v) => onAlias(String(v))}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.alias} value={m.alias} className="items-start">
              <span className="flex flex-col gap-0.5">
                <span className="font-mono text-xs">{m.alias}</span>
                <span className="text-xs text-muted-foreground">
                  {m.id}
                  {m.abliterated ? " · abliterated" : ""}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The module (pack), as a pill beside the model. One module is a static label;
// two or more open a menu. Same look as the model pill.
function ModulePill({
  packs,
  pack,
  onPack,
}: {
  packs: PackChoice[]
  pack: string
  onPack: (id: string) => void
}) {
  const current = packs.find((p) => p.id === pack)
  const label = current?.title ?? pack
  const pill =
    "flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-3 text-xs text-muted-foreground [&_svg]:size-3.5"
  if (packs.length <= 1) {
    return (
      <span className={pill} title="Module">
        <Blocks />
        <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Module"
        className={cn(pill, "outline-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted")}
      >
        <Blocks />
        <span className="truncate">{label}</span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup value={pack} onValueChange={(v) => onPack(String(v))}>
          {packs.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.title}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
