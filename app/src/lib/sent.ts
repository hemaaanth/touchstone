import type { RunEvent } from "./types"
import type { Step } from "./runModel"

// A message the operator sent that the agent has not echoed yet. `base` is
// the run's event count when it was sent; only a close after it can lose it.
// `mode`: still sending, steering the live turn, or starting a follow-up.
// `restore`: if it is lost, put its text back in the composer.
export type Sent = { id: string; text: string; base: number; mode: "sending" | "steer" | "follow-up"; restore?: boolean }

export const LOST = "The agent stopped before it read your message."

// What happened to each sent message, if anything yet: "echoed", or an error.
// A steer is lost if the run closes without its echo. A follow-up is lost if
// its reply starts and closes without one. The reply-start check skips the
// close of the turn before it: a message sent as that turn ended becomes a
// follow-up. A message still sending is only settled by its echo.
//
// The echo and the steer error match by id at any index, not only after
// `base`. The id is new for each send, so a match is always this message. And
// `base` is a count of the events this client holds: the live stream adds a
// `status` (and, for an idle run, a `closed`) that the server never stores,
// so after a follow-up
// reloads the server's events, the echo can sit before `base`. Before this,
// that copy never settled: it stayed at the bottom of the thread as a second
// copy of the message, under the reply to it.
export function settleSent(sent: Sent[], events: RunEvent[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const x of sent) {
    const own = events.find((e) => e.id === x.id && (e.ev === "operator-message" || e.ev === "steer-error"))
    if (own) {
      out.set(x.id, own.ev === "operator-message" ? "echoed" : typeof own.error === "string" && own.error ? own.error : LOST)
      continue
    }
    if (x.mode === "sending") continue
    let open = x.mode === "steer"
    for (let i = x.base; i < events.length; i++) {
      const e = events[i]
      if (e.ev === "reply-start") open = true
      if (e.ev === "closed" && open) {
        out.set(x.id, LOST)
        break
      }
    }
  }
  return out
}

export function messageId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// The message a reply answers: the operator's message by its send id, or a
// message to an agent by its step key. The reply block takes this id, so the
// "Thinking…" row shown while the agent works is the same row that grows into
// its answer.
export function turnId(step: Step, owner: string | null): string | null {
  if (step.kind === "operator" && owner == null) return step.subId ?? step.key
  if (step.kind === "message" && owner != null && step.to === owner) return step.key
  return null
}

// What the agent owes an answer to right now, if anything. The thread shows a
// "Thinking…" row there until the answer starts. `owner` is null for the main
// chat, else a child id. `copies` are the local copies not echoed yet.
// - A follow-up copy, or a copy still sending to an idle run, starts a turn:
//   the row goes under that copy. A steer copy waits behind a live step, so
//   it gets no row of its own.
// - Else, on a live thread, the last step is a message the agent has not
//   answered yet: the row goes under it.
// - Else, a live child with no steps yet is starting: the row stands alone.
// `after` says where the row goes: after the steps, or after the copies.
export type Awaiting = { id: string; after: "steps" | "copies" }

export function awaitingReply(
  steps: Step[],
  live: boolean,
  owner: string | null,
  copies: Sent[] = [],
): Awaiting | null {
  const copy = copies[copies.length - 1]
  if (copy && (copy.mode === "follow-up" || (copy.mode === "sending" && !live))) return { id: copy.id, after: "copies" }
  if (!live) return null
  const last = steps[steps.length - 1]
  if (!last) return owner == null ? null : { id: "start", after: "steps" }
  const id = turnId(last, owner)
  return id ? { id, after: "steps" } : null
}
