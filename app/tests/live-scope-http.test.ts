import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// POST /api/scopes with kind "live" records the operator's permission to reach
// real websites, so it needs the console token, like a Settings write. Other
// scope kinds do not. Throwaway stores; the real spike/data files are never
// touched. The token matches grants-http.test.ts: bun shares one module cache
// across test files, and the token is read once, when the module loads.
const dir = mkdtempSync(path.join(tmpdir(), "live-scope-http-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
useEnv({ TOUCHSTONE_SCOPES_FILE: SCOPES })
useEnv({ TOUCHSTONE_GRANTS_FILE: GRANTS })
const TOKEN = "test-grant-token"
useEnv({ TOUCHSTONE_GRANT_TOKEN: TOKEN })

// @ts-expect-error — plain .mjs module, no types
const { handleScopes } = await import("../server/runs-http.mjs")

beforeEach(() => {
  // The stores read these on each call; set them again in case another test
  // file changed them.
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  rmSync(SCOPES, { force: true })
  rmSync(GRANTS, { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CONSOLE = { origin: "http://localhost:5173", host: "localhost:5173", "content-type": "application/json" }

function mockReq(body: unknown, headers: Record<string, string>, url = "/api/scopes") {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const req = {
    method: "POST",
    url,
    headers,
    on(ev: string, cb: (arg?: unknown) => void) {
      handlers[ev] = cb
      if (ev === "end") {
        setTimeout(() => {
          handlers.data?.(Buffer.from(JSON.stringify(body)))
          handlers.end?.()
        }, 0)
      }
      return req
    },
  }
  return req
}

async function post(body: unknown, headers: Record<string, string>, url = "/api/scopes") {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(s?: string) {
      this.body = s ?? ""
    },
  }
  await handleScopes(mockReq(body, headers, url), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const grants = () => (existsSync(GRANTS) ? JSON.parse(readFileSync(GRANTS, "utf8")) : [])
const live = { kind: "live", title: "My app", hosts: ["app.example.com"], permission: true }

describe("POST /api/scopes, kind live", () => {
  test("no console token: refused, nothing saved", async () => {
    const r = await post(live, CONSOLE)
    expect(r.status).toBe(403)
    expect(grants().length).toBe(0)
    expect(existsSync(SCOPES)).toBe(false)
  })

  test("a page on another origin, even with the token: refused", async () => {
    const r = await post(live, { ...CONSOLE, origin: "http://evil.example", "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(403)
    expect(grants().length).toBe(0)
  })

  test("with the token but no tick: refused, nothing saved", async () => {
    const r = await post({ ...live, permission: false }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(400)
    expect(grants().length).toBe(0)
  })

  test("an unknown module: refused before the grant is written", async () => {
    const r = await post({ ...live, pack: "nope" }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/unknown module/)
    expect(grants().length).toBe(0)
  })

  test("an AI/MCP scope keeps its token out of the summary but on the target", async () => {
    const r = await post({ ...live, host: undefined, hosts: ["https://mcp.example.com"], origins: undefined, pack: "ai-mcp", token: "tok_live_1" }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(201)
    // The summary the client sees carries the origin, never the secret.
    expect(r.json.origins).toEqual(["https://mcp.example.com"])
    expect(JSON.stringify(r.json)).not.toContain("tok_live_1")
    const saved = JSON.parse(readFileSync(SCOPES, "utf8")).find((x: { id: string }) => x.id === r.json.id)
    expect(saved.mcp.token).toBe("tok_live_1")
  })

  test("with the token and the tick: saved, with a grant tied to the scope", async () => {
    const r = await post(live, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(201)
    expect(r.json.kind).toBe("live")
    expect(r.json.hosts).toEqual(["app.example.com"])
    const g = grants()
    expect(g.length).toBe(1)
    expect(g[0].scopeId).toBe(r.json.id)
  })
})

describe("POST /api/scopes, kind live, private lab opt-in", () => {
  const lab = { kind: "live", title: "Local lab", hosts: ["http://127.0.0.1:8080"], permission: true, allowPrivate: true }

  test("the opt-in without the console token: refused, nothing saved", async () => {
    const r = await post(lab, CONSOLE)
    expect(r.status).toBe(403)
    expect(grants().length).toBe(0)
    expect(existsSync(SCOPES)).toBe(false)
  })

  test("a loopback host without the opt-in, even with the token: refused", async () => {
    const r = await post({ ...lab, allowPrivate: undefined }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/Refused/)
    expect(grants().length).toBe(0)
  })

  test("a non-boolean opt-in does not opt in", async () => {
    const r = await post({ ...lab, allowPrivate: "true" }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(400)
    expect(grants().length).toBe(0)
  })

  test("the opt-in with the token still refuses a DNS name or a metadata spelling", async () => {
    for (const h of ["localhost.localdomain", "http://localhost.:3000", "fd00", "[fd00:ec2::0254]", "2852039166"]) {
      const r = await post({ ...lab, hosts: [h] }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/Refused/)
    }
    expect(grants().length).toBe(0)
    expect(existsSync(SCOPES)).toBe(false)
  })

  test("an IPv6 lab is stored as its IPv6 address", async () => {
    const r = await post({ ...lab, hosts: ["[fd00::1]", "http://[::1]:8080"] }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(201)
    expect(r.json.hosts).toEqual(["fd00::1", "::1"])
    expect(grants()[0].hosts).toEqual(["fd00::1", "::1"])
  })

  test("the opt-in with the token: saved, and only that grant opts in", async () => {
    const r = await post(lab, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(201)
    expect(r.json.hosts).toEqual(["127.0.0.1"])
    const g = grants()
    expect(g.length).toBe(1)
    expect(g[0].scopeId).toBe(r.json.id)
    expect(g[0].allowPrivate).toBe(true)
  })
})

test("strict network policy survives scope creation; unknown policies save nothing", async () => {
  const headers = { ...CONSOLE, "x-touchstone-grant-token": TOKEN }
  const invalid = await post({ ...live, networkPolicy: "typo" }, headers)
  expect(invalid.status).toBe(400)
  expect(grants().length).toBe(0)
  const r = await post({ ...live, networkPolicy: "strict" }, headers)
  expect(r.status).toBe(201)
  expect(r.json.networkPolicy).toBe("strict")
  expect(JSON.parse(readFileSync(SCOPES, "utf8"))[0].networkPolicy).toBe("strict")
})


test("network access can be changed for a saved scope and requires the console token", async () => {
  const headers = { ...CONSOLE, "x-touchstone-grant-token": TOKEN }
  const created = await post(live, headers)
  const url = `/api/scopes/${created.json.id}/network-policy`
  const denied = await post({ networkPolicy: "public" }, CONSOLE, url)
  expect(denied.status).toBe(403)
  for (const networkPolicy of ["public", "strict"]) {
    const updated = await post({ networkPolicy }, headers, url)
    expect(updated.status).toBe(200)
    expect(updated.json.networkPolicy).toBe(networkPolicy)
    expect(JSON.parse(readFileSync(SCOPES, "utf8"))[0].networkPolicy).toBe(networkPolicy)
  }
  expect((await post({}, headers, url)).status).toBe(400)
  expect(JSON.parse(readFileSync(SCOPES, "utf8"))[0].networkPolicy).toBe("strict")
})

test("private labs refuse public access on creation and update", async () => {
  const headers = { ...CONSOLE, "x-touchstone-grant-token": TOKEN }
  const lab = { ...live, hosts: ["127.0.0.1"], allowPrivate: true }
  expect((await post({ ...lab, networkPolicy: "public" }, headers)).status).toBe(400)
  const created = await post(lab, headers)
  expect(created.status).toBe(201)
  expect((await post({ networkPolicy: "public" }, headers, `/api/scopes/${created.json.id}/network-policy`)).status).toBe(400)
})
