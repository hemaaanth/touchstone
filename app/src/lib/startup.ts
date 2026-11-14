import type { RunEvent } from "./types"

// What the run is doing before the agent session opens: the pack's tool scan
// and its setup. Each pack sends its own events while it scans, so this reads
// them by shape. It only shows what an event said. It never guesses a tool
// that has not reported.

export type StartState = "running" | "done" | "failed" | "unavailable"

export interface StartStage {
  key: string
  label: string
  state: StartState
  detail?: string
}

export interface StartProgress {
  stages: StartStage[]
  // Tools that reported, and how many of them ran.
  tools: number
  ran: number
  // Leads found so far. Null until a tool reports a count.
  leads: number | null
  // Until the final prepass event, these are reports so far, not whole-run coverage.
  partial: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
const RAN = new Set(["ok", "ran"])

// "zap:ok:3" → one tool. A tool error is not a clean result: it does not count as ran.
function coverage(v: unknown) {
  return names(v).map((c) => {
    const [engine, status, leads] = c.split(":")
    return { engine, ran: RAN.has(status), leads: Number(leads) || 0 }
  })
}

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

export function startProgress(events: RunEvent[]): StartProgress {
  const stages: StartStage[] = []
  const tools = new Map<string, boolean>() // engine → ran
  const leadCounts = new Map<string, number>()
  const joined = events.some((e) => e.ev === "packs" && Array.isArray(e.packs) && e.packs.length > 1)
  let toolsTotal: number | null = null
  let toolsRan: number | null = null
  let leads: number | null = null
  let summary = false
  let opened = false

  const put = (stage: StartStage) => {
    const at = stages.findIndex((s) => s.key === stage.key)
    if (at === -1) stages.push(stage)
    else stages[at] = { ...stages[at], ...stage }
  }
  const reportLeads = (key: string, n: number | null) => {
    if (n == null) return
    leadCounts.set(key, n)
    let total = 0
    for (const count of leadCounts.values()) total += count
    leads = total
  }
  const ranTool = (engine: string, ran: boolean) => {
    if (engine) tools.set(engine, (tools.get(engine) ?? false) || ran)
  }

  for (const e of events) {
    if (opened) break
    const ev = str(e.ev)
    const pack = joined ? str(e.pack) || ev.split("-")[0] : ""
    const scanKey = pack ? `${pack}:scan` : "scan"
    const captureKey = pack ? `${pack}:capture` : "capture"
    const scanLabel = pack ? `${pack} tool scan` : "Tool scan"
    if (ev === "opened") {
      opened = true
      break
    }
    if (ev === "prepass") {
      // The server's one summary of the whole scan. It is the final word on
      // the counts, so it replaces what the pack events added up to.
      summary = true
      tools.clear()
      for (const t of Array.isArray(e.tools) ? e.tools : []) {
        const o = t as { name?: unknown; status?: unknown; pack?: unknown }
        ranTool(`${str(o.pack)}:${str(o.name)}`, o.status === "ran")
      }
      const total = num(e.toolsTotal)
      const ran = num(e.toolsRan)
      if (total != null && ran != null && Number.isInteger(total) && Number.isInteger(ran) && total >= 0 && total <= 1000 && ran >= 0 && ran <= total) {
        toolsTotal = total
        toolsRan = ran
      }
      leads = num(e.total) ?? 0
      for (const s of stages) if (s.state === "running") s.state = "done"
      if (e.failed) put({ key: "scan", label: "Tool scan", state: "failed", detail: "The scan did not finish." })
      continue
    }
    if (ev === "module-prepass") {
      for (const key of tools.keys()) if (key.startsWith(`${pack}:`)) tools.delete(key)
      for (const key of leadCounts.keys()) if (key === pack || key.startsWith(`${pack}:`)) leadCounts.delete(key)
      const reported = Array.isArray(e.tools) ? e.tools as { name?: unknown; status?: unknown }[] : []
      for (const t of reported) ranTool(`${pack}:${str(t.name)}`, t.status === "ran")
      reportLeads(pack, num(e.total))
      const ran = reported.filter((t) => t.status === "ran").length
      put({ key: scanKey, label: scanLabel, state: e.failed || (reported.length > 0 && !ran) ? "failed" : "done", detail: `${ran} of ${plural(reported.length, "tool")} ran · ${plural(num(e.total) ?? 0, "lead")}` })
      for (const s of stages) if (s.key === captureKey) s.state = "done"
    } else if (ev.endsWith("-lab-started")) {
      put({ key: "target", label: "Started the lab", state: "done" })
    } else if (ev.endsWith("-live-target")) {
      const h = host(str(e.baseUrl))
      put({ key: "target", label: "Bound the live target", state: "done", detail: h || undefined })
    } else if (ev.endsWith("-capture-start")) {
      put({ key: captureKey, label: pack ? `${pack} domain capture` : "Capturing the domain", state: "running", detail: str(e.domain) || undefined })
    } else if (ev.endsWith("-scan-started")) {
      const list = names(e.engines)
      put({ key: scanKey, label: pack ? `${pack} tool scan` : "Running the tool scan", state: "running", detail: list.join(", ") || undefined })
    } else if (ev.endsWith("-scan-failed")) {
      // The error text can hold a secret, so only the fact shows.
      put({ key: scanKey, label: scanLabel, state: "failed", detail: "The scan stopped with an error." })
    } else if (ev.endsWith("-scan-done")) {
      const cov = coverage(e.coverage)
      for (const c of cov) ranTool(`${pack}:${c.engine}`, c.ran)
      reportLeads(pack, num(e.leads))
      const ran = cov.filter((c) => c.ran).length
      put({
        key: scanKey,
        label: scanLabel,
        state: cov.length && !ran ? "failed" : "done",
        detail: `${cov.length ? `${ran} of ${plural(cov.length, "tool")} ran · ` : ""}${plural(num(e.leads) ?? 0, "lead")}`,
      })
    } else if (ev.endsWith("-strix-started")) {
      const turns = num(e.turns)
      put({ key: "strix", label: "Strix is exploring the site", state: "running", detail: turns ? `up to ${plural(turns, "turn")}` : undefined })
    } else if (ev.endsWith("-strix-done")) {
      // A scan stopped at its turn cap or time limit still ran, and its leads
      // are kept: it is done, with the stop as a note beside the lead count.
      const status = str(e.status)
      const ok = status === "ran" || status === "ok" || status === "timed-out"
      const stop = status === "timed-out" ? str(e.reason).split(";")[0] || "stopped at its time limit" : ""
      put({
        key: "strix",
        label: "Strix",
        state: ok ? "done" : "unavailable",
        detail: ok ? [plural(num(e.leads) ?? 0, "lead"), stop].filter(Boolean).join(" · ") : str(e.reason) || undefined,
      })
    } else if (ev.endsWith("-strix-failed")) {
      put({ key: "strix", label: "Strix", state: "failed", detail: "Strix stopped with an error." })
    } else if (ev === "static-scan" || ev === "fuzz-scan") {
      const list = names(e.engines)
      const n = num(e.suspects) ?? (Array.isArray(e.findings) ? e.findings.length : null)
      for (const t of list) ranTool(`${pack}:${t}`, true)
      reportLeads(`${pack}:${ev}`, n)
      put({
        key: ev,
        label: ev === "static-scan" ? "Static analysis" : "Property fuzzing",
        state: "done",
        detail: [list.join(" + "), n != null ? plural(n, "lead") : ""].filter(Boolean).join(" · ") || undefined,
      })
    } else if (ev === "chain-scan") {
      const list = names(e.engines)
      for (const t of list) ranTool(`${pack}:${t}`, true)
      reportLeads(`${pack}:${ev}`, num(e.suspects))
      put({
        key: ev,
        label: "Chain scan",
        state: "done",
        detail: [list.join(" + "), plural(num(e.suspects) ?? 0, "lead")].filter(Boolean).join(" · "),
      })
    } else if (ev.endsWith("-prepass-done") || ev.endsWith("-prepass")) {
      for (const c of coverage(e.coverage)) ranTool(`${pack}:${c.engine}`, c.ran)
      reportLeads(pack, num(e.leads))
      for (const s of stages) if (s.key === captureKey) s.state = "done"
      put({ key: scanKey, label: scanLabel, state: "done", detail: plural(num(e.leads) ?? 0, "lead") })
    }
  }

  // The last row is what the run waits on now. Before the server's summary it
  // is the scan, unless a pack event already shows a running stage. After it,
  // the agent session is starting.
  if (!opened) {
    if (!summary) {
      if (!stages.some((s) => s.state === "running") && !stages.some((s) => s.key === "scan" || s.key.endsWith(":scan")))
        stages.push({ key: "scan", label: "Running the tool scan", state: "running" })
    } else {
      stages.push({ key: "session", label: "Starting the agent session", state: "running" })
    }
  }

  return { stages, tools: toolsTotal ?? tools.size, ran: toolsRan ?? [...tools.values()].filter(Boolean).length, leads, partial: !summary }
}
