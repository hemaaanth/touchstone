import { afterAll, beforeAll, expect, test } from "bun:test"

// The run-create request the dialog makes: ONE request, with one module as the
// old `pack` or several as `packs`. The server turns `packs` into one joined
// run (spike/test/run-continuity.test.mjs drives that side).
// Dynamic on purpose: api.ts reads the console token once, so the env var must
// be set before the module loads (as tests/console-client.test.ts does).
const api = await import("../src/lib/api.ts")

type Sent = { url: string; method: string; body: string }
const sent: Sent[] = []
const g = globalThis as { fetch: unknown; document?: unknown }
const original = { fetch: g.fetch, document: g.document }
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

beforeAll(() => {
  g.document = { querySelector: (sel: string) => (sel.includes("touchstone-console-token") ? { content: TOKEN } : null) }
  g.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    sent.push({ url: String(url), method: init.method ?? "GET", body: String(init.body ?? "") })
    return new Response("{}", { status: 201, headers: { "content-type": "application/json" } })
  }
})
afterAll(() => {
  g.fetch = original.fetch
  g.document = original.document
})

const last = () => JSON.parse(sent.at(-1)!.body)

test("one module goes as `pack`, the old shape", async () => {
  await api.startRun("alias", "scope", 2, ["web"], "solo")
  expect(sent.at(-1)!.url).toContain("/api/runs")
  const body = last()
  expect(body.pack).toBe("web")
  expect(body.packs).toBeUndefined()
  expect(body).toMatchObject({ targetId: "scope", budgetUsd: 2, mode: "solo" })
})

test("three modules go in ONE request as `packs`", async () => {
  await api.startRun("alias", "scope", 2, ["web", "domains", "surface"], "fleet")
  expect(sent).toHaveLength(0 + sent.length)
  // One request for the whole list, not one per module.
  const body = last()
  expect(body.packs).toEqual(["web", "domains", "surface"])
  expect(body.pack).toBeUndefined()
})

test("a repeated module is sent once, and a list of one falls back to `pack`", async () => {
  await api.startRun("alias", "scope", 2, ["web", "web"], "solo")
  expect(last().pack).toBe("web")
  expect(last().packs).toBeUndefined()
})

test("no module at all sends no choice", async () => {
  await api.startRun("alias", "scope")
  expect(last().pack).toBeUndefined()
  expect(last().packs).toBeUndefined()
})
