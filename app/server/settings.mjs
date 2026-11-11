// Settings: the inference providers the engine may use, the default provider
// and model for new runs, and the spend cap.
//
// The config lives in spike/data/providers.json (see spike/lib/providers.mjs).
// API keys are written there and read by the engine. They never go back to the
// browser: the API returns only whether a key is set, where it comes from, and
// its last 4 characters. Keys are never logged.
import {
  FALLBACK_PRICE,
  PROVIDERS,
  aliasFor,
  allProviders,
  activeId,
  runBudgetUsd,
  defaultAlias,
  providerKey,
  readConfig,
  writeConfig,
} from "../../spike/lib/providers.mjs"
import { spent } from "../../spike/lib/inference.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"

// The console's default per-run budget when Settings has none saved. The
// engine's own default (spike/lib/run-budget.mjs) stays $1 for CLI runs; app
// runs pass their budget to the worker as RUN_BUDGET_USD, so this one wins.
export const APP_DEFAULT_RUN_BUDGET_USD = 5

export function appRunBudgetUsd(cfg = readConfig()) {
  return cfg.runBudgetUsd == null ? APP_DEFAULT_RUN_BUDGET_USD : runBudgetUsd(cfg)
}

function keyState(p) {
  const k = providerKey(p)
  if (!k) return { set: false, source: null, last4: null }
  return { set: true, source: p.apiKey ? "settings" : "env", envName: p.apiKey ? null : p.keyEnv, last4: k.length > 8 ? k.slice(-4) : null }
}

function modelRows(p) {
  return Object.entries(p.models ?? {}).map(([alias, m]) => ({
    alias,
    id: m.id,
    input: m.input,
    output: m.output,
    context: m.context ?? null,
    priced: !m.provisional,
  }))
}

export function getSettings() {
  const cfg = readConfig()
  const all = allProviders(cfg)
  const active = activeId(cfg)
  const providers = Object.values(all).map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl ?? "",
    builtIn: Boolean(p.builtIn),
    saved: Boolean(cfg.providers?.[p.id]),
    key: keyState(p),
    models: modelRows(p),
  }))
  const ap = all[active]
  return {
    providers,
    default: { provider: active, model: ap ? defaultAlias(ap, cfg) : null },
    // PROVIDER in the server's env overrides the saved default. Say so.
    envOverride: process.env.PROVIDER || null,
    spend: { usd: spent(), budgetUsd: appRunBudgetUsd(cfg) },
    fallbackPrice: FALLBACK_PRICE,
  }
}

function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
}

function cleanBaseUrl(raw) {
  let u
  try {
    u = new URL(String(raw ?? "").trim())
  } catch {
    throw new Error("base URL is not a valid URL")
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("base URL must be http or https")
  return u.toString().replace(/\/+$/, "")
}

function price(v, fallback) {
  if (v == null || String(v).trim() === "") return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// Turn the UI's model rows into the engine's model table, keyed by a
// filename-safe alias. Rows with no id are dropped; duplicate aliases get a suffix.
function modelTable(rows) {
  const out = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = String(r?.id ?? "").trim()
    if (!id) continue
    let alias = aliasFor(id)
    for (let i = 2; out[alias]; i++) alias = `${aliasFor(id)}-${i}`
    const priced = r.input != null && r.input !== "" && r.output != null && r.output !== ""
    out[alias] = {
      id,
      input: price(r.input, FALLBACK_PRICE.input),
      output: price(r.output, FALLBACK_PRICE.output),
      context: Number(r.context) > 0 ? Number(r.context) : 131072,
      maxOut: 65536,
      ...(priced ? {} : { provisional: true }),
    }
  }
  return out
}

// Add or update a provider. An empty apiKey keeps the saved one.
export function saveProvider(body = {}) {
  const cfg = readConfig()
  cfg.providers ??= {}
  const label = String(body.label ?? "").trim()
  const id = body.id ? String(body.id) : slug(label)
  if (!id) throw new Error("name is required")
  const prev = cfg.providers[id] ?? {}
  const preset = PROVIDERS[id]
  const entry = {
    id,
    label: label || prev.label || preset?.label || id,
    baseUrl: cleanBaseUrl(body.baseUrl || prev.baseUrl || preset?.baseUrl),
  }
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  if (key) entry.apiKey = key
  else if (prev.apiKey && !body.clearKey) entry.apiKey = prev.apiKey
  if (body.models !== undefined) {
    const models = modelTable(body.models)
    if (Object.keys(models).length) entry.models = models
  } else if (prev.models) {
    entry.models = prev.models
  }
  if (!entry.models && !preset) throw new Error("add at least one model")
  cfg.providers[id] = entry
  writeConfig(cfg)
  return getSettings()
}

// Remove a saved provider. A built-in provider falls back to its preset.
export function deleteProvider(id) {
  const cfg = readConfig()
  if (!cfg.providers?.[id]) throw new Error(`no saved provider "${id}"`)
  delete cfg.providers[id]
  if (cfg.default?.provider === id && !PROVIDERS[id]) cfg.default = null
  writeConfig(cfg)
  return getSettings()
}

export function setDefault({ provider, model } = {}) {
  const cfg = readConfig()
  const p = allProviders(cfg)[provider]
  if (!p) throw new Error(`unknown provider "${provider}"`)
  if (!p.models?.[model]) throw new Error(`unknown model "${model}" for ${p.label}`)
  if (!providerKey(p)) throw new Error(`${p.label} has no API key yet`)
  cfg.default = { provider, model }
  writeConfig(cfg)
  return getSettings()
}

export function setRunBudget(value) {
  const n = validateRunBudget(value)
  const cfg = readConfig()
  cfg.runBudgetUsd = n
  writeConfig(cfg)
  return getSettings()
}

// Gateways publish prices per token (OpenRouter style) or per 1M tokens.
function perMillion(v) {
  const n = Number(typeof v === "object" && v ? v.amount ?? v.usd ?? v.value : v)
  if (!Number.isFinite(n) || n < 0) return null
  return n > 0 && n < 0.01 ? Math.round(n * 1e6 * 1e4) / 1e4 : n
}

// List the models a gateway serves for this key: GET {baseUrl}/models. Free.
// Uses the key from the body, else the saved or env key of provider `id`.
export async function discoverModels(body = {}) {
  const saved = body.id ? allProviders()[body.id] : null
  const baseUrl = cleanBaseUrl(body.baseUrl || saved?.baseUrl)
  const key = (typeof body.apiKey === "string" && body.apiKey.trim()) || providerKey(saved)
  const res = await fetch(`${baseUrl}/models`, {
    headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new Error(`could not reach ${baseUrl}/models: ${String(err?.message ?? err)}`)
  })
  const text = await res.text()
  const scrub = (s) => (key ? s.split(key).join("***") : s).slice(0, 300)
  if (!res.ok) throw new Error(`${baseUrl}/models returned ${res.status}: ${scrub(text)}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${baseUrl}/models did not return JSON`)
  }
  const list = Array.isArray(json) ? json : json.data ?? json.models ?? []
  const models = list
    .map((m) => {
      const id = m?.id ?? m?.name
      if (!id) return null
      const p = m.pricing ?? {}
      return {
        id: String(id),
        input: perMillion(p.prompt ?? p.input ?? m.input_price ?? m.inputCostPerToken),
        output: perMillion(p.completion ?? p.output ?? m.output_price ?? m.outputCostPerToken),
        context: Number(m.context_length ?? m.context_window ?? m.contextLength ?? m.context) || null,
      }
    })
    .filter(Boolean)
  return { models, keyUsed: Boolean(key) }
}
