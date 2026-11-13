import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The grant HTTP contract: list, add, revoke. The grant store's own rules (host
// normalization, the ownership/approvedBy checks) are covered in
// spike/test/grant-store.test.mjs; here we check the (req,res) handler wires them
// to the right status codes. A throwaway store via TOUCHSTONE_GRANTS_FILE, set
// before the module loads, so the real spike/data/grants.json is never touched.
const dir = mkdtempSync(path.join(tmpdir(), "grants-http-test-"))
useEnv({ TOUCHSTONE_GRANTS_FILE: path.join(dir, "grants.json") })
// A known token, set before the module loads, so the test can forge the header
// the operator would read from the console. Also skips the console print.
const TOKEN = "test-grant-token"
useEnv({ TOUCHSTONE_GRANT_TOKEN: TOKEN })

// @ts-expect-error — plain .mjs module, no types
const { handleGrants } = await import("../server/runs-http.mjs")

type Handlers = Record<string, (arg?: unknown) => void>

// The console's own origin. A grant mutation is accepted only from a same-origin
// request: an Origin header whose host matches the request's Host header. These
// stand-ins make goodHeaders a real same-origin request.
const CONSOLE_ORIGIN = "http://localhost:5173"
const CONSOLE_HOST = "localhost:5173"

// A mutation (POST/DELETE) from the console carries the capability token, a
// same-origin Origin/Host pair, and, for POST, an application/json content-type.
// These defaults stand in for a same-origin console request; a test overrides
// them to probe the guard.
function goodHeaders(method: string): Record<string, string> {
  const h: Record<string, string> = {
    "x-touchstone-grant-token": TOKEN,
    origin: CONSOLE_ORIGIN,
    host: CONSOLE_HOST,
  }
  if (method === "POST") h["content-type"] = "application/json"
  return h
}

function mockReq(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const handlers: Handlers = {}
  const req = {
    method,
    url,
    headers: headers ?? {},
    on(ev: string, cb: (arg?: unknown) => void) {
      handlers[ev] = cb
      // readBody registers "data" then "end"; drive the body once "end" is set so
      // both listeners exist before the chunk and the end fire.
      if (ev === "end") {
        setTimeout(() => {
          if (body !== undefined) handlers.data?.(Buffer.from(JSON.stringify(body)))
          handlers.end?.()
        }, 0)
      }
      return req
    },
  }
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v
    },
    end(s?: string) {
      this.body = s ?? ""
    },
  }
}

async function call(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
  const res = mockRes()
  // A GET needs no credential; a mutation gets the console's good headers unless
  // the test passes its own to probe the guard.
  const h = headers ?? (method === "GET" ? {} : goodHeaders(method))
  const handled = await handleGrants(mockReq(method, url, body, h), res)
  return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

describe("grant endpoints", () => {
  test("a non-grant path is not handled", async () => {
    const { handled } = await call("GET", "/api/runs")
    expect(handled).toBe(false)
  })

  test("adds an operator-owned grant, lists it active, then revokes it", async () => {
    const add = await call("POST", "/api/grants", {
      hosts: ["Example.com", "https://api.example.com/v1"],
      kind: "operator-owned",
      ownership: true,
      note: "my infra",
    })
    expect(add.status).toBe(201)
    // Hosts are normalized: scheme and path dropped, lowercased.
    expect(add.json.hosts).toEqual(["example.com", "api.example.com"])
    expect(add.json.ownership).toBe(true)
    const id = add.json.id

    const list = await call("GET", "/api/grants")
    expect(list.status).toBe(200)
    const found = list.json.grants.find((g: { id: string }) => g.id === id)
    expect(found).toBeTruthy()
    expect(found.active).toBe(true)

    const del = await call("DELETE", `/api/grants/${id}`)
    expect(del.status).toBe(200)
    expect(del.json.removed).toBe(true)

    // Revoking a grant that is already gone is a 404, not a silent success.
    const again = await call("DELETE", `/api/grants/${id}`)
    expect(again.status).toBe(404)
  })

  test("an operator-owned grant without confirmed ownership is refused", async () => {
    const r = await call("POST", "/api/grants", { hosts: ["x.example.com"], kind: "operator-owned" })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain("ownership")
  })

  test("an authorized grant needs who approved it", async () => {
    const r = await call("POST", "/api/grants", { hosts: ["y.example.com"], kind: "authorized" })
    expect(r.status).toBe(400)
    expect(r.json.error).toContain("approvedBy")
  })

  // A grant must be unforgeable by a web page or the agent. These three checks are
  // the forgery defense: a drive-by page fails all three, the agent fails the
  // token. None of them store a grant.
  test("a grant POST with no capability token is refused, and stores nothing", async () => {
    // Same-origin and good content-type, but no token: it must still be refused,
    // so this isolates the token check.
    const r = await call("POST", "/api/grants", { hosts: ["z.example.com"], kind: "operator-owned", ownership: true }, { "content-type": "application/json", origin: CONSOLE_ORIGIN, host: CONSOLE_HOST })
    expect(r.status).toBe(403)
    const list = await call("GET", "/api/grants")
    expect(list.json.grants.some((g: { hosts: string[] }) => g.hosts.includes("z.example.com"))).toBe(false)
  })

  test("a grant POST with the wrong content-type is refused (415)", async () => {
    const r = await call("POST", "/api/grants", { hosts: ["z.example.com"], kind: "operator-owned", ownership: true }, { "content-type": "text/plain", "x-touchstone-grant-token": TOKEN, origin: CONSOLE_ORIGIN, host: CONSOLE_HOST })
    expect(r.status).toBe(415)
  })

  test("a grant POST from a foreign origin is refused (403)", async () => {
    const r = await call("POST", "/api/grants", { hosts: ["z.example.com"], kind: "operator-owned", ownership: true }, { "content-type": "application/json", "x-touchstone-grant-token": TOKEN, origin: "https://evil.example", host: CONSOLE_HOST })
    expect(r.status).toBe(403)
  })

  test("a grant POST with NO Origin header is refused (403, fail-closed)", async () => {
    // A request with a valid token and good content-type but no Origin at all is
    // still refused: the same-origin guard fails closed, so a client that omits
    // the Origin cannot slip a mutation through. Nothing is stored.
    const r = await call("POST", "/api/grants", { hosts: ["noorigin.example.com"], kind: "operator-owned", ownership: true }, { "content-type": "application/json", "x-touchstone-grant-token": TOKEN, host: CONSOLE_HOST })
    expect(r.status).toBe(403)
    const list = await call("GET", "/api/grants")
    expect(list.json.grants.some((g: { hosts: string[] }) => g.hosts.includes("noorigin.example.com"))).toBe(false)
  })

  test("a grant DELETE with no capability token is refused (403)", async () => {
    // Seed a grant with a valid request, then try to revoke it without the token.
    const add = await call("POST", "/api/grants", { hosts: ["keep.example.com"], kind: "operator-owned", ownership: true })
    expect(add.status).toBe(201)
    const r = await call("DELETE", `/api/grants/${add.json.id}`, undefined, { origin: CONSOLE_ORIGIN, host: CONSOLE_HOST })
    expect(r.status).toBe(403)
    const list = await call("GET", "/api/grants")
    expect(list.json.grants.some((g: { id: string }) => g.id === add.json.id)).toBe(true)
  })
})

rmSync(dir, { recursive: true, force: true })
