import { useContext, useState } from "react"
import {
  AuiIf,
  useAuiState,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
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
  Network,
  Play,
  ShieldX,
  TerminalSquare,
  TriangleAlert,
  CreditCard,
  Gauge,
  CloudOff,
  Scissors,
  FolderX,
  Square,
  Info,
  Loader2,
  CirclePause,
} from "lucide-react"
import type { ArtifactDoc, ArtifactVersion, PendingApproval, PrepassView, ProofKind } from "@/lib/types"
import { COORDINATOR } from "@/lib/types"
import type { ContextUse } from "@/components/fleet-view"
import { PrepassDetail } from "@/components/prepass"
import { RunStart } from "@/components/assistant-ui/elements/start-progress"
import { ErrorState } from "@/components/assistant-ui/elements/error-state"
import { ToolError } from "@/components/assistant-ui/elements/tool-error"
import { ProofMark, SeverityMark } from "@/components/assistant-ui/elements/indicators"
import { splitRaw, type RunFailure, type Step } from "@/lib/runModel"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { card, cardInteractive, ShimmerLabel, StatusMark, type Mark } from "@/components/assistant-ui/elements/surfaces"
import { ToolGroup, type GroupedTool } from "@/components/assistant-ui/elements/tool-group"
import { AgentHandoff } from "@/components/assistant-ui/elements/agent-handoff"
import { Markdown } from "@/components/markdown"
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card"
import { useSmoothText } from "@/components/assistant-ui/elements/streaming-text"
import { agentName, FleetContext, fleetSpend, stepAge, ThreadOwner } from "@/components/fleet-view"
import { agentLook, MarkedStep, OpenArtifact, sentence, type CardState, type RunStartView } from "@/components/thread-model"

// The run's thread: the message list, its part renderers, and the composer.
// The main chat and a fleet peek both render through this one file, so a
// child's thread looks exactly like the coordinator's. RunChat owns the state.


// A touch device raises its on-screen keyboard whenever an input takes focus,
// so the composer only grabs focus on its own where there is a real pointer.
const FINE_POINTER = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches

// The thread body + composer, styled in base-nova. Headless assistant-ui
// primitives do the scroll-stickiness, message iteration and compose state.
// The icon per failure kind. Amber throughout — red stays reserved for a proven
// finding and destructive controls, so an error never reads as a finding.
const ERROR_ICON: Record<RunFailure["kind"], typeof TriangleAlert> = {
  transient: CloudOff,
  account: CreditCard,
  budget: Gauge,
  cutoff: Scissors,
  coverage: FolderX,
  model: TriangleAlert,
  crash: TriangleAlert,
  unknown: TriangleAlert,
}

// The server's plain reasons ("the server restarted during this run, so it
// stopped") are lower case with no period. `sentence` gives them a capital and
// an end mark.
const same = (a: string, b: string) => sentence(a).toLowerCase() === sentence(b).toLowerCase()

// The run failed before it proved anything. This is the one place the operator
// learns why: what went wrong, what it actually cost, and the single next step.
// Three levels only: the title, one muted line (the reason, then the spend), and
// the actions. "Technical details" holds only what the card does not already
// show (the raw engine error and the failure code), so nothing repeats. A
// transient fault offers "Run again"; a billing fault does not pretend retrying
// helps. No red: an error is not a finding.
function RunErrorCard({
  info,
  fallback,
  onRetry,
  retrying,
  archived,
  warning = false,
}: {
  info: RunFailure | null
  fallback: string | null
  onRetry: () => void
  retrying: boolean
  archived: boolean
  // A warning beside a recorded finding (the coverage note): no spend line and
  // no "Run again", because the run did not fail.
  warning?: boolean
}) {
  const kind = info?.kind ?? "unknown"
  const Icon = ERROR_ICON[kind] ?? TriangleAlert
  const title = info?.title ?? "The run did not complete"
  const hint = info?.hint ?? fallback ?? "Try starting the run again."
  // In a fleet run the agents report their own spend, so the card never says
  // less than the header does.
  const fleet = useContext(FleetContext)
  const spent = Math.max(info?.spentUsd ?? 0, fleet ? fleetSpend(fleet.state) : 0)
  const cost = spent > 0 ? `About $${spent.toFixed(4)} was spent on the work that did run.` : "Nothing was spent on this run."
  // The raw error, unless it is the line the card already shows.
  const detail = [info?.detail, info ? null : fallback]
    .map((t) => t?.trim())
    .find((t): t is string => !!t && !same(t, hint) && !same(t, title))
  // The detail can be a sentence, a blank line, then raw output. The sentence
  // reads as text; the raw output stays preformatted.
  // Without a blank line the detail stays preformatted, as it was.
  const parts = detail ? splitRaw(detail) : null
  const split = !!parts?.raw
  const said = split && parts.text && !same(parts.text, hint) && !same(parts.text, title) ? sentence(parts.text) : null
  const raw = split ? parts.raw : (detail ?? null)
  const code = info?.reason && info.reason !== "unknown" ? info.reason : null
  const technical = !!said || !!raw || !!code
  const retryable = (info?.retryable ?? true) && !archived && !warning

  return (
    <Collapsible>
      <ErrorState
        icon={Icon}
        title={sentence(title).replace(/\.$/, "")}
        detail={
          <>
            {sentence(hint)} {warning ? null : cost}
          </>
        }
        onRetry={retryable ? onRetry : undefined}
        retrying={retrying}
        retryLabel="Run again"
        actions={
          technical ? (
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
              Technical details
            </CollapsibleTrigger>
          ) : null
        }
      >
        {technical ? (
          <CollapsibleContent>
            <div className="mt-3 space-y-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {code ? (
                <p>
                  Code <span className="font-mono text-foreground/80">{code}</span>
                </p>
              ) : null}
              {said ? <p className="leading-relaxed">{said}</p> : null}
              {raw ? (
                <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                  {raw}
                </pre>
              ) : null}
            </div>
          </CollapsibleContent>
        ) : null}
      </ErrorState>
    </Collapsible>
  )
}

export function Thread({
  prepass,
  start = null,
  error,
  errorInfo,
  coverage = null,
  note = null,
  onRetry,
  retrying,
  archived,
  sendError,
  sending = false,
  context = null,
  to = "the agent",
  readOnly = false,
}: {
  prepass: PrepassView | null
  // The run's setup, from "starting" to the agent session. One card at the top
  // of the thread that stays in place once the agent works.
  start?: RunStartView | null
  error: string | null
  errorInfo: RunFailure | null
  // A recorded run that did not read its whole scope. Shown as a warning card.
  coverage?: RunFailure | null
  // A quiet line at the run's end, e.g. agents a restart cut off. Not an error.
  note?: string | null
  onRetry: () => void
  retrying: boolean
  archived: boolean
  sendError: string | null
  // A message is on its way to the server. It shows in the composer only.
  sending?: boolean
  // How full the main thread's context is, when the engine reported it.
  context?: ContextUse | null
  // Who a message goes to: "coordinator" in a fleet run, "the agent" in a solo run.
  to?: string
  // A peek: no composer, no prepass, no start line.
  readOnly?: boolean
}) {
  return (
    <ThreadPrimitive.Root
      className="flex min-h-0 flex-1 flex-col bg-background [--composer-bg:color-mix(in_oklab,var(--color-muted)_30%,transparent)] [--composer-padding:8px] [--composer-radius:1rem]"
      style={{ ["--thread-max-width" as string]: "48rem" }}
    >
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth">
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col gap-5 px-5 py-6",
          )}
        >
          {start && !readOnly ? (
            <RunStart {...start}>{prepass ? <PrepassDetail prepass={prepass} /> : null}</RunStart>
          ) : null}

          <ThreadPrimitive.Messages components={{ Message }} />

          {error || errorInfo ? (
            <RunErrorCard
              info={errorInfo}
              fallback={error}
              onRetry={onRetry}
              retrying={retrying}
              archived={archived}
            />
          ) : coverage ? (
            <RunErrorCard info={coverage} fallback={null} onRetry={onRetry} retrying={retrying} archived={archived} warning />
          ) : null}
          {note ? (
            <p data-slot="run-note" className="flex max-w-160 items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <CirclePause aria-hidden className="mt-[3px] size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{note}</span>
            </p>
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

      {readOnly ? null : <Composer to={to} archived={archived} error={sendError} sending={sending} context={context} />}
    </ThreadPrimitive.Root>
  )
}

// The composer, styled as assistant-ui's base-nova composer: the input on top,
// an action row under it. The operator talks to the coordinator, which passes
// work on to the agents, or to the one agent of a solo run. While the run works,
// Send steers it and Stop ends the work. A failed send (spend cap, no saved
// session) shows as one quiet line in the action row's free left side, a place
// that is always there, so the box never moves. The text stays in the input.
// While a send waits for the server, the text stays too, the input is read
// only and Send turns into a spinner. Nothing else moves.
// An archived run reads as quiet rather than broken.
function Composer({
  to,
  archived,
  error,
  sending,
  context,
}: {
  to: string
  archived: boolean
  error: string | null
  sending: boolean
  context: ContextUse | null
}) {
  return (
    <div className="px-5 pt-2 pb-5 max-md:px-3 max-md:pb-3">
      <div className="mx-auto max-w-(--thread-max-width)">
        <ComposerPrimitive.Root
          className={cn(
            "flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border border-foreground/10 bg-(--composer-bg) p-(--composer-padding)",
            "transition-[border-color] focus-within:border-foreground/25",
            archived && "opacity-70",
          )}
        >
          <ComposerPrimitive.Input
            autoFocus={FINE_POINTER}
            disabled={archived}
            readOnly={sending}
            rows={1}
            submitOnEnter
            enterKeyHint="send"
            placeholder={archived ? "This run is archived." : `Message ${to}…`}
            className="max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 caret-primary outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed md:text-sm"
          />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {context ? <ContextRing use={context} /> : null}
              {error ? <ErrorState compact title="Message not sent" detail={sentence(error)} /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerPrimitive.Cancel asChild>
                  <Button size="icon" variant="outline" className="size-7 rounded-full" aria-label="Stop">
                    <Square className="size-3 fill-current" />
                  </Button>
                </ComposerPrimitive.Cancel>
              </AuiIf>
              {sending ? (
                <Button size="icon" className="size-7 rounded-full" aria-label="Sending" aria-busy disabled>
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                </Button>
              ) : (
                <ComposerPrimitive.Send asChild>
                  <Button size="icon" className="size-7 rounded-full" aria-label="Send">
                    <ArrowUp className="size-4" />
                  </Button>
                </ComposerPrimitive.Send>
              )}
            </div>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </div>
  )
}

// How full the model's context is: a small ring and a percentage. The title
// gives the token counts.
function ContextRing({ use }: { use: ContextUse }) {
  const share = Math.min(1, use.used / use.window)
  const r = 6
  const c = 2 * Math.PI * r
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  return (
    <span
      className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground tabular-nums"
      title={`Context: ${k(use.used)} of ${k(use.window)} tokens`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-foreground/10" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${share * c} ${c}`}
          className={share > 0.85 ? "stroke-bad" : "stroke-muted-foreground"}
        />
      </svg>
      {Math.round(share * 100)}% context
    </span>
  )
}

// One message. A user steer reads as the operator's own primary bubble, pinned
// right; the agent's message is a plain column of prose, reasoning and tool-call
// parts. MessageRoot emits no data-role, so we branch the layout with
// MessagePrimitive.If (exactly one arm renders per message).
function Message() {
  const parts = { Text, tools: { Fallback: StepPart } }
  // The operator's bubble is quiet: muted fill, no accent.
  return (
    <MessagePrimitive.Root className="flex flex-col">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-[70%] rounded-[14px] bg-muted px-4 py-3 text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
          <MessagePrimitive.Parts components={parts} />
        </div>
        <Queued />
      </MessagePrimitive.If>
      <MessagePrimitive.If user={false}>
        <div className="flex flex-col gap-2.5">
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  )
}

// A steer the agent has not read yet. It reads it when its current step ends.
// The hint waits a second, so a steer that lands at once never flashes it.
function Queued() {
  const queued = useAuiState((s) => s.message.metadata.custom?.queued === true)
  if (!queued) return null
  return (
    <span className="ml-auto mt-1 pr-1 text-xs text-muted-foreground animate-in fade-in duration-300 [animation-delay:1s] [animation-fill-mode:backwards]">
      Queued until the agent's next step
    </span>
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
    eyebrow?: string
    spawn?: Step[]
    fleetFinding?: boolean
    stepKey?: string
    waiting?: boolean
  }
  if (a.eyebrow) return <Eyebrow text={a.eyebrow} />
  // The agent has the message and has not answered yet. This is the same
  // element as live reasoning below, so the row stays put when thinking starts.
  if (a.waiting) return <ReasoningPart step={null} tail />
  if (a.spawn) return <SpawnRow steps={a.spawn} />
  if (a.pending && a.fleetFinding)
    return (
      <FindingRow
        pending={a.pending}
        state={a.card ?? "waiting"}
        proofKind={a.proofKind ?? "forge"}
        proofArtifactId={a.proofArtifactId ?? null}
        stepKey={a.stepKey}
      />
    )
  if (a.pending)
    return <FindingCard
        pending={a.pending}
        state={a.card ?? "waiting"}
        proofKind={a.proofKind ?? "forge"}
        proofArtifactId={a.proofArtifactId ?? null}
        stepKey={a.stepKey}
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
  if (step.kind === "message") return <MessageCard step={step} />
  if (step.kind === "agent-error") return <AgentErrorRow step={step} />
  if (step.kind === "reply-error") return <ReplyErrorRow step={step} />
  if (step.kind === "system") return <SystemLine step={step} />
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

// Fleet: who wrote the block below. "COORDINATOR" in the main chat, the
// agent's name in a peek.
function Eyebrow({ text }: { text: string }) {
  return <p className="text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{text}</p>
}

// Fleet: one message between agents. A pill opens the other agent's thread at
// this same message. The Coordinator pill in a peek goes back to the main
// chat. The pill for the thread you are in does nothing.
function MessageCard({ step }: { step: Step }) {
  const fleet = useContext(FleetContext)
  const owner = useContext(ThreadOwner)
  if (!fleet) return null
  const me = owner ?? COORDINATOR
  const click = (id: string | undefined) => {
    if (!id || id === me) return undefined
    if (id === COORDINATOR) return () => fleet.jumpMain(step.key)
    return () => fleet.openPeek(id, step.key, owner != null)
  }
  return (
    <AgentHandoff
      data-step-key={step.key}
      from={agentName(fleet.state, step.from)}
      to={agentName(fleet.state, step.to)}
      time={stepAge(fleet.state, step)}
      text={<Markdown text={step.label} className="text-[13px] leading-[19px]" />}
      long={step.label.length > 400}
      onFrom={click(step.from)}
      onTo={click(step.to)}
      highlighted={fleet.highlight === step.key}
    />
  )
}

const fleetRow = "flex max-w-160 items-center gap-2.5 rounded-[10px] border bg-background px-3 py-2.5"

// A card the view just jumped to: the cards' own focus ring, for a moment.
const MARK = "ring-2 ring-foreground/15"

// Fleet: the coordinator started agents. A run of spawns folds into one row
// that names the first two. A name opens that agent's peek. "+N" or the
// chevron lists them all.
function SpawnRow({ steps }: { steps: Step[] }) {
  const fleet = useContext(FleetContext)
  const [open, setOpen] = useState(false)
  if (!fleet) return null
  const ids = steps.map((s) => s.subId).filter((id): id is string => !!id)
  const shown = ids.slice(0, 2)
  const rest = ids.length - shown.length
  const name = (id: string) => agentName(fleet.state, id)
  const link = "rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/20"
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-160 rounded-[10px] border bg-background">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Network className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[13px] font-medium">
          Spawned {ids.length} {ids.length === 1 ? "agent" : "agents"}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {shown.map((id, i) => (
            <span key={id}>
              {i ? " · " : ""}
              <button type="button" className={link} onClick={() => fleet.openPeek(id)}>
                {name(id)}
              </button>
            </span>
          ))}
          {rest > 0 ? (
            <>
              {" · "}
              <button type="button" className={link} onClick={() => setOpen(!open)}>
                +{rest}
              </button>
            </>
          ) : null}
        </span>
        <CollapsibleTrigger
          aria-label={open ? "Hide agents" : "Show all agents"}
          className="group ml-auto shrink-0 rounded-sm text-muted-foreground/60 outline-none hover:text-foreground"
        >
          <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="border-t py-1">
          {ids.map((id) => {
            const a = fleet.state.agents.find((n) => n.id === id)
            return (
              <button
                key={id}
                type="button"
                onClick={() => fleet.openPeek(id)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <span className={cn("size-[7px] shrink-0 rounded-full", agentLook(fleet.state, a).dot)} />
                <span className="shrink-0 text-[13px] font-medium">{name(id)}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{a?.title}</span>
              </button>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Fleet: a child agent stopped with an error, as a tool-error row. Retry and
// Reassign send a plain operator message to the coordinator, the same as
// typing it. Nothing else. Amber, not red: an agent error is not a finding.
function AgentErrorRow({ step }: { step: Step }) {
  const fleet = useContext(FleetContext)
  const [busy, setBusy] = useState(false)
  if (!fleet) return null
  const id = step.subId
  const name = agentName(fleet.state, id)
  const task = fleet.state.agents.find((a) => a.id === id)?.title
  const age = stepAge(fleet.state, step)
  const send = (text: string) => {
    setBusy(true)
    fleet.steer(text).finally(() => setBusy(false))
  }
  return (
    <ToolError
      data-step-key={step.key}
      name={step.cut ? `${name} interrupted` : `${name} stopped`}
      paused={step.cut}
      onName={id ? () => fleet.openPeek(id) : undefined}
      target={age || undefined}
      message={sentence(step.label)}
      retrying={busy}
      disabled={!fleet.canSteer}
      onRetry={() => send(`Retry ${name}.`)}
      onSkip={() => send(task ? `Reassign ${name}'s task: ${task}` : `Reassign ${name}'s task.`)}
      skipLabel="Reassign"
    />
  )
}

// A follow-up that stopped. The reason reads as a sentence. The raw output
// (a process's last lines) is in a fold, closed by default. No Retry button:
// the composer keeps the message, and sending it again is the retry.
function ReplyErrorRow({ step }: { step: Step }) {
  return (
    <ToolError
      data-step-key={step.key}
      name="The follow-up stopped"
      message={sentence(step.label) || "No reason was given."}
    >
      {step.detail ? (
        <Collapsible className="mt-1">
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[panel-open]:rotate-90 motion-reduce:transition-none" />
            Output
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
              {step.detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </ToolError>
  )
}

// A quiet line from the system, such as "the workspace was rebuilt". It is
// news, not an error: muted text with no card and no colour.
function SystemLine({ step }: { step: Step }) {
  return (
    <p data-slot="system-line" data-step-key={step.key} className="flex max-w-160 items-start gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{step.label}</span>
    </p>
  )
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
// A folded thinking row. With no step it is the waiting row: the agent has the
// message but has sent nothing yet. It looks the same, but does not open.
function ReasoningPart({ step, tail }: { step: Step | null; tail: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open && !!step} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={!step}
        className="group flex items-center gap-1.5 text-xs text-muted-foreground transition-colors enabled:hover:text-foreground"
      >
        <Brain className="size-3.5" />
        {tail ? <ShimmerLabel active>Thinking…</ShimmerLabel> : "Thought it through"}
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>{open && step ? <ReasoningBody text={step.label} tail={tail} /> : null}</CollapsibleContent>
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
  // A child a restart cut off neither failed nor runs: its mark is "off".
  const mark: Mark = step.cut ? "off" : step.subState === "failed" ? "fail" : step.subState === "done" ? "done" : "running"
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
  stepKey,
}: {
  pending: PendingApproval
  state: CardState
  proofKind: ProofKind
  proofArtifactId: string | null
  // The card's step, so a jump can find it and mark it with the focus ring.
  stepKey?: string
}) {
  const openArtifact = useContext(OpenArtifact)
  const marked = useContext(MarkedStep) === stepKey && !!stepKey
  const proven = state === "proven"
  const clickable = proven && !!proofArtifactId
  const m = CARD_MARK[state]
  const body = (
    <>
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide uppercase">
          <span className="text-muted-foreground">Finding</span>
          <SeverityMark severity={pending.severity} proven={proven} />
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
        data-step-key={stepKey}
        onClick={() => openArtifact(proofArtifactId)}
        className={cn(card, cardInteractive, "group block w-full overflow-hidden text-left", marked && MARK)}
      >
        {body}
      </button>
    )
  }
  return (
    <div data-step-key={stepKey} className={cn(card, "overflow-hidden", marked && MARK)}>
      {body}
    </div>
  )
}

// Fleet: a submitted finding as one compact row. Green shows only once the
// oracle replay proved it; until then it reads like any other row.
function FindingRow({
  pending,
  state,
  proofKind,
  proofArtifactId,
  stepKey,
}: {
  pending: PendingApproval
  state: CardState
  proofKind: ProofKind
  proofArtifactId: string | null
  stepKey?: string
}) {
  const openArtifact = useContext(OpenArtifact)
  const marked = useContext(MarkedStep) === stepKey && !!stepKey
  const proven = state === "proven"
  const note = proven ? `Reproduced on oracle replay${pending.poc ? ` · ${pending.poc}` : ""}` : CARD_NOTE[proofKind][state]
  // One text label at most: the title. The proof state is the leading icon and
  // the severity is the bars on the right, each with a tooltip and a name.
  const body = (
    <>
      <ProofMark state={state} tip={CARD_NOTE[proofKind][state]} className="mt-0.5 self-start" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-[13px] leading-[18px] font-medium text-pretty">{pending.title}</span>
        <span className="truncate text-xs text-muted-foreground">{note}</span>
      </span>
      <SeverityMark severity={pending.severity} proven={proven} className="ml-auto" />
    </>
  )
  if (proven && proofArtifactId)
    return (
      <button
        type="button"
        title="Open replay proof"
        data-step-key={stepKey}
        onClick={() => openArtifact(proofArtifactId)}
        className={cn(fleetRow, cardInteractive, "w-full", marked && MARK)}
      >
        {body}
      </button>
    )
  return (
    <div data-step-key={stepKey} className={cn(fleetRow, marked && MARK)}>
      {body}
    </div>
  )
}
