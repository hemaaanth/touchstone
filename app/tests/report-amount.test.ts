import "./helpers/isolated-env"
import { describe, expect, test } from "bun:test"
// @ts-expect-error — plain .mjs module, no types
import { buildReport, renderReportMarkdown } from "../server/report.mjs"

// The shareable report leaves the machine. Its harm lines read each transfer
// by the console's rule (src/lib/amount.mjs): never cut, rounded only with
// "≈" and the exact wei beside it, dust in wei. A record without the exact
// wei keeps its own text, as before.
const finding = (transfers: Record<string, unknown>[]) => ({
  id: "run-1.1",
  title: "Drain",
  severity: "high",
  proven: true,
  proofKind: "forge",
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  explanation: "Drains the vault.",
  proof: { tool: "Foundry", test: "test_drain", pass: true, gas: 1, transfers, balances: [], assertions: [], testSource: null },
})

describe("report: the harm amounts", () => {
  test("an exact, a rounded and a dust move", () => {
    const r = buildReport(
      finding([
        { label: "attacker", address: "0xA", net: "+9.945 ETH", netWei: "9945000000000000000", gained: true },
        { label: "victim", address: "0xB", net: "-1.9999 ETH", netWei: "-1999999999999999999", gained: false },
        // The engine's own text cut this to +0 ETH.
        { label: "vault", address: "0xC", net: "+0 ETH", netWei: "3980", gained: true },
      ]),
    )
    expect(r.harm).toContain("attacker gained +9.945 ETH.")
    expect(r.harm).toContain("victim lost ≈-2 ETH (exactly -1,999,999,999,999,999,999 wei).")
    expect(r.harm).toContain("vault gained +3,980 wei.")
    expect(renderReportMarkdown(r)).toContain("vault gained +3,980 wei.")
  })

  test("a record without the exact wei reads as before", () => {
    const r = buildReport(finding([{ label: "attacker", address: "0xA", net: "+10 ETH", gained: true }]))
    expect(r.harm).toContain("attacker gained +10 ETH.")
  })
})
