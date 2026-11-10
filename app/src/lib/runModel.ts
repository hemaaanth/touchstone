import { useEffect, useMemo, useState } from "react"
import { streamRun } from "./api"
import { isTerminal } from "./format"
import { getFixture } from "./fixtures"
import type {
  Activity,
  AgentNode,
  FindingStages,
  FindingSummary,
  PendingApproval,
  RunEvent,
  RunStatus,
  Severity,
  SteerEntry,
  TargetScope,
  Verdict,
} from "./types"

// The live stream is a flat list of raw engine events. The UI wants an ordered
// list of meaningful STEPS — and PoC attempts especially need pairing: a
// `run_poc` (the agent submits an exploit) resolves later into PASS or FAIL
// when its `run_poc-done` lands. This reducer does that translation. It is pure
// and derived fresh from the event array, so replay-on-connect just works.
//
// Beyond tool steps it now folds the agent's own cognition — streamed reasoning
// (`thinking-delta`) and prose (`assistant-delta`/`say`) — plus subagent
// handoffs, per-run findings, and the two-phase steering lifecycle, all keyed
// off the vocabulary pinned in types.ts.

export type StepKind =
  | "open"
  | "list"
  | "read"
  | "poc"
  | "cap"
  | "decided"
  | "note"
  | "operator"
  | "scan"
  | "reasoning"
  | "say"
  | "subagent"

export interface Step {
  key: string
  kind: StepKind
  label: string
  detail?: string
  phase: "run" | "decide"
  // PoC-only
  attempt?: number
  contract?: string
  state?: "running" | "pass" | "fail"
  // Streamed cognition (reasoning/say): the conversation this block belongs to,
  // so a snapshot delta REPLACES the right growing block instead of appending.
  conv?: string
  // Subagent step: the child's id/area, so a handoff row can show its state.
  subId?: string
  subState?: AgentNode["state"]
}

export interface RunState {
  events: RunEvent[]
  steps: Step[]
  // The resource this run is pointed at, from the first `scope` event. Null
  // until it arrives (or on an old run that predates the event). The header
  // reads this so a live run names its real target instead of a hardcoded one.
  scope: TargetScope | null
  status: RunStatus
  pending: PendingApproval | null
  decision: Verdict | null
  error: string | null
  finalText: string | null // the agent's words when it could not prove anything
  closed: boolean
  // The verdict ladder, derived live from the step stream so the same four
  // stations the recorded finding shows are visible while the agent is still
  // working — the before and after views line up.
  stages: FindingStages
  // What the agent is visibly doing right now, from the latest cognition event.
  // Drives the live AgentStatus pill. "idle" once the run is closed/terminal.
  activity: Activity
  // The owner→subagent tree, latest `agent-graph` snapshot. Empty on a single
  // agent run that never fanned out.
  agents: AgentNode[]
  // Findings this run has proven, scoped to the run (no global rail). In order
  // of arrival, deduped by id.
  findings: FindingSummary[]
  // Operator steers across their two-phase life (pending chip → admitted msg).
  steers: SteerEntry[]
  // The finding the run settled on, from `run-complete`. Null until then.
  findingId: string | null
}

export function reduceEvents(events: RunEvent[]): RunState {
  const steps: Step[] = []
  let status: RunStatus = "starting"
  let pending: PendingApproval | null = null
  let decision: Verdict | null = null
  let error: string | null = null
  let finalText: string | null = null
  let closed = false
  let phase: "run" | "decide" = "run"
  let scope: TargetScope | null = null
  let activity: Activity = "working"
  let agents: AgentNode[] = []
  const findings: FindingSummary[] = []
  const steers: SteerEntry[] = []
  let findingId: string | null = null

  const num = (v: unknown) => (typeof v === "number" ? v : null)
  const str = (v: unknown) => (typeof v === "string" ? v : "")

  // Fold a streamed cognition snapshot (reasoning or prose) into one growing
  // step keyed by (conv, attempt). A `-delta` carries the full text each time,
  // so we REPLACE the block's label rather than append — a throttled/dropped
  // tick never loses or doubles prose. First snapshot creates the block at the
  // current transcript position; later ones update it in place.
  const streamStep = (kind: "reasoning" | "say", conv: string, attempt: number | null, text: string) => {
    const k = `${kind}:${conv}:${attempt ?? 0}`
    const existing = steps.find((s) => s.key === k)
    if (existing) {
      existing.label = text
      return
    }
    steps.push({ key: k, kind, phase, conv, label: text })
  }
  const topChecks = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (x && typeof x === "object" && "check" in x ? str((x as { check: unknown }).check) : ""))
          .filter(Boolean)
      : []

  events.forEach((e, i) => {
    const key = `${i}-${e.ev}`
    switch (e.ev) {
      case "scope": {
        // The run's opening event: which resource it is pointed at. Carries no
        // visible step — it sets the header, not the transcript.
        if (e.scope && typeof e.scope === "object") scope = e.scope as TargetScope
        break
      }
      case "opened": {
        phase = e.mode === "decide" ? "decide" : "run"
        // The "decide" pass is the app's own automatic record step — it reopens
        // the run only to replay it and record the proven finding. There is no
        // operator gate, so it gets no visible step here; the honest work of the
        // pass shows up as "Recording the finding" / "Finding recorded" below.
        if (phase === "run")
          steps.push({ key, kind: "open", phase, label: "Agent session started" })
        break
      }
      case "static-scan": {
        // The pre-pass: two independent static engines scan the target and hand
        // the agent a ranked suspect list before it starts. A suspect is only a
        // lead — never a finding until a replay proves it — so this gets a neutral
        // mark. Suspects both engines agree on rank first; we note how many.
        const n = num(e.suspects) ?? 0
        const engines = Array.isArray(e.engines) && e.engines.length
          ? (e.engines as unknown[]).map(str).filter(Boolean)
          : ["Slither"]
        const who = engines.join(" + ")
        const names = topChecks(e.top).slice(0, 3)
        const agreed = Array.isArray(e.top)
          ? (e.top as unknown[]).filter((x) => x && typeof x === "object" && (x as { corroborated?: unknown }).corroborated).length
          : 0
        const detailParts: string[] = []
        if (names.length) detailParts.push(`${who}: ${names.join(", ")}`)
        if (agreed > 0) detailParts.push(`${agreed} corroborated`)
        steps.push({
          key,
          kind: "scan",
          phase,
          label: n > 0 ? `Static scan — ${n} suspect${n === 1 ? "" : "s"}` : "Static scan — nothing flagged",
          detail: detailParts.length ? detailParts.join(" · ") : undefined,
        })
        break
      }
      case "static_findings":
        steps.push({ key, kind: "note", phase, label: "Read the static analyzer report" })
        break
      case "fuzz-scan": {
        // The fuzz pre-pass: two independent property fuzzers try to break an
        // invariant from ordinary calls. A broken invariant is only a lead —
        // never a finding until a replay proves it — so this gets the same neutral
        // mark. An invariant both fuzzers broke ranks first; we note how many.
        const n = num(e.suspects) ?? 0
        const engines = Array.isArray(e.engines) && e.engines.length
          ? (e.engines as unknown[]).map(str).filter(Boolean)
          : ["Echidna"]
        const who = engines.join(" + ")
        const names = topChecks(e.top).slice(0, 3)
        const agreed = Array.isArray(e.top)
          ? (e.top as unknown[]).filter((x) => x && typeof x === "object" && (x as { corroborated?: unknown }).corroborated).length
          : 0
        const detailParts: string[] = []
        if (names.length) detailParts.push(`${who}: ${names.join(", ")}`)
        if (agreed > 0) detailParts.push(`${agreed} corroborated`)
        steps.push({
          key,
          kind: "scan",
          phase,
          label: n > 0 ? `Fuzzing — ${n} invariant${n === 1 ? "" : "s"} broken` : "Fuzzing — nothing broken",
          detail: detailParts.length ? detailParts.join(" · ") : undefined,
        })
        break
      }
      case "fuzz_findings":
        steps.push({ key, kind: "note", phase, label: "Read the property fuzzer report" })
        break
      case "list_sources":
        steps.push({ key, kind: "list", phase, label: "Listed the contract sources" })
        break
      case "read_source":
        steps.push({ key, kind: "read", phase, label: `Read ${str(e.file) || "a source file"}` })
        break
      case "run_poc":
        steps.push({
          key,
          kind: "poc",
          phase,
          label: `Exploit attempt ${num(e.attempt) ?? steps.filter((s) => s.kind === "poc").length + 1}`,
          contract: str(e.contract),
          attempt: num(e.attempt) ?? undefined,
          state: "running",
        })
        break
      case "run_poc-done": {
        // Resolve the most recent still-running PoC for this contract.
        for (let j = steps.length - 1; j >= 0; j--) {
          const s = steps[j]
          if (s.kind === "poc" && s.state === "running" && s.contract === str(e.contract)) {
            s.state = e.passed ? "pass" : "fail"
            s.detail = e.passed
              ? "Replay passed"
              : e.timedOut
                ? "Replay timed out"
                : num(e.failed) != null
                  ? `${num(e.failed)} test${num(e.failed) === 1 ? "" : "s"} failed`
                  : "Replay did not pass"
            break
          }
        }
        break
      }
      case "run_poc-capped":
        steps.push({
          key,
          kind: "cap",
          phase,
          label: "Hit the exploit attempt budget",
          detail: num(e.attempts) != null ? `${num(e.attempts)} attempts used` : "No attempts remaining",
        })
        break
      case "thinking-delta": {
        // The agent's reasoning, streamed as a growing snapshot. Updates the
        // live "Thinking…" status and the collapsible reasoning block.
        streamStep("reasoning", str(e.conv) || "root", num(e.attempt), str(e.text))
        activity = "thinking"
        break
      }
      case "assistant-delta": {
        // The agent's prose answer, streamed as a growing snapshot.
        streamStep("say", str(e.conv) || "root", num(e.attempt), str(e.text))
        activity = "typing"
        break
      }
      case "say": {
        // A finalized assistant message (the engine may emit this instead of, or
        // after, the deltas). Same block key, so it just lands the final text.
        streamStep("say", str(e.conv) || "root", num(e.attempt), str(e.text))
        activity = "typing"
        break
      }
      case "subagent-spawned": {
        const id = str(e.id)
        const area = str(e.area) || "subagent"
        const title = str(e.title) || area
        steps.push({
          key,
          kind: "subagent",
          phase,
          label: title,
          detail: area,
          subId: id,
          subState: "working",
        })
        // Seed the node if the next agent-graph snapshot has not landed yet.
        if (id && !agents.some((n) => n.id === id))
          agents = [...agents, { id, parent: str(e.parent) || null, area, title, state: "working" }]
        activity = "working"
        break
      }
      case "subagent-done": {
        const id = str(e.id)
        const st = e.status === "failed" ? "fail" : "pass"
        for (let j = steps.length - 1; j >= 0; j--) {
          const s = steps[j]
          if (s.kind === "subagent" && s.subId === id) {
            s.subState = e.status === "failed" ? "failed" : "done"
            s.state = st
            break
          }
        }
        agents = agents.map((n) =>
          n.id === id ? { ...n, state: e.status === "failed" ? "failed" : "done" } : n,
        )
        break
      }
      case "agent-graph": {
        if (Array.isArray(e.nodes))
          agents = (e.nodes as unknown[])
            .filter((n): n is AgentNode => !!n && typeof n === "object" && "id" in n)
            .map((n) => n)
        break
      }
      case "finding": {
        const id = str(e.id)
        if (id && !findings.some((f) => f.id === id)) {
          const stages = (e.stages && typeof e.stages === "object" ? e.stages : null) as FindingStages | null
          findings.push({
            id,
            runId: str(e.runId) || undefined,
            title: str(e.title) || "Finding",
            severity: (str(e.severity) || "medium") as Severity,
            module: str(e.module) || "",
            target: str(e.target) || scope?.title || "",
            proven: e.proven !== false,
            dismissed: false,
            ms: num(e.ms),
            stages:
              stages ?? {
                hypothesis: true,
                reproduced: true,
                proven: e.proven !== false,
                accepted: "auto",
              },
          })
        }
        break
      }
      case "steer-pending": {
        const id = str(e.id)
        if (id && !steers.some((s) => s.id === id))
          steers.push({ id, text: str(e.text), state: "pending" })
        break
      }
      case "steer-rejected": {
        const id = str(e.id)
        const s = steers.find((x) => x.id === id)
        if (s) s.state = "rejected"
        break
      }
      case "approval-pending":
        pending = {
          id: str(e.id),
          title: str(e.title),
          severity: (str(e.severity) || "medium") as Severity,
          poc: str(e.poc),
        }
        status = "awaiting-approval"
        break
      case "host-deciding":
        steps.push({
          key,
          kind: "note",
          phase: "decide",
          label: e.status === "approved" ? "Recording the finding" : "Rejecting the finding",
        })
        break
      case "approval-decided":
        steps.push({
          key,
          kind: "decided",
          phase: "decide",
          label: e.status === "approved" ? "Finding recorded" : "Finding denied",
          state: e.status === "approved" ? "pass" : "fail",
        })
        break
      case "operator-message": {
        // The second phase of a steer: the agent admitted the operator's message
        // into the live turn. It is interleaved in the transcript at the moment
        // it took effect, so the conversation reads as a real back-and-forth. If
        // it carries the id of a pending steer, that chip is now admitted and
        // stops showing as pending over the composer.
        const id = str(e.id)
        if (id) {
          const s = steers.find((x) => x.id === id)
          if (s) s.state = "admitted"
        }
        steps.push({ key, kind: "operator", phase, label: str(e.text), ...(id ? { subId: id } : {}) })
        break
      }
      case "no-finding":
        finalText = str(e.final) || null
        break
      case "run-complete":
        // The engine's terminal event: the run has settled. Carries the final
        // status and the finding it recorded, if any. The stream still ends with
        // its own `closed`, so `closed` stays the single "stream done" signal.
        if (typeof e.status === "string") status = e.status as RunStatus
        if (typeof e.findingId === "string") findingId = e.findingId
        break
      case "status":
        if (typeof e.status === "string") status = e.status as RunStatus
        if (e.pending) pending = e.pending as PendingApproval
        if (e.decision === "approve" || e.decision === "deny") decision = e.decision
        if (typeof e.error === "string") error = e.error
        break
      case "closed":
        closed = true
        break
      default:
        break
    }
  })

  const stages: FindingStages = {
    // The agent formed a hypothesis once it read a source or reasoned about one.
    hypothesis: steps.some((s) => s.kind === "read" || s.kind === "reasoning"),
    reproduced: steps.some((s) => s.kind === "poc"),
    proven: steps.some((s) => s.kind === "poc" && s.state === "pass"),
    // A proven run records itself (auto-accept); until it reaches "recorded"
    // the last station is still open. (status is reassigned inside the forEach
    // closure above, which TS control-flow can't see — cast to compare.)
    accepted: (status as RunStatus) === "recorded" ? "auto" : false,
  }

  // Once the run has settled there is nothing in flight — the status pill, not
  // the activity pill, carries the outcome.
  if (closed || isTerminal(status as RunStatus)) activity = "idle"

  return {
    events,
    steps,
    scope,
    status,
    pending,
    decision,
    error,
    finalText,
    closed,
    stages,
    activity,
    agents,
    findings,
    steers,
    findingId,
  }
}

// Subscribe to a run and keep the reduced state fresh. The server replays the
// whole history on connect, so we always start from an empty buffer.
//
// A runId of `fixture:<name>` replays a canned `.events` sequence over timers
// instead of opening the SSE — the deterministic, zero-cost harness the whole
// streaming UI is built and visually verified against. It exercises the real
// reduce → buildMessages → render path; only the transport is swapped. The DEV
// shell is the only thing that ever hands useRun a `fixture:` id.
export function useRun(runId: string | null): RunState | null {
  const [events, setEvents] = useState<RunEvent[]>([])

  useEffect(() => {
    setEvents([])
    if (!runId) return

    if (runId.startsWith("fixture:")) {
      const script = getFixture(runId.slice("fixture:".length))
      let i = 0
      let timer: ReturnType<typeof setTimeout>
      const tick = () => {
        if (i >= script.length) return
        const e = script[i++]
        setEvents((prev) => [...prev, e])
        // Streamed snapshots land fast so prose visibly grows; discrete tool
        // steps get a human beat between them.
        const gap = e.ev === "thinking-delta" || e.ev === "assistant-delta" ? 90 : 300
        timer = setTimeout(tick, gap)
      }
      timer = setTimeout(tick, 120)
      return () => clearTimeout(timer)
    }

    const stop = streamRun(runId, (e) => setEvents((prev) => [...prev, e]))
    return stop
  }, [runId])

  return useMemo(() => (runId ? reduceEvents(events) : null), [runId, events])
}
