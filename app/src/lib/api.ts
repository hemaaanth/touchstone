import type {
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
import { tokenHeaders } from "./console-token"

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
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${url} -> ${res.status}`)
  return json as T
}

// A DELETE carries no body. It still carries the console token: the server
// refuses every write without it.
async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE", headers: tokenHeaders() })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${url} -> ${res.status}`)
  return json as T
}

export async function fetchFindings(): Promise<FindingSummary[]> {
  const data = await getJson<{ findings: FindingSummary[] }>("/api/findings")
  return data.findings
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

export async function fetchRuns(): Promise<RunSummary[]> {
  const data = await getJson<{ runs: RunSummary[] }>("/api/runs")
  return data.runs
}

// Start a run against a chosen scope. Omit targetId to let the server pick a
// target at random from the library, so repeated Runs stop re-breaking one bug.
export function startRun(
  alias: string,
  targetId?: string,
  budgetUsd?: number,
  pack?: string,
  mode?: RunMode,
): Promise<RunView> {
  return postJson<RunView>("/api/runs", { alias, targetId, budgetUsd, pack, mode })
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
