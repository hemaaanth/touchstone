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
// @ts-expect-error — plain .mjs module, no types
const inference = await import("../../spike/lib/inference.mjs")

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
    const detail = inference.spendCapMessage(50.86, 50.85)
    const info = runs.failureInfo({ settled: { status: "unanswered", reason: "model_error", detail }, events: [] })
    expect(info.kind).toBe("budget")
    expect(info.retryable).toBe(false)
    expect(info.title).toMatch(/total spend cap/i)
    writeFileSync(LEDGER, "{ not json")
    const ledgerDetail = inference.ledgerState().error
    expect(ledgerDetail).toMatch(/spend ledger/i)
    const ledgerInfo = runs.failureInfo({ settled: { status: "unanswered", reason: "model_error", detail: ledgerDetail }, events: [] })
    expect(ledgerInfo.kind).toBe("budget")
    expect(ledgerInfo.retryable).toBe(false)
    // Words alone do not make a budget stop: only the cap's own sentence does.
    const other = runs.failureInfo({ settled: { status: "unanswered", reason: "model_error", detail: "Tool failed: could not parse spend ledger column in target CSV" }, events: [] })
    expect(other.kind).not.toBe("budget")
  })

  test("a follow-up is refused when the ledger is at the cap", () => {
    // This run has also spent its own budget, so without the cap check the
    // next check stops the follow-up before any workspace or worker.
    const run = () => ({ id: "r", events: [{ ev: "budget", usd: 1 }, { ev: "spend", usd: 1 }] })
    ledger(10)
    expect(() => runs.followUp(run(), "hi", "c")).toThrow(/spent its budget/)
    ledger(50.85)
    expect(() => runs.followUp(run(), "hi", "c")).toThrow(/total spend cap/i)
    writeFileSync(LEDGER, "{ not json")
    expect(() => runs.followUp(run(), "hi", "c")).toThrow(/spend ledger/i)
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
