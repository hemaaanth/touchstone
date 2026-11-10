import type { RunEvent } from "../types"

// A canned COMPREHENSIVE audit: the agent ranks its suspects, proves a medium
// first, keeps going, proves a high and a low, and the recorder replays all three
// worst first. It is the visual harness for several finding cards in one run.
// Sandbox Foundry only — never live funds (NO-LIVE-HARM).

const RUN = "fixture:audit"

const plan =
  "Suspects, worst first: 1) withdraw() pays out before it zeroes the balance (re-entrancy). 2) setFee() has no access control. 3) sweep() rounds the fee down to zero for small amounts. I will prove each one with its own test."

const poc = (n: number, contract: string, title: string, severity: string): RunEvent[] => [
  { ev: "run_poc", attempt: n, contract },
  { ev: "run_poc-done", contract, passed: true },
  { ev: "finding-submitted", n, title, severity, poc: contract },
]

export const auditFixture: RunEvent[] = [
  {
    ev: "scope",
    id: "vault-local",
    title: "Vault.sol — full audit",
    kind: "local-source",
    entry: "src/Vault.sol",
    signal: "static",
  },
  { ev: "opened", mode: "run" },
  { ev: "list_sources" },
  { ev: "read_source", file: "src/Vault.sol" },
  { ev: "assistant-delta", conv: "root", attempt: 0, text: plan },
  // The agent finds the medium first, submits it, and keeps going.
  ...poc(1, "FeeAccessTest", "Anyone can set the protocol fee", "medium"),
  // A repeat submission is refused; the audit goes on.
  { ev: "submit-rejected", poc: "FeeAccessTest", reason: "duplicate" },
  ...poc(2, "ReentryDrainTest", "Re-entrancy drains Vault.withdraw()", "high"),
  { ev: "audit-continue", found: 2, left: 8 },
  ...poc(3, "FeeRoundingTest", "Fee rounds to zero on small sweeps", "low"),
  {
    ev: "say",
    conv: "root",
    attempt: 1,
    text: "Coverage: re-entrancy — proven. Fee access — proven. Fee rounding — proven. Nothing left untried.",
  },
  { ev: "status", status: "deciding" },
  // The recorder replays each one, worst first.
  ...(
    [
      ["1", "Re-entrancy drains Vault.withdraw()", "high", "ReentryDrainTest"],
      ["2", "Anyone can set the protocol fee", "medium", "FeeAccessTest"],
      ["3", "Fee rounds to zero on small sweeps", "low", "FeeRoundingTest"],
    ] as const
  ).flatMap(([k, title, severity, contract]): RunEvent[] => [
    { ev: "finding", id: `${RUN}.${k}`, runId: RUN, title, severity, poc: contract, proven: true, target: "src/Vault.sol" },
    { ev: "artifact-open", id: `proof-${RUN}.${k}`, title: `Replay proof — ${contract}`, kind: "proof", findingId: `${RUN}.${k}` },
    { ev: "artifact-done", id: `proof-${RUN}.${k}` },
  ]),
  {
    ev: "status",
    status: "recorded",
    decision: "approve",
    findingId: `${RUN}.1`,
    findingIds: [`${RUN}.1`, `${RUN}.2`, `${RUN}.3`],
  },
  { ev: "closed" },
]
