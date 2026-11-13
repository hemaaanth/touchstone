import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// POST /api/scopes/:id/brief sets or clears a scope's brief. It is a write, so
// it needs the console token like every other write. Throwaway stores only.
// The token matches grants-http.test.ts: bun shares one module cache across
// test files, and the token is read once, when the module loads.
const dir = mkdtempSync(path.join(tmpdir(), "scope-brief-http-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

// @ts-expect-error — plain .mjs module, no types
const { handleScopes } = await import("../server/runs-http.mjs")

const ID = "scope-svc-00000001"
const record = { id: ID, kind: "scope", title: "svc", pack: "review", entry: "https://github.com/acme/svc", signal: "agent", members: [{ kind: "repo", url: "https://github.com/acme/svc" }], links: ["https://github.com/acme/svc"], createdAt: 1 }
beforeEach(() => {
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  writeFileSync(SCOPES, JSON.stringify([record]))
  rmSync(GRANTS, { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CONSOLE = { origin: "http://localhost:5173", host: "localhost:5173", "content-type": "application/json" }
const SIGNED = { ...CONSOLE, "x-touchstone-grant-token": TOKEN }

async function post(url: string, raw: string, headers: Record<string, string>) {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const req = {
    method: "POST",
    url,
    headers,
    on(ev: string, cb: (arg?: unknown) => void) {
      handlers[ev] = cb
      if (ev === "end") {
        setTimeout(() => {
          handlers.data?.(Buffer.from(raw))
          handlers.end?.()
        }, 0)
      }
      return req
    },
  }
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(s?: string) {
      this.body = s ?? ""
    },
  }
  await handleScopes(req, res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}
const url = `/api/scopes/${ID}/brief`
const stored = () => JSON.parse(readFileSync(SCOPES, "utf8"))[0]

describe("POST /api/scopes/:id/brief", () => {
  test("no console token: refused, nothing saved", async () => {
    const r = await post(url, JSON.stringify({ brief: "Look at auth." }), CONSOLE)
    expect(r.status).toBe(403)
    expect(stored()).toEqual(record)
  })

  test("with the token: saved trimmed, and an empty text clears it", async () => {
    let r = await post(url, JSON.stringify({ brief: "  Look at auth.  " }), SIGNED)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ id: ID, brief: "Look at auth." })
    expect(stored()).toEqual({ ...record, brief: "Look at auth." })
    r = await post(url, JSON.stringify({ brief: "" }), SIGNED)
    expect(r.json).toEqual({ id: ID, brief: "" })
    expect(stored()).toEqual(record)
  })

  test("over 8,000 characters: refused with a sentence, nothing saved", async () => {
    const r = await post(url, JSON.stringify({ brief: "x".repeat(8001) }), SIGNED)
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("A scope brief holds at most 8,000 characters. This one has 8,001. Shorten it and save again.")
    expect(stored()).toEqual(record)
  })

  test("a body that is not { brief: text } does not clear a saved brief", async () => {
    await post(url, JSON.stringify({ brief: "Keep me." }), SIGNED)
    for (const raw of ["{ not json", JSON.stringify({}), JSON.stringify({ brief: 3 })]) {
      const r = await post(url, raw, SIGNED)
      expect(r.status).toBe(400)
      expect(stored().brief).toBe("Keep me.")
    }
  })

  test("an unknown scope: refused", async () => {
    const r = await post("/api/scopes/scope-nope/brief", JSON.stringify({ brief: "x" }), SIGNED)
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("unknown scope: scope-nope")
  })
})
