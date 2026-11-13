import { useCallback, useSyncExternalStore } from "react"
import { fetchRun, HttpError, streamRun } from "./api"
import { isTerminal } from "./format"
import { closingHeld, repairFinalSay } from "./final-text"
import type {
  Activity,
  AgentNode,
  ArtifactDoc,
  BulletinNote,
  ArtifactVersion,
  FindingStages,
  FindingSummary,
  ModulePlanEntry,
  PendingApproval,
  PrepassTool,
  PrepassView,
  RunEvent,
  RunLead,
  RunStatus,
  Severity,
  SteerEntry,
  TargetScope,
  Verdict,
} from "./types"
import { COORDINATOR } from "./types"

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
  | "artifact"
  | "message"
  | "agent-error"
  | "submitted"
  // A quiet line from the system, e.g. "the workspace was rebuilt".
  | "system"
  // A follow-up that stopped. `label` is the reason; `detail` is the raw output.
  | "reply-error"

// A server error can be one sentence, a blank line, then raw output (a
// process's last lines). The sentence is for reading; the raw part is shown as
// preformatted text.
export function splitRaw(error: string): { text: string; raw: string | null } {
  const at = error.search(/\n[ \t]*\n/)
  if (at < 0) return { text: error.trim(), raw: null }
  const raw = error.slice(at).replace(/^\s*\n/, "").trimEnd()
  return { text: error.slice(0, at).trim(), raw: raw.trim() ? raw : null }
}

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
  // Also carries an artifact id on an "artifact" step, so its transcript chip
  // can look the live document up in RunState.artifacts.
  subId?: string
  subState?: AgentNode["state"]
  // "submitted" step: the finding the agent submitted at this point. Its card
  // renders inline here, so several findings read in the order they landed.
  finding?: PendingApproval
  // Fleet: the child that made this step. Absent = the coordinator.
  agent?: string
  // "message" step: who sent it and who got it (child id or COORDINATOR).
  // The text is in `label`. The same step shows in both agents' threads.
  from?: string
  to?: string
  // A "say" step made from the run's closing words, when the stream did not
  // already hold them (an old record).
  closing?: boolean
  // A child's handoff or end that a server restart cut off (the server's
  // `subagent-done` with `interrupted: true`). It did not fail.
  cut?: boolean
}

// Lower is worse. Matches spike/lib/record.mjs so the UI and the recorder agree
// on which finding leads.
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
export const severityRank = (s: string | undefined) => SEV_RANK[String(s ?? "").toLowerCase()] ?? 4


// A classified, operator-readable run failure from the server. `kind` picks the
// tone and icon of the error card; `retryable` decides whether "Run again" is
// the headline action; `detail` is the real engine/gateway error text; `hint`
// is the one concrete next step; `spentUsd` is what the run actually cost.
export interface RunFailure {
  kind: "transient" | "account" | "budget" | "cutoff" | "coverage" | "model" | "crash" | "unknown"
  title: string
  hint: string
  detail: string
  message: string
  retryable: boolean
  spentUsd: number
  reason?: string
}

export interface RunState {
  events: RunEvent[]
  steps: Step[]
  // The resource this run is pointed at, from the first `scope` event. Null
  // until it arrives (or on an old run that predates the event). The header
  // reads this so a live run names its real target instead of a hardcoded one.
  scope: TargetScope | null
  status: RunStatus
  // The worst finding submitted so far (null until the first one).
  pending: PendingApproval | null
  // Every finding the agent submitted, in submission order.
  submitted: PendingApproval[]
  decision: Verdict | null
  error: string | null
  // The structured, classified failure behind `error`. Null unless the run ended
  // in an error state. Drives the error card; `error` stays the plain fallback.
  errorInfo: RunFailure | null
  // A recorded run that did not read its whole scope: what was not read. A
  // warning beside the finding, not an error. Null when the scope was covered.
  coverage: RunFailure | null
  finalText: string | null // the agent's words when it could not prove anything
  // No worker is running. A follow-up message reopens the run (`reply-start`)
  // and a later `closed` ends it again.
  closed: boolean
  // A follow-up worker is answering, and when it started.
  replying: boolean
  replyStartedAt: number | null
  // Archived runs are locked: they take no more messages.
  archived: boolean
  // The operator's name for the run, from the latest `renamed` event.
  name: string | null
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
  // Fleet: the run's shared Bulletin, in post order. Empty without a fleet.
  bulletin: BulletinNote[]
  // Leads the agents recorded, worst first, one per id. Never proven.
  leads: RunLead[]
  // Findings this run has proven, scoped to the run (no global rail). In order
  // of arrival, deduped by id.
  findings: FindingSummary[]
  // Operator steers across their two-phase life (pending chip → admitted msg).
  steers: SteerEntry[]
  // Workspace documents the agent wrote (the PoC it drafts, the proof it runs),
  // in order of first appearance. The artifact pane renders the open one; its
  // transcript chip links back to it. Empty on a run that wrote nothing.
  artifacts: ArtifactDoc[]
  // The most recently opened file+version, so the pane can auto-follow a fresh
  // write even when it is a new version of an older file (which does not move
  // that file to the end of `artifacts`). Null until the first artifact opens.
  latestArtifact: { fileId: string; versionId: string } | null
  // The finding the run settled on, from `run-complete`. Null until then.
  findingId: string | null
  // What the pack's tools found before the agent started. Null when the pack
  // has no prepass or it has not finished.
  prepass: PrepassView | null
  // The run's pipeline plan, from the `modules` event at run start. Null on a
  // run that predates the event.
  modules: ModulePlanEntry[] | null
  // The provider and model id the run started with, from the `provider` event.
  // Null on a run that predates the event.
  provider: { id: string; model: string } | null
  // The agents a server restart cut off mid-turn, each with the server's plain
  // reason. An agent leaves this list when it works again.
  cutOff: Record<string, string>
  // The operator stopped the run's last piece of work. A follow-up clears it.
  stopped: boolean
}

export function reduceEvents(events: RunEvent[]): RunState {
  const steps: Step[] = []
  let status: RunStatus = "starting"
  let pending: PendingApproval | null = null
  const submitted: PendingApproval[] = []
  let decision: Verdict | null = null
  let error: string | null = null
  let errorInfo: RunFailure | null = null
  let coverage: RunFailure | null = null
  let finalText: string | null = null
  // The closing step added at the run's end, until the run's status settles.
  // If the run then ends as an error other than a coverage gap, the words go.
  let closing: Step | null = null
  let closed = false
  let replying = false
  let replyStartedAt: number | null = null
  let archived = false
  let name: string | null = null
  let phase: "run" | "decide" = "run"
  let scope: TargetScope | null = null
  let activity: Activity = "working"
  let agents: AgentNode[] = []
  const bulletin: BulletinNote[] = []
  const leads: RunLead[] = []
  const findings: FindingSummary[] = []
  const steers: SteerEntry[] = []
  const artifacts: ArtifactDoc[] = []
  let latestArtifact: { fileId: string; versionId: string } | null = null
  let findingId: string | null = null
  let prepass: PrepassView | null = null
  let modules: ModulePlanEntry[] | null = null
  let provider: { id: string; model: string } | null = null
  const cutOff: Record<string, string> = {}
  let stopped = false

  const num = (v: unknown) => (typeof v === "number" ? v : null)
  const str = (v: unknown) => (typeof v === "string" ? v : "")

  // Fold a streamed cognition snapshot (reasoning or prose) into one growing
  // step keyed by (conv, attempt). A `-delta` carries the full text each time,
  // so we REPLACE the block's label rather than append — a throttled/dropped
  // tick never loses or doubles prose. First snapshot creates the block at the
  // current transcript position; later ones update it in place.
  //
  // Attempt numbers are not unique across turns. A follow-up from an older
  // engine, an "audit-continue" pass and a fleet child's task ids can all
  // start again at a number an earlier turn used. So the same key after a turn
  // boundary is a new answer: it gets a new step at the current position, not
  // the old step far above. The one exception is a late tick of the old
  // answer itself: its text still starts with what that step shows.
  const stream = new Map<string, Step>()
  let turnKeys = new Set<string>()
  // Where the current turn starts in `steps`. The closing words are checked
  // and repaired only against the main agent's prose of this turn: an earlier
  // turn's answer or a child's words are other texts, and stay as they are.
  let turnStart = 0
  const newTurn = () => {
    turnKeys = new Set()
    closing = null
    turnStart = steps.length
  }
  const turnProse = () => steps.slice(turnStart).filter((s) => !s.agent)
  const streamStep = (kind: "reasoning" | "say", conv: string, attempt: number | null, text: string, i: number) => {
    const k = `${kind}:${conv}:${attempt ?? 0}`
    const prev = stream.get(k)
    if (prev && (turnKeys.has(k) || (prev.label !== "" && text.startsWith(prev.label)))) {
      prev.label = text
      turnKeys.add(k)
      return
    }
    const step: Step = { key: prev ? `${k}@${i}` : k, kind, phase, conv, label: text }
    steps.push(step)
    stream.set(k, step)
    turnKeys.add(k)
  }
  // Fleet: update one child's node in place (by id). No-op for an unknown id.
  const patchAgent = (id: string, patch: Partial<AgentNode>) => {
    agents = agents.map((n) => (n.id === id ? { ...n, ...patch } : n))
  }
  events.forEach((e, i) => {
    const key = `${i}-${e.ev}`
    // Fleet: a child made this event. Its steps get tagged with the child's id,
    // and its cognition moves the child's own activity, not the run's.
    const who = str(e.agent) || null
    const stepsBefore = steps.length
    const activityBefore = activity
    switch (e.ev) {
      case "scope": {
        // The run's opening event: which resource it is pointed at. Carries no
        // visible step — it sets the header, not the transcript.
        if (e.scope && typeof e.scope === "object") scope = e.scope as TargetScope
        break
      }
      case "provider":
        // The provider and model the run started with. No step.
        if (str(e.provider) && str(e.model)) provider = { id: str(e.provider), model: str(e.model) }
        break
      case "modules": {
        // The pipeline plan. It shows on the Modules page, not in the
        // transcript, so it adds no step.
        if (Array.isArray(e.modules)) modules = e.modules as ModulePlanEntry[]
        break
      }
      case "opened": {
        phase = e.mode === "decide" ? "decide" : "run"
        newTurn()
        // The "decide" pass is the app's own automatic record step — it reopens
        // the run only to replay it and record the proven finding. There is no
        // operator gate, so it gets no visible step here; the honest work of the
        // pass shows up as "Recording the finding" / "Finding recorded" below.
        // A follow-up ("chat") reopens the same session; the operator's message
        // already marks where it starts, so it gets no second "started" row.
        if (phase === "run" && e.mode !== "chat")
          steps.push({ key, kind: "open", phase, label: "Agent session started" })
        break
      }
      case "prepass": {
        // The pack's tool scan, summarised for every pack. It shows in one closed
        // fold above the transcript, so the raw static-scan and fuzz-scan events
        // add no step of their own. The leads are not findings.
        prepass = {
          total: num(e.total) ?? 0,
          tools: Array.isArray(e.tools) ? (e.tools as PrepassView["tools"]) : [],
          leads: Array.isArray(e.leads) ? (e.leads as PrepassView["leads"]) : [],
          ...(e.failed ? { failed: true } : {}),
        }
        break
      }
      case "static-scan":
      case "fuzz-scan":
        break
      case "static_findings":
        steps.push({ key, kind: "note", phase, label: "Read the static analyzer report" })
        break
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
              ? "Test passed"
              : e.timedOut
                ? "Test timed out"
                : num(e.failed) != null
                  ? `${num(e.failed)} test${num(e.failed) === 1 ? "" : "s"} failed`
                  : "Test failed"
            break
          }
        }
        // Mark the PoC artifact version this attempt ran, so the pane's version
        // switcher can show which rewrite actually passed its replay. Match the
        // latest still-running version for this contract — attempts resolve one
        // at a time, so the newest running one is this attempt's.
        for (const a of artifacts) {
          const v = [...a.versions].reverse().find((x) => x.contract === str(e.contract) && x.state === "running")
          if (v) {
            v.state = e.passed ? "pass" : "fail"
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
        streamStep("reasoning", str(e.conv) || who || "root", num(e.attempt), str(e.text), i)
        activity = "thinking"
        break
      }
      case "assistant-delta": {
        // The agent's prose answer, streamed as a growing snapshot.
        streamStep("say", str(e.conv) || who || "root", num(e.attempt), str(e.text), i)
        activity = "typing"
        break
      }
      case "say": {
        // A finalized assistant message (the engine may emit this instead of, or
        // after, the deltas). Same block key, so it just lands the final text.
        streamStep("say", str(e.conv) || who || "root", num(e.attempt), str(e.text), i)
        activity = "typing"
        break
      }
      case "artifact-open": {
        // The agent opens a version of a workspace document — the PoC it is about
        // to draft (or redraft after a steer), the proof trace it will run. The
        // version id is unique per write; `fileId` groups rewrites of the same
        // file (defaulting to the version id when the engine sends none, so a
        // one-shot doc is a single-version file). A brand-new file is pushed to
        // `artifacts`; a rewrite appends a version to the file already there.
        // Either way the version gets its own transcript chip (this step) — a
        // rewrite reads as a new pill, not an older one silently changing.
        const vid = str(e.id)
        if (!vid) break
        const fileId = str(e.fileId) || vid
        const title = str(e.title) || "Document"
        const attempt = num(e.attempt)
        const contract = str(e.contract) || undefined
        const forFinding = str(e.findingId) || undefined
        const version: ArtifactVersion = {
          id: vid,
          text: "",
          writing: true,
          ...(attempt != null ? { attempt, state: "running" } : {}),
          ...(contract ? { contract } : {}),
        }
        const file = artifacts.find((a) => a.id === fileId)
        if (file) {
          if (!file.versions.some((v) => v.id === vid)) file.versions.push(version)
        } else {
          artifacts.push({
            id: fileId,
            title,
            kind: (str(e.kind) || "report") as ArtifactDoc["kind"],
            lang: str(e.lang) || undefined,
            versions: [version],
            ...(forFinding ? { findingId: forFinding } : {}),
          })
        }
        // Proofs land worst first. Follow only the first one, so the pane opens
        // on the worst finding, not the last (least severe) one recorded.
        const laterProof = str(e.kind) === "proof" && artifacts.some((a) => a.kind === "proof" && a.id !== fileId)
        if (!laterProof) latestArtifact = { fileId, versionId: vid }
        steps.push({ key, kind: "artifact", phase, label: title, detail: str(e.kind) || undefined, subId: vid })
        activity = "working"
        break
      }
      case "artifact-delta": {
        // A growing snapshot of the version's full text — REPLACE, keyed by the
        // version id (unique across files), so a rewrite never bleeds into an
        // earlier version.
        const vid = str(e.id)
        for (const a of artifacts) {
          const v = a.versions.find((x) => x.id === vid)
          if (v) {
            v.text = str(e.text)
            break
          }
        }
        break
      }
      case "artifact-done": {
        const vid = str(e.id)
        for (const a of artifacts) {
          const v = a.versions.find((x) => x.id === vid)
          if (v) {
            v.writing = false
            break
          }
        }
        break
      }
      case "subagent-spawned": {
        const id = str(e.id)
        delete cutOff[id]
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
          agents = [
            ...agents,
            {
              id,
              parent: str(e.parent) || null,
              area,
              title,
              state: "working",
              name: str(e.name) || undefined,
              tier: e.tier === "T2" ? "T2" : "T1",
              conv: str(e.conv) || undefined,
              activity: "working",
              spendUsd: null,
              startedAt: num(e.t),
              endedAt: null,
            },
          ]
        activity = "working"
        break
      }
      case "subagent-done": {
        const id = str(e.id)
        const st = e.status === "failed" ? "fail" : "pass"
        // The server ends a child that a restart cut off as "failed" with
        // `interrupted: true`. It shows as interrupted, not as failed.
        const cut = e.interrupted === true
        if (cut) cutOff[id] = str(e.error) || "The server restarted while this agent was working."
        else delete cutOff[id]
        for (let j = steps.length - 1; j >= 0; j--) {
          const s = steps[j]
          if (s.kind === "subagent" && s.subId === id) {
            s.subState = e.status === "failed" ? "failed" : "done"
            s.state = st
            if (cut) s.cut = true
            break
          }
        }
        const failed = e.status === "failed"
        patchAgent(id, {
          state: failed ? "failed" : "done",
          activity: "idle",
          endedAt: num(e.t),
          ...(failed ? { error: str(e.error) || "Stopped with an error" } : {}),
        })
        // A failed child gets its own row in the main chat (Retry / Reassign).
        if (failed)
          steps.push({ key, kind: "agent-error", phase, label: str(e.error) || "Stopped with an error", subId: id, ...(cut ? { cut } : {}) })
        break
      }
      case "agent-graph": {
        // A snapshot of the tree. Keep the fleet fields we already know, since
        // a snapshot may not repeat them.
        if (Array.isArray(e.nodes))
          agents = (e.nodes as unknown[])
            .filter((n): n is AgentNode => !!n && typeof n === "object" && "id" in n)
            .map((n) => ({ ...agents.find((a) => a.id === n.id), ...n }))
        break
      }
      case "agent-status": {
        const st = e.state === "idle" ? "idle" : "working"
        if (st === "working") delete cutOff[str(e.id)]
        patchAgent(str(e.id), { state: st, ...(st === "idle" ? { activity: "idle" as const } : {}) })
        break
      }
      case "agent-message": {
        const from = str(e.from) || who || COORDINATOR
        const to = str(e.to) || COORDINATOR
        steps.push({ key, kind: "message", phase, label: str(e.text), from, to, subId: str(e.id) || undefined })
        break
      }
      case "bulletin-post": {
        const author = str(e.author) || who || COORDINATOR
        const sev = str(e.severity).toLowerCase()
        const authorTier = agents.find((n) => n.id === author)?.tier
        bulletin.push({
          id: str(e.id) || key,
          author,
          t: num(e.t),
          text: str(e.text),
          kind: e.kind === "lead" ? "lead" : "note",
          ...(sev in SEV_RANK ? { severity: sev as Severity } : {}),
          tags: Array.isArray(e.tags) ? e.tags.filter((x): x is string => typeof x === "string") : [],
          // A T2 author can never post to the trusted lane, whatever it says.
          lane: e.lane === "evidence" || authorTier === "T2" ? "evidence" : "trusted",
          stepKey: key,
        })
        break
      }
      case "lead": {
        // One lead per id. A later event for the same id replaces it in place.
        const id = str(e.id)
        const file = str(e.file)
        const line = num(e.line)
        if (!id || !file || line == null || line < 1) break
        const sev = str(e.severity).toLowerCase()
        const lead: RunLead = {
          id,
          author: who || COORDINATOR,
          t: num(e.t),
          severity: sev in SEV_RANK ? (sev as Severity) : null,
          file,
          line,
          title: str(e.title),
          reason: str(e.reason),
          proof: str(e.proof) || null,
          stepKey: key,
        }
        const at = leads.findIndex((l) => l.id === id)
        if (at >= 0) leads[at] = lead
        else leads.push(lead)
        break
      }
      case "agent-spend": {
        const usd = num(e.usd)
        if (usd != null) patchAgent(str(e.id), { spendUsd: usd })
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
            poc: str(e.poc) || undefined,
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
      case "finding-submitted":
      case "approval-pending": {
        // The agent submitted a finding. The new engine keeps auditing after
        // this (`finding-submitted`, many per run); an old run had exactly one
        // (`approval-pending`, then a decide phase). Either way the card sits
        // here in the transcript, and `pending` tracks the worst one so far.
        const poc = str(e.poc)
        if (submitted.some((f) => f.poc && f.poc === poc)) break
        const n = num(e.n) ?? submitted.length + 1
        const f: PendingApproval = {
          id: str(e.id) || `sub-${n}`,
          title: str(e.title) || "Finding",
          severity: (str(e.severity) || "medium") as Severity,
          poc,
          n,
        }
        submitted.push(f)
        steps.push({ key, kind: "submitted", phase, label: f.title, finding: f })
        pending = submitted.reduce((w, x) => (severityRank(x.severity) < severityRank(w.severity) ? x : w))
        if (e.ev === "approval-pending") status = "awaiting-approval"
        break
      }
      case "submit-rejected":
        steps.push({
          key,
          kind: "note",
          phase,
          label:
            e.reason === "duplicate"
              ? `Skipped a repeat submission of ${str(e.poc)}`
              : `Refused to record ${str(e.poc)}: its test has not passed`,
        })
        break
      case "audit-continue":
        newTurn()
        steps.push({
          key,
          kind: "note",
          phase,
          label: `Asked the agent to keep auditing (${num(e.found) ?? 0} found so far)`,
        })
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
        newTurn()
        break
      }
      case "no-finding": {
        // The agent's closing words. The stream usually holds them already,
        // whole: then they show there, once. Otherwise (an old record) they
        // become a prose step here, at the run's end, so a later turn shows
        // below them.
        finalText = str(e.final) || null
        if (finalText && !closingHeld(turnProse(), finalText) && !repairFinalSay(turnProse(), finalText)) {
          closing = { key, kind: "say", phase, conv: "root", label: finalText, closing: true }
          steps.push(closing)
        }
        break
      }
      case "coverage":
        coverage = e.info && typeof e.info === "object" ? (e.info as RunFailure) : null
        break
      case "settled": {
        // The streamed prose can end one chunk short. The settled event holds the
        // whole answer, so the last prose step takes it. Old records get the same repair.
        const summary = e.summary as { final?: { text?: unknown } } | undefined
        repairFinalSay(turnProse(), summary?.final?.text)
        break
      }
      case "run-complete":
        // The engine's terminal event: the run has settled. Carries the final
        // status and the finding it recorded, if any. The stream still ends with
        // its own `closed`, so `closed` stays the single "stream done" signal.
        if (typeof e.status === "string") status = e.status as RunStatus
        if (typeof e.findingId === "string") findingId = e.findingId
        break
      case "status":
        if (typeof e.status === "string") status = e.status as RunStatus
        // The server's own view of `pending` only matters when the stream had
        // no submission event to derive it from (a very old replay).
        if (e.pending && !submitted.length) pending = e.pending as PendingApproval
        if (e.decision === "approve" || e.decision === "deny") decision = e.decision
        // The live server records a finding by broadcasting a terminal `status`
        // (not the CLI's `run-complete`), stamping the recorded run's id here. We
        // resolve it so the proof pane can fetch that finding by id — without it a
        // live recorded run has no findingId and the replay proof never loads.
        if (typeof e.findingId === "string") findingId = e.findingId
        if (typeof e.error === "string") error = e.error
        // The classified failure the server attached to a terminal error status.
        if (e.errorInfo && typeof e.errorInfo === "object") errorInfo = e.errorInfo as RunFailure
        // The run's end status decides if the closing step stays: it does for
        // "no-finding" and for a coverage gap, not for another end.
        if (closing && ["recorded", "denied", "error", "no-finding"].includes(status)) {
          const keep = status === "no-finding" || (status === "error" && errorInfo?.kind === "coverage")
          if (!keep) steps.splice(steps.indexOf(closing), 1)
          closing = null
        }
        break
      case "closed":
        closed = true
        replying = false
        break
      // An operator message to an idle run starts a follow-up worker.
      case "reply-start":
        newTurn()
        closed = false
        replying = true
        replyStartedAt = typeof e.t === "number" ? e.t : null
        activity = "working"
        stopped = false
        error = null
        errorInfo = null
        break
      case "stopped":
        stopped = true
        activity = "idle"
        steps.push({ key, kind: "note", phase, label: "You stopped the run. Send a message to continue." })
        break
      case "stop-requested":
        steps.push({ key, kind: "note", phase, label: "Stopping the run" })
        break
      case "phase-restarted": {
        const step = ({ setup: "setup", prepass: "tool scan", agent: "agent turn", proof: "proof check" } as Record<string, string>)[str(e.phase)] ?? "step"
        newTurn()
        steps.push({ key, kind: "note", phase, label: `The server restarted, so the ${step} started again` })
        break
      }
      case "reply-error": {
        const { text, raw } = splitRaw(str(e.error))
        steps.push({ key, kind: "reply-error", phase, label: text, detail: raw ?? undefined })
        break
      }
      case "workspace":
        // The run's old workspace was gone, so the server built a new one.
        if (str(e.state) === "rebuilt" && str(e.message).trim())
          steps.push({ key, kind: "system", phase, label: str(e.message).trim() })
        break
      case "archived":
        archived = Boolean(e.archived)
        break
      case "renamed":
        name = str(e.name) || null
        break
      default:
        break
    }
    if (who) {
      // Tag the steps this child event added, and keep the run's activity on
      // the coordinator. The child's own activity lives on its node.
      for (let j = stepsBefore; j < steps.length; j++) steps[j].agent ??= who
      // A cognition delta updates an existing block in place; tag it too.
      if (e.ev === "thinking-delta" || e.ev === "assistant-delta" || e.ev === "say") {
        const conv = str(e.conv) || who
        for (const s of steps) if (s.conv === conv) s.agent ??= who
      }
      if (activity !== activityBefore) {
        const childActivity = activity
        activity = activityBefore
        patchAgent(who, { activity: childActivity, ...(childActivity !== "idle" ? { state: "working" } : {}) })
      }
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
  if (closed || (isTerminal(status as RunStatus) && !replying)) activity = "idle"

  return {
    events,
    steps,
    scope,
    status,
    pending,
    submitted,
    decision,
    error,
    errorInfo,
    coverage,
    finalText,
    closed,
    replying,
    replyStartedAt,
    archived,
    name,
    stages,
    activity,
    agents,
    bulletin,
    // Worst first; the sort is stable, so equal severities keep arrival order.
    leads: leads.toSorted((a, b) => severityRank(a.severity ?? undefined) - severityRank(b.severity ?? undefined)),
    findings,
    steers,
    artifacts,
    latestArtifact,
    findingId,
    prepass,
    modules,
    provider,
    cutOff,
    stopped,
  }
}

// Fleet: the steps one thread shows. `null` is the main chat (the
// coordinator). A child id is that child's thread. A message step shows in
// both the sender's and the receiver's thread, under the same key, so a pill
// can jump from one thread to the same message in the other.
export function threadSteps(steps: Step[], agentId: string | null): Step[] {
  const me = agentId ?? COORDINATOR
  return steps.filter((s) =>
    s.kind === "message"
      ? s.from === me || s.to === me
      : // A failed child's row (Retry / Reassign) belongs to the main chat,
        // even though the engine tags the event with the child's id.
        s.kind === "agent-error"
        ? agentId == null
        : agentId == null
          ? !s.agent
          : s.agent === agentId,
  )
}

// ---------------------------------------------------------------------------
// Run store. One entry per run, kept for the life of the page.
//
// The first time a run is needed we load its full event list in one request
// and reduce it once, so opening a run never replays it step by step. A run
// that is still live then follows its SSE stream in the background (from the
// first event the snapshot did not hold), even while another run is on screen.
// Incoming events are batched, so a burst of deltas costs one render.

interface RunEntry {
  events: RunEvent[]
  // Null until the snapshot has loaded. Never a guessed "starting" state.
  state: RunState | null
  listeners: Set<() => void>
  loading: boolean
  // The open stream, if any. `gen` counts loads: a stream only writes while
  // its load is the latest.
  stop?: () => void
  // Only setRetry touches this. Invariant: at most one pending retry timer and
  // at most one in-flight snapshot fetch per run id. (reloadRun may leave an
  // older fetch running, but `gen` drops its result, so it schedules nothing.)
  retry?: ReturnType<typeof setTimeout>
  // Reloads in a row without a stream that stayed open 5 s. Sets the backoff.
  failures: number
  gen: number
}

const entries = new Map<string, RunEntry>()
const allListeners = new Set<() => void>()
const settleListeners = new Set<(id: string) => void>()

// Status and headline of every loaded run, for the sidebar, plus what the
// Modules and Scopes pages count: the scope the run attacked, how many
// findings it proved, its pipeline plan and the tools its prepass ran.
// Replaced (never mutated) on each change so useSyncExternalStore sees a new
// snapshot.
export type RunBrief = {
  status: RunStatus
  pending: PendingApproval | null
  archived: boolean
  scope: TargetScope | null
  proven: number
  modules: ModulePlanEntry[] | null
  tools: PrepassTool[] | null
}
let briefs: Record<string, RunBrief> = {}

function briefOf(s: RunState): RunBrief {
  return {
    status: s.status,
    pending: s.pending,
    archived: s.archived,
    scope: s.scope,
    proven: s.findings.filter((f) => f.proven && !f.dismissed).length,
    modules: s.modules,
    tools: s.prepass?.tools ?? null,
  }
}

// The reducer rebuilds every object on each commit, so compare by content.
// The plan and the tools list are small; JSON is enough.
function sameBrief(a: RunBrief | undefined, b: RunBrief): boolean {
  return (
    !!a &&
    a.status === b.status &&
    a.pending === b.pending &&
    a.archived === b.archived &&
    a.scope?.id === b.scope?.id &&
    a.proven === b.proven &&
    JSON.stringify(a.modules) === JSON.stringify(b.modules) &&
    JSON.stringify(a.tools) === JSON.stringify(b.tools)
  )
}

function entryFor(id: string): RunEntry {
  let en = entries.get(id)
  if (!en) {
    en = { events: [], state: null, listeners: new Set(), loading: false, failures: 0, gen: 0 }
    entries.set(id, en)
  }
  return en
}

function commit(id: string, en: RunEntry, events: RunEvent[]) {
  const before = en.state
  en.events = events
  en.state = reduceEvents(events)
  const s = en.state
  const brief = briefOf(s)
  if (!sameBrief(briefs[id], brief)) {
    briefs = { ...briefs, [id]: brief }
    for (const l of allListeners) l()
  }
  // A run that settles while we watch it (not one that loaded settled).
  // A follow-up ending counts too: it may have spent and proven more.
  if (before && ((!isTerminal(before.status) && isTerminal(s.status)) || (before.replying && !s.replying))) {
    for (const l of settleListeners) l(id)
  }
  for (const l of en.listeners) l()
}

function follow(id: string, en: RunEntry) {
  const gen = en.gen
  const opened = Date.now()
  let queue: RunEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    if (!queue.length || en.gen !== gen) return
    const batch = queue
    queue = []
    commit(id, en, [...en.events, ...batch])
  }
  en.stop = streamRun(
    id,
    (e) => {
      queue.push(e)
      timer ??= setTimeout(flush, 32)
    },
    en.events.length,
    () => {
      if (en.gen !== gen) return
      flush()
      // The server owns the event list. Reload it instead of replaying an old
      // since= URL. A stream that keeps failing waits on the backoff.
      if (!en.state?.closed) {
        en.loading = false
        // The server sends `status` on every subscribe, so one message proves
        // nothing. Only a stream that stayed open 5 s resets the backoff.
        if (Date.now() - opened >= 5000) en.failures = 0
        retryLoad(id, en)
      }
    },
  )
}

// Load again after a dropped stream or a failed fetch. The first reload after a
// healthy stream is at once; then 1 s, 2 s, 4 s, and 5 s each time after that.
function retryLoad(id: string, en: RunEntry) {
  const delay = en.failures ? Math.min(1000 * 2 ** (en.failures - 1), 5000) : 0
  en.failures = Math.min(en.failures + 1, 4)
  setRetry(id, en, delay)
}

// The one place that sets or clears the retry timer. It always clears the old
// timer first, so a run never has two retry chains. `null` only clears.
function setRetry(id: string, en: RunEntry, delay: number | null) {
  clearTimeout(en.retry)
  en.retry =
    delay === null
      ? undefined
      : setTimeout(() => {
          en.retry = undefined
          loadRun(id)
        }, delay)
}

// Load a run into the store if it is not there yet. Safe to call often.
export function loadRun(id: string) {
  const en = entryFor(id)
  if (en.loading) return
  en.loading = true
  // This fetch replaces any pending retry.
  setRetry(id, en, null)
  const gen = ++en.gen
  fetchRun(id)
    .then((view) => {
      if (en.gen !== gen) return
      // The snapshot replaces the events. A stream still open from an earlier
      // load would add its events again on top, so stop it first.
      en.stop?.()
      en.stop = undefined
      commit(id, en, view.events ?? [])
      if (!en.state?.closed) follow(id, en)
    })
    .catch((err) => {
      if (en.gen !== gen) return
      en.loading = false
      // A 4xx will not change on retry (deleted, forbidden). A 5xx or a network
      // error is the server restarting, so it keeps retrying at most every 5 s.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) return
      retryLoad(id, en)
    })
}

// Fetch a run again and follow it if it is open. Use after a message reopens
// an idle run, or after it is archived: an idle run keeps no stream, so the
// new events are only in a fresh snapshot.
export function reloadRun(id: string) {
  const en = entryFor(id)
  en.gen++
  en.stop?.()
  en.stop = undefined
  en.failures = 0
  en.loading = false
  loadRun(id)
}

// The reduced state of one run. Null only until its snapshot first loads.
export function getRunState(id: string): RunState | null {
  return entries.get(id)?.state ?? null
}

export function useRun(runId: string | null): RunState | null {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!runId) return () => {}
      const en = entryFor(runId)
      en.listeners.add(cb)
      loadRun(runId)
      return () => {
        en.listeners.delete(cb)
      }
    },
    [runId],
  )
  const get = useCallback(() => (runId ? (entries.get(runId)?.state ?? null) : null), [runId])
  return useSyncExternalStore(subscribe, get)
}

// Status and headline of every loaded run, keyed by run id.
export function useRunBriefs(): Record<string, RunBrief> {
  return useSyncExternalStore(
    (cb) => {
      allListeners.add(cb)
      return () => {
        allListeners.delete(cb)
      }
    },
    () => briefs,
  )
}

// Call `cb(id)` when a run settles while the page watches it.
export function onRunSettled(cb: (id: string) => void): () => void {
  settleListeners.add(cb)
  return () => {
    settleListeners.delete(cb)
  }
}

// The header's Running word. A follow-up reply keeps the run's terminal status,
// so `replying` counts as running while its stream is open. Before the run
// loads, the sidebar's status decides.
export function isRunningNow(state: RunState | null, status: RunStatus): boolean {
  return state ? !state.closed && (!isTerminal(state.status) || state.replying) : status === "running"
}
