import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// An evidence finding's snapshot is raw files from the target. None of that
// text may reach the stored run record, a zip, or an API response. A throwaway
// results folder, set before the server modules load.
// bun runs every test file in one process: put the old value back at the end.
const results = mkdtempSync(path.join(tmpdir(), "replay-evidence-results-"))
// useEnv puts the old value back at the end.
useEnv({ TOUCHSTONE_RESULTS_DIR: results })
afterAll(() => rmSync(results, { recursive: true, force: true }))

// @ts-expect-error — plain .mjs module, no types
const { handleFindings } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { pinSnapshot, proveFindings } = await import("../../spike/lib/proof-evidence.mjs")
// @ts-expect-error — plain .mjs module, no types
const { buildReplayBundle } = await import("../../spike/lib/replay-bundle.mjs")
// @ts-expect-error — plain .mjs module, no types
const { HARM_CHECKS } = await import("../../spike/lib/proof-class.mjs")

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

      // N3: an evidence replay repeats a measurement, so this finding reads as
      // a measured candidate. A candidate has no report and no bundle (404),
      // and no answer sends snapshot text.
      const bundle = await call("/api/findings/ev-1.1/report?format=bundle")
      expect(bundle.status).toBe(404)
      expect(bundle.headers["content-type"]).toBe("application/json")
      for (const s of SECRETS) expect(bundle.body.includes(s)).toBe(false)

      // The builder refuses too, so no other caller can zip the snapshot.
      expect(() => buildReplayBundle({ finding: { proofKind: "evidence", proof: found[0].proof }, recorded: { proof: found[0].proof } })).toThrow("no replay bundle")

      // No other format answers for it either, and none carries snapshot text.
      for (const format of ["json", "md", "html", "agent"]) {
        const r = await call(`/api/findings/ev-1.1/report?format=${format}`)
        expect(r.status).toBe(404)
        for (const s of SECRETS) expect(r.body.includes(s)).toBe(false)
      }
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test("an old record that still holds snapshot text gets a 409, and no format sends that text", async () => {
    // The shape the first version of this PR wrote: the whole snapshot as text
    // on proof.replay.files. Made-up values.
    const snapshot = { version: 1, files: { ".env": `DB_PASSWORD=${SECRETS[0]}\nOPENAI_API_KEY=${SECRETS[1]}\n`, "deploy/key.txt": `${SECRETS[3]}\n` } }
    const replay = { version: 1, kind: "evidence", snapshotHash: "c".repeat(64), scrubbed: false, files: [{ path: "snapshot.json", text: JSON.stringify(snapshot) }], omitted: [] }
    const row = { title: "committed key", severity: "critical", proven: true, proof: { kind: "evidence", check: "key", status: "pass", replay } }
    writeFileSync(path.join(results, "run-ev-old.json"), JSON.stringify({ result: { findingSubmitted: true, recorded: true, decision: "approved", findings: [row] } }))
    // N3: a measured candidate now, so no format answers (404), and none sends that text.
    for (const format of ["bundle", "zip", "bundle-check", "json", "md", "html", "agent"]) {
      const r = await call(`/api/findings/ev-old.1/report?format=${format}`)
      expect([format, r.status]).toEqual([format, 404])
      for (const s of SECRETS) expect([format, r.body.includes(s)]).toEqual([format, false])
    }
  })

  test("the bundle route answers 409 for an http record that holds a key the redactor cannot mask", async () => {
    // Made up. The oracle detail holds a bare 64-hex key with a key word.
    const hex = "9c4f1a7e3b8d2f6a0c5e9b1d7f3a8c2e6b0d4f9a1c7e3b5d8f2a6c0e4b9d1f7a"
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "debug-route-signer-key-leak", detail: `signer key 0x${hex}`, passed: true },
      log: [{ label: "1", request: { method: "GET", url: "http://origin:8080/internal/debug/config" }, response: { status: 200, body: "ok" } }],
    }
    const row = { title: "debug route leaks the signer key", severity: "high", pocProved: true, script: 'await request("GET", "/internal/debug/config");\n', proof }
    writeFileSync(path.join(results, "run-http-leak.json"), JSON.stringify({ result: { findingSubmitted: true, recorded: true, decision: "approved", pack: "web", findings: [row] } }))
    const r = await call("/api/findings/http-leak.1/report?format=bundle")
    expect(r.status).toBe(409)
    expect(r.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(r.body).error).toContain("a 64-hex key")
    expect(r.body.includes(hex)).toBe(false)
  })

  test("the bundle route lists the values it could not judge, by count, with the zip and as JSON", async () => {
    // Made up: a transaction hash in the response. It may be evidence or a key.
    const txHash = "0x" + "7d".repeat(32)
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "siwe-nonce-replay", detail: "the lab accepted the same withdrawal twice", passed: true },
      log: [{ label: "1", request: { method: "POST", url: "http://origin:8080/withdraw" }, response: { status: 200, body: { txHash } } }],
    }
    const row = { title: "withdrawal replay", severity: "high", pocProved: true, script: 'await request("POST", "/withdraw");\n', proof }
    writeFileSync(path.join(results, "run-http-hash.json"), JSON.stringify({ result: { findingSubmitted: true, recorded: true, decision: "approved", pack: "web", findings: [row] } }))
    const check = await call("/api/findings/http-hash.1/report?format=bundle-check")
    expect(check.status).toBe(200)
    expect(check.headers["content-type"]).toBe("application/json")
    const body = JSON.parse(check.body)
    expect(body.unjudged).toEqual([{ shape: "hex64", count: 1, text: "1 value of 64 hex characters that may be a key or a hash" }])
    expect(body.note).toBe("Check these before you share the bundle")
    expect(check.body.includes(txHash.slice(2))).toBe(false)
    const zip = await call("/api/findings/http-hash.1/report?format=bundle")
    expect(zip.status).toBe(200)
    expect(zip.headers["content-type"]).toBe("application/zip")
    expect(JSON.parse(zip.headers["x-touchstone-unjudged"])).toEqual([{ shape: "hex64", count: 1 }])
    expect(zip.headers["x-touchstone-unjudged"].includes(txHash.slice(2))).toBe(false)
  })

  test("the bundle route answers 409 for a finding its replay did not prove", async () => {
    const proof = {
      kind: "http",
      status: "fail",
      oracle: { name: "debug-route-signer-key-leak", detail: "no response returned a signerPrivateKey field", passed: false },
      log: [{ label: "1", request: { method: "GET", url: "http://origin:8080/healthz" }, response: { status: 200, body: "ok" } }],
    }
    const row = { title: "a lead", severity: "high", pocProved: false, script: 'await request("GET", "/healthz");\n', proof }
    writeFileSync(path.join(results, "run-http-lead.json"), JSON.stringify({ result: { findingSubmitted: true, recorded: true, decision: "approved", pack: "web", findings: [row] } }))
    for (const format of ["bundle", "zip", "bundle-check"]) {
      const r = await call(`/api/findings/http-lead.1/report?format=${format}`)
      expect([format, r.status]).toEqual([format, 409])
      expect(JSON.parse(r.body).error).toBe("This finding is not proven by its replay, so it has no replay bundle: a bundle of a lead could be shared as if it were proof.")
    }
    expect((await call("/api/findings/http-lead.1/report?format=json")).status).toBe(200)
  })

  // If an evidence check is ever counted as harm (HARM_CHECKS, the owner's B1),
  // its finding has a report again. The report must still send no snapshot
  // text, and the bundle must still refuse with its reason. The check is
  // flipped for this test only.
  test("an evidence check counted as harm: its report has no snapshot text, and the bundle refuses", async () => {
    HARM_CHECKS.add("key")
    try {
      const bundle = await call("/api/findings/ev-1.1/report?format=bundle")
      expect(bundle.status).toBe(409)
      expect(JSON.parse(bundle.body).error).toContain("no replay bundle")
      for (const s of SECRETS) expect(bundle.body.includes(s)).toBe(false)
      for (const format of ["json", "md", "html", "agent"]) {
        const r = await call(`/api/findings/ev-1.1/report?format=${format}`)
        expect([format, r.status]).toEqual([format, 200])
        for (const s of SECRETS) expect([format, r.body.includes(s)]).toEqual([format, false])
      }
    } finally {
      HARM_CHECKS.delete("key")
    }
    expect((await call("/api/findings/ev-1.1/report?format=md")).status).toBe(404)
  })

  test("an unknown report format is refused, not answered with json", async () => {
    const r = await call("/api/findings/http-leak.1/report?format=bogus")
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body).error).toContain("unknown format")
    expect((await call("/api/findings/http-leak.1/report?format=JSON")).status).toBe(200)
  })
})
