import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// GET /api/stores: a store file that exists but cannot be read lists as empty,
// so the app asks for the reason and shows it. Throwaway stores only.
const dir = mkdtempSync(path.join(tmpdir(), "store-errors-test-"))
const SCOPES = path.join(dir, "scopes.json")
const GRANTS = path.join(dir, "grants.json")
process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
process.env.TOUCHSTONE_GRANT_TOKEN = "test-grant-token"

// @ts-expect-error — plain .mjs module, no types
const { handleApi } = await import("../server/api.mjs")
// @ts-expect-error — plain .mjs module, no types
const { listTargets } = await import("../../spike/lib/targets.mjs")

beforeEach(() => {
  process.env.TOUCHSTONE_SCOPES_FILE = SCOPES
  process.env.TOUCHSTONE_GRANTS_FILE = GRANTS
  rmSync(SCOPES, { force: true })
  rmSync(GRANTS, { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("GET /api/stores", () => {
  test("no store file, or good ones: no error", async () => {
    expect(await handleApi("/api/stores")).toEqual({ status: 200, json: { errors: [] } })
    writeFileSync(SCOPES, "[]")
    writeFileSync(GRANTS, "[]")
    expect((await handleApi("/api/stores")).json.errors).toEqual([])
  })

  test("a damaged scope store lists as empty, and the sentence says why", async () => {
    writeFileSync(SCOPES, "{ not json")
    expect(listTargets().every((t: { id: string }) => !t.id.startsWith("scope-"))).toBe(true)
    const { json } = await handleApi("/api/stores")
    expect(json.errors).toEqual([`The scope store file ${SCOPES} is not a valid JSON list. Its scopes are not shown, and none can be added or changed, until the file is repaired or moved away.`])
  })

  test("a damaged grant store is named too", async () => {
    writeFileSync(GRANTS, '{"not": "a list"}')
    const { json } = await handleApi("/api/stores")
    expect(json.errors).toEqual([`The grant store file ${GRANTS} is not a valid JSON list. Its grants are not shown, and none can be added or changed, until the file is repaired or moved away.`])
    expect(json.errors[0]).not.toContain("Nothing was changed")
  })
})
