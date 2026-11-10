import { useEffect, useMemo, useState } from "react"
import { streamRun } from "./api"
import type { FindingStages, PendingApproval, RunEvent, RunStatus, Severity, TargetScope, Verdict } from "./types"

// The live stream is a flat list of raw engine events. The UI wants an ordered
// list of meaningful STEPS — and PoC attempts especially need pairing: a
// `run_poc` (the agent submits an exploit) resolves later into PASS or FAIL
// when its `run_poc-done` lands. This reducer does that translation. It is pure
// and derived fresh from the event array, so replay-on-connect just works.

export type StepKind = "open" | "list" | "read" | "poc" | "cap" | "decided" | "note" | "operator" | "scan"

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

  const num = (v: unknown) => (typeof v === "number" ? v : null)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
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
      case "operator-message":
        // A message the operator sent into the live turn (native steering). It
        // is interleaved in the transcript at the moment it was injected, so the
        // conversation reads as a real back-and-forth, not a one-way log.
        steps.push({ key, kind: "operator", phase, label: str(e.text) })
        break
      case "no-finding":
        finalText = str(e.final) || null
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
    hypothesis: steps.some((s) => s.kind === "read"),
    reproduced: steps.some((s) => s.kind === "poc"),
    proven: steps.some((s) => s.kind === "poc" && s.state === "pass"),
    // A proven run records itself (auto-accept); until it reaches "recorded"
    // the last station is still open. (status is reassigned inside the forEach
    // closure above, which TS control-flow can't see — cast to compare.)
    accepted: (status as RunStatus) === "recorded" ? "auto" : false,
  }

  return { events, steps, scope, status, pending, decision, error, finalText, closed, stages }
}

// Subscribe to a run and keep the reduced state fresh. The server replays the
// whole history on connect, so we always start from an empty buffer.
export function useRun(runId: string | null): RunState | null {
  const [events, setEvents] = useState<RunEvent[]>([])

  useEffect(() => {
    setEvents([])
    if (!runId) return
    const stop = streamRun(runId, (e) => setEvents((prev) => [...prev, e]))
    return stop
  }, [runId])

  return useMemo(() => (runId ? reduceEvents(events) : null), [runId, events])
}
