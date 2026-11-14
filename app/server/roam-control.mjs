import { randomBytes, randomUUID } from "node:crypto"
import { redactSecrets } from "./redact.mjs"

const ID = /^[A-Za-z0-9_-]{1,128}$/
const KINDS = new Set(["question", "test-account", "wallet-fund", "wallet-spend", "email-send", "login", "payment", "sign-transaction", "takeover"])
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const closed = () => ({ kind: "closed" })

export function roamSelection(freeRoam, options = [], mode = "fleet") {
  if (freeRoam === undefined) freeRoam = mode === "fleet"
  if (typeof freeRoam !== "boolean" || !Array.isArray(options) || options.length !== 0) throw fail("Wallet and email capabilities are not available.", 400)
  if (freeRoam && mode !== "fleet") throw fail("Free-roam requires a fleet.", 400)
  return { freeRoam, options: [...options] }
}

function askPresentation(kind, value) {
  if (kind !== "question" || !value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 16384 || Object.keys(value).some((k) => !["options", "select", "min", "max"].includes(k))) return undefined
    const { options, select = "single", min = 1, max = options?.length } = value
    if (!Array.isArray(options) || options.length < 2 || options.length > 12 || !["single", "multiple"].includes(select)) return undefined
    if (select === "single" && ("min" in value || "max" in value)) return undefined
    if (select === "multiple" && (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > options.length)) return undefined
    const seen = new Set()
    const clean = []
    for (const option of options) {
      if (!option || typeof option !== "object" || Array.isArray(option) || Object.keys(option).some((k) => !["id", "label", "description"].includes(k))) return undefined
      if (typeof option.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(option.id) || seen.has(option.id)) return undefined
      if (typeof option.label !== "string" || !option.label.trim() || option.label.trim().length > 200 || ("description" in option && (typeof option.description !== "string" || option.description.length > 500))) return undefined
      seen.add(option.id)
      const label = redactSecrets(option.label.trim()).trim()
      const description = "description" in option ? redactSecrets(option.description) : undefined
      if (!label || label.length > 200 || (description !== undefined && description.length > 500)) return undefined
      clean.push({ id: option.id, label, ...(description !== undefined ? { description } : {}) })
    }
    const presentation = { options: clean, select, ...(select === "multiple" ? { min, max } : {}) }
    return Buffer.byteLength(JSON.stringify(presentation)) <= 16384 ? presentation : undefined
  } catch {
    return undefined
  }
}

// Capabilities and pending replies stay only in this process, never in run records.
export function createRoamControlApi({ getRun, emit, machine, timeoutMs = 15000, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  const workers = new Map()
  const desktops = new Map()
  const identityOf = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["id", "epoch"].includes(key)) || typeof value.id !== "string" || !ID.test(value.id) || ("epoch" in value && (typeof value.epoch !== "string" || !ID.test(value.epoch)))) throw fail("A desktop request identity is required.", 400)
    return value
  }
  const desktopKey = (id, agent, identity) => JSON.stringify([id, agent, identity.id])
  const state = (run) => workers.get(run.id)
  const active = (id, expected) => {
    const run = getRun(id)
    const s = run && state(run)
    if (!run) throw fail("No such run.", 404)
    if (!run.owner) throw fail("This server does not own this run.")
    if (s?.retired || (expected && s !== expected) || run.stopping || run.archived || !run.child?.stdin?.writable || !s || s.child !== run.child || s.epoch !== run.roamEpoch || (run.status !== "running" && !run.replying)) throw fail("This worker is no longer available.")
    return { run, s }
  }
  const agentOf = (run, agent) => {
    if (typeof agent !== "string" || !ID.test(agent)) throw fail("Invalid agent.", 400)
    const spawned = run.events.findLast((e) => e.ev === "subagent-spawned" && e.id === agent)
    if (!spawned || spawned.loadout !== "free-roam") throw fail("No free-roam agent.")
    return agent
  }
  const pending = (s, key, match, payload) => new Promise((resolve, reject) => {
    const timer = schedule(() => { s.pending.delete(key); reject(fail("Worker acknowledgement timed out. Automation state is unknown; keep human input disabled.")) }, timeoutMs)
    s.pending.set(key, { match, resolve: (value) => { unschedule(timer); s.pending.delete(key); resolve(value) }, reject: (error) => { unschedule(timer); s.pending.delete(key); reject(error) } })
    try { s.child.stdin.write(JSON.stringify(payload) + "\n", (error) => { if (error) s.pending.get(key)?.reject(fail("Worker pipe closed.")) }) } catch { s.pending.get(key)?.reject(fail("Worker pipe closed.")) }
  })
  const gate = async (run, s, agent, op, lease = null) => {
    active(run.id, s)
    const id = randomUUID()
    const e = await pending(s, id, (e) => e.ev === "roam-control" && e.id === id && e.epoch === s.epoch && e.agent === agent && e.op === op && e.lease === lease, { roamControl: { id, epoch: s.epoch, agent, op, lease } })
    active(run.id, s)
    if (e.ok !== true || e.state !== (op === "pause" ? "paused" : op === "cancel" ? "closed" : "running")) throw fail("Worker did not acknowledge the requested automation state.")
  }
  const request = async (m, input) => {
    try { return await m.request(Buffer.from(JSON.stringify(input))) } catch { throw fail("Desktop runtime request failed.") }
  }
  const cleanDesktop = (d) => {
    unschedule(d.timer)
    d.view = closed()
    return d.cleanup ??= (async () => {
      const results = await Promise.allSettled([request(d.machine, { action: "close" }).then((r) => { if (r?.kind !== "closed") throw fail("Desktop did not close.") }), d.grant ? d.machine.expirePreview(d.port, d.grant.revokeToken) : Promise.resolve()])
      if (results.some((r) => r.status === "rejected")) {
        d.failed = true
        throw fail("Desktop cleanup failed. Automation remains blocked.")
      }
    })()
  }
  const closeAgent = async (run, s, agent, announce = true) => {
    const d = s.desktops.get(agent)
    if (!d) return closed()
    if (announce) emit(run, { ev: "desktop-view", agent, state: "closed" })
    await cleanDesktop(d)
    active(run.id, s)
    if (d.failed || (d.lease && !d.paused)) throw fail("Automation remains blocked. Stop this run.")
    if (d.paused) {
      try { await gate(run, s, agent, "resume", d.lease) }
      catch {
        d.failed = true
        // A lost resume acknowledgment must not leave admission open.
        await gate(run, s, agent, "cancel", d.lease).catch(() => {})
        throw fail("Automation remains blocked. Stop this run.")
      }
    }
    s.desktops.delete(agent)
    return closed()
  }
  const serial = (s, agent, fn, scope) => {
    if (s.operations.has(agent)) return Promise.reject(fail("A desktop change is already pending."))
    const op = { cancelled: false, promise: null, scope }
    s.operations.set(agent, op)
    op.promise = Promise.resolve().then(() => fn(op)).finally(() => { s.operations.delete(agent) })
    return op.promise
  }
  async function desktop(id, agent, viewOnly, origin, identity) {
    const { run, s } = active(id)
    agentOf(run, agent)
    if (typeof viewOnly !== "boolean") throw fail("Choose Watch or Take control.", 400)
    let appOrigin
    try { appOrigin = new URL(origin); if (appOrigin.origin !== origin || appOrigin.protocol !== "https:") throw 0 } catch { throw fail("Desktop access requires the console's HTTPS origin.", 400) }
    if (s.closing.has(agent)) throw fail("A desktop change is already pending.")
    identity = identityOf(identity)
    const key = desktopKey(id, agent, identity)
    let scope = desktops.get(key)
    if (scope?.closed) throw fail("This desktop request is retired.")
    if ((scope && scope.s !== s) || (identity.epoch !== undefined && identity.epoch !== s.epoch)) throw fail("This desktop belongs to a different worker.")
    if (!scope) {
      scope = { id: identity.id, epoch: s.epoch, s, closed: false, closing: null }
      desktops.set(key, scope)
      s.scopes.add(scope)
    }
    return serial(s, agent, async (op) => {
      let d
      const current = () => {
        active(id, s)
        if (scope.closed || op.cancelled || (d?.expires && d.expires <= now())) throw fail("Desktop request was cancelled.")
      }
      current()
      const old = s.desktops.get(agent)
      if (old && old.scope !== scope) throw fail(old.failed ? "Automation remains blocked. Stop this run." : "Another desktop session is active. Release it first.")
      if (!viewOnly && (!old || old.view.kind !== "open" || !old.view.viewOnly || old.view.expires <= now())) throw fail("Open Watch before taking control.")
      const watched = old?.machine.id
      if (old) { await closeAgent(run, s, agent, false); current() }
      // Status checks the current trusted board. It never grants pause ownership.
      if (viewOnly) { await gate(run, s, agent, "status"); current() }
      let m
      try { m = await machine(run.ws, agent) } catch { throw fail("Desktop adapter is unavailable.") }
      current()
      if (!m) throw fail("This agent has no available desktop.")
      if (!viewOnly && m.id !== watched) throw fail("The watched machine is no longer available.")
      d = { scope, machine: m, view: closed(), port: null, grant: null, lease: viewOnly ? null : randomUUID(), paused: false, failed: false, timer: null, expires: null, cleanup: null }
      s.desktops.set(agent, d)
      const expireAt = (expires) => {
        unschedule(d.timer)
        d.expires = expires
        d.timer = schedule(async () => {
          try { if (s.desktops.get(agent) === d) await closeOwned(run, s, agent, scope) }
          catch { /* Invalidation may retire the worker before this timer runs. */ }
        }, Math.max(0, expires - now()))
        d.timer?.unref?.()
      }
      try {
        if (d.lease) {
          await gate(run, s, agent, "pause", d.lease)
          d.paused = true
          current()
        }
        const configured = await request(m, { action: "configure" })
        current()
        if (configured?.kind !== "configured" || !Number.isInteger(configured.port) || configured.port < 1 || configured.port > 65535 || !Number.isFinite(configured.expires) || configured.expires <= now() || configured.expires > now() + 900000) throw fail("Desktop runtime is not configured.")
        d.port = configured.port
        expireAt(configured.expires)
        const seconds = Math.min(900, Math.floor((configured.expires - now()) / 1000))
        if (seconds < 1) throw fail("Desktop grant expired.")
        d.grant = await m.previewGrant(d.port, seconds)
        current()
        const preview = new URL(d.grant.url)
        if (preview.protocol !== "https:" || preview.username || preview.password || preview.hash || preview.search || preview.pathname !== "/" || !Number.isFinite(d.grant.expires) || d.grant.expires <= now() || d.grant.expires > configured.expires || typeof d.grant.revokeToken !== "string" || !d.grant.revokeToken) throw fail("Invalid signed desktop grant.")
        expireAt(d.grant.expires)
        const token = randomBytes(32).toString("base64url")
        const opened = await request(m, { action: "open", previewOrigin: preview.origin, appOrigins: [appOrigin.origin], token, viewOnly })
        current()
        if (opened?.kind !== "open" || opened.port !== d.port || opened.viewOnly !== viewOnly || opened.expires !== configured.expires) throw fail("Desktop runtime did not open.")
        const expires = Math.min(configured.expires, d.grant.expires)
        d.view = { kind: "open", agent, viewOnly, expires, desktop: { id: scope.id, epoch: scope.epoch }, url: `${preview.origin}/#${token}&parentOrigin=${encodeURIComponent(appOrigin.origin)}` }
        emit(run, { ev: "desktop-view", agent, state: "open", viewOnly, expires })
        return d.view
      } catch {
        d.failed = !op.cancelled || Boolean(d.lease)
        await cleanDesktop(d)
        if (!d.failed) s.desktops.delete(agent)
        throw fail(d.failed ? "Desktop setup failed. Automation remains blocked; stop this run." : "Desktop request was cancelled.")
      }
    }, scope)
  }
  function closeOwned(run, s, agent, scope) {
    active(run.id, s)
    if (scope.closing) return scope.closing
    scope.closed = true
    const op = s.operations.get(agent)
    const pendingOp = op?.scope === scope ? op : null
    if (pendingOp) pendingOp.cancelled = true
    if (!pendingOp && s.desktops.get(agent)?.scope !== scope) {
      scope.s = null
      return Promise.resolve(closed())
    }
    const closing = (async () => {
      if (pendingOp) await pendingOp.promise.catch(() => {})
      active(run.id, s)
      if (s.desktops.get(agent)?.scope !== scope) return closed()
      return serial(s, agent, () => closeAgent(run, s, agent), scope)
    })().finally(() => {
      if (s.closing.get(agent) === closing) s.closing.delete(agent)
      scope.s = null
    })
    scope.closing = closing
    s.closing.set(agent, closing)
    return closing
  }
  async function close(id, agent, identity) {
    const run = getRun(id)
    if (!run) throw fail("No such run.", 404)
    if (!run.owner) throw fail("This server does not own this run.")
    agentOf(run, agent)
    identity = identityOf(identity)
    const key = desktopKey(id, agent, identity)
    const scope = desktops.get(key)
    if (!scope) {
      // A cancellation can arrive before its POST. Never let that POST open later.
      desktops.set(key, { closed: true })
      return closed()
    }
    if (identity.epoch !== undefined && identity.epoch !== scope.epoch) return closed()
    if (scope.closing) { await scope.closing; return closed() }
    if (scope.closed || !scope.s) return closed()
    if (scope.s.retired) { await scope.s.invalidation; return closed() }
    if (scope.s !== state(run)) return closed()
    return closeOwned(run, scope.s, agent, scope)
  }
  async function answer(id, body) {
    const { run, s } = active(id)
    const keys = Object.keys(body ?? {})
    const hasDone = typeof body?.done === "boolean"
    const reply = typeof body?.reply === "string" ? body.reply.trim() : ""
    if (keys.length !== 2 || !keys.includes("ask") || !(hasDone ? keys.includes("done") : keys.includes("reply") && reply && reply.length <= 4000)) throw fail("Use Done, Cancel, or a nonempty reply up to 4,000 characters.", 400)
    const ask = s.asks.get(body.ask)
    if (!ask || ask.answer || ask.sending) throw fail("This ask is stale or already answered.")
    ask.sending = true
    try {
      const scope = s.operations.get(ask.agent)?.scope ?? s.desktops.get(ask.agent)?.scope
      if (scope) await closeOwned(run, s, ask.agent, scope)
      else if (s.closing.has(ask.agent)) await s.closing.get(ask.agent)
      active(id, s)
      if (ask.answer) throw fail("This ask is no longer pending.")
      const expected = hasDone ? body.done ? "done" : "cancel" : "reply"
      const e = await pending(s, `ask:${ask.id}`, (e) => e.ev === "ask-answered" && e.id === ask.id && e.agent === ask.agent, hasDone ? { ask: ask.id, done: body.done } : { ask: ask.id, reply })
      if (e.answer !== expected) throw fail("The ask was cancelled before this answer was accepted.")
      return { ok: true }
    } finally { ask.sending = false }
  }
  function consume(run, child, epoch, e) {
    const s = state(run)
    const privateEvent = ["roam-control", "ask-human", "ask-answered"].includes(e.ev)
    if (!s || s.retired || s.child !== child || s.epoch !== epoch || run.child !== child || run.roamEpoch !== epoch) return privateEvent || (child !== run.child)
    if (e.ev === "roam-control") {
      const p = s.pending.get(e.id)
      if (p?.match(e)) p.resolve(e)
      return true
    }
    if (e.ev === "ask-human") {
      if (!ID.test(e.id ?? "") || !ID.test(e.agent ?? "") || !KINDS.has(e.kind) || typeof e.question !== "string" || !e.question.trim() || e.question.length > 4000 || s.asks.has(e.id)) return true
      if (e.agent !== "coordinator" && !run.events.some((x) => x.ev === "subagent-spawned" && x.id === e.agent)) return true
      const ask = { id: e.id, agent: e.agent, kind: e.kind, question: redactSecrets(e.question), t: now() }
      if (e.detail !== undefined) {
        const detail = JSON.stringify(redactSecrets(e.detail))
        if (detail && Buffer.byteLength(detail) <= 8192) ask.detail = detail
      }
      const presentation = askPresentation(e.kind, e.presentation)
      if (presentation) ask.presentation = presentation
      s.asks.set(e.id, ask)
      emit(run, { ev: "ask-human", ...ask })
      return true
    }
    if (e.ev === "ask-answered") {
      const ask = s.asks.get(e.id)
      if (!ask || ask.agent !== e.agent || ask.answer || !["done", "cancel", "reply"].includes(e.answer)) return true
      ask.answer = e.answer
      const p = s.pending.get(`ask:${e.id}`)
      if (p?.match(e)) p.resolve(e)
      emit(run, { ev: "ask-answered", id: ask.id, agent: ask.agent, answer: e.answer, t: now() })
      return true
    }
    return false
  }
  function invalidate(run, child, epoch) {
    const s = state(run)
    if (!s || (child !== undefined && (s.child !== child || s.epoch !== epoch))) return Promise.resolve()
    if (s.invalidation) return s.invalidation
    s.retired = true
    for (const scope of s.scopes) scope.closed = true
    for (const op of s.operations.values()) op.cancelled = true
    for (const p of [...s.pending.values()]) p.reject(fail("Worker ended before acknowledgement."))
    for (const ask of s.asks.values()) if (!ask.answer) {
      ask.answer = "cancel"
      emit(run, { ev: "ask-answered", id: ask.id, agent: ask.agent, answer: "cancel", interrupted: true, t: now() })
    }
    s.invalidation = (async () => {
      try {
        await Promise.allSettled([...s.operations.values()].map((op) => op.promise).concat([...s.closing.values()]))
        const cleanup = await Promise.allSettled([...s.desktops.values()].map(cleanDesktop))
        if (cleanup.some((r) => r.status === "rejected")) throw fail("Desktop revocation failed.")
        if (state(run) === s) workers.delete(run.id)
      } finally {
        for (const scope of s.scopes) scope.s = null
      }
    })()
    for (const scope of s.scopes) scope.closing ??= s.invalidation
    return s.invalidation
  }
  function assertIdle(run) {
    if (state(run)) throw fail("Previous worker desktop cleanup has not completed. No new worker was started.")
  }
  function begin(run, child, epoch) {
    assertIdle(run)
    workers.set(run.id, { child, epoch, retired: false, invalidation: null, asks: new Map(), pending: new Map(), desktops: new Map(), operations: new Map(), closing: new Map(), scopes: new Set() })
  }
  return { begin, assertIdle, consume, invalidate, answer, desktop, close }
}
