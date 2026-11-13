import { createContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { AgentNode, ArtifactDoc, ArtifactVersion, PendingApproval, PrepassView, ProofKind, RunEvent, RunStatus } from "@/lib/types"
import { isRunningNow, type RunState, type Step } from "@/lib/runModel"
import { startProgress } from "@/lib/startup"
import type { Mark } from "@/components/assistant-ui/elements/surfaces"
import { isTerminal, statusLabel, statusTone, type Tone } from "@/lib/format"
import { AGENT_WORD, agentName, dotClass } from "@/components/fleet-view"
import { awaitingReply, turnId, type Sent } from "@/lib/sent"

// The data side of the run thread: steps in, assistant-ui messages out. The
// renderers in run-thread.tsx read the parts this builds.

// How a transcript chip — or the proof card — opens its document in the pane
// beside the chat. A file can have several versions, so the callback takes the
// file id plus an optional version to land on (a chip opens its own version; the
// proof card just opens the file). buildMessages packs the ids into the part's
// args, but the setter lives in RunChat and a tool-call part's args must stay
// serialisable, so the callback flows down as context instead. Default is a
// no-op (nothing to open).
export const OpenArtifact = createContext<(fileId: string, versionId?: string) => void>(() => {})

// The step key of the card the view just jumped to, so that card shows the
// focus ring for a moment. Null when nothing is marked.
export const MarkedStep = createContext<string | null>(null)

// On a phone, a finding a child agent submitted: the spawn row of that child
// says so and opens its thread on a tap. Null when there is nothing to say.
export const FindingNote = createContext<{ agent: string; name: string; open: () => void } | null>(null)

export type CardState = "waiting" | "replaying" | "proven" | "unproven" | "dropped"

// The proof kind of a submitted finding: what the scope's proof surface says,
// else Foundry (older records have no surface).
export function proofKindOf(state: RunState): ProofKind {
  const surface = state.scope?.proofSurface?.kind
  return surface === "http" || surface === "evidence" ? surface : "forge"
}

// Fold the reduced step stream into assistant-ui messages. Operator steps are
// the user's bubbles; each contiguous run of agent steps is one assistant
// message whose parts carry the Step for our renderers — reasoning/prose/subagent
// handoffs and tool cards alike. The agent's closing prose and the live proof
// card trail the final assistant message. Keying each message by its first step
// id keeps rows and scroll stable as the stream grows. A block that answers a
// message is keyed by that message instead (`reply:<id>`), the same key the
// waiting row uses, so the waiting row grows into the answer in place. `tail`
// marks the single cognition block being written right now so only it reveals
// word by word.
//
// Fleet runs (`fleet`) add four things. Each assistant block starts with an
// eyebrow naming its author. A message between agents is its own card. A run of
// spawns folds into one row. A submitted finding is a compact row. `owner` is
// whose thread this is: null for the main chat, else a child id.
export function buildMessages(
  state: RunState | null,
  steps: Step[],
  status: RunStatus,
  live: boolean,
  fleet = false,
  owner: string | null = null,
  // Each module's proof kind (PackChoice.proof), for a card whose recorded
  // finding has not arrived yet.
  packProof: Record<string, string> = {},
): ThreadMessageLike[] {
  if (!state) return []
  const msgs: ThreadMessageLike[] = []
  let buf: { id: string; parts: ThreadMessageLike["content"] } | null = null

  // The live tail is the block still streaming: the run's last step, when that
  // step is reasoning or prose. Once a tool step follows, the block is done, so
  // "Thinking…" never shimmers above a tool that is already running.
  const lastIndex = steps.length - 1
  const lastKind = steps[lastIndex]?.kind
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

  // Fleet: consecutive spawns become one row.
  let spawn: Step[] = []
  const flushSpawn = () => {
    if (buf && spawn.length) {
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: `spawn:${spawn[0].key}`,
        toolName: "spawn",
        args: { spawn },
        result: "done",
      })
    }
    spawn = []
  }
  // The message the next block answers, if any. A child's first block answers
  // its start, like the waiting row on a child that has no steps yet.
  let answers: string | null = owner == null ? null : "start"
  const open = (key: string) => {
    const id = answers ? `reply:${answers}` : key
    answers = null
    const b: { id: string; parts: ThreadMessageLike["content"] } = { id, parts: [] }
    if (fleet) (b.parts as unknown[]).push(eyebrowPart(state, id, owner))
    return b
  }

  steps.forEach((step, i) => {
    if (step.kind !== "subagent" || !fleet) flushSpawn()
    if (step.kind === "operator") {
      flushGroup()
      flush()
      msgs.push({ role: "user", id: step.key, content: [{ type: "text", text: step.label }] })
      answers = turnId(step, owner)
      return
    }
    // The decide pass already shows up as the single proof card below, which
    // carries its own replaying → proven state. Its bookkeeping rows ("Recording
    // the finding", the approved "Finding recorded") stacked above that card and
    // read as duplicates out of order — drop them. A denial has no green card to
    // carry it, so its one red "Finding denied" row stays.
    if (step.phase === "decide" && step.kind === "note") return
    if (step.kind === "decided" && step.state === "pass") return

    // Fleet: a message between agents stands on its own, outside any block.
    if (fleet && step.kind === "message") {
      flushGroup()
      flush()
      msgs.push({
        role: "assistant",
        id: step.key,
        content: [
          { type: "tool-call", toolCallId: step.key, toolName: "message", args: { step }, result: "done" },
        ] as unknown as ThreadMessageLike["content"],
      })
      answers = turnId(step, owner) ?? answers
      return
    }
    if (!buf) buf = open(step.key)
    if (fleet && step.kind === "subagent") {
      flushGroup()
      spawn.push(step)
      return
    }
    if (GROUPED.has(step.kind)) {
      group.push(step)
      return
    }
    // A cognition/outcome step ends the current group and renders on its own.
    flushGroup()
    // A submitted finding renders its card right where the agent submitted it,
    // so a run with several findings reads in the order they landed.
    if (step.kind === "submitted" && step.finding) {
      const { card, proofKind, proofArtifactId } = cardFor(state, step.finding, status, packProof)
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "proof",
        args: { pending: step.finding, card, proofKind, proofArtifactId, fleetFinding: fleet, stepKey: step.key },
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
    // A block's first reasoning takes the waiting row's key, so that row
    // becomes it without a remount.
    const lead = step.kind === "reasoning" && buf.parts.length === (fleet ? 1 : 0)
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: lead ? `lead:${buf.id}` : step.key,
      toolName: step.kind,
      args: { step, tail: i === tailIndex },
      result: step.state ?? "done",
    })
  })
  flushSpawn()
  flushGroup()

  flush()
  return msgs
}

// Fleet: the eyebrow that opens a block, naming its author.
function eyebrowPart(state: RunState, id: string, owner: string | null) {
  const eyebrow = (owner ? agentName(state, owner) : "Coordinator").toUpperCase()
  return { type: "tool-call", toolCallId: `eyebrow:${id}`, toolName: "eyebrow", args: { eyebrow }, result: "done" }
}

// The row shown while the agent works on a message and has not answered yet.
// It has the key of the block that will hold the answer, and its one part has
// the key of that block's first reasoning. So when the answer starts, React
// updates this row in place. Reasoning keeps it exactly. Prose or a tool card
// replaces it in the same spot, and the block only grows from there.
export function waitingMessage(
  state: RunState,
  answers: string,
  fleet: boolean,
  owner: string | null,
): ThreadMessageLike {
  const id = `reply:${answers}`
  const parts: unknown[] = fleet ? [eyebrowPart(state, id, owner)] : []
  parts.push({ type: "tool-call", toolCallId: `lead:${id}`, toolName: "reasoning", args: { waiting: true }, result: "done" })
  return { role: "assistant", id, content: parts as ThreadMessageLike["content"] }
}

// Match a submitted finding to its recorded one and its replay-proof document.
// New runs match by test contract name. An old run recorded one finding with no
// contract name, so its one submission maps to the run's one finding.
export function cardFor(
  state: RunState,
  sub: PendingApproval,
  status: RunStatus,
  packProof: Record<string, string> = {},
): { card: CardState; proofKind: ProofKind; proofArtifactId: string | null } {
  const legacy = state.findings.length > 0 && state.findings.every((f) => !f.poc)
  const rec = recordFor(state, sub, status)
  // The finding's own proof kind: from its record, else from the module it came
  // through; the run's scope only when neither is known. In a joined run a web
  // finding is an HTTP replay even when the scope is a Contracts one.
  // The module: the recorded finding's, else the submitted card's.
  const known = (pack: string | null | undefined): ProofKind | undefined => {
    const k = pack ? packProof[pack] : undefined
    return k === "forge" || k === "http" || k === "evidence" ? k : undefined
  }
  const proofKind: ProofKind = rec?.proofKind ?? known(rec?.pack) ?? known(sub.pack) ?? proofKindOf(state)
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

// The recorded finding a submitted card stands for: by its PoC, or, in an old
// record whose findings carry no PoC, the one finding of a one-card run.
function recordFor(state: RunState, sub: PendingApproval, status: RunStatus) {
  const legacy = state.findings.length > 0 && state.findings.every((f) => !f.poc)
  return legacy
    ? state.submitted.length === 1 && status === "recorded"
      ? state.findings[0]
      : undefined
    : state.findings.find((f) => f.poc === sub.poc)
}

// "Open this finding" (the Findings page's Open in run): where a finding of
// this run sits. `key` is the step that holds its card, `agent` the child whose
// thread holds that card (null: the main chat), `proofId` its replay proof when
// a replay proved it. Null for an id this run does not have, so an unknown id
// or another run's finding does nothing. While the stream loads, the card may
// not be there yet: then `key` is null and the caller waits.
export function findingTarget(
  state: RunState,
  status: RunStatus,
  findingId: string,
): FindingTarget | null {
  const rec = state.findings.find((f) => f.id === findingId)
  if (!rec) return null
  const step = state.steps.find((s) => s.kind === "submitted" && s.finding && recordFor(state, s.finding, status)?.id === rec.id)
  const proofId = step?.finding ? cardFor(state, step.finding, status).proofArtifactId : null
  const agent = step?.agent ?? null
  // A child's card is in its own thread. In the main chat that child is its
  // spawn row: the place a phone lands on.
  const spawn = agent ? (state.steps.find((s) => s.kind === "subagent" && s.subId === agent && !s.agent)?.key ?? null) : null
  return { key: step?.key ?? null, agent, proofId, spawn }
}
export type FindingTarget = { key: string | null; agent: string | null; proofId: string | null; spawn: string | null }

// What one "open this finding" request still has to do, given where the finding
// sits now and what the request already did. The jump to the card and the
// drawer are separate: the card can land before its proof does (the server
// announces a finding before its proof document), and the proof then opens
// once, with no second jump. On a phone the drawer never opens by itself.
export type FocusDone = { jumped: boolean; opened: boolean }
export function focusActions(
  target: FindingTarget | null,
  done: FocusDone,
  narrow: boolean,
): {
  jump: string | null
  proof: string | null
  peek: { agent: string; key: string } | null
  // On a phone, a child's finding: the note under that child's spawn row.
  note: { agent: string; key: string | null } | null
  // On a phone, fold the Run Info panel so it does not cover the card.
  fold: boolean
  done: FocusDone
} {
  const none = { jump: null, proof: null, peek: null, note: null, fold: false, done }
  if (!target) return none
  // The main chat's card, or on a phone the spawn row of the child that holds it.
  const main = target.agent ? (narrow ? target.spawn : null) : target.key
  const jump = !done.jumped && main ? main : null
  const note = narrow && target.agent ? { agent: target.agent, key: target.key } : null
  let proof: string | null = null
  let peek: { agent: string; key: string } | null = null
  if (!done.opened && !narrow) {
    if (target.proofId) proof = target.proofId
    // A child's unproven finding: its card in that agent's thread, once.
    else if (target.agent && target.key) peek = { agent: target.agent, key: target.key }
  }
  return {
    jump,
    proof,
    peek,
    note,
    fold: narrow && !!jump,
    done: { jumped: done.jumped || !!jump || (!!target.agent && !narrow), opened: done.opened || !!proof || !!peek },
  }
}

// The one line under the composer: a refused send, else a refused rename or
// archive of this run (the server's sentence, with what did not happen as the
// title). Null when there is nothing to say.
export function composerNotice(
  sendError: string | null,
  action: { title: string; text: string } | null,
): { title: string; detail: string } | null {
  if (sendError) return { title: "Message not sent", detail: sentence(sendError) }
  if (action) return { title: action.title, detail: sentence(action.text) }
  return null
}

// One sentence as a card or the composer shows it: a capital first letter and
// an end mark. The server's plain reasons ("no such run", "the server restarted
// during this run, so it stopped") are lower case with no period.
export function sentence(text: string): string {
  const t = text.trim()
  if (!t) return t
  const s = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// The run's state as the top bar's dot shows it. The dot carries the state;
// the word is its tooltip and its accessible name. The tones match the
// sidebar's dots: amber while it works, green once a replay proved it, red when
// it failed or the finding was denied, grey otherwise. A stop is the newest
// fact about a run, so it wins over an older failure.
export type HeadTone = "working" | "proven" | "failed" | "neutral"

export function runHeadStatus(state: RunState | null, status: RunStatus): { word: string; tone: HeadTone } {
  if (isRunningNow(state, status)) return { word: "Running", tone: "working" }
  if (state?.stopped) return { word: "Stopped", tone: "neutral" }
  if (runInterruption(state, status)?.ended) return { word: "Interrupted", tone: "neutral" }
  if (status === "error") return { word: "Failed", tone: "failed" }
  if (status === "denied") return { word: "Denied", tone: "failed" }
  if (status === "recorded") return { word: "Proven", tone: "proven" }
  if (status === "no-finding") return { word: "No finding", tone: "neutral" }
  return { word: "Done", tone: "neutral" }
}

// The run's start as one card at the top of the thread, from the first event
// to the agent's first step. The card is the same card live and replayed: its
// header is one line that only changes its counts and its mark, and its rows
// only grow. Once the agent session opens, a last row says so, so the card
// never goes away. `live` is false once the run stopped or failed.
export interface StartRow {
  key: string
  label: string
  detail?: string
  mark: Mark
  // A word beside an off or stopped row. Done and running rows need none.
  word?: string
}

export interface RunStartView {
  rows: StartRow[]
  // "2 tools (1 ran) · 7 leads", or null before any tool reports.
  meta: string | null
  mark: Mark
  word?: string
  // The header shimmers while the run is still getting ready.
  active: boolean
  // A run that stopped before the agent started opens its card, since the
  // card is all there is to read.
  openFirst: boolean
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// A running stage's words describe work in progress ("Running the tool scan").
// Once the run stopped, the row names the stage instead, beside "Stopped".
const SETTLED: Record<string, string> = {
  scan: "Tool scan",
  strix: "Strix",
  capture: "Domain capture",
  session: "Agent session",
}

export function runStartView(events: RunEvent[], prepass: PrepassView | null, live: boolean): RunStartView | null {
  const p = startProgress(events)
  const opened = events.some((e) => e.ev === "opened")
  // A run that opened with no setup to report (an older record, or a pack with
  // no tool scan) has nothing to show here.
  if (opened && !prepass && p.stages.length === 0) return null
  const rows: StartRow[] = p.stages.map((s) => ({
    key: s.key,
    label: s.state === "running" && !live ? (SETTLED[s.key] ?? s.label) : s.label,
    detail: s.detail,
    // A stage cannot keep running once the run stopped.
    ...(s.state === "running"
      ? live
        ? { mark: "running" as Mark }
        : { mark: "off" as Mark, word: "Stopped" }
      : s.state === "done"
        ? { mark: "done" as Mark }
        : s.state === "failed"
          ? { mark: "fail" as Mark }
          : { mark: "off" as Mark, word: "Unavailable" }),
  }))
  if (opened) rows.push({ key: "session", label: "Agent session started", mark: "done" })

  const meta =
    [
      p.tools ? `${count(p.tools, "tool")}${p.ran < p.tools ? ` (${p.ran} ran)` : ""}` : null,
      p.leads != null ? count(p.leads, "lead") : null,
    ]
      .filter(Boolean)
      .join(" · ") || null

  const running = rows.some((r) => r.mark === "running")
  const stopped = !opened && !live
  const failed = !!prepass?.failed || rows.some((r) => r.mark === "fail")
  const mark: Pick<RunStartView, "mark" | "word"> = running
    ? { mark: "running" }
    : stopped
      ? { mark: "off", word: "Stopped" }
      : failed
        ? { mark: "fail", word: "Incomplete" }
        : { mark: "done" }
  return { rows, meta, ...mark, active: running, openFirst: stopped }
}

// The main thread with the operator's local copies. A copy shows only once the
// server accepted its message, so a refused send never touches the
// transcript: while the send is pending, the composer shows it instead. A copy
// steps aside when its echo lands or it is lost. While the agent owes an
// answer, a waiting row stands where the answer will go.
export function withCopies(
  ms: ThreadMessageLike[],
  state: RunState | null,
  steps: Step[],
  live: boolean,
  fleet: boolean,
  sent: Sent[],
  outcomes: Map<string, string>,
): ThreadMessageLike[] {
  if (!state) return ms
  const out = [...ms]
  const copies = sent.filter((x) => x.mode !== "sending" && !outcomes.has(x.id))
  const wait = awaitingReply(steps, live, null, copies)
  if (wait?.after === "steps") out.push(waitingMessage(state, wait.id, fleet, null))
  for (const x of copies) {
    out.push({
      role: "user",
      id: `sent:${x.id}`,
      content: [{ type: "text", text: x.text }],
      metadata: { custom: { queued: x.mode === "steer" } },
    })
  }
  if (wait?.after === "copies") out.push(waitingMessage(state, wait.id, fleet, null))
  return out
}

// One send, as state changes. The copy enters `sent` as "sending", then takes
// the server's answer: a steer or a follow-up, or it goes on a refusal.
export async function sendCopy(
  copy: Sent,
  steer: () => Promise<{ followUp?: boolean }>,
  update: (f: (xs: Sent[]) => Sent[]) => void,
): Promise<{ ok: true; followUp: boolean } | { ok: false; error: string }> {
  update((xs) => [...xs, copy])
  try {
    const res = await steer()
    const mode = res.followUp ? "follow-up" : "steer"
    update((xs) => xs.map((x) => (x.id === copy.id ? { ...x, mode } : x)))
    return { ok: true, followUp: !!res.followUp }
  } catch (err) {
    update((xs) => xs.filter((x) => x.id !== copy.id))
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// The run's modules (packs), for Run Info. A joined run holds several: the
// `packs` event says which, and the model falls back to the scope's own pack on
// an old record. Nothing here needs to guess.
export function runModules(state: RunState): string[] {
  return state.packs
}

// The server's module list in this run's own order. ModulePills orders the
// pills by the list it gets, so a joined run shows its modules as stored.
export function inRunOrder<T extends { id: string }>(packs: T[] | undefined, ids: readonly string[]): T[] | undefined {
  if (!packs) return packs
  const at = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length)
  return [...packs].sort((a, b) => at(a.id) - at(b.id))
}

// A run row's word and dot tone in the run list. A run a restart cut off reads
// "Interrupted" in neutral ink; every other status keeps its word and tone.
export function runRowStatus(r: { status: RunStatus; errorKind?: string | null }): { word: string; tone: Tone } {
  if (r.status === "error" && r.errorKind === "cutoff") return { word: "Interrupted", tone: "neutral" }
  return { word: statusLabel(r.status), tone: statusTone(r.status) }
}

// The one status mark (RunStatusMark) a run shows, in the sidebar and in the
// run's top bar. One kind per run state; the mark keeps one size in all.
export type RunMarkKind = "starting" | "working" | "replaying" | "paused" | "proven" | "done" | "failed"

// A run in the list: its status, and how an error ended. A restart's cut-off
// reads as paused, not failed.
export function runMarkKind(r: { status: RunStatus; errorKind?: string | null }): RunMarkKind {
  switch (r.status) {
    case "starting":
      return "starting"
    case "running":
      return "working"
    case "awaiting-approval":
    case "deciding":
      return "replaying"
    case "recorded":
      return "proven"
    case "no-finding":
      return "done"
    case "denied":
      return "failed"
    case "error":
      return r.errorKind === "cutoff" ? "paused" : "failed"
    default:
      return "done"
  }
}

// The run's top bar (runHeadStatus): the same marks.
export function headMarkKind(head: { word: string; tone: HeadTone }): RunMarkKind {
  if (head.tone === "working") return "working"
  if (head.tone === "proven") return "proven"
  if (head.tone === "failed") return "failed"
  return head.word === "Stopped" || head.word === "Interrupted" ? "paused" : "done"
}

// How one agent's state reads in a row, a header or a dot. An agent a server
// restart cut off reads "Interrupted" in neutral ink with a ring dot: it is not
// working, it is not done, and it did not fail. Red stays for a real failure.
export function agentLook(
  state: RunState,
  a: AgentNode | undefined,
): { word: string; dot: string; bad: boolean; reason: string | null } {
  const reason = a ? (state.cutOff[a.id] ?? null) : null
  if (a && reason != null) return { word: "Interrupted", dot: "border border-muted-foreground", bad: false, reason }
  const st = a?.state ?? "working"
  return { word: AGENT_WORD[st], dot: dotClass(st), bad: st === "failed", reason: null }
}

// A run that a server restart cut off, from what the server wrote:
// - `ended`: the run itself stopped there. The server ends it as an error of
//   kind "cutoff" (not a model failure).
// - otherwise the run ended on its own terms (a fleet whose proof check
//   recorded its findings), but agents the restart cut off never finished.
// `note` is the one calm line for that case: what happened and what to do.
export function runInterruption(
  state: RunState | null,
  status: RunStatus,
): { ended: boolean; agents: string[]; reason: string; note: string | null } | null {
  if (!state || isRunningNow(state, status) || state.stopped) return null
  const agents = Object.keys(state.cutOff).map((id) => agentName(state, id))
  const ended = status === "error" && state.errorInfo?.kind === "cutoff"
  // A run that ended as another error has its own card; it needs no note.
  if (!ended && !(isTerminal(status) && status !== "error" && agents.length)) return null
  const names = agents.length > 1 ? `${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}` : (agents[0] ?? "")
  const reason = ended
    ? sentence(state.errorInfo?.message ?? "The server restarted during this run")
    : `The server restarted while ${names} ${agents.length > 1 ? "were" : "was"} working.`
  const note = ended
    ? null
    : `${reason} ${agents.length > 1 ? "They were" : "It was"} not started again, so ${agents.length > 1 ? "their" : "its"} part of the scope is not finished. Send a message to continue.`
  return { ended, agents, reason, note }
}

// A run's start time as epoch ms, or undefined. The store keeps numbers; an
// ISO string (or a number in a string) is read too, so a run never sorts or
// groups as "no time" by its type alone.
export function startMs(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : undefined
  if (typeof v !== "string" || !v.trim()) return undefined
  const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export type DateGroup = { label: "Today" | "Yesterday" | "Earlier"; indices: number[] }

// The run list's date headings: newest first, one group per label. A run with
// no time counts as now (it is starting). `times` is indexed like the list.
export function dateGroups(times: readonly unknown[], indices: readonly number[], startOfToday: number): DateGroup[] {
  const yesterday = new Date(startOfToday)
  yesterday.setDate(yesterday.getDate() - 1)
  const startOfYesterday = yesterday.getTime()
  const ms = (i: number) => startMs(times[i])
  const sorted = [...indices].sort((a, b) => (ms(b) ?? Number.MAX_SAFE_INTEGER) - (ms(a) ?? Number.MAX_SAFE_INTEGER))
  const groups: DateGroup[] = []
  for (const index of sorted) {
    const t = ms(index)
    const label = t === undefined || t >= startOfToday ? "Today" : t >= startOfYesterday ? "Yesterday" : "Earlier"
    const last = groups[groups.length - 1]
    if (last?.label === label) last.indices.push(index)
    else groups.push({ label, indices: [index] })
  }
  return groups
}
