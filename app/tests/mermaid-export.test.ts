import "./helpers/isolated-env"
import { describe, expect, test } from "bun:test"
// @ts-expect-error — plain .mjs module, no types
import { buildReport, renderReportAgent, renderReportHtml, renderReportMarkdown } from "../server/report.mjs"
import { explanationSections } from "@/lib/explanation"

// The agent may now put a `mermaid` fence in a finding's write-up
// (spike/lib/diagram-rule.mjs). Outside the chat it is plain text: the Findings
// page shows it as a code block, and the exports carry it as text.
const FENCE = '```mermaid\nflowchart LR\n  A["<script>x</script> Attacker"] -->|withdraw| V[Vault]\n  V -->|ETH before the balance update| A\n```'
const finding = {
  id: "run-1.1",
  title: "Reentrancy drains the vault",
  severity: "high",
  proven: true,
  proofKind: "forge",
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  explanation: `The vault sends ETH before it lowers the balance.\n\n${FENCE}\n\nFix: lower the balance first.`,
  proof: { tool: "Foundry", test: "test_drain", pass: true, gas: 1, transfers: [], balances: [], assertions: [], testSource: null },
}

describe("a mermaid fence in a finding's write-up", () => {
  test("the Findings page parser keeps it as a mermaid code block", () => {
    const blocks = explanationSections(finding.explanation)
    const code = blocks.find((b) => b.kind === "code")
    expect(code).toEqual({ kind: "code", lang: "mermaid", text: FENCE.slice("```mermaid\n".length, -"\n```".length) })
    expect(blocks.some((b) => b.kind === "prose" && b.heading === "Fix")).toBe(true)
  })

  test("the Markdown export carries the fence as text; the fix stays the fix", () => {
    const r = buildReport(finding)
    expect(r.fix).toBe("lower the balance first.")
    expect(renderReportMarkdown(r)).toContain(FENCE)
  })

  test("the one-line agent export keeps the first sentence and no broken fence", () => {
    const line = renderReportAgent(buildReport(finding))
    expect(line).toContain("What is wrong: The vault sends ETH before it lowers the balance.")
    expect(line).not.toContain("```")
  })

  test("the one-line agent export drops a ~~~ fence too", () => {
    const tilde = { ...finding, explanation: "The vault pays first.\n\n~~~mermaid\nflowchart LR\n  A --> V\n~~~\n\nThen it lowers the balance." }
    const line = renderReportAgent(buildReport(tilde))
    expect(line).toContain("What is wrong: The vault pays first. Then it lowers the balance.")
    expect(line).not.toContain("~~~")
    expect(line).not.toContain("flowchart")
  })

  test("the HTML export shows it escaped, with nothing live", () => {
    const html = renderReportHtml(buildReport(finding))
    expect(html).toContain('<pre class="code">flowchart LR')
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(html).not.toContain("<script>x</script>")
    expect(html).not.toContain('class="pele')
  })
})
