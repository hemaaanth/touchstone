import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Runs started from the app always run under a total spend cap over the shared
// ledger (default $50.85). The app refuses to start a run at or above the cap,
// or when the ledger cannot be read; every worker gets SPEND_CAP_USD; a run that
// stops at the cap is reported as a budget stop, not a model failure.
// A throwaway ledger. createRun is always called with an unknown model alias,
// so even code without the cap check stops before any workspace or worker.
const dir = mkdtempSync(path.join(tmpdir(), "spend-cap-test-"))
const LEDGER = path.join(dir, "spend.json")
const saved = { ledger: process.env.SPEND_LEDGER, cap: process.env.SPEND_CAP_USD }
process.env.SPEND_LEDGER = LEDGER
delete process.env.SPEND_CAP_USD
process.env.TOUCHSTONE_GRANT_TOKEN = "test-grant-token"

// @ts-expect-error — plain .mjs module, no types
const runs = await import("../server/runs.mjs")
// @ts-expect-error — plain .mjs module, no types
const settings = await import("../server/settings.mjs")

const ledger = (totalUsd: unknown) => writeFileSync(LEDGER, JSON.stringify({ totalUsd, calls: 0, byModel: {} }))
const start = () => runs.createRun({ alias: "no-such-alias" })

beforeEach(() => {
  process.env.SPEND_LEDGER = LEDGER
  delete process.env.SPEND_CAP_USD
  ledger(0)
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  if (saved.ledger == null) delete process.env.SPEND_LEDGER
  else process.env.SPEND_LEDGER = saved.ledger
  if (saved.cap == null) delete process.env.SPEND_CAP_USD
  else process.env.SPEND_CAP_USD = saved.cap
})

describe("total spend cap", () => {
  test("the app cap defaults to $50.85, and SPEND_CAP_USD can only lower it", () => {
    expect(settings.APP_DEFAULT_SPEND_CAP_USD).toBe(50.85)
    expect(settings.appSpendCapUsd({})).toBe(50.85)
    process.env.SPEND_CAP_USD = "20"
    expect(settings.appSpendCapUsd({})).toBe(20)
    process.env.SPEND_CAP_USD = "500"
    expect(settings.appSpendCapUsd({})).toBe(50.85)
  })

  test("a run is refused when the ledger is at the cap", async () => {
    ledger(50.85)
    await expect(start()).rejects.toThrow(/total spend cap/i)
    ledger(51)
    await expect(start()).rejects.toThrow(/total spend cap/i)
  })

  test("a run is refused when the ledger is unreadable or corrupt", async () => {
    writeFileSync(LEDGER, "{ not json")
    await expect(start()).rejects.toThrow(/spend ledger/i)
    writeFileSync(LEDGER, JSON.stringify({ calls: 1, byModel: {} }))
    await expect(start()).rejects.toThrow(/spend ledger/i)
  })

  test("a run is refused when SPEND_CAP_USD is set but unusable", async () => {
    process.env.SPEND_CAP_USD = "lots"
    await expect(start()).rejects.toThrow(/SPEND_CAP_USD/)
  })

  test("below the cap, the cap check lets the run go on to its next check", async () => {
    ledger(10)
    await expect(start()).rejects.toThrow(/unknown model alias/)
  })

  test("every worker gets the total cap in SPEND_CAP_USD", () => {
    const env = runs.budgetEnv({ events: [] })
    expect(env.SPEND_CAP_USD).toBe("50.85")
    expect(env.RUN_BUDGET_USD).toBe("5")
  })

  test("a run stopped at the total cap is a budget stop, not a model failure", () => {
    const detail = "Total spend cap reached: the ledger shows $50.8600 of the $50.85 total cap (SPEND_CAP_USD). Raise the total cap to spend more."
    const info = runs.failureInfo({ settled: { status: "unanswered", reason: "model_error", detail }, events: [] })
    expect(info.kind).toBe("budget")
    expect(info.retryable).toBe(false)
    expect(info.title).toMatch(/total spend cap/i)
    const ledgerInfo = runs.failureInfo({ settled: { status: "unanswered", reason: "model_error", detail: "The spend ledger (/x/spend.json) is unreadable or corrupt, so the total spend cap cannot be checked." }, events: [] })
    expect(ledgerInfo.kind).toBe("budget")
    expect(ledgerInfo.retryable).toBe(false)
  })

  test("Settings shows the cap and the ledger, and does not break on a corrupt ledger", () => {
    ledger(12.5)
    const ok = settings.getSettings().spend
    expect(ok.capUsd).toBe(50.85)
    expect(ok.usd).toBe(12.5)
    expect(ok.ledgerError).toBeNull()
    writeFileSync(LEDGER, "{ not json")
    const bad = settings.getSettings().spend
    expect(bad.capUsd).toBe(50.85)
    expect(bad.usd).toBeNull()
    expect(bad.ledgerError).toMatch(/spend ledger/i)
    expect(runs.spendState().ledgerError).toMatch(/spend ledger/i)
  })
})
