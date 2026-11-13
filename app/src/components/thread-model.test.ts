// buildMessages: the agent's closing words when it proved nothing.
// Runs with `bun test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceEvents } from "../lib/runModel"
import type { RunEvent } from "../lib/types"
import type { Sent } from "../lib/sent"
import { settleSent } from "../lib/sent"
import { buildMessages, runHeadStatus, runStartView as startView, sendCopy, sentence, withCopies } from "./thread-model"

const runStartView = (...args: Parameters<typeof startView>) => {
  const view = startView(...args)
  assert.ok(view)
  return view
}

const coverage = { kind: "coverage", title: "The scope was not read", hint: "h", detail: "d", message: "m", retryable: false, spentUsd: 0 }
// The prose of a thread, in order: text parts and the agent's "say" steps.
type Part = { type: string; text?: string; toolName?: string; args?: { step?: { label: string } } }
const prose = (ms: ReturnType<typeof buildMessages>) =>
  ms
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]) : []))
    .flatMap((p) => (p.type === "text" ? [p.text ?? ""] : p.toolName === "say" ? [p.args?.step?.label ?? ""] : []))
const texts = (events: RunEvent[]) => {
  const state = reduceEvents(events)
  return prose(buildMessages(state, state.steps, state.status, false))
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

// A send as the run chat does it, against a fake server that answers after
// 1000 ms. The transcript is sampled after every state change and every 50 ms
// while the send waits, so "at any time" is checked, not only at the end.
async function delayedSend(events: RunEvent[], live: boolean, answer: "accept" | "refuse") {
  const state = reduceEvents(events)
  let sent: Sent[] = []
  const rows = () => withCopies(buildMessages(state, state.steps, state.status, live), state, state.steps, live, false, sent, settleSent(sent, state.events)).length
  const before = rows()
  const seen: number[] = []
  // The rows seen before the server answered.
  const waiting: number[] = []
  let answered = false
  const look = () => {
    seen.push(rows())
    if (!answered) waiting.push(rows())
  }
  const update = (f: (xs: Sent[]) => Sent[]) => {
    sent = f(sent)
    look()
  }
  const steer = () =>
    new Promise<{ followUp?: boolean }>((ok, no) =>
      setTimeout(() => {
        answered = true
        if (answer === "accept") ok({ followUp: !live })
        else no(new Error("spend cap reached"))
      }, 1000),
    )
  const tick = setInterval(look, 50)
  const copy: Sent = { id: "m1", text: "look at withdraw()", base: state.events.length, mode: "sending", restore: true }
  const res = await sendCopy(copy, steer, update)
  clearInterval(tick)
  return { before, seen, waiting, after: rows(), res, sent }
}

const idleRun: RunEvent[] = [{ ev: "no-finding", final: "Nothing found." }, { ev: "status", status: "no-finding" }, { ev: "closed" }]

test("a refused send never adds a row to the transcript, even when the refusal is slow", async () => {
  for (const live of [false, true]) {
    const events = live ? [{ ev: "status", status: "running" } as RunEvent] : idleRun
    const { before, seen, after, res, sent } = await delayedSend(events, live, "refuse")
    assert.equal(res.ok, false)
    assert.ok(seen.length > 10, "the transcript was sampled while the send waited")
    assert.deepEqual([...new Set(seen)], [before], `live=${live}: no row came and went`)
    assert.equal(after, before)
    assert.deepEqual(sent, [])
  }
})

test("an accepted send adds its message once, with no second jump", async () => {
  // An idle run: the copy and the waiting row for the follow-up's reply.
  const idle = await delayedSend(idleRun, false, "accept")
  assert.deepEqual(idle.res, { ok: true, followUp: true })
  // Before the server answers, nothing changes; then the copy comes, once.
  assert.ok(idle.waiting.length > 10)
  assert.deepEqual([...new Set(idle.waiting)], [idle.before])
  const idleChanges = idle.seen.filter((n, i) => n !== (i === 0 ? idle.before : idle.seen[i - 1]))
  assert.equal(idleChanges.length, 1)
  assert.equal(idle.after, idle.before + 2)
  // A live run: the copy only. The agent's waiting row was already there.
  const live = await delayedSend([{ ev: "status", status: "running" }], true, "accept")
  assert.deepEqual([...new Set(live.waiting)], [live.before])
  const liveChanges = live.seen.filter((n, i) => n !== (i === 0 ? live.before : live.seen[i - 1]))
  assert.equal(liveChanges.length, 1)
  assert.equal(live.after, live.before + 1)
})

// B8 in the thread: the closing words of a run that proved nothing.
const whole = `## Summary\n\n${"No path moves funds out of the vault. ".repeat(180)}**medium — src/utils/about.ts** ends it.`
const cutFinal = whole.slice(0, 4000)
const delta = (text: string): RunEvent => ({ ev: "assistant-delta", conv: "root", attempt: 1, text })

test("the closing words show once, whole, when the stream holds them and the final is cut", () => {
  const out = texts([delta(whole), { ev: "no-finding", final: cutFinal }, { ev: "status", status: "no-finding" }, { ev: "closed" }])
  assert.deepEqual(out, [whole])
})

test("a follow-up after a no-finding end keeps the order: closing words, message, answer", () => {
  const events: RunEvent[] = [
    delta(whole),
    { ev: "no-finding", final: cutFinal },
    { ev: "status", status: "no-finding" },
    { ev: "closed" },
    { ev: "reply-start" },
    { ev: "operator-message", id: "m1", text: "Check the router too." },
    delta("The router is fine."),
    { ev: "status", status: "no-finding" },
    { ev: "closed" },
  ]
  const state = reduceEvents(events)
  const ms = buildMessages(state, state.steps, state.status, false)
  const order = ms.flatMap((m) => (m.role === "user" ? ["user:" + prose([m]).join("")] : prose([m]).map((t) => "agent:" + t.slice(0, 10))))
  assert.deepEqual(order, ["agent:## Summary", "user:Check the router too.", "agent:The router"])
  // The whole text, once.
  assert.equal(prose(ms).filter((t) => t === whole).length, 1)
})

test("an old record with only the final text shows it once, before a later turn", () => {
  const out = texts([
    { ev: "thinking-delta", conv: "root", attempt: 1, text: "Read the vault" },
    { ev: "no-finding", final: "Nothing to prove." },
    { ev: "status", status: "no-finding" },
    { ev: "closed" },
    { ev: "reply-start" },
    { ev: "operator-message", id: "m1", text: "and the router?" },
    delta("The router is fine."),
  ])
  assert.deepEqual(out, ["Nothing to prove.", "and the router?", "The router is fine."])
})

test("Run Info's module line is a list: today one entry, the scope's pack", async () => {
  const { runModules } = await import("./run-panel")
  const scope = { id: "s", title: "S", kind: "lab", blurb: "", entry: "" }
  assert.deepEqual(runModules(reduceEvents([{ ev: "scope", scope: { ...scope, pack: "web" } }])), ["web"])
  // A scope saved before modules is a Contracts scope.
  assert.deepEqual(runModules(reduceEvents([{ ev: "scope", scope }])), ["contracts"])
  assert.deepEqual(runModules(reduceEvents([])), [])
})
