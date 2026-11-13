// Settings: the inference providers the engine may use, the default provider
// and model for new runs, the spend cap, and where tool calls run.
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
import { DEFAULT_SPEND_CAP_USD, ledgerState, spendCapUsd } from "../../spike/lib/inference.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"
import { DEFAULT_SNAPSHOT, DEFAULT_TARGET, execConfig } from "../../spike/lib/daytona.mjs"
import crypto from "node:crypto"
import { GRANT_TOKEN } from "../../spike/lib/grant-store.mjs"

// The console guard. Every state-changing request under /api/ passes it before
// its handler runs: a run create, steer, stop, archive, rename or delete, a
// finding dismiss, a scope create or delete, a grant change, a Settings write.
// Only the operator's own console page may send one. Each rule fails closed.
//   - Origin is required, and its host must equal the Host header. A browser
//     always sends Origin on a POST or DELETE. A write with no Origin is not
//     the console, so it is refused. X-Forwarded-Host is not trusted: any
//     client can set it.
//   - A request with a body (not DELETE) must say content-type
//     application/json. A cross-site form cannot send that content type.
//   - The request must carry the console token in x-touchstone-grant-token.
// The token is grant-store.GRANT_TOKEN, one token for every console write. The
// operator never types it. The dev server writes it into the page it serves
// (vite.config.ts), and the page sends it back on each write. The token is
// never written to a log or to a response.
export const SETTINGS_TOKEN = GRANT_TOKEN

// GET and HEAD only read. Every other method is a write and is guarded.
const READ_METHODS = new Set(["GET", "HEAD"])

// The host of the Origin header, or null when it is absent or not a URL.
function originHost(headers) {
  try {
    return headers.origin ? new URL(headers.origin).host : null
  } catch {
    return null
  }
}

// True when the request names an Origin that is not this console. The dev
// server refuses such a request on every path, reads included.
export function foreignOrigin(req) {
  const h = req.headers ?? {}
  return h.origin !== undefined && (!h.host || originHost(h) !== h.host)
}

// Does the request carry the console token? A wrong type or a wrong length is
// refused first. The compare itself takes the same time for every wrong token.
function tokenMatches(given) {
  if (typeof given !== "string") return false
  const a = Buffer.from(given)
  const b = Buffer.from(SETTINGS_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Why this write is refused, as { status, error }, or null when it may go on.
// A read (GET, HEAD) is never refused here.
export function consoleWriteRefusal(req) {
  if (READ_METHODS.has(req.method)) return null
  const h = req.headers ?? {}
  const from = originHost(h)
  if (!from || !h.host || from !== h.host) {
    return { status: 403, error: "This request did not come from the console's own page. Reload the page and try again." }
  }
  if (req.method !== "DELETE" && !/^application\/json\b/i.test(String(h["content-type"] ?? ""))) {
    return { status: 415, error: "The console sends each change as JSON. Reload the page and try again." }
  }
  if (!tokenMatches(h["x-touchstone-grant-token"])) {
    return { status: 403, error: "This page is out of date. Reload the page and try again." }
  }
  return null
}

// The older names of the guard. Settings code and tests still use them.
export const settingsWriteRefusal = consoleWriteRefusal

export function settingsWriteAllowed(req) {
  return consoleWriteRefusal(req) === null
}

// The console's default per-run budget when Settings has none saved. The
// engine's own default for CLI runs (spike/lib/run-budget.mjs) is also $5; app
// runs pass their budget to the worker as RUN_BUDGET_USD, so this one wins.
export const APP_DEFAULT_RUN_BUDGET_USD = 5

export function appRunBudgetUsd(cfg = readConfig()) {
  return cfg.runBudgetUsd == null ? APP_DEFAULT_RUN_BUDGET_USD : runBudgetUsd(cfg)
}

// The total spend cap: every app run stops once the shared ledger
// (spike/spend.json, or SPEND_LEDGER) reaches it. The owner's default is $50.85.
// providers.json may set spendCapUsd. SPEND_CAP_USD in the server's env can
// only lower the cap, never raise it. A value that is not a positive dollar
// amount throws, so the cap is never "no limit". Read-only in the console.
export const APP_DEFAULT_SPEND_CAP_USD = DEFAULT_SPEND_CAP_USD
export function appSpendCapUsd(cfg = readConfig()) {
  return spendCapUsd(cfg)
}

// Why a new run (or a follow-up) may not start under the total cap, or null.
// Fails closed: an unreadable ledger or an unusable cap refuses the run.
export function spendCapRefusal(cfg = readConfig()) {
  let capUsd
  try {
    capUsd = appSpendCapUsd(cfg)
  } catch (err) {
    return `Run refused: ${err.message}`
  }
  const ledger = ledgerState()
  if (ledger.error) return `Run refused: ${ledger.error}`
  if (ledger.usd >= capUsd) {
    return `Run refused: the total spend cap is reached. The spend ledger shows $${ledger.usd.toFixed(2)} of the $${capUsd.toFixed(2)} total cap. Raise the total cap (spendCapUsd or SPEND_CAP_USD) to start new runs.`
  }
  return null
}

// The ledger total and the total cap for screens. Never throws: a broken
// ledger or cap shows as an error line instead of a number.
export function totalSpendState(cfg = readConfig()) {
  const ledger = ledgerState()
  let capUsd = null
  let capError = null
  try {
    capUsd = appSpendCapUsd(cfg)
  } catch (err) {
    capError = err.message
  }
  return { usd: ledger.usd, capUsd, ledgerError: ledger.error ?? capError }
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
    spend: { ...totalSpendState(cfg), budgetUsd: appRunBudgetUsd(cfg) },
    fallbackPrice: FALLBACK_PRICE,
    execution: executionState(cfg),
  }
}

// Where tool calls run: local Docker (the default) or Daytona sandboxes.
// The Daytona key is masked like a provider key. TOUCHSTONE_EXEC in the
// server's env overrides the saved backend. Say so.
function executionState(cfg) {
  const c = execConfig(process.env, cfg)
  const saved = cfg.execution ?? {}
  return {
    backend: c.backend,
    saved: saved.backend === "daytona" ? "daytona" : "local",
    envOverride: process.env.TOUCHSTONE_EXEC || null,
    key: c.apiKey
      ? { set: true, source: c.keySource, envName: c.keySource === "env" ? "DAYTONA_API_KEY" : null, last4: c.apiKey.length > 8 ? c.apiKey.slice(-4) : null }
      : { set: false, source: null, envName: null, last4: null },
    target: c.target,
    snapshot: c.snapshot,
    defaults: { target: DEFAULT_TARGET, snapshot: DEFAULT_SNAPSHOT },
  }
}

// Save the execution backend. An empty apiKey keeps the saved one.
// Daytona needs a key, from this body, Settings, or DAYTONA_API_KEY.
export function setExecution(body = {}) {
  const cfg = readConfig()
  const prev = cfg.execution ?? {}
  const backend = body.backend ?? prev.backend ?? "local"
  if (backend !== "local" && backend !== "daytona") throw new Error('backend must be "local" or "daytona"')
  const next = { backend }
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  if (key) next.apiKey = key
  else if (prev.apiKey && !body.clearKey) next.apiKey = prev.apiKey
  for (const f of ["target", "snapshot"]) {
    const v = body[f] === undefined ? prev[f] : String(body[f] ?? "").trim()
    if (v && !/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error(`${f} has bad characters`)
    if (v) next[f] = v
  }
  if (backend === "daytona" && !execConfig(process.env, { execution: next }).apiKey) {
    throw new Error("Daytona needs an API key (here, or DAYTONA_API_KEY)")
  }
  cfg.execution = next
  writeConfig(cfg)
  return getSettings()
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
