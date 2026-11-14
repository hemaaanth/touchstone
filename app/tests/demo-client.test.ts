import "./helpers/isolated-env"
import { afterEach, expect, test } from "bun:test"
import { startRun, stopRun } from "../src/lib/api"
import { DEMO_ADMIN_MESSAGE } from "../src/lib/demo"

const globals = globalThis as { fetch: unknown; document?: unknown }
const original = { fetch: globals.fetch, document: globals.document }
afterEach(() => { globals.fetch = original.fetch; globals.document = original.document })
const enableDemo = () => {
  globals.document = { querySelector: (selector: string) => selector.includes("touchstone-demo") ? { content: '{"budgetUsd":1,"maxMinutes":10}' } : null }
}

test("demo POST sends only the chosen target and receipt UUID, then recovers a dropped response", async () => {
  enableDemo()
  let requestId = ""
  let posts = 0
  globals.fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++
      const body = JSON.parse(String(init.body))
      requestId = body.requestId
      expect(body).toEqual({ targetId: "vault-accounting", requestId })
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(init.headers).toEqual({ "content-type": "application/json" })
      throw new TypeError("Dropped response")
    }
    expect(url).toBe(`/api/runs?requestId=${requestId}`)
    return Response.json({ run: { id: "demo-recovered", target: "vault-accounting" } })
  }
  const run = await startRun("owner-alias", "vault-accounting", 999, ["web"], "solo", { freeRoam: true, options: [] })
  expect(run.id).toBe("demo-recovered")
  expect(posts).toBe(1)
})

test("an unconfirmed demo retry retains its original target and UUID despite unused owner options", async () => {
  enableDemo()
  let first: unknown
  globals.fetch = async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") first = JSON.parse(String(init.body))
    throw new TypeError("Dropped response")
  }
  await expect(startRun("alias", "vault-reentrancy", 1)).rejects.toThrow("will not create a duplicate")
  globals.fetch = async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual(first)
    return Response.json({ id: "same-demo" })
  }
  expect((await startRun("different-unused-alias", "vault-reentrancy", 10)).id).toBe("same-demo")
}, 15000)

test("missing or foreign demo scopes never send a start request", async () => {
  enableDemo()
  globals.fetch = () => { throw new Error("Unexpected fetch") }
  await expect(startRun("alias")).rejects.toThrow("Select a prepared demo scope")
  await expect(startRun("alias", "scope-owner")).rejects.toThrow("Select a prepared demo scope")
})

test("provider failures give visitor actions, not owner setup instructions", async () => {
  enableDemo()
  for (const status of [400, 403, 503]) {
    globals.fetch = async () => Response.json({ error: "Add a provider key in Settings" }, { status })
    await expect(startRun("alias", "vault-reentrancy")).rejects.toThrow(DEMO_ADMIN_MESSAGE)
  }
})

test("only demo_busy identifies a running demo; other 429 responses describe a limit", async () => {
  enableDemo()
  for (const code of ["demo_busy", "demo_session_limit", "demo_ip_limit", "unknown", undefined, null, 429]) {
    globals.fetch = async () => Response.json({ code, error: "Internal quota details" }, { status: 429 })
    const message = code === "demo_busy"
      ? "Another demo is running. Try again when it finishes. Runs are not queued."
      : "Demo limit reached. Please try again later."
    await expect(startRun("alias", "vault-reentrancy")).rejects.toThrow(message)
  }
})

test("the owned Stop request remains available without a console token", async () => {
  enableDemo()
  globals.fetch = async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/runs/demo-owned/stop")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({})
    expect(init?.headers).toEqual({ "content-type": "application/json" })
    return Response.json({ ok: true })
  }
  expect(await stopRun("demo-owned")).toEqual({ ok: true })
})
