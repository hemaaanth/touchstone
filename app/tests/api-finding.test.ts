import { describe, expect, mock, test } from "bun:test"
import * as fsp from "node:fs/promises"
import path from "node:path"
// The operator's own view (GET /api/findings/:id) shows the stored record as
// it is. Only the exports (report.mjs) redact. Review Minor 7: nothing caught
// a redaction added back to getFinding. The secret here is synthetic.

const real = { ...fsp }
const FILE = "run-zz-minor7.json"
const explanation = 'Body {"token":"9c2e4f1a4f1a4f1a4f1a4f1a4f1a4f1a4f1a4f1a"} then Authorization: Bearer Zq7Xv9KpR2mN4tW8yB3cL6'
const record = { result: { finding: { title: "synthetic", severity: "low", explanation } } }

// Add one synthetic run to the results folder. Every other path reads the disk.
mock.module("node:fs/promises", () => ({
  ...real,
  readdir: async (dir: string, ...rest: unknown[]) =>
    path.basename(String(dir)) === "agent" ? [...(await real.readdir(dir).catch(() => [])), FILE] : real.readdir(dir, ...(rest as [])),
  readFile: async (file: string, ...rest: unknown[]) =>
    path.basename(String(file)) === FILE ? JSON.stringify(record) : real.readFile(file, ...(rest as [])),
}))

describe("api: a finding is returned as stored (review Minor 7)", () => {
  test("/api/findings/:id keeps the stored secret text for the operator", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { handleApi } = await import("../server/api.mjs")
    const res = await handleApi("/api/findings/zz-minor7")
    expect(res.status).toBe(200)
    expect(res.json.explanation).toBe(explanation)
  })
})
