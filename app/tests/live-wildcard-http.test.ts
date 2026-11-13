import { useEnv } from "./helpers/env"
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
useEnv({ TOUCHSTONE_SCOPES_FILE: SCOPES })
useEnv({ TOUCHSTONE_GRANTS_FILE: GRANTS })
const TOKEN = "test-grant-token"
useEnv({ TOUCHSTONE_GRANT_TOKEN: TOKEN })

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

  test("too broad: *.com is refused at the route, *.co.uk as a public suffix", async () => {
    for (const [bad, why] of [["*.com", /^"\*\.com" is too broad: a wildcard needs a domain name of at least two labels after "\*\.", so \*\.example\.com, never \*\.com\.$/], ["*.co.uk", /^"\*\.co\.uk" covers hosts that belong to other people: co\.uk is a public suffix\. Use your own name under it, for example \*\.example\.co\.uk\.$/]] as const) {
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

  // The 2d review's lists: each one refused through the route, nothing saved.
  test("a wildcard over names that belong to other people is refused with a sentence, and nothing is saved", async () => {
    const PRIVATE = /covers hosts that belong to other people: every customer of .+ gets a name under it\. Use your own name, for example \*\.yourapp\..+\.$/
    const ICANN = /covers hosts that belong to other people: .+ is a public suffix\./
    const HANDED_OUT = /covers hosts that belong to other people: names under .+ are handed out to customers\./
    const SHARED = /covers hosts that belong to other people: names under .+ are shared or resolve to any address\./
    const cases: [string, RegExp][] = [
      // the PSL private section: the platform itself
      ["*.vercel.app", PRIVATE], ["*.blogspot.com", PRIVATE], ["*.eu.ngrok.io", PRIVATE], ["*.elasticbeanstalk.com", PRIVATE],
      ["*.azurestaticapps.net", PRIVATE], ["*.r2.dev", PRIVATE], ["*.duckdns.org", PRIVATE], ["*.up.railway.app", PRIVATE],
      ["*.ngrok-free.app", PRIVATE], ["*.com.de", PRIVATE], ["*.blob.core.windows.net", SHARED], ["*.cache.amazonaws.com", SHARED], ["*.database.windows.net", SHARED],
      ["*.googleusercontent.com", SHARED], ["*.wordpress.com", PRIVATE],
      // the PSL ICANN section
      ["*.ne.jp", ICANN], ["*.co.nz", ICANN], ["*.gov.br", ICANN],
      // public suffixes under the base: a provider namespace or a wildcard rule
      ["*.amazonaws.com", SHARED], ["*.eu-west-1.amazonaws.com", SHARED], ["*.r.appspot.com", HANDED_OUT], ["*.run.app", HANDED_OUT],
      // the small list of names the PSL lacks, at any depth
      ["*.nip.io", SHARED], ["*.1.2.3.4.nip.io", SHARED], ["*.sslip.io", SHARED], ["*.lvh.me", SHARED],
      ["*.scm.azurewebsites.net", SHARED], ["*.cloudapp.azure.com", SHARED], ["*.eastus.cloudapp.azure.com", SHARED],
      // blogspot country domains: the PSL keeps only blogspot.com
      ["*.blogspot.co.uk", /every blog gets a name under it/],
      // letters outside ASCII: the punycode form is named
      ["*.bücher.de", /"\*\.bücher\.de" has letters outside plain ASCII\. Write the punycode form: \*\.xn--bcher-kva\.de\.$/],
    ]
    for (const [bad, why] of cases) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(`${bad}: ${r.json.error}`).toMatch(why)
      expect(scopes()).toEqual([])
      expect(grants()).toEqual([])
    }
  })

  test("an address with a user name or password is refused, and the sentence does not repeat the secret", async () => {
    // An address that does not parse is refused too, with the credential part masked.
    const broken = await create(["https://example.com", "https://user:pw-secret-1@exa mple.com"])
    expect(broken.status).toBe(400)
    expect(broken.json.error).toBe(`"https://…@exa mple.com" is not a website address Touchstone can read. Write a host name or an http(s) address, for example example.com or https://app.example.com:8443.`)
    for (const bad of ["https://user:pw-secret-1@example.com", "admin:pw-secret-1@shop.example.com", "https://user@example.com"]) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/^The address for (shop\.)?example\.com holds a user name or password\. Touchstone never keeps a credential typed into a website address\./)
      expect(r.json.error).not.toContain("pw-secret-1")
      expect(scopes()).toEqual([])
      expect(grants()).toEqual([])
    }
  })

  test("a plain website that does not parse is refused with a sentence, not dropped", async () => {
    for (const bad of ["exa mple.com", "ftp://files.example.com", "https://", "http://[::1", "exa_mple..com"]) {
      const r = await create(["https://example.com", bad])
      expect(r.status).toBe(400)
      expect(r.json.error).toBe(`"${bad}" is not a website address Touchstone can read. Write a host name or an http(s) address, for example example.com or https://app.example.com:8443.`)
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
