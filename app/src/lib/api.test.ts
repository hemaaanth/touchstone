import { test } from "node:test"
import assert from "node:assert/strict"
import { streamRun } from "./api"
import { reduceEvents } from "./runModel"
import type { RunEvent } from "./types"

test("a dropped run stream reconnects and receives the server's failed status", () => {
  const original = globalThis.EventSource
  class FakeEventSource {
    static instance: FakeEventSource
    closed = false
    url: string
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) { this.url = url; FakeEventSource.instance = this }
    close() { this.closed = true }
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  try {
    const events: RunEvent[] = []
    let ended = 0
    streamRun("run-1", (event) => events.push(event), 2, () => ended++)
    const source = FakeEventSource.instance
    assert.equal(source.url, "/api/runs/run-1/stream?since=2")
    source.onerror?.() // The server is restarting. Native EventSource retries unless closed.
    assert.equal(source.closed, false)
    assert.equal(ended, 0)
    source.onmessage?.({ data: JSON.stringify({ ev: "status", status: "error" }) } as MessageEvent)
    source.onmessage?.({ data: JSON.stringify({ ev: "closed" }) } as MessageEvent)
    assert.deepEqual(events.map((event) => event.ev), ["status", "closed"])
    assert.equal(reduceEvents(events).status, "error")
    assert.equal(reduceEvents(events).closed, true)
    assert.equal(source.closed, true)
    assert.equal(ended, 1)
  } finally {
    globalThis.EventSource = original
  }
})
