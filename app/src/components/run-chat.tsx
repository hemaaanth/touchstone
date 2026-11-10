import { useEffect, useMemo, useState } from "react"
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
  FileSearch,
  FileText,
  FlaskConical,
  GitBranch,
  ListTree,
  PenLine,
  Radar,
  ShieldCheck,
  TerminalSquare,
  Loader2,
} from "lucide-react"
import type { Activity, PendingApproval, RunStatus, RunSummary } from "@/lib/types"
import { useRun, type RunState, type Step } from "@/lib/runModel"
import { steerRun } from "@/lib/api"
import { elapsed } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AgentStatus, type AgentState } from "@/components/assistant-ui/elements/agent-status"
import { ShimmerLabel } from "@/components/assistant-ui/elements/surfaces"

// The center column. The run is a pi-durable agent session; its live SSE step
// log is reduced into RunState, then mapped onto assistant-ui's message model
// so the Thread, tool-call cards and composer come from one maintained library
// instead of hand-rolled scroll/compose code. We own the state (ExternalStore)
// and the look (base-nova classes + our own part renderers), so adopting the
// library costs no backend protocol change and keeps the restraint rules: our
// renderer reads `step.state`, so green only ever shows for a proven PoC.
//
// Beyond tool steps the thread now surfaces the agent's own cognition — streamed
// reasoning folds into a collapsible "thinking" block, streamed prose types
// itself with a live caret, and a subagent handoff reads as its own row. A live
// AgentStatus pill above the composer names what the agent is doing right now.

export function RunChat({
  run,
  onStatus,
}: {
  run: RunSummary
  onStatus: (status: RunStatus, pending: PendingApproval | null) => void
}) {
  const state = useRun(run.id)
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
    <div className="flex h-full min-w-0 flex-col">
      {/* T3-style top bar: the target, nothing else. Status lives in the live
          pill and the sidebar row, not here. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="truncate text-sm font-medium">{scope?.title ?? run.title ?? run.alias}</h1>
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
  )
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

function Composer({ live }: { live: boolean }) {
  return (
    <div className="border-t p-3">
      <div className="mx-auto max-w-(--thread-max-width)">
        <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:ring-2 focus-within:ring-ring/40">
          <ComposerPrimitive.Input
            autoFocus
            disabled={!live}
            rows={1}
            submitOnEnter
            placeholder={live ? "Steer the agent… (Enter to send)" : "This run has settled."}
            className="min-h-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <ComposerPrimitive.Send asChild>
            <Button size="icon" className="size-8 shrink-0" disabled={!live}>
              <ArrowUp className="size-4" />
            </Button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          Green only after a deterministic Foundry replay proves the finding.
        </p>
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

// A thin caret that blinks at the tail of a block still being written, so a
// live stream reads as the agent typing rather than text popping in.
function TypingCaret() {
  return (
    <span className="ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-foreground/70 align-baseline motion-reduce:animate-none" />
  )
}

// Our own renderer for every part we pack as a tool-call. It reads the Step we
// packed into `args`, so the PoC pass/fail tone and the proof card come from
// `step.state` — never from assistant-ui's generic running/done status. `tail`
// is set only on the one cognition block currently being written on a live run.
const StepPart: ToolCallMessagePartComponent = ({ args }) => {
  const a = args as { step?: Step; pending?: PendingApproval; proven?: boolean; tail?: boolean }
  if (a.pending) return <ProofCard pending={a.pending} proven={!!a.proven} />
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

  const Icon = ICONS[step.kind] ?? FileText
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-sm">{step.label}</p>
        {step.detail ? <p className="text-xs text-muted-foreground">{step.detail}</p> : null}
      </div>
    </div>
  )
}

// Streamed reasoning. While it is the live tail it stays open with a shimmering
// "Thinking" header and a caret; once the agent moves on it folds into a quiet
// "Thought it through" the operator can reopen.
function ReasoningPart({ step, tail }: { step: Step; tail: boolean }) {
  if (tail) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Brain className="size-3.5" />
          <ShimmerLabel active>Thinking</ShimmerLabel>
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
          {step.label}
          <TypingCaret />
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

// Streamed assistant prose. Types itself with a caret while it is the live tail.
function SayPart({ step, tail }: { step: Step; tail: boolean }) {
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed">
      {step.label}
      {tail ? <TypingCaret /> : null}
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
        <TerminalSquare className="size-4" />
        {step.label}
        {step.contract ? <span className="font-mono text-xs text-muted-foreground">{step.contract}</span> : null}
        <span className="ml-auto flex items-center gap-1.5 text-xs">
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

function ProofCard({ pending, proven }: { pending: PendingApproval; proven: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        proven ? "border-emerald-500/50 bg-emerald-500/5" : "border-amber-500/50 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-2">
        {proven ? (
          <ShieldCheck className="size-4 text-emerald-500" />
        ) : (
          <Loader2 className="size-4 animate-spin text-amber-500" />
        )}
        <span className="text-sm font-semibold">{pending.title}</span>
        <Badge variant="outline" className="ml-auto capitalize">
          {pending.severity}
        </Badge>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {proven ? "Proven by replay — recorded as a finding." : "Replaying to prove the exploit…"}
      </p>
      {pending.poc ? <p className="mt-2 font-mono text-[11px] text-muted-foreground">{pending.poc}</p> : null}
    </div>
  )
}

const ICONS: Partial<Record<Step["kind"], typeof FileText>> = {
  open: Radar,
  list: ListTree,
  read: FileSearch,
  scan: Radar,
  note: FileText,
  cap: FlaskConical,
}

// Fold the reduced step stream into assistant-ui messages. Operator steps are
// the user's bubbles; each contiguous run of agent steps is one assistant
// message whose parts carry the Step for our renderers — reasoning/prose/subagent
// handoffs and tool cards alike. The agent's closing prose and the live proof
// card trail the final assistant message. Keying each message by its first step
// id keeps rows and scroll stable as the stream grows. `tail` marks the single
// cognition block being written right now so only it shows a typing caret.
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

  state.steps.forEach((step, i) => {
    if (step.kind === "operator") {
      flush()
      msgs.push({ role: "user", id: step.key, content: [{ type: "text", text: step.label }] })
      return
    }
    if (!buf) buf = { id: step.key, parts: [] }
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: step.key,
      toolName: step.kind,
      args: { step, tail: i === tailIndex },
      result: step.state ?? "done",
    })
  })

  // Closing prose (the agent's words when nothing could be proven).
  if (status === "no-finding" && state.finalText) {
    if (!buf) buf = { id: "final", parts: [] }
    ;(buf.parts as unknown[]).push({ type: "text", text: state.finalText })
  }

  // The live proof card: pending approval, turning green only once recorded.
  if (state.pending) {
    if (!buf) buf = { id: "proof", parts: [] }
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: "proof",
      toolName: "proof",
      args: { pending: state.pending, proven: status === "recorded" },
      result: status === "recorded" ? "proven" : "pending",
    })
  }

  flush()
  return msgs
}
