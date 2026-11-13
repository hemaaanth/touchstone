// reduceEvents: where streamed text lands when attempt numbers repeat.
// Runs with `bun test src/lib`.
import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { getRunState, isRunningNow, loadRun, reduceEvents, threadSteps } from "./runModel"
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

test("a rebuilt workspace shows its message once, as a quiet system line", () => {
  const message = "The earlier workspace of this run is gone. Files the agent wrote before are not in it."
  const events = [ev("reply-start"), ev("workspace", { state: "rebuilt", message }), say(0, "Looking again")]
  assert.deepEqual(rows(events), [`system:${message}`, "say:Looking again"])
  // Not grouped with tool rows, and not an error.
  assert.equal(reduceEvents(events).error, null)
})

test("a kept workspace with something to tell shows its message as the same quiet line", () => {
  const message = "The access token of this run's scope is no longer in the scope library, so this follow-up runs without it."
  assert.deepEqual(rows([ev("reply-start"), ev("workspace", { state: "kept", message }), say(0, "Going on")]), [`system:${message}`, "say:Going on"])
})

test("the events of a source restore are one status line that changes, and the result takes its place", () => {
  const first = "The fetched sources of this run are put back into its workspace, as this run read them before: 20 to fetch. Each one can take up to 90 seconds."
  const fetching = Array.from({ length: 20 }, (_, k) => ev("workspace", { state: "restoring", message: `Fetching acme/repo${k + 1} (${k + 1} of 20).` }))
  const progress = [ev("reply-start"), ev("workspace", { state: "restoring", message: first }), ...fetching]
  // While it runs: the latest line only, however many sources.
  assert.deepEqual(rows(progress.slice(0, 2)), [`system:${first}`])
  assert.deepEqual(rows(progress.slice(0, 5)), ["system:Fetching acme/repo3 (3 of 20)."])
  assert.deepEqual(rows(progress), ["system:Fetching acme/repo20 (20 of 20)."])
  // The line keeps its place and its key, so nothing moves while it changes.
  assert.equal(reduceEvents(progress).steps[0].key, reduceEvents(progress.slice(0, 2)).steps[0].key)
  // The result is the one line that stays.
  const result = "The earlier workspace of this run is gone, so this is a new workspace built from the same scope. These fetched sources could not be put back, so they are not in it: https://github.com/acme/repo2: could not fetch commit 0123456789ab of acme/repo2."
  assert.deepEqual(rows([...progress, ev("workspace", { state: "rebuilt", message: result }), say(0, "Looking again")]), [`system:${result}`, "say:Looking again"])
  // A restore that the operator stopped: its last line stays, then the stop.
  assert.deepEqual(rows([...progress.slice(0, 3), ev("stop-requested"), ev("stopped")]), ["system:Fetching acme/repo1 (1 of 20).", "note:Stopping the run", "note:You stopped the run. Send a message to continue."])
  // A later restore, after other steps, is a new line: the old one is history.
  const again = [...progress.slice(0, 3), ev("stopped"), ev("reply-start"), ev("workspace", { state: "restoring", message: "Fetching acme/repo1 (1 of 20)." }), ev("workspace", { state: "kept", message: "The server did that now." })]
  assert.deepEqual(rows(again), ["system:Fetching acme/repo1 (1 of 20).", "note:You stopped the run. Send a message to continue.", "system:The server did that now."])
})

test("a workspace event with no message, or with a state this code does not know, shows nothing and does not throw", () => {
  const message = "Something about the workspace."
  const odd = [
    ev("workspace", { state: "rebuilt" }),
    ev("workspace", { state: "restoring", message: "   " }),
    ev("workspace", { state: "kept", message: 7 }),
    ev("workspace", { state: "rebuilt", message: null }),
    ev("workspace", { state: "moved", message }),
    ev("workspace", { message }),
    ev("workspace", { state: 3, message }),
    ev("workspace", { state: ["rebuilt"], message }),
    ev("workspace"),
  ]
  assert.deepEqual(rows(odd), [])
  // An odd event in the middle of a restore does not break the line either.
  assert.deepEqual(rows([ev("workspace", { state: "restoring", message: "Fetching a/b (1 of 2)." }), ...odd, ev("workspace", { state: "restoring", message: "Fetching a/c (2 of 2)." })]), ["system:Fetching a/c (2 of 2)."])
})

test("a follow-up error keeps its sentence apart from the raw output", () => {
  const error = "The agent process ended before it gave an answer: it exited with the code 1. Send the message again to retry.\n\nError: spawn ENOENT\n    at run (agent.mjs:4)"
  const [step] = reduceEvents([ev("reply-error", { error })]).steps
  assert.equal(step.kind, "reply-error")
  assert.equal(step.label, "The agent process ended before it gave an answer: it exited with the code 1. Send the message again to retry.")
  assert.equal(step.detail, "Error: spawn ENOENT\n    at run (agent.mjs:4)")
  // A plain sentence has no raw part.
  assert.equal(reduceEvents([ev("reply-error", { error: "The server restarted during this reply." })]).steps[0].detail, undefined)
})

class FakeEventSource {
  static sources: FakeEventSource[] = []
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) { this.url = url; FakeEventSource.sources.push(this) }
  close() { this.closed = true }
  send(event: RunEvent) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent) }
  drop() { this.onerror?.() }
}

// A stream that a broken proxy kills before any message arrives.
class FailingEventSource extends FakeEventSource {
  constructor(url: string) { super(url); setTimeout(() => this.drop(), 0) }
}

// A proxy that passes the server's first `status` event, then cuts the stream.
class OneEventEventSource extends FakeEventSource {
  constructor(url: string) {
    super(url)
    setTimeout(() => { this.send(ev("status", { status: "running" })); this.drop() }, 5)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, "timed out waiting for the run")
    await sleep(10)
  }
}

// Under fake timers: move the clock and let the fetch promises settle.
async function advance(ms: number, step = 50) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
}

// The store keeps every run in one module map, so a timer left by another test
// can still fetch. Count only this run's snapshot fetches; others get a 404,
// which also stops them.
async function withRun(
  id: string,
  Source: typeof FakeEventSource,
  respond: (n: number) => Response,
  body: (fetches: () => number) => Promise<void>,
) {
  const originalFetch = globalThis.fetch
  const originalSource = globalThis.EventSource
  let count = 0
  FakeEventSource.sources = []
  globalThis.EventSource = Source as unknown as typeof EventSource
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== `/api/runs/${id}`) return new Response(null, { status: 404 })
    return respond(++count)
  }) as typeof fetch
  try {
    await body(() => count)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalSource
  }
}

const down = () => { throw new TypeError("server unavailable") }

test("a dropped stream reloads the exact server events without replay duplicates", async () => {
  const id = "replay-test"
  const initial = [ev("opened"), ev("status", { status: "running" })]
  const live = [ev("say", { text: "one" }), ev("say", { text: "two" })]
  const canonical = [...initial, ...live, ev("status", { status: "error" }), ev("closed")]
  await withRun(id, FakeEventSource, (n) => Response.json({ events: n === 1 ? initial : canonical }), async (fetches) => {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    const source = FakeEventSource.sources[0]
    assert.equal(source.url, `/api/runs/${id}/stream?since=2`)
    for (const event of live) source.send(event)
    await until(() => getRunState(id)?.events.length === 4)
    source.drop()
    // Native EventSource retries the same URL. The server would replay from since=2.
    for (const event of [...live, ...canonical.slice(4)]) source.send(event)
    await until(() => getRunState(id)?.closed === true)
    assert.deepEqual(getRunState(id)?.events, canonical)
    assert.equal(getRunState(id)?.status, "error")
    assert.equal(fetches(), 2)
  })
})

test("a dropped stream retries snapshots while the server is down, then shows failure", async () => {
  const id = "restart-test"
  const initial = [ev("status", { status: "running" })]
  const failed = [...initial, ev("error", { message: "Server restarted" }), ev("status", { status: "error" }), ev("closed")]
  await withRun(id, FakeEventSource, (n) => (n === 2 || n === 3 ? down() : Response.json({ events: n === 1 ? initial : failed })), async (fetches) => {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].drop()
    await until(() => getRunState(id)?.closed === true, 6000)
    assert.deepEqual(getRunState(id)?.events, failed)
    assert.equal(getRunState(id)?.status, "error")
    assert.equal(fetches(), 4)
  })
})

test("a deleted run stops retrying after a 404 snapshot", async () => {
  const id = "deleted-test"
  const respond = (n: number) => (n === 1 ? Response.json({ events: [ev("status", { status: "running" })] }) : new Response(null, { status: 404 }))
  await withRun(id, FakeEventSource, respond, async (fetches) => {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].drop()
    await until(() => fetches() === 2)
    await sleep(1200)
    assert.equal(fetches(), 2)
    assert.equal(FakeEventSource.sources.length, 1)
  })
})

// A follow-up reply keeps the run's terminal status, so the header must read
// `replying` to say Running.
test("a finished run shows Running while a follow-up reply streams, then its outcome again", () => {
  const done = [ev("status", { status: "running" }), ev("status", { status: "recorded" }), ev("closed")]
  assert.equal(isRunningNow(reduceEvents(done), "recorded"), false)
  const replying = reduceEvents([...done, ev("reply-start")])
  assert.equal(isRunningNow(replying, replying.status), true)
  const failed = [ev("status", { status: "error" }), ev("closed"), ev("reply-start")]
  assert.equal(isRunningNow(reduceEvents(failed), "error"), true)
  const after = reduceEvents([...done, ev("reply-start"), say(0, "ok"), ev("closed")])
  assert.equal(isRunningNow(after, after.status), false)
  assert.equal(isRunningNow(null, "running"), true)
  assert.equal(isRunningNow(null, "recorded"), false)
})

test("a good snapshot with a stream that always fails reloads on the backoff, not in a tight loop", async () => {
  const id = "tight-loop-test"
  await withRun(id, FailingEventSource, () => Response.json({ events: [ev("status", { status: "running" })] }), async (fetches) => {
    loadRun(id)
    await sleep(2500)
    // Reloads at 0 s, 0 s and 1 s; the next waits until 3 s.
    assert.ok(fetches() >= 2 && fetches() <= 4, `expected 2-4 snapshot fetches in 2.5 s, got ${fetches()}`)
  })
})

// The server sends `status` on every subscribe, so a stream that connects at
// all delivers one message. That message alone must not reset the backoff.
test("a stream that delivers one event and then drops reloads on the backoff", async () => {
  const id = "one-event-test"
  await withRun(id, OneEventEventSource, () => Response.json({ events: [ev("status", { status: "running" })] }), async (fetches) => {
    loadRun(id)
    await sleep(2500)
    assert.ok(fetches() >= 2 && fetches() <= 4, `expected 2-4 snapshot fetches in 2.5 s, got ${fetches()}`)
  })
})

test("loadRun calls during an outage keep one retry chain", async () => {
  const id = "one-chain-test"
  mock.timers.enable({ apis: ["setTimeout", "Date"] })
  try {
    await withRun(id, FakeEventSource, down, async (fetches) => {
      loadRun(id)
      // Failures at 0, 0, 1, 3 and 7 s; the run is now on the 5 s step.
      await advance(8000)
      const before = fetches()
      // As from three remounts of the run's page.
      loadRun(id)
      loadRun(id)
      loadRun(id)
      await advance(9900)
      // One fetch now and one 5 s later. Two chains would add more.
      assert.equal(fetches() - before, 2)
    })
  } finally {
    mock.timers.reset()
  }
})

test("a healthy stream that drops after 5 s reloads at once, even after earlier failures", async () => {
  const id = "healthy-drop-test"
  mock.timers.enable({ apis: ["setTimeout", "Date"] })
  try {
    await withRun(id, FakeEventSource, () => Response.json({ events: [ev("status", { status: "running" })] }), async (fetches) => {
      loadRun(id)
      await advance(50)
      // Two streams that die at once push the backoff to 2 s.
      FakeEventSource.sources[0].drop()
      await advance(50)
      FakeEventSource.sources[1].drop()
      await advance(1050)
      assert.equal(FakeEventSource.sources.length, 3)
      const healthy = FakeEventSource.sources[2]
      healthy.send(ev("status", { status: "running" }))
      await advance(6000)
      const before = fetches()
      healthy.drop()
      await advance(100)
      assert.equal(fetches(), before + 1)
    })
  } finally {
    mock.timers.reset()
  }
})

test("a 4xx snapshot stops retries, not only a 404", async () => {
  const id = "forbidden-test"
  const respond = (n: number) => (n === 1 ? Response.json({ events: [ev("status", { status: "running" })] }) : new Response(null, { status: 403 }))
  await withRun(id, FakeEventSource, respond, async (fetches) => {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].drop()
    await until(() => fetches() === 2)
    await sleep(1200)
    assert.equal(fetches(), 2)
  })
})

test("after a drop an open snapshot follows from its own length and appends live events once", async () => {
  const id = "open-reload-test"
  const initial = [ev("opened"), ev("status", { status: "running" })]
  const snapshot = [...initial, ev("say", { text: "one" })]
  const tail = [ev("say", { text: "two" }), ev("status", { status: "recorded" }), ev("closed")]
  await withRun(id, FakeEventSource, (n) => Response.json({ events: n === 1 ? initial : snapshot }), async (fetches) => {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].send(snapshot[2])
    await until(() => getRunState(id)?.events.length === 3)
    FakeEventSource.sources[0].drop()
    await until(() => FakeEventSource.sources.length === 2)
    const second = FakeEventSource.sources[1]
    assert.equal(second.url, `/api/runs/${id}/stream?since=${snapshot.length}`)
    for (const event of tail) second.send(event)
    await until(() => getRunState(id)?.closed === true)
    assert.deepEqual(getRunState(id)?.events, [...snapshot, ...tail])
    assert.equal(fetches(), 2)
    assert.equal(FakeEventSource.sources.length, 2)
  })
})

// A recorded run that did not read its whole scope keeps a coverage warning.
// A later cleared note (a follow-up that read the rest) removes it.
test("a coverage note on a recorded run is kept as a warning, and a cleared note removes it", () => {
  const info = { kind: "coverage", title: "Part of the scope was not read", hint: "h", detail: "d", message: "m", retryable: false, spentUsd: 0 }
  const recorded = [ev("coverage", { info }), ev("status", { status: "recorded", decision: "approve" })]
  const s = reduceEvents(recorded)
  assert.equal(s.status, "recorded")
  assert.equal(s.coverage?.title, "Part of the scope was not read")
  assert.equal(s.errorInfo, null)
  assert.equal(reduceEvents([...recorded, ev("coverage", { info: null })]).coverage, null)
})

// A Review lead arrives as a `lead` event the moment the agent records it. The
// run view lists it under Leads with its evidence, worst first, one per id.
// A lead is never proven, whatever the event says.
test("lead events fill state.leads with evidence, one per id, worst first, never proven", () => {
  const state = reduceEvents([
    ev("lead", { t: 1, id: "lead-a", severity: "medium", file: "src/svg.ts", line: 12, title: "SVG script passes through", reason: "no sanitizer", agent: "a-52" }),
    ev("lead", { t: 2, id: "lead-b", severity: "high", file: "src/avatar.ts", line: 88, title: "SSRF via avatar URL", reason: "fetch with no host check", proof: "hit 169.254.169.254" }),
    ev("lead", { t: 3, id: "lead-a", severity: "medium", file: "src/svg.ts", line: 12, title: "SVG script passes through", reason: "no sanitizer on render", agent: "a-52", proven: true }),
    ev("lead", { t: 4, id: "", file: "", line: 0 }),
  ])
  assert.deepEqual(
    state.leads.map((l) => [l.id, l.severity, l.file, l.line, l.author]),
    [
      ["lead-b", "high", "src/avatar.ts", 88, "coordinator"],
      ["lead-a", "medium", "src/svg.ts", 12, "a-52"],
    ],
  )
  assert.equal(state.leads[1].reason, "no sanitizer on render")
  assert.equal(state.leads[0].proof, "hit 169.254.169.254")
  assert.ok(state.leads.every((l) => !("proven" in l)))
  assert.deepEqual(state.findings, [])
})

// A joined run says which modules it covers, in order. The pre-pass view and Run
// Info read state.packs, so it must never be empty on a run that has a scope.
test("a packs event fills state.packs in order, and one module stays one", () => {
  assert.deepEqual(reduceEvents([ev("packs", { packs: ["web", "domains"] })]).packs, ["web", "domains"])
  assert.deepEqual(reduceEvents([ev("packs", { packs: ["web"] })]).packs, ["web"])
  // An empty or broken list falls back to the scope's own module below.
  assert.deepEqual(reduceEvents([ev("packs", { packs: [] })]).packs, [])
})

// A record from before the packs event still names its one module.
test("an old record gets its one module from the scope", () => {
  const scope = { id: "s", title: "Site", kind: "live", pack: "web", blurb: "", entry: "", signal: "", proofSurface: { kind: "http", note: "" } }
  assert.deepEqual(reduceEvents([ev("scope", { scope })]).packs, ["web"])
  assert.deepEqual(reduceEvents([]).packs, [])
})

// B8: the closing words of a run that proved nothing. The engine used to cut
// `final` at 4000 characters; the stream held the whole text.
const whole = `## Summary\n\n${"The vault rounds in its own favour. ".repeat(190)}**medium — src/utils/about.ts** ends it.`
const cut = whole.slice(0, 4000)

test("a stream with the whole closing text and a cut final keeps one copy", () => {
  for (const final of [cut, `${cut} …cut`, whole]) {
    const steps = reduceEvents([say(1, whole), ev("no-finding", { final }), ev("status", { status: "no-finding" }), ev("closed")]).steps
    assert.deepEqual(steps.map((s) => `${s.kind}:${s.label.length}`), [`say:${whole.length}`])
  }
})

test("an old record with only the final text shows it once, at the run's end", () => {
  const events = [
    think(1, "Read the vault"),
    ev("no-finding", { final: "Nothing to prove." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
    ev("reply-start"),
    ev("operator-message", { id: "m1", text: "and the router?" }),
    say(1, "The router is fine."),
    ev("status", { status: "no-finding" }),
  ]
  assert.deepEqual(rows(events), ["reasoning:Read the vault", "say:Nothing to prove.", "operator:and the router?", "say:The router is fine."])
  assert.equal(reduceEvents(events).steps.filter((s) => s.closing).length, 1)
})

test("the closing step goes when the run ends as another error, not as a coverage gap", () => {
  const end = (errorInfo: Record<string, unknown>) =>
    rows([ev("no-finding", { final: "Nothing." }), ev("status", { status: "error", errorInfo })])
  assert.deepEqual(end({ kind: "coverage" }), ["say:Nothing."])
  assert.deepEqual(end({ kind: "crash" }), [])
})

test("the provider event gives the run its provider and model id; an old run has none", () => {
  const state = reduceEvents([ev("provider", { provider: "lyber", model: "deepseek-v4.1-flash" }), ev("status", { status: "running" })])
  assert.deepEqual(state.provider, { id: "lyber", model: "deepseek-v4.1-flash" })
  assert.deepEqual(state.steps, [])
  assert.equal(reduceEvents([ev("status", { status: "running" })]).provider, null)
})

// The closing check looks only at the turn that ended and at the main agent.
// The first two are the reviewer's boundary tests, as written.
test("each old-record turn gets its own equal closing answer", () => {
  const es = [
    ev("no-finding", { final: "Nothing to report." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
    ev("reply-start"),
    ev("operator-message", { text: "Please check again." }),
    ev("no-finding", { final: "Nothing to report." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
  ]
  assert.deepEqual(
    reduceEvents(es).steps.map((s) => [s.kind, s.label]),
    [
      ["say", "Nothing to report."],
      ["operator", "Please check again."],
      ["say", "Nothing to report."],
    ],
  )
})

test("a child answer cannot stand in for the coordinator closing", () => {
  const state = reduceEvents([
    ev("subagent-spawned", { id: "a-1", name: "Worker", conv: "child" }),
    ev("assistant-delta", { agent: "a-1", conv: "child", attempt: 1, text: "Nothing to report." }),
    ev("no-finding", { final: "Nothing to report." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
  ])
  assert.deepEqual(threadSteps(state.steps, null).filter((s) => s.kind === "say").map((s) => s.label), ["Nothing to report."])
})

test("a fleet child's last text equal to the coordinator's final: both show, each in its thread", () => {
  const state = reduceEvents([
    ev("subagent-spawned", { id: "a-1", name: "Worker", conv: "child" }),
    ev("assistant-delta", { agent: "a-1", conv: "child", attempt: 1, text: "The vault is safe." }),
    ev("assistant-delta", { conv: "root", attempt: 2, text: "The vault is safe." }),
    ev("settled", { summary: { final: { text: "The vault is safe." } } }),
    ev("no-finding", { final: "The vault is safe." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
  ])
  const says = (id: string | null) => threadSteps(state.steps, id).filter((s) => s.kind === "say").map((s) => s.label)
  assert.deepEqual(says(null), ["The vault is safe."])
  assert.deepEqual(says("a-1"), ["The vault is safe."])
  assert.equal(state.steps.filter((s) => s.closing).length, 0, "the coordinator's own stream holds its final")
})

test("a follow-up whose answer equals the run's first final: both show, in order", () => {
  const es = [
    say(1, "No path drains the vault."),
    ev("no-finding", { final: "No path drains the vault." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
    ev("reply-start"),
    ev("operator-message", { id: "m1", text: "Sure?" }),
    say(1, "No path drains the vault."),
    ev("settled", { summary: { final: { text: "No path drains the vault. Checked twice." } } }),
    ev("no-finding", { final: "No path drains the vault. Checked twice." }),
    ev("status", { status: "no-finding" }),
    ev("closed"),
  ]
  // The second final extends this turn's own stream, never the first answer.
  assert.deepEqual(rows(es), ["say:No path drains the vault.", "operator:Sure?", "say:No path drains the vault. Checked twice."])
})

// B10: the server ends a child that a restart cut off as `subagent-done` with
// status "failed" and `interrupted: true`. That is not a failure.
const CUT = "The server restarted while this agent was working. It was not started again."
const spawn = (id: string) => ev("subagent-spawned", { id, name: id, conv: id })

test("a child a restart cut off is interrupted, not failed; a real failure stays failed", () => {
  const state = reduceEvents([
    spawn("a-1"),
    spawn("a-2"),
    ev("subagent-done", { id: "a-1", status: "failed", interrupted: true, error: CUT }),
    ev("subagent-done", { id: "a-2", status: "failed", error: "The model call failed." }),
  ])
  assert.deepEqual(state.cutOff, { "a-1": CUT })
  const errors = state.steps.filter((s) => s.kind === "agent-error").map((s) => [s.subId, !!s.cut])
  assert.deepEqual(errors, [["a-1", true], ["a-2", false]])
  assert.deepEqual(state.steps.filter((s) => s.kind === "subagent").map((s) => [s.subId, !!s.cut]), [["a-1", true], ["a-2", false]])
})

test("an agent that works again leaves the cut-off list", () => {
  const cut = [spawn("a-1"), ev("subagent-done", { id: "a-1", status: "failed", interrupted: true, error: CUT })]
  assert.deepEqual(reduceEvents([...cut, ev("agent-status", { id: "a-1", state: "working" })]).cutOff, {})
  assert.deepEqual(reduceEvents([...cut, ev("subagent-done", { id: "a-1", status: "done" })]).cutOff, {})
  // An idle report is not work: the agent stays cut off.
  assert.deepEqual(Object.keys(reduceEvents([...cut, ev("agent-status", { id: "a-1", state: "idle" })]).cutOff), ["a-1"])
})

test("the scope brief: Run Info gets the last one, a follow-up can remove it, and it is no step", () => {
  const base: RunEvent[] = [{ t: 1, ev: "scope", scope: { id: "s", title: "svc" } }, { t: 2, ev: "brief", text: "Look at auth first." }]
  let s = reduceEvents(base)
  assert.equal(s.brief, "Look at auth first.")
  assert.ok(!s.steps.some((st) => /brief/i.test(st.label ?? "")))
  s = reduceEvents([...base, { t: 3, ev: "brief", text: "Second." }])
  assert.equal(s.brief, "Second.")
  s = reduceEvents([...base, { t: 3, ev: "brief", text: "" }])
  assert.equal(s.brief, null)
  assert.equal(reduceEvents([{ t: 1, ev: "scope", scope: { id: "s", title: "svc" } }]).brief, null)
})

test("an older run's read of the Touchstone BRIEF.md is not shown as a repo file", () => {
  const reads = (kind: string | null) =>
    reduceEvents([
      ...(kind ? [{ t: 0, ev: "scope", scope: { id: "s", title: "svc", kind } }] : []),
      { t: 1, ev: "read_source", file: "BRIEF.md" },
      { t: 2, ev: "read_source", file: "src/Vault.sol" },
    ]).steps.filter((st) => st.kind === "read").map((st) => st.label)
  // A scope run got its text in that file.
  for (const kind of ["scope", "brief", "live"]) assert.deepEqual(reads(kind), ["Read the scope brief", "Read src/Vault.sol"])
  // A lab never had a scope brief: the agent only looked for the file.
  assert.deepEqual(reads("lab"), ["Looked for a BRIEF.md file", "Read src/Vault.sol"])
  assert.deepEqual(reads(null), ["Looked for a BRIEF.md file", "Read src/Vault.sol"])
})
