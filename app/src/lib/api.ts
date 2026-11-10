import type {
  Finding,
  FindingSummary,
  ModelChoice,
  ProviderInfo,
  RunEvent,
  RunSummary,
  RunView,
  SpendState,
} from "./types"

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return (await res.json()) as T
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${url} -> ${res.status}`)
  return json as T
}

export async function fetchFindings(): Promise<FindingSummary[]> {
  const data = await getJson<{ findings: FindingSummary[] }>("/api/findings")
  return data.findings
}

export function fetchFinding(id: string): Promise<Finding> {
  return getJson<Finding>(`/api/findings/${encodeURIComponent(id)}`)
}

// ---- Live runs.

export async function fetchModels(): Promise<{
  models: ModelChoice[]
  spend: SpendState
  provider: ProviderInfo
}> {
  return getJson<{ models: ModelChoice[]; spend: SpendState; provider: ProviderInfo }>("/api/models")
}

export async function fetchRuns(): Promise<RunSummary[]> {
  const data = await getJson<{ runs: RunSummary[] }>("/api/runs")
  return data.runs
}

export function startRun(alias: string): Promise<RunView> {
  return postJson<RunView>("/api/runs", { alias })
}

// Steer a run that is in flight. The text is injected into the agent's current
// turn (native pi-durable steering, whenBusy:"steer") and echoed back as an
// `operator-message` event so it lands in the transcript. Only valid while the
// run is still "running"; the server rejects a steer once the agent has settled.
export function steerRun(id: string, text: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/runs/${encodeURIComponent(id)}/steer`, { text })
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

// Subscribe to a run's live event stream. Returns an unsubscribe function. The
// server replays everything already seen on connect, so a subscriber attached
// at any time catches up and then follows live.
export function streamRun(id: string, onEvent: (e: RunEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`)
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as RunEvent)
    } catch {
      /* ignore a torn frame */
    }
  }
  // The server closes the stream with a "closed" event; also stop on error.
  source.onerror = () => source.close()
  return () => source.close()
}
