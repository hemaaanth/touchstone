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

test("one scope preserves repositories, websites and deployments through a joined run workspace", async () => {
  const members = [{ kind: "repo", url: "https://github.com/sparkdotfi/sparklend" }]
  const contracts = [{ chainId: 1, address: "0x00000000000000000000000000000000000000AB" }]
  const r = await post({ ...live, members, contracts }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
  expect(r.status).toBe(201)
  expect(r.json.members[0].url).toBe(members[0].url)
  expect(r.json.origins).toEqual(["https://app.example.com"])
  expect(r.json.contracts).toEqual([{ chainId: 1, address: contracts[0].address.toLowerCase() }])
  expect(r.json.packs).toContain("review")
  expect(r.json.packs).toContain("contracts")
  // @ts-expect-error — plain .mjs module
  const { getUserScope, removeScope } = await import("../../spike/lib/scopes-store.mjs")
  // @ts-expect-error — plain .mjs module
  const { pickTarget, prepareMultiWorkspace, scopeEnv } = await import("../../spike/lib/targets.mjs")
  // @ts-expect-error — plain .mjs module
  const { memberDir } = await import("../../spike/packs/multi.mjs")
  // @ts-expect-error — plain .mjs module
  const { planModules } = await import("../../spike/lib/modules.mjs")
  const target = pickTarget({ id: r.json.id, pack: "review" })
  const plan = planModules(target, undefined, undefined, ["review", "web", "contracts"])
  expect(plan.find((m: { id: string }) => m.id === "fetch").on).toBe(true)
  const notes = scopeEnv(target).SCOPE_NOTES
  expect(notes).toContain(members[0].url)
  expect(notes).toContain("https://app.example.com")
  expect(notes).toContain(`eip155:1:${contracts[0].address.toLowerCase()}`)
  const ws = await prepareMultiWorkspace(target, { packs: ["review", "web", "contracts"], modules: plan })
  try {
    const cfg = (dir: string) => JSON.parse(readFileSync(path.join(dir, ".touchstone.json"), "utf8"))
    expect(cfg(memberDir(ws, "web")).origins).toEqual(["https://app.example.com"])
    expect(cfg(memberDir(ws, "review")).links).toEqual([members[0].url])
    expect(cfg(memberDir(ws, "contracts")).contracts).toEqual(r.json.contracts)
    expect(cfg(ws).links).toEqual([members[0].url])
    expect(cfg(ws).contracts).toEqual(r.json.contracts)
    expect(getUserScope(r.json.id).permission.grantId).toBe(grants()[0].id)
  } finally { rmSync(ws, { recursive: true, force: true }) }
  removeScope(r.json.id)
  expect(grants()).toEqual([])
})

test("malformed mixed assets save neither a scope nor a grant", async () => {
  for (const assets of [
    { members: [{ kind: "repo", url: "https://evil.example/repo" }] },
    { contracts: [{ chainId: 0, address: "0x123" }] },
    { contracts: [{ chainId: 1, address: "0x123" }] },
    { contracts: "not a list" },
  ]) {
    const r = await post({ ...live, ...assets }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(400)
    expect(grants()).toEqual([])
    expect(existsSync(SCOPES)).toBe(false)
  }
})

test("a contract-only scope retains chain identity and can prepare a contract workspace", async () => {
  const contracts = [1, 10].map((chainId) => ({ chainId, address: "0x0000000000000000000000000000000000000001" }))
  const r = await post({ title: "Deployments", contracts }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
  expect(r.status).toBe(201)
  expect(r.json.contracts).toEqual(contracts)
  // @ts-expect-error — plain .mjs module
  const { pickTarget, prepareRunWorkspace, scopeEnv } = await import("../../spike/lib/targets.mjs")
  const target = pickTarget({ id: r.json.id, pack: "contracts" })
  expect(scopeEnv(target).SCOPE_NOTES).toContain("eip155:10:")
  const ws = await prepareRunWorkspace(target)
  try {
    expect(JSON.parse(readFileSync(path.join(ws, ".touchstone.json"), "utf8")).contracts).toEqual(contracts)
  } finally { rmSync(ws, { recursive: true, force: true }) }
  expect(grants()).toEqual([])
})

test("mixed scopes preserve the explicit network policy when selecting code and web modules", async () => {
  // @ts-expect-error — plain .mjs module
  const { pickTarget, targetSummary } = await import("../../spike/lib/targets.mjs")
  const headers = { ...CONSOLE, "x-touchstone-grant-token": TOKEN }
  for (const networkPolicy of ["strict", "public"]) {
    const created = await post({
      ...live, networkPolicy,
      members: [{ kind: "repo", url: "https://github.com/sparkdotfi/sparklend" }],
      contracts: [{ chainId: 1, address: "0x0000000000000000000000000000000000000001" }],
    }, headers)
    expect(created.status).toBe(201)
    expect(created.json.networkPolicy).toBe(networkPolicy)
    for (const pack of ["review", "contracts", "web"]) {
      const target = pickTarget({ id: created.json.id, pack })
      expect(target.networkPolicy).toBe(networkPolicy)
      const summary = targetSummary(target)
      expect(summary.networkPolicy).toBe(networkPolicy)
      expect(summary.members.length).toBe(1)
      expect(summary.contracts.length).toBe(1)
      expect(summary.origins).toEqual(["https://app.example.com"])
    }
  }
})
