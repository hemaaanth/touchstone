import "./helpers/isolated-env"
import { test, expect } from "bun:test"
import { createRoamControlApi, roamSelection } from "../server/roam-control.mjs"
import { createSessionArtifactsApi } from "../server/candidates.mjs"
import { handleRuns } from "../server/runs-http.mjs"
import { EventEmitter } from "node:events"

function fixture() {
  const log = [], events = [], lines = [], timers = []
  const run = { id: "r1", owner: {}, ws: "/fake", status: "running", roamEpoch: "epoch-1", events: [{ ev: "subagent-spawned", id: "a-1", loadout: "free-roam", t: 1 }, { ev: "subagent-spawned", id: "a-2", loadout: "confined", t: 1 }] }
  let autoAck = true, failOpen = false, failRevoke = false, failClose = false
  const child = { stdin: { writable: true, write(raw, cb) {
    const line = JSON.parse(raw); lines.push(line); cb?.()
    if (line.roamControl) {
      const r = line.roamControl; log.push(r.op)
      if (autoAck) queueMicrotask(() => api.consume(run, child, run.roamEpoch, { ev: "roam-control", ...r, ok: true, state: r.op === "pause" ? "paused" : "running" }))
    }
  } } }
  run.child = child
  const machine = { id: "sandbox", async request(bytes) {
    const req = JSON.parse(Buffer.from(bytes).toString()); log.push(req.action)
    if (req.action === "configure") return { kind: "configured", port: 9876, expires: 900001 }
    if (req.action === "close") { if (failClose) throw Error("synthetic-secret"); return { kind: "closed" } }
    if (req.action === "open") { if (failOpen) throw Error("synthetic-secret"); expect(req.token).toMatch(/^[A-Za-z0-9_-]{43}$/); return { kind: "open", viewOnly: req.viewOnly, expires: 900001 } }
  }, async previewGrant() { log.push("grant"); return { url: "https://desktop.example/", expires: 900001, revokeToken: "synthetic-grant" } }, async expirePreview() { log.push("revoke"); if (failRevoke) throw Error("synthetic-secret") } }
  const api = createRoamControlApi({ getRun: (id) => id === run.id ? run : null, emit: (_run, event) => events.push(event), machine: async () => machine, now: () => 1, timeoutMs: 20, schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timers.push(timer); return timer }, unschedule: clearTimeout })
  api.begin(run, child, run.roamEpoch)
  return { api, run, child, log, events, lines, machine, ack(value) { autoAck = value }, failOpen() { failOpen = true }, failRevoke() { failRevoke = true }, failClose() { failClose = true }, async end() { timers.forEach(clearTimeout); await api.invalidate(run).catch(() => {}) } }
}
const ask = (id = "ask-1", agent = "a-1") => ({ ev: "ask-human", id, agent, kind: "login", question: "Open the test account", detail: { token: "synthetic-secret" } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("per-run options default fleet on and cannot leak to solo or confined", () => {
  expect(roamSelection()).toEqual({ freeRoam: true, options: [] })
  expect(roamSelection(undefined, [], "solo")).toEqual({ freeRoam: false, options: [] })
  for (const args of [[true, [], "solo"], [true, ["wallet"]], [true, ["email"]], [false, ["email"]], [true, ["wallet", "wallet"]], [true, ["rpc"]], ["1", []], [null, []]]) expect(() => roamSelection(...args)).toThrow()
})

test("queue exact identities, confined asks, strict answers and ack not pipe success", async () => {
  const f = fixture()
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    f.api.consume(f.run, f.child, "epoch-1", ask("ask-2", "a-2"))
    f.api.consume(f.run, f.child, "epoch-1", ask("unknown", "other"))
    expect(f.events.map((e) => e.id)).toEqual(["ask-1", "ask-2"])
    expect(JSON.stringify(f.events)).not.toContain("synthetic-secret")
    for (const body of [{ ask: "ask-1", done: true, reply: "x" }, { ask: "ask-1", reply: " " }, { ask: "ask-1", reply: "x".repeat(4001) }, { ask: "stale", done: true }, { ask: "ask-1", done: "true" }]) await expect(f.api.answer("r1", body)).rejects.toThrow()
    let settled = false
    const answer = f.api.answer("r1", { ask: "ask-1", reply: "synthetic-private-reply" }).then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow()
    f.api.consume(f.run, {}, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply" })
    expect(settled).toBe(false)
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", reply: "must not serialize" })
    await answer
    expect(JSON.stringify(f.events)).not.toContain("synthetic-private-reply")
    expect(JSON.stringify(f.events)).not.toContain("must not serialize")
    expect(f.lines[0]).toEqual({ ask: "ask-1", reply: "synthetic-private-reply" })
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow()
  } finally { await f.end() }
})

test("timeout cancellation cannot acknowledge Done; stop and restart invalidate pending IDs", async () => {
  const f = fixture()
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    const answer = f.api.answer("r1", { ask: "ask-1", done: true })
    await tick()
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "cancel" })
    await expect(answer).rejects.toThrow("cancelled")
    f.run.stopping = true
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example")).rejects.toThrow()
    f.run.stopping = false
    f.run.owner = null
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow("own")
    f.run.owner = {}
    await f.api.invalidate(f.run)
    f.run.roamEpoch = "epoch-2"
    f.api.begin(f.run, f.child, "epoch-2")
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow("stale")
  } finally { await f.end() }
})

test("Watch first; gate pause ack precedes control; close and revoke precede resume", async () => {
  const f = fixture()
  try {
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example")).rejects.toThrow("Watch")
    await expect(f.api.desktop("r1", "a-2", true, "https://console.example")).rejects.toThrow("free-roam")
    const watched = await f.api.desktop("r1", "a-1", true, "https://console.example")
    expect(watched.viewOnly).toBe(true)
    expect(f.log).not.toContain("pause")
    f.ack(false)
    const take = f.api.desktop("r1", "a-1", false, "https://console.example")
    await tick()
    expect(f.log).toEqual(["configure", "grant", "open", "close", "revoke", "pause"])
    const req = f.lines.at(-1).roamControl
    for (const patch of [{ epoch: "old" }, { lease: "wrong" }, { agent: "a-2" }, { id: "wrong" }]) f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused", ...patch })
    await tick()
    expect(f.log.at(-1)).toBe("pause")
    f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused" })
    const controlled = await take
    expect(controlled.viewOnly).toBe(false)
    f.ack(true)
    await f.api.close("r1", "a-1")
    expect(f.log.slice(-3)).toEqual(["close", "revoke", "resume"])
    expect(JSON.stringify(f.events)).not.toContain("https://")
    expect(JSON.stringify(f.events)).not.toContain("synthetic-grant")
    expect(f.events.some((e) => e.ev === "roam-control")).toBe(false)
  } finally { await f.end() }
})

test("pause timeout never opens control, and failed setup cleans runtime and grant", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example")
    f.ack(false)
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example")).rejects.toThrow("blocked")
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
  const g = fixture()
  try {
    await g.api.desktop("r1", "a-1", true, "https://console.example")
    g.failOpen()
    await expect(g.api.desktop("r1", "a-1", false, "https://console.example")).rejects.toThrow("blocked")
    expect(g.log.slice(-2)).toEqual(["close", "revoke"])
    expect(g.log).not.toContain("resume")
    await g.api.close("r1", "a-1")
    expect(g.log.slice(-3)).toEqual(["close", "revoke", "resume"])
  } finally { await g.end() }
})

test("revocation failure never resumes and ask answer waits for cleanup", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example")
    await f.api.desktop("r1", "a-1", false, "https://console.example")
    f.api.consume(f.run, f.child, "epoch-1", ask())
    f.failRevoke()
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow("blocked")
    expect(f.lines.some((l) => l.ask)).toBe(false)
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
})

test("expiry closes and revokes even when no browser remains", async () => {
  let expire
  const f = fixture()
  const api = createRoamControlApi({ getRun: () => f.run, emit: () => {}, machine: async () => f.machine, now: () => 1, schedule: (fn) => { expire = fn; return 1 }, unschedule: () => {} })
  api.begin(f.run, f.child, "epoch-1")
  try {
    await api.desktop("r1", "a-1", true, "https://console.example")
    expire()
    await tick()
    expect(f.log.slice(-2)).toEqual(["close", "revoke"])
  } finally { await api.invalidate(f.run); await f.end() }
})

test("canonical reviewed transcript MIME lists and downloads with exact result agreement; screenshots stay withheld", async () => {
  const hash = "a".repeat(64)
  const manifest = { version: 1, run: "r1", agent: "a-1", sequence: 1, files: [{ id: "f1", kind: "screenshot", sha256: hash, bytes: 3, mime: "image/png", approval: "pending" }, { id: "t1", kind: "transcript", sha256: hash, bytes: 3, mime: "text/plain; charset=utf-8", approval: "not-required" }] }
  const run = { owner: {}, candidates: [{ poc: "session:a-1:1", proven: false, evidence: { kind: "session", agent: "a-1", artifacts: { version: 1, run: "r1", agent: "a-1", poc: "session:a-1:1", manifest: "m-1" } } }] }
  const calls = []
  let readMime = "text/plain; charset=utf-8"
  const api = createSessionArtifactsApi({ getRun: (id) => id === "r1" ? run : null, rootOf: () => "/private/r1", store: async () => ({ listSessionArtifacts: () => manifest, readSessionArtifact: (_root, selectors) => { calls.push(selectors); return { data: Buffer.from("log"), mime: readMime } }, releaseSessionScreenshot: (_root, selectors) => { calls.push(selectors) } }) })
  const body = { candidate: "session:a-1:1" }
  await expect(api("r2", body)).rejects.toThrow()
  await expect(api("r1", { candidate: "session:a-2:1" })).rejects.toThrow()
  await expect(api("r1", body, "read", "f1")).rejects.toThrow()
  await expect(api("r1", { ...body, sha256: "b".repeat(64) }, "release", "f1")).rejects.toThrow()
  expect(calls).toHaveLength(0)
  expect(await api("r1", body)).toEqual(manifest)
  await expect(api("r1", { ...body, sha256: hash }, "release", "f1")).rejects.toThrow()
  manifest.files[0].approval = "released"
  await expect(api("r1", body, "read", "f1")).rejects.toThrow()
  expect(calls).toHaveLength(0)
  const data = await api("r1", body, "read", "t1")
  expect(data.data.toString()).toBe("log")
  expect(data.mime).toBe("text/plain; charset=utf-8")
  expect(calls[0]).toEqual({ run: "r1", agent: "a-1", poc: body.candidate, id: "t1" })
  readMime = "text/plain"
  await expect(api("r1", body, "read", "t1")).rejects.toThrow()
  manifest.files[1].mime = "text/html"
  await expect(api("r1", body)).rejects.toThrow()
  manifest.files[1].mime = "text/plain; charset=utf-8"
  run.candidates[0].evidence.artifacts.agent = "a-2"
  await expect(api("r1", body)).rejects.toThrow()
})

test("every private endpoint refuses bad authentication and CSRF before body reads", async () => {
  for (const [method, path] of [["POST", "ask"], ["POST", "desktop"], ["DELETE", "desktop"], ["POST", "session-artifacts"], ["POST", "session-artifacts/f1/read"], ["POST", "session-artifacts/f1/review"], ["POST", "session-artifacts/f1/release"]]) {
    for (const headers of [{ host: "console.example" }, { host: "console.example", origin: "https://evil.example", "content-type": "application/json", "x-touchstone-grant-token": "test-grant-token" }, { host: "console.example", origin: "https://console.example", "content-type": "application/json" }]) {
      const req = new EventEmitter(); req.url = `/api/runs/r1/${path}`; req.method = method; req.headers = headers
      let status, bodyRead = false
      req.on = () => { bodyRead = true; return req }
      const res = { set statusCode(v) { status = v }, setHeader() {}, end() {} }
      expect(await handleRuns(req, res)).toBe(true)
      expect(status).toBe(403)
      expect(bodyRead).toBe(false)
    }
  }
})

test("Done is exact-id acknowledged, and runtime close failure keeps control blocked", async () => {
  const f = fixture()
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    const done = f.api.answer("r1", { ask: "ask-1", done: true })
    await tick()
    expect(f.lines.at(-1)).toEqual({ ask: "ask-1", done: true })
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "done" })
    expect(await done).toEqual({ ok: true })
    await f.api.desktop("r1", "a-1", true, "https://console.example")
    await f.api.desktop("r1", "a-1", false, "https://console.example")
    f.failClose()
    await expect(f.api.close("r1", "a-1")).rejects.toThrow("blocked")
    expect(f.log.at(-1)).toBe("revoke")
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
})

test("first release refuses desktop and screenshot release even for the authenticated operator", async () => {
  for (const [method, endpoint] of [["POST", "desktop"], ["DELETE", "desktop"], ["POST", "session-artifacts/f1/review"], ["POST", "session-artifacts/f1/release"]]) {
    const req = new EventEmitter()
    req.url = `/api/runs/r1/${endpoint}`
    req.method = method
    req.headers = { host: "console.example", origin: "https://console.example", "content-type": "application/json", "x-touchstone-grant-token": "test-grant-token" }
    let status, data, bodyRead = false
    req.on = () => { bodyRead = true; return req }
    const headers = {}
    const res = { set statusCode(v) { status = v }, setHeader(k, v) { headers[k] = v }, end(v) { data = JSON.parse(v) } }
    expect(await handleRuns(req, res)).toBe(true)
    expect(status).toBe(409)
    expect(data.error).toContain("not enabled")
    expect(headers["cache-control"]).toBe("no-store")
    expect(bodyRead).toBe(false)
  }
})

const choices = { options: [{ id: "first", label: "First choice" }, { id: "second", label: "Second choice" }], select: "single" }

test("Ask presentation validates every frozen malformed combination and falls back to a plain question", async () => {
  const f = fixture()
  const bad = [
    null, [], "options", {}, { select: "single" }, { options: {} },
    { options: [] }, { options: choices.options.slice(0, 1) },
    { options: Array.from({ length: 13 }, (_, i) => ({ id: `id-${i}`, label: "Choice" })) },
    { ...choices, select: "any" }, { ...choices, select: null },
    { ...choices, extra: true }, { ...choices, min: 1 }, { ...choices, max: 2 },
    ...["", "_first", "Upper", "has space", "x".repeat(65)].map((id) => ({ ...choices, options: [{ id, label: "Choice" }, choices.options[1]] })),
    { ...choices, options: [choices.options[0], choices.options[0]] },
    ...[null, "", "  ", 7, "x".repeat(201)].map((label) => ({ ...choices, options: [{ id: "first", label }, choices.options[1]] })),
    ...[null, 1, "x".repeat(501)].map((description) => ({ ...choices, options: [{ ...choices.options[0], description }, choices.options[1]] })),
    { ...choices, options: [{ ...choices.options[0], disabled: true }, choices.options[1]] },
    { ...choices, options: [null, choices.options[1]] },
    ...[{ min: 0 }, { max: 0 }, { min: 1.5 }, { max: 1.5 }, { min: 2, max: 1 }, { max: 3 }, { min: "1" }, { max: "2" }, { min: null }, { max: null }].map((range) => ({ ...choices, select: "multiple", ...range })),
    { ...choices, options: Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, label: "Choice", description: "界".repeat(500) })) },
  ]
  try {
    for (let i = 0; i < bad.length; i++) {
      f.api.consume(f.run, f.child, "epoch-1", { ...ask(`bad-${i}`), kind: "question", presentation: bad[i] })
      expect(f.events.at(-1)).toMatchObject({ id: `bad-${i}`, question: "Open the test account" })
      expect(f.events.at(-1)).not.toHaveProperty("presentation")
    }
    for (const kind of ["login", "payment", "wallet-spend", "takeover"]) {
      f.api.consume(f.run, f.child, "epoch-1", { ...ask(`action-${kind}`), kind, presentation: choices })
      expect(f.events.at(-1)).not.toHaveProperty("presentation")
    }
    f.api.consume(f.run, f.child, "epoch-1", ask("old"))
    expect(f.events.at(-1)).not.toHaveProperty("presentation")
  } finally { await f.end() }
})

test("Ask presentation bounds, defaults and scrubbed display strings survive server ingestion", async () => {
  const f = fixture()
  try {
    f.api.consume(f.run, f.child, "epoch-1", { ...ask("defaults"), kind: "question", presentation: { options: choices.options } })
    expect(f.events.at(-1).presentation).toEqual(choices)
    f.api.consume(f.run, f.child, "epoch-1", { ...ask("multi-default"), kind: "question", presentation: { options: choices.options, select: "multiple" } })
    expect(f.events.at(-1).presentation).toEqual({ ...choices, select: "multiple", min: 1, max: 2 })
    const options = Array.from({ length: 12 }, (_, i) => ({ id: i ? `choice-${i}` : "a".repeat(64), label: ` ${"x".repeat(200)} `, description: "x".repeat(500) }))
    f.api.consume(f.run, f.child, "epoch-1", { ...ask("bounds"), kind: "question", presentation: { options, select: "multiple", min: 1, max: 12 } })
    expect(f.events.at(-1).presentation.options[0].label).toBe("x".repeat(200))
    expect(f.events.at(-1).presentation.max).toBe(12)
    const secretLabel = "Authorization: Bearer secret-label-value"
    const secretDescription = "password=secret-description-value"
    f.api.consume(f.run, f.child, "epoch-1", { ...ask("scrubbed"), kind: "question", presentation: { ...choices, options: [{ id: "first", label: secretLabel, description: secretDescription }, choices.options[1]] } })
    const stored = JSON.stringify(f.events.at(-1))
    expect(stored).not.toContain("secret-label-value")
    expect(stored).not.toContain("secret-description-value")
    expect(stored).toContain("[REDACTED]")
  } finally { await f.end() }
})

test("Choice Reply waits for exact worker/epoch/agent ack; retry clears sending and reply never enters telemetry", async () => {
  const f = fixture()
  const reply = "Selected option: first (First choice)"
  try {
    f.api.consume(f.run, f.child, "epoch-1", { ...ask(), kind: "question", presentation: choices })
    let completed = false
    const pending = f.api.answer("r1", { ask: "ask-1", reply }).then(() => { completed = true })
    await tick()
    expect(f.lines.at(-1)).toEqual({ ask: "ask-1", reply })
    f.api.consume(f.run, f.child, "old-epoch", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply" })
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-2", answer: "reply" })
    await tick()
    expect(completed).toBe(false)
    await expect(f.api.answer("r1", { ask: "ask-1", reply })).rejects.toThrow()
    await expect(pending).rejects.toThrow("timed out")
    expect(completed).toBe(false)
    const retried = f.api.answer("r1", { ask: "ask-1", reply })
    await tick()
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", reply, selected: ["first"] })
    expect(await retried).toEqual({ ok: true })
    expect(f.events.at(-1)).toEqual({ ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", t: 1 })
    expect(JSON.stringify(f.events)).not.toContain(reply)
    await expect(f.api.answer("r1", { ask: "ask-1", reply })).rejects.toThrow()
    f.api.consume(f.run, f.child, "epoch-1", { ...ask("terminated"), kind: "question", presentation: choices })
    const terminated = f.api.answer("r1", { ask: "terminated", reply })
    await f.api.invalidate(f.run)
    await expect(terminated).rejects.toThrow("ended")
    await expect(f.api.answer("r1", { ask: "terminated", reply })).rejects.toThrow()
  } finally { await f.end() }
})
