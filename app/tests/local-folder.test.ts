import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// A local folder is read in place by the server: the operator names its path
// and nothing is uploaded. Throwaway stores and folders; the token matches the
// other HTTP tests, because bun shares one module cache across test files.
const dir = mkdtempSync(path.join(tmpdir(), "local-folder-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
const TOKEN = "test-grant-token"
process.env.TOUCHSTONE_GRANT_TOKEN = TOKEN

// @ts-expect-error — plain .mjs module, no types
const { readFolderInPlace, addScope, withFreshFolders } = await import("../server/runs.mjs")
// @ts-expect-error — plain .mjs module, no types
const { handleScopes } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { getUserScope } = await import("../../spike/lib/scopes-store.mjs")

const lab = path.join(dir, "My Lab")
beforeEach(() => {
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  rmSync(SCOPES, { force: true })
  rmSync(lab, { recursive: true, force: true })
  mkdirSync(path.join(lab, "src"), { recursive: true })
  mkdirSync(path.join(lab, "node_modules/x"), { recursive: true })
  mkdirSync(path.join(lab, ".git"), { recursive: true })
  writeFileSync(path.join(lab, "src/Vault.sol"), "contract Vault {}\n")
  writeFileSync(path.join(lab, "node_modules/x/i.js"), "x")
  writeFileSync(path.join(lab, ".git/config"), "x")
  writeFileSync(path.join(lab, ".env"), "SECRET=1")
  writeFileSync(path.join(lab, "logo.png"), "x")
  writeFileSync(path.join(lab, "src/key.ts"), "-----BEGIN RSA PRIVATE KEY-----\n")
  symlinkSync(path.join(dir), path.join(lab, "outside"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("readFolderInPlace", () => {
  test("keeps source files only: no hidden, dependency, binary or symlinked entries", () => {
    const r = readFolderInPlace(lab)
    expect(r.path).toBe(lab)
    expect(r.name).toBe("My-Lab")
    // key.ts is kept here by name; folderFiles drops it for its content.
    expect(r.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/Vault.sol", "src/key.ts"])
  })

  test("refuses a relative path, a missing folder and a file", () => {
    expect(() => readFolderInPlace("src")).toThrow(/full path/)
    expect(() => readFolderInPlace(path.join(dir, "nope"))).toThrow(/No folder/)
    expect(() => readFolderInPlace(path.join(lab, "logo.png"))).toThrow(/not a folder/)
  })
})

describe("addScope with a folder path", () => {
  test("reads the folder from disk, ignores sent files, and keeps the path", () => {
    const s = addScope({ members: [{ kind: "folder", path: lab, files: [{ path: "evil.ts", content: "x" }] }] })
    const saved = getUserScope(s.id)
    expect(saved.pack).toBe("contracts")
    expect(saved.members[0].path).toBe(lab)
    // The secret-content file is dropped by the shared intake rules.
    expect(saved.members[0].files.map((f: { path: string }) => f.path)).toEqual(["src/Vault.sol"])
  })

  test("a run reads the folder fresh from its path", () => {
    const s = addScope({ members: [{ kind: "folder", path: lab }] })
    writeFileSync(path.join(lab, "src/Vault.sol"), "contract Vault { uint x; }\n")
    const fresh = withFreshFolders(getUserScope(s.id))
    expect(fresh.members[0].files[0].content).toContain("uint x")
    rmSync(lab, { recursive: true, force: true })
    expect(() => withFreshFolders(getUserScope(s.id))).toThrow(/No folder/)
  })
})

function mockReq(body: unknown, headers: Record<string, string>) {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const req = {
    method: "POST",
    url: "/api/scopes",
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

async function post(body: unknown, headers: Record<string, string>) {
  const res = { statusCode: 0, body: "", setHeader() {}, end(s?: string) { this.body = s ?? "" } }
  await handleScopes(mockReq(body, headers), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const CONSOLE = { origin: "http://localhost:5173", host: "localhost:5173", "content-type": "application/json" }

describe("POST /api/scopes with a folder path", () => {
  test("without the console token: refused, the disk is not read", async () => {
    const r = await post({ title: "Lab", members: [{ kind: "folder", path: lab }] }, CONSOLE)
    expect(r.status).toBe(403)
    expect(existsSync(SCOPES)).toBe(false)
  })

  test("with the token: saved from disk", async () => {
    const r = await post({ title: "Lab", members: [{ kind: "folder", path: lab }] }, { ...CONSOLE, "x-touchstone-grant-token": TOKEN })
    expect(r.status).toBe(201)
    const saved = JSON.parse(readFileSync(SCOPES, "utf8"))[0]
    expect(saved.members[0].path).toBe(lab)
  })
})
