// Touchstone's proof-gate + quarantine policy — the ONE bespoke layer over the
// `pi-bulletin` board. Pure domain logic, NO I/O: the harness wires these to the
// real pi-bulletin tools (bulletin_post / bulletin_read / bulletin_sync, see
// docs/ext-research.md §1); this file enforces the two rules pi-bulletin itself
// has no concept of:
//
//   1. QUARANTINE — a Tier-2 (untrusted attacker) post is evidence, never a
//      control message. It can only enter the `evidence` lane, can only be
//      `proposed`, and cannot adjudicate its own or anyone's lead.
//   2. PROOF GATE — nothing graduates to `proven` except by the harness-owned
//      oracle's replay proof. Reactions, corroboration, and an agent's own say-so
//      never earn `proven`. This is the core claim: "a finding is real only when
//      a replay proves it."
//
// Trust is registry-derived: the author's `tier` is passed in, NEVER inferred
// from a model name.

import type { Lead, LeadStatus, Tier, BulletinLane } from "./fleet"
import { leadStatus, isTerminal } from "./fleet"

// pi-bulletin's own evidence tier (its `status` param on bulletin_post). Our
// LeadStatus is a superset; this is the subset that crosses the wire.
export type ClaimStatus = "proposed" | "confirmed" | "contested" | "superseded"

// The quarantined lane for untrusted workers vs the trusted shared board.
// Tier 2 is untrusted → evidence. Tier 0/1 are trusted → bulletin.
export function laneForTier(tier: Tier): BulletinLane {
  return tier === 2 ? "evidence" : "bulletin"
}

// The highest evidence tier an author may self-assert at post time. An untrusted
// worker can only ever say "proposed" — it submits, it does not corroborate or
// confirm. Trusted agents may post a `confirmed` observation (still NOT proof).
export function maxClaimStatusForTier(tier: Tier): ClaimStatus {
  return tier === 2 ? "proposed" : "confirmed"
}

export interface PostValidation {
  ok: boolean
  errors: string[]
  // The lane the post is forced into, regardless of what the author requested.
  lane: BulletinLane
}

// Validate a would-be bulletin post and resolve its lane. Enforces quarantine
// and the "a post never adjudicates" rule. `authorTier` comes from the registry.
export function validateLeadPost(lead: Lead, authorTier: Tier): PostValidation {
  const errors: string[] = []
  const lane = laneForTier(authorTier)

  if (!lead.claim.trim()) errors.push("claim is empty")
  if (!lead.mechanism.trim()) errors.push("mechanism is empty")

  // The author's recorded tier must match the registry tier at post time —
  // otherwise a post could spoof a trust level.
  if (lead.tier !== authorTier) {
    errors.push(`lead.tier ${lead.tier} != registry tier ${authorTier}`)
  }

  // A post may only enter in a pre-adjudication state. `verifying`, `proven`,
  // and `dismissed` are harness/oracle outcomes, never a self-declared post.
  const posted = leadStatus(lead)
  if (posted !== "proposed" && posted !== "corroborated") {
    errors.push(`cannot post a lead already at status "${posted}"`)
  }

  // Quarantine: an untrusted worker can only submit a bare `proposed` lead to
  // the evidence lane. It cannot self-corroborate or claim the trusted lane.
  if (authorTier === 2) {
    if (lead.lane !== "evidence") errors.push("Tier-2 may only post to the evidence lane")
    if (posted !== "proposed") errors.push("Tier-2 may only post a `proposed` lead")
  } else if (lead.lane !== lane) {
    errors.push(`Tier-${authorTier} lead must be in the "${lane}" lane`)
  }

  return { ok: errors.length === 0, errors, lane }
}

// Map our LeadStatus onto the pi-bulletin ClaimStatus that crosses the wire.
// Our proof-gate states (verifying/proven/dismissed) have no pi-bulletin
// equivalent, so they collapse to the nearest evidence tier for the board; the
// authoritative status lives in our own run-state transitions, not the board.
export function toClaimStatus(status: LeadStatus): ClaimStatus {
  switch (status) {
    case "proposed":
      return "proposed"
    case "corroborated":
    case "verifying":
    case "proven":
      return "confirmed"
    case "dismissed":
      return "superseded"
  }
}

// The args for a real `bulletin_post` call. `ref` keys pi-bulletin's cheap
// conflict detector on the module (or "global"); the full Lead round-trips as a
// JSON payload in `claim` so the console can rebuild it. `team_name` is the
// lane's channel — the caller passes bulletinChannel(runId, validation.lane).
export interface BulletinPostArgs {
  team_name: string
  kind: "finding"
  ref: string
  claim: string
  status: ClaimStatus
}

export function toBulletinPost(teamName: string, lead: Lead): BulletinPostArgs {
  return {
    team_name: teamName,
    kind: "finding",
    ref: lead.module ?? "global",
    claim: JSON.stringify(lead),
    status: toClaimStatus(leadStatus(lead)),
  }
}

// Inverse: rebuild a Lead from a pi-bulletin event's `claim` payload. Returns
// null on anything that is not one of our JSON Lead payloads (a plain-text post
// from another tool, a torn record), so a malformed board entry is ignored, not
// trusted.
export function fromBulletinClaim(claim: string): Lead | null {
  try {
    const v = JSON.parse(claim) as Partial<Lead>
    if (!v || typeof v !== "object") return null
    if (typeof v.id !== "string" || typeof v.claim !== "string") return null
    if (typeof v.mechanism !== "string" || !Array.isArray(v.transitions)) return null
    return v as Lead
  } catch {
    return null
  }
}

// The authoritative oracle verdict — the harness-owned replay proof's result.
// This is the ONLY input that can graduate a lead to `proven`. `at` is passed in
// (pure code stamps no clock).
export interface OracleVerdict {
  // true ONLY when the oracle's replay proved harm. Nothing else sets `proven`.
  proven: boolean
  // The authoritative evidence handle the proof produced (a replay record id).
  evidenceRef: string | null
  at: number // epoch ms
  reason: string | null // why it did not prove, for a dismissal
}

// Record that the coordinator has routed a proposed lead to the oracle. Moves
// proposed/corroborated → verifying. `by` is the coordinator agent id. Idempotent
// on terminal leads. This is bookkeeping, NOT proof.
export function markVerifying(lead: Lead, by: string, at: number): Lead {
  if (isTerminal(leadStatus(lead))) return lead
  const status: LeadStatus = "verifying"
  return {
    ...lead,
    status,
    transitions: [...lead.transitions, { status, at, by }],
  }
}

// A second trusted agent corroborating a lead. Social signal only — moves
// proposed → corroborated and can NEVER reach proven. `by` is the corroborator.
// Rejected (returns the lead unchanged) for Tier-2 and for terminal leads.
export function corroborate(lead: Lead, by: string, byTier: Tier, at: number): Lead {
  if (byTier === 2) return lead // untrusted cannot corroborate
  if (leadStatus(lead) !== "proposed") return lead
  const status: LeadStatus = "corroborated"
  return {
    ...lead,
    status,
    transitions: [...lead.transitions, { status, at, by }],
  }
}

// THE PROOF GATE. Apply the oracle's authoritative verdict:
//   proven  → status `proven`, lane graduates to the trusted `bulletin` (out of
//             quarantine), evidenceRef pinned to the replay record. `by` is null
//             (the harness/oracle, never an agent).
//   !proven → status `dismissed`, lane unchanged (an unproven Tier-2 lead stays
//             quarantined), reason recorded.
// Idempotent: an already-terminal lead is returned unchanged.
export function applyOracleVerdict(lead: Lead, verdict: OracleVerdict): Lead {
  if (isTerminal(leadStatus(lead))) return lead
  if (verdict.proven) {
    const status: LeadStatus = "proven"
    return {
      ...lead,
      status,
      lane: "bulletin", // graduates out of quarantine
      evidenceRef: verdict.evidenceRef ?? lead.evidenceRef,
      transitions: [...lead.transitions, { status, at: verdict.at, by: null }],
    }
  }
  const status: LeadStatus = "dismissed"
  return {
    ...lead,
    status,
    transitions: [...lead.transitions, { status, at: verdict.at, by: null }],
  }
}

// Guard for the console: only a `proven` lead earns success signalling. Mirrors
// the design-track rule (docs §6a) — Done/Failed agents and High/Critical chips
// stay neutral until this is true.
export function earnsSuccessSignal(lead: Lead): boolean {
  return leadStatus(lead) === "proven"
}
