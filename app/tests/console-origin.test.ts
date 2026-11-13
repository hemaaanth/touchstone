import "./helpers/isolated-env"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"

// The real dev server (vite.config.ts), on a free loopback port. It proves two
// things the handler tests cannot: the console guard runs before dispatch, and
// a page on another origin cannot read the token-bearing page or /api/.
// Throwaway stores and a synthetic token (the same value as the other test
// files: bun shares one module cache, and the token is read once).
const dir = mkdtempSync(path.join(tmpdir(), "console-origin-test-"))
process.env.TOUCHSTONE_SCOPES_FILE ??= path.join(dir, "scopes.json")
process.env.TOUCHSTONE_GRANTS_FILE ??= path.join(dir, "grants.json")
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

const { build, createLogger, createServer } = await import("vite")
const { default: config } = await import("../vite.config.ts")

const appDir = path.resolve(import.meta.dir, "..")
const FOREIGN = "http://localhost:9999"
const META = "touchstone-console-token"

// Everything the dev server logs. The token must be in none of it.
const logged: string[] = []
const logger = createLogger("info")
for (const level of ["info", "warn", "warnOnce", "error"] as const) logger[level] = (msg: string) => void logged.push(msg)

// No .env file is read, and no dependency is pre-bundled: the tests fetch the
// page and /api/ only. The cache is a throwaway, not the shared node_modules one.
const shared = { ...config, configFile: false as const, root: appDir, envDir: false as const, cacheDir: path.join(dir, "vite-cache"), customLogger: logger }

let server: Awaited<ReturnType<typeof createServer>>
let base = ""

beforeAll(async () => {
  server = await createServer({ ...shared, optimizeDeps: { noDiscovery: true }, server: { ...config.server, port: 0, strictPort: false, hmr: false, watch: null } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === "string") throw new Error("the dev server did not bind a port")
  base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const page = (headers: Record<string, string> = {}) => fetch(`${base}/`, { headers: { accept: "text/html", ...headers } })
// A request with a chosen Host header, as a DNS rebinding page sends it. fetch
// sets Host itself, so this goes through node:http.
const withHost = (host: string, url: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(base + url, { headers: { accept: "text/html", ...headers, host } }, (res) => {
      let body = ""
      res.on("data", (d) => (body += d))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
const own = () => ({ origin: base, "content-type": "application/json", "x-touchstone-grant-token": TOKEN })

describe("dev server: the token-bearing page", () => {
  test("the console's own page load gets the token", async () => {
    const res = await page()
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain(META)
    expect(html.includes(TOKEN)).toBe(true)
    expect(res.headers.get("access-control-allow-origin")).toBe(null)
  })

  test("a page on another localhost port cannot read it", async () => {
    for (const origin of [FOREIGN, "http://127.0.0.1:9999", "https://evil.example", "null"]) {
      const res = await page({ origin })
      const body = await res.text()
      expect(res.status, origin).toBe(403)
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(null)
      expect(body.includes(TOKEN), origin).toBe(false)
      expect(body, origin).not.toContain(META)
    }
  })

  // The Origin rule compares Origin with Host, so it is safe only while Host is
  // restricted (server.allowedHosts). A DNS rebinding page sends its own name as
  // Host, and an Origin that matches it.
  test("a request with a foreign Host does not get the page", async () => {
    const port = new URL(base).port
    for (const host of ["evil.example", `evil.example:${port}`]) {
      for (const headers of [{}, { origin: `http://${host}` }]) {
        const where = `Host: ${host}, ${JSON.stringify(headers)}`
        const res = await withHost(host, "/", headers)
        expect(res.status, where).toBe(403)
        expect(res.body.includes(TOKEN), where).toBe(false)
        expect(res.body, where).not.toContain(META)
        // /api/ is closed to a foreign Host too, for a read as well.
        expect((await withHost(host, "/api/scopes", headers)).status, `/api/scopes, ${where}`).toBe(403)
      }
    }
    // The same helper with the console's own Host gets the page.
    const own = await withHost(`127.0.0.1:${port}`, "/")
    expect(own.status).toBe(200)
    expect(own.body).toContain(META)
  })

  test("a preflight from another origin is not granted", async () => {
    const res = await fetch(`${base}/api/scopes`, { method: "OPTIONS", headers: { origin: FOREIGN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-touchstone-grant-token" } })
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBe(null)
    expect(res.headers.get("access-control-allow-headers")).toBe(null)
  })
})

describe("dev server: /api/", () => {
  // The Findings page copies its texts from these reads. They pass the same
  // Origin and Host guard as every other read.
  test("the findings list and the copy routes refuse another origin and another Host", async () => {
    const host = `evil.example:${new URL(base).port}`
    for (const url of ["/api/findings", "/api/findings/zz-none?events=0", "/api/findings/zz-none/report?format=agent", "/api/findings/zz-none/report?format=md"]) {
      expect((await fetch(base + url, { headers: { origin: base } })).status, url).not.toBe(403)
      expect((await fetch(base + url, { headers: { origin: FOREIGN } })).status, url).toBe(403)
      expect((await withHost(host, url)).status, url).toBe(403)
    }
  })

  test("a read works from the console and not from another origin", async () => {
    for (const url of ["/api/scopes", "/api/grants", "/api/settings", "/api/runs", "/api/models"]) {
      expect((await fetch(base + url)).status, url).toBe(200)
      expect((await fetch(base + url, { headers: { origin: base } })).status, url).toBe(200)
      const foreign = await fetch(base + url, { headers: { origin: FOREIGN } })
      expect(foreign.status, url).toBe(403)
      expect(foreign.headers.get("access-control-allow-origin"), url).toBe(null)
    }
  })

  test("the guard runs before dispatch: a write to any /api/ path is refused", async () => {
    // /api/models has a read handler only, /api/health goes to the URL-only
    // reader, and /api/no-such-route has no handler at all.
    for (const url of ["/api/runs", "/api/scopes", "/api/models", "/api/health", "/api/no-such-route"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const where = `${method} ${url}`
        const { "x-touchstone-grant-token": _token, ...noToken } = own()
        const { origin: _origin, ...noOrigin } = own()
        expect((await fetch(base + url, { method, headers: noToken })).status, `${where}: no token`).toBe(403)
        expect((await fetch(base + url, { method, headers: { ...own(), "x-touchstone-grant-token": "x".repeat(TOKEN.length) } })).status, `${where}: wrong token`).toBe(403)
        expect((await fetch(base + url, { method, headers: noOrigin })).status, `${where}: missing Origin`).toBe(403)
        expect((await fetch(base + url, { method, headers: { ...own(), origin: FOREIGN } })).status, `${where}: foreign Origin`).toBe(403)
        if (method !== "DELETE") {
          expect((await fetch(base + url, { method, headers: { ...own(), "content-type": "text/plain" }, body: "{}" })).status, `${where}: text/plain`).toBe(415)
        }
      }
    }
  })

  test("the console's own write passes the guard and reaches the handler", async () => {
    // The run registry's own answer for a model alias it does not know. No run starts.
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: own(), body: JSON.stringify({ alias: "no-such-model-alias" }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/unknown model alias/)
  })
})

describe("the token stays out of the logs and out of a build", () => {
  test("the dev server logged nothing that holds the token", () => {
    expect(logged.some((line) => line.includes(TOKEN))).toBe(false)
  })

  test("a build output does not hold the token", async () => {
    const outDir = path.join(dir, "dist")
    // The build writes to the throwaway outDir only: app/dist is as it was before.
    const distBefore = existsSync(path.join(appDir, "dist"))
    await build({ ...shared, logLevel: "silent", build: { outDir, emptyOutDir: true } })
    const html = readFileSync(path.join(outDir, "index.html"), "utf8")
    expect(html).toContain('<div id="root">')
    expect(html).not.toContain(META)
    // No file of the build holds the token.
    const files = (d: string): string[] => readdirSync(d).flatMap((name) => (statSync(path.join(d, name)).isDirectory() ? files(path.join(d, name)) : [path.join(d, name)]))
    const all = files(outDir)
    expect(all.length).toBeGreaterThan(1)
    expect(all.filter((f) => readFileSync(f).includes(TOKEN)).map((f) => path.relative(outDir, f))).toEqual([])
    expect(existsSync(path.join(appDir, "dist"))).toBe(distBefore)
  }, 120_000)
})
