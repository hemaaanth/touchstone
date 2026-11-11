import { createContext } from "react"
import type { ThreadMessageLike } from "@assistant-ui/react"
import type { ArtifactDoc, ArtifactVersion, PendingApproval, ProofKind, RunStatus } from "@/lib/types"
import type { RunState, Step } from "@/lib/runModel"
import { isTerminal } from "@/lib/format"
import { agentName } from "@/components/fleet-view"

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
// id keeps rows and scroll stable as the stream grows. `tail` marks the single
// cognition block being written right now so only it reveals word by word.
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
  const eyebrow = (owner ? agentName(state, owner) : "Coordinator").toUpperCase()
  const open = (key: string) => {
    const b: { id: string; parts: ThreadMessageLike["content"] } = { id: key, parts: [] }
    if (fleet)
      (b.parts as unknown[]).push({
        type: "tool-call",
        toolCallId: `eyebrow:${key}`,
        toolName: "eyebrow",
        args: { eyebrow },
        result: "done",
      })
    return b
  }

  steps.forEach((step, i) => {
    if (step.kind !== "subagent" || !fleet) flushSpawn()
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
    ;(buf.parts as unknown[]).push({
      type: "tool-call",
      toolCallId: step.key,
      toolName: step.kind,
      args: { step, tail: i === tailIndex },
      result: step.state ?? "done",
    })
  })
  flushSpawn()
  flushGroup()

  // Closing prose (the agent's words when nothing could be proven).
  if (owner == null && status === "no-finding" && state.finalText) {
    if (!buf) buf = open("final")
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
