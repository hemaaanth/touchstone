import "./helpers/isolated-env"
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Rotating the console token (L11). The server route (settings.mjs
// handleConsoleToken), the guard every write passes, the grant CLI path (a new
// process reading the token file), and the client (api.ts, console-token.ts).
// Every token here lives in a throwaway file through TOUCHSTONE_GRANT_TOKEN_FILE,
// never spike/data. No token value is printed: an assertion compares, and a
// failure names only the case.
const dir = mkdtempSync(path.join(tmpdir(), "console-token-rotate-"))
const FILE = path.join(dir, "console-token")
const STORE = path.resolve(import.meta.dir, "../../spike/lib/grant-store.mjs")
// bun shares one process (and env) across test files: restore what we change.
const saved = { token: process.env.TOUCHSTONE_GRANT_TOKEN, file: process.env.TOUCHSTONE_GRANT_TOKEN_FILE }

// @ts-expect-error — plain .mjs module, no types
const settings = await import("../server/settings.mjs")
// @ts-expect-error — plain .mjs module, no types
const store = await import("../../spike/lib/grant-store.mjs")
const api = await import("../src/lib/api.ts")
const { onStalePage, tokenHeaders } = await import("../src/lib/console-token.ts")

beforeEach(() => {
  // A file-backed token (the helper pins one, which cannot be rotated).
  delete process.env.TOUCHSTONE_GRANT_TOKEN
  process.env.TOUCHSTONE_GRANT_TOKEN_FILE = FILE
  rmSync(FILE, { force: true })
})
afterAll(() => {
  if (saved.token === undefined) delete process.env.TOUCHSTONE_GRANT_TOKEN
  else process.env.TOUCHSTONE_GRANT_TOKEN = saved.token
  if (saved.file === undefined) delete process.env.TOUCHSTONE_GRANT_TOKEN_FILE
  else process.env.TOUCHSTONE_GRANT_TOKEN_FILE = saved.file
  try { chmodSync(dir, 0o700) } catch { /* already */ }
  rmSync(dir, { recursive: true, force: true })
})

const HOST = "127.0.0.1:5236"
const headers = (token: string | undefined, extra: Record<string, string> = {}) => ({
  host: HOST,
  origin: `http://${HOST}`,
  "content-type": "application/json",
  ...(token === undefined ? {} : { "x-touchstone-grant-token": token }),
  ...extra,
})
const write = (token: string | undefined, extra: Record<string, string> = {}) => ({ method: "POST", url: "/api/runs/x/rename", headers: headers(token, extra) })

// One call of the rotate route, with a response that records its answer.
function rotate(token: string | undefined, extra: Record<string, string> = {}) {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v },
    end(b: string) { this.body = b },
  }
  const handled = settings.handleConsoleToken({ method: "POST", url: "/api/console-token/rotate", headers: headers(token, extra) }, res)
  const json = res.body ? JSON.parse(res.body) : {}
  return { handled, status: res.statusCode, json, headers: res.headers }
}
const tokenInNewProcess = () => {
  const env: Record<string, string | undefined> = { ...process.env, TOUCHSTONE_GRANT_TOKEN_FILE: FILE }
  delete env.TOUCHSTONE_GRANT_TOKEN
  const r = spawnSync(process.execPath, ["-e", `const m = await import(${JSON.stringify(STORE)}); process.stdout.write(m.consoleToken())`], { env, encoding: "utf8" })
  return r.stdout
}

describe("server: rotate the console token", () => {
  test("after a rotate the old token gets 403 and the new one works", () => {
    const old = store.consoleToken()
    expect(settings.consoleWriteRefusal(write(old))).toBe(null)
    const r = rotate(old)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.headers["cache-control"]).toBe("no-store")
    const next = r.json.token as string
    expect(typeof next).toBe("string")
    expect(next === old).toBe(false)
    expect(settings.consoleWriteRefusal(write(old))).toEqual({ status: 403, error: settings.STALE_PAGE })
    expect(settings.consoleWriteRefusal(write(next))).toBe(null)
    expect(readFileSync(FILE, "utf8") === `${next}\n`).toBe(true)
  })

  test("the grant CLI path (a new process reading the file) gets the new token", () => {
    const old = store.consoleToken()
    expect(tokenInNewProcess() === old).toBe(true)
    const next = rotate(old).json.token as string
    expect(tokenInNewProcess() === next).toBe(true)
  })

  test("a rotate without a valid token is 403 and changes nothing", () => {
    const old = store.consoleToken()
    for (const given of [undefined, "", "x".repeat(old.length), `${old}x`]) {
      const r = rotate(given)
      expect(r.status).toBe(403)
      expect(r.json.token).toBeUndefined()
    }
    expect(store.consoleToken() === old).toBe(true)
  })

  test("a rotate from a foreign Origin, or with no Origin, is 403 and changes nothing", () => {
    const old = store.consoleToken()
    expect(rotate(old, { origin: "http://evil.example" }).status).toBe(403)
    const noOrigin = { ...headers(old) } as Record<string, string>
    delete noOrigin.origin
    const res = { statusCode: 0, setHeader() {}, end() {} }
    settings.handleConsoleToken({ method: "POST", url: "/api/console-token/rotate", headers: noOrigin }, res)
    expect(res.statusCode).toBe(403)
    expect(store.consoleToken() === old).toBe(true)
  })

  test("only POST rotates", () => {
    const old = store.consoleToken()
    const res = { statusCode: 0, setHeader() {}, end() {} }
    settings.handleConsoleToken({ method: "GET", url: "/api/console-token/rotate", headers: headers(old) }, res)
    expect(res.statusCode).toBe(405)
    expect(store.consoleToken() === old).toBe(true)
  })

  test("two rotates at once leave one valid token and a whole file", async () => {
    const old = store.consoleToken()
    const [a, b] = await Promise.all([Promise.resolve().then(() => rotate(old)), Promise.resolve().then(() => rotate(old))])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 403])
    const winner = (a.status === 200 ? a : b).json.token as string
    expect(store.consoleToken() === winner).toBe(true)
    expect(readFileSync(FILE, "utf8") === `${winner}\n`).toBe(true)
    expect(readdirSync(dir)).toEqual(["console-token"])
    expect(settings.consoleWriteRefusal(write(winner))).toBe(null)
    expect(settings.consoleWriteRefusal(write(old))?.status).toBe(403)
  })

  test("a failed write answers 500 without the token, and the old token stays valid", () => {
    const old = store.consoleToken()
    chmodSync(dir, 0o500)
    let r
    try {
      r = rotate(old)
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(r.status).toBe(500)
    expect(r.json.token).toBeUndefined()
    expect(String(r.json.error)).toContain("The old token still works")
    expect(String(r.json.error).includes(old)).toBe(false)
    expect(settings.consoleWriteRefusal(write(old))).toBe(null)
    expect(readdirSync(dir)).toEqual(["console-token"])
  })

  test("the token is never logged", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m))
    try {
      const old = store.consoleToken()
      const next = rotate(old).json.token as string
      rotate(old) // a refused one too
      for (const s of spies) {
        for (const call of s.mock.calls) {
          const line = call.map(String).join(" ")
          expect(line.includes(old) || line.includes(next)).toBe(false)
        }
      }
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})

describe("client: the page that rotates keeps working; a stale page is told", () => {
  const g = globalThis as { fetch: unknown; document?: unknown; window?: unknown }
  const original = { fetch: g.fetch, document: g.document, window: g.window }
  const meta = { content: "page-token-before" }
  const restore = () => {
    g.fetch = original.fetch
    g.document = original.document
    g.window = original.window
  }

  test("after rotateConsoleToken the page sends the new token, and the token is not returned to the caller", async () => {
    g.document = { querySelector: (sel: string) => (sel.includes("touchstone-console-token") ? meta : null) }
    const sent: Record<string, string>[] = []
    g.fetch = async (url: string, init: { headers?: Record<string, string> } = {}) => {
      sent.push(init.headers ?? {})
      const body = url === "/api/console-token/rotate" ? { token: "page-token-after" } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    }
    try {
      const out = await api.rotateConsoleToken()
      expect(out).toBeUndefined()
      expect(sent[0]["x-touchstone-grant-token"]).toBe("page-token-before")
      expect(tokenHeaders()["x-touchstone-grant-token"]).toBe("page-token-after")
      await api.renameRun("run", "name")
      expect(sent[1]["x-touchstone-grant-token"]).toBe("page-token-after")
    } finally {
      restore()
    }
  })

  test("a write refused with 403 tells the app (the stale-page notice) with the server's own sentence", async () => {
    g.window = new EventTarget()
    g.document = { querySelector: () => ({ content: "old" }) }
    g.fetch = async () => new Response(JSON.stringify({ error: settings.STALE_PAGE }), { status: 403, headers: { "content-type": "application/json" } })
    const heard: string[] = []
    const off = onStalePage((m) => heard.push(m))
    try {
      // A rename shows no error of its own; the notice is the only message.
      await expect(api.renameRun("run", "name")).rejects.toThrow(settings.STALE_PAGE)
      await expect(api.deleteRun("run")).rejects.toThrow(settings.STALE_PAGE)
      expect(heard).toEqual([settings.STALE_PAGE, settings.STALE_PAGE])
    } finally {
      off()
      restore()
    }
  })

  test("another refusal (409) is not a stale page", async () => {
    g.window = new EventTarget()
    g.fetch = async () => new Response(JSON.stringify({ error: "the run is not working" }), { status: 409, headers: { "content-type": "application/json" } })
    const heard: string[] = []
    const off = onStalePage((m) => heard.push(m))
    try {
      await expect(api.stopRun("run")).rejects.toThrow("the run is not working")
      expect(heard).toEqual([])
    } finally {
      off()
      restore()
    }
  })
})
