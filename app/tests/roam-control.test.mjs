import { TEST_STORE_DIR } from "./helpers/isolated-env"
import { test, expect } from "bun:test"
import { createRoamControlApi, roamSelection } from "../server/roam-control.mjs"
import { createSessionArtifactsApi } from "../server/candidates.mjs"
import { createRoamControl } from "../../spike/lib/roam-control.mjs"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"

function routeChild(source, args = [], cwd = new URL("../", import.meta.url).pathname) {
  return Bun.spawn([process.execPath, "--no-env-file", "--eval", source, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: TEST_STORE_DIR, TMPDIR: TEST_STORE_DIR, SPEND_LEDGER: `${TEST_STORE_DIR}/route-spend.jsonl`, TOUCHSTONE_GRANT_TOKEN: "test-grant-token", TOUCHSTONE_GRANT_TOKEN_FILE: `${TEST_STORE_DIR}/route-token`, TOUCHSTONE_GRANTS_FILE: `${TEST_STORE_DIR}/route-grants.json`, TOUCHSTONE_SCOPES_FILE: `${TEST_STORE_DIR}/route-scopes.json`, TOUCHSTONE_PROVIDERS_FILE: `${TEST_STORE_DIR}/route-providers.json`, TOUCHSTONE_RESULTS_DIR: `${TEST_STORE_DIR}/route-results` },
    stdout: "pipe", stderr: "pipe",
  })
}

// The real runs module boots workers and scans workspaces. Only the real router
// and console guard load here; every other route dependency is process-isolated.
async function routeCases(cases) {
  const source = `
    import { mock } from "bun:test";
    import { readFileSync } from "node:fs";
    import { EventEmitter } from "node:events";
    const base = new URL("./server/runs-http.mjs", import.meta.url);
    await import(new URL("./settings.mjs", base).href);
    const calls = [];
    for (const match of readFileSync(base, "utf8").matchAll(/import\\s*\\{([^}]+)\\}\\s*from\\s*"([^"]+)"/g)) {
      if (match[2] === "./settings.mjs") continue;
      const exports = Object.fromEntries(match[1].split(",").map((name) => [name.trim(), () => { throw Error("Unexpected fixture call"); }]));
      if (match[2] === "./runs.mjs") {
        exports.openRunDesktop = async (...args) => { calls.push(["open", ...args]); return {kind:"open",agent:args[1],viewOnly:args[2],url:"https://synthetic.example/#fixture",expires:900001}; };
        exports.closeRunDesktop = async (...args) => { calls.push(["close", ...args]); return {kind:"closed"}; };
      }
      mock.module(new URL(match[2], base).href, () => exports);
    }
    const { handleRuns } = await import(base.href);
    if (globalThis.__touchstoneRuns) throw Error("Real backend imported");
    const results = [];
    for (const item of JSON.parse(process.argv[1])) {
      const req = new EventEmitter();
      Object.assign(req, item);
      let status, data, bodyRead = false;
      const headers = {}, on = req.on.bind(req);
      req.on = (name, fn) => { bodyRead = true; return on(name, fn); };
      const res = {set statusCode(v){status=v},setHeader(k,v){headers[k]=v},end(v){data=JSON.parse(v)}};
      const handled = handleRuns(req,res);
      req.emit("data",JSON.stringify(item.body ?? {})); req.emit("end");
      results.push({handled:await handled,status,data,headers,bodyRead});
    }
    console.log(JSON.stringify({results,calls}));
  `
  const child = routeChild(source, [JSON.stringify(cases)])
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  return JSON.parse(stdout)
}

function fixture({ timeoutMs = 20 } = {}) {
  const log = [], events = [], lines = [], timers = []
  const run = { id: "r1", owner: {}, ws: "/fake", status: "running", roamEpoch: "epoch-1", events: [{ ev: "subagent-spawned", id: "a-1", loadout: "free-roam", t: 1 }, { ev: "subagent-spawned", id: "a-2", loadout: "confined", t: 1 }] }
  let autoAck = true, member = true, failOpen = false, failRevoke = false, failClose = false
  const child = { stdin: { writable: true, write(raw, cb) {
    const line = JSON.parse(raw); lines.push(line); cb?.()
    if (line.roamControl) {
      const r = line.roamControl; log.push(r.op)
      if (autoAck) queueMicrotask(() => api.consume(run, child, run.roamEpoch, { ev: "roam-control", ...r, ok: r.op !== "status" || member, state: r.op === "pause" ? "paused" : r.op === "cancel" ? "closed" : "running" }))
    }
  } } }
  run.child = child
  const machine = { id: "sandbox", async request(bytes) {
    const req = JSON.parse(Buffer.from(bytes).toString()); log.push(req.action)
    if (req.action === "configure") return { kind: "configured", port: 9876, expires: 900001 }
    if (req.action === "close") { if (failClose) throw Error("synthetic-secret"); return { kind: "closed" } }
    if (req.action === "open") { if (failOpen) throw Error("synthetic-secret"); expect(req.token).toMatch(/^[A-Za-z0-9_-]{43}$/); return { kind: "open", port: 9876, viewOnly: req.viewOnly, expires: 900001 } }
  }, async previewGrant() { log.push("grant"); return { url: "https://desktop.example/", expires: 900001, revokeToken: "synthetic-grant" } }, async expirePreview() { log.push("revoke"); if (failRevoke) throw Error("synthetic-secret") } }
  let lookup = async () => machine
  const scheduled = []
  const api = createRoamControlApi({ getRun: (id) => id === run.id ? run : null, emit: (_run, event) => events.push(event), machine: (...args) => lookup(...args), now: () => 1, timeoutMs, schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timers.push(timer); scheduled.push({ fn, ms }); return timer }, unschedule: clearTimeout })
  api.begin(run, child, run.roamEpoch)
  return { api, run, child, log, events, lines, machine, scope: { id: "fixture-desktop" }, lookup(fn) { lookup = fn }, member(value) { member = value }, expire() { const timer = scheduled.findLast((s) => s.ms > timeoutMs); timer?.fn(); return Boolean(timer) }, ack(value) { autoAck = value }, failOpen() { failOpen = true }, failRevoke() { failRevoke = true }, failClose() { failClose = true }, async end() { timers.forEach(clearTimeout); await api.invalidate(run).catch(() => {}) } }
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
    expect(JSON.stringify(f.events.filter((e) => e.ev !== "ask-receipt"))).not.toContain("synthetic-private-reply")
    expect(f.events.find((e) => e.ev === "ask-receipt")).toMatchObject({ id: "ask-1", agent: "a-1", answer: "reply", text: "synthetic-private-reply" })
    expect(JSON.stringify(f.events)).not.toContain("must not serialize")
    expect(f.lines[0]).toEqual({ ask: "ask-1", reply: "synthetic-private-reply" })
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow()
  } finally { await f.end() }
})

test("safe Ask receipts come only from the frozen submitted candidate after exact acknowledgement", async () => {
  const f = fixture({ timeoutMs: 100 })
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    const reply = "Use staging. Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nhttps://viewer.example/capability/private-token /preview/private-path"
    const pending = f.api.answer("r1", { ask: "ask-1", reply })
    await tick()
    expect(f.events.some((e) => e.ev === "ask-receipt")).toBe(false)
    for (const patch of [{ agent: "a-2" }, { id: "other" }]) f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", ...patch })
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-receipt", id: "ask-1", agent: "a-1", answer: "reply", text: "worker forgery" })
    expect(f.events.some((e) => e.ev === "ask-receipt")).toBe(false)
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", text: "worker forgery" })
    const accepted = await pending
    expect(accepted.receipt.text).toContain("Use staging.")
    for (const secret of ["abcdefghijklmnopqrstuvwxyz", "private-token", "private-path", "viewer.example", "worker forgery"]) expect(JSON.stringify(f.events)).not.toContain(secret)
    expect(f.lines[0].reply).toBe(reply)
    expect(f.events.filter((e) => e.ev === "ask-receipt")).toEqual([{ ev: "ask-receipt", ...accepted.receipt, t: 1 }])
    expect(f.events.find((e) => e.ev === "ask-answered")).toEqual({ ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply", t: 1 })
  } finally { await f.end() }
})

test("late category-only acknowledgement cannot certify different retry text", async () => {
  const f = fixture()
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    await expect(f.api.answer("r1", { ask: "ask-1", reply: "first answer" })).rejects.toMatchObject({ delivery: "unknown" })
    await expect(f.api.answer("r1", { ask: "ask-1", reply: "different retry" })).rejects.toMatchObject({ delivery: "unknown" })
    expect(f.lines.filter((l) => l.ask)).toHaveLength(1)
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply" })
    const accepted = await f.api.answer("r1", { ask: "ask-1", reply: "first answer" })
    expect(accepted.receipt.text).toBe("first answer")
    expect(JSON.stringify(f.events)).not.toContain("different retry")
    expect(f.lines.filter((l) => l.ask)).toHaveLength(1)
  } finally { await f.end() }
})

test("definitive synchronous Ask write refusal allows edited retry; duplicates send once", async () => {
  const f = fixture({ timeoutMs: 100 })
  try {
    f.api.consume(f.run, f.child, "epoch-1", ask())
    const write = f.child.stdin.write
    f.child.stdin.write = () => { throw Error("private probe detail") }
    await expect(f.api.answer("r1", { ask: "ask-1", reply: "not sent" })).rejects.toMatchObject({ delivery: "not-sent" })
    f.child.stdin.write = write
    const pending = f.api.answer("r1", { ask: "ask-1", reply: "edited answer" })
    await expect(f.api.answer("r1", { ask: "ask-1", reply: "edited answer" })).rejects.toThrow("pending")
    await tick()
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply" })
    expect((await pending).receipt.text).toBe("edited answer")
    expect(f.lines.filter((l) => l.ask)).toHaveLength(1)
    expect(JSON.stringify(f.events)).not.toContain("not sent")
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
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)).rejects.toThrow()
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
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)).rejects.toThrow("Watch")
    await expect(f.api.desktop("r1", "a-2", true, "https://console.example", f.scope)).rejects.toThrow("free-roam")
    const watched = await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    expect(watched.viewOnly).toBe(true)
    expect(f.log).not.toContain("pause")
    f.ack(false)
    const take = f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)
    await tick()
    expect(f.log).toEqual(["status", "configure", "grant", "open", "close", "revoke", "pause"])
    const req = f.lines.at(-1).roamControl
    f.api.consume(f.run, {}, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused" })
    for (const patch of [{ epoch: "old" }, { lease: "wrong" }, { agent: "a-2" }, { id: "wrong" }, { op: "status" }]) f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused", ...patch })
    await tick()
    expect(f.log.at(-1)).toBe("pause")
    f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused" })
    const controlled = await take
    expect(controlled.viewOnly).toBe(false)
    f.ack(true)
    await f.api.close("r1", "a-1", f.scope)
    expect(f.log.slice(-3)).toEqual(["close", "revoke", "resume"])
    expect(JSON.stringify(f.events)).not.toContain("https://")
    expect(JSON.stringify(f.events)).not.toContain("synthetic-grant")
    expect(f.events.some((e) => e.ev === "roam-control")).toBe(false)
  } finally { await f.end() }
})

test("pause timeout never opens control, and failed setup cleans runtime and grant", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    f.ack(false)
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)).rejects.toThrow("blocked")
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
  const g = fixture()
  try {
    await g.api.desktop("r1", "a-1", true, "https://console.example", g.scope)
    g.failOpen()
    await expect(g.api.desktop("r1", "a-1", false, "https://console.example", g.scope)).rejects.toThrow("blocked")
    expect(g.log.slice(-2)).toEqual(["close", "revoke"])
    expect(g.log).not.toContain("resume")
    await expect(g.api.close("r1", "a-1", g.scope)).rejects.toThrow("blocked")
    expect(g.log).not.toContain("resume")
  } finally { await g.end() }
})

test("revocation failure never resumes and ask answer waits for cleanup", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    await f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)
    f.api.consume(f.run, f.child, "epoch-1", ask())
    f.failRevoke()
    await expect(f.api.answer("r1", { ask: "ask-1", done: true })).rejects.toThrow("blocked")
    expect(f.lines.some((l) => l.ask)).toBe(false)
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
})

test("expiry closes and revokes even when no browser remains", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    expect(f.expire()).toBe(true)
    await tick()
    expect(f.log.slice(-2)).toEqual(["close", "revoke"])
  } finally { await f.end() }
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
  const cases = []
  for (const [method, path] of [["POST", "ask"], ["POST", "desktop"], ["DELETE", "desktop"], ["POST", "session-artifacts"], ["POST", "session-artifacts/f1/read"], ["POST", "session-artifacts/f1/review"], ["POST", "session-artifacts/f1/release"]]) {
    for (const headers of [{ host: "console.example" }, { host: "console.example", origin: "https://evil.example", "content-type": "application/json", "x-touchstone-grant-token": "test-grant-token" }, { host: "console.example", origin: "https://console.example", "content-type": "application/json" }]) cases.push({ url: `/api/runs/r1/${path}`, method, headers })
  }
  const { results, calls } = await routeCases(cases)
  for (const result of results) expect(result).toMatchObject({ handled: true, status: 403, bodyRead: false })
  expect(calls).toEqual([])
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
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    await f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)
    f.failClose()
    await expect(f.api.close("r1", "a-1", f.scope)).rejects.toThrow("blocked")
    expect(f.log.at(-1)).toBe("revoke")
    expect(f.log).not.toContain("resume")
  } finally { await f.end() }
})

test("desktop POST and DELETE dispatch privately while exact-image routes remain disabled", async () => {
  const headers = { host: "console.example", origin: "https://console.example", "content-type": "application/json", "x-touchstone-grant-token": "test-grant-token" }
  const desktop = { id: "route-desktop", epoch: "epoch-1" }
  const { results, calls } = await routeCases([["POST", "desktop"], ["POST", "desktop"], ["DELETE", "desktop"], ["POST", "session-artifacts/f1/review"], ["POST", "session-artifacts/f1/release"]].map(([method, endpoint], index) => ({ url: `/api/runs/r1/${endpoint}`, method, headers, body: { agent: "a-1", desktop, ...(method === "POST" ? { viewOnly: index === 0 } : {}) } })))
  expect(calls).toEqual([["open", "r1", "a-1", true, "https://console.example", desktop], ["open", "r1", "a-1", false, "https://console.example", desktop], ["close", "r1", "a-1", desktop]])
  for (const result of results.slice(0, 3)) expect(result).toMatchObject({ handled: true, status: 200, bodyRead: true })
  for (const result of results) {
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(result.headers["x-content-type-options"]).toBe("nosniff")
  }
  for (const result of results.slice(3)) {
    expect(result).toMatchObject({ handled: true, status: 409, bodyRead: false })
    expect(result.data.error).toContain("not enabled")
    expect(result.headers["cache-control"]).toBe("no-store")
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

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function holdRequest(f, action) {
  const started = deferred(), released = deferred()
  const request = f.machine.request
  f.machine.request = async (bytes) => {
    const result = await request(bytes)
    if (JSON.parse(Buffer.from(bytes).toString()).action === action) {
      started.resolve()
      await released.promise
    }
    return result
  }
  return { started: started.promise, release: released.resolve }
}
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }))

test("desktop membership comes from the current gate, not a completed child turn", async () => {
  const f = fixture()
  try {
    f.run.events.push({ ev: "subagent-done", id: "a-1", t: 2 })
    expect((await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)).viewOnly).toBe(true)
    expect(f.log[0]).toBe("status")
    expect(f.log).not.toContain("pause")
    await f.api.close("r1", "a-1", f.scope)
    f.member(false)
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example", { id: "next-desktop" })).rejects.toThrow()
    expect(f.log.filter((x) => x === "status")).toHaveLength(2)
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
  } finally { await f.end() }
})

test("invalidation joins setup at every remote stage and prevents a new worker from bypassing cleanup", async () => {
  for (const stage of ["lookup", "configure", "grant", "open"]) {
    const f = fixture()
    const started = deferred(), released = deferred()
    let held
    if (stage === "lookup") f.lookup(async () => { started.resolve(); await released.promise; return f.machine })
    else if (stage === "grant") {
      const grant = f.machine.previewGrant
      f.machine.previewGrant = async (...args) => { const result = await grant(...args); started.resolve(); await released.promise; return result }
    } else held = holdRequest(f, stage)
    const setup = outcome(f.api.desktop("r1", "a-1", true, "https://console.example", f.scope))
    try {
      await (held?.started ?? started.promise)
      let cleaned = false
      const first = outcome(f.api.invalidate(f.run)).then((r) => { cleaned = true; return r })
      let joined = false
      const second = outcome(f.api.invalidate(f.run)).then((r) => { joined = true; return r })
      await tick()
      expect(cleaned).toBe(false)
      expect(joined).toBe(false)
      expect(() => f.api.begin(f.run, {}, "epoch-2")).toThrow()
      held?.release(); released.resolve()
      expect((await setup).error).toBeDefined()
      await first; await second
      expect(f.events.some((e) => e.ev === "desktop-view" && e.state === "open")).toBe(false)
      if (stage !== "lookup") expect(f.log).toContain("close")
      if (["grant", "open"].includes(stage)) expect(f.log).toContain("revoke")
    } finally { held?.release(); released.resolve(); await setup; await f.end() }
  }
})

test("Release cancels an in-flight open, waits for cleanup and never returns its URL", async () => {
  const f = fixture()
  const held = holdRequest(f, "open")
  const setup = outcome(f.api.desktop("r1", "a-1", true, "https://console.example", f.scope))
  try {
    await held.started
    let closed = false
    const release = outcome(f.api.close("r1", "a-1", f.scope)).then((r) => { closed = true; return r })
    await tick()
    expect(closed).toBe(false)
    held.release()
    expect((await setup).error).toBeDefined()
    expect((await release).value).toEqual({ kind: "closed" })
    expect(f.log.slice(-2)).toEqual(["close", "revoke"])
    expect(f.events.some((e) => e.state === "open")).toBe(false)
  } finally { held.release(); await setup; await f.end() }
})

test("expiry cancels a configured setup before its delayed open response", async () => {
  const f = fixture()
  const held = holdRequest(f, "open")
  const setup = outcome(f.api.desktop("r1", "a-1", true, "https://console.example", f.scope))
  try {
    await held.started
    expect(f.expire()).toBe(true)
    held.release()
    expect((await setup).error).toBeDefined()
    await tick()
    expect(f.log.slice(-2)).toEqual(["close", "revoke"])
    expect(f.events.some((e) => e.state === "open")).toBe(false)
  } finally { held.release(); await setup; await f.end() }
})

test("an old worker exit cannot invalidate a new worker's pending Ask", async () => {
  const f = fixture()
  try {
    await f.api.invalidate(f.run)
    const next = { stdin: { writable: true, write() {} } }
    f.run.child = next
    f.run.roamEpoch = "epoch-2"
    f.api.begin(f.run, next, "epoch-2")
    f.api.consume(f.run, next, "epoch-2", ask("new-worker"))
    await f.api.invalidate(f.run, f.child, "epoch-1")
    expect(f.events.some((e) => e.id === "new-worker" && e.interrupted)).toBe(false)
    const answer = outcome(f.api.answer("r1", { ask: "new-worker", reply: "Proceed with the test" }))
    f.api.consume(f.run, next, "epoch-2", { ev: "ask-answered", id: "new-worker", agent: "a-1", answer: "reply" })
    expect((await answer).value).toEqual({ ok: true })
  } finally { await f.end() }
})

test("a timed-out pause and late acknowledgment never authorize Release to resume", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    f.ack(false)
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)).rejects.toThrow()
    const req = f.lines.findLast((l) => l.roamControl?.op === "pause").roamControl
    f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...req, ok: true, state: "paused" })
    f.ack(true)
    await expect(f.api.close("r1", "a-1", f.scope)).rejects.toThrow("blocked")
    expect(f.log).not.toContain("resume")
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
  } finally { await f.end() }
})

test("Take control refuses a different machine than the one watched", async () => {
  const f = fixture()
  let lookups = 0
  f.lookup(async () => ++lookups === 1 ? f.machine : { ...f.machine, id: "replacement" })
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    await expect(f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)).rejects.toThrow("machine")
    expect(f.log).not.toContain("pause")
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
  } finally { await f.end() }
})

test("real worker gate drains active work before its matching pause can authorize control", async () => {
  const f = fixture({ timeoutMs: 1000 })
  const active = deferred(), paused = deferred(), pauseStarted = deferred()
  const worker = createRoamControl({
    epoch: "epoch-1", isAgent: (id) => id === "a-1",
    emit: (event) => f.api.consume(f.run, f.child, "epoch-1", event),
    remote: { async pause() { pauseStarted.resolve(); await paused.promise }, async resume() {}, async close() {} },
  })
  f.child.stdin.write = (raw, cb) => {
    const line = JSON.parse(raw); f.lines.push(line); cb?.()
    if (line.roamControl) { f.log.push(line.roamControl.op); void worker.handle(line) }
  }
  let work, take
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    work = worker.run("a-1", () => active.promise)
    await tick()
    take = outcome(f.api.desktop("r1", "a-1", false, "https://console.example", f.scope))
    await tick()
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
    await expect(worker.run("a-1", () => "must not run")).rejects.toThrow()
    active.resolve()
    await work; await pauseStarted.promise
    expect(f.log.filter((x) => x === "open")).toHaveLength(1)
    paused.resolve()
    expect((await take).value.viewOnly).toBe(false)
    await f.api.close("r1", "a-1", f.scope)
    expect(f.log.slice(-3)).toEqual(["close", "revoke", "resume"])
  } finally { active.resolve(); paused.resolve(); await work; await take; worker.dispose(); await f.end() }
})

test("Ask waits for both cleanup completions and matching resume before its own acknowledgment", async () => {
  const f = fixture({ timeoutMs: 1000 })
  let held, answer
  const revoked = deferred(), revokeStarted = deferred()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    await f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)
    f.api.consume(f.run, f.child, "epoch-1", ask())
    held = holdRequest(f, "close")
    const revoke = f.machine.expirePreview
    f.machine.expirePreview = async (...args) => { await revoke(...args); revokeStarted.resolve(); await revoked.promise }
    f.ack(false)
    answer = outcome(f.api.answer("r1", { ask: "ask-1", reply: "Synthetic operator answer" }))
    await held.started; await revokeStarted.promise
    held.release(); await tick()
    expect(f.log).not.toContain("resume")
    expect(f.lines.some((l) => l.ask)).toBe(false)
    revoked.resolve(); await tick()
    const resume = f.lines.at(-1).roamControl
    expect(resume.op).toBe("resume")
    expect(f.lines.some((l) => l.ask)).toBe(false)
    f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...resume, ok: true, state: "running" })
    await tick()
    expect(f.lines.at(-1)).toEqual({ ask: "ask-1", reply: "Synthetic operator answer" })
    f.api.consume(f.run, f.child, "epoch-1", { ev: "ask-answered", id: "ask-1", agent: "a-1", answer: "reply" })
    expect((await answer).value).toEqual({ ok: true })
    expect(JSON.stringify(f.events)).not.toContain("Synthetic operator answer")
  } finally { held?.release(); revoked.resolve(); await answer; await f.end() }
})

test("a lost resume acknowledgment sends terminal cancel and never reopens the failed lease", async () => {
  const f = fixture()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    await f.api.desktop("r1", "a-1", false, "https://console.example", f.scope)
    f.ack(false)
    await expect(f.api.close("r1", "a-1", f.scope)).rejects.toThrow("blocked")
    expect(f.log.slice(-4)).toEqual(["close", "revoke", "resume", "cancel"])
    f.ack(true)
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example", { id: "retry-desktop" })).rejects.toThrow("blocked")
  } finally { await f.end() }
})

test("invalidation joins a held revocation and refuses a new worker after cleanup failure", async () => {
  const f = fixture()
  const held = deferred(), started = deferred()
  try {
    await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    f.machine.expirePreview = async () => { started.resolve(); await held.promise; throw Error("synthetic cleanup failure") }
    let ended = false
    const first = outcome(f.api.invalidate(f.run)).then((r) => { ended = true; return r })
    await started.promise
    const second = outcome(f.api.invalidate(f.run))
    await tick()
    expect(ended).toBe(false)
    expect(() => f.api.assertIdle(f.run)).toThrow("cleanup")
    held.resolve()
    expect((await first).error).toBeDefined()
    expect((await second).error).toBeDefined()
    expect(() => f.api.begin(f.run, {}, "epoch-2")).toThrow("cleanup")
  } finally { held.resolve(); await f.end() }
})

test("router child explicitly disables dotenv and uses a synthetic spend path", async () => {
  const dir = mkdtempSync(`${TEST_STORE_DIR}/dotenv-canary-`)
  try {
    writeFileSync(`${dir}/.env`, "REVIEW_SYNTHETIC_CANARY=synthetic-only\n", { mode: 0o600 })
    const command = 'console.log(JSON.stringify({canary:process.env.REVIEW_SYNTHETIC_CANARY ?? "absent",ledger:process.env.SPEND_LEDGER}))'
    const control = Bun.spawn([process.execPath, "--eval", command], { cwd: dir, env: { TMPDIR: dir, HOME: dir, SPEND_LEDGER: `${dir}/control-spend.jsonl` }, stdout: "pipe", stderr: "pipe" })
    const guarded = routeChild(command, [], dir)
    const [controlOut, guardedOut, controlErr, guardedErr, controlCode, guardedCode] = await Promise.all([
      new Response(control.stdout).text(), new Response(guarded.stdout).text(), new Response(control.stderr).text(), new Response(guarded.stderr).text(), control.exited, guarded.exited,
    ])
    expect(controlCode).toBe(0)
    expect(guardedCode).toBe(0)
    expect(controlErr).toBe("")
    expect(guardedErr).toBe("")
    expect(JSON.parse(controlOut).canary).toBe("synthetic-only")
    expect(JSON.parse(guardedOut)).toEqual({ canary: "absent", ledger: `${TEST_STORE_DIR}/route-spend.jsonl` })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("desktop identity is required, bound to worker/run/agent, and never enters events", async () => {
  const f = fixture()
  try {
    for (const identity of [undefined, null, [], "unscoped", {}, { id: "" }, { id: "x".repeat(129) }, { id: "valid", epoch: 7 }, { id: "valid", extra: true }]) {
      await expect(f.api.desktop("r1", "a-1", true, "https://console.example", identity)).rejects.toThrow("identity")
      await expect(f.api.close("r1", "a-1", identity)).rejects.toThrow("identity")
    }
    expect(f.log).toEqual([])
    const watched = await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    expect(watched.desktop).toEqual({ id: f.scope.id, epoch: "epoch-1" })
    await f.api.desktop("r1", "a-1", false, "https://console.example", watched.desktop)
    const before = f.log.length
    await f.api.close("r1", "a-1", { id: f.scope.id, epoch: "old-worker" })
    await expect(f.api.close("r2", "a-1", watched.desktop)).rejects.toThrow("run")
    await expect(f.api.close("r1", "a-2", watched.desktop)).rejects.toThrow("free-roam")
    expect(f.log.slice(before)).toEqual([])
    expect(f.events.at(-1).viewOnly).toBe(false)
    expect(JSON.stringify(f.events)).not.toContain(f.scope.id)
    expect(JSON.stringify(f.events)).not.toContain("epoch-1")
    await f.api.close("r1", "a-1", watched.desktop)
    expect(f.log.slice(-3)).toEqual(["close", "revoke", "resume"])
  } finally { await f.end() }
})

test("cancellation before its POST retires only that request and cannot affect another setup", async () => {
  const f = fixture({ timeoutMs: 1000 })
  try {
    const cancelled = { id: "cancelled-before-post" }
    expect(await f.api.close("r1", "a-1", cancelled)).toEqual({ kind: "closed" })
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example", cancelled)).rejects.toThrow("retired")
    expect(f.log).toEqual([])
    const watched = await f.api.desktop("r1", "a-1", true, "https://console.example", f.scope)
    f.ack(false)
    const take = outcome(f.api.desktop("r1", "a-1", false, "https://console.example", watched.desktop))
    await tick()
    const before = f.log.length
    await f.api.close("r1", "a-1", cancelled)
    expect(f.log.slice(before)).toEqual([])
    const pause = f.lines.at(-1).roamControl
    f.api.consume(f.run, f.child, "epoch-1", { ev: "roam-control", ...pause, ok: true, state: "paused" })
    expect((await take).value.viewOnly).toBe(false)
    f.ack(true)
    await f.api.close("r1", "a-1", watched.desktop)
    expect(f.log.slice(-3)).toEqual(["close", "revoke", "resume"])
  } finally { await f.end() }
})

test("unowned Watch cannot replace another session and a genuine delayed capability is revoked on cancellation", async () => {
  const f = fixture()
  const held = holdRequest(f, "open")
  const setup = outcome(f.api.desktop("r1", "a-1", true, "https://console.example", f.scope))
  try {
    await held.started
    const cancelling = outcome(f.api.close("r1", "a-1", f.scope))
    held.release()
    expect((await setup).error).toBeDefined()
    expect((await cancelling).value).toEqual({ kind: "closed" })
    expect(f.log.slice(-2)).toEqual(["close", "revoke"])
    const next = { id: "new-session" }
    await f.api.desktop("r1", "a-1", true, "https://console.example", next)
    await f.api.desktop("r1", "a-1", false, "https://console.example", next)
    const before = f.log.length
    await expect(f.api.desktop("r1", "a-1", true, "https://console.example", { id: "foreign-session" })).rejects.toThrow("Another desktop")
    await f.api.close("r1", "a-1", f.scope)
    expect(f.log.slice(before)).toEqual([])
    expect(f.events.at(-1).viewOnly).toBe(false)
  } finally { held.release(); await setup; await f.end() }
})

test("real host expiry during another agent's invalidation cannot crash or release a newer session", async () => {
  const source = String.raw`
    import assert from "node:assert/strict";
    import {setTimeout as sleep} from "node:timers/promises";
    import {createRoamControlApi} from ${JSON.stringify(new URL("../server/roam-control.mjs", import.meta.url).href)};
    const stage = process.argv[1];
    const entered = Promise.withResolvers(), released = Promise.withResolvers();
    const live = new Map(), revoked = new Map(), closed = new Map(), actions = [], events = [];
    let api, boot = 1, finished = false, pending, invalidating;
    const run = {id:"r1",owner:{},ws:"/synthetic",status:"running",roamEpoch:"epoch-1",events:["a-1","a-2"].map(id=>({ev:"subagent-spawned",id,loadout:"free-roam",t:1}))};
    function child(epoch) {
      const worker = {stdin:{writable:true,write(raw,callback) {
        callback?.();const q = JSON.parse(raw).roamControl;
        if(q) {
          actions.push(q.op);
          queueMicrotask(()=>api.consume(run,worker,epoch,{ev:"roam-control",...q,ok:true,state:q.op==="pause"?"paused":q.op==="cancel"?"closed":"running"}));
        }
      }}};
      return worker;
    }
    function machine(agent) {
      let expires, token = null, sequence = 0, state = "closed";
      return {
        id:agent+"-machine",
        async request(bytes) {
          const q=JSON.parse(bytes);actions.push(agent+":"+q.action);
          if(q.action==="configure") {
            assert.equal(state,"closed");state="configured";token=null;
            expires=Date.now()+(boot===1&&agent==="a-1"?2000:20000);
            return {kind:"configured",port:9876,expires};
          }
          if(q.action==="open") {
            assert.equal(state,"configured");state="open";
            return {kind:"open",port:9876,expires,viewOnly:q.viewOnly};
          }
          assert.equal(q.action,"close");state="closed";
          if(token) closed.set(token,(closed.get(token)??0)+1);
          return {kind:"closed"};
        },
        async previewGrant() {
          token=boot+"-"+agent+"-"+(++sequence);live.set(token,agent);actions.push(agent+":grant");
          const grant={url:"https://synthetic.invalid/",expires,revokeToken:token};
          if(boot===1&&agent==="a-2"&&stage==="grant") {entered.resolve();await released.promise}
          return grant;
        },
        async expirePreview(port,value) {
          assert.equal(port,9876);assert.equal(live.get(value),agent);
          live.delete(value);revoked.set(value,(revoked.get(value)??0)+1);actions.push(agent+":revoke");
        },
      };
    }
    const a=machine("a-1"), b=machine("a-2");
    api=createRoamControlApi({
      getRun:id=>id===run.id?run:null,emit:(_,event)=>events.push(event),
      machine:async(_,agent)=>{
        if(boot===1&&agent==="a-2"&&stage==="lookup") {entered.resolve();await released.promise}
        return agent==="a-1"?a:b;
      },
    }); // Real Date.now, setTimeout and clearTimeout; no timer or exception interception.
    run.child=child(run.roamEpoch);api.begin(run,run.child,run.roamEpoch);
    try {
      const watched=await api.desktop("r1","a-1",true,"https://console.invalid",{id:"old-watch"});
      pending=api.desktop("r1","a-2",true,"https://console.invalid",{id:"pending-watch"}).then(value=>({value}),error=>({error}));
      await entered.promise;
      const oldTokens=[...live.keys()], before=actions.length;
      invalidating=api.invalidate(run,run.child,run.roamEpoch).then(()=>{finished=true});
      await sleep(Math.max(0,watched.expires-Date.now())+60);
      assert(Date.now()>=watched.expires);
      assert.equal(finished,false);assert.deepEqual(actions.slice(before),[]);
      assert.deepEqual([...live.keys()],oldTokens);
      released.resolve();
      assert((await pending).error);await invalidating;
      assert.equal(finished,true);assert.equal(live.size,0);
      assert.equal(oldTokens.length,stage==="grant"?2:1);
      for(const token of oldTokens) {assert.equal(revoked.get(token),1);assert.equal(closed.get(token),1)}
      assert(!actions.includes("resume"));
      boot=2;run.roamEpoch="epoch-2";run.child=child(run.roamEpoch);api.begin(run,run.child,run.roamEpoch);
      const newer=await api.desktop("r1","a-1",true,"https://console.invalid",{id:"new-watch"});
      await api.desktop("r1","a-1",false,"https://console.invalid",newer.desktop);
      const marker=actions.length;
      await api.close("r1","a-1",watched.desktop);
      await sleep(20);
      assert.deepEqual(actions.slice(marker),[]);assert.equal(live.size,1);
      assert.equal(events.at(-1).viewOnly,false);
      await api.invalidate(run,run.child,run.roamEpoch);
      assert.equal(live.size,0);assert(!actions.includes("resume"));
      for(const count of revoked.values()) assert.equal(count,1);
      for(const count of closed.values()) assert.equal(count,1);
      console.log(JSON.stringify({stage,expiredWhileRetired:true,oldGrantsCleaned:oldTokens.length,newControlUntouched:true,unexpectedResume:false}));
    } finally {
      released.resolve();
      await pending;
      await invalidating;
      await api.invalidate(run);
    }
  `
  const node = Bun.which("node")
  expect(node).toBeTruthy()
  const checks = []
  for (const runtime of [process.execPath, node]) {
    for (const stage of ["lookup", "grant"]) {
      const dir = mkdtempSync(`${TEST_STORE_DIR}/real-expiry-`)
      const flags = runtime === process.execPath ? ["--no-env-file"] : ["--input-type=module"]
      const child = Bun.spawn([runtime, ...flags, "--eval", source, stage], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, SPEND_LEDGER: `${dir}/spend.jsonl`, TOUCHSTONE_GRANT_TOKEN: "test-grant-token", TOUCHSTONE_GRANT_TOKEN_FILE: `${dir}/console-token`, TOUCHSTONE_GRANTS_FILE: `${dir}/grants.json`, TOUCHSTONE_SCOPES_FILE: `${dir}/scopes.json`, TOUCHSTONE_PROVIDERS_FILE: `${dir}/providers.json`, TOUCHSTONE_RESULTS_DIR: `${dir}/results` },
        stdout: "pipe", stderr: "pipe",
      })
      checks.push((async () => {
        try {
          const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
          expect(err).toBe("")
          expect(code).toBe(0)
          expect(JSON.parse(out)).toEqual({ stage, expiredWhileRetired: true, oldGrantsCleaned: stage === "grant" ? 2 : 1, newControlUntouched: true, unexpectedResume: false })
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })())
    }
  }
  await Promise.all(checks)
}, 15000)
