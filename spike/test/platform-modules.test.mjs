// Module choice: the pack list, target filtering by pack, and the pack written
// into each run's .touchstone.json. A fake pack with a fake lab stands in for a
// pack that another thread ships; it is added and removed inside the test.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PACKS, packList } from "../packs/index.mjs"
import { listTargets, pickTarget, prepareWorkspace, getTarget } from "../lib/targets.mjs"
import { planModules } from "../lib/modules.mjs"
import { readTouchstone } from "../lib/sandbox.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const LAB = path.join(ROOT, "lab", "_test-fake-lab")

function withFakePack(fn) {
  PACKS.fakepack = { id: "fakepack", title: "Fake pack", tier: "A", proof: "http" }
  mkdirSync(LAB, { recursive: true })
  writeFileSync(path.join(LAB, ".touchstone.json"), JSON.stringify({ pack: "fakepack", title: "Fake lab", snapshot: "snapshot.json" }))
  writeFileSync(path.join(LAB, "snapshot.json"), "{}")
  try { return fn() } finally {
    delete PACKS.fakepack
    rmSync(LAB, { recursive: true, force: true })
  }
}

test("packList reads the loader", () => {
  const ids = packList().map((p) => p.id)
  assert.ok(ids.includes("contracts"))
  withFakePack(() => assert.ok(packList().some((p) => p.id === "fakepack" && p.proof === "http" && p.live === false && p.labTarget === undefined)))
})

// The Modules page builds its sentences from these fields (app/src/lib/catalog.ts).
// Each pack's map is pinned here, so a pack that changes its reach must change this too.
const REACH = {
  "contracts": { proof: "forge", live: false, fetches: ["github", "solc"] },
  "review": { proof: "none", live: false, fetches: ["github"] },
  "supply-chain": { proof: "evidence", live: true, grants: "github" },
  "domains": { proof: "evidence", live: true, scanNet: "open" },
  "surface": { proof: "none", live: true, scanNet: "open" },
  "web": { proof: "http", live: true, scanNet: "open" },
  "ai-mcp": { proof: "http", live: true, scanNet: "open", labTarget: "rule-based" },
  "keys": { proof: "forge", live: false, offline: true },
  "chain-watch": { proof: "forge", live: false, offline: true },
  "infra-cloud": { proof: "evidence", live: false, offline: true, extraProof: "cloud-http" },
}

test("packList sends each pack's proof and reach fields", () => {
  const byId = Object.fromEntries(packList().map(({ id, title, tier, ...rest }) => [id, rest]))
  assert.deepEqual(Object.keys(byId).sort(), Object.keys(REACH).sort())
  for (const [id, want] of Object.entries(REACH)) assert.deepEqual(byId[id], want, id)
})

// Read every source file in a pack's own folder, not its lab or its docs.
function packSource(id) {
  const dir = path.join(ROOT, "spike", "packs", id)
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n")
}

test("the reach fields match what each pack's code does", () => {
  for (const id of Object.keys(REACH)) {
    const src = packSource(id)
    const fetches = /name:\s*"fetch_source"/.test(src)
    assert.equal(PACKS[id].fetches?.includes("github") === true, fetches, `${id}: fetch_source needs fetches: ["github"]`)
    if (/\bSCAN_NETWORK\b/.test(src)) assert.equal(PACKS[id].scanNet, "open", `${id}: SCAN_NETWORK needs scanNet: "open"`)
    if (PACKS[id].offline) {
      assert.equal(PACKS[id].live, undefined, `${id}: an offline pack is not live`)
      assert.equal(/\bSCAN_NETWORK\b|network:\s*"bridge"|fetch_source/.test(src), false, `${id} says offline`)
    }
  }
})

test("a pack with no replay oracle plans the replay step off", () => {
  const plan = planModules({ kind: "lab", pack: "surface" }, undefined, PACKS.surface)
  const replay = plan.find((m) => m.id === "replay")
  assert.equal(replay.on, false)
  assert.equal(replay.available, false)
  assert.match(replay.reason, /no finding can be proven/)
  assert.equal(planModules({ kind: "lab", pack: "web" }, undefined, PACKS.web).find((m) => m.id === "replay").on, true)
})

test("targets carry a pack; built-in labs are Contracts, pack labs name their pack", () => {
  for (const t of listTargets().filter((t) => t.kind === "lab" && !t.id.includes("_test"))) {
    // A pack lab's id is "<pack>/<name>". A built-in Contracts lab id has no slash.
    if (t.id.includes("/")) assert.equal(t.pack, t.id.split("/")[0])
    else assert.equal(t.pack, "contracts")
  }
})

test("a pack's lab is found, and filtering by pack picks only its labs", () => {
  withFakePack(() => {
    const t = listTargets().find((t) => t.id === "fakepack/_test-fake-lab")
    assert.equal(t.pack, "fakepack")
    assert.equal(t.proofSurface.kind, "http")
    for (let i = 0; i < 10; i++) assert.equal(pickTarget({ pack: "fakepack" }).id, "fakepack/_test-fake-lab")
    for (let i = 0; i < 10; i++) assert.equal(pickTarget({}).pack ?? "contracts", "contracts")
  })
  assert.equal(getTarget("fakepack/_test-fake-lab"), null)
})

test("pickTarget refuses a scope from another pack, and a pack with no labs", () => {
  withFakePack(() => {
    assert.throws(() => pickTarget({ id: "fakepack/_test-fake-lab", pack: "contracts" }), /belongs to pack "fakepack"/)
    assert.throws(() => pickTarget({ id: "vault-reentrancy", pack: "fakepack" }), /belongs to pack "contracts"/)
  })
  assert.throws(() => pickTarget({ pack: "fakepack" }), /no runnable targets/)
})

test("prepareWorkspace writes pack; a Contracts run is unchanged apart from it", () => {
  const ws = prepareWorkspace(pickTarget({ id: "vault-reentrancy" }), { modules: [] })
  try {
    assert.deepEqual(readTouchstone(ws), { kind: "lab", solc: "0.8.38", pack: "contracts", modules: [] })
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test("a non-Contracts lab keeps its own config and gets pack and modules", () => {
  withFakePack(() => {
    const target = pickTarget({ pack: "fakepack" })
    const plan = planModules(target)
    const ws = prepareWorkspace(target, { modules: plan })
    try {
      const cfg = readTouchstone(ws)
      assert.equal(cfg.pack, "fakepack")
      assert.equal(cfg.snapshot, "snapshot.json")
      assert.equal(cfg.solc, undefined)
      assert.deepEqual(cfg.modules.map((m) => m.id), ["agent", "replay"])
      assert.ok(existsSync(path.join(ws, "snapshot.json")))
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})

// Make a lab dir holding a .touchstone.json for `pack`.
function makeLab(dir, pack) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, ".touchstone.json"), JSON.stringify({ pack }))
}

test("a pack's own lab/ dir is a lab when it holds .touchstone.json", () => {
  const packDir = path.join(ROOT, "spike", "packs", "fakepack")
  PACKS.fakepack = { id: "fakepack", title: "Fake pack", tier: "A", proof: "http" }
  makeLab(path.join(packDir, "lab"), "fakepack")
  try {
    const t = getTarget("fakepack/lab")
    assert.equal(t.pack, "fakepack")
    assert.equal(t.dir, path.join("spike", "packs", "fakepack", "lab"))
    assert.equal(pickTarget({ pack: "fakepack" }).id, "fakepack/lab")
  } finally {
    delete PACKS.fakepack
    rmSync(packDir, { recursive: true, force: true })
  }
})

test("two packs with a lab of the same name get different ids", () => {
  const a = path.join(ROOT, "spike", "packs", "fakea")
  const b = path.join(ROOT, "spike", "packs", "fakeb")
  PACKS.fakea = { id: "fakea", proof: "http" }
  PACKS.fakeb = { id: "fakeb", proof: "evidence" }
  makeLab(path.join(a, "lab", "app"), "fakea")
  makeLab(path.join(b, "lab", "app"), "fakeb")
  try {
    const ids = listTargets().filter((t) => t.pack === "fakea" || t.pack === "fakeb").map((t) => t.id).sort()
    assert.deepEqual(ids, ["fakea/app", "fakeb/app"])
    assert.equal(getTarget("fakea/app").pack, "fakea")
    assert.equal(getTarget("fakeb/app").pack, "fakeb")
    assert.throws(() => pickTarget({ id: "fakea/app", pack: "fakeb" }), /belongs to pack "fakea"/)
  } finally {
    delete PACKS.fakea
    delete PACKS.fakeb
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test("built-in Contracts lab ids are unchanged", () => {
  assert.ok(getTarget("vault-reentrancy"))
})
