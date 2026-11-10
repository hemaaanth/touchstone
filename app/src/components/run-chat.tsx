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
  ArrowUp,
  ArrowDown,
  Brain,
  ChevronRight,
  FileCode2,
  GitBranch,
  PenLine,
  ShieldCheck,
  TerminalSquare,
  Loader2,
  Clock,
  CircleSlash,
} from "lucide-react"
import type { Activity, ArtifactDoc, ArtifactVersion, Finding, PendingApproval, RunStatus, RunSummary } from "@/lib/types"
import { useRun, type RunState, type Step } from "@/lib/runModel"
import { steerRun, fetchFinding } from "@/lib/api"
import { getFixtureFinding } from "@/lib/fixtures"
import { elapsed, isTerminal } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AgentStatus, type AgentState } from "@/components/assistant-ui/elements/agent-status"
import { ShimmerLabel } from "@/components/assistant-ui/elements/surfaces"
import { ToolGroup, type GroupedTool } from "@/components/assistant-ui/elements/tool-group"
import { StreamingText } from "@/components/assistant-ui/elements/streaming-text"
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card"
import { ArtifactPane } from "@/components/assistant-ui/elements/artifact-pane"

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
// it arrives, and a subagent handoff reads as its own row. A live AgentStatus
// pill above the composer names what the agent is doing right now.

export function RunChat({
  run,
  onStatus,
}: {
  run: RunSummary
  onStatus: (status: RunStatus, pending: PendingApproval | null) => void
}) {
  const state = useRun(run.id)
  // The workspace documents the agent wrote, and which one the pane shows. On
  // desktop a new artifact auto-opens the pane and the pane follows to it;
  // closing it sticks until a newer document arrives (or the header chip reopens
  // the last one). On a phone the pane is a full-screen overlay, so it never
  // opens by itself: the document drafts in its chat card and opens on a tap.
  const artifacts = state?.artifacts ?? []
  // The pane opens a file at one version. `latestArtifact` names the most recent
  // write (file + version); a new version of an older file still counts as the
  // latest even though it does not move that file to the end of `artifacts`.
  const latest = state?.latestArtifact ?? null
  const latestFile = latest ? artifacts.find((a) => a.id === latest.fileId) ?? null : null
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const [openVersionId, setOpenVersionId] = useState<string | null>(null)
  // Open a file at a version. Omit the version to land on the file's latest.
  const openArtifact = (fileId: string, versionId?: string) => {
    setOpenArtifactId(fileId)
    const file = artifacts.find((a) => a.id === fileId) ?? null
    setOpenVersionId(versionId ?? file?.versions[file.versions.length - 1]?.id ?? null)
  }
  const seenArtifact = useRef<string | null>(null)
  useEffect(() => {
    const key = latest ? `${latest.fileId}:${latest.versionId}` : null
    if (key && key !== seenArtifact.current) {
      seenArtifact.current = key
      // Desktop follows every fresh write — including a new version of a file
      // already open, so the pane steps from v1 to v2 as the agent rewrites.
      if (!isNarrow() && latest) {
        setOpenArtifactId(latest.fileId)
        setOpenVersionId(latest.versionId)
      }
    }
  }, [latest])
  const openDoc = openArtifactId ? artifacts.find((a) => a.id === openArtifactId) ?? null : null
  // When the open document is the replay proof, it renders the recorded finding's
  // structured report in the pane. Resolve that finding only while the proof is
  // actually on screen; the id comes from the run-complete stamp, or the finding
  // event that lands a little earlier.
  // A run can record several findings; each proof document names its own.
  const proofFindingId = openDoc?.findingId ?? state?.findingId ?? state?.findings[0]?.id ?? null
  const finding = useFinding(openDoc?.kind === "proof" ? proofFindingId : null)
  // Flash fix: keep the sidebar's known status until this run's own stream has
  // actually produced events. reduceEvents defaults to "starting", so reading
  // state.status before any event would flash "Starting" on a settled run.
  const status = state && state.events.length > 0 ? state.status : run.status
  const scope = state?.scope ?? null
  // Lock fix: steer only a connected, still-open run. Before the stream connects
  // state is null; once its terminal `closed` lands the composer settles.
  const live = !!state && !state.closed

  // Report status + pending up so the sidebar row and spend meter follow live.
  useEffect(() => {
    if (state) onStatus(state.status, state.pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status, state?.pending])

  const messages = useMemo(() => buildMessages(state, status, live), [state, status, live])

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: live,
    isDisabled: !live,
    convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim()
      if (!text || !live) return
      await steerRun(run.id, text)
    },
  })

  return (
    <OpenArtifact.Provider value={openArtifact}>
      {/* The run splits into the chat and, when the agent writes one, the
          document pane. The chat flexes; the pane is a fixed-width column on
          desktop and a full-width overlay on mobile (so `relative` anchors it). */}
      <div className="relative flex h-full min-w-0">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {/* T3-style top bar: the sidebar toggle (mobile only — the sidebar is
              a Sheet there and unreachable otherwise), the target, then one
              trailing chip to reopen the document pane once it has been closed. */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1 md:hidden" />
            <h1 className="min-w-0 truncate text-sm font-medium">
              {scope?.title ?? run.title ?? run.alias}
            </h1>
            {latest && latestFile && !openDoc ? (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7 shrink-0 gap-1.5"
                onClick={() => openArtifact(latest.fileId, latest.versionId)}
              >
                <FileCode2 className="size-3.5" />
                <span className="max-w-[7rem] truncate md:max-w-[12rem]">
                  {latestFile.title}
                </span>
              </Button>
            ) : null}
          </header>

          <AssistantRuntimeProvider runtime={runtime}>
            <Thread
              live={live}
              empty={messages.length === 0}
              error={status === "error" ? state?.error ?? null : null}
              activity={state?.activity ?? "working"}
              startedAt={run.startedAt}
            />
          </AssistantRuntimeProvider>
        </div>

        {openDoc ? (
          <ArtifactPane
            docs={artifacts}
            activeId={openDoc.id}
            versionId={openVersionId}
            finding={finding}
            onSelect={(id) => openArtifact(id)}
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

// Read at call time, not from state: the first artifact can land before a
// hook-based mobile flag has settled. Matches Tailwind's `md` breakpoint.
function isNarrow(): boolean {
  return window.matchMedia("(max-width: 767px)").matches
}

// A touch device raises its on-screen keyboard whenever an input takes focus,
// so the composer only grabs focus on its own where there is a real pointer.
const FINE_POINTER = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches

// Resolve the finding a proof document renders. In DEV the fixtures carry the
// finding synchronously so the proof pane fills in the same tick it opens; a
// real run fetches it from the API once. Returns null until one resolves, and
// resets whenever the id changes so a stale proof never shows under a new one.
function useFinding(findingId: string | null): Finding | null {
  const fixture = useMemo(
    () => (findingId && import.meta.env.DEV ? getFixtureFinding(findingId) : null),
    [findingId],
  )
  const [remote, setRemote] = useState<Finding | null>(null)
  useEffect(() => {
    setRemote(null)
    if (!findingId || fixture) return
    let live = true
    fetchFinding(findingId)
      .then((f) => live && setRemote(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [findingId, fixture])
  return fixture ?? remote
}

// A clock that ticks once a second while the run is live, so the AgentStatus
// elapsed reads up in real time. Stops dead once the run settles.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  thinking: "Thinking",
  working: "Working",
  typing: "Writing",
  idle: "Idle",
}

function ActivityIcon({ activity }: { activity: Activity }) {
  if (activity === "thinking") return <Brain className="size-3" />
  if (activity === "typing") return <PenLine className="size-3" />
  return <Loader2 className="size-3 animate-spin" />
}

// The thread body + composer, styled in base-nova. Headless assistant-ui
// primitives do the scroll-stickiness, message iteration and compose state.
function Thread({
  live,
  empty,
  error,
  activity,
  startedAt,
}: {
  live: boolean
  empty: boolean
  error: string | null
  activity: Activity
  startedAt: number
}) {
  const now = useNow(live)
  const agentState: AgentState = "working"
  return (
    <ThreadPrimitive.Root
      className="flex min-h-0 flex-1 flex-col bg-background"
      style={{ ["--thread-max-width" as string]: "48rem" }}
    >
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth">
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col gap-3 px-5 py-6">
          {empty ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Starting the agent session…
            </div>
          ) : null}

          <ThreadPrimitive.Messages components={{ Message }} />

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
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

      {/* The live cognition pill: what the agent is doing right now, with a
          real-time elapsed clock. Gone the moment the run settles. */}
      {live ? (
        <div className="flex justify-center px-5 pb-1 pt-1">
          <AgentStatus
            state={agentState}
            label={ACTIVITY_LABEL[activity]}
            elapsed={elapsed(startedAt, now)}
            trailing={<ActivityIcon activity={activity} />}
          />
        </div>
      ) : null}

      <Composer live={live} />
    </ThreadPrimitive.Root>
  )
}

// The composer floats under the thread — no divider, no helper line. A single
// rounded pill with the send button tucked inside; disabled (not bordered-off)
// once the run settles, so a closed run reads as quiet rather than broken.
function Composer({ live }: { live: boolean }) {
  return (
    <div className="px-5 pb-4 pt-1">
      <div className="mx-auto max-w-(--thread-max-width)">
        <ComposerPrimitive.Root
          className={cn(
            "flex items-end gap-2 rounded-2xl border border-border/60 bg-card/70 px-2.5 py-1.5 shadow-sm backdrop-blur",
            "transition-colors focus-within:border-border focus-within:ring-2 focus-within:ring-ring/25",
            !live && "opacity-70",
          )}
        >
          <ComposerPrimitive.Input
            autoFocus={FINE_POINTER}
            disabled={!live}
            rows={1}
            submitOnEnter
            placeholder={live ? "Steer the agent…" : "This run has settled."}
            className="min-h-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <ComposerPrimitive.Send asChild>
            <Button size="icon" className="size-7 shrink-0 rounded-full" disabled={!live}>
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

const Text: TextMessagePartComponent = ({ text }) => (
  <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
)

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
    proofArtifactId?: string | null
    artifact?: ArtifactDoc | null
    version?: ArtifactVersion | null
    vIndex?: number
    vCount?: number
    tail?: boolean
  }
  if (a.pending)
    return <ProofCard pending={a.pending} state={a.card ?? "waiting"} proofArtifactId={a.proofArtifactId ?? null} />
  if (a.group) return <ToolGroupPart group={a.group} />
  if (a.artifact && a.version)
    return (
      <ArtifactChip doc={a.artifact} version={a.version} vIndex={a.vIndex ?? 1} vCount={a.vCount ?? 1} />
    )
  const step = a.step
  if (!step) return null

  if (step.kind === "reasoning") return <ReasoningPart step={step} tail={!!a.tail} />
  if (step.kind === "say") return <SayPart step={step} tail={!!a.tail} />
  if (step.kind === "subagent") return <HandoffRow step={step} />
  if (step.kind === "poc") return <PocRow step={step} />
  if (step.kind === "decided")
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
          step.state === "pass"
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-destructive/40 bg-destructive/10 text-destructive",
        )}
      >
        <ShieldCheck className="size-4" />
        {step.label}
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

// Streamed reasoning. While it is the live tail it stays open with a shimmering
// "Thinking" header and its fresh text fading in; once the agent moves on it
// folds into a quiet "Thought it through" the operator can reopen.
function ReasoningPart({ step, tail }: { step: Step; tail: boolean }) {
  if (tail) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Brain className="size-3.5" />
          <ShimmerLabel active>Thinking</ShimmerLabel>
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
          <StreamingText text={step.label} streaming />
        </p>
      </div>
    )
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Brain className="size-3.5" />
        Thought it through
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground">
          {step.label}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Streamed assistant prose. While it is the live tail each incoming chunk fades
// in; once settled it is plain prose.
function SayPart({ step, tail }: { step: Step; tail: boolean }) {
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed">
      <StreamingText text={step.label} streaming={tail} />
    </div>
  )
}

// A subagent handoff: the lead delegated an angle to a child conversation. Reads
// as a distinct dashed row with the child's area and live state.
function HandoffRow({ step }: { step: Step }) {
  const failed = step.subState === "failed"
  const done = step.subState === "done" || failed
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-sm">
      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{step.label}</span>
      {step.detail ? (
        <Badge variant="secondary" className="shrink-0 text-[11px]">
          {step.detail}
        </Badge>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {done ? (
          failed ? (
            <span className="text-destructive">failed</span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">done</span>
          )
        ) : (
          <>
            <Loader2 className="size-3.5 animate-spin" /> working
          </>
        )}
      </span>
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

function PocRow({ step }: { step: Step }) {
  const tone =
    step.state === "pass"
      ? "border-emerald-500/40 bg-emerald-500/10"
      : step.state === "fail"
        ? "border-destructive/40 bg-destructive/10"
        : "border-amber-500/40 bg-amber-500/10"
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", tone)}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <TerminalSquare className="size-4 shrink-0" />
        <span className="shrink-0 whitespace-nowrap">{step.label}</span>
        {step.contract ? (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{step.contract}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          {step.state === "running" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> running
            </>
          ) : step.state === "pass" ? (
            <span className="text-emerald-600 dark:text-emerald-400">passed</span>
          ) : (
            <span className="text-destructive">failed</span>
          )}
        </span>
      </div>
      {step.detail ? <p className="mt-1 pl-6 text-xs text-muted-foreground">{step.detail}</p> : null}
    </div>
  )
}

// The inline finding card. Amber while the replay runs; green once recorded.
// A recorded finding opens its replay proof as a document in the pane beside the
// chat — the same place the PoC opened, so the proof reads as another artifact.
// The whole card becomes a button so it is keyboard reachable, with a hover ring
// and an "Open replay proof" affordance so the click target reads as one. An
// unproven card stays a plain, non-interactive div.
// waiting: the test passed; the audit goes on and the final replay comes at the
// end. replaying: the run is recording now. proven: the final replay held.
// unproven / dropped: the run settled without proving this one.
type CardState = "waiting" | "replaying" | "proven" | "unproven" | "dropped"

const CARD_NOTE: Record<CardState, string> = {
  waiting: "Test passed. The final replay runs when the audit ends.",
  replaying: "Replaying to prove the exploit…",
  proven: "Proven by replay — recorded as a finding.",
  unproven: "Recorded, but the final replay did not reproduce it.",
  dropped: "Not recorded: the run ended before the final replay.",
}

function ProofCard({
  pending,
  state,
  proofArtifactId,
}: {
  pending: PendingApproval
  state: CardState
  proofArtifactId: string | null
}) {
  const openArtifact = useContext(OpenArtifact)
  const proven = state === "proven"
  const amber = state === "waiting" || state === "replaying"
  const clickable = proven && !!proofArtifactId
  const body = (
    <>
      <div className="flex items-center gap-2">
        {proven ? (
          <ShieldCheck className="size-4 shrink-0 text-emerald-500" />
        ) : state === "replaying" ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-amber-500" />
        ) : state === "waiting" ? (
          <Clock className="size-4 shrink-0 text-amber-500" />
        ) : (
          <CircleSlash className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-semibold">{pending.title}</span>
        <Badge variant="outline" className="ml-auto capitalize">
          {pending.severity}
        </Badge>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {CARD_NOTE[state]}
      </p>
      {pending.poc ? <p className="mt-2 font-mono text-[11px] text-muted-foreground">{pending.poc}</p> : null}
      {clickable ? (
        <p className="mt-2.5 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          Open replay proof
          <ChevronRight className="size-3.5" />
        </p>
      ) : null}
    </>
  )

  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => openArtifact(proofArtifactId)}
        className="block w-full rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-4 text-left transition-colors hover:bg-emerald-500/10 focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:outline-none"
      >
        {body}
      </button>
    )
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        proven
          ? "border-emerald-500/50 bg-emerald-500/5"
          : amber
            ? "border-amber-500/50 bg-amber-500/5"
            : "bg-muted/30",
      )}
    >
      {body}
    </div>
  )
}

// Fold the reduced step stream into assistant-ui messages. Operator steps are
// the user's bubbles; each contiguous run of agent steps is one assistant
// message whose parts carry the Step for our renderers — reasoning/prose/subagent
// handoffs and tool cards alike. The agent's closing prose and the live proof
// card trail the final assistant message. Keying each message by its first step
// id keeps rows and scroll stable as the stream grows. `tail` marks the single
// cognition block being written right now so only it fades its fresh text in.
function buildMessages(state: RunState | null, status: RunStatus, live: boolean): ThreadMessageLike[] {
  if (!state) return []
  const msgs: ThreadMessageLike[] = []
  let buf: { id: string; parts: ThreadMessageLike["content"] } | null = null

  // The last reasoning/prose block is the live tail — the one still streaming.
  let tailIndex = -1
  if (live) {
    for (let i = state.steps.length - 1; i >= 0; i--) {
      const k = state.steps[i].kind
      if (k === "say" || k === "reasoning") {
        tailIndex = i
        break
      }
    }
  }

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
      const { card, proofArtifactId } = cardFor(state, step.finding, status)
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "proof",
        args: { pending: step.finding, card, proofArtifactId },
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
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "artifact",
        args: { artifact: file, version, vIndex: vIndex + 1, vCount: file.versions.length },
        result: "done",
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
): { card: CardState; proofArtifactId: string | null } {
  const legacy = state.findings.length > 0 && state.findings.every((f) => !f.poc)
  const rec = legacy
    ? state.submitted.length === 1 && status === "recorded"
      ? state.findings[0]
      : undefined
    : state.findings.find((f) => f.poc === sub.poc)
  if (rec) {
    if (!rec.proven) return { card: "unproven", proofArtifactId: null }
    const proofs = state.artifacts.filter((a) => a.kind === "proof")
    const doc = proofs.find((a) => a.findingId === rec.id) ?? (legacy ? proofs[0] : undefined)
    return { card: "proven", proofArtifactId: doc?.id ?? null }
  }
  if (status === "deciding") return { card: "replaying", proofArtifactId: null }
  if (status === "recorded" || isTerminal(status)) return { card: "dropped", proofArtifactId: null }
  return { card: "waiting", proofArtifactId: null }
}
