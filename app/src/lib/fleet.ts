// Fleet orchestration data model. See docs/fleet-orchestration.md.
//
// The operator talks to ONE coordinator; the coordinator spins up parallel
// hunter agents (the operator never chats with them). The agents coordinate
// through a durable Bulletin — the `pi-bulletin` Pi extension's persisted board
// (blackboard pattern), NOT any BB/dev-harness feature. Touchstone ships with Pi
// bundled and depends on nothing external at runtime. This file is the shared
// contract between the harness (which runs the fleet) and the console (which
// visualizes it): the Lead shape plus Touchstone's own trust/quarantine policy,
// which pi-bulletin does not provide. Types + pure derivations only — no I/O.

import type { Severity } from "./types"

// Trust tier. Registry-derived, NEVER inferred from the model name or brand.
//   0 — the operator (human) and the coordinator's conversational surface
//   1 — coordinator + trusted hunter/analyst agents (trusted orchestration)
//   2 — attacker workers: UNTRUSTED NEAR abliterated models in offline
//       sandboxes. Their bulletin posts are evidence submissions, never control
//       messages, and stay in the quarantined evidence lane until the harness
//       validates them.
export type Tier = 0 | 1 | 2

export type Loadout = "confined" | "free-roam"
export type LoadoutOption = "wallet" | "email"

// Neutral agent lifecycle. Done is NOT success and Failed is NOT danger — the
// console reserves success/danger signalling for an authoritative *proven* lead
// (docs §6a), never for an agent merely finishing or erroring.
export type AgentStatus = "spawning" | "working" | "idle" | "done" | "failed"

// Spend for one agent. Unknown is `null` (the console renders "—"), never 0 —
// "we don't know yet" must not read as "it cost nothing". Dollars are the
// primary field; token counts live in the row's disclosure.
export interface AgentSpend {
  usd: number | null
  tokensIn: number | null
  tokensOut: number | null
}

// One child agent in the fleet. `model` is neutral text shown beside the name,
// never a brand chip or a colour. `tier` is the registry trust label and is the
// only thing that may mark an agent untrusted — not its model name.
export interface HunterAgent {
  // Stable short id, reused verbatim across the Fleet list, Bulletin authorship,
  // and evidence so one agent reads as one identity everywhere.
  id: string
  name: string // primary identity
  model: string // neutral descriptor, e.g. "near-abliterated-70b"
  tier: Tier
  // Missing fields in legacy records mean confined with no optional tools.
  loadout?: Loadout
  options?: LoadoutOption[]
  status: AgentStatus
  // Current work, one line (the console truncates it). null before first task.
  task: string | null
  // What this hunter was pointed at. A free-form hunter has module === null.
  module: string | null
  toolkit: string[] // the mix of tools it was handed
  spend: AgentSpend
}

// Which lane a bulletin entry lives in.
//   "bulletin" — the trusted lane: Tier-1 leads, triage, dispatch.
//   "evidence" — the quarantined Tier-2 lane: untrusted worker submissions.
//                Promotion into the trusted lane requires harness validation
//                (the oracle / replay proof), never a reaction or a vote.
export type BulletinLane = "bulletin" | "evidence"

// A lead's lifecycle. `proven` and `dismissed` are alternative TERMINAL
// outcomes; everything else is in flight.
export type LeadStatus =
  | "proposed"
  | "corroborated"
  | "verifying"
  | "proven"
  | "dismissed"

// One recorded status change. The console renders the recorded transitions only
// and MUST NOT infer earlier stages from the current status (docs §6a) — a lead
// that jumped straight to `dismissed` never implies it was ever `proven`.
export interface LeadTransition {
  status: LeadStatus
  at: number // epoch ms, stamped when the transition was recorded
  // The agent that caused it, or null when the harness/oracle did (e.g. the
  // authoritative promotion to `proven`).
  by: string | null
}

// A reaction on a lead. Reactions and corroboration are social signal, NOT
// proof — only an authoritative harness result earns `proven`.
export interface Reaction {
  emoji: string
  by: string[] // agentIds
}

// One bulletin entry (a "Lead"). This is the §3 schema: the shared message shape
// posted to `run:<id>:bulletin` (trusted) or `run:<id>:evidence` (quarantined).
export interface Lead {
  id: string
  lane: BulletinLane
  author: string // agentId
  tier: Tier // the author's tier at post time (drives the trust label)
  module: string | null
  toolkit: string[]
  claim: string // what the author asserts was found
  mechanism: string // the claimed mechanism — what breaks and how
  // Handle to the backing evidence (a PoC id, a findings record, a snapshot
  // hash). null while the lead is still a bare hypothesis.
  evidenceRef: string | null
  severity: Severity
  // The current status === the last recorded transition's status. Kept here for
  // convenience; `transitions` is the source of truth the UI renders.
  status: LeadStatus
  transitions: LeadTransition[]
  // Parent lead id when this corroborates or replies to another lead.
  replyTo: string | null
  reactions: Reaction[]
}

// The whole fleet for one run. Durable: rebuilt from persisted run state +
// bulletin channel history on restart (docs §7).
export interface Fleet {
  runId: string
  coordinatorId: string // the Tier-1 coordinator the operator talks to
  agents: HunterAgent[]
}

// Header-chip summary, e.g. "Fleet · 8 agents · 5 active". Counts unique child
// ids — several hunters sharing a model are still separate agents.
export interface FleetSummary {
  agents: number
  active: number
}

// The pi-bulletin topic/board name for a run's lane. One place owns the
// convention so the harness and console never drift (docs §3).
export function bulletinChannel(runId: string, lane: BulletinLane): string {
  return `run:${runId}:${lane}`
}

// Derive the header summary. `active` counts agents that are spawning or
// working — the ones currently doing something, not idle/done/failed.
export function fleetSummary(fleet: Fleet): FleetSummary {
  const ids = new Set(fleet.agents.map((a) => a.id))
  const active = fleet.agents.filter(
    (a) => a.status === "spawning" || a.status === "working",
  ).length
  return { agents: ids.size, active }
}

// The current status of a lead, read from its recorded transitions (the source
// of truth). Falls back to the stored `status` when no transition is recorded
// yet. Never infers intermediate stages.
export function leadStatus(lead: Lead): LeadStatus {
  const last = lead.transitions[lead.transitions.length - 1]
  return last ? last.status : lead.status
}

// Whether a lead reached an authoritative terminal outcome. Only `proven` earns
// success signalling in the console; `dismissed` is the neutral counterpart.
export function isTerminal(status: LeadStatus): boolean {
  return status === "proven" || status === "dismissed"
}
