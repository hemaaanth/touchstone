// reduceEvents: where streamed text lands when attempt numbers repeat.
// Runs with `bun test src/lib`.
import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { getRunState, isRunningNow, loadRun, reduceEvents } from "./runModel"
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
  // Not grouped with tool rows, not an error, and nothing for another state.
  assert.equal(reduceEvents(events).error, null)
  assert.deepEqual(rows([ev("workspace", { state: "kept", message })]), [])
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
  const s = reduceEvents([{ t: 1, ev: "read_source", file: "BRIEF.md" }, { t: 2, ev: "read_source", file: "src/Vault.sol" }])
  const labels = s.steps.filter((st) => st.kind === "read").map((st) => st.label)
  assert.deepEqual(labels, ["Read the scope brief", "Read src/Vault.sol"])
})
