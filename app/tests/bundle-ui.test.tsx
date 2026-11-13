import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"

// H3c (the replay bundle on the Findings page) and D3b (a joined run's parts).
// Every record here is synthetic and lives in a throwaway results folder, set
// before the server modules read it. bun runs every test file in one process:
// put the old value back at the end.
const results = mkdtempSync(path.join(tmpdir(), "bundle-ui-results-"))
const prevResults = process.env.TOUCHSTONE_RESULTS_DIR
process.env.TOUCHSTONE_RESULTS_DIR = results
afterAll(() => {
  if (prevResults === undefined) delete process.env.TOUCHSTONE_RESULTS_DIR
  else process.env.TOUCHSTONE_RESULTS_DIR = prevResults
  rmSync(results, { recursive: true, force: true })
})

// @ts-expect-error — plain .mjs module, no types
const { handleFindings, readmeHead } = await import("../server/runs-http.mjs")
// @ts-expect-error — plain .mjs module, no types
const { getFinding } = await import("../server/findings.mjs")
// @ts-expect-error — plain .mjs module, no types
const { zipStore } = await import("../../spike/lib/replay-bundle.mjs")
const { BundleResult } = await import("../src/components/findings-page")
const { sizeText } = await import("../src/lib/findings-view")
const { joinedModules } = await import("../src/lib/catalog")

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
const write = (id: string, record: unknown) => writeFileSync(path.join(results, `run-${id}.json`), JSON.stringify(record))

describe("bundle-check says what the bundle is, in its README's own first words (H3c)", () => {
  test("readmeHead reads the first paragraph of the zip's README.md, and nothing else", () => {
    const zip = zipStore([
      { name: "README.md", data: "PROVEN: line one of the bundle.\n\n## More\n\nThe rest." },
      { name: "proof.json", data: "{}" },
    ])
    expect(readmeHead(zip)).toBe("PROVEN: line one of the bundle.")
    expect(readmeHead(zipStore([{ name: "proof.json", data: "{}" }]))).toBeNull()
    expect(readmeHead(Buffer.from("not a zip"))).toBeNull()
  })

  test("an HTTP bundle: the answer's `about` is its README line 1", async () => {
    const proof = {
      kind: "http",
      status: "pass",
      oracle: { name: "replayed-withdrawal", detail: "the lab accepted the same withdrawal twice", passed: true },
      log: [{ label: "1", request: { method: "POST", url: "http://origin:8080/withdraw" }, response: { status: 200, body: { txHash: "0x" + "7d".repeat(32) } } }],
    }
    write("zz-bundle-http", { result: { findingSubmitted: true, recorded: true, pack: "web", findings: [{ title: "withdrawal replay", severity: "high", pocProved: true, script: 'await request("POST", "/withdraw");\n', proof }] } })
    const r = await call("/api/findings/zz-bundle-http.1/report?format=bundle-check")
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.about).toMatch(/^PROVEN: the engine's proof gate passed this finding/)
    expect(body.note).toBe("Check these before you share the bundle")
    expect(body.unjudged[0].count).toBe(1)
  })

  test("a Foundry bundle: `about` says it has no re-run command, in the bundle's words", async () => {
    const proof = { kind: "forge", pass: true, status: "pass", contract: "VaultTest", test: "testDrain", transfers: [], harm: { ok: true, kind: "funds" } }
    write("zz-bundle-forge", { result: { findingSubmitted: true, recorded: true, pack: "contracts", findings: [{ title: "vault drain", severity: "critical", poc: "VaultTest", pocProved: true, proof }] } })
    const r = await call("/api/findings/zz-bundle-forge.1/report?format=bundle-check")
    expect(r.status).toBe(200)
    const about = JSON.parse(r.body).about
    expect(about).toMatch(/^PROVEN: Touchstone proved this finding by its own replay/)
    expect(about).toContain("it has no re-run command yet")
  })
})

describe("the bundle control shows the server's answer calmly (H3c)", () => {
  const html = (check: Parameters<typeof BundleResult>[0]["check"]) => renderToStaticMarkup(<BundleResult check={check} href="/api/findings/x/report?format=bundle" />)
  const RED = /text-bad|text-destructive|bg-destructive|text-red|bg-red/

  test("a refusal shows the server's sentence and offers no download", () => {
    const out = html({ ok: false, error: "This finding is not proven by its replay, so it has no replay bundle." })
    expect(out).toContain("This finding is not proven by its replay, so it has no replay bundle.")
    expect(out).not.toContain("href=")
    expect(out).not.toContain("download")
    expect(out).not.toMatch(RED)
  })

  test("a bundle with values it could not judge: the size, what it is, the counts by class, then the download", () => {
    const out = html({
      ok: true,
      bytes: 18_432,
      about: "PROVEN: the bundle's own line.",
      note: "Check these before you share the bundle",
      unjudged: [
        { shape: "hex64", count: 2, text: "2 values of 64 hex characters that may be keys or hashes" },
        { shape: "urlToken", count: 1, text: "1 URL part that may be an access token" },
      ],
    })
    expect(out).toContain('href="/api/findings/x/report?format=bundle"')
    expect(out).toContain("download")
    expect(out).toContain("18 KB")
    expect(out).toContain("PROVEN: the bundle&#x27;s own line.")
    expect(out).toContain("Check these before you share the bundle: 2 values of 64 hex characters that may be keys or hashes; 1 URL part that may be an access token.")
    expect(out).not.toMatch(RED)
  })

  test("a bundle with nothing to check shows no check line", () => {
    const out = html({ ok: true, bytes: 900, about: null, note: null, unjudged: [] })
    expect(out).not.toContain("Check these")
    expect(out).toContain("900 B")
  })

  test("sizes read in B, KB and MB", () => {
    expect(sizeText(512)).toBe("512 B")
    expect(sizeText(18_432)).toBe("18 KB")
    expect(sizeText(3 * 1024 * 1024 + 200_000)).toBe("3.2 MB")
  })
})

describe("a joined run: each finding's write-up is its own module's call (D3b a)", () => {
  test("submit_finding_<module> and the label pick the call; a shared label in another module does not", async () => {
    write("zz-joined-2611130000-1", {
      result: {
        packs: ["contracts", "web", "domains"],
        findings: [
          { title: "Web leak", severity: "high", pack: "web", poc: "replay-1", pocProved: true, proof: { kind: "http", status: "pass", oracle: { name: "leak", passed: true }, log: [] } },
          { title: "Vault drain", severity: "critical", pack: "contracts", poc: "VaultTest", pocProved: true, proof: { kind: "forge", pass: true, contract: "VaultTest", transfers: [] } },
        ],
      },
      transcript: {
        calls: [
          // Another module used the same label first.
          { name: "submit_finding_domains", args: { label: "replay-1", explanation: "domains write-up" } },
          { name: "submit_finding_web", args: { label: "replay-1", explanation: "web write-up" } },
          { name: "submit_finding_contracts", args: { poc_contract: "VaultTest", explanation: "contracts write-up" } },
        ],
        results: [],
      },
    })
    expect((await getFinding("zz-joined-2611130000-1.1", { events: false })).explanation).toBe("web write-up")
    expect((await getFinding("zz-joined-2611130000-1.2", { events: false })).explanation).toBe("contracts write-up")
  })

  test("a one-module record keeps the plain submit_finding call", async () => {
    write("zz-plain-2611130001-1", {
      result: { finding: { title: "Old drain", severity: "high", poc: "OldTest" }, pocProved: true },
      transcript: { calls: [{ name: "submit_finding", args: { poc_contract: "OldTest", explanation: "old write-up" } }], results: [] },
    })
    expect((await getFinding("zz-plain-2611130001-1", { events: false })).explanation).toBe("old write-up")
  })
})

describe("a joined run's row shows all its modules (D3b b)", () => {
  const packs = [
    { id: "contracts", title: "Contracts" },
    { id: "web", title: "Web and sign-in" },
    { id: "domains", title: "Domains and front end" },
  ] as Parameters<typeof joinedModules>[1]
  test("one module: no pills, the row stays one line", () => {
    expect(joinedModules({ packs: ["web"] }, packs)).toBeNull()
    expect(joinedModules({}, packs)).toBeNull()
  })
  test("several modules: every one, in the server's order, with its title", () => {
    expect(joinedModules({ packs: ["domains", "contracts", "lab-x"] }, packs)).toEqual([
      { id: "contracts", title: "Contracts" },
      { id: "domains", title: "Domains and front end" },
      { id: "lab-x", title: "lab-x" },
    ])
  })
})
