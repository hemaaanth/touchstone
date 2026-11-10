import type {
  Finding,
  FindingSummary,
  ModelChoice,
  ProviderInfo,
  RunEvent,
  RunSummary,
  RunView,
  SpendState,
  TargetChoice,
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
  targets: TargetChoice[]
  spend: SpendState
  provider: ProviderInfo
}> {
  return getJson<{ models: ModelChoice[]; targets: TargetChoice[]; spend: SpendState; provider: ProviderInfo }>(
    "/api/models",
  )
}

export async function fetchRuns(): Promise<RunSummary[]> {
  const data = await getJson<{ runs: RunSummary[] }>("/api/runs")
  return data.runs
}

// Start a run against a chosen scope. Omit targetId to let the server pick a
// target at random from the library, so repeated Runs stop re-breaking one bug.
export function startRun(alias: string, targetId?: string): Promise<RunView> {
  return postJson<RunView>("/api/runs", { alias, targetId })
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

// One run with its full event list, for the first load of a run.
export function fetchRun(id: string): Promise<RunView> {
  return getJson<RunView>(`/api/runs/${encodeURIComponent(id)}`)
}

// Follow a run's event stream from event index `since` on (the events before
// it came from fetchRun). Returns an unsubscribe function. `onEnd` fires once
// when the stream stops, for any reason.
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
  // The server ends the stream after "closed"; any other drop also ends it.
  source.onerror = end
  return end
}
