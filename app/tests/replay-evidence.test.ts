import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// An evidence finding's snapshot is raw files from the target. None of that
// text may reach the stored run record, a zip, or an API response. A throwaway
// results folder, set before the server modules load.
const results = mkdtempSync(path.join(tmpdir(), "replay-evidence-results-"))
process.env.TOUCHSTONE_RESULTS_DIR = results
afterAll(() => rmSync(results, { recursive: true, force: true }))

// @ts-expect-error — plain .mjs module, no types
const { handleFindings } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { pinSnapshot, proveFindings } = await import("../../spike/lib/proof-evidence.mjs")
// @ts-expect-error — plain .mjs module, no types
const { buildReplayBundle } = await import("../../spike/lib/replay-bundle.mjs")

// Made-up values shaped like real ones. Each one is in a captured file.
const SECRETS = [
  "evidence-db-password-7f3a9c",
  "sk-proj-" + "Q".repeat(40),
  "0x" + "3".repeat(63) + "1",
  "b".repeat(64),
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
]

function call(url: string) {
  const req = { method: "GET", url, headers: {}, on() { return req } }
  const out: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: "" }
  const res = {
    set statusCode(v: number) { out.status = v },
    get statusCode() { return out.status },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v },
    end(b?: string | Buffer) { out.body = b == null ? "" : Buffer.isBuffer(b) ? b.toString("latin1") : String(b) },
  }
  return handleFindings(req, res).then(() => out)
}

describe("evidence replay keeps no snapshot text", () => {
  test("the record, the bundle route, and the report hold the hash and file names only", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "replay-evidence-ws-"))
    try {
      const snapshot = {
        version: 1,
        files: {
          ".env": `DB_PASSWORD=${SECRETS[0]}\nOPENAI_API_KEY=${SECRETS[1]}\n`,
          "hardhat.config.js": `module.exports = { networks: { main: { accounts: ["${SECRETS[2]}"] } } }\n`,
          "deploy/key.txt": `${SECRETS[3]}\n`,
          "ops/id_rsa": `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRETS[4]}\n-----END OPENSSH PRIVATE KEY-----\n`,
        },
      }
      const hash = pinSnapshot(ws, snapshot)
      const found = await proveFindings(ws, [{
        title: "committed private key",
        severity: "critical",
        evidence: { check: "key", snapshotHash: hash, where: { file: "hardhat.config.js" } },
      }], [], () => {}, { detectors: { key: () => ({ ok: true }) } })
      expect(found).toHaveLength(1)
      expect(found[0].proof.replay).toEqual({
        version: 2,
        kind: "evidence",
        snapshotHash: hash,
        snapshotFiles: [".env", "hardhat.config.js", "deploy/key.txt", "ops/id_rsa"],
        snapshotFileCount: 4,
      })

      // The stored record, as runs.mjs persists it.
      const record = JSON.stringify({ result: { findingSubmitted: true, recorded: true, decision: "approved", findings: found } }, null, 2)
      writeFileSync(path.join(results, "run-ev-1.json"), record)
      const stored = readFileSync(path.join(results, "run-ev-1.json"), "utf8")
      for (const s of SECRETS) expect(stored.includes(s)).toBe(false)

      // The bundle route refuses, with a reason, and sends no snapshot text.
      const bundle = await call("/api/findings/ev-1.1/report?format=bundle")
      expect(bundle.status).toBe(409)
      expect(JSON.parse(bundle.body).error).toContain("no replay bundle")
      expect(bundle.headers["content-type"]).toBe("application/json")
      for (const s of SECRETS) expect(bundle.body.includes(s)).toBe(false)

      // The builder refuses too, so no other caller can zip the snapshot.
      expect(() => buildReplayBundle({ finding: { proofKind: "evidence", proof: found[0].proof }, recorded: { proof: found[0].proof } })).toThrow("no replay bundle")

      // The other report formats still work and carry no snapshot text.
      for (const format of ["json", "md", "html"]) {
        const r = await call(`/api/findings/ev-1.1/report?format=${format}`)
        expect(r.status).toBe(200)
        for (const s of SECRETS) expect(r.body.includes(s)).toBe(false)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("an unknown report format is refused, not answered with json", async () => {
    const r = await call("/api/findings/ev-1.1/report?format=bogus")
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body).error).toContain("unknown format")
    expect((await call("/api/findings/ev-1.1/report?format=JSON")).status).toBe(200)
  })
})
