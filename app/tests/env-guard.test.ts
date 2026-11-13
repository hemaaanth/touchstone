import { describe, expect, test } from "bun:test"
import { envLeaks } from "./helpers/env"

// The env guard's message names a leaked key and the kind of change, never a
// value: a guarded variable can hold a token. The values here are synthetic.
describe("the env guard's message", () => {
  const token = "tok_synthetic_7f3a9c2e4b1d8f6a0e5c3b9d"
  const path = "/home/someone/.cache/tmp/finding-harm-test-Ab12Cd/agent"

  test("a leaked token names its key, not its value", () => {
    const msg = envLeaks({ TOUCHSTONE_GRANT_TOKEN: "test-grant-token" }, { TOUCHSTONE_GRANT_TOKEN: token })
    expect(msg).toContain("TOUCHSTONE_GRANT_TOKEN (value changed)")
    expect(msg).not.toContain(token)
    expect(msg).not.toContain("test-grant-token")
    // Not even a part of it.
    expect(msg).not.toContain(token.slice(0, 8))
    expect(msg).not.toContain(token.slice(-8))
  })

  test("a set, an unset and a changed path: each by key and kind, no path", () => {
    const msg = envLeaks({ TOUCHSTONE_SCOPES_FILE: path, SPEND_CAP_USD: "5" }, { TOUCHSTONE_SCOPES_FILE: `${path}2`, TOUCHSTONE_RESULTS_DIR: path, SPEND_LEDGER: path })
    expect(msg).toContain("SPEND_CAP_USD (was set, now unset)")
    expect(msg).toContain("SPEND_LEDGER (was unset, now set)")
    expect(msg).toContain("TOUCHSTONE_RESULTS_DIR (was unset, now set)")
    expect(msg).toContain("TOUCHSTONE_SCOPES_FILE (value changed)")
    expect(msg).not.toContain("/home/someone")
    expect(msg).not.toContain("finding-harm-test")
    expect(msg).not.toContain("5")
  })

  test("nothing changed: no message", () => {
    expect(envLeaks({ TOUCHSTONE_GRANT_TOKEN: "x" }, { TOUCHSTONE_GRANT_TOKEN: "x" })).toBeNull()
  })
})
