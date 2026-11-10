import type { Finding } from "../types"
import { streamingFixture } from "./streaming"

// The rich finding the streaming fixture's proof card opens into. It is the same
// re-entrancy drain the `.events` sequence narrates, now carrying everything the
// detailed report renders: the two-engine static leads, the real money the
// replay moved, the lines it logged and checked, the reproduce command, and the
// agent's own explanation with highlighted Solidity. Every field uses the exact
// keys pinned in types.ts, so this doubles as the shape the real engine must
// serve from /api/findings/:id — the detail view is built and visually verified
// against it without a server. Stripped from a production build (DEV-only).

// Built as joined lines so the ``` code fences and inline `code` need no
// escaping. Opens with its own heading (## What goes wrong), so ReplayProof
// drops its generic "Why it works" label and lets this structure lead.
const explanation = [
  "## What goes wrong",
  "",
  "`Vault.withdraw()` sends ETH to the caller with a low-level `call` **before** it zeroes that caller's recorded balance. The state write that should close the door sits *after* the external call, so the contract still believes the caller is owed their full balance at the moment control leaves the contract.",
  "",
  "```solidity",
  "function withdraw() external {",
  "    uint256 bal = balances[msg.sender];",
  '    require(bal > 0, "nothing to withdraw");',
  '    (bool ok, ) = msg.sender.call{value: bal}(""); // interaction first',
  '    require(ok, "transfer failed");',
  "    balances[msg.sender] = 0;                       // effect last — too late",
  "}",
  "```",
  "",
  "A contract that re-enters `withdraw()` from its `receive()` hook calls back in before `balances[msg.sender] = 0` ever runs, so each re-entrant call still passes the `bal > 0` check and sends another `bal`. The attacker repeats this against a single 1 ETH deposit until the pool is empty.",
  "",
  "## Fix",
  "",
  "Apply checks-effects-interactions: zero the balance **before** the external call, or wrap the function in a `nonReentrant` guard.",
  "",
  "```solidity",
  "function withdraw() external {",
  "    uint256 bal = balances[msg.sender];",
  '    require(bal > 0, "nothing to withdraw");',
  "    balances[msg.sender] = 0;                       // effect first",
  '    (bool ok, ) = msg.sender.call{value: bal}("");  // interaction last',
  '    require(ok, "transfer failed");',
  "}",
  "```",
].join("\n")

const raw1 = [
  "[⠢] Compiling 2 files with Solc 0.8.26",
  "[⠆] Solc 0.8.26 finished in 412.08ms",
  "Compiler run successful!",
  "",
  "Ran 1 test for test/ReentryAttack.t.sol:ReentryAttack",
  "[FAIL: panic: arithmetic underflow or overflow (0x11)] testReentryDrain() (gas: 142317)",
  "Traces:",
  "  [142317] ReentryAttack::testReentryDrain()",
  "    ├─ [48211] Vault::deposit{value: 1000000000000000000}()",
  "    ├─ [24110] Vault::withdraw()",
  "    │   ├─ [21055] ReentryAttack::receive()",
  "    │   │   └─ [2300] Vault::withdraw()",
  "    │   │       └─ ← [Revert] panic: arithmetic underflow or overflow (0x11)",
  "    │   └─ ← [Revert] panic: arithmetic underflow or overflow (0x11)",
  "    └─ ← [Revert] panic: arithmetic underflow or overflow (0x11)",
  "",
  "Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 3.21ms",
].join("\n")

const raw2 = [
  "No files changed, compilation skipped",
  "",
  "Ran 1 test for test/ReentryAttack.t.sol:ReentryAttack",
  "[PASS] testReentryDrain() (gas: 187432)",
  "Logs:",
  "  attacker deposit: 1.0 ETH",
  "  vault balance before: 10.0 ETH",
  "  re-entrancy depth reached: 10",
  "  vault balance after: 0.0 ETH",
  "  attacker profit: 9.0 ETH",
  "",
  "Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 4.07ms",
].join("\n")

export const fixtureFinding: Finding = {
  id: "f-reentry",
  runId: "fixture:streaming",
  title: "Re-entrancy drains Vault.withdraw()",
  severity: "high",
  module: "Contracts",
  target: "src/Vault.sol",
  stages: { hypothesis: true, reproduced: true, proven: true, accepted: "auto" },
  proven: true,
  dismissed: false,
  ms: 48213,
  decision: "approved",
  recorded: true,
  proof: {
    tool: "forge",
    compiler: "0.8.26",
    test: "testReentryDrain",
    contract: "ReentryAttack",
    gas: 187432,
    pass: true,
    runs: [
      {
        n: 1,
        pass: false,
        test: "testReentryDrain",
        contract: "ReentryAttack",
        gas: 142317,
        passed: 0,
        failed: 1,
        compiler: "0.8.26",
        raw: raw1,
      },
      {
        n: 2,
        pass: true,
        test: "testReentryDrain",
        contract: "ReentryAttack",
        gas: 187432,
        passed: 1,
        failed: 0,
        compiler: "0.8.26",
        raw: raw2,
      },
    ],
    transfers: [
      { label: "Attacker", address: "0xA7772b9eD8cE1e3fD2b2a91C4b1F0A9d3c5E6f701", net: "+9 ETH", gained: true },
      { label: "Vault", address: "0x9f8E7d6C5B4a39281706F5e4D3c2B1a098765432", net: "−9 ETH", gained: false },
    ],
    logs: [
      "attacker deposit: 1.0 ETH",
      "vault balance before: 10.0 ETH",
      "re-entrancy depth reached: 10",
      "vault balance after: 0.0 ETH",
      "attacker profit: 9.0 ETH",
    ],
    balances: [],
    assertions: [
      "assertEq(address(vault).balance, 0) — vault fully drained",
      "assertGt(attacker.balance - startBalance, deposit) — attacker ended richer than its single deposit",
    ],
    rerunCommand: "forge test --match-test testReentryDrain -vvv",
    testSource: null,
  },
  staticScan: {
    tool: "Slither + Aderyn",
    engines: ["Slither", "Aderyn"],
    mode: "unit",
    suspects: 3,
    top: [
      {
        check: "reentrancy-eth",
        impact: "High",
        where: "Vault.withdraw()",
        line: 42,
        engines: ["Slither", "Aderyn"],
        corroborated: true,
      },
      {
        check: "unchecked-transfer",
        impact: "Medium",
        where: "Vault.withdraw()",
        line: 44,
        engines: ["Slither"],
        corroborated: false,
      },
      {
        check: "arbitrary-send-eth",
        impact: "Medium",
        where: "Vault.withdraw()",
        line: 43,
        engines: ["Aderyn"],
        corroborated: false,
      },
    ],
  },
  fuzzScan: null,
  hypothesis:
    "withdraw() sends ETH before zeroing the caller's balance, so a re-entrant receiver can withdraw repeatedly against one deposit.",
  explanation,
  calls: ["deposit()", "withdraw()", "receive()"],
  model: "deepseek-v4.1-flash-abliterated",
  usage: { usd: 0.42, in: 18234, out: 4521, reasoning: 2100 },
  events: streamingFixture,
}

// The fixture findings the DEV detail view can open, keyed by id. Mirrors
// getFixture's pattern so finding-detail resolves a fixture id before it would
// ever hit the real /api/findings/:id (which does not know these ids).
const FIXTURE_FINDINGS: Record<string, Finding> = {
  "f-reentry": fixtureFinding,
}

export function getFixtureFinding(id: string): Finding | null {
  return FIXTURE_FINDINGS[id] ?? null
}
