import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, beforeAll, expect, test } from "bun:test"

// The client side of the console guard: every write in src/lib/api.ts carries
// the console token, and the server's guard accepts the request as sent. The
// token is synthetic (the same value as the other test files: bun shares one
// module cache, and the server reads the token once).
const TOKEN = "test-grant-token"
useEnv({ TOUCHSTONE_GRANT_TOKEN: TOKEN })

const api = await import("../src/lib/api.ts")
// @ts-expect-error — plain .mjs module, no types
const { consoleWriteRefusal } = await import("../server/settings.mjs")

type Sent = { url: string; method: string; headers: Record<string, string> }
const sent: Sent[] = []
const g = globalThis as { fetch: unknown; document?: unknown }
const original = { fetch: g.fetch, document: g.document }

beforeAll(() => {
  // The page as the dev server serves it: the token is in a meta tag.
  g.document = { querySelector: (sel: string) => (sel.includes("touchstone-console-token") ? { content: TOKEN } : null) }
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    sent.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
})
afterAll(() => {
  g.fetch = original.fetch
  g.document = original.document
})

test("every write of the client carries the token, and the guard accepts it", async () => {
  await api.startRun("alias", "scope")
  await api.attachScope({ title: "t", members: [] })
  await api.removeScope("scope")
  await api.steerRun("run", "text")
  await api.stopRun("run")
  await api.archiveRun("run", true)
  await api.renameRun("run", "name")
  await api.deleteRun("run")
  await api.dismissFinding("finding", true)
  await api.saveProvider({ label: "l", baseUrl: "https://guard.example.com/v1" })
  await api.deleteProvider("provider")
  await api.discoverModels({ baseUrl: "https://guard.example.com/v1" })
  await api.setDefaultModel("provider", "model")
  await api.setRunBudget(1)

  expect(sent.length).toBe(14)
  expect(sent.map((s) => s.method).sort()).toEqual([...Array(2).fill("DELETE"), ...Array(12).fill("POST")])
  for (const s of sent) {
    const where = `${s.method} ${s.url}`
    expect(s.headers["x-touchstone-grant-token"], where).toBe(TOKEN)
    // The browser adds Host and Origin itself. With them, the guard lets the request in.
    const req = { method: s.method, headers: { ...s.headers, host: "127.0.0.1:5207", origin: "http://127.0.0.1:5207" } }
    expect(consoleWriteRefusal(req), where).toBe(null)
  }
})

test("a read of the client sends no token", async () => {
  sent.length = 0
  await api.fetchFindings().catch(() => {})
  expect(sent.length).toBe(1)
  expect(sent[0].method).toBe("GET")
  expect(sent[0].headers["x-touchstone-grant-token"]).toBe(undefined)
})

test("an unconfirmed submission keeps the same identity for an explicit retry", async () => {
  const savedFetch = g.fetch
  let firstId = ""
  g.fetch = async (_url: string, init: { method?: string; body?: string } = {}) => {
    if (init.method === "POST") firstId = JSON.parse(init.body ?? "{}").requestId
    throw new TypeError("Failed to fetch")
  }
  try {
    await expect(api.startRun("alias", "scope")).rejects.toThrow("will not create a duplicate")
    g.fetch = async (_url: string, init: { body?: string } = {}) => {
      expect(JSON.parse(init.body ?? "{}").requestId).toBe(firstId)
      return new Response(JSON.stringify({ id: "accepted-on-retry" }), { status: 201 })
    }
    expect((await api.startRun("alias", "scope")).id).toBe("accepted-on-retry")
  } finally {
    g.fetch = savedFetch
  }
}, 15000)

test("a refused start preserves the server's actionable setup error", async () => {
  const savedFetch = g.fetch
  g.fetch = async () => new Response(JSON.stringify({ error: "Add an API key for NEAR AI Cloud in Settings before starting a run." }), { status: 400 })
  try {
    await expect(api.startRun("alias", "scope")).rejects.toThrow("Add an API key for NEAR AI Cloud in Settings")
  } finally {
    g.fetch = savedFetch
  }
})

test("a dropped start response opens the exact accepted run without submitting another run", async () => {
  const savedFetch = g.fetch
  let requestId = ""
  let posts = 0
  g.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    if (init.method === "POST") {
      posts += 1
      requestId = JSON.parse(init.body ?? "{}").requestId
      throw new TypeError("Failed to fetch")
    }
    expect(url).toBe(`/api/runs?requestId=${requestId}`)
    return new Response(JSON.stringify({ run: { id: "accepted-run", alias: "alias", status: "starting" } }), { status: 200 })
  }
  try {
    const run = await api.startRun("alias", "scope")
    expect(run.id).toBe("accepted-run")
    expect(posts).toBe(1)
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  } finally {
    g.fetch = savedFetch
  }
})

test("a truncated success response is reconciled instead of returning an empty run", async () => {
  const savedFetch = g.fetch
  let posts = 0
  g.fetch = async (_url: string, init: { method?: string } = {}) => {
    if (init.method === "POST") {
      posts += 1
      return new Response("{", { status: 201 })
    }
    return new Response(JSON.stringify({ run: { id: "accepted-before-truncation" } }), { status: 200 })
  }
  try {
    expect((await api.startRun("alias", "scope")).id).toBe("accepted-before-truncation")
    expect(posts).toBe(1)
  } finally {
    g.fetch = savedFetch
  }
})

test("confirmation survives a second network change without sending another POST", async () => {
  const savedFetch = g.fetch
  let posts = 0, reads = 0
  g.fetch = async (_url: string, init: { method?: string } = {}) => {
    if (init.method === "POST") { posts++; throw new TypeError("Failed to fetch") }
    if (++reads === 1) throw new TypeError("Failed to fetch")
    return new Response(JSON.stringify({ run: { id: "recovered-after-network-change" } }), { status: 200 })
  }
  try {
    expect((await api.startRun("alias", "scope")).id).toBe("recovered-after-network-change")
    expect(posts).toBe(1)
    expect(reads).toBe(2)
  } finally { g.fetch = savedFetch }
})
