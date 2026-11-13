import "./helpers/isolated-env"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// K5: the finding answer carries the proof gate's harm and each transfer's
// exact wei when the record has them, and an older record reads as before.
// The shapes are those of the real FeeVault record (run …2611110619-1).
const dir = mkdtempSync(path.join(tmpdir(), "finding-harm-test-"))
process.env.TOUCHSTONE_RESULTS_DIR = dir
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
// H3b: the proof's replay carries the re-run verdict the engine recorded.
writeFileSync(path.join(dir, "run-rerun-pass-2611110619-1.json"), JSON.stringify(record({ transfers, harm, replay: { kind: "forge", store: { sha256: "a".repeat(64) }, rerun: { checked: true, pass: true, command: "docker run ...", image: "img@sha256:x", ms: 1200 } } })))
writeFileSync(path.join(dir, "run-rerun-fail-2611110619-1.json"), JSON.stringify(record({ transfers, harm, replay: { kind: "forge", store: { sha256: "b".repeat(64) }, rerun: { checked: true, pass: false, reason: "the proof forked a chain, which the offline re-run cannot" } } })))

describe("the finding answer and the proof gate's harm (K5)", () => {
  test("a record with harm and exact wei sends both, and every field it sent before", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { getFinding } = await import("../server/findings.mjs")
    const f = await getFinding("harm-new-2611110619-1.1", { events: false })
    expect(f.proof.harm).toEqual(harm)
    expect(f.proof.transfers).toEqual(transfers)
  })

  test("the proof surfaces the re-run verdict, read-only: pass, a reason, or null", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { getFinding } = await import("../server/findings.mjs")
    const ok = await getFinding("rerun-pass-2611110619-1.1", { events: false })
    expect(ok.proof.rerun).toEqual({ checked: true, pass: true })
    const bad = await getFinding("rerun-fail-2611110619-1.1", { events: false })
    expect(bad.proof.rerun).toEqual({ checked: true, pass: false, reason: "the proof forked a chain, which the offline re-run cannot" })
    // No command or image leaks into the normalized proof; it is a bool + reason.
    expect(JSON.stringify(ok.proof.rerun)).not.toContain("docker run")
    // An older record without a verdict surfaces null.
    const old = await getFinding("harm-old-2611110619-1.1", { events: false })
    expect(old.proof.rerun).toBeNull()
  })

  test("an older record reads as before: no netWei, harm is null", async () => {
    // @ts-expect-error — plain .mjs module, no types
    const { getFinding } = await import("../server/findings.mjs")
    const f = await getFinding("harm-old-2611110619-1.1", { events: false })
    expect(f.proof.harm).toBeNull()
    for (const t of f.proof.transfers) expect(Object.keys(t).sort()).toEqual(["address", "gained", "label", "net"])
  })
})
