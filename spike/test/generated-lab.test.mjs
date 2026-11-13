// Generated labs: a pack may export `lab: { title, blurb, make }`. make() builds a
// fresh directory for each run. A fake pack stands in, so no keys or git are made.
import "./helpers/isolated-env.mjs";
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PACKS } from "../packs/index.mjs"
import { listTargets, pickTarget, getTarget, prepareRunWorkspace, prepareWorkspace } from "../lib/targets.mjs"
import { readTouchstone, cleanupWorkspace } from "../lib/sandbox.mjs"
import { DEFAULT_RUN_BUDGET_USD } from "../lib/run-budget.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const inside = (dir) => path.resolve(dir) === ROOT || path.resolve(dir).startsWith(ROOT + path.sep)

let made = []
function fakePack(make) {
  PACKS.genfake = { id: "genfake", title: "Gen fake", tier: "P", proof: "evidence", lab: { title: "Generated lab", blurb: "Made per run.", make } }
}
const tmpMake = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "genlab-test-"))
  writeFileSync(path.join(dir, ".touchstone.json"), JSON.stringify({ pack: "genfake", kind: "lab" }))
  made.push(dir)
  return dir
}
const done = () => {
  delete PACKS.genfake
  for (const d of made) rmSync(d, { recursive: true, force: true })
  made = []
}

test("a pack with a generated lab lists one runnable target <pack>/lab", () => {
  fakePack(tmpMake)
  try {
    const t = listTargets().filter((x) => x.pack === "genfake")
    assert.equal(t.length, 1)
    assert.equal(t[0].id, "genfake/lab")
    assert.equal(t[0].kind, "lab")
    assert.equal(t[0].runnable, true)
    assert.equal(t[0].title, "Generated lab")
    assert.equal(t[0].proofSurface.kind, "evidence")
    // The summary never carries a path or the generator.
    assert.ok(!("dir" in t[0]) && !("make" in t[0]))
  } finally { done() }
})

test("a generated lab is picked by pack, by id, and not for another pack", () => {
  fakePack(tmpMake)
  try {
    assert.equal(pickTarget({ pack: "genfake" }).id, "genfake/lab")
    assert.equal(pickTarget({ id: "genfake/lab", pack: "genfake" }).id, "genfake/lab")
    assert.throws(() => pickTarget({ id: "genfake/lab", pack: "contracts" }), /belongs to pack "genfake"/)
    assert.equal(getTarget("genfake/lab").generated, true)
  } finally { done() }
})

test("make() runs once per run: two runs get different dirs, none under the repo", async () => {
  let calls = 0
  fakePack(() => { calls++; return tmpMake() })
  try {
    const target = pickTarget({ pack: "genfake" })
    assert.equal(calls, 0)
    const a = await prepareRunWorkspace(target, { modules: [] })
    assert.equal(calls, 1)
    const b = await prepareRunWorkspace(target, { modules: [] })
    assert.equal(calls, 2)
    assert.notEqual(a, b)
    for (const ws of [a, b]) {
      assert.ok(!inside(ws), `${ws} is under the repo`)
      assert.ok(ws.startsWith(path.resolve(tmpdir())))
    }
    // The run's modules ride in the config, and the lab's own config is kept.
    const cfg = readTouchstone(a)
    assert.equal(cfg.pack, "genfake")
    assert.equal(cfg.kind, "lab")
    assert.ok(Array.isArray(cfg.modules))
    // The run's own cleanup removes the generated dir.
    cleanupWorkspace(a)
    assert.ok(!existsSync(a))
    assert.ok(existsSync(b))
  } finally { done() }
})

test("a lab made inside the repo is refused and removed", async () => {
  const bad = path.join(ROOT, "spike", "results", `_genlab-test-${process.pid}`)
  fakePack(async () => {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(bad, { recursive: true })
    return bad
  })
  try {
    await assert.rejects(prepareRunWorkspace(pickTarget({ pack: "genfake" }), { modules: [] }), /inside the repository/)
    assert.ok(!existsSync(bad))
  } finally { rmSync(bad, { recursive: true, force: true }); done() }
})

test("prepareWorkspace alone refuses a generated target; folder labs are unchanged", async () => {
  fakePack(tmpMake)
  try {
    assert.throws(() => prepareWorkspace(pickTarget({ pack: "genfake" }), { modules: [] }), /generated per run/)
    const ws = await prepareRunWorkspace(pickTarget({ id: "vault-reentrancy" }), { modules: [] })
    assert.equal(readTouchstone(ws).pack, "contracts")
    cleanupWorkspace(ws)
  } finally { done() }
})

test("Supply chain lists its generated lab with one manifest line", () => {
  const t = listTargets().filter((x) => x.pack === "supply-chain")
  assert.deepEqual(t.map((x) => x.id), ["supply-chain/lab"])
  assert.equal(t[0].runnable, true)
  assert.equal(typeof PACKS["supply-chain"].lab.make, "function")
})

test("the default run budget is $5", () => {
  assert.equal(DEFAULT_RUN_BUDGET_USD, 5)
})

test("a pack lab without a title in its config is named by its pack, not its folder", () => {
  const labs = listTargets().filter((t) => t.kind === "lab" && t.pack !== "contracts" && !getTarget(t.id).generated)
  assert.ok(labs.length > 0)
  for (const t of labs) {
    const folder = t.id.split("/").pop()
    const cfg = readTouchstone(path.resolve(ROOT, getTarget(t.id).dir))
    assert.equal(t.title, cfg.title ?? `${PACKS[t.pack].title ?? t.pack} lab`)
    if (!cfg.title) assert.notEqual(t.title, folder)
  }
})
