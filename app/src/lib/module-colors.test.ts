import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { MODULE_COLOR, MODULE_FALLBACK_TOKEN, MODULE_TOKENS, moduleColor, moduleToken, orderModules } from "./module-colors"

// The real pack list the server sends as `availablePacks` (GET /api/models).
// @ts-expect-error — plain .mjs module, no types
const { packList } = await import("../../../spike/packs/index.mjs")
const packIds = (packList() as { id: string }[]).map((p) => p.id)

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
const block = (re: RegExp) => css.match(re)?.[1] ?? ""
const light = block(/:root\s*\{([\s\S]*?)\}/)
const dark = block(/\.dark\s*\{([\s\S]*?)\}/)
const value = (body: string, token: string) => body.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1].trim()
const hueOf = (v: string) => Number(v.match(/^oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s*\)$/)?.[1])

describe("module colours", () => {
  test("the server lists packs", () => {
    assert.ok(packIds.length >= 11)
  })

  test("every listed module has a colour", () => {
    for (const id of packIds) {
      assert.ok(Object.hasOwn(MODULE_COLOR, id), `${id} has no colour in MODULE_COLOR`)
      assert.equal(moduleToken(id), MODULE_COLOR[id])
    }
  })

  test("no two listed modules share a colour", () => {
    const tokens = packIds.map((id) => moduleToken(id))
    assert.equal(new Set(tokens).size, packIds.length)
    assert.ok(!tokens.includes(MODULE_FALLBACK_TOKEN))
  })

  test("an unknown module gets the same neutral fallback every time", () => {
    for (const id of ["no-such-module", "agent", "replay", "", "toString", "constructor", "__proto__"]) {
      assert.equal(moduleToken(id), MODULE_FALLBACK_TOKEN)
      assert.equal(moduleToken(id), moduleToken(id))
    }
    assert.equal(moduleToken(null), MODULE_FALLBACK_TOKEN)
    assert.equal(moduleToken(undefined), MODULE_FALLBACK_TOKEN)
    assert.equal(moduleColor("no-such-module"), `var(${MODULE_FALLBACK_TOKEN})`)
    assert.equal(moduleColor("web"), `var(${MODULE_COLOR.web})`)
  })

  test("the map only uses tokens from the list", () => {
    for (const token of Object.values(MODULE_COLOR)) assert.ok(MODULE_TOKENS.includes(token), token)
  })

  test("every token is set in the light and the dark theme", () => {
    for (const token of [...MODULE_TOKENS, MODULE_FALLBACK_TOKEN]) {
      assert.ok(value(light, token), `${token} is missing in :root`)
      assert.ok(value(dark, token), `${token} is missing in .dark`)
    }
  })

  test("no module token is red or green, and no two tokens are the same colour", () => {
    // Red sits near hue 25 (--bad) and green near hue 165 (--ok).
    const far = (h: number, from: number) => Math.min(Math.abs(h - from), 360 - Math.abs(h - from)) >= 20
    for (const body of [light, dark]) {
      const seen = new Set<string>()
      for (const token of MODULE_TOKENS) {
        const v = value(body, token)!
        const hue = hueOf(v)
        assert.ok(Number.isFinite(hue), `${token}: ${v} is not a plain oklch() colour`)
        assert.ok(far(hue, 25), `${token} is too close to red`)
        assert.ok(far(hue, 165), `${token} is too close to green`)
        assert.ok(hue < 110 || hue > 190, `${token} is in the green range`)
        assert.ok(!seen.has(v), `${token} repeats ${v}`)
        seen.add(v)
      }
      assert.match(value(body, MODULE_FALLBACK_TOKEN)!, /^oklch\(\s*[\d.]+\s+0\s+0\s*\)$/)
    }
  })
})

describe("module order", () => {
  test("a row's modules take the order of the server's list", () => {
    const order = ["contracts", "web", "review"]
    assert.deepEqual(orderModules(["review", "contracts"], order), ["contracts", "review"])
    assert.deepEqual(orderModules(["contracts", "review"], order), ["contracts", "review"])
  })

  test("an unknown module goes last and keeps its place", () => {
    const order = ["contracts", "web"]
    assert.deepEqual(orderModules(["new-b", "web", "new-a", "contracts"], order), ["contracts", "web", "new-b", "new-a"])
  })

  test("the input list is not changed", () => {
    const ids = ["web", "contracts"]
    orderModules(ids, ["contracts", "web"])
    assert.deepEqual(ids, ["web", "contracts"])
  })
})
