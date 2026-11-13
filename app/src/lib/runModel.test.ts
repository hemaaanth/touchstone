// reduceEvents: where streamed text lands when attempt numbers repeat.
// Runs with `bun test src/lib`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceEvents } from "./runModel"
import type { RunEvent } from "./types"

const ev = (ev: string, extra: Record<string, unknown> = {}): RunEvent => ({ ev, ...extra })
const say = (attempt: number, text: string) => ev("assistant-delta", { conv: "root", attempt, text })
const think = (attempt: number, text: string) => ev("thinking-delta", { conv: "root", attempt, text })
const rows = (events: RunEvent[]) => reduceEvents(events).steps.map((s) => `${s.kind}:${s.label}`)

test("a growing snapshot updates its one step in place", () => {
  assert.deepEqual(rows([say(0, "Hel"), say(0, "Hello")]), ["say:Hello"])
})

// An older engine started each follow-up at attempt 0 again. The reply used to
// overwrite the first answer at the top, so it showed above the message.
test("a follow-up that reuses an attempt number gets its own step under the message", () => {
  const events = [
    say(0, "First answer"),
    ev("closed"),
    ev("reply-start"),
    ev("operator-message", { id: "m1", text: "and the vault?" }),
    think(0, "Look at the vault"),
    say(0, "The vault is safe"),
  ]
  assert.deepEqual(rows(events), [
    "say:First answer",
    "operator:and the vault?",
    "reasoning:Look at the vault",
    "say:The vault is safe",
  ])
  const keys = reduceEvents(events).steps.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
})

test("an audit-continue pass that starts attempts again gets new steps", () => {
  const out = rows([say(1, "Pass one"), ev("audit-continue", { found: 1 }), say(1, "Pass two")])
  assert.deepEqual(out, ["say:Pass one", "note:Asked the agent to keep auditing (1 found so far)", "say:Pass two"])
})

// A last tick of the old answer can land just after the boundary. It still
// starts with the old text, so it finishes that step instead of copying it.
test("a late tick of the old answer finishes it in place", () => {
  const out = rows([say(2, "Done wit"), ev("operator-message", { text: "next" }), say(2, "Done with it")])
  assert.deepEqual(out, ["say:Done with it", "operator:next"])
})

test("inside one turn a snapshot that changes still updates in place", () => {
  assert.deepEqual(rows([say(0, "draft"), say(0, "final")]), ["say:final"])
})

test("a server restart shows which step started again, and its new steps stay separate", () => {
  const out = rows([say(0, "Before the restart"), ev("phase-restarted", { phase: "agent" }), say(0, "After it")])
  assert.deepEqual(out, ["say:Before the restart", "note:The server restarted, so the agent turn started again", "say:After it"])
  assert.deepEqual(rows([ev("phase-restarted", { phase: "prepass" })]), ["note:The server restarted, so the tool scan started again"])
})

test("a stop request shows before the run stops", () => {
  assert.deepEqual(rows([ev("stop-requested"), ev("stopped")]), ["note:Stopping the run", "note:You stopped the run. Send a message to continue."])
})
