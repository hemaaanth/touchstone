import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The Findings page and its server (findings.mjs) list findings only. A
// candidate lives in `result.candidates` and is shown in its run. Even a
// record that holds a candidate under `findings` (forged, or written by a bug)
// must not list it, count it, open it, copy it, report it or bundle it. Not
// listing candidates on the Findings page is this pass's choice (G5).
const results = mkdtempSync(path.join(tmpdir(), "candidate-findings-"))
useEnv({ TOUCHSTONE_RESULTS_DIR: results })
afterAll(() => rmSync(results, { recursive: true, force: true }))

// @ts-expect-error — plain .mjs module, no types
const { getFinding, listFindings } = await import("../server/findings.mjs")
// @ts-expect-error — plain .mjs module, no types
const { handleFindings } = await import("../server/runs-http.mjs")

const proof = { kind: "http", status: "pass", pass: true, oracle: { name: "bola-wallet-idor", passed: true } }
const candidate = (poc: string) => ({
  n: 1, pack: "web", title: `Candidate ${poc}`, severity: "critical", poc, explanation: "Agent says so.\nFix: x.",
  evidence: { kind: "transcript" }, cites: [], kind: "candidate", candidate: true, assertedBy: "agent", proven: false, provedBy: null,
})
// The candidate rows claim proof, so a reader that lets them through shows them as proven.
const forged = (poc: string) => ({ ...candidate(poc), proven: true, pocProved: true, proof })
writeFileSync(path.join(results, "run-cand-ledger-1.json"), JSON.stringify({
  result: {
    pack: "web",
    outcome: "recorded",
    findings: [
      { title: "Admin export needs no session", severity: "high", poc: "export", pocProved: true, proof },
      forged("forged_row"),
      { title: "Upload keeps the name", severity: "low", poc: "upload", pocProved: false, proof: { kind: "http", status: "fail" } },
    ],
    candidates: [candidate("pause_probe")],
  },
}))
// An older record with one finding at the run level, which is a candidate.
writeFileSync(path.join(results, "run-cand-legacy-1.json"), JSON.stringify({ result: { pack: "web", finding: forged("legacy_row"), pocProved: true, proof } }))

function call(url: string) {
  const req = { method: "GET", url, headers: {}, on() { return req } }
  const out = { status: 0, body: "" }
  const res = {
    set statusCode(v: number) { out.status = v },
    get statusCode() { return out.status },
    setHeader() {},
    end(b?: string | Buffer) { out.body = b == null ? "" : String(b) },
  }
  return handleFindings(req, res).then(() => out)
}

describe("the Findings page never holds a candidate", () => {
  test("the list and its counts hold the findings only, with their own ids", async () => {
    const list = await listFindings()
    expect(list.map((f: { id: string }) => f.id).sort()).toEqual(["cand-ledger-1.1", "cand-ledger-1.3"])
    expect(list.filter((f: { proven: boolean }) => f.proven).length).toBe(1)
    expect(JSON.stringify(list)).not.toContain("Candidate ")
  })

  test("a candidate row cannot be opened, and the rows after it keep their place", async () => {
    expect(await getFinding("cand-ledger-1.2")).toBeNull()
    expect(await getFinding("cand-legacy-1")).toBeNull()
    expect((await getFinding("cand-ledger-1.3")).title).toBe("Upload keeps the name")
  })

  test("no copy text, report or bundle is made for a candidate", async () => {
    for (const format of ["json", "md", "agent", "html", "bundle", "bundle-check"]) {
      for (const id of ["cand-ledger-1.2", "cand-legacy-1"]) {
        const out = await call(`/api/findings/${id}/report?format=${format}`)
        expect([format, id, out.status]).toEqual([format, id, 404])
      }
    }
    expect((await call("/api/findings/cand-ledger-1.1/report?format=md")).status).toBe(200)
  })
})

// N3: the Findings page lists candidates beside the findings, as their own state.
describe("the list API and the page list candidates apart (N3)", () => {
  test("/api/findings sends the candidates beside the findings, never among them", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { handleApi } = await import("../server/api.mjs")
    const { json } = await handleApi("/api/findings")
    expect(json.findings.some((f: { id: string }) => f.id.includes(".c"))).toBe(false)
    const own = json.candidates.filter((c: { runId: string }) => c.runId === "cand-ledger-1")
    expect(own.map((c: { origin: string; proven: boolean }) => [c.origin, c.proven])).toEqual([["agent", false]])
    // A candidate id is the run plus a hash of what it is (repair 1, m8).
    expect(own[0].id).toMatch(/^cand-ledger-1\.c-[0-9a-f]{12}$/)
  })
})
