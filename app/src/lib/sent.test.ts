// settleSent: when a message the operator sent shows as the agent's own echo,
// and when it counts as lost. Runs with `bun test src/lib`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { awaitingReply, LOST, settleSent, type Sent } from "./sent"
import type { Step } from "./runModel"
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

// awaitingReply: when the thread shows the waiting row, and where.
const op = (key: string, subId?: string): Step => ({ key, kind: "operator", phase: "run", label: "hi", subId })
const say = (key: string): Step => ({ key, kind: "say", phase: "run", label: "ok" })
const msg = (key: string, to: string): Step => ({ key, kind: "message", phase: "run", label: "go", from: "coordinator", to })

test("a live agent that has not answered the operator yet is waited on", () => {
  assert.deepEqual(awaitingReply([say("1"), op("2", "m1")], true, null), { id: "m1", after: "steps" })
  assert.deepEqual(awaitingReply([op("2")], true, null), { id: "2", after: "steps" })
})

test("no row once the answer starts, or when the run is not live", () => {
  assert.equal(awaitingReply([op("2", "m1"), say("3")], true, null), null)
  assert.equal(awaitingReply([op("2", "m1")], false, null), null)
  assert.equal(awaitingReply([], true, null), null)
})

test("a follow-up copy is waited on under the copy, live or not", () => {
  const x: Sent = { id: "m2", text: "hi", base: 0, mode: "follow-up" }
  assert.deepEqual(awaitingReply([say("1")], false, null, [x]), { id: "m2", after: "copies" })
  assert.deepEqual(awaitingReply([say("1")], true, null, [x]), { id: "m2", after: "copies" })
})

test("a copy still sending is waited on only on an idle run", () => {
  const x: Sent = { id: "m2", text: "hi", base: 0, mode: "sending" }
  assert.deepEqual(awaitingReply([say("1")], false, null, [x]), { id: "m2", after: "copies" })
  assert.equal(awaitingReply([say("1")], true, null, [x]), null)
})

test("a queued steer gets no row of its own", () => {
  const x: Sent = { id: "m2", text: "hi", base: 0, mode: "steer" }
  assert.equal(awaitingReply([say("1")], true, null, [x]), null)
  // An earlier message the agent read is still waited on, above the copy.
  assert.deepEqual(awaitingReply([op("1", "m1")], true, null, [x]), { id: "m1", after: "steps" })
})

test("a child is waited on after a message to it, or before its first step", () => {
  assert.deepEqual(awaitingReply([msg("5", "c1")], true, "c1"), { id: "5", after: "steps" })
  assert.equal(awaitingReply([msg("5", "coordinator")], true, "c1"), null)
  assert.deepEqual(awaitingReply([], true, "c1"), { id: "start", after: "steps" })
  assert.equal(awaitingReply([], false, "c1"), null)
})
