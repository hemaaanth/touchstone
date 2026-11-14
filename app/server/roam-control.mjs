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

// Capabilities and pending replies stay only in this process, never in run records.
export function createRoamControlApi({ getRun, emit, machine, timeoutMs = 15000, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  const workers = new Map()
  const state = (run) => workers.get(run.id)
  const active = (id) => {
    const run = getRun(id)
    const s = run && state(run)
    if (!run) throw fail("No such run.", 404)
    if (!run.owner) throw fail("This server does not own this run.")
    if (run.stopping || run.archived || !run.child?.stdin?.writable || !s || s.child !== run.child || s.epoch !== run.roamEpoch || (run.status !== "running" && !run.replying)) throw fail("This worker is no longer available.")
    return { run, s }
  }
  const agentOf = (run, agent) => {
    if (!ID.test(agent ?? "")) throw fail("Invalid agent.", 400)
    const spawned = run.events.findLast((e) => e.ev === "subagent-spawned" && e.id === agent)
    if (!spawned || spawned.loadout !== "free-roam" || run.events.some((e) => e.ev === "subagent-done" && e.id === agent && e.t >= spawned.t)) throw fail("No active free-roam agent.")
    return agent
  }
  const pending = (s, key, match, payload) => new Promise((resolve, reject) => {
    const timer = schedule(() => { s.pending.delete(key); reject(fail("Worker acknowledgement timed out. Automation remains blocked.")) }, timeoutMs)
    s.pending.set(key, { match, resolve: (value) => { unschedule(timer); s.pending.delete(key); resolve(value) }, reject: (error) => { unschedule(timer); s.pending.delete(key); reject(error) } })
    try { s.child.stdin.write(JSON.stringify(payload) + "\n", (error) => { if (error) s.pending.get(key)?.reject(fail("Worker pipe closed.")) }) } catch { s.pending.get(key)?.reject(fail("Worker pipe closed.")) }
  })
  const gate = async (run, s, agent, op, lease) => {
    active(run.id)
    const id = randomUUID()
    const e = await pending(s, id, (e) => e.ev === "roam-control" && e.id === id && e.epoch === s.epoch && e.agent === agent && e.op === op && e.lease === lease, { roamControl: { id, epoch: s.epoch, agent, op, lease } })
    if (e.ok !== true || e.state !== (op === "pause" ? "paused" : op === "resume" ? "running" : "closed")) throw fail("Worker did not acknowledge the requested automation state.")
  }
  const request = async (m, input) => {
    try { return await m.request(Buffer.from(JSON.stringify(input))) } catch { throw fail("Desktop runtime request failed.") }
  }
  const cleanDesktop = async (d) => {
    unschedule(d.timer)
    const results = await Promise.allSettled([request(d.machine, { action: "close" }).then((r) => { if (r?.kind !== "closed") throw fail("Desktop did not close.") }), d.grant ? d.machine.expirePreview(d.port, d.grant.revokeToken) : Promise.resolve()])
    d.view = closed()
    if (results.some((r) => r.status === "rejected")) throw fail("Desktop cleanup failed. Automation remains blocked.")
  }
  const closeAgent = async (run, s, agent, resume = true) => {
    const d = s.desktops.get(agent)
    if (!d) return closed()
    await cleanDesktop(d)
    if (d.lease && resume) await gate(run, s, agent, "resume", d.lease)
    s.desktops.delete(agent)
    emit(run, { ev: "desktop-view", agent, state: "closed" })
    return closed()
  }
  const serial = async (s, agent, fn) => {
    if (s.busy.has(agent)) throw fail("A desktop change is already pending.")
    s.busy.add(agent)
    try { return await fn() } finally { s.busy.delete(agent) }
  }
  async function desktop(id, agent, viewOnly, origin) {
    const { run, s } = active(id)
    agentOf(run, agent)
    if (typeof viewOnly !== "boolean") throw fail("Choose Watch or Take control.", 400)
    let appOrigin
    try { appOrigin = new URL(origin); if (appOrigin.origin !== origin || appOrigin.protocol !== "https:") throw 0 } catch { throw fail("Desktop access requires the console's HTTPS origin.", 400) }
    return serial(s, agent, async () => {
      const old = s.desktops.get(agent)
      if (!viewOnly && (!old || old.view.kind !== "open" || !old.view.viewOnly || old.view.expires <= now())) throw fail("Open Watch before taking control.")
      if (old) await closeAgent(run, s, agent)
      let m
      try { m = await machine(run.ws, agent) } catch { throw fail("Desktop adapter is unavailable.") }
      if (!m) throw fail("This agent has no available desktop.")
      active(id)
      const d = { machine: m, view: closed(), port: null, grant: null, lease: viewOnly ? null : randomUUID(), timer: null }
      s.desktops.set(agent, d)
      try {
        if (d.lease) await gate(run, s, agent, "pause", d.lease)
        active(id)
        const configured = await request(m, { action: "configure" })
        active(id)
        if (configured?.kind !== "configured" || !Number.isInteger(configured.port) || configured.port < 1 || configured.port > 65535 || !Number.isFinite(configured.expires) || configured.expires <= now()) throw fail("Desktop runtime is not configured.")
        d.port = configured.port
        const seconds = Math.min(900, Math.floor((configured.expires - now()) / 1000))
        if (seconds < 1) throw fail("Desktop grant expired.")
        d.grant = await m.previewGrant(d.port, seconds)
        active(id)
        const preview = new URL(d.grant.url)
        if (preview.protocol !== "https:" || preview.username || preview.password || preview.hash || preview.search || preview.pathname !== "/" || !Number.isFinite(d.grant.expires) || d.grant.expires <= now() || !d.grant.revokeToken) throw fail("Invalid signed desktop grant.")
        const token = randomBytes(32).toString("base64url")
        const opened = await request(m, { action: "open", previewOrigin: preview.origin, appOrigins: [appOrigin.origin], token, viewOnly })
        if (opened?.kind !== "open" || opened.viewOnly !== viewOnly || !Number.isFinite(opened.expires) || opened.expires <= now()) throw fail("Desktop runtime did not open.")
        active(id)
        const expires = Math.min(configured.expires, d.grant.expires, opened.expires)
        d.view = { kind: "open", agent, viewOnly, expires, url: `${preview.origin}/#${token}&parentOrigin=${encodeURIComponent(appOrigin.origin)}` }
        d.timer = schedule(() => { void serial(s, agent, () => closeAgent(run, s, agent)).catch(() => {}) }, expires - now())
        d.timer?.unref?.()
        emit(run, { ev: "desktop-view", agent, state: "open", viewOnly, expires })
        return d.view
      } catch {
        // Keep the lease latched if either revocation or pause acknowledgement failed.
        try { await cleanDesktop(d) } catch { throw fail("Desktop cleanup failed. Automation remains blocked.") }
        throw fail("Desktop setup failed. Automation remains blocked; release or stop this run.")
      }
    })
  }
  async function close(id, agent) {
    const { run, s } = active(id)
    agentOf(run, agent)
    return serial(s, agent, () => closeAgent(run, s, agent))
  }
  async function answer(id, body) {
    const { s } = active(id)
    const keys = Object.keys(body ?? {})
    const hasDone = typeof body?.done === "boolean"
    const reply = typeof body?.reply === "string" ? body.reply.trim() : ""
    if (keys.length !== 2 || !keys.includes("ask") || !(hasDone ? keys.includes("done") : keys.includes("reply") && reply && reply.length <= 4000)) throw fail("Use Done, Cancel, or a nonempty reply up to 4,000 characters.", 400)
    const ask = s.asks.get(body.ask)
    if (!ask || ask.answer || ask.sending) throw fail("This ask is stale or already answered.")
    ask.sending = true
    try {
      if (s.desktops.has(ask.agent)) await close(id, ask.agent)
      active(id)
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
    if (!s || s.child !== child || s.epoch !== epoch || run.child !== child) return privateEvent || (child !== run.child)
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
  async function invalidate(run) {
    const s = state(run)
    if (!s) return
    workers.delete(run.id)
    for (const p of [...s.pending.values()]) p.reject(fail("Worker ended before acknowledgement."))
    for (const ask of s.asks.values()) if (!ask.answer) emit(run, { ev: "ask-answered", id: ask.id, agent: ask.agent, answer: "cancel", interrupted: true, t: now() })
    const cleanup = await Promise.allSettled([...s.desktops.values()].map(cleanDesktop))
    if (cleanup.some((r) => r.status === "rejected")) throw fail("Desktop revocation failed.")
  }
  function begin(run, child, epoch) {
    if (state(run)) throw fail("Previous worker control has not been invalidated.")
    workers.set(run.id, { child, epoch, asks: new Map(), pending: new Map(), desktops: new Map(), busy: new Set() })
  }
  return { begin, consume, invalidate, answer, desktop, close }
}
