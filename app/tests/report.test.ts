import { describe, expect, test } from "bun:test"
// The report module is plain .mjs (server side). We test its pure builders with
// hand-built findings shaped exactly like app/server/findings.mjs normalize():
// a forge proof carries balances/transfers/gas; an http proof carries an oracle
// and exchanges. No filesystem, no server.
// @ts-expect-error — plain .mjs module, no types
import { buildReport, renderReportHtml, renderReportMarkdown, splitExplanation } from "../server/report.mjs"

// A proven forge finding, with a "Fix:" line in its explanation.
const forgeFinding = {
  id: "run-x.1",
  runId: "run-x",
  title: "Reentrancy drains the vault",
  severity: "critical",
  module: "Contracts",
  proofKind: "forge",
  target: "Vault.sol",
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  hypothesis: "contract Vault { function withdraw() ... }",
  explanation:
    "Vault.withdraw() sends ETH before it zeroes the balance.\n\n" +
    "PoC (contract VaultTest): the attacker re-enters and drains the vault.\n\n" +
    "Fix: zero the balance before the external call, or add a reentrancy guard.",
  proof: {
    tool: "Foundry",
    test: "testReentrancyDrainsVault",
    contract: "VaultTest",
    gas: 246929,
    pass: true,
    transfers: [{ label: "attacker", address: "0xA", net: "+10 ETH", gained: true }],
    balances: [{ label: "Vault balance", before: "10 ETH", after: "0 ETH" }],
    assertions: ["assertEq(address(vault).balance, 0);"],
    testSource: "contract VaultTest is Test { ... }",
  },
  model: "ds",
  usage: { usd: 0.42 },
  ms: 1234,
}

describe("report: honesty", () => {
  test("extracts the fix only from a stated Fix label, never invents one", () => {
    const r = buildReport(forgeFinding)
    expect(r.fixStated).toBe(true)
    expect(r.fix).toContain("zero the balance before the external call")
    // The PoC/mechanism prose stays in the narrative; only the Fix line is the fix.
    expect(r.fix).not.toContain("re-enters and drains")
    expect(r.narrative).toContain("sends ETH before it zeroes")
  })

  test("a finding with no Fix label reports no fix, and says so", () => {
    const noFix = { ...forgeFinding, explanation: "Just a mechanism description, no remediation." }
    const r = buildReport(noFix)
    expect(r.fixStated).toBe(false)
    expect(r.fix).toBeNull()
    expect(renderReportMarkdown(r)).toContain("did not state a fix")
    expect(renderReportHtml(r)).toContain("does not invent one")
  })

  test("the harm is read from the proof's own numbers", () => {
    const r = buildReport(forgeFinding)
    const harm = r.harm.join(" ")
    expect(harm).toContain("Vault balance: 10 ETH → 0 ETH")
    expect(harm).toContain("246929")
    expect(harm).toContain("attacker gained +10 ETH")
  })

  test("an unproven finding is labelled not proven, never a finding", () => {
    const lead = { ...forgeFinding, stages: { ...forgeFinding.stages, proven: false } }
    const r = buildReport(lead)
    expect(r.proven).toBe(false)
    expect(r.status).toContain("Not proven")
    expect(renderReportHtml(r)).toContain("Not proven")
    expect(renderReportHtml(r)).not.toContain("Proven by replay")
  })
})

describe("report: http proof harm", () => {
  const httpFinding = {
    id: "run-h.1",
    runId: "run-h",
    title: "IDOR exposes another user's record",
    severity: "high",
    module: "Web",
    proofKind: "http",
    target: "app.example.com",
    stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
    explanation: "The endpoint does not check ownership.\n\nFix: check the record owner against the session.",
    proof: {
      kind: "http",
      pass: true,
      oracle: { name: "cross-tenant read", detail: "victim's email returned to the attacker token", passed: true },
      exchanges: [
        { label: "Request 1", request: { method: "GET", url: "/api/users/2" }, response: { status: 200 } },
      ],
      detail: "",
    },
    usage: { usd: null },
  }

  test("reads the oracle and the exchange, not a forge shape", () => {
    const r = buildReport(httpFinding)
    const harm = r.harm.join(" ")
    expect(harm).toContain("cross-tenant read")
    expect(harm).toContain("victim's email returned")
    expect(harm).toContain("1 request/response exchange")
    expect(harm).toContain("answered 200")
    expect(r.fixStated).toBe(true)
  })
})

describe("report: splitExplanation", () => {
  test("promotes a '## Fix' heading to the fix and keeps the rest as narrative", () => {
    const { fix, narrative } = splitExplanation("Mechanism paragraph.\n\n## Fix\n\nuse a guard.")
    expect(fix).toBe("use a guard.")
    expect(narrative).toBe("Mechanism paragraph.")
  })

  test("empty explanation yields no fix and empty narrative", () => {
    expect(splitExplanation("")).toEqual({ fix: null, narrative: "" })
    expect(splitExplanation(null)).toEqual({ fix: null, narrative: "" })
  })
})

describe("report: html is self-contained and safe", () => {
  test("one document, no external asset, html-escaped", () => {
    const evil = { ...forgeFinding, title: "<script>alert(1)</script> & \"bad\"" }
    const html = renderReportHtml(buildReport(evil))
    expect(html.startsWith("<!doctype html>")).toBe(true)
    // No remote asset: no external stylesheet or script src.
    expect(html).not.toMatch(/<link[^>]+href="https?:/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    // The title is escaped, so no live script tag from finding text.
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})

describe("report: brand comes from the app's own files", () => {
  test("inlines the app's tokens, dark tokens as a media query, and the logo mark", () => {
    const { readFileSync } = require("node:fs")
    const tokens = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8")
    const html = renderReportHtml(buildReport(forgeFinding))
    // The same --background values the app uses, light and dark.
    for (const m of tokens.matchAll(/--background:\s*([^;]+);/g)) expect(html).toContain(`--background: ${m[1]};`)
    expect(html).toContain("@media (prefers-color-scheme: dark)")
    expect(html).not.toContain(".dark {")
    // The mark is inline SVG, and there is exactly one footer.
    expect(html).toContain('fill-rule="evenodd"')
    expect(html.match(/<footer/g)?.length).toBe(1)
  })
})

describe("report: secrets stay out of every format", () => {
  // A live AI/MCP run's bearer token, quoted in the write-up and in the
  // exchanges (Authorization, Cookie, X-API-Key, a query param, a JSON body).
  const token = "tok_operator_9f3a2c1b8e7d"
  const fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const leak = {
    id: "run-m.1",
    runId: "run-m",
    title: "Tool call used the operator credential",
    severity: "high",
    module: "AI / MCP",
    proofKind: "http",
    target: "mcp.example.com",
    stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
    explanation:
      `The agent read the brief and called the tool with Bearer ${token}.\n\n` +
      "Fix: rotate that credential and stop copying it into the prompt.",
    proof: {
      kind: "http",
      pass: true,
      oracle: { name: "forbidden tool call", detail: "the tool ran with the operator credential", passed: true },
      exchanges: [
        {
          label: "MCP tools/call",
          request: {
            method: "POST",
            url: `/mcp/tools/call?token=${token}`,
            headers: [
              { name: "Authorization", redacted: false, value: `Bearer ${token}` },
              { name: "X-API-Key", redacted: false, value: token },
              { name: "Cookie", redacted: false, value: `session=${token}` },
              { name: "Content-Type", redacted: false, value: "application/json" },
              { name: "Authorization", redacted: true, sha256: fingerprint },
            ],
            body: `{"jsonrpc":"2.0","authorization":"Bearer ${token}","email":"victim@example.com"}`,
          },
          response: {
            status: 200,
            headers: [{ name: "Set-Cookie", redacted: false, value: `sid=${token}` }],
            body: "ok",
          },
        },
      ],
      detail: "",
    },
    usage: { usd: null },
  }

  test("html, markdown and json omit the bearer token and keep the proof", () => {
    const report = buildReport(leak)
    const html = renderReportHtml(report)
    const md = renderReportMarkdown(report)
    const json = JSON.stringify(report)
    for (const rendered of [html, md, json]) {
      expect(rendered).not.toContain(token)
      expect(rendered).toContain("victim@example.com")
      expect(rendered).toContain("application/json")
      expect(rendered).toContain("/mcp/tools/call")
      expect(rendered).toContain("forbidden tool call")
      expect(rendered).toContain("rotate that credential")
    }
    expect(html).toContain("answered 200")
    expect(json).toContain(fingerprint)
    expect(report.fixStated).toBe(true)
    // The finding handed in is the recorded one. Redaction copies; it does not edit it.
    expect(leak.explanation).toContain(token)
    expect(leak.proof.exchanges[0].request.headers[0].value).toContain(token)
  })
})
