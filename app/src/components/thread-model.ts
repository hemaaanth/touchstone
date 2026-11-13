import { createContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { ArtifactDoc, ArtifactVersion, PendingApproval, ProofKind, RunStatus } from "@/lib/types"
import type { RunState, Step } from "@/lib/runModel"
import { isTerminal } from "@/lib/format"
import { agentName } from "@/components/fleet-view"
import { turnId } from "@/lib/sent"

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
      const { card, proofKind, proofArtifactId } = cardFor(state, step.finding, status)
      ;(buf.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: step.key,
        toolName: "proof",
        args: { pending: step.finding, card, proofKind, proofArtifactId, fleetFinding: fleet },
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

  // Closing prose (the agent's words when nothing could be proven). A run that
  // did not read its whole scope ends as a coverage error, but its words stay.
  const closing = status === "no-finding" || (status === "error" && state.errorInfo?.kind === "coverage")
  if (owner == null && closing && state.finalText) {
    if (!buf) buf = open("final")
    ;(buf.parts as unknown[]).push({ type: "text", text: state.finalText })
  }

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
