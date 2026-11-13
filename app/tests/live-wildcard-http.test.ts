import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// A "*.example.com" entry through the real create route (POST /api/scopes,
// kind live), then the real reach gate. The form sends plain websites as
// origins and a wildcard as the bare "*.example.com". Every other spelling with
// a star is refused with a sentence; it is never dropped from the grant.
// Throwaway stores. The token matches the other HTTP tests: bun shares one
// module cache across test files, and the token is read once.
const dir = mkdtempSync(path.join(tmpdir(), "live-wildcard-http-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

// @ts-expect-error — plain .mjs module, no types
const { handleScopes } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { getTarget } = await import("../../spike/lib/targets.mjs")
// @ts-expect-error — plain .mjs module, no types
const { enforceReach } = await import("../../spike/lib/reach.mjs")

beforeEach(() => {
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  rmSync(SCOPES, { force: true })
  rmSync(GRANTS, { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SIGNED = { origin: "http://localhost:5173", host: "localhost:5173", "content-type": "application/json", "x-touchstone-grant-token": TOKEN }

async function create(hosts: string[]) {
  const body = { kind: "live", title: "", hosts, permission: true, pack: ["web"] }
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const req = {
    method: "POST",
    url: "/api/scopes",
    headers: SIGNED,
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
const grants = () => (existsSync(GRANTS) ? JSON.parse(readFileSync(GRANTS, "utf8")) : [])
const scopes = () => (existsSync(SCOPES) ? JSON.parse(readFileSync(SCOPES, "utf8")) : [])
// Would a run of this scope be let through to these hosts? The real gate, with
// the scope's own grant only.
const reaches = (id: string, hosts: string[]) => {
  try {
    enforceReach({ ...getTarget(id), hosts, origins: undefined })
    return true
  } catch {
    return false
  }
}

describe("a *. entry through POST /api/scopes", () => {
  test("the form's exact payload for example.com + *.example.com: the scope and its grant hold both", async () => {
    const r = await create(["https://example.com", "*.example.com"])
    expect(r.status).toBe(201)
    expect(r.json.hosts).toEqual(["example.com", "*.example.com"])
    expect(grants()).toHaveLength(1)
    expect(grants()[0].hosts).toEqual(["example.com", "*.example.com"])
    expect(reaches(r.json.id, ["example.com"])).toBe(true)
    expect(reaches(r.json.id, ["a.example.com", "a.b.example.com"])).toBe(true)
  })

  test("a wildcard never covers the bare parent unless the parent is listed", async () => {
    const r = await create(["https://app.example.com", "*.example.com"])
    expect(r.status).toBe(201)
    expect(reaches(r.json.id, ["shop.example.com"])).toBe(true)
    expect(reaches(r.json.id, ["example.com"])).toBe(false)
  })

  test("a wildcard for one domain never covers another domain", async () => {
    const r = await create(["https://example.com", "*.example.com"])
    for (const other of ["evilexample.com", "example.com.evil.test", "xexample.com", "example.co", "a.example.net"]) {
      expect(reaches(r.json.id, [other])).toBe(false)
    }
  })

  test("every other spelling with a star is refused with a sentence, and nothing is saved", async () => {
    for (const bad of ["https://%2A.example.com", "%2a.example.com", "https://*.example.com", "*.*.example.com", "a.*.example.com", "**.example.com", "*.example.com:8443", "*.example.com/admin", "*.10.0.0", "*example.com", "*."]) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/is not a wildcard entry Touchstone accepts\. Write it as \*\.example\.com: a star, a dot and a domain name, with no scheme, port or path\.$/)
      expect(scopes()).toEqual([])
      expect(grants()).toEqual([])
    }
  })

  test("too broad: *.com and *.co.uk are refused at the route, a listed public suffix by the grant store", async () => {
    for (const [bad, why] of [["*.com", /^"\*\.com" is too broad: a wildcard needs a domain name of at least two labels after "\*\.", so \*\.example\.com, never \*\.com\.$/], ["*.co.uk", /co\.uk is a country's second-level domain/], ["*.ltd.uk", /public suffix/]] as const) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(why)
      expect(grants()).toEqual([])
    }
  })

  test("a wildcard first is refused: a run sends its requests to the first website", async () => {
    const r = await create(["*.example.com", "https://example.com"])
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("List a plain website before a wildcard entry, for example example.com, then *.example.com. A run sends its requests to the first website.")
    expect(grants()).toEqual([])
  })

  test("a wildcard over names that belong to other people is refused with a sentence, and nothing is saved", async () => {
    const cases: [string, RegExp][] = [
      // resolves any name to any address, at any depth
      ["*.nip.io", /^"\*\.nip\.io" covers hosts that belong to other people: names under nip\.io are shared or resolve to any address\./],
      ["*.1.2.3.4.nip.io", /names under nip\.io/],
      ["*.sslip.io", /names under sslip\.io/],
      ["*.lvh.me", /names under lvh\.me/],
      // a provider namespace, at any depth
      ["*.amazonaws.com", /names under amazonaws\.com/],
      ["*.eu-west-1.amazonaws.com", /names under amazonaws\.com/],
      ["*.blob.core.windows.net", /names under windows\.net/],
      // a shared platform itself
      ["*.vercel.app", /^"\*\.vercel\.app" covers hosts that belong to other people: every customer of vercel\.app gets a name under it\. Use your own name, for example \*\.yourapp\.vercel\.app\.$/],
      ["*.blogspot.com", /every customer of blogspot\.com/],
      ["*.up.railway.app", /every customer of up\.railway\.app/],
      ["*.ngrok-free.app", /every customer of ngrok-free\.app/],
      // a country's second-level domain
      ["*.com.de", /^"\*\.com\.de" covers hosts that belong to other people: com\.de is a country's second-level domain\./],
      ["*.co.nz", /co\.nz is a country's second-level domain/],
      ["*.gov.br", /gov\.br is a country's second-level domain/],
      // letters outside ASCII: the punycode form is named
      ["*.bücher.de", /^"\*\.bücher\.de" has letters outside plain ASCII\. Write the punycode form: \*\.xn--bcher-kva\.de\.$/],
    ]
    for (const [bad, why] of cases) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(why)
      expect(scopes()).toEqual([])
      expect(grants()).toEqual([])
    }
  })

  test("a wildcard under one tenant's own name on a platform, and an ordinary domain, are still accepted", async () => {
    for (const ok of ["*.example.com", "*.app.example.co.uk", "*.myapp.vercel.app", "*.shop.myshopify.com", "*.x.up.railway.app", "*.example.com.de"]) {
      rmSync(SCOPES, { force: true })
      rmSync(GRANTS, { force: true })
      const r = await create(["https://example.com", ok])
      expect(r.status).toBe(201)
      expect(grants()[0].hosts).toContain(ok)
    }
  })
})
