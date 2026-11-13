// Coordinator loop tests — the orchestration contract encoded as assertions.
//
// Same compiled-ESM pattern as fleet-policy.test.ts: the app has no test runner
// wired yet, so these are run by compiling the lib to ESM (tsc), renaming
// .js→.mjs, rewriting the relative imports to .mjs, and running with
// `node --test`. The exact command + output is recorded in the track's
// validation note.
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Lead, HunterAgent, Tier } from "./fleet"
import { bulletinChannel, leadStatus } from "./fleet"
import type { OracleVerdict } from "./fleet-policy"
import { toBulletinPost } from "./fleet-policy"
import {
  Coordinator,
  InMemoryBulletin,
  shardWork,
  type HunterSpec,
  type HunterSpawner,
  type Oracle,
} from "./coordinator"

const RUN = "r1"
const COORD = "coord-0"

// A Tier-2 evidence lead, as a hunter would post it.
const lead = (over: Partial<Lead> = {}): Lead => ({
  id: "L1",
  lane: "evidence",
  author: "h7",
  tier: 2,
  module: "web",
  toolkit: ["x"],
  claim: "reentrancy in withdraw",
  mechanism: "external call before state update",
  evidenceRef: null,
  severity: "high",
  status: "proposed",
  transitions: [],
  replyTo: null,
  reactions: [],
  ...over,
})

const agent = (over: Partial<HunterAgent> = {}): HunterAgent => ({
  id: "h7",
  name: "Hunter 7",
  model: "near-abliterated-70b",
  tier: 2,
  status: "working",
  task: null,
  module: "web",
  toolkit: ["x"],
  spend: { usd: null, tokensIn: null, tokensOut: null },
  ...over,
})

// A spawner that just echoes the spec as a registry record.
const echoSpawner: HunterSpawner = {
  async spawn(spec: HunterSpec): Promise<HunterAgent> {
    return agent({
      id: spec.id,
      name: spec.name,
      model: spec.model,
      tier: spec.tier,
      module: spec.shard.module,
      toolkit: spec.shard.toolkit,
      status: "working",
    })
  },
}

// Oracles with fixed verdicts.
const provingOracle = (evidenceRef = "replay:0xabc"): Oracle => ({
  async verify(): Promise<OracleVerdict> {
    return { proven: true, evidenceRef, at: 1000, reason: null }
  },
})
const rejectingOracle: Oracle = {
  async verify(): Promise<OracleVerdict> {
    return { proven: false, evidenceRef: null, at: 1000, reason: "no harm reproduced" }
  },
}

// Build a coordinator over one shared in-memory board.
function harness(oracle: Oracle) {
  const board = new InMemoryBulletin()
  const coord = new Coordinator({
    runId: RUN,
    coordinatorId: COORD,
    bulletin: (a) => board.session(a),
    spawner: echoSpawner,
    oracle,
    now: () => 500,
  })
  return { board, coord }
}

// Post a lead to a lane AS a given agent (sets its PI_BULLETIN_AGENT identity).
function postAs(board: InMemoryBulletin, as: string, l: Lead) {
  const team = bulletinChannel(RUN, l.lane)
  return board.session(as).bulletin_post(toBulletinPost(team, l))
}

// --- sharding ---
test("shardWork produces module / toolkit / free-form shards", () => {
  const shards = shardWork({
    modules: ["web", "contracts"],
    toolkits: [["slither", "echidna"]],
    freeForm: 2,
    baseToolkit: ["grep"],
  })
  assert.equal(shards.length, 5)
  assert.deepEqual(shards[0], { kind: "module", module: "web", toolkit: ["grep"] })
  assert.deepEqual(shards[2], { kind: "toolkit", module: null, toolkit: ["slither", "echidna"] })
  assert.equal(shards[3].kind, "free-form")
  assert.equal(shards[3].module, null)
})

// --- spawn + registry ---
test("spawnFleet registers agents and reports a fleet summary", async () => {
  const { coord } = harness(provingOracle())
  const shards = shardWork({ modules: ["web"], freeForm: 1, baseToolkit: ["grep"] })
  const specs: HunterSpec[] = shards.map((shard, i) => ({
    id: `h${i}`,
    name: `Hunter ${i}`,
    model: "near-abliterated-70b",
    tier: 2 as Tier,
    shard,
  }))
  const fleet = await coord.spawnFleet(specs)
  assert.equal(fleet.agents.length, 2)
  const report = coord.report(fleet)
  assert.equal(report.agents, 2)
  assert.equal(report.active, 2)
})

// --- the proof gate: oracle is the ONLY promoter ---
test("a proven Tier-2 evidence lead graduates to proven on the trusted lane", async () => {
  const { board, coord } = harness(provingOracle("replay:0xabc"))
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const res = await coord.tick()
  assert.equal(res.proven.length, 1)
  assert.equal(res.dismissed.length, 0)
  const promoted = res.proven[0]
  assert.equal(leadStatus(promoted), "proven")
  assert.equal(promoted.lane, "bulletin") // graduated out of quarantine
  assert.equal(promoted.evidenceRef, "replay:0xabc")
  // and it was posted into the trusted bulletin lane
  const trusted = await board.session("observer").bulletin_read(bulletinChannel(RUN, "bulletin"))
  assert.equal(trusted.events.length, 1)
})

test("a rejected Tier-2 lead is dismissed and stays quarantined", async () => {
  const { board, coord } = harness(rejectingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.dismissed.length, 1)
  assert.equal(leadStatus(res.dismissed[0]), "dismissed")
  assert.equal(res.dismissed[0].lane, "evidence") // unproven stays quarantined
  // nothing posted to the trusted lane
  const trusted = await board.session("observer").bulletin_read(bulletinChannel(RUN, "bulletin"))
  assert.equal(trusted.events.length, 0)
})

// --- the core claim: corroboration / reactions never promote ---
test("reactions on a lead do not promote it; only the oracle does", async () => {
  const { board, coord } = harness(rejectingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // a lead loaded with social signal — reactions and corroborated status fields
  await postAs(board, "h7", lead({ reactions: [{ emoji: "🔥", by: ["h1", "h2"] }] }))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0) // the oracle rejected it; signal is irrelevant
  assert.equal(res.dismissed.length, 1) // it WAS routed and dismissed, not ignored
})

// a poster-injected fake `proven` transition must not survive ingest
test("inbound transitions / evidenceRef are sanitized, not trusted", async () => {
  const { board, coord } = harness(rejectingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // hunter injects a fake harness proof into the history + a bogus evidence handle
  await postAs(
    board,
    "h7",
    lead({
      evidenceRef: "forged:0xdead",
      transitions: [
        { status: "proven", at: 1, by: null }, // fake harness proof...
        { status: "proposed", at: 2, by: "h7" }, // ...hidden behind a current proposed
      ],
    }),
  )
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.dismissed.length, 1)
  const dismissed = res.dismissed[0]
  // no `proven` transition and no forged evidence ref survived
  assert.ok(!dismissed.transitions.some((t) => t.status === "proven"))
  assert.ok(dismissed.transitions.every((t) => (t.status === "dismissed" ? t.by === null : true)))
  assert.notEqual(dismissed.evidenceRef, "forged:0xdead")
})

// a truthy-but-non-true verdict (from a malformed/hostile oracle) never promotes
test("a malformed oracle verdict is dismissed, never proven", async () => {
  const hostileOracle: Oracle = {
    // deliberately the wrong shape — proven is a string, not a boolean
    async verify(): Promise<OracleVerdict> {
      return { proven: "false", evidenceRef: null, at: 1, reason: null } as unknown as OracleVerdict
    },
  }
  const { board, coord } = harness(hostileOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.dismissed.length, 1)
})

// --- quarantine enforcement ---
test("a Tier-2 author posting into the trusted bulletin lane is rejected as a spoof", async () => {
  const { board, coord } = harness(provingOracle())
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // post directly to the trusted lane, bypassing validateLeadPost at post time
  const team = bulletinChannel(RUN, "bulletin")
  await board.session("h7").bulletin_post(toBulletinPost(team, lead({ lane: "bulletin" })))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "tier-spoof")
})

test("a post from an unknown author is rejected", async () => {
  const { board, coord } = harness(provingOracle())
  // no spawnFleet → empty registry
  await postAs(board, "ghost", lead())
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "unknown-author")
})

test("a lead that fails the policy gate is rejected, not verified", async () => {
  const { board, coord } = harness(provingOracle())
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // empty claim → validateLeadPost fails
  await postAs(board, "h7", lead({ claim: "   " }))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "policy")
})

// --- a Tier-1 lead is also routed through the oracle, never auto-proven ---
test("a Tier-1 trusted lead still only reaches proven via the oracle", async () => {
  const { board, coord } = harness(rejectingOracle)
  await coord.spawnFleet([
    { id: "a1", name: "Analyst 1", model: "m", tier: 1, shard: { kind: "module", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "a1", lead({ id: "L9", author: "a1", tier: 1, lane: "bulletin" }))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.dismissed.length, 1) // routed and rejected, not promoted on trust
})

// --- author spoofing: lead.author must match the posting agent ---
test("a lead whose author != the posting agent is rejected as a spoof", async () => {
  const { board, coord } = harness(provingOracle())
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
    { id: "a1", name: "Analyst 1", model: "m", tier: 1, shard: { kind: "module", module: "web", toolkit: ["x"] } },
  ])
  // h7 (Tier-2) posts but stamps a1 (a Tier-1 id) into lead.author
  await postAs(board, "h7", lead({ author: "a1" }))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "author-spoof")
})

// --- lane spoofing: the lead's own lane field must match the arrival channel ---
test("a Tier-2 payload claiming lane:bulletin on the evidence channel is rejected", async () => {
  const { board, coord } = harness(provingOracle())
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // post lands on the evidence channel (laneForTier(2)) but its payload claims bulletin
  const evidenceTeam = bulletinChannel(RUN, "evidence")
  await board.session("h7").bulletin_post(toBulletinPost(evidenceTeam, lead({ lane: "bulletin" })))
  const res = await coord.tick()
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "lane-mismatch")
})

// --- fault isolation: a throw strands one lead, keeps the batch, retries next tick ---
test("an oracle throw strands one lead without dropping the rest, and retries", async () => {
  let failFirst = true
  const flakyOracle: Oracle = {
    async verify(l: Lead): Promise<OracleVerdict> {
      if (l.id === "BAD" && failFirst) {
        failFirst = false
        throw new Error("oracle unavailable")
      }
      return { proven: true, evidenceRef: "replay:ok", at: 1, reason: null }
    },
  }
  const { board, coord } = harness(flakyOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead({ id: "BAD" }))
  await postAs(board, "h7", lead({ id: "GOOD" }))
  const t1 = await coord.tick()
  // GOOD still got proven even though BAD threw first in the batch
  assert.equal(t1.proven.length, 1)
  assert.equal(t1.proven[0].id, "GOOD")
  assert.equal(t1.stranded.length, 1)
  assert.equal(t1.stranded[0].id, "BAD")
  // next tick retries the stranded lead (oracle now succeeds) with no re-post
  const t2 = await coord.tick()
  assert.equal(t2.proven.length, 1)
  assert.equal(t2.proven[0].id, "BAD")
  assert.equal(t2.stranded.length, 0)
})

// --- watermark: a lead handled in tick 1 is not re-processed in tick 2 ---
test("the owned cursor does not re-process events across ticks", async () => {
  let calls = 0
  const countingOracle: Oracle = {
    async verify(): Promise<OracleVerdict> {
      calls++
      return { proven: false, evidenceRef: null, at: 1, reason: null }
    },
  }
  const { board, coord } = harness(countingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const t1 = await coord.tick()
  assert.equal(t1.dismissed.length, 1)
  assert.equal(calls, 1)
  const t2 = await coord.tick() // no new posts
  assert.equal(t2.dismissed.length, 0)
  assert.equal(calls, 1) // the tick-1 event was not re-read
})

// --- idempotency: a re-posted terminal lead is not re-verified ---
test("a re-posted already-terminal lead is ignored on the next tick", async () => {
  let calls = 0
  const countingOracle: Oracle = {
    async verify(): Promise<OracleVerdict> {
      calls++
      return { proven: true, evidenceRef: "r", at: 1, reason: null }
    },
  }
  const { board, coord } = harness(countingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  await coord.tick()
  assert.equal(calls, 1)
  await postAs(board, "h7", lead()) // same lead id again
  await coord.tick()
  assert.equal(calls, 1) // not re-verified
})

// --- the safe UI seam ---
test("adjudicatedLeads is the trusted projection: no forged board entry, no raw evidence copy", async () => {
  const { board, coord } = harness(provingOracle("replay:0xabc"))
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // a forged tier-spoof post into the trusted lane (rejected by ingest)...
  await board
    .session("h7")
    .bulletin_post(toBulletinPost(bulletinChannel(RUN, "bulletin"), lead({ id: "FORGED", lane: "bulletin" })))
  // ...and a legitimate evidence lead that the oracle proves.
  await postAs(board, "h7", lead({ id: "L2" }))
  const res = await coord.tick()
  assert.equal(res.proven.length, 1)
  assert.equal(res.rejected.length, 1)

  const projection = coord.adjudicatedLeads()
  // only the accepted + adjudicated lead; the forged post never enters.
  assert.equal(projection.length, 1)
  assert.equal(projection[0].id, "L2")
  assert.equal(leadStatus(projection[0]), "proven")
  assert.equal(projection[0].lane, "bulletin") // the promoted copy, in place
  assert.ok(!projection.some((l) => l.id === "FORGED"))

  // DEEP snapshot: mutating the returned copy cannot write back into coordinator
  // state. Tamper with the projection, then read a fresh one and confirm it is
  // pristine.
  projection[0].claim = "tampered"
  projection[0].transitions.push({ status: "proven", at: 9, by: null })
  const fresh = coord.adjudicatedLeads()
  assert.equal(fresh[0].claim, "reentrancy in withdraw")
  assert.equal(fresh[0].transitions.filter((t) => t.status === "proven" && t.at === 9).length, 0)

  // the UNSAFE raw-board path still carries both the forged entry and the
  // quarantined evidence copy — exactly what this accessor exists to bypass.
  const rawTrusted = await board.session("audit-a").bulletin_read(bulletinChannel(RUN, "bulletin"))
  const rawEvidence = await board.session("audit-b").bulletin_read(bulletinChannel(RUN, "evidence"))
  assert.ok(rawTrusted.events.some((e) => e.claim.includes("FORGED")))
  assert.ok(rawEvidence.events.some((e) => e.claim.includes("L2")))
})

// THE proof-gate regression (cycle-3 HIGH): a consumer mutating the projection
// must NOT be able to forge a promotion. Before the deep-copy fix, the accessor
// handed out the live lead; pushing a `proven` transition onto it made the next
// tick's applyOracleVerdict treat it as already-terminal and promote it with the
// oracle never saying yes.
test("mutating the projection cannot forge a promotion past the oracle", async () => {
  // throws on the first proof attempt (strands the lead in `pending`), then NO.
  let attempts = 0
  const flaky: Oracle = {
    async verify(): Promise<OracleVerdict> {
      attempts++
      if (attempts === 1) throw new Error("transient oracle fault")
      return { proven: false, evidenceRef: null, at: 1, reason: "no harm reproduced" }
    },
  }
  const { board, coord } = harness(flaky)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const t1 = await coord.tick()
  assert.equal(t1.stranded.length, 1) // thrown → still verifying in `pending`

  // a hostile/buggy console mutates the returned copy to forge a harness proof.
  const projection = coord.adjudicatedLeads()
  projection[0].transitions.push({ status: "proven", at: 2, by: null })
  projection[0].claim = "pwned"

  const t2 = await coord.tick() // oracle now returns its real verdict: NO
  assert.equal(t2.proven.length, 0) // the mutation did NOT promote it
  assert.equal(t2.dismissed.length, 1) // the real verdict stands
  assert.equal(leadStatus(t2.dismissed[0]), "dismissed")

  // coordinator state is untouched by the consumer's edit...
  const after = coord.adjudicatedLeads()
  assert.equal(after[0].claim, "reentrancy in withdraw") // not "pwned"
  assert.ok(!after[0].transitions.some((t) => t.status === "proven"))
  // ...and nothing was posted to the trusted lane.
  const trusted = await board.session("obs").bulletin_read(bulletinChannel(RUN, "bulletin"))
  assert.equal(trusted.events.length, 0)
})

// The SAME bypass, reached through tick().stranded instead of adjudicatedLeads().
test("mutating tick().stranded cannot forge a promotion past the oracle", async () => {
  let attempts = 0
  const flaky: Oracle = {
    async verify(): Promise<OracleVerdict> {
      attempts++
      if (attempts === 1) throw new Error("transient oracle fault")
      return { proven: false, evidenceRef: null, at: 1, reason: "no harm reproduced" }
    },
  }
  const { board, coord } = harness(flaky)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const t1 = await coord.tick()
  assert.equal(t1.stranded.length, 1)
  // forge a harness proof onto the returned stranded lead.
  t1.stranded[0].transitions.push({ status: "proven", at: 2, by: null })
  const t2 = await coord.tick() // oracle now says NO
  assert.equal(t2.proven.length, 0) // not promoted
  assert.equal(t2.dismissed.length, 1)
  const trusted = await board.session("obs").bulletin_read(bulletinChannel(RUN, "bulletin"))
  assert.equal(trusted.events.length, 0)
})

// Mutating tick().dismissed must not leak a false `proven` into the projection
// the console reads.
test("mutating tick().dismissed does not leak a false proven into the projection", async () => {
  const { board, coord } = harness(rejectingOracle)
  await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  await postAs(board, "h7", lead())
  const t = await coord.tick()
  assert.equal(t.dismissed.length, 1)
  // attacker rewrites the dismissed lead to look proven + graduated.
  t.dismissed[0].status = "proven"
  t.dismissed[0].lane = "bulletin"
  t.dismissed[0].transitions.push({ status: "proven", at: 3, by: null })
  const proj = coord.adjudicatedLeads()
  assert.equal(proj.length, 1)
  assert.equal(leadStatus(proj[0]), "dismissed") // still the oracle's real verdict
  assert.equal(proj[0].lane, "evidence") // still quarantined
})

// The trust root: mutating spawnFleet().agents must not rewrite the registry tier
// that the tier-spoof check depends on.
test("mutating spawnFleet().agents tier does not defeat the tier-spoof check", async () => {
  const { board, coord } = harness(provingOracle())
  const fleet = await coord.spawnFleet([
    { id: "h7", name: "Hunter 7", model: "m", tier: 2, shard: { kind: "free-form", module: "web", toolkit: ["x"] } },
  ])
  // attacker flips the returned agent to Tier-1 to shed quarantine...
  fleet.agents[0].tier = 1
  // ...then posts a Tier-1-looking lead straight into the trusted lane.
  await board
    .session("h7")
    .bulletin_post(toBulletinPost(bulletinChannel(RUN, "bulletin"), lead({ tier: 1, lane: "bulletin" })))
  const res = await coord.tick()
  // registry tier is unchanged (still Tier-2), so it is still a spoof.
  assert.equal(res.proven.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, "tier-spoof")
})

// --- restart (F9 in coordinator.ts) ---
// A Coordinator keeps its registry, leads, pending and cursors in memory. No
// running code holds one: the live fleet is spike/lib/fleet.mjs, and
// app/server/runs.mjs restores a fleet run from the run's own files. This test
// records what a NEW Coordinator over the SAME durable board has lost, and the
// rule that holds across the restart: the board alone proves nothing.
test("a coordinator that starts again over the same board has lost its state, and proves nothing without the oracle", async () => {
  const board = new InMemoryBulletin()
  let asked = 0
  const oracle: Oracle = {
    async verify(): Promise<OracleVerdict> {
      asked++
      return { proven: true, evidenceRef: "replay:0xabc", at: 1000, reason: null }
    },
  }
  const start = () =>
    new Coordinator({ runId: RUN, coordinatorId: COORD, bulletin: (a) => board.session(a), spawner: echoSpawner, oracle, now: () => 500 })
  const spec: HunterSpec = { id: "h7", name: "Hunter 7", model: "near-abliterated-70b", tier: 2, shard: { kind: "module", module: "web", toolkit: ["x"] } }

  const first = start()
  const fleet = await first.spawnFleet([spec])
  await postAs(board, "h7", lead())
  assert.equal((await first.tick()).proven.length, 1)
  assert.equal(asked, 1)

  // The restart. The board still holds the hunter's post and the coordinator's
  // own promoted copy of it, which says `proven`.
  const second = start()
  // Lost: the registry (the fleet's agents and tiers), every lead and verdict.
  assert.deepEqual(second.adjudicatedLeads(), [])
  assert.deepEqual(second.report(fleet).proven, [])
  // Lost: the read cursors, so it reads the whole board again. With no registry
  // it trusts no post. The proven copy on the board does not make a proven lead.
  const again = await second.tick()
  assert.equal(again.proven.length, 0)
  assert.deepEqual(again.rejected.map((r) => r.reason), ["unknown-author"])
  assert.deepEqual(second.adjudicatedLeads(), [])
  assert.equal(asked, 1)

  // With the registry back, the lead is proven again only by a new replay.
  const third = start()
  await third.spawnFleet([spec])
  const replayed = await third.tick()
  assert.equal(replayed.proven.length, 1)
  assert.equal(replayed.proven[0].evidenceRef, "replay:0xabc")
  assert.equal(asked, 2)
})
