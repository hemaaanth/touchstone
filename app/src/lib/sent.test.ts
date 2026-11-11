// settleSent: when a message the operator sent shows as the agent's own echo,
// and when it counts as lost. Runs with `bun test src/lib`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { LOST, settleSent, type Sent } from "./sent"
import type { RunEvent } from "./types"

const ev = (ev: string, extra: Record<string, unknown> = {}): RunEvent => ({ ev, ...extra })
const one = (x: Sent, events: RunEvent[]) => settleSent([x], events).get(x.id)

test("the echo with the same id settles a message", () => {
  const x: Sent = { id: "a", text: "hi", base: 1, mode: "steer" }
  assert.equal(one(x, [ev("say"), ev("operator-message", { id: "a", text: "hi" })]), "echoed")
})

test("an echo before the send returns still settles it", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "sending" }
  assert.equal(one(x, [ev("operator-message", { id: "a", text: "hi" })]), "echoed")
})

test("an echo with another id, or one before the send, does not", () => {
  const x: Sent = { id: "a", text: "hi", base: 1, mode: "steer" }
  assert.equal(one(x, [ev("operator-message", { id: "a" }), ev("operator-message", { id: "b", text: "hi" })]), undefined)
})

test("a steer error gives its message back", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "steer" }
  assert.equal(one(x, [ev("steer-error", { id: "a", error: "busy" })]), "busy")
})

test("a steer is lost if the run closes without its echo", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "steer" }
  assert.equal(one(x, [ev("say"), ev("closed")]), LOST)
})

test("a message still sending is never lost to a close", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "sending" }
  assert.equal(one(x, [ev("closed")]), undefined)
})

test("a follow-up skips the close of the turn before it", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "follow-up" }
  assert.equal(one(x, [ev("closed"), ev("reply-start")]), undefined)
  assert.equal(one(x, [ev("closed"), ev("reply-start"), ev("operator-message", { id: "a" }), ev("closed")]), "echoed")
})

test("a follow-up is lost if its reply closes without the echo", () => {
  const x: Sent = { id: "a", text: "hi", base: 0, mode: "follow-up" }
  assert.equal(one(x, [ev("reply-start"), ev("closed")]), LOST)
})
