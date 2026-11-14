// HTTP glue for the live run orchestrator.
//
// Runs need things the findings reader never did: POST bodies and a long-lived
// SSE stream. So this handler takes the raw (req, res) instead of just a URL.
// It returns true when it handled the request, false to fall through to the
// findings router.
import { createRun, steerRun, stopRun, archiveRun, renameRun, deleteRun, getRun, listRuns, subscribe, availableModels, availableTargets, availablePacks, spendState, providerInfo, listScopes, addScope, deleteScope, answerRunAsk, openRunDesktop, closeRunDesktop, runSessionArtifacts } from "./runs.mjs"
import { dismissFinding, getFinding, nowCandidate } from "./findings.mjs"
import { buildReport, renderReportAgent, renderReportHtml, renderReportMarkdown } from "./report.mjs"
import { bundleRefusal, loadRecordedReplay, planReplayBundle, UNJUDGED_NOTE } from "./replay-bundle.mjs"
import { readGrants, addGrant, removeGrant, grantActive } from "../../spike/lib/grant-store.mjs"
import { setScopeBrief } from "../../spike/lib/scopes-store.mjs"
import { getSettings, saveProvider, deleteProvider, setDefault, setRunBudget, discoverModels, setExecution, consoleWriteRefusal } from "./settings.mjs"

function send(res, status, json) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(json))
}

// The console guard (settings.mjs), at the entry of every handler in this file.
// Returns true when it refused the request and sent the answer; the handler
// then does not run. A read (GET) always passes.
function refusedWrite(req, res) {
  const refusal = consoleWriteRefusal(req)
  if (refusal) send(res, refusal.status, { error: refusal.error })
  return Boolean(refusal)
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

// What the bundle is, in its own words: the first paragraph of its README.md.
// The zip is stored, not compressed (replay-bundle.mjs zipStore), and README.md
// is its first entry, so the text is read straight from the first local header.
// Null when the zip does not start that way.
export function readmeHead(zip) {
  if (!Buffer.isBuffer(zip) || zip.length < 30 || zip.readUInt32LE(0) !== 0x04034b50 || zip.readUInt16LE(8) !== 0) return null
  const nameLen = zip.readUInt16LE(26)
  const start = 30 + nameLen + zip.readUInt16LE(28)
  if (zip.toString("utf8", 30, 30 + nameLen) !== "README.md") return null
  const text = zip.toString("utf8", start, Math.min(start + zip.readUInt32LE(18), start + 4096))
  return text.split(/\n\s*\n/)[0].trim() || null
}

export async function handleRuns(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","runs",...]
  if (parts[0] !== "api" || parts[1] !== "runs") return false
  if (refusedWrite(req, res)) return true

  // GET /api/runs — list recent live runs
  if (parts.length === 2 && req.method === "GET") {
    send(res, 200, { runs: listRuns() })
    return true
  }

  // POST /api/runs — start a real agent run. `modules`, when given, is the set of
  // toggleable module ids the operator left on; the orchestrator resolves it
  // against the scope so an unsupported module is off with a reason, not dropped.
  // `packs` is the modules the ONE run covers: two or more build one joined run,
  // one or none is today's single `pack`.
  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 201, await createRun({ alias: body.alias, targetId: body.targetId, modules: body.modules, budgetUsd: body.budgetUsd, pack: body.pack, packs: body.packs, mode: body.mode, freeRoam: body.freeRoam, options: body.options }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  const id = parts[2]

  // Private capabilities, replies, and captured bytes never use unguarded GETs.
  if ((req.method === "POST" && ((parts.length === 4 && ["ask", "desktop", "session-artifacts"].includes(parts[3])) || (parts.length === 6 && parts[3] === "session-artifacts" && ["read", "review", "release"].includes(parts[5])))) || (req.method === "DELETE" && parts.length === 4 && parts[3] === "desktop")) {
    res.setHeader("cache-control", "no-store")
    res.setHeader("x-content-type-options", "nosniff")
    if (["review", "release"].includes(parts[5])) {
      send(res, 409, { error: "Exact-image review and screenshot release are not enabled in this release." })
      return true
    }
    const body = await readBody(req)
    try {
      if (parts[3] === "ask") send(res, 200, await answerRunAsk(id, body))
      else if (parts[3] === "desktop") send(res, 200, req.method === "DELETE" ? await closeRunDesktop(id, body.agent, body.desktop) : await openRunDesktop(id, body.agent, body.viewOnly, req.headers.origin, body.desktop))
      else {
        const action = parts[5] ?? "list"
        const result = await runSessionArtifacts(id, body, action, parts[4])
        if (action !== "read") send(res, 200, result)
        else {
          res.statusCode = 200
          res.setHeader("content-type", result.mime)
          res.setHeader("content-disposition", `attachment; filename="${result.filename}"`)
          res.setHeader("content-length", result.data.length)
          res.end(result.data)
        }
      }
    } catch (err) {
      send(res, Number.isInteger(err?.status) ? err.status : 409, { error: ["ask", "desktop"].includes(parts[3]) ? String(err?.message ?? "Control request failed.") : "Session artifact is not available for this candidate." })
    }
    return true
  }

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
  if (refusedWrite(req, res)) return true
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

  // GET /api/findings/:id/report?format=html|md|json|agent|bundle — the shareable
  // report of a finished run's finding (the finding, its proof, the harm, the
  // fix). json is the structured report the UI renders; html is one
  // self-contained page to share; md is for a README or an issue; agent is a
  // short brief for a coding agent. bundle is a zip a judge can unzip and
  // rerun: the proof sources, foundry config, proof JSON, and fork parameters,
  // with one command in README.md. The report invents nothing: the fix is shown
  // only when the run stated one (report.mjs). bundle-check is the same build
  // as bundle, answered as JSON: the values the zip could not judge, counted by
  // shape, for the line next to the download.
  const REPORT_FORMATS = new Set(["json", "md", "markdown", "html", "agent", "bundle", "zip", "bundle-check"])
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
        send(res, 404, (await nowCandidate(id)) ?? { error: "no such finding" })
        return true
      }
      const slug = String(id).replace(/[^\w.-]+/g, "-")
      if (format === "bundle" || format === "zip" || format === "bundle-check") {
        const recorded = loadRecordedReplay(id)
        const refused = bundleRefusal({ finding, recorded })
        if (refused) {
          send(res, 409, { error: refused })
          return true
        }
        let plan
        try {
          plan = planReplayBundle({ finding, recorded })
        } catch (err) {
          // The builder refuses a zip that would leak a secret it cannot mask.
          if (err?.refused !== true) throw err
          send(res, 409, { error: err.message })
          return true
        }
        const { zip, unjudged } = plan
        if (format === "bundle-check") {
          send(res, 200, { bundle: true, bytes: zip.length, unjudged, note: unjudged.length ? UNJUDGED_NOTE : null, about: readmeHead(zip) })
          return true
        }
        res.statusCode = 200
        // Counts by shape only, never a value. JSON is ASCII here: the texts are fixed.
        res.setHeader("x-touchstone-unjudged", JSON.stringify(unjudged.map(({ shape, count }) => ({ shape, count }))))
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
      } else if (format === "agent") {
        // The short brief for a coding agent (report.mjs renderReportAgent).
        res.statusCode = 200
        res.setHeader("content-type", "text/plain; charset=utf-8")
        res.end(renderReportAgent(buildReport(finding)))
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
//   POST   /api/scopes/:id/brief — set or clear its brief ({ brief }); text for
//                                the model only, it changes no reach or grant
export async function handleScopes(req, res) {
  const url = new URL(req.url, "http://localhost")
  const parts = url.pathname.split("/").filter(Boolean) // ["api","scopes",...]
  if (parts[0] !== "api" || parts[1] !== "scopes") return false
  if (refusedWrite(req, res)) return true

  if (parts.length === 2 && req.method === "GET") {
    send(res, 200, { scopes: listScopes() })
    return true
  }

  if (parts.length === 2 && req.method === "POST") {
    // Every scope create passed the console guard above. A live scope records
    // the operator's permission to reach real hosts, and a local folder path
    // makes the server read this machine's disk. A web page or the agent
    // cannot add either.
    const body = await readBody(req)
    try {
      send(res, 201, addScope({ kind: body.kind, title: body.title, brief: body.brief, blurb: body.blurb, files: body.files, repo: body.repo, members: body.members, pack: body.pack, hosts: body.hosts, permission: body.permission, token: body.token, tokens: body.tokens, toolScope: body.toolScope, assistant: body.assistant, allowPrivate: body.allowPrivate }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  if (parts.length === 4 && parts[3] === "brief" && req.method === "POST") {
    const body = await readBody(req)
    try {
      // A body that did not parse reads as {}. It must not clear the brief.
      if (typeof body.brief !== "string") throw new Error("Send the brief as text: { brief }. An empty text clears it.")
      const scope = setScopeBrief(decodeURIComponent(parts[2]), body.brief)
      send(res, 200, { id: scope.id, brief: scope.brief ?? "" })
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
// AND by the agent itself. The console guard (settings.mjs) makes it so: the
// console token, the same origin, and JSON only. The token is never printed.

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
  if (refusedWrite(req, res)) return true

  if (parts.length === 2 && req.method === "GET") {
    const now = Date.now()
    send(res, 200, { grants: readGrants().map((g) => ({ ...g, active: grantActive(g, now) })) })
    return true
  }

  if (parts.length === 2 && req.method === "POST") {
    const body = await readBody(req)
    try {
      send(res, 201, addGrant({ hosts: body.hosts, kind: body.kind, ownership: body.ownership, approvedBy: body.approvedBy, note: body.note, scopeId: body.scopeId, expiresAt: body.expiresAt }))
    } catch (err) {
      send(res, 400, { error: String(err?.message ?? err) })
    }
    return true
  }

  if (parts.length === 3 && req.method === "DELETE") {
    const id = decodeURIComponent(parts[2])
    let removed
    try {
      removed = removeGrant(id)
    } catch (err) {
      // A store refusal (busy, damaged, a bad lock path): its sentence, as the other store routes give it.
      send(res, 400, { error: String(err?.message ?? err) })
      return true
    }
    if (!removed) {
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
  if (refusedWrite(req, res)) return true
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
