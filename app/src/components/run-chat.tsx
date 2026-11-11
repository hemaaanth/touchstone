import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
  type TextMessagePartComponent,
} from "@assistant-ui/react"
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  ArrowDown,
  Brain,
  ChevronRight,
  FileCode2,
  GitBranch,
  MoreHorizontal,
  Play,
  ShieldX,
  TerminalSquare,
  Trash2,
  Loader2,
} from "lucide-react"
import type { ArtifactDoc, ArtifactVersion, Finding, PendingApproval, PrepassView, ProofKind, RunStatus, RunSummary } from "@/lib/types"
import { PrepassFold } from "@/components/prepass"
import { reloadRun, useRun, type RunState, type Step } from "@/lib/runModel"
import { steerRun, fetchFinding } from "@/lib/api"
import { INK, isTerminal, runTitle, severityTone } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { TitleInput } from "@/components/title-input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { card, cardInteractive, ShimmerLabel, StatusMark, type Mark } from "@/components/assistant-ui/elements/surfaces"
import { ToolGroup, type GroupedTool } from "@/components/assistant-ui/elements/tool-group"
import { Markdown } from "@/components/markdown"
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card"
import { ArtifactPane } from "@/components/assistant-ui/elements/artifact-pane"
import { FilesPanel } from "@/components/assistant-ui/elements/files-panel"
import { useSmoothText } from "@/components/assistant-ui/elements/streaming-text"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// How a transcript chip — or the proof card — opens its document in the pane
// beside the chat. A file can have several versions, so the callback takes the
// file id plus an optional version to land on (a chip opens its own version; the
// proof card just opens the file). buildMessages packs the ids into the part's
// args, but the setter lives in RunChat and a tool-call part's args must stay
// serialisable, so the callback flows down as context instead. Default is a
// no-op (nothing to open).
const OpenArtifact = createContext<(fileId: string, versionId?: string) => void>(() => {})

// The center column. The run is a pi-durable agent session; its live SSE step
// log is reduced into RunState, then mapped onto assistant-ui's message model
// so the Thread, tool-call cards and composer come from one maintained library
// instead of hand-rolled scroll/compose code. We own the state (ExternalStore)
// and the look (base-nova classes + our own part renderers), so adopting the
// library costs no backend protocol change and keeps the restraint rules: our
// renderer reads `step.state`, so green only ever shows for a proven PoC.
//
// Beyond tool steps the thread now surfaces the agent's own cognition — streamed
// reasoning folds into a collapsible "thinking" block, streamed prose fades in as
// it arrives, and a subagent handoff reads as its own row.

export function RunChat({
  run,
  onArchive,
  onRename,
  onDelete,
}: {
  run: RunSummary
  onArchive: (id: string, archived: boolean) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => Promise<void>
}) {
  const state = useRun(run.id)
  const [renaming, setRenaming] = useState(false)
  // The workspace documents the agent wrote, and which one the pane shows. The
  // pane is closed until the operator opens a document (a chat card or the
  // Files panel). Each chat keeps its own pane: the open file is saved per run,
  // so a chat comes back as it was left. A chat with nothing saved opens
  // closed. On desktop an open pane follows new writes. On a phone the pane is
  // a full-screen overlay, so it never opens by itself.
  const artifacts = state?.artifacts ?? []
  // The pane opens a file at one version. `latestArtifact` names the most recent
  // write (file + version); a new version of an older file still counts as the
  // latest even though it does not move that file to the end of `artifacts`.
  const latest = state?.latestArtifact ?? null
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(() => (isNarrow() ? null : storedPane(run.id)))
  const [openVersionId, setOpenVersionId] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useStoredFlag("ts.filesOpen", false)
  // Open a file at a version. Omit the version to land on the file's latest.
  const openArtifact = (fileId: string, versionId?: string) => {
    setOpenArtifactId(fileId)
    const file = artifacts.find((a) => a.id === fileId) ?? null
    setOpenVersionId(versionId ?? file?.versions[file.versions.length - 1]?.id ?? null)
  }
  useEffect(() => storePane(run.id, openArtifactId), [run.id, openArtifactId])
  // The first write we see is history, not news, so it only sets the mark.
  const seenArtifact = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const key = latest ? `${latest.fileId}:${latest.versionId}` : null
    if (!key || key === seenArtifact.current) return
    const fresh = seenArtifact.current !== undefined
    seenArtifact.current = key
    // An open pane on desktop follows each fresh write, including a new version
    // of the open file, so it steps from v1 to v2 as the agent rewrites.
    if (fresh && openArtifactId && !isNarrow() && latest) {
      setOpenArtifactId(latest.fileId)
      setOpenVersionId(latest.versionId)
    }
  }, [latest, openArtifactId])
  const openDoc = openArtifactId ? artifacts.find((a) => a.id === openArtifactId) ?? null : null
  // When the open document is the replay proof, it renders the recorded finding's
  // structured report in the pane. Resolve that finding only while the proof is
  // actually on screen; the id comes from the run-complete stamp, or the finding
  // event that lands a little earlier.
  // A run can record several findings; each proof document names its own.
  const proofFindingId = openDoc?.findingId ?? state?.findingId ?? state?.findings[0]?.id ?? null
  const finding = useFinding(openDoc?.kind === "proof" ? proofFindingId : null)
  // Until the run store has loaded this run, trust the sidebar's status.
  const status = state ? state.status : run.status
  const scope = state?.scope ?? null
  const title = runTitle({ ...run, scopeTitle: run.scopeTitle ?? scope?.title })
  // Live: a worker is running, so a message steers it. Idle: a message starts a
  // follow-up on the saved session. Only an archived run takes no messages.
  const live = !!state && !state.closed
  const archived = !!state?.archived
  const [sendError, setSendError] = useState<string | null>(null)

  const messages = useMemo(() => buildMessages(state, status, live), [state, status, live])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: live,
    isDisabled: !state || archived,
    convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim()
      if (!text || !state || archived) return
      setSendError(null)
      try {
        const res = await steerRun(run.id, text)
        // An idle run keeps no stream. Fetch it again to follow the reply.
        if (res.followUp) reloadRun(run.id)
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  return (
    <OpenArtifact.Provider value={openArtifact}>
      {/* The run splits into the chat and, when the agent writes one, the
          document pane. The chat flexes; the pane is a fixed-width column on
          desktop and a full-width overlay on mobile (so `relative` anchors it). */}
      <div className="relative flex h-full min-w-0">
        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          {/* The run's files float in the chat's top-right corner, under the top
              bar. Folded, the panel is one line; open, it lists every file. */}
          {artifacts.length ? (
            <div className="pointer-events-none absolute top-14 right-3 z-10 flex max-h-[calc(100%-4rem)] justify-end">
              <FilesPanel
                docs={artifacts}
                activeId={openDoc?.id ?? null}
                activeVersionId={openVersionId}
                open={filesOpen}
                onOpenChange={setFilesOpen}
                onOpen={(fileId, versionId) => {
                  openArtifact(fileId, versionId)
                  // On a phone the document covers the chat, so fold the list.
                  if (isNarrow()) setFilesOpen(false)
                }}
              />
            </div>
          ) : null}
          {/* The top bar holds the run's title and the actions on the run as a
              whole: archive, and delete behind a menu. Both wait while the agent
              works, because the server refuses to change a busy run. The sidebar
              toggle shows on mobile only, where the sidebar is a Sheet. */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 pe-2">
            <SidebarTrigger className="-ml-1 md:hidden" />
            {/* The run's own name, the same one the rail shows. Click to rename. */}
            {renaming ? (
              <TitleInput
                value={title}
                onSave={(name) => {
                  onRename(run.id, name)
                  setRenaming(false)
                }}
                onCancel={() => setRenaming(false)}
                className="h-7 w-full max-w-md text-sm font-medium"
              />
            ) : (
              <h1 className="min-w-0 truncate text-sm font-medium">
                <button
                  type="button"
                  title="Rename run"
                  onClick={() => setRenaming(true)}
                  className="max-w-full cursor-text truncate rounded-sm text-left outline-none hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {title}
                </button>
              </h1>
            )}
            <RunActions
              archived={archived}
              busy={live || !state}
              findings={state?.findings.length ?? 0}
              onArchive={() => onArchive(run.id, !archived)}
              onDelete={() => onDelete(run.id)}
            />
          </header>

          <AssistantRuntimeProvider runtime={runtime}>
            <Thread
              live={live}
              empty={messages.length === 0}
              prepass={state?.prepass ?? null}
              error={status === "error" ? state?.error ?? null : null}
              archived={archived}
              sendError={sendError}
            />
          </AssistantRuntimeProvider>
        </div>

        {openDoc ? (
          <ArtifactPane
            doc={openDoc}
            versionId={openVersionId}
            finding={finding}
            onSelectVersion={setOpenVersionId}
            onClose={() => {
              setOpenArtifactId(null)
              setOpenVersionId(null)
            }}
          />
        ) : null}
      </div>
    </OpenArtifact.Provider>
  )
}

// Which file each chat's pane shows, saved by run id. A run with no entry has
// its pane closed. Closing the pane removes the entry.
const PANE_KEY = "ts.artifactPane"

function readPanes(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}")
    return saved && typeof saved === "object" ? saved : {}
  } catch {
    return {}
  }
}

function storedPane(runId: string): string | null {
  const id = readPanes()[runId]
  return typeof id === "string" ? id : null
}

function storePane(runId: string, fileId: string | null) {
  const panes = readPanes()
  if ((panes[runId] ?? null) === fileId) return
  if (fileId) panes[runId] = fileId
  else delete panes[runId]
  localStorage.setItem(PANE_KEY, JSON.stringify(panes))
}

// Read at call time, not from state: the first artifact can land before a
// hook-based mobile flag has settled. Matches Tailwind's `md` breakpoint.
function isNarrow(): boolean {
  return window.matchMedia("(max-width: 767px)").matches
}

// A touch device raises its on-screen keyboard whenever an input takes focus,
// so the composer only grabs focus on its own where there is a real pointer.
const FINE_POINTER = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches

// Resolve the finding a proof document renders, fetched once from the API.
// Returns null until it loads, and resets whenever the id changes so a stale
// proof never shows under a new one.
function useFinding(findingId: string | null): Finding | null {
  const [remote, setRemote] = useState<Finding | null>(null)
  useEffect(() => {
    setRemote(null)
    if (!findingId) return
    let live = true
    fetchFinding(findingId)
      .then((f) => live && setRemote(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [findingId])
  return remote
}

// A yes/no setting kept in localStorage, so a panel stays as the operator left it.
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key)
    return saved == null ? initial : saved === "1"
  })
  const set = (v: boolean) => {
    setValue(v)
    localStorage.setItem(key, v ? "1" : "0")
  }
  return [value, set]
}

// The actions on the whole run, at the end of the top bar. Archive is one tap
// and undoes itself. Delete sits in a menu and asks first. The server moves a
// deleted run's files to a trash folder, so a mistake can still be recovered by
// hand. Both wait while the agent works.
function RunActions({
  archived,
  busy,
  findings,
  onArchive,
  onDelete,
}: {
  archived: boolean
  busy: boolean
  findings: number
  onArchive: () => void
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wait = busy ? "Wait for the agent to finish" : undefined
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={busy}
        title={wait}
        onClick={onArchive}
      >
        {archived ? <ArchiveRestore /> : <Archive />}
        <span className="hidden sm:inline">{archived ? "Unarchive" : "Archive"}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More actions" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setError(null)
              setConfirm(true)
            }}
          >
            <Trash2 />
            Delete run
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={(o) => !deleting && setConfirm(o)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this run?</DialogTitle>
            <DialogDescription>
              The run leaves the list with its transcript and files.
              {findings
                ? ` Its ${findings === 1 ? "finding leaves" : `${findings} findings leave`} the ledger too.`
                : ""}{" "}
              The files move to a trash folder, so they can be restored by hand.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-xs text-bad">{error}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleting} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                setDeleting(true)
                onDelete()
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : String(err))
                    setDeleting(false)
                  })
              }}
            >
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// The thread body + composer, styled in base-nova. Headless assistant-ui
// primitives do the scroll-stickiness, message iteration and compose state.
function Thread({
  live,
  empty,
  prepass,
  error,
  archived,
  sendError,
}: {
  live: boolean
  empty: boolean
  prepass: PrepassView | null
  error: string | null
  archived: boolean
  sendError: string | null
}) {
  return (
    <ThreadPrimitive.Root
      className="flex min-h-0 flex-1 flex-col bg-background"
      style={{ ["--thread-max-width" as string]: "48rem" }}
    >
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth">
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col gap-3 px-5 py-6">
          {prepass ? <PrepassFold prepass={prepass} /> : null}

          {empty ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Starting the agent session…
            </div>
          ) : null}

          <ThreadPrimitive.Messages components={{ Message }} />

          {error ? (
            <div className={cn(card, "px-4 py-3 text-sm text-bad")}>
              {error}
            </div>
          ) : null}
        </div>

        <ThreadPrimitive.ScrollToBottom asChild>
          <Button
            size="icon"
            variant="outline"
            className="absolute bottom-4 left-1/2 size-8 -translate-x-1/2 rounded-full disabled:invisible"
          >
            <ArrowDown className="size-4" />
          </Button>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>

      <Composer live={live} archived={archived} error={sendError} />
    </ThreadPrimitive.Root>
  )
}

// The composer floats under the thread — no divider, no helper line. A single
// rounded pill with the send button tucked inside. It is always open, except on
// an archived run, which reads as quiet rather than broken. A failed send (spend
// cap, no saved session) shows one line above it.
function Composer({ live, archived, error }: { live: boolean; archived: boolean; error: string | null }) {
  return (
    <div className="px-5 pb-4 pt-1">
      <div className="mx-auto max-w-(--thread-max-width)">
        {error ? <p className="mb-1.5 px-3 text-xs text-bad">{error}</p> : null}
        <ComposerPrimitive.Root
          className={cn(
            "flex items-end gap-2 rounded-2xl border border-border/60 bg-card/70 px-2.5 py-1.5 shadow-sm backdrop-blur",
            "transition-colors focus-within:border-border focus-within:ring-2 focus-within:ring-ring/25",
            archived && "opacity-70",
          )}
        >
          <ComposerPrimitive.Input
            autoFocus={FINE_POINTER}
            disabled={archived}
            rows={1}
            submitOnEnter
            placeholder={archived ? "This run is archived." : live ? "Steer the agent…" : "Message the agent…"}
            className="min-h-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <ComposerPrimitive.Send asChild>
            <Button size="icon" className="size-7 shrink-0 rounded-full" disabled={archived}>
              <ArrowUp className="size-4" />
            </Button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </div>
    </div>
  )
}

// One message. A user steer reads as the operator's own primary bubble, pinned
// right; the agent's message is a plain column of prose, reasoning and tool-call
// parts. MessageRoot emits no data-role, so we branch the layout with
// MessagePrimitive.If (exactly one arm renders per message).
function Message() {
  const parts = { Text, tools: { Fallback: StepPart } }
  return (
    <MessagePrimitive.Root className="flex flex-col">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If user={false}>
        <div className="flex flex-col gap-2.5">
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  )
}

const Text: TextMessagePartComponent = ({ text }) => <Markdown text={text} className="text-sm leading-relaxed" />

// Our own renderer for every part we pack as a tool-call. It reads the Step we
// packed into `args`, so the PoC pass/fail tone and the proof card come from
// `step.state` — never from assistant-ui's generic running/done status. `tail`
// is set only on the one cognition block currently being written on a live run.
const StepPart: ToolCallMessagePartComponent = ({ args }) => {
  const a = args as {
    step?: Step
    group?: Step[]
    pending?: PendingApproval
    card?: CardState
    proofKind?: ProofKind
    proofArtifactId?: string | null
    artifact?: ArtifactDoc | null
    version?: ArtifactVersion | null
    vIndex?: number
    vCount?: number
    tail?: boolean
  }
  if (a.pending)
    return <FindingCard
        pending={a.pending}
        state={a.card ?? "waiting"}
        proofKind={a.proofKind ?? "forge"}
        proofArtifactId={a.proofArtifactId ?? null}
      />
  if (a.group) return <ToolGroupPart group={a.group} />
  if (a.artifact && a.version && !a.step)
    return (
      <ArtifactChip doc={a.artifact} version={a.version} vIndex={a.vIndex ?? 1} vCount={a.vCount ?? 1} />
    )
  const step = a.step
  if (!step) return null

  if (step.kind === "reasoning") return <ReasoningPart step={step} tail={!!a.tail} />
  if (step.kind === "say") return <SayPart step={step} tail={!!a.tail} />
  if (step.kind === "subagent") return <HandoffRow step={step} />
  if (step.kind === "poc")
    return <AttemptCard step={step} file={a.artifact ?? null} version={a.version ?? null} vIndex={a.vIndex ?? 1} />
  if (step.kind === "decided")
    return (
      <div className={cn(card, "flex items-center gap-2.5 px-3.5 py-2.5 text-sm")}>
        <ShieldX className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{step.label}</span>
        <StatusMark className="ml-auto" mark="off" word="Denied" />
      </div>
    )

  // Every remaining kind (open/list/read/scan/note/cap) is grouped into a
  // ToolGroup by buildMessages, so nothing else should reach here.
  return null
}

// Short mono tool names for the grouped rows, so each reads as a tool call
// (`read src/Vault.sol`) rather than a sentence.
const TOOL_NAME: Partial<Record<Step["kind"], string>> = {
  open: "init",
  list: "ls",
  read: "read",
  scan: "scan",
  note: "read",
  cap: "cap",
}

// A contiguous run of the agent's non-cognition steps, folded into one card that
// is collapsed by default — so recon no longer pops in row by row and jitters
// the layout under the live stream. Expanding shows each call and its leads.
function ToolGroupPart({ group }: { group: Step[] }) {
  const [open, setOpen] = useState(false)
  const tools: GroupedTool[] = group.map((s) => ({
    id: s.key,
    name: TOOL_NAME[s.kind] ?? s.kind,
    target: s.detail ? `${s.label} — ${s.detail}` : s.label,
    state: s.state === "fail" ? "failed" : "done",
  }))
  const label = group.length === 1 ? group[0].label : "Recon & static analysis"
  return (
    <ToolGroup
      className="max-w-none"
      label={label}
      tools={tools}
      open={open}
      onOpenChange={setOpen}
    />
  )
}

// Streamed reasoning. This model thinks at length, so the block starts folded:
// one quiet line that shimmers "Thinking…" while the agent thinks, then reads
// "Thought it through". A click opens the side rail with the full text, live or
// done, and the block keeps that choice when the agent moves on.
function ReasoningPart({ step, tail }: { step: Step; tail: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Brain className="size-3.5" />
        {tail ? <ShimmerLabel active>Thinking…</ShimmerLabel> : "Thought it through"}
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>{open ? <ReasoningBody text={step.label} tail={tail} /> : null}</CollapsibleContent>
    </Collapsible>
  )
}

// The rail mounts only while open, so folded thinking costs no Markdown parse.
function ReasoningBody({ text, tail }: { text: string; tail: boolean }) {
  return <Markdown text={useSmoothText(text, tail)} className={RAIL} />
}

const RAIL = "mt-1.5 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground"

// Streamed assistant prose, rendered as Markdown. While it streams, it reveals
// word by word instead of in the uneven chunks the transport sends.
function SayPart({ step, tail }: { step: Step; tail: boolean }) {
  return <Markdown text={useSmoothText(step.label, tail)} className="text-sm leading-relaxed" />
}

// A subagent handoff: the lead delegated an angle to a child conversation. Reads
// as a distinct dashed row with the child's area and live state.
function HandoffRow({ step }: { step: Step }) {
  const mark: Mark = step.subState === "failed" ? "fail" : step.subState === "done" ? "done" : "running"
  return (
    <div className={cn(card, "flex items-center gap-2.5 px-3.5 py-2.5 text-sm")}>
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{step.label}</span>
      {step.detail ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{step.detail}</span> : null}
      <StatusMark className="ml-auto" mark={mark} />
    </div>
  )
}

// The agent opened a workspace document. It reads as a compact paper chip in the
// transcript — "Writing · N words" while it streams — that opens the full file in
// the pane when clicked. The live document (text, writing, word count) comes from
// RunState.artifacts, packed into this part by buildMessages, so the chip updates
// as the file is written.
const KIND_LABEL: Record<ArtifactDoc["kind"], string> = {
  poc: "Proof of concept",
  proof: "Replay proof",
  source: "Source",
  report: "Report",
}

function ArtifactChip({
  doc,
  version,
  vIndex,
  vCount,
}: {
  doc: ArtifactDoc
  version: ArtifactVersion
  vIndex: number
  vCount: number
}) {
  const open = useContext(OpenArtifact)
  const words = version.text.trim() ? version.text.trim().split(/\s+/).length : 0
  const base = doc.lang ? `${KIND_LABEL[doc.kind]} · ${doc.lang}` : KIND_LABEL[doc.kind]
  // When the file has more than one version this chip is one rewrite of it, so
  // it names its own version — v1/v2/v3 — up front, keeping each attempt a
  // distinct pill instead of one card changing under the operator.
  const meta = vCount > 1 ? `v${vIndex} · ${base}` : base
  const openThis = () => open(doc.id, version.id)
  return (
    <ArtifactCard
      role="button"
      tabIndex={0}
      onClick={openThis}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          openThis()
        }
      }}
      className="cursor-pointer"
      title={doc.title}
      meta={meta}
      generating={version.writing}
      words={words}
      preview={version.writing ? <DraftTail text={version.text} /> : null}
    />
  )
}

// Phone only: the last few lines of a file as it drafts, inside its chat card,
// so you watch it being written without the pane covering the chat. The top
// fades out, and long lines clip rather than wrap. Desktop has the live pane.
function DraftTail({ text }: { text: string }) {
  const tail = text.trimEnd().split("\n").slice(-5).join("\n")
  if (!tail) return null
  return (
    <pre
      aria-hidden
      className="overflow-hidden rounded-lg bg-foreground/[0.04] px-2.5 py-2 font-mono text-[10.5px] leading-[1.45] whitespace-pre text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,black_45%)] md:hidden"
    >
      {tail}
    </pre>
  )
}

// One exploit attempt as one card: the test file the agent wrote, then the
// Foundry run of that test. Every attempt has the same two rows, so attempt 2
// reads exactly like attempt 1. The file row opens that version in the pane.
function AttemptCard({
  step,
  file,
  version,
  vIndex,
}: {
  step: Step
  file: ArtifactDoc | null
  version: ArtifactVersion | null
  vIndex: number
}) {
  const open = useContext(OpenArtifact)
  const mark: Mark = step.state === "pass" ? "pass" : step.state === "fail" ? "fail" : "running"
  const text = version?.text ?? ""
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const lines = text ? text.trimEnd().split("\n").length : 0
  const openFile = file && version ? () => open(file.id, version.id) : null
  const row = "flex w-full items-center gap-2.5 border-t border-border/60 px-3.5 py-2 text-left text-[13px]"
  return (
    <div className={cn(card, "overflow-hidden")}>
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 whitespace-nowrap text-sm font-medium">{step.label}</span>
        {step.contract ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{step.contract}</span>
        ) : null}
        <StatusMark className="ml-auto" mark={mark} />
      </div>

      {file && version ? (
        <button
          type="button"
          onClick={openFile ?? undefined}
          className={cn(row, "group transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:outline-none")}
        >
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {version.writing ? "Writing " : "Wrote "}
            <span className="font-mono text-[12px]">{file.title}</span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
            {version.writing ? (
              <ShimmerLabel active>{words} words</ShimmerLabel>
            ) : (
              <>
                {file.versions.length > 1 ? `v${vIndex} · ` : ""}
                {lines} lines
              </>
            )}
            <ChevronRight className="size-3.5 transition-colors group-hover:text-foreground" />
          </span>
        </button>
      ) : null}
      {version?.writing ? (
        <div className="px-3.5 pb-2.5 md:hidden">
          <DraftTail text={text} />
        </div>
      ) : null}

      <div className={row}>
        <Play className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">Ran it in Foundry</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {step.state === "running" ? (version?.writing ? "Waiting for the file" : "Running…") : step.detail}
        </span>
      </div>
    </div>
  )
}

// The finding the agent submitted. It is the same plain card as every other
// one. Its state lives in the StatusMark; its severity is an overline word, red
// or amber only once a replay proved it. A proven card opens its replay proof
// in the pane, the same place the PoC opened.
// waiting: the test passed; the final replay comes when the audit ends.
// replaying: the run is recording now. proven: the final replay held.
// unproven / dropped: the run settled without proving this one.
type CardState = "waiting" | "replaying" | "proven" | "unproven" | "dropped"

// The note under a finding card says what the replay did, so it follows the
// proof kind: a Foundry test, a request, or pinned evidence.
const CARD_NOTE: Record<ProofKind, Record<CardState, string>> = {
  forge: {
    waiting: "The test passed. The final replay runs when the audit ends.",
    replaying: "Replaying the test from a clean state.",
    proven: "A clean Foundry replay reproduced the exploit.",
    unproven: "Recorded, but the final replay did not reproduce it.",
    dropped: "Not recorded. The run ended before the final replay.",
  },
  http: {
    waiting: "The request showed the harm. The final replay runs when the audit ends.",
    replaying: "Replaying the request on a private network.",
    proven: "A clean replay of the request showed the harm.",
    unproven: "Recorded, but the final replay did not show the harm.",
    dropped: "Not recorded. The run ended before the final replay.",
  },
  evidence: {
    waiting: "The evidence check passed. The final replay runs when the audit ends.",
    replaying: "Checking the pinned evidence again.",
    proven: "The pinned evidence replayed and the check still holds.",
    unproven: "Recorded, but the pinned evidence did not replay.",
    dropped: "Not recorded. The run ended before the final replay.",
  },
}

// The proof kind of a submitted finding: what the scope's proof surface says,
// else Foundry (older records have no surface).
function proofKindOf(state: RunState): ProofKind {
  const surface = state.scope?.proofSurface?.kind
  return surface === "http" || surface === "evidence" ? surface : "forge"
}

const CARD_MARK: Record<CardState, { mark: Mark; word?: string }> = {
  waiting: { mark: "waiting" },
  replaying: { mark: "running", word: "Replaying" },
  proven: { mark: "proven" },
  unproven: { mark: "off", word: "Not reproduced" },
  dropped: { mark: "off", word: "Not recorded" },
}

function FindingCard({
  pending,
  state,
  proofKind,
  proofArtifactId,
}: {
  pending: PendingApproval
  state: CardState
  proofKind: ProofKind
  proofArtifactId: string | null
}) {
  const openArtifact = useContext(OpenArtifact)
  const proven = state === "proven"
  const clickable = proven && !!proofArtifactId
  const sevInk = proven ? INK[severityTone(pending.severity)] : "text-muted-foreground"
  const m = CARD_MARK[state]
  const body = (
    <>
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide uppercase">
          <span className="text-muted-foreground">Finding</span>
          <span aria-hidden className="text-muted-foreground/50">·</span>
          <span className={sevInk}>{pending.severity}</span>
          <StatusMark className="ml-auto tracking-normal normal-case" mark={m.mark} word={m.word} />
        </div>
        <p className="mt-1.5 text-[15px] leading-snug font-semibold text-pretty">{pending.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{CARD_NOTE[proofKind][state]}</p>
      </div>
      {pending.poc || clickable ? (
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2">
          {pending.poc ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{pending.poc}</span>
          ) : null}
          {clickable ? (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
              Open replay proof
              <ChevronRight className="size-3.5" />
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )

  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => openArtifact(proofArtifactId)}
        className={cn(card, cardInteractive, "group block w-full overflow-hidden text-left")}
      >
        {body}
      </button>
    )
  }
  return <div className={cn(card, "overflow-hidden")}>{body}</div>
}

// Fold the reduced step stream into assistant-ui messages. Operator steps are
// the user's bubbles; each contiguous run of agent steps is one assistant
// message whose parts carry the Step for our renderers — reasoning/prose/subagent
// handoffs and tool cards alike. The agent's closing prose and the live proof
// card trail the final assistant message. Keying each message by its first step
// id keeps rows and scroll stable as the stream grows. `tail` marks the single
// cognition block being written right now so only it reveals word by word.
function buildMessages(state: RunState | null, status: RunStatus, live: boolean): ThreadMessageLike[] {
  if (!state) return []
  const msgs: ThreadMessageLike[] = []
  let buf: { id: string; parts: ThreadMessageLike["content"] } | null = null

  // The live tail is the block still streaming: the run's last step, when that
  // step is reasoning or prose. Once a tool step follows, the block is done, so
  // "Thinking…" never shimmers above a tool that is already running.
  const lastIndex = state.steps.length - 1
  const lastKind = state.steps[lastIndex]?.kind
  const tailIndex = live && (lastKind === "say" || lastKind === "reasoning") ? lastIndex : -1

  const flush = () => {
    if (buf && buf.parts.length) msgs.push({ role: "assistant", id: buf.id, content: buf.parts })
    buf = null
  }

  // A contiguous run of the agent's non-cognition steps collapses into one
  // ToolGroup card instead of a row each, so recon stops jittering the layout.
  let group: Step[] = []
  const flushGroup = () => {
    if (buf && group.length) {
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: `group:${group[0].key}`,
        toolName: "toolgroup",
        args: { group },
        result: "done",
      })
    }
    group = []
  }
  const GROUPED = new Set<Step["kind"]>(["open", "list", "read", "scan", "note", "cap"])

  state.steps.forEach((step, i) => {
    if (step.kind === "operator") {
      flushGroup()
      flush()
      msgs.push({ role: "user", id: step.key, content: [{ type: "text", text: step.label }] })
      return
    }
    // The decide pass already shows up as the single proof card below, which
    // carries its own replaying → proven state. Its bookkeeping rows ("Recording
    // the finding", the approved "Finding recorded") stacked above that card and
    // read as duplicates out of order — drop them. A denial has no green card to
    // carry it, so its one red "Finding denied" row stays.
    if (step.phase === "decide" && step.kind === "note") return
    if (step.kind === "decided" && step.state === "pass") return

    if (!buf) buf = { id: step.key, parts: [] }
    if (GROUPED.has(step.kind)) {
      group.push(step)
      return
    }
    // A cognition/outcome step ends the current group and renders on its own.
    flushGroup()
    // A submitted finding renders its card right where the agent submitted it,
    // so a run with several findings reads in the order they landed.
    if (step.kind === "submitted" && step.finding) {
      const { card, proofKind, proofArtifactId } = cardFor(state, step.finding, status)
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "proof",
        args: { pending: step.finding, card, proofKind, proofArtifactId },
        result: card,
      })
      return
    }
    // An artifact step carries only the document id; pack the live document so
    // its transcript chip shows the current writing state and word count. The
    // replay proof is the exception: the green finding card below is its
    // transcript entry point, so skip its plain chip and let that card (and the
    // pane tab) carry it — no redundant pointer stacked right above the card.
    if (step.kind === "artifact") {
      // step.subId is the VERSION id; find the file it belongs to and the index
      // of that version, so the chip can label itself v1/v2/v3 and open the file
      // at exactly its own version.
      let file: ArtifactDoc | null = null
      let version: ArtifactVersion | null = null
      let vIndex = 0
      for (const a of state.artifacts) {
        const idx = a.versions.findIndex((v) => v.id === step.subId)
        if (idx >= 0) {
          file = a
          version = a.versions[idx]
          vIndex = idx
          break
        }
      }
      if (!file || !version) return
      if (file.kind === "proof") return
      // A PoC version that belongs to an attempt shows inside that attempt's
      // card, not as its own chip.
      if (file.kind === "poc" && version.attempt != null) return
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "artifact",
        args: { artifact: file, version, vIndex: vIndex + 1, vCount: file.versions.length },
        result: "done",
      })
      return
    }
    // An attempt card carries the test file it ran: the PoC version written for
    // this attempt number and contract.
    if (step.kind === "poc") {
      let pocFile: ArtifactDoc | null = null
      let pocVersion: ArtifactVersion | null = null
      let vIndex = 0
      for (const a of state.artifacts) {
        if (a.kind !== "poc") continue
        const idx = a.versions.findIndex((v) => v.attempt === step.attempt && v.contract === step.contract)
        if (idx >= 0) {
          pocFile = a
          pocVersion = a.versions[idx]
          vIndex = idx + 1
          break
        }
      }
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "poc",
        args: { step, artifact: pocFile, version: pocVersion, vIndex },
        result: step.state ?? "done",
      })
      return
    }
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: step.key,
      toolName: step.kind,
      args: { step, tail: i === tailIndex },
      result: step.state ?? "done",
    })
  })
  flushGroup()

  // Closing prose (the agent's words when nothing could be proven).
  if (status === "no-finding" && state.finalText) {
    if (!buf) buf = { id: "final", parts: [] }
    ;(buf.parts as unknown[]).push({ type: "text", text: state.finalText })
  }

  flush()
  return msgs
}

// Match a submitted finding to its recorded one and its replay-proof document.
// New runs match by test contract name. An old run recorded one finding with no
// contract name, so its one submission maps to the run's one finding.
function cardFor(
  state: RunState,
  sub: PendingApproval,
  status: RunStatus,
): { card: CardState; proofKind: ProofKind; proofArtifactId: string | null } {
  const legacy = state.findings.length > 0 && state.findings.every((f) => !f.poc)
  const rec = legacy
    ? state.submitted.length === 1 && status === "recorded"
      ? state.findings[0]
      : undefined
    : state.findings.find((f) => f.poc === sub.poc)
  const proofKind = proofKindOf(state)
  if (rec) {
    if (!rec.proven) return { card: "unproven", proofKind, proofArtifactId: null }
    const proofs = state.artifacts.filter((a) => a.kind === "proof")
    const doc = proofs.find((a) => a.findingId === rec.id) ?? (legacy ? proofs[0] : undefined)
    return { card: "proven", proofKind, proofArtifactId: doc?.id ?? null }
  }
  if (status === "deciding") return { card: "replaying", proofKind, proofArtifactId: null }
  if (status === "recorded" || isTerminal(status)) return { card: "dropped", proofKind, proofArtifactId: null }
  return { card: "waiting", proofKind, proofArtifactId: null }
}
