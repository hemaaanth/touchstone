// reduceEvents: where streamed text lands when attempt numbers repeat.
// Runs with `bun test src/lib`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { getRunState, loadRun, reduceEvents } from "./runModel"
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

async function until(predicate: () => boolean, timeout = 5000) {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, "timed out waiting for the run")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("a dropped stream reloads the exact server events without replay duplicates", async () => {
  const originalFetch = globalThis.fetch
  const originalSource = globalThis.EventSource
  const id = "replay-test"
  const initial = [ev("opened"), ev("status", { status: "running" })]
  const live = [ev("say", { text: "one" }), ev("say", { text: "two" })]
  const canonical = [...initial, ...live, ev("status", { status: "error" }), ev("closed")]
  let requests = 0
  FakeEventSource.sources = []
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async () => Response.json({ events: ++requests === 1 ? initial : canonical })) as typeof fetch
  try {
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
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalSource
  }
})

test("a dropped stream retries snapshots while the server is down, then shows failure", async () => {
  const originalFetch = globalThis.fetch
  const originalSource = globalThis.EventSource
  const id = "restart-test"
  const initial = [ev("status", { status: "running" })]
  const failed = [...initial, ev("error", { message: "Server restarted" }), ev("status", { status: "error" }), ev("closed")]
  let requests = 0
  FakeEventSource.sources = []
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async () => {
    requests++
    if (requests === 2 || requests === 3) throw new TypeError("server unavailable")
    return Response.json({ events: requests === 1 ? initial : failed })
  }) as typeof fetch
  try {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].drop()
    await until(() => getRunState(id)?.closed === true, 6000)
    assert.deepEqual(getRunState(id)?.events, failed)
    assert.equal(getRunState(id)?.status, "error")
    assert.equal(requests, 4)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalSource
  }
})

test("a deleted run stops retrying after a 404 snapshot", async () => {
  const originalFetch = globalThis.fetch
  const originalSource = globalThis.EventSource
  const id = "deleted-test"
  let requests = 0
  FakeEventSource.sources = []
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  globalThis.fetch = (async () => {
    requests++
    return requests === 1
      ? Response.json({ events: [ev("status", { status: "running" })] })
      : new Response(null, { status: 404 })
  }) as typeof fetch
  try {
    loadRun(id)
    await until(() => FakeEventSource.sources.length === 1)
    FakeEventSource.sources[0].drop()
    await until(() => requests === 2)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(requests, 2)
    assert.equal(FakeEventSource.sources.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.EventSource = originalSource
  }
})
