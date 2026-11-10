import { useEffect, useMemo } from "react"
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
  FileSearch,
  FileText,
  FlaskConical,
  ListTree,
  Radar,
  ShieldCheck,
  TerminalSquare,
  Loader2,
} from "lucide-react"
import type { PendingApproval, RunStatus, RunSummary } from "@/lib/types"
import { useRun, type RunState, type Step } from "@/lib/runModel"
import { steerRun } from "@/lib/api"
import { isTerminal, statusLabel, statusTone, DOT } from "@/lib/format"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

// The center column. The run is a pi-durable agent session; its live SSE step
// log is reduced into RunState, then mapped onto assistant-ui's message model
// so the Thread, tool-call cards and composer come from one maintained library
// instead of hand-rolled scroll/compose code. We own the state (ExternalStore)
// and the look (base-nova classes + our own tool-part renderer), so adopting
// the library costs no backend protocol change and keeps the restraint rules:
// our renderer reads `step.state`, so green only ever shows for a proven PoC.

export function RunChat({
  run,
  onStatus,
}: {
  run: RunSummary
  onStatus: (status: RunStatus, pending: PendingApproval | null) => void
}) {
  const state = useRun(run.id)
  const status = state?.status ?? run.status
  const scope = state?.scope ?? null
  const live = !isTerminal(status)

  // Report status + pending up so the sidebar row and spend meter follow live.
  useEffect(() => {
    if (state) onStatus(state.status, state.pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status, state?.pending])

  const messages = useMemo(() => buildMessages(state, status), [state, status])

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

  const tone = statusTone(status)

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{scope?.title ?? run.title ?? run.alias}</h1>
            {scope ? (
              <Badge variant="secondary" className="capitalize">
                {scope.kind}
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{scope?.blurb ?? "Agent run"}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
            <span className={cn("size-1.5 rounded-full", DOT[tone], live && "animate-pulse")} />
            {statusLabel(status)}
          </span>
          <Badge variant="outline" className="font-mono text-[11px]">
            {run.alias}
          </Badge>
        </div>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        <Thread live={live} empty={messages.length === 0} error={status === "error" ? state?.error ?? null : null} />
      </AssistantRuntimeProvider>
    </div>
  )
}

// The thread body + composer, styled in base-nova. Headless assistant-ui
// primitives do the scroll-stickiness, message iteration and compose state.
function Thread({ live, empty, error }: { live: boolean; empty: boolean; error: string | null }) {
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

// One message. The root carries data-role, so a user steer reads as the
// operator's own primary bubble while the agent's message stays a plain column
// of prose and tool-call parts. Tool parts only ever occur in assistant
// messages, so the bubble styling never touches them.
function Message() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-3 data-[role=user]:ml-auto data-[role=user]:max-w-[80%] data-[role=user]:rounded-2xl data-[role=user]:rounded-br-sm data-[role=user]:bg-primary data-[role=user]:px-3.5 data-[role=user]:py-2 data-[role=user]:text-primary-foreground">
      <MessagePrimitive.Parts components={{ Text, tools: { Fallback: StepPart } }} />
    </MessagePrimitive.Root>
  )
}

const Text: TextMessagePartComponent = ({ text }) => (
  <div className="text-sm leading-relaxed">{text}</div>
)

// Our own renderer for every tool-call part. It reads the Step we packed into
// `args`, so the PoC pass/fail tone and the proof card come from `step.state`
// — never from assistant-ui's generic running/done status.
const StepPart: ToolCallMessagePartComponent = ({ args }) => {
  const a = args as { step?: Step; pending?: PendingApproval; proven?: boolean }
  if (a.pending) return <ProofCard pending={a.pending} proven={!!a.proven} />
  const step = a.step
  if (!step) return null

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
// message whose tool-call parts carry the Step for our renderer. The agent's
// closing prose and the live proof card trail the final assistant message.
// Keying each message by its first step id keeps rows and scroll stable as the
// stream grows.
function buildMessages(state: RunState | null, status: RunStatus): ThreadMessageLike[] {
  if (!state) return []
  const msgs: ThreadMessageLike[] = []
  let buf: { id: string; parts: ThreadMessageLike["content"] } | null = null

  const flush = () => {
    if (buf && buf.parts.length) msgs.push({ role: "assistant", id: buf.id, content: buf.parts })
    buf = null
  }

  for (const step of state.steps) {
    if (step.kind === "operator") {
      flush()
      msgs.push({ role: "user", id: step.key, content: [{ type: "text", text: step.label }] })
      continue
    }
    if (!buf) buf = { id: step.key, parts: [] }
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: step.key,
      toolName: step.kind,
      args: { step },
      result: step.state ?? "done",
    })
  }

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
