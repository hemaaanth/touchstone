import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
const { readFolderInPlace, openedInside, addScope, withFreshFolders } = await import("../server/runs.mjs")
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
  // A symlinked file that points at a file outside the folder.
  writeFileSync(path.join(dir, "secret.ts"), "export const secret = 1\n")
  symlinkSync(path.join(dir, "secret.ts"), path.join(lab, "src/leak.ts"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("readFolderInPlace", () => {
  test("keeps source files only: no hidden, dependency, binary or symlinked entries", () => {
    const r = readFolderInPlace(lab)
    expect(r.path).toBe(lab)
    expect(r.name).toBe("My-Lab")
    // key.ts is kept here by name; folderFiles drops it for its content.
    expect(r.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/Vault.sol", "src/key.ts"])
    expect(r.files.some((f: { content: string }) => f.content.includes("secret"))).toBe(false)
  })

  test("a parent folder swapped for a symlink after the walk is refused, not read", () => {
    // An outside folder with a file of the same name.
    const outside = path.join(dir, "outside-src")
    rmSync(outside, { recursive: true, force: true })
    mkdirSync(outside)
    writeFileSync(path.join(outside, "Vault.sol"), "contract OUTSIDE {}\n")
    writeFileSync(path.join(outside, "key.ts"), "export const OUTSIDE = 1\n")
    let swapped = false
    const swap = () => {
      if (swapped) return
      swapped = true
      // The exact race: src is renamed and replaced by a symlink to the outside
      // folder after the walk saw src/Vault.sol as a plain file.
      renameSync(path.join(lab, "src"), path.join(lab, "src-kept"))
      symlinkSync(outside, path.join(lab, "src"))
    }
    expect(() => readFolderInPlace(lab, { beforeOpen: swap })).toThrow(/no longer inside/)
    expect(swapped).toBe(true)
  })

  test("missing proc descriptor proof refuses an outside file without reading it", () => {
    const outside = path.join(dir, "outside-proof.ts")
    writeFileSync(outside, "export const OUTSIDE_ROOT = true\n")
    const fd = openSync(outside, "r")
    let reads = 0
    try {
      // Simulate a platform without /proc (or a failed readlink). The opened
      // descriptor points outside, while the claimed path is inside the lab.
      const readIfProven = () => {
        if (openedInside(fd, fstatSync(fd), path.join(lab, "src/proof.ts"), lab, () => {
          throw new Error("/proc/self/fd unavailable")
        })) {
          reads++
          return readFileSync(fd, "utf8")
        }
      }
      expect(readIfProven).toThrow(/Cannot prove this file is inside the scope root/)
      expect(reads).toBe(0)
    } finally {
      closeSync(fd)
    }
  })

  test("a folder given through a symlink is read at its real path, and ~ is the home folder", () => {
    const link = path.join(dir, "lab-link")
    rmSync(link, { force: true })
    symlinkSync(lab, link)
    expect(readFolderInPlace(link).path).toBe(lab)
    // "~user" is not expanded: it is a relative path and is refused.
    expect(() => readFolderInPlace("~root/x")).toThrow(/full path/)
    expect(() => readFolderInPlace("~/" + path.relative(homedir(), path.join(dir, "nope")))).toThrow(/No folder/)
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
