import { useRef, useState } from "react"
import { ArrowUp, Check, ChevronDown, Cpu, FileCode2, Loader2, Shuffle } from "lucide-react"
import type { ModelChoice, SpendState, TargetChoice } from "@/lib/types"
import { formatUsd } from "@/lib/format"
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
// one real choice, shown in place instead of hidden in a dropdown. The toolbar
// holds the model, the spend left, and the send button. There is no free-text
// box: a run is autonomous, and the operator steers it once it is live.
// "Random" omits targetId, so the server picks and repeat runs do not
// re-break one bug.
export function NewRunDialog({
  open,
  onOpenChange,
  models,
  targets,
  spend,
  busy,
  error,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  models: ModelChoice[]
  targets: TargetChoice[]
  spend: SpendState | null
  busy: boolean
  error: string | null
  onStart: (alias: string, targetId?: string) => void
}) {
  const runnable = targets.filter((t) => t.runnable)
  // The operator's pick, else the first abliterated model.
  const [picked, setAlias] = useState("")
  const alias = picked || (models.find((m) => m.abliterated) ?? models[0])?.alias || ""
  const [scopeId, setScopeId] = useState(RANDOM)
  const listRef = useRef<HTMLDivElement>(null)

  const capped = spend ? spend.usd >= spend.cap : false
  const canStart = alias !== "" && runnable.length > 0 && !busy && !capped
  const ids = [RANDOM, ...runnable.map((t) => t.id)]

  const submit = () => {
    if (!canStart) return
    onStart(alias, scopeId === RANDOM ? undefined : scopeId)
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

  const notice = capped
    ? "Spend cap reached. Raise the cap to start a run."
    : runnable.length === 0
      ? "No runnable scopes are available right now."
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

        <div
          ref={listRef}
          role="radiogroup"
          aria-label="Scope"
          onKeyDown={onListKey}
          className="flex max-h-[min(24rem,60vh)] flex-col gap-0.5 overflow-y-auto px-2 pb-2"
        >
          <ScopeRow
            id={RANDOM}
            selected={scopeId === RANDOM}
            onSelect={setScopeId}
            icon={<Shuffle />}
            title="Random scope"
            blurb="The server picks one from the library."
          />
          {runnable.map((t) => (
            <ScopeRow
              key={t.id}
              id={t.id}
              selected={scopeId === t.id}
              onSelect={setScopeId}
              icon={<FileCode2 />}
              title={t.title}
              meta={t.entry}
              blurb={t.blurb}
            />
          ))}
        </div>

        {notice ? <p className="border-t border-border/60 px-4 py-2 text-xs text-bad">{notice}</p> : null}

        <div className="flex items-center gap-2 border-t border-border/60 px-2 py-2">
          <ModelPill models={models} alias={alias} onAlias={setAlias} />
          <span className="flex-1" />
          {spend ? (
            <span
              className={cn("text-xs tabular-nums", capped ? "text-bad" : "text-muted-foreground")}
              title="Spent so far against the spend cap"
            >
              {formatUsd(spend.usd)} of {formatUsd(spend.cap)}
            </span>
          ) : null}
          <Button
            size="icon"
            onClick={submit}
            disabled={!canStart}
            aria-label="Start run"
            title="Start run (Enter)"
            className="rounded-full"
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// One scope. The selected row shows its full blurb; the rest keep one line.
// The check column has a fixed width so rows do not shift on selection.
function ScopeRow({
  id,
  selected,
  onSelect,
  icon,
  title,
  meta,
  blurb,
}: {
  id: string
  selected: boolean
  onSelect: (id: string) => void
  icon: React.ReactNode
  title: string
  meta?: string
  blurb: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-id={id}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(id)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none",
        "focus-visible:ring-1 focus-visible:ring-foreground/15",
        selected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center [&_svg]:size-4",
          selected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13.5px] font-medium">{title}</span>
          {meta ? (
            <span className="ml-auto hidden shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
              {meta}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "text-xs leading-relaxed text-muted-foreground text-pretty",
            selected ? "" : "line-clamp-1",
          )}
        >
          {blurb}
        </span>
      </span>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
    </button>
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
    "flex h-8 items-center gap-1.5 rounded-full border border-border/60 px-3 font-mono text-xs text-muted-foreground [&_svg]:size-3.5"
  if (models.length <= 1) {
    return (
      <span className={pill} title={current?.id}>
        <Cpu />
        {alias || "No model"}
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(pill, "outline-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted")}
      >
        <Cpu />
        {alias}
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
