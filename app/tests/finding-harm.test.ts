import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// K5: the finding answer carries the proof gate's harm and each transfer's
// exact wei when the record has them, and an older record reads as before.
// The shapes are those of the real FeeVault record (run …2611110619-1).
const dir = mkdtempSync(path.join(tmpdir(), "finding-harm-test-"))
useEnv({ TOUCHSTONE_RESULTS_DIR: dir })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const transfers = [
  { address: "0x2e234dae75c793f67a35089c9d99245e1c58470b", label: "Deployed contract", net: "+10.945 ETH", netWei: "10945000000000000000", gained: true },
  { address: "0x000000000000000000000000000000000000beef", label: "Account", net: "-10 ETH", netWei: "-10000000000000000000", gained: false },
]
const harm = { ok: true, kind: "funds", victim: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", lostWei: "9945000000000000000", targets: [{ address: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f", name: "FeeVault" }], writes: 13 }
const record = (proof: Record<string, unknown>) => ({
  result: {
    outcome: "recorded",
    recorded: true,
    findings: [{ title: "Reentrancy in withdrawAll", severity: "critical", poc: "ReentrancyTest", proof: { kind: "forge", tool: "forge", contract: "ReentrancyTest", test: "test_drain", status: "pass", pass: true, gasUsed: 1000, logs: [], ...proof } }],
  },
})
writeFileSync(path.join(dir, "run-harm-new-2611110619-1.json"), JSON.stringify(record({ transfers, harm })))
// A record from before netWei and harm.
writeFileSync(path.join(dir, "run-harm-old-2611110619-1.json"), JSON.stringify(record({ transfers: transfers.map(({ netWei: _, ...t }) => t) })))

describe("the finding answer and the proof gate's harm (K5)", () => {
  test("a record with harm and exact wei sends both, and every field it sent before", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { getFinding } = await import("../server/findings.mjs")
    const f = await getFinding("harm-new-2611110619-1.1", { events: false })
    expect(f.proof.harm).toEqual(harm)
    expect(f.proof.transfers).toEqual(transfers)
  })

  // N3 (B7): a record from before the harm check has no harm verdict. Harm was
  // not judged, so it is a candidate, not a finding. The record is unchanged.
  test("an older record from before the harm check reads as a candidate: harm not judged", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { getFinding, listCandidates } = await import("../server/findings.mjs")
    expect(await getFinding("harm-old-2611110619-1.1", { events: false })).toBeNull()
    const c = (await listCandidates()).find((x: { runId: string }) => x.runId === "harm-old-2611110619-1")
    expect(c.origin).toBe("measured")
    expect(c.proven).toBe(false)
    expect(c.measured.words).toBe("Harm not judged: recorded before the harm check.")
  })
})
