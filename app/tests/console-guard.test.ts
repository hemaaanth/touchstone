import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The console guard: every write under /api/ needs the console token, the
// console's own origin and, with a body, a JSON content type. One negative
// test per route family and one positive test. Throwaway stores; the real
// spike/data files are never touched. Every token here is synthetic. The value
// matches the other test files: bun shares one module cache across test files,
// and the token is read once, when the module loads.
const dir = mkdtempSync(path.join(tmpdir(), "console-guard-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

// @ts-expect-error — plain .mjs module, no types
const { handleRuns, handleFindings, handleScopes, handleGrants, handleSettings } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { consoleWriteRefusal, foreignOrigin } = await import("../server/settings.mjs")

beforeEach(() => {
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  rmSync(SCOPES, { force: true })
  rmSync(GRANTS, { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Headers = Record<string, string | string[]>
type Handler = (req: unknown, res: unknown) => Promise<boolean>

const HOST = "127.0.0.1:5207"
const GOOD: Headers = { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", "x-touchstone-grant-token": TOKEN }
const without = (key: string): Headers => Object.fromEntries(Object.entries(GOOD).filter(([k]) => k !== key))

// The bad requests. Each one is the console's own request with one fault.
const BAD: { name: string; headers: Headers; status: number; hasBody?: true }[] = [
  { name: "no token", headers: without("x-touchstone-grant-token"), status: 403 },
  { name: "wrong token, same length", headers: { ...GOOD, "x-touchstone-grant-token": "x".repeat(TOKEN.length) }, status: 403 },
  { name: "wrong token, other length", headers: { ...GOOD, "x-touchstone-grant-token": `${TOKEN}x` }, status: 403 },
  { name: "foreign Origin", headers: { ...GOOD, origin: "http://localhost:9999" }, status: 403 },
  { name: "missing Origin", headers: without("origin"), status: 403 },
  // A DELETE reads no body, so this fault applies to the other writes only.
  { name: "text/plain body", headers: { ...GOOD, "content-type": "text/plain" }, status: 415, hasBody: true },
]

// The guard's own answers. A handler never sends one of these.
const GUARD_ERRORS = [
  "This request did not come from the console's own page. Reload the page and try again.",
  "The console sends each change as JSON. Reload the page and try again.",
  "This page is out of date. Reload the page and try again.",
]

// A request that records whether a handler read its body, and a response that
// counts its answers.
async function call(handler: Handler, method: string, url: string, headers: Headers, body: unknown = {}) {
  let bodyRead = false
  const on: Record<string, (arg?: unknown) => void> = {}
  const req = {
    method,
    url,
    headers,
    on(ev: string, cb: (arg?: unknown) => void) {
      bodyRead = true
      on[ev] = cb
      if (ev === "end") {
        setTimeout(() => {
          on.data?.(Buffer.from(JSON.stringify(body)))
          on.end?.()
        }, 0)
      }
      return req
    },
  }
  const res = {
    statusCode: 0,
    body: "",
    answers: 0,
    setHeader() {},
    end(s?: string) {
      this.answers += 1
      this.body = s ?? ""
    },
  }
  const handled = await handler(req, res)
  return { handled, status: res.statusCode, answers: res.answers, bodyRead, json: res.body ? JSON.parse(res.body) : null }
}

const upload = { title: "Guard lab", members: [{ kind: "folder", name: "lab", files: [{ path: "Vault.sol", content: "contract Vault {}" }] }] }
const grant = { hosts: ["guard.example.com"], kind: "operator-owned", ownership: true }

// Every write route of the console, by route family.
const FAMILIES: { family: string; handler: Handler; routes: [method: string, url: string, body?: unknown][] }[] = [
  {
    family: "runs",
    handler: handleRuns,
    routes: [
      ["POST", "/api/runs", { alias: "no-such-model-alias" }],
      ["POST", "/api/runs/no-such-run/steer", { text: "hello" }],
      ["POST", "/api/runs/no-such-run/stop"],
      ["POST", "/api/runs/no-such-run/archive", { archived: true }],
      ["POST", "/api/runs/no-such-run/rename", { name: "x" }],
      ["POST", "/api/runs/no-such-run/delete"],
    ],
  },
  { family: "findings", handler: handleFindings, routes: [["POST", "/api/findings/no-such-finding/dismiss", { dismissed: true }]] },
  { family: "scopes", handler: handleScopes, routes: [["POST", "/api/scopes", upload], ["DELETE", "/api/scopes/no-such-scope"]] },
  { family: "grants", handler: handleGrants, routes: [["POST", "/api/grants", grant], ["DELETE", "/api/grants/no-such-grant"]] },
  {
    family: "settings",
    handler: handleSettings,
    routes: [
      ["POST", "/api/settings/providers", { label: "Guard", baseUrl: "https://guard.example.com/v1", models: [{ id: "m" }] }],
      ["POST", "/api/settings/discover", { baseUrl: "https://guard.example.com/v1" }],
      ["POST", "/api/settings/default", { provider: "guard", model: "m" }],
      ["POST", "/api/settings/budget", { budgetUsd: 1 }],
      ["POST", "/api/settings/execution", { backend: "local" }],
      ["DELETE", "/api/settings/providers/no-such-provider"],
    ],
  },
]

describe("console guard: a bad write is refused and the handler does not run", () => {
  for (const { family, handler, routes } of FAMILIES) {
    test(`${family}: no token, wrong token, foreign Origin, missing Origin, text/plain`, async () => {
      for (const [method, url, body] of routes) {
        for (const bad of BAD) {
          if (bad.hasBody && method === "DELETE") continue
          const r = await call(handler, method, url, bad.headers, body)
          const where = `${method} ${url}: ${bad.name}`
          expect(r.handled, where).toBe(true)
          expect(r.status, where).toBe(bad.status)
          // One answer, and it is the guard's. The handler read no body.
          expect(r.answers, where).toBe(1)
          expect(GUARD_ERRORS, where).toContain(r.json.error)
          expect(r.bodyRead, where).toBe(false)
        }
      }
      // Nothing was saved.
      expect(existsSync(SCOPES)).toBe(false)
      expect(existsSync(GRANTS)).toBe(false)
    })
  }

  test("a method that is not GET or HEAD is a write: PUT and PATCH are guarded too", async () => {
    for (const method of ["PUT", "PATCH", "OPTIONS"]) {
      const r = await call(handleScopes, method, "/api/scopes", without("x-touchstone-grant-token"))
      expect(r.status, method).toBe(403)
    }
  })

  test("a read needs no token", async () => {
    const bare = { host: HOST }
    expect((await call(handleRuns, "GET", "/api/runs", bare)).status).toBe(200)
    expect((await call(handleScopes, "GET", "/api/scopes", bare)).status).toBe(200)
    expect((await call(handleGrants, "GET", "/api/grants", bare)).status).toBe(200)
    expect((await call(handleSettings, "GET", "/api/settings", bare)).status).toBe(200)
  })
})

describe("console guard: the console's own write reaches the handler", () => {
  // Each answer below is the handler's normal answer. No run starts and no
  // Settings file is written: these requests fail inside the handler, or they
  // use the throwaway stores.
  test("runs: every run route answers as the run registry does", async () => {
    const create = await call(handleRuns, "POST", "/api/runs", GOOD, { alias: "no-such-model-alias" })
    expect(create.status).toBe(400)
    expect(GUARD_ERRORS).not.toContain(create.json.error)
    for (const [action, body] of [["steer", { text: "hello" }], ["stop", {}], ["archive", { archived: true }], ["rename", { name: "x" }], ["delete", {}]] as const) {
      const r = await call(handleRuns, "POST", `/api/runs/no-such-run/${action}`, GOOD, body)
      expect(r.status, action).toBe(409)
      expect(r.json.error, action).toBe("no such run")
    }
  })

  test("findings: dismiss answers as the ledger does", async () => {
    const r = await call(handleFindings, "POST", "/api/findings/no-such-finding/dismiss", GOOD, { dismissed: true })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("no such finding")
  })

  test("scopes: a code scope is added and deleted", async () => {
    const add = await call(handleScopes, "POST", "/api/scopes", GOOD, upload)
    expect(add.status).toBe(201)
    const del = await call(handleScopes, "DELETE", `/api/scopes/${encodeURIComponent(add.json.id)}`, without("content-type"))
    expect(del.status).toBe(200)
  })

  test("grants: a grant is added and revoked", async () => {
    const add = await call(handleGrants, "POST", "/api/grants", GOOD, grant)
    expect(add.status).toBe(201)
    const del = await call(handleGrants, "DELETE", `/api/grants/${add.json.id}`, without("content-type"))
    expect(del.status).toBe(200)
  })

  test("settings: a write reaches Settings", async () => {
    const post = await call(handleSettings, "POST", "/api/settings/execution", GOOD, { backend: "cloud" })
    expect(post.status).toBe(400)
    expect(post.json.error).toMatch(/backend must be/)
    const del = await call(handleSettings, "DELETE", "/api/settings/providers/no-such-provider", without("content-type"))
    expect(del.status).toBe(400)
    expect(del.json.error).toMatch(/no saved provider/)
  })
})

describe("console guard: the rules", () => {
  const req = (method: string, headers: Headers) => ({ method, headers })

  test("each refusal is a full sentence that tells the operator to reload", () => {
    for (const bad of BAD) {
      const refusal = consoleWriteRefusal(req("POST", bad.headers))
      expect(refusal.error, bad.name).toMatch(/^[A-Z].*Reload the page and try again\.$/)
    }
  })

  test("the token compare is crypto.timingSafeEqual, on equal lengths only", () => {
    const compare = spyOn(crypto, "timingSafeEqual")
    try {
      // A wrong type or a wrong length is refused before any compare.
      const early: Headers[] = [
        without("x-touchstone-grant-token"),
        { ...GOOD, "x-touchstone-grant-token": [TOKEN, TOKEN] },
        { ...GOOD, "x-touchstone-grant-token": "" },
        { ...GOOD, "x-touchstone-grant-token": TOKEN.slice(1) },
        { ...GOOD, "x-touchstone-grant-token": `${TOKEN}x` },
      ]
      for (const headers of early) expect(consoleWriteRefusal(req("POST", headers))?.status).toBe(403)
      expect(compare).toHaveBeenCalledTimes(0)

      // A wrong token of the right length goes through the constant-time compare.
      expect(consoleWriteRefusal(req("POST", { ...GOOD, "x-touchstone-grant-token": "x".repeat(TOKEN.length) }))?.status).toBe(403)
      expect(compare).toHaveBeenCalledTimes(1)
      const [a, b] = compare.mock.calls[0] as [Buffer, Buffer]
      expect(a.length).toBe(b.length)

      // So does the right token.
      expect(consoleWriteRefusal(req("POST", GOOD))).toBe(null)
      expect(compare).toHaveBeenCalledTimes(2)
    } finally {
      compare.mockRestore()
    }
  })

  test("foreignOrigin: an Origin that is not the console's own", () => {
    for (const origin of ["http://localhost:9999", "http://127.0.0.1:9999", "https://evil.example", "null", ""]) {
      expect(foreignOrigin(req("GET", { host: HOST, origin })), origin).toBe(true)
    }
    // No Origin (a same-origin read, a page load) and the console's own Origin pass.
    expect(foreignOrigin(req("GET", { host: HOST }))).toBe(false)
    expect(foreignOrigin(req("GET", { host: HOST, origin: `http://${HOST}` }))).toBe(false)
    expect(foreignOrigin(req("POST", { host: "x.getbb.app", origin: "https://x.getbb.app" }))).toBe(false)
  })
})

describe("the console token is never written to a log", () => {
  // A child process, so the token comes from a token file as it does on a real
  // server (TOUCHSTONE_GRANT_TOKEN unset). The file holds a synthetic token.
  test("a grants GET and refused writes print nothing that holds the token", () => {
    const SYNTHETIC = "synthetic-console-token-7f3a9c2e41d8"
    const tokenFile = path.join(dir, "console-token")
    writeFileSync(tokenFile, `${SYNTHETIC}\n`, { mode: 0o600 })
    const script = `
      const { handleGrants } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../server/runs-http.mjs"))})
      const host = "127.0.0.1:5207"
      const base = { host, origin: "http://" + host, "content-type": "application/json" }
      const requests = [
        ["GET", "/api/grants", { host }],
        ["GET", "/api/grants", { host }],
        ["POST", "/api/grants", base],
        ["POST", "/api/grants", { ...base, "x-touchstone-grant-token": "wrong" }],
        ["DELETE", "/api/grants/x", { ...base, origin: "http://localhost:9999" }],
      ]
      for (const [method, url, headers] of requests) {
        const res = { statusCode: 0, setHeader() {}, end(s) { this.body = s ?? "" } }
        await handleGrants({ method, url, headers, on() {} }, res)
        console.log(method, url, res.statusCode, res.body)
      }
      console.log("done")
    `
    const env: Record<string, string | undefined> = { ...process.env, TOUCHSTONE_GRANT_TOKEN_FILE: tokenFile, TOUCHSTONE_GRANTS_FILE: path.join(dir, "child-grants.json") }
    delete env.TOUCHSTONE_GRANT_TOKEN
    const child = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", cwd: path.resolve(import.meta.dir, "..") })
    const out = `${child.stdout}\n${child.stderr}`
    // The child ran every request, and the token is in none of its output.
    expect(child.status).toBe(0)
    expect(child.stdout).toContain("GET /api/grants 200")
    expect(child.stdout).toContain("POST /api/grants 403")
    expect(child.stdout).toContain("done")
    // A boolean, so a failure never prints the output.
    expect(out.includes(SYNTHETIC)).toBe(false)
  })
})
