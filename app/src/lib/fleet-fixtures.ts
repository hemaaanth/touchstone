// Local mock Fleet + Lead fixtures for the operator console's Fleet panel and
// Bulletin feed. The LIVE coordinator that produces this data is a sibling
// track; until it lands, the console renders against these fixtures. They are
// the ONLY thing to delete when live data drops in — every component takes a
// `Fleet` and a `Lead[]` as props, so the wiring seam is a single prop pair.
//
// Four states are covered so each design rule is visible in isolation:
//   empty     — a run with a coordinator but no hunters and no posts.
//   populated — a live fleet mid-run: mixed tiers, spends, and lead statuses,
//               including an unknown spend ("—", never 0).
//   tier2     — a Tier-2 (untrusted) evidence submission, quarantined and
//               unproven, kept in the evidence lane.
//   proven    — a lead the oracle graduated to `proven` (the one place success
//               signalling is earned), alongside a dismissed terminal lead.

import type { Fleet, Lead, HunterAgent } from "./fleet"

// Stable clock so relative times read sensibly without a live backend. All
// offsets are "minutes ago" from one captured instant.
const T0 = Date.now()
const min = (m: number) => T0 - m * 60_000

// ── Agents ──────────────────────────────────────────────────────────────────

// The coordinator is NOT a child: it lives in the conversation header, not the
// Fleet list, and is kept out of `fleet.agents` so `fleetSummary` counts unique
// CHILD ids only (docs §6b — "Fleet · N agents · M active" means children).
export const coordinatorAgent: HunterAgent = {
  id: "coord",
  name: "Coordinator",
  model: "claude-opus-4-8",
  tier: 1,
  status: "working",
  task: "Watching the bulletin; routing proposed leads to the oracle.",
  module: null,
  toolkit: ["planner", "oracle-dispatch"],
  spend: { usd: 0.42, tokensIn: 184_200, tokensOut: 31_040 },
}

const hunters: HunterAgent[] = [
  {
    id: "h-recon-1",
    name: "Recon-Alpha",
    model: "claude-sonnet-4-8",
    tier: 1,
    status: "working",
    task: "Mapping the dex router's approve/transferFrom allowance surface.",
    module: "defi-dex",
    toolkit: ["slither", "foundry", "rpc-probe"],
    spend: { usd: 0.18, tokensIn: 92_400, tokensOut: 12_880 },
  },
  {
    id: "h-exploit-1",
    name: "Exploit-Beta",
    model: "claude-sonnet-4-8",
    tier: 1,
    status: "working",
    task: "Drafting a reentrancy PoC against the staking withdraw path.",
    module: "defi-staking",
    toolkit: ["foundry", "cast", "anvil-fork"],
    spend: { usd: 0.27, tokensIn: 140_100, tokensOut: 24_600 },
  },
  {
    id: "h-recon-2",
    name: "Recon-Gamma",
    model: "claude-haiku-4-8",
    tier: 1,
    status: "idle",
    task: "Handed its allowance lead to Exploit-Beta; awaiting the next shard.",
    module: "defi-dex",
    toolkit: ["rpc-probe", "etherscan"],
    spend: { usd: 0.06, tokensIn: 38_900, tokensOut: 4_210 },
  },
  {
    id: "w-attacker-1",
    name: "Attacker-01",
    model: "near-abliterated-70b",
    tier: 2,
    status: "working",
    task: "Composing a signed raw-tx drain in the offline sandbox.",
    module: "defi-staking",
    toolkit: ["raw-tx", "sandbox-signer"],
    // Untrusted sandbox worker: spend is not metered through the trusted
    // registry yet, so it is unknown — renders "—", never 0.
    spend: { usd: null, tokensIn: null, tokensOut: null },
  },
  {
    id: "h-analyst-1",
    name: "Analyst-Delta",
    model: "claude-sonnet-4-8",
    tier: 1,
    status: "done",
    task: "Triaged the oracle-price lead; wrote the mechanism note.",
    module: "oracle-price",
    toolkit: ["notebook", "math-check"],
    spend: { usd: 0.11, tokensIn: 61_300, tokensOut: 9_050 },
  },
  {
    id: "h-exploit-2",
    name: "Exploit-Epsilon",
    model: "claude-sonnet-4-8",
    tier: 1,
    status: "failed",
    task: "Fork harness ran out of gas before the invariant tripped.",
    module: "defi-lending",
    toolkit: ["foundry", "anvil-fork"],
    spend: { usd: 0.09, tokensIn: 44_700, tokensOut: 6_120 },
  },
]

// A second untrusted worker whose submission the oracle proved — used by the
// `proven` fixture so graduation is visible on a real author.
const provenWorker: HunterAgent = {
  id: "w-attacker-2",
  name: "Attacker-02",
  model: "near-abliterated-70b",
  tier: 2,
  status: "done",
  task: "Submitted the credited-drain raw-tx; the oracle replayed it.",
  module: "defi-staking",
  toolkit: ["raw-tx", "sandbox-signer"],
  spend: { usd: null, tokensIn: null, tokensOut: null },
}

// ── Leads ───────────────────────────────────────────────────────────────────

// A trusted Tier-1 lead, corroborated by a second hunter, now being verified.
const leadAllowance: Lead = {
  id: "lead-allow",
  lane: "bulletin",
  author: "h-recon-1",
  tier: 1,
  module: "defi-dex",
  toolkit: ["slither", "rpc-probe"],
  claim: "Router leaves an unbounded allowance after a failed swap.",
  mechanism:
    "swapExactTokensForTokens approves the pair for the full input, then reverts on slippage without resetting the approval — a later attacker transferFrom drains the stranded approval.",
  evidenceRef: "poc:dex-allow-0x9f",
  severity: "high",
  status: "verifying",
  transitions: [
    { status: "proposed", at: min(48), by: "h-recon-1" },
    { status: "corroborated", at: min(41), by: "h-recon-2" },
    { status: "verifying", at: min(12), by: "coord" },
  ],
  replyTo: null,
  reactions: [
    { emoji: "👀", by: ["h-exploit-1", "h-analyst-1"] },
    { emoji: "➕", by: ["h-recon-2"] },
  ],
}

// A plain proposed Tier-1 lead, no corroboration yet.
const leadOracle: Lead = {
  id: "lead-oracle",
  lane: "bulletin",
  author: "h-analyst-1",
  tier: 1,
  module: "oracle-price",
  toolkit: ["math-check"],
  claim: "Spot-price oracle is manipulable within a single block.",
  mechanism:
    "getPrice reads the pair reserves directly, so a flash-loan-sized swap moves the quoted price for any call later in the same transaction.",
  evidenceRef: null,
  severity: "critical",
  status: "proposed",
  transitions: [{ status: "proposed", at: min(23), by: "h-analyst-1" }],
  replyTo: null,
  reactions: [{ emoji: "👀", by: ["coord"] }],
}

// A trusted lead the oracle DISMISSED — a terminal outcome that must never read
// as "was once proven". It jumps proposed → verifying → dismissed.
const leadLending: Lead = {
  id: "lead-lend",
  lane: "bulletin",
  author: "h-exploit-2",
  tier: 1,
  module: "defi-lending",
  toolkit: ["foundry"],
  claim: "Liquidation rounding lets a borrower keep dust collateral free.",
  mechanism:
    "The close-factor math rounds the seized amount down, so a dust position can be liquidated for less than it holds.",
  evidenceRef: "poc:lend-round-0x4c",
  severity: "medium",
  status: "dismissed",
  transitions: [
    { status: "proposed", at: min(70), by: "h-exploit-2" },
    { status: "verifying", at: min(55), by: "coord" },
    { status: "dismissed", at: min(50), by: null },
  ],
  replyTo: null,
  reactions: [],
}

// The Tier-2 EVIDENCE submission: untrusted, quarantined to the evidence lane,
// only ever `proposed`. High severity but it MUST stay neutral (unproven).
const leadEvidence: Lead = {
  id: "lead-ev-1",
  lane: "evidence",
  author: "w-attacker-1",
  tier: 2,
  module: "defi-staking",
  toolkit: ["raw-tx"],
  claim: "Signed raw-tx drains the staking vault via the withdraw reentrancy.",
  mechanism:
    "withdraw() sends native value before zeroing the stake, so a contract receiver re-enters and withdraws again. Attached tx replays the drain against the fork.",
  evidenceRef: "tx:0x7ad9…c1",
  severity: "critical",
  status: "proposed",
  transitions: [{ status: "proposed", at: min(8), by: "w-attacker-1" }],
  replyTo: "lead-allow",
  reactions: [],
}

// The PROVEN lead: a Tier-2 evidence submission the oracle replayed and
// graduated. It carries the full recorded path and is the only lead that earns
// success signalling. Note the terminal `proven` was recorded `by: null`
// (the harness/oracle, never an agent).
const leadProven: Lead = {
  id: "lead-proven",
  lane: "bulletin",
  author: "w-attacker-2",
  tier: 2,
  module: "defi-staking",
  toolkit: ["raw-tx", "sandbox-signer"],
  claim: "Credited drain of the staking vault, proven by replay.",
  mechanism:
    "The reentrant withdraw path lets a receiver contract re-enter before the stake is zeroed; the signed raw-tx drains the vault and the balance change is credited to the attacker on replay.",
  evidenceRef: "replay:0xproof-2b7f",
  severity: "critical",
  status: "proven",
  transitions: [
    { status: "proposed", at: min(40), by: "w-attacker-2" },
    { status: "verifying", at: min(20), by: "coord" },
    { status: "proven", at: min(6), by: null },
  ],
  replyTo: null,
  reactions: [
    { emoji: "✅", by: ["coord", "h-analyst-1"] },
    { emoji: "🔥", by: ["h-exploit-1"] },
  ],
}

// ── Fixture sets ─────────────────────────────────────────────────────────────

export interface FleetFixture {
  key: string
  label: string
  note: string
  fleet: Fleet
  leads: Lead[]
}

const RUN = "run-7f3a"

export const FIXTURES: FleetFixture[] = [
  {
    key: "empty",
    label: "Empty",
    note: "A run with a coordinator but no hunters spawned and no bulletin posts yet.",
    fleet: { runId: RUN, coordinatorId: "coord", agents: [] },
    leads: [],
  },
  {
    key: "populated",
    label: "Populated",
    note: "A live fleet mid-run: mixed tiers and statuses, one unknown spend, leads in flight.",
    fleet: {
      runId: RUN,
      coordinatorId: "coord",
      agents: [...hunters],
    },
    leads: [leadAllowance, leadOracle, leadEvidence, leadLending],
  },
  {
    key: "tier2",
    label: "Tier-2 evidence",
    note: "An untrusted Tier-2 worker's evidence submission: quarantined, unproven, no trusted-peer controls.",
    fleet: {
      runId: RUN,
      coordinatorId: "coord",
      agents: [hunters[1], hunters[3]],
    },
    leads: [leadEvidence],
  },
  {
    key: "proven",
    label: "Proven",
    note: "A Tier-2 submission the oracle replayed and graduated to proven — the one place success signalling is earned — beside a dismissed terminal lead.",
    fleet: {
      runId: RUN,
      coordinatorId: "coord",
      agents: [hunters[1], provenWorker],
    },
    leads: [leadProven, leadLending],
  },
]
