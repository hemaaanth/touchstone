import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { ReplayProof } from "../src/components/replay-proof"

// A record whose token harm carries decimals a token cannot have (-1) must not
// blank the page or fail the report: the amount reads in raw units.
const dir = mkdtempSync(path.join(tmpdir(), "bad-decimals-test-"))
useEnv({ TOUCHSTONE_RESULTS_DIR: dir })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const harm = { ok: true, kind: "funds", asset: "token", victim: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", token: "0x1111111111111111111111111111111111111111", lostUnits: "1500000", symbol: "USDC", decimals: -1, targets: [{ address: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", name: "TokenVault" }] }
writeFileSync(
  path.join(dir, "run-bad-decimals-2611110619-1.json"),
  JSON.stringify({
    result: {
      outcome: "recorded",
      recorded: true,
      findings: [{ title: "Token drain", severity: "high", poc: "DrainTest", explanation: "Drains the vault.\n\nFix: check the balance.", proof: { kind: "forge", tool: "forge", contract: "DrainTest", test: "test_drain", status: "pass", pass: true, gasUsed: 1, logs: [], transfers: [], harm } }],
    },
  }),
)

const load = async () => {
  // @ts-expect-error — plain .mjs module, no types
  const { getFinding } = await import("../server/findings.mjs")
  return getFinding("bad-decimals-2611110619-1.1", { events: false })
}

describe("token decimals a token cannot have", () => {
  test("the finding still renders, with the loss in raw units", async () => {
    const finding = await load()
    expect(finding.proof.harm.decimals).toBe(-1)
    const html = renderToStaticMarkup(<ReplayProof finding={finding} />)
    expect(html).toContain("What was lost")
    expect(html).toMatch(/TokenVault lost <span[^>]*>1,500,000 raw units<\/span> of token 0x1111…1111\./)
  })

  test("its report builds as json, Markdown and HTML", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { buildReport, renderReportHtml, renderReportMarkdown } = await import("../server/report.mjs")
    const report = buildReport(await load())
    expect(JSON.parse(JSON.stringify(report)).title).toBe("Token drain")
    expect(renderReportMarkdown(report)).toContain("Token drain")
    expect(renderReportHtml(report)).toContain("Token drain")
  })
})
