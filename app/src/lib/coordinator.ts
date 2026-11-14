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

import type { Fleet, HunterAgent, Lead, Tier, BulletinLane, LeadTransition, Loadout, LoadoutOption } from "./fleet"
import { bulletinChannel, fleetSummary, leadStatus } from "./fleet"
import type { ClaimStatus, OracleVerdict, BulletinPostArgs } from "./fleet-policy"
import {
  applyOracleVerdict,
  fromBulletinClaim,
  isOracleVerdict,
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
  loadout?: Loadout
  options?: LoadoutOption[]
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
  // Add one default free-form roam shard. Explicit false opts out.
  freeRoam?: boolean
}

function normalizeLoadout(loadout: Loadout = "confined", options: LoadoutOption[] = []): { loadout: Loadout; options: LoadoutOption[] } {
  if (loadout !== "confined" && loadout !== "free-roam") throw new Error("Unknown loadout.")
  if (!Array.isArray(options)) throw new Error("Unknown loadout option.")
  for (const option of options) {
    if (option !== "wallet" && option !== "email") throw new Error("Unknown loadout option.")
  }
  if (loadout === "confined" && options.length) throw new Error("Confined agents cannot have loadout options.")
  return { loadout, options: [...new Set(options)] }
}

export function shardWork(spec: RunSpec): Shard[] {
  const base = spec.baseToolkit ?? []
  const shards: Shard[] = []
  for (const module of spec.modules ?? []) {
    shards.push({ kind: "module", module, toolkit: [...base], loadout: "confined", options: [] })
  }
  for (const toolkit of spec.toolkits ?? []) {
    shards.push({ kind: "toolkit", module: null, toolkit: [...toolkit], loadout: "confined", options: [] })
  }
  for (let i = 0; i < (spec.freeForm ?? 0); i++) {
    shards.push({ kind: "free-form", module: null, toolkit: [...base], loadout: "confined", options: [] })
  }
  if (spec.freeRoam !== false) {
    shards.push({ kind: "free-form", module: null, toolkit: [...base], loadout: "free-roam", options: [] })
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
  loadout?: Loadout
  options?: LoadoutOption[]
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
  | "non-finding" // a signal/message kind, audited not silently dropped
  | "unknown-author" // author id not in the fleet registry
  | "author-spoof" // lead.author != the posting agent (PI_BULLETIN_AGENT)
  | "tier-spoof" // a Tier-2 author posting into the trusted lane
  | "lane-mismatch" // the lead's own `lane` field != the channel it arrived on
  | "policy" // validateLeadPost rejected it
  | "duplicate" // id already processed in this lane's trust scope

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
  // Leads that were validated and marked `verifying` but whose oracle/post/
  // resolve step threw. They are NOT dropped: they stay registered and are
  // retried on the next tick. Surfaced here so a throw is never silent.
  stranded: Lead[]
  // Posts that never reached the oracle, and why.
  rejected: RejectedPost[]
}

export interface CoordinatorReport {
  runId: string
  agents: number
  active: number
  proven: Lead[]
  dismissed: Lead[]
  // Leads still mid-flight (validated, verifying, awaiting a successful oracle
  // round) at report time.
  stranded: Lead[]
  rejected: RejectedPost[]
}

// Max events pulled from one lane per read, so a single tick is bounded.
const READ_LIMIT = 256

// A validated lead marked `verifying`, awaiting (or retrying) its oracle round.
interface PendingLead {
  key: string // trust-scoped dedup key
  lead: Lead
  lane: BulletinLane // the channel it arrived on (where we resolve it)
  seq: number // the originating post's board sequence
}

// ---------------------------------------------------------------------------
// Known limitations / real-runtime deltas (acknowledged, scoped follow-ups):
//
//   F9 (restart rehydration) — the Bulletin is durable, but this coordinator's
//   `registry`, `leads`, `pending`, and `cursors` are in-memory. A restarted
//   coordinator with an empty registry would reject its own prior promoted posts
//   as `unknown-author` and re-read the whole board. Rehydration (replay the
//   bulletin history + persisted run-state registry into these maps, seed the
//   cursors past what was handled) is a SCOPED FOLLOW-UP, not done here. Spec §7
//   describes the durable substrate; this file does not yet consume it on boot.
//
//   F8 (post authenticity) — trust rests on `ev.agent` (the pi-bulletin
//   PI_BULLETIN_AGENT), an UNAUTHENTICATED env value over plain files. The real
//   extension does not cryptographically bind a post to an agent, so the
//   author-spoof check here defends against a buggy/confused poster, not a
//   determined one with write access to another session's env. This does NOT
//   weaken the core claim: nothing reaches `proven` without the harness oracle,
//   regardless of who posted. Hardening identity is an extension-level concern.
//
//   F10 (bare-id collisions across lanes) — dedup is keyed `${lane}:${id}` so the
//   same bare `id` can exist once per lane (one `evidence:L1`, one `bulletin:L1`),
//   and dedup is per-lane so a Tier-2 poster who grabs `evidence:L1` first blocks
//   a LATER Tier-2 post reusing `L1` in the same lane regardless of author. Both
//   are acknowledged follow-ups: a globally-unique lead id (author-qualified, or
//   minted by the coordinator on ingest) would remove the cross-lane ambiguity
//   and the cross-author block. The display-layer id collision is also handled on
//   the console side. Neither affects the gate — promotion still requires the
//   oracle — and the trusted projection now returns deep copies, so a collision
//   cannot leak one lead's mutable state into another's view.
// ---------------------------------------------------------------------------

export class Coordinator {
  private readonly runId: string
  private readonly coordinatorId: string
  private readonly spawner: HunterSpawner
  private readonly oracle: Oracle
  private readonly now: () => number

  // The coordinator's own board session (Tier-1), used to read both lanes and to
  // post promoted leads into the trusted lane.
  private readonly session: BulletinClient

  // The fleet registry — the ONLY source of an author's trust tier. A post's
  // self-declared tier is checked against this, never trusted on its own. Keyed
  // by the agent id that becomes its PI_BULLETIN_AGENT (spec.id).
  private readonly registry = new Map<string, HunterAgent>()

  // Every lead we have processed, keyed by a TRUST-SCOPED key (lane + id), so an
  // untrusted (evidence-lane) poster cannot squat a lead id and block a later
  // trusted (bulletin-lane) lead with the same id. The map is also the source
  // for the report.
  private readonly leads = new Map<string, Lead>()

  // Leads marked `verifying` whose oracle round has not yet succeeded. Drained
  // (retried) at the head of every tick so a transient oracle/board failure does
  // not strand a lead forever.
  private readonly pending = new Map<string, PendingLead>()

  // Per-lane read cursor the coordinator OWNS, advanced only past events it has
  // handled this tick. We do not rely on the board's own per-agent watermark so
  // that a batch is processed deterministically and bounded by READ_LIMIT.
  private readonly cursors = new Map<BulletinLane, number>()

  private readonly rejects: RejectedPost[] = []

  constructor(opts: CoordinatorOptions) {
    this.runId = opts.runId
    this.coordinatorId = opts.coordinatorId
    this.spawner = opts.spawner
    this.oracle = opts.oracle
    this.now = opts.now
    this.session = opts.bulletin(opts.coordinatorId)
  }

  // THE OUTPUT BOUNDARY. Nothing the coordinator retains — a lead in `this.leads`
  // or `pending`, an agent in `this.registry`, a `RejectedPost` in `this.rejects`
  // — is EVER handed out by reference. Every public method that returns a lead /
  // agent / fleet / result routes its return value through here, so a consumer's
  // mutation (the console is one) can never write back into coordinator state and
  // thus can never smuggle a lead past the oracle. This is a CLASS invariant, not
  // a per-site patch: a new return site is only correct if it, too, goes through
  // `out()`. Deep clone (structuredClone) — a shallow copy would still share the
  // nested `transitions`/`reactions` arrays that the bypass mutates.
  private out<T>(x: T): T {
    return structuredClone(x)
  }

  // Plan: turn a run spec into shards. Pure delegation to `shardWork`, exposed on
  // the coordinator so the loop reads as plan → shard → spawn.
  plan(spec: RunSpec): Shard[] {
    return shardWork(spec)
  }

  // Bind the spawner to a detached, coordinator-selected identity and loadout.
  // Legacy specs and records normalize to confined with no optional tools.
  async spawnFleet(specs: HunterSpec[]): Promise<Fleet> {
    const ids = new Set(this.registry.keys())
    const requested = specs.map((input) => {
      const spec = this.out(input)
      if (typeof spec.id !== "string" || !spec.id.trim() || spec.id === this.coordinatorId || ids.has(spec.id)) {
        throw new Error("Hunter identity must be unique and distinct from the coordinator.")
      }
      ids.add(spec.id)
      const shard = normalizeLoadout(spec.shard.loadout, spec.shard.options)
      const selected = normalizeLoadout(
        spec.loadout === undefined ? shard.loadout : spec.loadout,
        spec.options === undefined ? shard.options : spec.options,
      )
      if ((spec.shard.loadout !== undefined && selected.loadout !== shard.loadout) ||
        (spec.shard.kind !== "free-form" && selected.loadout !== "confined")) {
        throw new Error("Hunter and shard loadout must match; module/toolkit shards stay confined.")
      }
      if (selected.loadout === "free-roam" && spec.tier !== 2) throw new Error("Free-roam hunters must have tier 2.")
      return { ...spec, ...selected, shard: { ...spec.shard, ...selected } }
    })
    const agents: HunterAgent[] = []
    for (const spec of requested) {
      // The spawner cannot rewrite the expected binding or retain a registry alias.
      const agent = this.out(await this.spawner.spawn(this.out(spec)))
      const selected = normalizeLoadout(agent.loadout, agent.options)
      if (agent.id !== spec.id || agent.tier !== spec.tier || selected.loadout !== spec.loadout ||
        selected.options.length !== spec.options.length || selected.options.some((option) => !spec.options.includes(option))) {
        throw new Error("Spawned hunter identity, tier, or loadout does not match its specification.")
      }
      const registered = { ...agent, loadout: spec.loadout, options: [...spec.options] }
      this.registry.set(spec.id, registered)
      agents.push(registered)
    }
    return this.out({
      runId: this.runId,
      coordinatorId: this.coordinatorId,
      agents,
    })
  }

  // One pass of the watch loop. Order matters:
  //   1. Retry any lead left `verifying` by a previous tick's throw.
  //   2. Drain NEW events on both lanes (evidence first so a Tier-2 submission is
  //      never mistaken for a trusted lead) and route each valid lead through the
  //      proof gate.
  // Per-event handling is fault-isolated: one oracle/post/resolve throw strands
  // that single lead (retried next tick) and never drops the rest of the batch,
  // and leads adjudicated earlier in the tick still appear in the result.
  async tick(): Promise<TickResult> {
    const result: TickResult = { proven: [], dismissed: [], stranded: [], rejected: [] }

    // (1) retry stranded leads from earlier ticks.
    for (const p of [...this.pending.values()]) {
      await this.finalize(p, result)
    }

    // (2) read and route new events. Evidence lane first.
    for (const lane of ["evidence", "bulletin"] as const) {
      const team = bulletinChannel(this.runId, lane)
      const from = this.cursors.get(lane) ?? 0
      const { events } = await this.session.bulletin_read(team, from, READ_LIMIT)
      for (const ev of events) {
        const ingested = this.ingest(ev, lane)
        if (ingested.kind === "reject") result.rejected.push(ingested.rejected)
        else if (ingested.kind === "verify") await this.finalize(ingested.pending, result)
        // advance our cursor past every handled event, whatever its outcome —
        // a stranded lead is retried via `pending`, not by re-reading.
        this.cursors.set(lane, ev.seq)
      }
    }
    // Single output boundary: the result's proven/dismissed/stranded entries are
    // live objects still held in `this.leads`/`pending`, and `rejected` aliases
    // `this.rejects`. Deep-clone the whole result so NONE of them can be mutated
    // back into coordinator state (a `{status:"proven"}` pushed onto a returned
    // `stranded` lead must not promote on the next tick).
    return this.out(result)
  }

  // Validate one event and, if it is a trustworthy lead, mark it `verifying` and
  // register it for the proof round. PURE and synchronous — it never calls the
  // oracle or the board, so it cannot throw mid-flight. Validation order is the
  // security order: identity before dedup, so an untrusted poster can neither
  // squat an id nor block a trusted lead.
  private ingest(
    ev: BulletinEvent,
    lane: BulletinLane,
  ):
    | { kind: "reject"; rejected: RejectedPost }
    | { kind: "skip" }
    | { kind: "verify"; pending: PendingLead } {
    // Our own promotions/digests echo back on the trusted lane — never re-ingest
    // them as hunter submissions.
    if (ev.agent === this.coordinatorId) return { kind: "skip" }

    // Non-finding kinds (signal/message) are coordination chatter, not leads.
    // Audited, not silently skipped.
    if (ev.kind !== "finding") {
      return { kind: "reject", rejected: this.reject(ev, lane, "non-finding", [`kind "${ev.kind}" is not a lead`]) }
    }

    const lead = fromBulletinClaim(ev.claim)
    if (!lead) {
      return { kind: "reject", rejected: this.reject(ev, lane, "unparseable", ["claim is not a Lead payload"]) }
    }

    // Resolve the author's tier from the registry — the only trusted source.
    const author = ev.agent ? this.registry.get(ev.agent) : undefined
    if (!author) {
      return { kind: "reject", rejected: this.reject(ev, lane, "unknown-author", [
        `author "${ev.agent ?? "<none>"}" is not in the fleet registry`,
      ]) }
    }
    const authorTier = author.tier

    // Identity: the payload's self-declared `author` must match the posting
    // agent (its PI_BULLETIN_AGENT). Otherwise a hunter is claiming another
    // agent's id — e.g. a Tier-2 stamping a Tier-1 id into `author`.
    if (lead.author !== ev.agent) {
      return { kind: "reject", rejected: this.reject(ev, lane, "author-spoof", [
        `lead.author "${lead.author}" != posting agent "${ev.agent}"`,
      ]) }
    }

    // Trust/lane guards. A Tier-2 author on the trusted bulletin channel is a
    // spoofed control message. Otherwise the lead's own `lane` field must match
    // the channel it actually arrived on (a Tier-2 payload claiming `bulletin`
    // but posted to `evidence`, or vice-versa, is rejected).
    if (lane === "bulletin" && authorTier === 2) {
      return { kind: "reject", rejected: this.reject(ev, lane, "tier-spoof", [
        "Tier-2 author posted into the trusted bulletin lane",
      ]) }
    }
    if (lead.lane !== lane) {
      return { kind: "reject", rejected: this.reject(ev, lane, "lane-mismatch", [
        `lead.lane "${lead.lane}" != arrival lane "${lane}"`,
      ]) }
    }

    // The policy gate — quarantine + no self-adjudication. Validated against the
    // REGISTRY tier, never the lead's self-declared one.
    const check = validateLeadPost(lead, authorTier)
    if (!check.ok) {
      return { kind: "reject", rejected: this.reject(ev, lane, "policy", check.errors) }
    }

    // Dedup — AFTER identity + tier + policy, and scoped by trust lane so a
    // Tier-2 squatting an id in `evidence` cannot block a Tier-1 lead with the
    // same id in `bulletin`. Every drop is recorded, never silent.
    const key = `${lane}:${lead.id}`
    if (this.leads.has(key)) {
      return { kind: "reject", rejected: this.reject(ev, lane, "duplicate", [
        `lead id "${lead.id}" already processed in lane "${lane}"`,
      ]) }
    }

    // SANITIZE inbound history + social fields. A poster-supplied
    // `transitions`/`evidenceRef` is untrusted — a hunter could inject a fake
    // `proven`/`by:null` transition that the console (which renders recorded
    // transitions) would show as a harness proof. Likewise `reactions`/`replyTo`
    // are a social endorsement surface: a Tier-2 post carrying
    // `reactions:[{emoji:"✅",by:["a1","coord"]}]` or a `replyTo` would DISPLAY a
    // forged Tier-1/coordinator approval even though it can never promote. We
    // rebuild from scratch: a single baseline transition stamped from TRUSTED
    // board metadata (the post's own seq time and verified author), then only the
    // coordinator's and oracle's own recorded actions, and drop all poster-set
    // endorsement fields. Reactions can only ever be added later by the
    // coordinator/oracle round, never carried in on a submission.
    const posted = leadStatus(lead)
    const baseline: LeadTransition = { status: posted, at: ev.at, by: ev.agent }
    const clean: Lead = {
      ...lead,
      evidenceRef: null, // never trust a poster's evidence handle
      status: posted,
      transitions: [baseline],
      reactions: [], // drop forged endorsements
      replyTo: null, // drop a forged thread link
    }

    // Record verifying bookkeeping (the coordinator's own action) and register
    // for the proof round.
    const verifying = markVerifying(clean, this.coordinatorId, this.now())
    this.leads.set(key, verifying)
    const pending: PendingLead = { key, lead: verifying, lane, seq: ev.seq }
    this.pending.set(key, pending)
    return { kind: "verify", pending }
  }

  // The proof round for one registered lead: ask the oracle, gate the verdict,
  // apply it, then promote/dismiss on the board. May throw (the oracle and the
  // board are I/O); a throw leaves the lead in `pending` for the next tick and
  // surfaces it in `result.stranded` — it is NEVER dropped and NEVER stuck
  // silently. On success the lead leaves `pending` and lands in proven/dismissed.
  private async finalize(p: PendingLead, result: TickResult): Promise<void> {
    try {
      const raw = (await this.oracle.verify(p.lead)) as unknown
      // Shape-guard the verdict BEFORE the gate. A malformed/hostile verdict
      // (e.g. `{proven:"false"}`, a missing field, `proven:true` with no
      // evidence) can NEVER promote — it becomes an authoritative dismissal.
      const verdict: OracleVerdict = isOracleVerdict(raw)
        ? raw
        : { proven: false, evidenceRef: null, at: this.now(), reason: "malformed oracle verdict" }

      const adjudicated = applyOracleVerdict(p.lead, verdict)
      this.leads.set(p.key, adjudicated)

      const team = bulletinChannel(this.runId, p.lane)
      if (leadStatus(adjudicated) === "proven") {
        // Post the promoted lead into the trusted bulletin lane, then resolve the
        // ORIGINAL post on its own lane under a PER-LEAD ref (the lead id, not the
        // shared module name) so one lead's dismissal cannot overwrite another's
        // promotion. `supersedes` names the original post the proof replaces.
        await this.session.bulletin_post(
          toBulletinPost(bulletinChannel(this.runId, "bulletin"), adjudicated),
        )
        await this.session.bulletin_resolve(team, p.lead.id, "promoted", verdict.evidenceRef, [p.seq])
      } else {
        await this.session.bulletin_resolve(team, p.lead.id, "dismissed", null)
      }

      // Success → leave the retry queue.
      this.pending.delete(p.key)
      const status = leadStatus(adjudicated)
      if (status === "proven") result.proven.push(adjudicated)
      else if (status === "dismissed") result.dismissed.push(adjudicated)
    } catch {
      // Throw during the proof round → keep it pending (retried next tick) and
      // surface it. The lead stays `verifying` in `this.leads`.
      result.stranded.push(p.lead)
    }
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

  // The TRUSTED projection the live console should consume. Returns only leads
  // that cleared ingest + the policy gate and were recorded in run-state — the
  // sanitized, trust-scoped versions in `this.leads`, each either `verifying`
  // (mid-flight) or carrying an `applyOracleVerdict` outcome (`proven`/
  // `dismissed`). It NEVER contains a rejected board entry (tier-spoof,
  // author-spoof, duplicate, …) nor the pre-promotion evidence-lane copy of a
  // now-proven lead: promotion overwrites the same trust-scoped key in place, so
  // the forged/raw board records never surface here.
  //
  // This exists so the UI seam does NOT have to re-read the raw pi-bulletin board
  // (bulletin_read → fromBulletinClaim), which still holds rejected posts and the
  // quarantined evidence copy — reading that would let a forged entry reach the
  // Trusted region. Consume THIS instead.
  //
  // Returns DEEP COPIES, never the live lead objects. The leads held in
  // `this.leads` are not frozen, and the console is a mutating consumer: handed a
  // reference, it could `projection[0].transitions.push({status:"proven",...})`,
  // and the next tick's `applyOracleVerdict` would see an already-terminal lead,
  // return it unchanged, and promote it (proven=1 + a trusted-lane post) with the
  // oracle never saying yes — a proof-gate bypass. A `projection[0].claim = …`
  // would likewise rewrite coordinator state. So this is a read-only snapshot
  // that CANNOT write back into `this.leads` or `pending`.
  adjudicatedLeads(): Lead[] {
    return this.out([...this.leads.values()])
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
    // Single output boundary (same invariant as adjudicatedLeads/tick): the whole
    // report is deep-cloned, so none of these live leads/rejects can be mutated
    // back into `this.leads`/`pending`/`this.rejects`.
    return this.out({
      runId: this.runId,
      agents: summary.agents,
      active: summary.active,
      proven,
      dismissed,
      stranded: [...this.pending.values()].map((p) => p.lead),
      rejected: [...this.rejects],
    })
  }
}
