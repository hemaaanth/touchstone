import { test } from "node:test"
import assert from "node:assert/strict"
import { streamRun } from "./api"
import type { RunEvent } from "./types"

// Contract test, not a regression test: this already held before the reload fix.
// The store's reload depends on it, so it guards against a native retry coming back.
test("contract: a dropped run stream closes once and calls onEnd", () => {
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
    source.onerror?.() // The store replaces events with a snapshot after this.
    assert.equal(source.closed, true)
    assert.equal(ended, 1)
    assert.deepEqual(events, [])
  } finally {
    globalThis.EventSource = original
  }
})
