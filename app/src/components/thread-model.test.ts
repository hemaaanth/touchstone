// buildMessages: the agent's closing words when it proved nothing.
// Runs with `bun test`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceEvents } from "../lib/runModel"
import type { RunEvent } from "../lib/types"
import type { Sent } from "../lib/sent"
import { settleSent } from "../lib/sent"
import { orderModules } from "../lib/module-colors"
import { agentLook, buildMessages, composerNotice, findingTarget, focusActions, inRunOrder, runHeadStatus, runInterruption, runModules, runRowStatus, runStartView as startView, sendCopy, sentence, withCopies } from "./thread-model"

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

// The agent's streamed reasoning and prose, keyed by attempt so a new number
// starts a new block (as a fresh thinking-delta does on a real run).
const think = (attempt: number, text: string): RunEvent => ({ ev: "thinking-delta", conv: "root", attempt, text })
const say = (attempt: number, text: string): RunEvent => ({ ev: "assistant-delta", conv: "root", attempt, text })
// The tool-call parts a run reduces to, in order, as the renderer sees them.
type WorkPart = { toolName?: string; args?: { work?: { kind: string }[] } }
const partsOf = (events: RunEvent[], live = false) => {
  const state = reduceEvents(events)
  return buildMessages(state, state.steps, "running", live).flatMap((m) =>
    Array.isArray(m.content) ? (m.content as WorkPart[]) : [],
  )
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

test("Run Info's module line names every module of a joined run, in order", () => {
  const state = reduceEvents([{ ev: "packs", packs: ["web", "domains", "surface"] }])
  assert.deepEqual(runModules(state), ["web", "domains", "surface"])
})

test("Run Info's module line on an old record is the scope's one pack", () => {
  const scope = { id: "s", title: "S", kind: "lab", blurb: "", entry: "" }
  assert.deepEqual(runModules(reduceEvents([{ ev: "scope", scope: { ...scope, pack: "web" } }])), ["web"])
  // A scope saved before modules is a Contracts scope.
  assert.deepEqual(runModules(reduceEvents([{ ev: "scope", scope }])), ["contracts"])
  assert.deepEqual(runModules(reduceEvents([])), [])
})

// B10: how a restart's cut-off reads, from the data the server writes.
const CUT = "The server restarted while this agent was working. It was not started again."
const fleetEvents = (end: RunEvent[]): RunEvent[] => [
  { ev: "mode", mode: "fleet" },
  { ev: "subagent-spawned", id: "a-1", name: "siwe-auth", conv: "a-1" },
  { ev: "subagent-spawned", id: "a-2", name: "xss-reflect", conv: "a-2" },
  { ev: "subagent-done", id: "a-1", status: "failed", interrupted: true, error: CUT },
  { ev: "subagent-done", id: "a-2", status: "failed", error: "The model call failed." },
  ...end,
  { ev: "closed" },
]
const cutoffInfo = { kind: "cutoff", reason: "interrupted", title: "This fleet run stopped at the server restart", hint: "h", detail: "", message: "this fleet run stopped at the server restart; its agents were not started again", retryable: true, spentUsd: 0 }

test("an agent a restart cut off reads Interrupted in neutral ink; a failed one stays Failed in red", () => {
  const state = reduceEvents(fleetEvents([{ ev: "status", status: "no-finding" }]))
  const look = (id: string) => agentLook(state, state.agents.find((a) => a.id === id))
  assert.deepEqual(look("a-1"), { word: "Interrupted", dot: "border border-muted-foreground", bad: false, reason: CUT })
  assert.equal(look("a-2").word, "Failed")
  assert.equal(look("a-2").bad, true)
})

test("a run the restart cut off: the top bar says Interrupted, not Failed; another error stays Failed", () => {
  const cut = reduceEvents(fleetEvents([{ ev: "status", status: "error", errorInfo: cutoffInfo }]))
  assert.deepEqual(runHeadStatus(cut, "error"), { word: "Interrupted", tone: "neutral" })
  const run = runInterruption(cut, "error")
  assert.equal(run?.ended, true)
  assert.equal(run?.note, null, "the run's own card says what to do")
  const crash = reduceEvents(fleetEvents([{ ev: "status", status: "error", errorInfo: { ...cutoffInfo, kind: "crash" } }]))
  assert.deepEqual(runHeadStatus(crash, "error"), { word: "Failed", tone: "failed" })
  assert.equal(runInterruption(crash, "error"), null)
})

test("a cut-off fleet that ended as recorded gets one calm run-level note", () => {
  const state = reduceEvents(fleetEvents([{ ev: "status", status: "recorded" }]))
  assert.deepEqual(runHeadStatus(state, "recorded"), { word: "Proven", tone: "proven" })
  const run = runInterruption(state, "recorded")
  assert.equal(run?.ended, false)
  assert.deepEqual(run?.agents, ["siwe-auth"])
  assert.equal(run?.note, "The server restarted while siwe-auth was working. It was not started again, so its part of the scope is not finished. Send a message to continue.")
  // A run with no cut-off agent, or one still running, has no note.
  assert.equal(runInterruption(reduceEvents([{ ev: "status", status: "recorded" }, { ev: "closed" }]), "recorded"), null)
  assert.equal(runInterruption(reduceEvents(fleetEvents([]).slice(0, -1)), "running"), null)
})

test("the run list row: a restart's cut-off reads Interrupted with a neutral dot; a real failure stays red", () => {
  assert.deepEqual(runRowStatus({ status: "error", errorKind: "cutoff" }), { word: "Interrupted", tone: "neutral" })
  assert.deepEqual(runRowStatus({ status: "error", errorKind: "model" }), { word: "Error", tone: "red" })
  assert.deepEqual(runRowStatus({ status: "error" }), { word: "Error", tone: "red" })
  assert.deepEqual(runRowStatus({ status: "recorded", errorKind: null }), { word: "Proven", tone: "green" })
  // The kind only matters for an error: a finished run keeps its own word.
  assert.deepEqual(runRowStatus({ status: "no-finding", errorKind: "cutoff" }), { word: "No finding", tone: "neutral" })
})

// "Open this finding": where a finding of this run sits.
const R = "run-2611130715-1"
const submittedEv = (n: number, poc: string, agent?: string): RunEvent => ({ ev: "finding-submitted", n, title: `F${n}`, severity: "high", poc, ...(agent ? { agent } : {}) })
const findingEv = (k: number, poc: string, proven = true): RunEvent => ({ ev: "finding", id: `${R}.${k}`, runId: R, title: `F${k}`, severity: "high", poc, proven })
const proofEv = (k: number): RunEvent => ({ ev: "artifact-open", id: `proof-${R}.${k}`, title: "Replay proof", kind: "proof", findingId: `${R}.${k}` })

test("open a finding: its card's step and its replay proof, for a proven one", () => {
  const state = reduceEvents([submittedEv(1, "PocA"), submittedEv(2, "PocB"), findingEv(1, "PocA"), findingEv(2, "PocB", false), proofEv(1), { ev: "status", status: "recorded" }])
  const card = (n: number) => state.steps.find((s) => s.kind === "submitted" && s.finding?.n === n)?.key
  assert.deepEqual(findingTarget(state, "recorded", `${R}.1`), { key: card(1), agent: null, proofId: `proof-${R}.1`, spawn: null })
  // Not proven: the card only, no proof to open.
  assert.deepEqual(findingTarget(state, "recorded", `${R}.2`), { key: card(2), agent: null, proofId: null, spawn: null })
  // The card's step really carries its key into the thread.
  const keys = buildMessages(state, state.steps, "recorded", false)
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as { toolName?: string; args?: { stepKey?: string } }[]) : []))
    .filter((p) => p.toolName === "proof")
    .map((p) => p.args?.stepKey)
  assert.deepEqual(keys, [card(1), card(2)])
})

test("open a finding: an unknown id or another run's finding does nothing", () => {
  const state = reduceEvents([submittedEv(1, "PocA"), findingEv(1, "PocA"), { ev: "status", status: "recorded" }])
  assert.equal(findingTarget(state, "recorded", `${R}.9`), null)
  assert.equal(findingTarget(state, "recorded", "other-run-2611120000-1.1"), null)
  assert.equal(findingTarget(reduceEvents([]), "starting", `${R}.1`), null, "a cold load before the stream lands")
})

test("open a finding: a child agent's finding is in that agent's thread", () => {
  const state = reduceEvents([
    { ev: "subagent-spawned", id: "a-1", name: "drain-econ", conv: "c1" },
    submittedEv(1, "PocA", "a-1"),
    findingEv(1, "PocA", false),
    { ev: "status", status: "recorded" },
  ])
  assert.equal(findingTarget(state, "recorded", `${R}.1`)?.agent, "a-1")
})

test("open a finding: an old one-card record whose finding has no PoC still finds its card", () => {
  const state = reduceEvents([
    { ev: "approval-pending", id: "x", title: "Old", severity: "high" },
    { ev: "finding", id: "old-run-1", runId: "old-run-1", title: "Old", severity: "high", proven: true },
    { ev: "artifact-open", id: "proof-old-run-1", title: "Replay proof", kind: "proof", findingId: "old-run-1" },
    { ev: "status", status: "recorded" },
  ])
  const t = findingTarget(state, "recorded", "old-run-1")
  assert.ok(t?.key)
  assert.equal(t?.proofId, "proof-old-run-1")
})

test("open a finding: a proof that lands after its card still opens, once, with no second jump", () => {
  // The server announces the finding before its proof document.
  const first = reduceEvents([submittedEv(3, "PocC"), findingEv(3, "PocC"), { ev: "status", status: "recorded" }])
  const later = reduceEvents([submittedEv(3, "PocC"), findingEv(3, "PocC"), proofEv(3), { ev: "status", status: "recorded" }])
  const id = `${R}.3`
  const a = focusActions(findingTarget(first, "recorded", id), { jumped: false, opened: false }, false)
  assert.ok(a.jump)
  assert.equal(a.proof, null)
  const b = focusActions(findingTarget(later, "recorded", id), a.done, false)
  assert.equal(b.jump, null, "no second jump")
  assert.equal(b.proof, `proof-${R}.3`)
  const c = focusActions(findingTarget(later, "recorded", id), b.done, false)
  assert.deepEqual([c.jump, c.proof, c.peek], [null, null, null], "nothing more after that")
  // On a phone the drawer never opens by itself, early or late.
  const phone = focusActions(findingTarget(later, "recorded", id), { jumped: false, opened: false }, true)
  assert.ok(phone.jump)
  assert.equal(phone.proof, null)
  // An unknown id does nothing.
  assert.deepEqual(focusActions(findingTarget(later, "recorded", `${R}.9`), { jumped: false, opened: false }, false).jump, null)
})

test("open a child's finding on a phone: land on its spawn row with a note, fold the panel; desktop is unchanged", () => {
  const state = reduceEvents([
    { ev: "mode", mode: "fleet" },
    { ev: "subagent-spawned", id: "a-40", name: "hidden-routes", conv: "c40" },
    submittedEv(1, "PocA", "a-40"),
    findingEv(1, "PocA"),
    proofEv(1),
    { ev: "status", status: "recorded" },
  ])
  const t = findingTarget(state, "recorded", `${R}.1`)
  const spawn = state.steps.find((s) => s.kind === "subagent" && s.subId === "a-40")?.key
  assert.equal(t?.agent, "a-40")
  assert.equal(t?.spawn, spawn)
  const fresh = { jumped: false, opened: false }
  // Phone: the spawn row, marked, with the note; the panel folds; no drawer.
  const phone = focusActions(t, fresh, true)
  assert.equal(phone.jump, spawn)
  assert.deepEqual(phone.note, { agent: "a-40", key: t?.key })
  assert.equal(phone.fold, true)
  assert.equal(phone.proof, null)
  assert.equal(phone.peek, null)
  // Desktop: as before, the proof opens and nothing jumps in the main chat.
  const desk = focusActions(t, fresh, false)
  assert.deepEqual([desk.jump, desk.note, desk.fold, desk.proof], [null, null, false, `proof-${R}.1`])
})

test("open a main-chat finding on a phone folds the Run Info panel", () => {
  const state = reduceEvents([submittedEv(1, "PocA"), findingEv(1, "PocA"), { ev: "status", status: "recorded" }])
  const act = focusActions(findingTarget(state, "recorded", `${R}.1`), { jumped: false, opened: false }, true)
  assert.ok(act.jump)
  assert.equal(act.fold, true)
  assert.equal(act.note, null)
  // Only once: the second update does not fold again.
  assert.equal(focusActions(findingTarget(state, "recorded", `${R}.1`), act.done, true).fold, false)
})

test("Run Info's module pills follow the run's own order, not the server's list", () => {
  const server = [{ id: "contracts", title: "Contracts" }, { id: "domains", title: "Domains" }, { id: "web", title: "Web" }]
  const ordered = inRunOrder(server, ["web", "contracts", "domains"])
  assert.deepEqual(ordered?.map((p) => p.id), ["web", "contracts", "domains"])
  // The pills order by that list, as ModulePills does.
  assert.deepEqual(orderModules(["contracts", "domains", "web"], ordered!.map((p) => p.id)), ["web", "contracts", "domains"])
  assert.equal(inRunOrder(undefined, ["web"]), undefined)
})

test("a refused rename or archive says why in the composer line; a refused send comes first", () => {
  const refusal = { title: "Not renamed", text: "this console's token is out of date; reload the page" }
  assert.deepEqual(composerNotice(null, refusal), { title: "Not renamed", detail: "This console's token is out of date; reload the page." })
  assert.deepEqual(composerNotice("spend cap reached", refusal), { title: "Message not sent", detail: "Spend cap reached." })
  assert.equal(composerNotice(null, null), null)
})

test("a joined run's finding card reads its own module's proof, not the scope's; a one-module run reads as before", () => {
  const contracts = { ev: "scope", scope: { id: "s", title: "Vault and site", kind: "lab", pack: "contracts", proofSurface: { kind: "sandbox-foundry" } } } as RunEvent
  const kinds = (events: RunEvent[], packProof: Record<string, string> = {}) =>
    buildMessages(reduceEvents(events), reduceEvents(events).steps, "recorded", false, false, null, packProof)
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as { toolName?: string; args?: { proofKind?: string } }[]) : []))
      .filter((p) => p.toolName === "proof")
      .map((p) => p.args?.proofKind)
  const web: RunEvent = { ev: "finding-submitted", n: 1, title: "XSS", severity: "medium", poc: "xss-1", pack: "web" }
  // From the finding's own record (the server sends pack and proofKind).
  assert.deepEqual(kinds([contracts, web, { ev: "finding", id: `${R}.1`, runId: R, title: "XSS", poc: "xss-1", pack: "web", proofKind: "http" }]), ["http"])
  // Before the record arrives: from the module it came through.
  assert.deepEqual(kinds([contracts, web], { web: "http", contracts: "forge" }), ["http"])
  // A one-module run, or a card with no module: the scope's, as today.
  const forge: RunEvent = { ev: "finding-submitted", n: 1, title: "Drain", severity: "high", poc: "DrainTest" }
  assert.deepEqual(kinds([contracts, forge, { ev: "finding", id: `${R}.1`, runId: R, title: "Drain", poc: "DrainTest" }]), ["forge"])
})

test("a recorded finding with a module but no proof kind reads its module's proof, before the scope's", () => {
  // The review's case: no pack on the card, no proofKind on the record, only the record's pack.
  const contracts = { ev: "scope", scope: { id: "s", title: "Vault", kind: "lab", pack: "contracts", proofSurface: { kind: "sandbox-foundry" } } } as RunEvent
  const events: RunEvent[] = [
    contracts,
    { ev: "finding-submitted", n: 1, title: "XSS", severity: "medium", poc: "P" },
    { ev: "finding", id: `${R}.1`, runId: R, title: "XSS", poc: "P", pack: "web" },
  ]
  const state = reduceEvents(events)
  const kinds = buildMessages(state, state.steps, "recorded", false, false, null, { web: "http", contracts: "forge" })
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as { toolName?: string; args?: { proofKind?: string } }[]) : []))
    .filter((p) => p.toolName === "proof")
    .map((p) => p.args?.proofKind)
  assert.deepEqual(kinds, ["http"])
})

test("Ask is a stable unresolved native tool part between groups, then one receipt in place", () => {
  const before: RunEvent[] = [{ ev: "read_source", file: "before.ts" },
    { ev: "ask-human", id: "q", agent: "coordinator", kind: "question", question: "Which source?" },
    { ev: "read_source", file: "after.ts" }]
  const parts = (events: RunEvent[]) => {
    const state = reduceEvents(events)
    return buildMessages(state, state.steps, "running", true).flatMap((m) => Array.isArray(m.content) ? m.content as { toolName?: string; toolCallId?: string; result?: unknown; args?: unknown }[] : [])
  }
  const pending = parts(before)
  assert.deepEqual(pending.map((p) => p.toolName), ["toolgroup", "ask_human", "toolgroup"])
  assert.equal(pending[1].result, undefined)
  const answered = parts([...before, { ev: "ask-answered", id: "q", agent: "coordinator", answer: "reply" },
    { ev: "ask-receipt", id: "q", agent: "coordinator", answer: "reply", text: "before.ts" }])
  assert.equal(answered[1].toolCallId, pending[1].toolCallId)
  assert.deepEqual(answered[1].result, { id: "q", agent: "coordinator", answer: "reply", text: "before.ts" })
  assert.equal(answered.filter((p) => p.toolName === "ask_human").length, 1)
})


test("a think → request → think stretch folds into one work card; prose stays outside", () => {
  const parts = partsOf([
    think(0, "First thought"),
    { ev: "run_request_script", label: "prompt-injection probe", attempt: 1 },
    { ev: "run_request_script-done", label: "prompt-injection probe", calls: 3, matched: null },
    think(1, "Second thought"),
    say(0, "Here is what I found."),
  ])
  // One card folds both thoughts and the request, in order; the real prose is
  // its own part, never swallowed by the card.
  assert.deepEqual(parts.map((p) => p.toolName), ["work", "say"])
  assert.deepEqual(parts[0].args?.work?.map((s) => s.kind), ["reasoning", "request", "reasoning"])
})

test("a lone thought is a plain reasoning row, not a work card", () => {
  const parts = partsOf([think(0, "Just thinking"), say(0, "Done.")])
  assert.deepEqual(parts.map((p) => p.toolName), ["reasoning", "say"])
})

test("on a live run the tail thought stays a standalone row below the work card", () => {
  const parts = partsOf(
    [
      think(0, "First"),
      { ev: "run_request_script", label: "probe", attempt: 1 },
      { ev: "run_request_script-done", label: "probe", calls: 2 },
      think(1, "Still thinking"),
    ],
    true,
  )
  // The finished work folds away; the live tail thought keeps shimmering below.
  assert.deepEqual(parts.map((p) => p.toolName), ["work", "reasoning"])
  assert.deepEqual(parts[0].args?.work?.map((s) => s.kind), ["reasoning", "request"])
})

test("a lost send response retains its copy for a later agent receipt", async () => {
  const copy: Sent = { id: "lost-response", text: "continue", base: 0, mode: "sending" }
  let copies: Sent[] = []
  const error = Object.assign(new Error("Delivery is not confirmed. Waiting for the agent's receipt."), { uncertain: true })
  const result = await sendCopy(copy, async () => { throw error }, (update) => { copies = update(copies) })
  assert.equal(result.ok, false)
  assert.deepEqual(copies, [copy])
  assert.equal(composerNotice(error.message, null)?.title, "Checking delivery")
})
