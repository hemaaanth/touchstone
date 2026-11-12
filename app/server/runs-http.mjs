// HTTP glue for the live run orchestrator.
//
// Runs need things the findings reader never did: POST bodies and a long-lived
// SSE stream. So this handler takes the raw (req, res) instead of just a URL.
// It returns true when it handled the request, false to fall through to the
// findings router.
import { createRun, steerRun, stopRun, archiveRun, renameRun, deleteRun, getRun, listRuns, subscribe, availableModels, availableTargets, availablePacks, spendState, providerInfo, listScopes, addScope, deleteScope } from "./runs.mjs"
import { dismissFinding } from "./findings.mjs"
import { getSettings, saveProvider, deleteProvider, setDefault, setRunBudget, discoverModels, setExecution, settingsWriteAllowed } from "./settings.mjs"

function send(res, status, json) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(json))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (d) => {
      raw += d
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) req.destroy()
    })
    req.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

export async function handleRuns(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","runs",...]
  if (parts[0] !== "api" || parts[1] !== "runs") return false

  // GET /api/runs — list recent live runs
  if (parts.length === 2 && req.method === "GET") {
    send(res, 200, { runs: listRuns() })
    return true
  }

  // POST /api/runs — start a real agent run. `modules`, when given, is the set of
  // toggleable module ids the operator left on; the orchestrator resolves it
  // against the scope so an unsupported module is off with a reason, not dropped.
  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 201, await createRun({ alias: body.alias, targetId: body.targetId, modules: body.modules, budgetUsd: body.budgetUsd, pack: body.pack, mode: body.mode }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  const id = parts[2]

  // GET /api/runs/:id/stream — Server-Sent Events, live + replayed
  if (parts.length === 4 && parts[3] === "stream" && req.method === "GET") {
    if (!getRun(id)) {
      send(res, 404, { error: "no such run" })
      return true
    }
    res.statusCode = 200
    res.setHeader("content-type", "text/event-stream")
    res.setHeader("cache-control", "no-cache")
    res.setHeader("connection", "keep-alive")
    res.flushHeaders?.()
    const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    // `since=N`: the client already loaded the first N events as a snapshot.
    const since = Math.max(0, Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0)
    const unsubscribe = subscribe(id, write, since)
    // Heartbeat so idle proxies (the bb Connect tunnel) keep the stream open.
    const beat = setInterval(() => res.write(": beat\n\n"), 15000)
    const close = () => {
      clearInterval(beat)
      unsubscribe?.()
    }
    req.on("close", close)
    res.on("close", close)
    return true
  }

  // POST /api/runs/:id/steer — message the agent: steer a live turn, or start a follow-up
  if (parts.length === 4 && parts[3] === "steer" && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 200, steerRun(id, body.text, body.id))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // POST /api/runs/:id/stop — stop the run's live work (the audit or a reply)
  if (parts.length === 4 && parts[3] === "stop" && req.method === "POST") {
    try {
      send(res, 200, stopRun(id))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // POST /api/runs/:id/archive — archive a run ({archived:true}) or restore it
  if (parts.length === 4 && parts[3] === "archive" && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 200, archiveRun(id, body.archived !== false))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // POST /api/runs/:id/rename — set the run's name ({name}); empty clears it
  if (parts.length === 4 && parts[3] === "rename" && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 200, renameRun(id, body.name))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // POST /api/runs/:id/delete — move the run's files to trash and drop it
  if (parts.length === 4 && parts[3] === "delete" && req.method === "POST") {
    try {
      send(res, 200, deleteRun(id))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // GET /api/runs/:id — run detail (events + state)
  if (parts.length === 3 && req.method === "GET") {
    const run = getRun(id)
    if (!run) {
      send(res, 404, { error: "no such run" })
      return true
    }
    send(res, 200, run)
    return true
  }

  return false
}

// POST /api/findings/:id/dismiss — mark a recorded finding dismissed / restored.
// A (req,res) handler because it takes a body; the findings reader is URL-only.
export async function handleFindings(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","findings",id,"dismiss"]
  if (parts[0] !== "api" || parts[1] !== "findings") return false
  if (parts.length === 4 && parts[3] === "dismiss" && req.method === "POST") {
    const id = decodeURIComponent(parts[2])
    const body = await readBody(req)
    try {
      send(res, 200, await dismissFinding(id, Boolean(body.dismissed)))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }
  return false
}

// Operator-configured scopes (briefs). A (req,res) handler because POST takes a
// body. Returns true when it handled the request.
//   GET    /api/scopes        — list the operator's scopes (summaries)
//   POST   /api/scopes        — add one from { title, members, pack? } (repos and
//                                folders, mixed), or a legacy { title, files },
//                                { title, repo }, or { title, brief, blurb }
//   DELETE /api/scopes/:id     — remove one
export async function handleScopes(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","scopes",...]
  if (parts[0] !== "api" || parts[1] !== "scopes") return false

  if (parts.length === 2 && req.method === "GET") {
    send(res, 200, { scopes: listScopes() })
    return true
  }

  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 201, addScope({ title: body.title, brief: body.brief, blurb: body.blurb, files: body.files, repo: body.repo, members: body.members, pack: body.pack }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  if (parts.length === 3 && req.method === "DELETE") {
    const id = decodeURIComponent(parts[2])
    try {
      send(res, 200, deleteScope(id))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  return false
}

// GET /api/models — which models the UI may run, and the live spend ledger.
export function handleModels(req, res) {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname !== "/api/models" || req.method !== "GET") return false
  send(res, 200, { models: availableModels(), targets: availableTargets(), packs: availablePacks(), spend: spendState(), provider: providerInfo() })
  return true
}

// Settings. API keys go in, never out: responses carry only a masked key state.
//   GET    /api/settings                   — providers, default, spend
//   POST   /api/settings/providers         — add or update { id?, label, baseUrl, apiKey?, models? }
//   DELETE /api/settings/providers/:id     — remove a saved provider
//   POST   /api/settings/discover          — list a gateway's models { id?, baseUrl?, apiKey? }
//   POST   /api/settings/default           — { provider, model } for new runs
//   POST   /api/settings/budget            — { budgetUsd } default per-run budget
//   POST   /api/settings/execution         — { backend, apiKey?, clearKey? } where tools run
export async function handleSettings(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts[0] !== "api" || parts[1] !== "settings") return false
  const route = `${req.method} ${parts.slice(2, 3).join("/")}`
  // Every write is guarded: a cross-site page must not repoint a key or a baseUrl.
  if (req.method !== "GET" && !settingsWriteAllowed(req)) return send(res, 403, { error: "cross-site settings write refused" }), true
  try {
    if (parts.length === 2 && req.method === "GET") return send(res, 200, getSettings()), true
    if (parts.length === 3 && route === "POST providers") return send(res, 200, saveProvider(await readBody(req))), true
    if (parts.length === 4 && route === "DELETE providers") return send(res, 200, deleteProvider(decodeURIComponent(parts[3]))), true
    if (parts.length === 3 && route === "POST discover") return send(res, 200, await discoverModels(await readBody(req))), true
    if (parts.length === 3 && route === "POST default") return send(res, 200, setDefault(await readBody(req))), true
    if (parts.length === 3 && route === "POST budget") return send(res, 200, setRunBudget((await readBody(req)).budgetUsd)), true
    if (parts.length === 3 && route === "POST execution") return send(res, 200, setExecution(await readBody(req))), true
  } catch (err) {
    send(res, 400, { error: String(err?.message ?? err) })
    return true
  }
  return false
}
