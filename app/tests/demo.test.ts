import "./helpers/isolated-env"
import { afterEach, expect, test } from "bun:test"
import { demoConfig, demoStartBody, isDemoMode } from "../src/lib/demo"

const globals = globalThis as { document?: unknown }
const original = globals.document
const meta = (content: string | null) => {
  globals.document = { querySelector: () => content === null ? null : { content } }
}
afterEach(() => { globals.document = original })

test("owner mode stays unchanged without a document or demo opt-in", () => {
  delete globals.document
  expect(demoConfig()).toBeNull()
  meta(null)
  expect(isDemoMode()).toBe(false)
})

test("the static opt-in restricts the first render before any catalog response", () => {
  meta('{"budgetUsd":1,"maxMinutes":10}')
  expect(demoConfig()).toEqual({ budgetUsd: 1, maxMinutes: 10 })
  expect(isDemoMode()).toBe(true)
})

test("malformed or unsupported opt-ins cannot reveal owner controls", () => {
  for (const value of ["", "{", "null", "[]", "true", '{"budgetUsd":100,"maxMinutes":60}', '{"budgetUsd":"1","maxMinutes":10}']) {
    meta(value)
    expect(isDemoMode()).toBe(true)
    expect(demoConfig()).toEqual({ budgetUsd: 1, maxMinutes: 10 })
  }
})

test("demo starts require one explicit prepared target, never random or custom scope", () => {
  for (const target of [undefined, "", "random", "scope-owner", "vault-multi"]) {
    expect(() => demoStartBody(target)).toThrow("Select a prepared demo scope")
  }
  for (const targetId of ["vault-reentrancy", "vault-accounting"]) {
    expect(demoStartBody(targetId)).toEqual({ targetId })
  }
})
