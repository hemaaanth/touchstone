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
process.env.TOUCHSTONE_GRANTS_FILE = path.join(dir, "grants.json")

// @ts-expect-error — plain .mjs module, no types
const { handleGrants } = await import("../server/runs-http.mjs")

type Handlers = Record<string, (arg?: unknown) => void>

function mockReq(method: string, url: string, body?: unknown) {
  const handlers: Handlers = {}
  const req = {
    method,
    url,
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

async function call(method: string, url: string, body?: unknown) {
  const res = mockRes()
  const handled = await handleGrants(mockReq(method, url, body), res)
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
})

rmSync(dir, { recursive: true, force: true })
