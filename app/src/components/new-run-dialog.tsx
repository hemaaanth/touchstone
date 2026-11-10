import { useRef, useState } from "react"
import { ArrowUp, Blocks, Check, ChevronDown, Cpu, FileCode2, FolderGit2, Loader2, Plus, Shuffle, X } from "lucide-react"
import type { ModelChoice, PackChoice, SpendState, TargetChoice } from "@/lib/types"
import { attachScope, removeScope } from "@/lib/api"
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
const DEFAULT_PACK = "contracts"

// The New Run window, shaped like a composer. The body is the scope list: the
// one real choice, shown in place. Each scope shows its name and its file,
// nothing else. The last row adds a scope from a GitHub URL, a folder, or files. The toolbar holds the model, this run's budget, and the send
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
  const runnable = targets.filter((t) => t.runnable && (t.pack ?? DEFAULT_PACK) === pack)
  // The operator's pick, else the default model (the server lists it first).
  const [picked, setAlias] = useState("")
  const alias = picked || models[0]?.alias || ""
  const [scopeId, setScopeId] = useState(RANDOM)
  const listRef = useRef<HTMLDivElement>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)

  const onAttached = (scope: TargetChoice) => {
    setScopeError(null)
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
                icon={t.links?.length ? <FolderGit2 /> : <FileCode2 />}
                title={t.title}
                meta={scopeMeta(t)}
                onRemove={isOwnScope(t.id) ? () => onRemove(t.id) : undefined}
              />
            ))}
          </div>
          {pack === DEFAULT_PACK ? <AddScope onAttached={onAttached} onError={setScopeError} /> : null}
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

// What a scope row shows on the right: its file, its file count, or its repo.
function scopeMeta(t: TargetChoice): string {
  if (t.files?.length) return t.files.length === 1 ? t.files[0] : `${t.files.length} files`
  if (t.links?.length) return t.links[0].replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")
  return t.entry
}

// Scopes the operator added (as opposed to the built-in labs) can be removed.
function isOwnScope(id: string) {
  return id.startsWith("source-") || id.startsWith("brief-")
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

// Read picked files into { path, content }, keeping only Solidity source.
// A picked folder's own name is dropped from each path and becomes the title.
async function readSolidity(list: FileList) {
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
  const title = root || files[0]?.path.replace(/\.sol$/, "") || ""
  return { title, files }
}

// The last row of the list: add your own scope. Closed, it is one quiet row.
// Open, it takes a GitHub URL (Enter), a folder, or Solidity files. The name
// comes from the repo or folder; there is nothing else to fill in.
function AddScope({
  onAttached,
  onError,
}: {
  onAttached: (scope: TargetChoice) => void
  onError: (msg: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const folderRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)

  const attach = (body: Parameters<typeof attachScope>[0]) => {
    setBusy(true)
    onError(null)
    attachScope(body)
      .then((scope) => {
        setOpen(false)
        setUrl("")
        onAttached(scope)
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false))
  }

  const onPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    const { title, files } = await readSolidity(list)
    e.target.value = ""
    if (!files.length) return onError("No Solidity files found there.")
    attach({ title, files })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-0.5 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/15 [&_svg]:size-4"
      >
        <Plus />
        Add scope
      </button>
    )
  }

  const chip =
    "h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
  return (
    <div className="mt-0.5 flex items-center gap-2 rounded-lg bg-muted/50 py-1 pr-1 pl-2.5 [&_svg]:size-4">
      <span className="text-muted-foreground">{busy ? <Loader2 className="animate-spin" /> : <Plus />}</span>
      <input
        autoFocus
        value={url}
        disabled={busy}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            setOpen(false)
          }
          if (e.key === "Enter" && url.trim()) attach({ title: "", repo: url.trim() })
        }}
        placeholder="GitHub URL"
        aria-label="GitHub repository URL"
        className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
      />
      <button type="button" className={chip} disabled={busy} onClick={() => folderRef.current?.click()}>
        Folder
      </button>
      <button type="button" className={chip} disabled={busy} onClick={() => filesRef.current?.click()}>
        Files
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => setOpen(false)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
      >
        <X />
      </button>
      <input
        ref={folderRef}
        type="file"
        hidden
        onChange={onPicked}
        {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      <input ref={filesRef} type="file" hidden multiple accept=".sol" onChange={onPicked} />
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
