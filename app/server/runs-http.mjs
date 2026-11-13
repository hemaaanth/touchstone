// HTTP glue for the live run orchestrator.
//
// Runs need things the findings reader never did: POST bodies and a long-lived
// SSE stream. So this handler takes the raw (req, res) instead of just a URL.
// It returns true when it handled the request, false to fall through to the
// findings router.
import { createRun, steerRun, stopRun, archiveRun, renameRun, deleteRun, getRun, listRuns, subscribe, availableModels, availableTargets, availablePacks, spendState, providerInfo, listScopes, addScope, deleteScope, namesLocalPath } from "./runs.mjs"
import { dismissFinding, getFinding } from "./findings.mjs"
import { buildReport, renderReportHtml, renderReportMarkdown } from "./report.mjs"
import { buildReplayBundle, bundleRefusal, loadRecordedReplay } from "./replay-bundle.mjs"
import { readGrants, addGrant, removeGrant, grantActive, GRANT_TOKEN } from "../../spike/lib/grant-store.mjs"
import { getSettings, saveProvider, deleteProvider, setDefault, setRunBudget, discoverModels, setExecution, settingsWriteRefusal } from "./settings.mjs"

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

  // GET /api/findings/:id/report?format=html|md|json|bundle — the shareable report
  // of a finished run's finding (the finding, its proof, the harm, the fix).
  // json is the structured report the UI renders; html is one self-contained
  // page to share; md is for a README or an issue. bundle is a zip a judge can
  // unzip and rerun: the proof sources, foundry config, proof JSON, and fork
  // parameters, with one command in README.md. The report invents nothing: the
  // fix is shown only when the run stated one (report.mjs).
  const REPORT_FORMATS = new Set(["json", "md", "markdown", "html", "bundle", "zip"])
  if (parts.length === 4 && parts[3] === "report" && req.method === "GET") {
    const id = decodeURIComponent(parts[2])
    const format = (url.searchParams.get("format") || "json").toLowerCase()
    if (!REPORT_FORMATS.has(format)) {
      send(res, 400, { error: `unknown format: use one of ${[...REPORT_FORMATS].join(", ")}` })
      return true
    }
    try {
      const finding = await getFinding(id)
      if (!finding) {
        send(res, 404, { error: "no such finding" })
        return true
      }
      const slug = String(id).replace(/[^\w.-]+/g, "-")
      if (format === "bundle" || format === "zip") {
        const recorded = loadRecordedReplay(id)
        const refused = bundleRefusal({ finding, recorded })
        if (refused) {
          send(res, 409, { error: refused })
          return true
        }
        let zip
        try {
          zip = buildReplayBundle({ finding, recorded })
        } catch (err) {
          // The builder refuses a zip that would leak a secret it cannot mask.
          if (err?.refused !== true) throw err
          send(res, 409, { error: err.message })
          return true
        }
        res.statusCode = 200
        res.setHeader("content-type", "application/zip")
        res.setHeader("content-disposition", `attachment; filename="touchstone-replay-${slug}.zip"`)
        res.end(zip)
      } else if (format === "html") {
        const report = buildReport(finding)
        res.statusCode = 200
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.setHeader("content-disposition", `inline; filename="touchstone-report-${slug}.html"`)
        res.end(renderReportHtml(report))
      } else if (format === "md" || format === "markdown") {
        const report = buildReport(finding)
        res.statusCode = 200
        res.setHeader("content-type", "text/markdown; charset=utf-8")
        res.setHeader("content-disposition", `inline; filename="touchstone-report-${slug}.md"`)
        res.end(renderReportMarkdown(report))
      } else {
        send(res, 200, buildReport(finding))
      }
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
    // A live scope also records the operator's permission to reach real hosts,
    // so it needs the console token, like a Settings write. A web page or the
    // agent cannot add one.
    // This covers the private-lab opt-in (allowPrivate) too: it only acts on
    // the live path, so it can never skip this token check.
    const body = await readBody(req)
    // A local folder path makes the server read this machine's disk, so it
    // needs the token too.
    if (body?.kind === "live" || namesLocalPath(body)) {
      const refusal = settingsWriteRefusal(req)
      if (refusal) {
        send(res, refusal.status, { error: refusal.error })
        return true
      }
    }
    try {
      send(res, 201, addScope({ kind: body.kind, title: body.title, brief: body.brief, blurb: body.blurb, files: body.files, repo: body.repo, members: body.members, pack: body.pack, hosts: body.hosts, permission: body.permission, token: body.token, tokens: body.tokens, toolScope: body.toolScope, assistant: body.assistant, allowPrivate: body.allowPrivate }))
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

// A grant is the operator's written permission to reach a live host, so ADDING
// or REVOKING one must be unforgeable by a web page the operator happens to visit
// AND by the agent itself. Three checks together make it so:
//
//   1. A per-session capability token. Minted once per server process and printed
//      to the server's console (OUTSIDE the HTTP surface, below). Only someone who
//      can see the terminal — the operator — reads it. A cross-origin page cannot
//      read it; the agent child is never handed it (it lives in a module variable,
//      not in process.env, unless a test sets TOUCHSTONE_GRANT_TOKEN).
//   2. Same-origin. A request that carries a foreign Origin is refused, so a
//      visited page cannot drive a mutation even as a no-cors request.
//   3. JSON only. A grant POST must be application/json — a content type a no-cors
//      cross-origin request cannot set without a preflight it is not allowed.
//
// A drive-by page fails all three; the agent fails the token. A test sets
// TOUCHSTONE_GRANT_TOKEN to a known value and skips the console print.
let grantTokenAnnounced = false
function announceGrantToken() {
  if (grantTokenAnnounced || process.env.TOUCHSTONE_GRANT_TOKEN) return
  grantTokenAnnounced = true
  // This line IS where the operator reads the token; it is not a log of a secret
  // held elsewhere. Never sent over HTTP.
  try {
    process.stderr.write(`[grants] to add or revoke a live-reach grant, send header  x-touchstone-grant-token: ${GRANT_TOKEN}\n`)
  } catch {
    /* ignore a closed pipe */
  }
}

// Guard a grant mutation (POST, DELETE). Returns true if the caller may proceed;
// otherwise it has already sent the refusal and returns false. Exported so other
// state-changing console routes can reuse the one forgery defense.
export function grantMutationAllowed(req, res) {
  // Same-origin, fail-closed: an Origin MUST be present and its host MUST equal
  // our Host. A browser always sends Origin on a state-changing (POST/DELETE)
  // request, same-origin or not, so a mutation with no Origin is not the console
  // — it is a non-browser caller or a stripped request, and we refuse it rather
  // than wave it through. A same-origin fetch sends a matching Origin; a
  // cross-origin one sends a foreign Origin (or, for no-cors, cannot set the JSON
  // content-type the POST check below requires either).
  const origin = req.headers["origin"]
  let originHost = null
  try {
    originHost = origin ? new URL(origin).host : null
  } catch {
    originHost = null
  }
  const host = req.headers["host"]
  if (!originHost || !host || originHost !== host) {
    send(res, 403, { error: "a grant can only be changed from the console's own origin (a same-origin request with a matching Origin header)" })
    return false
  }
  // JSON only on POST (DELETE carries no body).
  if (req.method === "POST") {
    const ct = String(req.headers["content-type"] || "")
    if (!/^application\/json\b/i.test(ct)) {
      send(res, 415, { error: "a grant POST must be application/json" })
      return false
    }
  }
  // The capability token, unforgeable by a page or the agent.
  const token = req.headers["x-touchstone-grant-token"]
  if (!token || token !== GRANT_TOKEN) {
    send(res, 403, { error: "a valid x-touchstone-grant-token is required to add or revoke a grant" })
    return false
  }
  return true
}

// Grants — the operator's written permission to reach a live host (grant-store).
// A grant names the hosts in scope, who approved it, and when; it fills the
// scope proxy's allow-list, and a live module refuses to run with no grant for
// its target. A grant never widens what a run may DO — it only names hosts the
// network seam may reach — so this is permission plumbing, never a finding. A
// (req,res) handler because POST takes a body.
//   GET    /api/grants        — list grants, each with a computed `active` flag
//   POST   /api/grants        — add one from { hosts, kind, ownership?, approvedBy?, note?, scopeId?, expiresAt? }
//   DELETE /api/grants/:id     — revoke one
export async function handleGrants(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","grants",...]
  if (parts[0] !== "api" || parts[1] !== "grants") return false
  announceGrantToken()

  if (parts.length === 2 && req.method === "GET") {
    const now = Date.now()
    send(res, 200, { grants: readGrants().map((g) => ({ ...g, active: grantActive(g, now) })) })
    return true
  }

  if (parts.length === 2 && req.method === "POST") {
    if (!grantMutationAllowed(req, res)) return true
    const body = await readBody(req)
    try {
      send(res, 201, addGrant({ hosts: body.hosts, kind: body.kind, ownership: body.ownership, approvedBy: body.approvedBy, note: body.note, scopeId: body.scopeId, expiresAt: body.expiresAt }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  if (parts.length === 3 && req.method === "DELETE") {
    if (!grantMutationAllowed(req, res)) return true
    const id = decodeURIComponent(parts[2])
    if (!removeGrant(id)) {
      send(res, 404, { error: "no such grant" })
      return true
    }
    send(res, 200, { removed: true, id })
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
  const refused = req.method !== "GET" && settingsWriteRefusal(req)
  if (refused) return send(res, refused.status, { error: refused.error }), true
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
