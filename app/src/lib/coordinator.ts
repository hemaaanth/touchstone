// Coordinator orchestration loop — fleet build step 3 (spec §5).
//
// The operator talks to ONE coordinator; the coordinator plans a run, shards the
// work, spawns hunter agents, then watches the durable Bulletin and routes every
// inbound lead through the proof gate. This file is the ONLY place the fleet's
// control flow lives. It is pure orchestration over two injected ports:
//
//   - a `BulletinClient` whose methods mirror the REAL pi-bulletin tool surface
//     (ext-research §1: bulletin_status/post/read/conflicts/resolve/sync). An
//     in-memory fake (`InMemoryBulletin`) implements it for tests. Nothing here
//     depends on a live Pi or on BB — Pi is the product runtime (not vendored
//     yet), BB is only the dev harness.
//   - an `Oracle` (the harness-owned replay proof) that returns an authoritative
//     `OracleVerdict`.
//
// The two load-bearing rules are NOT reimplemented here — they are imported from
// the frozen policy layer and enforced on every post:
//   1. `validateLeadPost` gates every inbound post (quarantine + no self-adjudication).
//   2. `applyOracleVerdict` is the ONLY thing that can set `proven`. Corroboration,
//      reactions, and an agent's own say-so never promote.
// Tier-2 posts are read from the `evidence` lane only and are treated as evidence
// submissions, never as control messages.

import type { Fleet, HunterAgent, Lead, Tier, BulletinLane } from "./fleet"
import { bulletinChannel, fleetSummary, isTerminal, leadStatus } from "./fleet"
import type { ClaimStatus, OracleVerdict, BulletinPostArgs } from "./fleet-policy"
import {
  applyOracleVerdict,
  fromBulletinClaim,
  markVerifying,
  toBulletinPost,
  validateLeadPost,
} from "./fleet-policy"

// ---------------------------------------------------------------------------
// BulletinClient — a thin interface mirroring the real pi-bulletin tools
// (ext-research §1). Identity is pi-bulletin's `PI_BULLETIN_AGENT` env, set per
// session by the spawner; here it is bound when a session is opened, so a client
// instance IS one agent's view of the board.
// ---------------------------------------------------------------------------

export type BulletinKind = "finding" | "signal" | "message"

// One persisted board event, as bulletin_read returns it. `agent` is the
// PI_BULLETIN_AGENT that posted (the board records it; the post args do not
// carry it). `seq` is the board-global append sequence.
export interface BulletinEvent {
  seq: number
  agent: string | null
  kind: BulletinKind
  ref: string
  claim: string
  value: unknown
  to: string | null
  status: ClaimStatus
  at: number
}

export interface BulletinStatus {
  root: string
  events: number
  lastDigest: string | null
  members: string[]
}

// bulletin_read result: only NEW events since the per-agent watermark, plus the
// advanced cursor.
export interface BulletinReadResult {
  events: BulletinEvent[]
  cursor: number
}

export type ConflictLevel = "hard" | "medium" | "soft"
export interface BulletinConflict {
  ref: string
  level: ConflictLevel
  seqs: number[]
}

// Post args: the frozen `BulletinPostArgs` (team_name/kind/ref/claim/status) plus
// pi-bulletin's optional `value`/`to`.
export interface BulletinPostInput extends BulletinPostArgs {
  value?: unknown
  to?: string | null
}

// The real pi-bulletin tool surface, one session = one agent (PI_BULLETIN_AGENT).
// `bulletin_compact` is omitted — the coordinator loop never archives mid-run.
export interface BulletinClient {
  bulletin_status(team_name: string): Promise<BulletinStatus>
  bulletin_post(args: BulletinPostInput): Promise<BulletinEvent>
  bulletin_read(
    team_name: string,
    since_seq?: number,
    limit?: number,
  ): Promise<BulletinReadResult>
  bulletin_conflicts(
    team_name: string,
    since_seq: number,
  ): Promise<BulletinConflict[]>
  bulletin_resolve(
    team_name: string,
    ref: string,
    decision: string,
    decision_evidence?: string | null,
    supersedes?: number[],
  ): Promise<void>
  bulletin_sync(team_name: string, digest: string, members?: string[]): Promise<void>
}

// A factory that opens a board session bound to one agent id — mirrors the real
// runtime setting PI_BULLETIN_AGENT per spawned hunter / for the coordinator.
export type BulletinSessionFactory = (agent: string) => BulletinClient

// ---------------------------------------------------------------------------
// In-memory fake — a shared board with per-agent read watermarks. Matches
// pi-bulletin's durability shape (append-only events, per-agent cursors) without
// the file I/O, so the loop is testable with no Pi and no network.
// ---------------------------------------------------------------------------

export class InMemoryBulletin {
  // team_name -> append-only event log (seq is 1-based index + 1).
  private readonly boards = new Map<string, BulletinEvent[]>()
  // `${agent}::${team}` -> last read seq.
  private readonly watermarks = new Map<string, number>()
  // team_name -> member agent ids seen.
  private readonly members = new Map<string, Set<string>>()
  private readonly digests = new Map<string, string>()

  // Open a session bound to `agent` (its PI_BULLETIN_AGENT identity).
  session(agent: string): BulletinClient {
    return {
      bulletin_status: async (team_name) => this.status(team_name),
      bulletin_post: async (args) => this.post(agent, args),
      bulletin_read: async (team_name, since_seq, limit) =>
        this.read(agent, team_name, since_seq, limit),
      bulletin_conflicts: async (team_name, since_seq) =>
        this.conflicts(team_name, since_seq),
      bulletin_resolve: async () => {
        /* audit marker only; the fake records nothing adjudicative */
      },
      bulletin_sync: async (team_name, digest) => {
        this.digests.set(team_name, digest)
      },
    }
  }

  private log(team: string): BulletinEvent[] {
    let l = this.boards.get(team)
    if (!l) {
      l = []
      this.boards.set(team, l)
    }
    return l
  }

  private status(team: string): BulletinStatus {
    const l = this.log(team)
    return {
      root: `mem://${team}`,
      events: l.length,
      lastDigest: this.digests.get(team) ?? null,
      members: [...(this.members.get(team) ?? [])],
    }
  }

  private post(agent: string, args: BulletinPostInput): BulletinEvent {
    const l = this.log(args.team_name)
    let m = this.members.get(args.team_name)
    if (!m) {
      m = new Set()
      this.members.set(args.team_name, m)
    }
    m.add(agent)
    const ev: BulletinEvent = {
      seq: l.length + 1,
      agent,
      kind: args.kind,
      ref: args.ref,
      claim: args.claim,
      value: args.value ?? null,
      to: args.to ?? null,
      status: args.status,
      at: Date.now(),
    }
    l.push(ev)
    return ev
  }

  private read(
    agent: string,
    team: string,
    since_seq?: number,
    limit?: number,
  ): BulletinReadResult {
    const l = this.log(team)
    const key = `${agent}::${team}`
    const from = since_seq ?? this.watermarks.get(key) ?? 0
    let events = l.filter((e) => e.seq > from)
    if (limit != null) events = events.slice(0, limit)
    const cursor = events.length ? events[events.length - 1].seq : from
    this.watermarks.set(key, cursor)
    return { events, cursor }
  }

  // Symbolic conflict check: two posts on the same ref are a (soft) conflict.
  // The real extension tiers these hard/medium/soft; the fake only needs to
  // surface same-ref collisions for the loop to exercise the call.
  private conflicts(team: string, since_seq: number): BulletinConflict[] {
    const l = this.log(team).filter((e) => e.seq > since_seq)
    const byRef = new Map<string, number[]>()
    for (const e of l) {
      const arr = byRef.get(e.ref) ?? []
      arr.push(e.seq)
      byRef.set(e.ref, arr)
    }
    const out: BulletinConflict[] = []
    for (const [ref, seqs] of byRef) {
      if (seqs.length > 1) out.push({ ref, level: "soft", seqs })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Sharding — plan a run into work units. Three kinds, per spec §5:
//   module    — a hunter pointed at one target module.
//   toolkit   — a hunter handed a specific tool mix, module-agnostic.
//   free-form — a hunter with no fixed module (module === null).
// ---------------------------------------------------------------------------

export type ShardKind = "module" | "toolkit" | "free-form"

export interface Shard {
  kind: ShardKind
  module: string | null
  toolkit: string[]
}

export interface RunSpec {
  // One shard per module (each gets the shared `baseToolkit`).
  modules?: string[]
  // One shard per toolkit mix, not tied to a module.
  toolkits?: string[][]
  // N free-form shards (no fixed module), each handed `baseToolkit`.
  freeForm?: number
  // Default toolkit handed to module + free-form shards.
  baseToolkit?: string[]
}

export function shardWork(spec: RunSpec): Shard[] {
  const base = spec.baseToolkit ?? []
  const shards: Shard[] = []
  for (const module of spec.modules ?? []) {
    shards.push({ kind: "module", module, toolkit: base })
  }
  for (const toolkit of spec.toolkits ?? []) {
    shards.push({ kind: "toolkit", module: null, toolkit })
  }
  for (let i = 0; i < (spec.freeForm ?? 0); i++) {
    shards.push({ kind: "free-form", module: null, toolkit: base })
  }
  return shards
}

// ---------------------------------------------------------------------------
// Spawner + Oracle ports — injected so the loop never reaches a process or the
// network directly.
// ---------------------------------------------------------------------------

// What the coordinator asks the spawner to start. `model` is neutral text (a
// registry descriptor), `tier` is registry-derived — NEVER inferred from the
// model name.
export interface HunterSpec {
  id: string
  name: string
  model: string
  tier: Tier
  shard: Shard
}

export interface HunterSpawner {
  // Start one hunter and return its registry record. The spawner is responsible
  // for setting PI_BULLETIN_AGENT = spec.id for that session.
  spawn(spec: HunterSpec): Promise<HunterAgent>
}

// The harness-owned replay proof. This is the ONLY authority that can prove a
// lead.
export interface Oracle {
  verify(lead: Lead): Promise<OracleVerdict>
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface CoordinatorOptions {
  runId: string
  coordinatorId: string
  bulletin: BulletinSessionFactory
  spawner: HunterSpawner
  oracle: Oracle
  // Injected clock — pure code stamps no wall clock of its own.
  now: () => number
}

// Why a given inbound post was not routed to the oracle.
export type RejectReason =
  | "unparseable" // not one of our JSON Lead payloads
  | "unknown-author" // author id not in the fleet registry
  | "tier-spoof" // a Tier-2 author posting into the trusted lane
  | "policy" // validateLeadPost rejected it

export interface RejectedPost {
  seq: number
  author: string | null
  lane: BulletinLane
  reason: RejectReason
  errors: string[]
}

export interface TickResult {
  // Leads promoted to `proven` this tick (through the oracle only).
  proven: Lead[]
  // Leads the oracle declined — now `dismissed`.
  dismissed: Lead[]
  // Posts that never reached the oracle, and why.
  rejected: RejectedPost[]
}

export interface CoordinatorReport {
  runId: string
  agents: number
  active: number
  proven: Lead[]
  dismissed: Lead[]
  rejected: RejectedPost[]
}

export class Coordinator {
  private readonly runId: string
  private readonly coordinatorId: string
  private readonly bulletin: BulletinSessionFactory
  private readonly spawner: HunterSpawner
  private readonly oracle: Oracle
  private readonly now: () => number

  // The coordinator's own board session (Tier-1), used to read both lanes and to
  // post promoted leads into the trusted lane.
  private readonly session: BulletinClient

  // The fleet registry — the ONLY source of an author's trust tier. A post's
  // self-declared tier is checked against this, never trusted on its own.
  private readonly registry = new Map<string, HunterAgent>()

  // Every lead we have processed, keyed by lead id, so a re-post (e.g. a
  // corroboration repost) is not re-verified and the report is stable.
  private readonly leads = new Map<string, Lead>()
  private readonly rejects: RejectedPost[] = []

  constructor(opts: CoordinatorOptions) {
    this.runId = opts.runId
    this.coordinatorId = opts.coordinatorId
    this.bulletin = opts.bulletin
    this.spawner = opts.spawner
    this.oracle = opts.oracle
    this.now = opts.now
    this.session = opts.bulletin(opts.coordinatorId)
  }

  // Plan: turn a run spec into shards. Pure delegation to `shardWork`, exposed on
  // the coordinator so the loop reads as plan → shard → spawn.
  plan(spec: RunSpec): Shard[] {
    return shardWork(spec)
  }

  // Spawn the hunters for a set of specs and build the Fleet. Each spawned agent
  // is registered so its tier is known when its posts arrive.
  async spawnFleet(specs: HunterSpec[]): Promise<Fleet> {
    const agents: HunterAgent[] = []
    for (const spec of specs) {
      const agent = await this.spawner.spawn(spec)
      this.registry.set(agent.id, agent)
      agents.push(agent)
    }
    return {
      runId: this.runId,
      coordinatorId: this.coordinatorId,
      agents,
    }
  }

  // One pass of the watch loop: drain NEW events on both lanes and route each
  // valid, non-terminal lead through the proof gate. The evidence lane is read
  // as untrusted submissions; a Tier-2 author appearing in the trusted lane is a
  // spoof and is dropped, never acted on as a control message.
  async tick(): Promise<TickResult> {
    const result: TickResult = { proven: [], dismissed: [], rejected: [] }

    for (const lane of ["bulletin", "evidence"] as const) {
      const team = bulletinChannel(this.runId, lane)
      const { events } = await this.session.bulletin_read(team)
      for (const ev of events) {
        if (ev.kind !== "finding") continue // signals/messages are not leads
        const outcome = await this.ingest(ev, lane)
        if (!outcome) continue
        if (outcome.rejected) {
          result.rejected.push(outcome.rejected)
          continue
        }
        if (!outcome.lead) continue
        const status = leadStatus(outcome.lead)
        if (status === "proven") result.proven.push(outcome.lead)
        else if (status === "dismissed") result.dismissed.push(outcome.lead)
      }
    }
    return result
  }

  // Ingest one finding event. Returns a rejection, a processed lead, or null when
  // there is nothing to do (already processed / already terminal).
  private async ingest(
    ev: BulletinEvent,
    lane: BulletinLane,
  ): Promise<{ rejected?: RejectedPost; lead?: Lead } | null> {
    const lead = fromBulletinClaim(ev.claim)
    if (!lead) {
      return { rejected: this.reject(ev, lane, "unparseable", ["claim is not a Lead payload"]) }
    }

    // Already handled? (duplicate / corroboration repost of a lead we verified.)
    const seen = this.leads.get(lead.id)
    if (seen && isTerminal(leadStatus(seen))) return null

    // Resolve the author's tier from the registry — the only trusted source.
    const author = ev.agent ? this.registry.get(ev.agent) : undefined
    if (!author) {
      return { rejected: this.reject(ev, lane, "unknown-author", [
        `author "${ev.agent ?? "<none>"}" is not in the fleet registry`,
      ]) }
    }
    const authorTier = author.tier

    // Lane/tier guard. A Tier-2 (untrusted) author in the trusted bulletin lane
    // is a spoofed control message — drop it. Tier-2 is only ever read from the
    // quarantined evidence lane.
    if (lane === "bulletin" && authorTier === 2) {
      return { rejected: this.reject(ev, lane, "tier-spoof", [
        "Tier-2 author posted into the trusted bulletin lane",
      ]) }
    }

    // The policy gate — quarantine + no self-adjudication. Validate against the
    // registry tier (not the lead's self-declared one). The lead's own `lane`
    // field is checked here too, so a Tier-2 payload claiming the trusted lane is
    // rejected even though it arrived on the evidence channel.
    const check = validateLeadPost(lead, authorTier)
    if (!check.ok) {
      return { rejected: this.reject(ev, lane, "policy", check.errors) }
    }

    // Valid lead → route through the proof gate. Record verifying bookkeeping,
    // then apply the oracle's authoritative verdict. This is the ONLY promotion
    // path; corroboration/reactions on the post are ignored here.
    const verifying = markVerifying(lead, this.coordinatorId, this.now())
    this.leads.set(lead.id, verifying)

    const verdict = await this.oracle.verify(verifying)
    const adjudicated = applyOracleVerdict(verifying, verdict)
    this.leads.set(adjudicated.id, adjudicated)

    // Promote / dismiss on the board, keyed by the lead's module ref.
    const evidenceTeam = bulletinChannel(this.runId, "evidence")
    const ref = adjudicated.module ?? "global"
    if (leadStatus(adjudicated) === "proven") {
      // Post the promoted lead into the trusted bulletin lane and mark the
      // evidence ref resolved in favour of the proof.
      await this.session.bulletin_post(
        toBulletinPost(bulletinChannel(this.runId, "bulletin"), adjudicated),
      )
      await this.session.bulletin_resolve(
        evidenceTeam,
        ref,
        "promoted",
        verdict.evidenceRef,
      )
    } else {
      await this.session.bulletin_resolve(
        evidenceTeam,
        ref,
        "dismissed",
        null,
      )
    }

    return { lead: adjudicated }
  }

  private reject(
    ev: BulletinEvent,
    lane: BulletinLane,
    reason: RejectReason,
    errors: string[],
  ): RejectedPost {
    const r: RejectedPost = { seq: ev.seq, author: ev.agent, lane, reason, errors }
    this.rejects.push(r)
    return r
  }

  // Final report for the operator: fleet size + the terminal leads, split by the
  // only two authoritative outcomes.
  report(fleet: Fleet): CoordinatorReport {
    const summary = fleetSummary(fleet)
    const proven: Lead[] = []
    const dismissed: Lead[] = []
    for (const lead of this.leads.values()) {
      const s = leadStatus(lead)
      if (s === "proven") proven.push(lead)
      else if (s === "dismissed") dismissed.push(lead)
    }
    return {
      runId: this.runId,
      agents: summary.agents,
      active: summary.active,
      proven,
      dismissed,
      rejected: [...this.rejects],
    }
  }
}
