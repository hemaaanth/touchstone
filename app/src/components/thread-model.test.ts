// buildMessages: the agent's closing words when it proved nothing.
// Runs with `bun test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceEvents } from "../lib/runModel"
import type { RunEvent } from "../lib/types"
import { buildMessages, runHeadStatus, runStartView as startView, sentence } from "./thread-model"

const runStartView = (...args: Parameters<typeof startView>) => {
  const view = startView(...args)
  assert.ok(view)
  return view
}

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

test("sentence gives a server fragment a capital and an end mark", () => {
  assert.equal(sentence("no such run"), "No such run.")
  assert.equal(sentence("  spend cap reached!  "), "Spend cap reached!")
  assert.equal(sentence("Already fine."), "Already fine.")
  assert.equal(sentence("   "), "")
})

test("the top bar dot: one word and one tone per run state", () => {
  const head = (events: RunEvent[]) => {
    const state = reduceEvents(events)
    return runHeadStatus(state, state.status)
  }
  assert.deepEqual(runHeadStatus(null, "running"), { word: "Running", tone: "working" })
  assert.deepEqual(runHeadStatus(null, "recorded"), { word: "Proven", tone: "proven" })
  assert.deepEqual(runHeadStatus(null, "error"), { word: "Failed", tone: "failed" })
  assert.deepEqual(runHeadStatus(null, "denied"), { word: "Denied", tone: "failed" })
  assert.deepEqual(runHeadStatus(null, "no-finding"), { word: "No finding", tone: "neutral" })
  // A stop is newer than the error it caused, so it reads as stopped, not failed.
  const stopped = reduceEvents([{ ev: "stopped" }, { ev: "status", status: "error" }, { ev: "closed" }])
  assert.equal(stopped.stopped, true)
  assert.deepEqual(runHeadStatus(stopped, "error"), { word: "Stopped", tone: "neutral" })
  assert.equal(head([{ ev: "status", status: "no-finding" }, { ev: "closed" }]).word, "No finding")
})

test("the run start card: rows only grow, and the agent session closes it", () => {
  const scan: RunEvent[] = [{ ev: "web-scan-started", engines: ["zap", "nuclei"] }]
  const live = runStartView(scan, null, true)
  assert.equal(live.mark, "running")
  assert.equal(live.active, true)
  assert.deepEqual(live.rows.map((r) => r.mark), ["running"])

  const summary: RunEvent = {
    ev: "prepass",
    total: 7,
    tools: [
      { name: "zap", status: "ran" },
      { name: "nuclei", status: "unavailable" },
    ],
  }
  const waiting = runStartView([...scan, summary], null, true)
  assert.equal(waiting.meta, "2 tools (1 ran) · 7 leads")
  assert.deepEqual(waiting.rows.map((r) => r.key), ["scan", "session"])
  assert.equal(waiting.rows[1].mark, "running")

  // The same events, replayed from the record after the session opened.
  const done = runStartView([...scan, summary, { ev: "opened" }], null, false)
  assert.deepEqual(done.rows.map((r) => r.key), ["scan", "session"])
  assert.deepEqual(done.rows.map((r) => r.mark), ["done", "done"])
  assert.equal(done.mark, "done")
  assert.equal(done.active, false)
  assert.equal(done.openFirst, false)
  assert.equal(done.meta, waiting.meta)
})

test("a run that stopped before the agent started shows where it stopped", () => {
  const view = runStartView([{ ev: "web-scan-started", engines: ["zap"] }], null, false)
  assert.deepEqual(view.rows.map((r) => [r.mark, r.word]), [["off", "Stopped"]])
  // The row names the stage. It no longer says the scan is running.
  assert.equal(view.rows[0].label, "Tool scan")
  assert.equal(view.mark, "off")
  assert.equal(view.word, "Stopped")
  assert.equal(view.openFirst, true)
  // A failed scan is a coverage gap, not a stop: the card says it is incomplete.
  const failed = runStartView([{ ev: "prepass", total: 0, tools: [], failed: true }, { ev: "opened" }], { total: 0, tools: [], leads: [], failed: true }, false)
  assert.equal(failed.mark, "fail")
  assert.equal(failed.word, "Incomplete")
})

test("a run that opened with no setup to report shows no start card", () => {
  assert.equal(startView([{ ev: "opened" }], null, false), null)
})
