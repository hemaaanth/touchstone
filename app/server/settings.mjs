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
  providerSetupError,
  envKeyHome,
  readConfig,
  writeConfig,
} from "../../spike/lib/providers.mjs"
import { DEFAULT_SPEND_CAP_USD, ledgerState, spendCapUsd } from "../../spike/lib/inference.mjs"
import { validateRunBudget } from "../../spike/lib/run-budget.mjs"
import { STRIX_DEFAULTS, STRIX_LIMITS, strixSettings, validateStrixSetting } from "../../spike/lib/strix.mjs"
import { DEFAULT_API_URL, DEFAULT_SNAPSHOT, DEFAULT_TARGET, execConfig, hostOf } from "../../spike/lib/daytona.mjs"
import { roamSetupView } from "../../spike/lib/daytona-setup.mjs"
import { errorText, originOf, publicUrl, scrubUrl } from "../../spike/lib/redact-url.mjs"
import { consoleToken, rotateConsoleToken, sameToken } from "../../spike/lib/grant-store.mjs"
// The page gets the token from here (vite.config.ts), read at serve time.
export { consoleToken }

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
// The token is grant-store's consoleToken(), one token for every console write,
// read from its file on each check, so a rotate takes effect at once. The
// operator never types it. The dev server writes it into the page it serves
// (vite.config.ts), and the page sends it back on each write. The token is
// never written to a log. The only response that holds it is the rotate answer,
// to the page that rotated it (handleConsoleToken).

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

// Does the request carry the current console token? A wrong type or a wrong
// length is refused first. The compare takes the same time for every wrong token.
function tokenMatches(given) {
  return sameToken(given, consoleToken())
}

// The refusal a page with an old token gets. The console shows it as it is.
export const STALE_PAGE = "This page is out of date. Reload the page and try again."

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
    return { status: 403, error: STALE_PAGE }
  }
  return null
}

// Rotate the console token: POST /api/console-token/rotate. The console guard has
// already checked Origin, content type and the token (vite.config.ts); it runs
// here again, so the route is safe on its own. The swap itself checks the token
// once more, so of two rotates at once the second gets the same 403 as a stale
// page. The answer gives the new token to the page that asked, and only to it
// (no-store); every other open page holds the old token and gets 403 on its
// next write. Returns true when it answered.
export function handleConsoleToken(req, res) {
  const path = new URL(req.url ?? "/", "http://localhost").pathname
  if (path !== "/api/console-token/rotate") return false
  const send = (status, json) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.setHeader("cache-control", "no-store")
    res.end(JSON.stringify(json))
  }
  if (req.method !== "POST") return send(405, { error: "Rotate the console token with POST." }), true
  const refusal = consoleWriteRefusal(req)
  if (refusal) return send(refusal.status, { error: refusal.error }), true
  let token
  try {
    token = rotateConsoleToken(req.headers?.["x-touchstone-grant-token"])
  } catch (err) {
    return send(500, { error: String(err?.message ?? err) }), true
  }
  if (!token) return send(403, { error: STALE_PAGE }), true
  return send(200, { token }), true
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

// envHome: where the provider's env key may go (its built-in base URL), so
// the form can warn before a save. held: why an env key is set but not used.
function keyState(p) {
  const k = providerKey(p)
  const envHome = p.keyEnv ? envKeyHome(p) || null : null
  if (!k) {
    const envName = p.keyEnv && process.env[p.keyEnv] ? p.keyEnv : null
    const held = envName ? `The key from ${envName} is only sent to ${envHome || "its built-in server"}, not ${originOf(p.baseUrl) || "this URL"}.` : null
    return { set: false, source: null, envName, envHome, last4: null, held }
  }
  return { set: true, source: p.apiKey ? "settings" : "env", envName: p.apiKey ? null : p.keyEnv, envHome, last4: k.length > 8 ? k.slice(-4) : null }
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
    // GET /api/settings needs no console token: no user name, password,
    // query or #part of a URL goes out.
    baseUrl: publicUrl(p.baseUrl).url,
    baseUrlHidden: publicUrl(p.baseUrl).cut,
    builtIn: Boolean(p.builtIn),
    saved: Boolean(cfg.providers?.[p.id]),
    key: keyState(p),
    models: modelRows(p),
  }))
  const ap = all[active]
  const setupError = providerSetupError(ap, ap ? defaultAlias(ap, cfg) : null)
  return {
    providers,
    default: { provider: setupError ? null : active, model: !setupError && ap ? defaultAlias(ap, cfg) : null },
    // PROVIDER in the server's env overrides the saved default. Say so.
    envOverride: process.env.PROVIDER || null,
    setupError,
    spend: { ...totalSpendState(cfg), budgetUsd: appRunBudgetUsd(cfg) },
    fallbackPrice: FALLBACK_PRICE,
    execution: executionState(cfg),
    modules: { web: { strix: strixState(cfg) } },
  }
}

// The Web module's Strix limits: the values a scan uses now, where each came
// from (saved, env or default), and the defaults and bounds for the form.
function strixState(cfg) {
  const { source, ...values } = strixSettings(cfg)
  return { ...values, source, defaults: STRIX_DEFAULTS, limits: STRIX_LIMITS }
}

// Save the Strix limits. A null or empty value clears the saved one, so the
// env value or the default applies again. Every value is checked first, so a
// bad one saves nothing.
export function setStrixSettings(body = {}) {
  const next = {}
  for (const name of Object.keys(STRIX_DEFAULTS)) {
    if (!(name in body)) continue
    next[name] = body[name] == null || body[name] === "" ? null : validateStrixSetting(name, body[name])
  }
  const cfg = readConfig()
  const saved = { ...(cfg.modules?.web?.strix ?? {}) }
  for (const [name, v] of Object.entries(next)) {
    if (v == null) delete saved[name]
    else saved[name] = v
  }
  cfg.modules = { ...(cfg.modules ?? {}), web: { ...(cfg.modules?.web ?? {}), strix: saved } }
  writeConfig(cfg)
  return getSettings()
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
    // saved: a key is stored in Settings, even one that is held, so the form
    // can remove it. Only the last 4 characters of a key in use leave here.
    key: c.apiKey
      ? { set: true, source: c.keySource, envName: c.keySource === "env" ? "DAYTONA_API_KEY" : null, last4: c.apiKey.length > 8 ? c.apiKey.slice(-4) : null, saved: Boolean(saved.apiKey) }
      : { set: false, source: null, envName: null, last4: null, held: c.keyHeld, saved: Boolean(saved.apiKey) },
    apiUrl: publicUrl(c.apiUrl).url,
    apiUrlHidden: publicUrl(c.apiUrl).cut,
    envKeyHost: c.envKeyHost,
    target: c.target,
    snapshot: c.snapshot,
    roamSnapshot: c.roamSnapshot,
    shellSetup: roamSetupView(c),
    // A server env var wins over the saved value. Name it, so the form can say so.
    envNames: {
      apiUrl: process.env.DAYTONA_API_URL ? "DAYTONA_API_URL" : null,
      target: process.env.DAYTONA_TARGET ? "DAYTONA_TARGET" : null,
      roamSnapshot: process.env.TOUCHSTONE_ROAM_SNAPSHOT ? "TOUCHSTONE_ROAM_SNAPSHOT" : null,
    },
    defaults: { apiUrl: DEFAULT_API_URL, target: DEFAULT_TARGET, snapshot: DEFAULT_SNAPSHOT },
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
  for (const f of ["target", "snapshot", "roamSnapshot"]) {
    const v = body[f] === undefined ? prev[f] : String(body[f] ?? "").trim()
    if (v && !/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error(`${f} has bad characters`)
    if (v) next[f] = v
  }
  // The key is sent to this server, so it must be https.
  const url = body.apiUrl === undefined ? prev.apiUrl : String(body.apiUrl ?? "").trim()
  if (url) next.apiUrl = daytonaUrl(url)
  // A saved key goes only to the host it was saved for. A new server host
  // drops it, unless this request brings a key. A new path keeps it.
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  const sameHost = hostOf(prev.apiUrl || DEFAULT_API_URL) === hostOf(next.apiUrl || DEFAULT_API_URL)
  if (key) {
    next.apiKey = key
    next.keyHost = hostOf(process.env.DAYTONA_API_URL || next.apiUrl || DEFAULT_API_URL)
  } else if (prev.apiKey && !body.clearKey && sameHost) {
    next.apiKey = prev.apiKey
    if (prev.keyHost) next.keyHost = prev.keyHost
  }
  if (backend === "daytona" && !execConfig(process.env, { execution: next }).apiKey) {
    throw new Error("Daytona needs an API key (here, or DAYTONA_API_KEY)")
  }
  cfg.execution = next
  writeConfig(cfg)
  return getSettings()
}

function daytonaUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error("Daytona server URL is not a valid URL")
  }
  if (u.protocol !== "https:") throw new Error("Daytona server URL must start with https://")
  if (u.username || u.password || u.search || u.hash) throw new Error("Daytona server URL must have no user name, password, query or #part")
  return u.href.replace(/\/+$/, "")
}

function slug(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
}

// publicUrl (redact-url.mjs) is what the page may see of a URL. Re-exported
// for the tests and for callers that import it from here.
export { publicUrl }

// The form sends back the URL it was shown. When that is the cut form of the
// stored URL, keep the stored one, so the hidden parts are not lost.
function keepHidden(posted, stored) {
  const shown = publicUrl(stored)
  return shown.cut && String(posted ?? "").trim() === shown.url ? stored : posted
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
    baseUrl: cleanBaseUrl(keepHidden(body.baseUrl, prev.baseUrl || preset?.baseUrl) || prev.baseUrl || preset?.baseUrl),
  }
  // A saved key goes only to the server it was saved for: a new scheme, host
  // or port drops it, unless this request brings a key. A new path keeps it.
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  const sameServer = originOf(entry.baseUrl) === originOf(prev.baseUrl || preset?.baseUrl)
  if (key) entry.apiKey = key
  else if (prev.apiKey && !body.clearKey && sameServer) entry.apiKey = prev.apiKey
  if (body.models !== undefined) {
    const models = modelTable(body.models)
    if (Object.keys(models).length) entry.models = models
  } else if (prev.models) {
    entry.models = prev.models
  }
  if (!entry.models && !preset) throw new Error("add at least one model")
  cfg.providers[id] = entry
  // The first configured provider becomes the default; later saves preserve the choice.
  if (!cfg.default && !process.env.PROVIDER) {
    const p = allProviders(cfg)[id]
    const model = defaultAlias(p, cfg)
    if (!providerSetupError(p, model)) cfg.default = { provider: id, model }
  }
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
  const setupError = providerSetupError(p, model)
  if (setupError) throw new Error(setupError)
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
// Uses the key from the body, else the saved or env key of provider `id`. A
// provider's key (saved or env) goes only to its saved base URL (same scheme, host
// and port), like the Daytona key. No text from this call holds a hidden part
// of the URL: every error goes through scrubUrl with the raw URL.
export async function discoverModels(body = {}) {
  const saved = body.id ? allProviders()[body.id] : null
  const baseUrl = cleanBaseUrl(keepHidden(body.baseUrl, saved?.baseUrl) || saved?.baseUrl)
  const shown = publicUrl(baseUrl).url
  const typed = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  const savedKey = providerKey(saved)
  const bound = Boolean(saved?.baseUrl) && originOf(baseUrl) !== "" && originOf(baseUrl) === originOf(saved.baseUrl)
  const key = typed || (bound ? savedKey : null)
  const keyNote =
    !typed && savedKey && !bound ? `The provider's key was not sent: it goes only to ${originOf(saved.baseUrl) || "its saved base URL"}.` : null
  const fail = (msg) => new Error(scrubUrl(keyNote ? `${msg} ${keyNote}` : msg, baseUrl, saved?.baseUrl))
  const res = await fetch(`${baseUrl}/models`, {
    headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw fail(`could not reach ${shown}/models: ${errorText(err)}`)
  })
  const text = await res.text()
  const scrub = (s) => (key ? s.split(key).join("***") : s).slice(0, 300)
  if (!res.ok) throw fail(`${shown}/models returned ${res.status}: ${scrub(text)}`)
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw fail(`${shown}/models did not return JSON`)
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
  return { models, keyUsed: Boolean(key), keyNote }
}
