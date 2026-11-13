import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReplayProof } from "../src/components/replay-proof"
import type { Finding } from "../src/lib/types"

// Does every proof module actually render end to end? There is no live recorded
// http or evidence run in this checkout (all 12 recorded findings are forge), so
// a browser walkthrough can only reach the forge card. This renders each proof
// kind — and the thin and edge-case variants — through react-dom to static
// markup, so a render-time crash in any card (a missing guard, a null field read
// as an object) fails here deterministically, with no agent run and no network.
// It also proves the shared ExportReport footer renders on all three kinds.

const base: Pick<Finding, "runId" | "severity" | "dismissed" | "decision" | "recorded" | "fuzzScan" | "calls" | "model" | "usage" | "events"> = {
  runId: "run-x",
  severity: "critical",
  dismissed: false,
  decision: null,
  recorded: true,
  fuzzScan: null,
  calls: [],
  model: "ds",
  usage: { usd: 0.42, in: 1200, out: 300, reasoning: null },
  events: [],
}

const forge: Finding = {
  ...base,
  id: "run-x.forge",
  title: "Reentrancy drains the vault",
  module: "Contracts",
  target: "Vault.sol",
  proofKind: "forge",
  proven: true,
  ms: 1234,
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  staticScan: {
    tool: "Slither",
    engines: ["Slither", "Aderyn"],
    mode: "unit",
    suspects: 2,
    top: [
      { check: "reentrancy-eth", impact: "High", where: "Vault.sol", line: 12, engines: ["Slither", "Aderyn"], corroborated: true },
    ],
  },
  hypothesis: "contract Vault { function withdraw() external { ... } }",
  explanation: "Vault.withdraw() sends ETH before it zeroes the balance.\n\nFix: zero the balance first, or add a reentrancy guard.",
  proof: {
    tool: "Foundry",
    compiler: "0.8.20",
    test: "testReentrancyDrainsVault",
    contract: "VaultTest",
    gas: 246929,
    pass: true,
    runs: [
      { n: 1, pass: false, test: "testReentrancyDrainsVault", contract: "VaultTest", gas: null, passed: 0, failed: 1, compiler: "0.8.20", raw: "run 1 failed" },
      { n: 2, pass: true, test: "testReentrancyDrainsVault", contract: "VaultTest", gas: 246929, passed: 1, failed: 0, compiler: "0.8.20", raw: "run 2 passed" },
    ],
    transfers: [{ label: "attacker", address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", net: "+10 ETH", gained: true }],
    logs: ["drained 10 ETH from the vault"],
    balances: [{ label: "Vault balance", before: "10 ETH", after: "0 ETH" }],
    assertions: ["assertEq(address(vault).balance, 0);"],
    rerunCommand: "forge test --match-test testReentrancyDrainsVault",
    testSource: "contract VaultTest is Test { }",
  },
}

const http: Finding = {
  ...base,
  id: "run-x.http",
  title: "IDOR exposes another user's record",
  module: "Web",
  target: "app.example.com",
  proofKind: "http",
  proven: true,
  ms: 820,
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  staticScan: null,
  hypothesis: "GET /api/users/:id does not check ownership",
  explanation: "The endpoint returns any record by id.\n\nFix: check the record owner against the session.",
  proof: {
    kind: "http",
    pass: true,
    oracle: { name: "cross-tenant read", detail: "victim's email returned to the attacker token", passed: true },
    exchanges: [
      {
        label: "Request 1",
        request: { method: "GET", url: "/api/users/2", headers: [{ name: "Authorization", redacted: true, sha256: "abcd1234ef567890" }], body: null },
        response: { status: 200, headers: [{ name: "Content-Type", redacted: false, value: "application/json" }], body: '{"email":"victim@example.com"}' },
      },
    ],
    detail: "The attacker token read user 2's record.",
  },
}

const evidence: Finding = {
  ...base,
  id: "run-x.evidence",
  title: "A live API key is committed to the repo",
  module: "Surface",
  target: "acme/app@c0ffee",
  proofKind: "evidence",
  proven: true,
  ms: 410,
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  staticScan: null,
  hypothesis: "config.ts line 4 holds a token",
  explanation: "The key is live and committed.\n\nFix: rotate the key and move it to a secret store.",
  proof: {
    kind: "evidence",
    pass: true,
    check: "secret present in the pinned snapshot",
    snapshotHash: "deadbeefdeadbeefdeadbeef",
    commit: "c0ffee1234",
    cited: [
      { name: "config.ts:4", redacted: false, value: "const region = 'us-east-1'" },
      { name: "token", redacted: true, sha256: "ffff0000ffff0000" },
    ],
    detail: "The token still authenticates.",
  },
}

// Thin variants: the fields a real-but-sparse record may leave empty, so an
// unguarded read surfaces here rather than in the browser.
const forgeThin: Finding = {
  ...forge,
  id: "run-x.forge-thin",
  proven: false,
  stages: { hypothesis: true, reproduced: true, proven: false, accepted: false },
  staticScan: null,
  hypothesis: null,
  explanation: null,
  proof: { ...forge.proof, pass: false, runs: [], transfers: [], logs: [], assertions: [], rerunCommand: null, testSource: null },
}

const httpThin: Finding = {
  ...http,
  id: "run-x.http-thin",
  explanation: null,
  proof: { kind: "http" as const, pass: false, oracle: { name: "no read", detail: "", passed: false }, exchanges: [], detail: "" },
}

const evidenceThin: Finding = {
  ...evidence,
  id: "run-x.evidence-thin",
  explanation: null,
  proof: { kind: "evidence" as const, pass: false, check: "absent", snapshotHash: "0", commit: null, cited: [], detail: "" },
}

describe("every proof module renders end to end", () => {
  const cases: Array<[string, Finding, string[]]> = [
    ["forge", forge, ["Proven by replay", "What the exploit moved", "+10 ETH", "Reproduce it yourself", "Test source", "contract VaultTest is Test"]],
    ["http", http, ["cross-tenant read", "/api/users/2", "What the oracle checked"]],
    ["evidence", evidence, ["secret present in the pinned snapshot", "REDACTED"]],
    ["forge (thin/unproven)", forgeThin, ["Replay not proven"]],
    ["http (thin/empty)", httpThin, []],
    ["evidence (thin/empty)", evidenceThin, []],
  ]

  for (const [name, finding, anchors] of cases) {
    test(`${name} renders without crashing and shows the shareable report`, () => {
      let html = ""
      expect(() => {
        html = renderToStaticMarkup(<ReplayProof finding={finding} />)
      }).not.toThrow()
      expect(html.length).toBeGreaterThan(0)
      // The ExportReport footer rides on every kind via ReplayProof.
      expect(html).toContain("Shareable report")
      for (const anchor of anchors) expect(html).toContain(anchor)
    })
  }

  test("a redacted cited cell shows its hash, never a secret value", () => {
    // The evidence card renders its cited cells unfolded, so the redaction shows
    // in the static markup. The redacted token cell carries only a sha256 — there
    // is no value field to leak — and the non-secret cited line renders in full.
    const html = renderToStaticMarkup(<ReplayProof finding={evidence} />)
    expect(html).toContain("REDACTED")
    expect(html).toContain("ffff0000") // the hash, shortened
    expect(html).toContain("const region = ") // the non-secret cited line, in full
  })
})
