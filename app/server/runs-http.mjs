// HTTP glue for the live run orchestrator.
//
// Runs need things the findings reader never did: POST bodies and a long-lived
// SSE stream. So this handler takes the raw (req, res) instead of just a URL.
// It returns true when it handled the request, false to fall through to the
// findings router.
import { createRun, decideRun, steerRun, getRun, listRuns, subscribe, availableModels, availableTargets, spendState, providerInfo, listScopes, addScope, deleteScope } from "./runs.mjs"
import { dismissFinding } from "./findings.mjs"

function send(res, status, json) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(json))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
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
      send(res, 201, createRun({ alias: body.alias, targetId: body.targetId, modules: body.modules }))
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
    const unsubscribe = subscribe(id, write)
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

  // POST /api/runs/:id/decision — approve or deny the pending finding
  if (parts.length === 4 && parts[3] === "decision" && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 200, decideRun(id, body.verdict))
    } catch (err) {
      send(res, 409, { error: String(err?.message ?? err) })
    }
    return true
  }

  // POST /api/runs/:id/steer — inject an operator message into the live turn
  if (parts.length === 4 && parts[3] === "steer" && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 200, steerRun(id, body.text))
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
//   GET    /api/scopes        — list the operator's brief scopes (summaries)
//   POST   /api/scopes        — add one from { title, brief, blurb }
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
      send(res, 201, addScope({ title: body.title, brief: body.brief, blurb: body.blurb }))
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
  send(res, 200, { models: availableModels(), targets: availableTargets(), spend: spendState(), provider: providerInfo() })
  return true
}
