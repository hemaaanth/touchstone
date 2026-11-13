// buildMessages: the agent's closing words when it proved nothing.
// Runs with `bun test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceEvents } from "../lib/runModel"
import type { RunEvent } from "../lib/types"
import { buildMessages } from "./thread-model"

const coverage = { kind: "coverage", title: "The scope was not read", hint: "h", detail: "d", message: "m", retryable: false, spentUsd: 0 }
const texts = (events: RunEvent[]) => {
  const state = reduceEvents(events)
  return buildMessages(state, state.steps, state.status, false)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => (p as { type: string }).type === "text")
    .map((p) => (p as { text: string }).text)
}

test("a run that ends as a coverage error still shows the agent's final answer", () => {
  const final: RunEvent = { ev: "no-finding", final: "I found nothing in x/bank." }
  assert.deepEqual(texts([final, { ev: "status", status: "no-finding" }]), ["I found nothing in x/bank."])
  assert.deepEqual(texts([final, { ev: "status", status: "error", errorInfo: coverage }]), ["I found nothing in x/bank."])
  // Another kind of error has no final answer to show.
  assert.deepEqual(texts([final, { ev: "status", status: "error", errorInfo: { ...coverage, kind: "crash" } }]), [])
})
