import "./helpers/isolated-env"
import { afterAll, beforeAll, expect, test } from "bun:test"

// The client side of the console guard: every write in src/lib/api.ts carries
// the console token, and the server's guard accepts the request as sent. The
// token is synthetic (the same value as the other test files: bun shares one
// module cache, and the server reads the token once).
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

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
