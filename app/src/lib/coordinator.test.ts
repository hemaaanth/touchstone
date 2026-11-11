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
  async verify(l: Lead): Promise<OracleVerdict> {
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
