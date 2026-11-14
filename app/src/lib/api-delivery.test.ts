import { test } from "node:test"
import assert from "node:assert/strict"
import { steerRun, MessageDeliveryError } from "./api"

test("lost HTTP response is reconciled by message id without repeating the write", async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (_url, init) => {
    calls.push(init?.method ?? "GET")
    if (init?.method === "POST") throw new TypeError("Failed to fetch")
    return Response.json({ events: [{ ev: "operator-message", id: "m1" }] })
  }) as typeof fetch
  try {
    assert.deepEqual(await steerRun("r1", "continue", "m1"), { ok: true, followUp: true })
    await assert.rejects(steerRun("r1", "other", "m2"), MessageDeliveryError)
    assert.deepEqual(calls, ["POST", "GET", "POST", "GET"])
  } finally { globalThis.fetch = original }
})
