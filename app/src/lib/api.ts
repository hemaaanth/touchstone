import type {
  CandidateSummary,
  DiscoveredModel,
  Finding,
  FindingSummary,
  ModelChoice,
  ProviderInfo,
  RunEvent,
  RunSummary,
  RunView,
  SettingsState,
  SpendState,
  TargetChoice,
  PackChoice,
  RunMode,
} from "./types"
import { reportStalePage, setConsoleToken, tokenHeaders } from "./console-token"

export class HttpError extends Error {
  status: number
  constructor(url: string, status: number) {
    super(`${url} -> ${status}`)
    this.status = status
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new HttpError(url, res.status)
  return (await res.json()) as T
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...tokenHeaders() },
    body: JSON.stringify(body),
  })
  return writeResult<T>(url, res)
}

// A write refused because this page's console token is old. The app shows it
// once (the stale-page notice, with Reload); a page's own error line can skip it.
export class StalePageError extends Error {}

// The answer to a write. A 403 means this page's console token is old: the app
// is told (reportStalePage), and the caller gets the server's sentence as a
// StalePageError.
async function writeResult<T>(url: string, res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = (json as { error?: string }).error ?? `${url} -> ${res.status}`
    if (res.status === 403) {
      reportStalePage(error)
      throw new StalePageError(error)
    }
    throw new Error(error)
  }
  return json as T
}

// A DELETE carries no body. It still carries the console token: the server
// refuses every write without it.
async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE", headers: tokenHeaders() })
  return writeResult<T>(url, res)
}

// Rotate the console token (Settings). The old token stops working at once, in
// this server and for the grant CLI. This page takes the new one and keeps
// working; any other open console page gets 403 on its next write. The token
// is never returned to the caller.
export async function rotateConsoleToken(): Promise<void> {
  const { token } = await postJson<{ token?: string }>("/api/console-token/rotate", {})
  if (!token) throw new Error("The server did not send the new token. Reload the page.")
  setConsoleToken(token)
}

export async function fetchFindings(): Promise<FindingSummary[]> {
  const data = await getJson<{ findings: FindingSummary[] }>("/api/findings")
  return data.findings
}

// The Findings page's list: the findings, and the candidates beside them.
export async function fetchFindingsAndCandidates(): Promise<{ findings: FindingSummary[]; candidates: CandidateSummary[] }> {
  const data = await getJson<{ findings: FindingSummary[]; candidates?: CandidateSummary[] }>("/api/findings")
  return { findings: data.findings, candidates: data.candidates ?? [] }
}

// `events: false` asks for the finding without its run's transcript
// (`events` is then []). A run's events can be tens of MB.
export function fetchFinding(id: string, { events = true }: { events?: boolean } = {}): Promise<Finding> {
  return getJson<Finding>(`/api/findings/${encodeURIComponent(id)}${events ? "" : "?events=0"}`)
}

// A finding's report as text, built and redacted by the server (report.mjs):
// "md" is the Markdown report, "agent" the short brief for a coding agent.
// Never build these in the browser: the stored record is not redacted.
export async function fetchFindingText(id: string, format: "md" | "agent"): Promise<string> {
  const url = `/api/findings/${encodeURIComponent(id)}/report?format=${format}`
  const res = await fetch(url)
  if (!res.ok) throw new HttpError(url, res.status)
  return res.text()
}

// A finding's replay bundle, asked about before the download (H3c). The server
// builds the zip and answers what it holds (`bundle-check`), or refuses it with
// one sentence (409): a finding that is not proven, an evidence finding, or a
// bundle that would hold a secret it can name.
export type BundleCheck =
  | {
      ok: true
      bytes: number
      // The values the zip could not judge, counted by class. Never a value.
      unjudged: { shape: string; count: number; text: string }[]
      // "Check these before you share the bundle" when `unjudged` has counts.
      note: string | null
      // What the bundle is, in its README's own first words.
      about: string | null
    }
  | { ok: false; error: string }

export async function fetchBundleCheck(id: string): Promise<BundleCheck> {
  const url = `/api/findings/${encodeURIComponent(id)}/report?format=bundle-check`
  const res = await fetch(url)
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.status === 409) return { ok: false, error: typeof json.error === "string" ? json.error : "The server refused this bundle." }
  if (!res.ok) throw new HttpError(url, res.status)
  return {
    ok: true,
    bytes: Number(json.bytes) || 0,
    unjudged: Array.isArray(json.unjudged) ? (json.unjudged as { shape: string; count: number; text: string }[]) : [],
    note: typeof json.note === "string" ? json.note : null,
    about: typeof json.about === "string" ? json.about : null,
  }
}

export const bundleUrl = (id: string) => `/api/findings/${encodeURIComponent(id)}/report?format=bundle`

// ---- Live runs.

export async function fetchModels(): Promise<{
  models: ModelChoice[]
  targets: TargetChoice[]
  packs: PackChoice[]
  spend: SpendState
  provider: ProviderInfo
}> {
  return getJson<{
    models: ModelChoice[]
    targets: TargetChoice[]
    packs: PackChoice[]
    spend: SpendState
    provider: ProviderInfo
  }>("/api/models")
}

// The sentences for a store file that cannot be read (scopes, grants). Empty
// when both are fine. A damaged store lists as empty, so the page must say so.
export async function fetchStoreErrors(): Promise<string[]> {
  const data = await getJson<{ errors: string[] }>("/api/stores")
  return data.errors
}

export async function fetchRuns(): Promise<RunSummary[]> {
  const data = await getJson<{ runs: RunSummary[] }>("/api/runs")
  return data.runs
}

// Start ONE run against a chosen scope, over one module or several. Omit
// targetId to let the server pick a target at random from the library, so
// repeated Runs stop re-breaking one bug. One module goes as `pack`, the old
// shape; several go as `packs`, and the server builds one joined run.
export interface RunStartBody {
  alias: string
  targetId?: string
  budgetUsd?: number
  mode?: RunMode
  pack?: string
  packs?: string[]
}

// The one body of a run start, split out so its shape is testable without a DOM.
// A repeated module is sent once; a list of one is the old `pack`.
export function runStartBody(alias: string, targetId: string | undefined, budgetUsd: number | undefined, modules: string[], mode?: RunMode): RunStartBody {
  const packs = [...new Set(modules)]
  return { alias, targetId, budgetUsd, mode, ...(packs.length > 1 ? { packs } : { pack: packs[0] }) }
}

export function startRun(
  alias: string,
  targetId?: string,
  budgetUsd?: number,
  modules: string[] = [],
  mode?: RunMode,
): Promise<RunView> {
  return postJson<RunView>("/api/runs", runStartBody(alias, targetId, budgetUsd, modules, mode))
}

// One member of a scope: a GitHub repo, or a local folder with its files.
export type ScopeMember =
  | { kind: "repo"; url: string }
  // A folder on this machine, read in place by the server. Needs the console token.
  | { kind: "folder"; name?: string; path: string }
  // The upload fallback: the files themselves.
  | { kind: "folder"; name: string; files: { path: string; content: string }[] }

// One scope per call. `members` is the main shape: repos and folders mixed, in
// any language. The server picks the pack from the content; `pack` is a hint
// that counts only for repos, whose content is not known until the run fetches
// it. The other fields are the older single-member bodies.
export function attachScope(body: {
  title: string
  kind?: "live"
  hosts?: string[]
  permission?: boolean
  // The operator's opt-in for a local lab (loopback or private hosts only).
  allowPrivate?: boolean
  // A live AI/MCP target may carry its own credential and its scopes.
  token?: string
  tokens?: Record<string, { client: string; scopes: string[] }>
  toolScope?: Record<string, string>
  // The assistant's chat path and request budget for garak (ai-mcp only).
  assistant?: { path: string; budget: number }
  members?: ScopeMember[]
  // A live scope takes the list of modules the operator ticked.
  pack?: string | string[]
  repo?: string
  brief?: string
  files?: { path: string; content: string }[]
}): Promise<TargetChoice> {
  return postJson<TargetChoice>("/api/scopes", body)
}

// Set or clear a scope's brief (at most 8,000 characters; the server refuses more
// with a sentence). Every run of the scope gets it in the agent's instructions.
export function saveScopeBrief(id: string, brief: string): Promise<{ id: string; brief: string }> {
  return postJson<{ id: string; brief: string }>(`/api/scopes/${encodeURIComponent(id)}/brief`, { brief })
}

export async function removeScope(id: string): Promise<void> {
  await deleteJson(`/api/scopes/${encodeURIComponent(id)}`)
}

// Message a run. While the agent works, the text is injected into its current
// turn (native pi-durable steering). When the run is idle, the server starts a
// follow-up that reopens the saved session (`followUp: true`). Either way the
// text comes back as an `operator-message` event, with `clientId` as its id.
// Only an archived run refuses.
export function steerRun(id: string, text: string, clientId?: string): Promise<{ ok: true; followUp?: boolean }> {
  return postJson<{ ok: true; followUp?: boolean }>(`/api/runs/${encodeURIComponent(id)}/steer`, { text, id: clientId })
}

// Stop the run's live work: the audit, or a follow-up reply. The run ends as
// stopped; a message continues it from its saved session.
export function stopRun(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/stop`, {})
}

// Archive a run, or bring it back. An archived run takes no more messages.
export function archiveRun(id: string, archived: boolean): Promise<{ ok: true; archived: boolean }> {
  return postJson<{ ok: true; archived: boolean }>(`/api/runs/${encodeURIComponent(id)}/archive`, { archived })
}

// Name a run. An empty name clears it; the run then shows its finding or
// scope title again.
export function renameRun(id: string, name: string): Promise<{ ok: true; name: string | null }> {
  return postJson<{ ok: true; name: string | null }>(`/api/runs/${encodeURIComponent(id)}/rename`, { name })
}

// Delete a run. The server moves its files to a trash folder and drops it from
// the list. Its findings leave the ledger with it. A busy run refuses.
export function deleteRun(id: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/delete`, {})
}

// Ledger override. A proven exploit is recorded automatically; this flips a
// recorded finding to "dismissed" (or restores it). It never re-runs the engine
// and never alters the proof — it only changes how the finding reads.
export function dismissFinding(id: string, dismissed: boolean): Promise<{ id: string; dismissed: boolean }> {
  return postJson<{ id: string; dismissed: boolean }>(
    `/api/findings/${encodeURIComponent(id)}/dismiss`,
    { dismissed },
  )
}

// One run with its full event list, for the first load of a run.
export function fetchRun(id: string): Promise<RunView> {
  return getJson<RunView>(`/api/runs/${encodeURIComponent(id)}`)
}

// Follow a run's event stream from event index `since` on (the events before
// it came from fetchRun). Returns an unsubscribe function. `onEnd` fires once
// when the run closes or the caller unsubscribes.
export function streamRun(id: string, onEvent: (e: RunEvent) => void, since = 0, onEnd?: () => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream?since=${since}`)
  let ended = false
  const end = () => {
    source.close()
    if (ended) return
    ended = true
    onEnd?.()
  }
  source.onmessage = (msg) => {
    let e: RunEvent
    try {
      e = JSON.parse(msg.data) as RunEvent
    } catch {
      return
    }
    onEvent(e)
    if (e.ev === "closed") end()
  }
  // A native reconnect repeats the original since= URL and duplicates live events.
  // The store reloads the authoritative snapshot after this stream ends.
  source.onerror = end
  return end
}

// ---- Settings. Keys go up in a request body and never come back.

export function fetchSettings(): Promise<SettingsState> {
  return getJson<SettingsState>("/api/settings")
}

export function saveProvider(body: {
  id?: string
  label: string
  baseUrl: string
  apiKey?: string
  models?: { id: string; input: string; output: string; context: number | null }[]
}): Promise<SettingsState> {
  return postJson<SettingsState>("/api/settings/providers", body)
}

export function deleteProvider(id: string): Promise<SettingsState> {
  return deleteJson<SettingsState>(`/api/settings/providers/${encodeURIComponent(id)}`)
}

// keyNote: why the provider's key was not sent (another host), or null.
export function discoverModels(body: { id?: string; baseUrl: string; apiKey?: string }): Promise<{ models: DiscoveredModel[]; keyUsed: boolean; keyNote?: string | null }> {
  return postJson<{ models: DiscoveredModel[]; keyUsed: boolean; keyNote?: string | null }>("/api/settings/discover", body)
}

export function setDefaultModel(provider: string, model: string): Promise<SettingsState> {
  return postJson<SettingsState>("/api/settings/default", { provider, model })
}

export function setRunBudget(budgetUsd: number): Promise<SettingsState> {
  return postJson<SettingsState>("/api/settings/budget", { budgetUsd })
}

// Where tool calls run. An empty apiUrl or target clears the saved value.
export function setExecution(body: {
  backend: "local" | "daytona"
  apiKey?: string
  clearKey?: boolean
  apiUrl?: string
  target?: string
}): Promise<SettingsState> {
  return postJson<SettingsState>("/api/settings/execution", body)
}
