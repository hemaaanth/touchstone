// Module choice: the pack list, target filtering by pack, and the pack written
// into each run's .touchstone.json. A fake pack with a fake lab stands in for a
// pack that another thread ships; it is added and removed inside the test.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
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
  withFakePack(() => assert.ok(packList().some((p) => p.id === "fakepack" && p.proof === "http")))
})

test("targets carry a pack; built-in labs are Contracts", () => {
  for (const t of listTargets().filter((t) => t.kind === "lab" && !t.id.startsWith("_test"))) assert.equal(t.pack, "contracts")
})

test("a pack's lab is found, and filtering by pack picks only its labs", () => {
  withFakePack(() => {
    const t = listTargets().find((t) => t.id === "_test-fake-lab")
    assert.equal(t.pack, "fakepack")
    assert.equal(t.proofSurface.kind, "http")
    for (let i = 0; i < 10; i++) assert.equal(pickTarget({ pack: "fakepack" }).id, "_test-fake-lab")
    for (let i = 0; i < 10; i++) assert.equal(pickTarget({}).pack ?? "contracts", "contracts")
  })
  assert.equal(getTarget("_test-fake-lab"), null)
})

test("pickTarget refuses a scope from another pack, and a pack with no labs", () => {
  withFakePack(() => {
    assert.throws(() => pickTarget({ id: "_test-fake-lab", pack: "contracts" }), /belongs to pack "fakepack"/)
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
