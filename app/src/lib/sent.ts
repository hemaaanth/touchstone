import type { RunEvent } from "./types"

// A message the operator sent that the agent has not echoed yet. `base` is
// the run's event count when it was sent; only later events can settle it.
// `mode`: still sending, steering the live turn, or starting a follow-up.
// `restore`: if it is lost, put its text back in the composer.
export type Sent = { id: string; text: string; base: number; mode: "sending" | "steer" | "follow-up"; restore?: boolean }

export const LOST = "The agent stopped before it read your message."

// What happened to each sent message, if anything yet: "echoed", or an error.
// A steer is lost if the run closes without its echo. A follow-up is lost if
// its reply starts and closes without one. The reply-start check skips the
// close of the turn before it: a message sent as that turn ended becomes a
// follow-up. A message still sending is only settled by its echo.
export function settleSent(sent: Sent[], events: RunEvent[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const x of sent) {
    let open = x.mode === "steer"
    for (let i = x.base; i < events.length; i++) {
      const e = events[i]
      if (e.id === x.id && e.ev === "operator-message") {
        out.set(x.id, "echoed")
        break
      }
      if (e.id === x.id && e.ev === "steer-error") {
        out.set(x.id, typeof e.error === "string" && e.error ? e.error : LOST)
        break
      }
      if (x.mode === "sending") continue
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
