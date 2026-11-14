import "./helpers/isolated-env"
import { useEnv } from "./helpers/env"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "provider-onboarding-"))
const results = join(dir, "results")
useEnv({
  TOUCHSTONE_PROVIDERS_FILE: join(dir, "providers.json"),
  TOUCHSTONE_RESULTS_DIR: results,
  SPEND_LEDGER: join(dir, "spend.json"),
  PROVIDER: undefined,
  NEARAI_API_KEY: undefined,
  BOUNDLESS_API_KEY: undefined,
  LYBER_API_KEY: undefined,
})

// @ts-expect-error — plain .mjs module
// These modules capture configuration paths at load time. Load only after the fixture env is set.
const providers = await import("../../spike/lib/providers.mjs")
// @ts-expect-error — plain .mjs module
const settings = await import("../server/settings.mjs")
// @ts-expect-error — plain .mjs module
const runs = await import("../server/runs.mjs")

beforeEach(() => {
  delete process.env.PROVIDER
  delete process.env.NEARAI_API_KEY
  providers.writeConfig({ default: null, providers: {} })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a fresh installation requires a key instead of advertising runnable preset models", async () => {
  const state = settings.getSettings()
  expect(state.default.provider).toBeNull()
  expect(state.setupError).toContain("API key for NEAR AI Cloud")
  expect(runs.availableModels()).toEqual([])
  const before = runs.listRuns()
  await expect(runs.createRun({ alias: "ds-abl", targetId: "not-a-target" })).rejects.toThrow("Add an API key for NEAR AI Cloud in Settings")
  expect(runs.listRuns()).toEqual(before)
  expect(existsSync(results)).toBe(false)
})

test("a configured provider passes admission without requiring an unrelated RPC key", async () => {
  settings.saveProvider({ id: "near", apiKey: "synthetic-near-key-only-for-tests" })
  expect(settings.getSettings().setupError).toBeNull()
  expect(runs.availableModels().some((m: { alias: string }) => m.alias === "ds-abl")).toBe(true)
  // The target check is the next boundary; it refuses before any workspace, Docker, or worker.
  await expect(runs.createRun({ alias: "ds-abl", targetId: "not-a-target" })).rejects.toThrow("unknown target")
  expect(existsSync(results)).toBe(false)
})

test("saving the first working alternative selects it, but later saves preserve the chosen provider", () => {
  const first = settings.saveProvider({ id: "boundless", apiKey: "synthetic-boundless-key-only-for-tests" })
  expect(first.default.provider).toBe("boundless")
  const second = settings.saveProvider({ id: "near", apiKey: "synthetic-near-key-only-for-tests" })
  expect(second.default.provider).toBe("boundless")
  expect(JSON.stringify(second)).not.toContain("synthetic-near-key-only-for-tests")
})

test("an explicit server provider is respected and still needs its own key", () => {
  process.env.PROVIDER = "boundless"
  const state = settings.saveProvider({ id: "near", apiKey: "synthetic-near-key-only-for-tests" })
  expect(state.default.provider).toBeNull()
  expect(state.setupError).toContain("API key for Boundless")
})

test("a key held for another server cannot make a provider ready", () => {
  process.env.NEARAI_API_KEY = "synthetic-env-key-only-for-tests"
  settings.saveProvider({ id: "near", baseUrl: "https://other.example.test/v1" })
  expect(settings.getSettings().setupError).toContain("API key for NEAR AI Cloud")
  expect(runs.availableModels()).toEqual([])
})

test("empty model selections and whitespace credentials cannot pass the setup check", () => {
  expect(providers.providerSetupError({ label: "Empty", baseUrl: "https://example.test/v1", models: {}, apiKey: "fake" }, null)).toContain("Choose a DeepSeek model")
  expect(providers.providerSetupError({ label: "Empty", baseUrl: "https://example.test/v1", models: { m: { id: "deepseek-test" } }, apiKey: "   " }, "m")).toContain("API key")
})

test("an unconfigured provider is actionable and not advertised as retryable", () => {
  const info = runs.failureInfo({ events: [], settled: { reason: "model_error", detail: "Provider is not configured: boundless" } })
  expect(info.title).toBe("Provider setup is incomplete")
  expect(info.retryable).toBe(false)
  expect(info.hint).toContain("Settings")
})

test("an unconfigured saved default gives way to the only configured provider", () => {
  providers.writeConfig({ default: { provider: "boundless", model: "ds-abl" }, providers: {
    lyber: { apiKey: "synthetic-lyber-key-only-for-tests", models: { ds: { id: "deepseek-test", input: 1, output: 1 } } },
  } })
  expect(settings.getSettings().default.provider).toBe("lyber")
  expect(runs.providerInfo().id).toBe("lyber")
  expect(runs.availableModels().map((m: { alias: string }) => m.alias)).toEqual(["ds"])
})

test("two or three configured providers keep one valid default and reject an unconfigured choice", () => {
  settings.saveProvider({ id: "near", apiKey: "synthetic-near-key-only-for-tests" })
  settings.saveProvider({ id: "lyber", apiKey: "synthetic-lyber-key-only-for-tests", models: [{ id: "deepseek-test", input: 1, output: 1 }] })
  expect(settings.setDefault({ provider: "lyber", model: "deepseek-test" }).default.provider).toBe("lyber")
  expect(() => settings.setDefault({ provider: "boundless", model: "ds-abl" })).toThrow("API key")
  settings.saveProvider({ id: "boundless", apiKey: "synthetic-boundless-key-only-for-tests" })
  expect(settings.setDefault({ provider: "boundless", model: "ds-abl" }).default.provider).toBe("boundless")
  expect(settings.saveProvider({ id: "boundless", clearKey: true }).default.provider).toBe("near")
  expect(settings.saveProvider({ id: "near", clearKey: true }).default.provider).toBe("lyber")
})

test("a saved Kimi default cannot be advertised or started, and stored credentials stay intact", async () => {
  providers.writeConfig({ default: { provider: "lyber", model: "kimi" }, providers: {
    lyber: { apiKey: "synthetic-lyber-key-only-for-tests", models: {
      kimi: { id: "kimi-k31-pro-abliterated", input: 1, output: 1 },
      ds: { id: "deepseek-test", input: 1, output: 1 },
    } },
  } })
  expect(settings.getSettings().default.model).toBe("ds")
  expect(runs.availableModels().map((m: { alias: string }) => m.alias)).toEqual(["ds"])
  const before = runs.listRuns()
  await expect(runs.createRun({ alias: "kimi", targetId: "not-a-target" })).rejects.toThrow("DeepSeek")
  expect(runs.listRuns()).toEqual(before)
  expect(providers.readConfig().providers.lyber.apiKey).toBe("synthetic-lyber-key-only-for-tests")
  expect(() => settings.saveProvider({ id: "lyber", models: [{ id: "kimi-k31-pro-abliterated" }] })).toThrow("Only DeepSeek")
})

test("model discovery offers only DeepSeek models without making a provider call", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ data: [
    { id: "kimi-k31-pro-abliterated" },
    { id: "deepseek-ai/DeepSeek-test" },
    { id: "Qwen/Qwen-test" },
  ] }) as Promise<Response>
  try {
    const result = await settings.discoverModels({ id: "near" })
    expect(result.models.map((m: { id: string }) => m.id)).toEqual(["deepseek-ai/DeepSeek-test"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
