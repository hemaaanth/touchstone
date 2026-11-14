import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO, demoConfig, demoEnvironment } from "../server/demo-config.mjs";
import { createDemoHandler, demoRoute, demoSessions, demoStarts, sessionSecret } from "../server/demo-http.mjs";
import { createDemoServerHandler, demoAssets, startDemoServer } from "../server/demo-server.mjs";
import { armDemoDeadline, closeDemoRun, demoFence, demoProve } from "../server/demo-lifecycle.mjs";
import { startServer } from "../server/start.mjs";

const env = (stateDir) => ({ TOUCHSTONE_DEMO: "1", TOUCHSTONE_DEMO_ORIGIN: "https://touchstone.hem.so", TOUCHSTONE_DEMO_STATE_DIR: stateDir, SPEND_CAP_USD: "20", FLEET_MAX: "3" });
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), "demo-policy-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, config: demoConfig(env(dir)) }; }
export class Response extends EventEmitter {
  statusCode = 0; headers = {}; text = "";
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  flushHeaders() { this.headersSent = true; }
  write(text) { this.text += text; return true; }
  end(text = "") { this.text += text; this.emit("close"); }
  get json() { return JSON.parse(this.text); }
}
export async function request(handler, { method = "GET", url = "/api/runs", cookie, data, headers = {}, ip = "127.0.0.1" } = {}) {
  const req = Readable.from(data === undefined ? [] : [typeof data === "string" ? data : JSON.stringify(data)]);
  Object.assign(req, { method, url, socket: { remoteAddress: ip }, headers: { ...(cookie ? { cookie } : {}), ...(method === "POST" ? { origin: "https://touchstone.hem.so", "content-type": "application/json" } : {}), ...headers } });
  const res = new Response(); await handler(req, res); return res;
}
const cookieOf = (res) => res.headers["set-cookie"].split(";")[0];
const requestId = "11111111-2222-4333-8444-555555555555";

test("corrupt private provider configuration fails startup before backend loading or listening", async (t) => {
  const { config } = fixture(t);
  const values = demoEnvironment(config);
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  writeFileSync(config.stores.TOUCHSTONE_PROVIDERS_FILE, "not-json", { mode: 0o600 });
  await assert.rejects(startDemoServer(config, {}), SyntaxError);
  writeFileSync(config.stores.TOUCHSTONE_PROVIDERS_FILE, "[]", { mode: 0o600 });
  await assert.rejects(startDemoServer(config, {}), /Invalid demo provider config/);
});

test("demo opt-in is strict, local stores cannot inherit owner paths, and insecure origin needs explicit loopback test mode", (t) => {
  const { dir, config } = fixture(t);
  assert.equal(demoConfig({}), null); assert.equal(demoConfig({ TOUCHSTONE_DEMO: "0" }), null);
  for (const patch of [{ TOUCHSTONE_DEMO: "true" }, { TOUCHSTONE_DEMO_ORIGIN: undefined }, { TOUCHSTONE_DEMO_ORIGIN: "http://touchstone.hem.so" }, { TOUCHSTONE_DEMO_ORIGIN: "https://touchstone.hem.so/" }, { TOUCHSTONE_DEMO_ORIGIN: "https://user:pass@touchstone.hem.so" }, { TOUCHSTONE_DEMO_ORIGIN: "https://touchstone.hem.so?x=y" }, { SPEND_CAP_USD: "Infinity" }, { SPEND_CAP_USD: undefined }, { SPEND_CAP_USD: "0" }, { PROVIDER: "boundless" }, { TOUCHSTONE_EXEC: "daytona" }, { FLEET_MAX: "50" }, { TOUCHSTONE_DEMO_PROXY_IP: "127.0.0.1, 1.2.3.4" }, { TOUCHSTONE_DEMO_ASSETS_DIR: "relative" }, { HOST: "0.0.0.0" }, { TOUCHSTONE_PROVIDERS_FILE: "/owner/providers.json" }, { AGENT_RESULTS_DIR: "/owner/results" }]) assert.throws(() => demoConfig({ ...env(dir), ...patch }));
  const insecure = demoConfig({ ...env(dir), TOUCHSTONE_DEMO_ORIGIN: "http://127.0.0.1:5190", TOUCHSTONE_DEMO_TEST_HTTP: "1" });
  assert.equal(insecure.secure, false);
  assert.throws(() => demoConfig({ ...env(dir), TOUCHSTONE_DEMO_ORIGIN: "http://example.com", TOUCHSTONE_DEMO_TEST_HTTP: "1" }));
  assert.equal(demoEnvironment(config).AGENT_RESULTS_DIR, join(dir, "results"));
});

test("signed host-only cookies survive restart; malformed, unsigned, appended and expired cookies cannot choose ownership", (t) => {
  const { config } = fixture(t); let now = 1800000000000;
  const sessions = demoSessions(config, undefined, () => now); const res = new Response();
  const owner = sessions.session({ headers: {} }, res), cookie = cookieOf(res);
  assert.match(res.headers["set-cookie"], /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure$/);
  assert(!res.headers["set-cookie"].includes("Domain="));
  const restored = demoSessions(config, undefined, () => now);
  assert.equal(restored.session({ headers: { cookie } }, new Response()), owner);
  assert.equal(restored.requestId(owner, requestId), sessions.requestId(owner, requestId));
  for (const bad of [cookie + ".extra", cookie.replace(/.$/, "z"), "__Host-touchstone-demo=chosen", cookie + "; " + cookie]) assert.notEqual(restored.session({ headers: { cookie: bad } }, new Response()), owner);
  now += 86400_001; assert.notEqual(restored.session({ headers: { cookie } }, new Response()), owner);
  const other = restored.session({ headers: {} }, new Response()); assert.notEqual(restored.requestId(other, requestId), restored.requestId(owner, requestId));
  writeFileSync(config.secretFile, "bad"); assert.throws(() => sessionSecret(config.secretFile));
});

test("IP quota uses only socket IP or validated X-Real-IP from an explicit proxy", (t) => {
  const { config } = fixture(t), secret = "a".repeat(64);
  const direct = demoSessions(config, secret), proxy = demoSessions({ ...config, proxyIp: "127.0.0.1" }, secret);
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(direct.ip(req("127.0.0.1", { "x-real-ip": "1.2.3.4", "x-forwarded-for": "8.8.8.8" })), direct.ip(req("127.0.0.1")));
  assert.equal(proxy.ip(req("127.0.0.1", { "x-real-ip": "1.2.3.4", "x-forwarded-for": "8.8.8.8" })), direct.ip(req("1.2.3.4")));
  assert.throws(() => proxy.ip(req("127.0.0.1", { "x-real-ip": "1.2.3.4, 8.8.8.8" })));
  assert.throws(() => proxy.ip(req("127.0.0.1")));
  assert.equal(proxy.ip(req("10.0.0.1", { "x-real-ip": "1.2.3.4" })), direct.ip(req("10.0.0.1")));
  assert.equal(direct.ip(req("::ffff:127.0.0.1")), direct.ip(req("127.0.0.1")));
  assert.equal(direct.ip(req("2001:db8::1")), direct.ip(req("2001:0db8:0:0:0:0:0:1")));
});

test("exact route and query allowlist denies owner and malformed routes", () => {
  for (const path of ["/api/settings", "/api/grants", "/api/stores", "/api/console-token/rotate", "/api/runs/a/steer", "/api/runs/a/ask", "/api/runs/a/desktop", "/api/runs/a/session-artifacts", "/api/runs/a/delete", "/api/runs/a/archive", "/api/runs/a/rename", "/api/findings/a/dismiss", "/api/scopes/a", "/api/nope", "/api//runs", "/api/runs/", "/api/runs/%61", "/api/runs/%2f", "/api/runs/%ZZ", "/api/runs/../runs", "/api/runs/a/more", "/api/runs?requestId=" + requestId + "&requestId=" + requestId, "/api/runs?other=1", "/api/runs?requestId=" + requestId + "&", "/api/runs/a/stream?since=-1", "/api/findings/a?events=2", "/api/findings/a/report?format=evil", "/api/runs/a?", "/api/runs?requestId=" + requestId + "??"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) assert.equal(demoRoute(method, path), null, `${method} ${path}`);
  }
  assert.equal(demoRoute("GET", `/api/runs?requestId=${requestId}`).kind, "runs");
  assert.equal(demoRoute("POST", "/api/runs").kind, "start");
  assert.equal(demoRoute("GET", "/api/findings/a/report?format=bundle-check").kind, "report");
});

function fakeBackend() {
  const rows = new Map(); let seq = 0;
  const visible = ({ id, scope, status }) => ({ id, scope, status });
  return { rows,
    demoCatalog: () => ({ demo: DEMO, models: [], targets: [], packs: [], provider: { id: "near" }, spend: {} }),
    runOwnedBy: (id, owner) => rows.get(id)?.ownerHash === owner,
    listRuns: () => [...rows.values()].map(visible),
    getRun: (id) => rows.has(id) ? visible(rows.get(id)) : null,
    getRunByRequest: (id) => { const row = [...rows.values()].find((r) => r.requestId === id); return row ? visible(row) : null; },
    demoBusy: () => [...rows.values()].some((r) => r.status === "starting"),
    acceptRun: (options) => { const row = { ...options, id: `run-${++seq}`, scope: { id: options.targetId }, status: "starting" }; rows.set(row.id, row); return visible(row); },
    stopRun: (id) => { rows.get(id).status = "stopped"; return { ok: true }; },
    subscribe: (_id, emit) => { emit({ ev: "closed" }); return () => {}; },
  };
}

test("two sessions share no run or recovery, concurrent starts admit one, retries precede quota, quota persists across restart", async (t) => {
  const { config } = fixture(t), backend = fakeBackend();
  let handler = createDemoHandler(config, backend, {}, () => assert.fail("Unexpected report"));
  const a = cookieOf(await request(handler)), b = cookieOf(await request(handler));
  const start = (cookie, uuid = requestId) => request(handler, { method: "POST", data: { targetId: "vault-reentrancy", requestId: uuid }, cookie });
  const concurrent = await Promise.all([start(a), start(b)]);
  assert.deepEqual(concurrent.map((r) => r.statusCode), [201, 429]); assert.equal(concurrent[1].json.code, "demo_busy");
  const id = concurrent[0].json.id;
  assert.equal((await start(a)).json.id, id);
  assert.equal((await request(handler, { cookie: b, url: `/api/runs/${id}` })).statusCode, 404);
  assert.equal((await request(handler, { cookie: b, url: `/api/runs/${id}/stream` })).statusCode, 404);
  assert.equal((await request(handler, { cookie: b, method: "POST", data: {}, url: `/api/runs/${id}/stop` })).statusCode, 404);
  assert.equal((await request(handler, { cookie: b, url: `/api/runs?requestId=${requestId}` })).statusCode, 404);
  assert.deepEqual((await request(handler, { cookie: b })).json, { runs: [] });
  backend.stopRun(id); const ownB = await start(b); assert.equal(ownB.statusCode, 201); assert.notEqual(ownB.json.id, id); backend.stopRun(ownB.json.id);
  const second = await start(a, "21111111-2222-4333-8444-555555555555"); assert.equal(second.statusCode, 201); backend.stopRun(second.json.id);
  handler = createDemoHandler(config, backend, {}, () => {});
  const limited = await start(a, "31111111-2222-4333-8444-555555555555"); assert.equal(limited.statusCode, 429); assert.equal(limited.json.code, "demo_rate_limited");
  assert.equal((await start(a)).json.id, id);
  for (const row of backend.rows.values()) {
    assert.equal(row.alias, "ds-abl"); assert.equal(row.mode, "fleet"); assert.equal(row.freeRoam, false); assert.deepEqual(row.modules, []); assert.deepEqual(row.options, []); assert.equal(row.pack, "contracts"); assert.equal(row.budgetUsd, 1);
  }
  assert.equal((await request(handler, { cookie: a, url: `/api/runs?requestId=${requestId}` })).json.run.id, id);
});

test("body, content type and origin restrictions run before execution", async (t) => {
  const { config } = fixture(t), backend = fakeBackend(), handler = createDemoHandler(config, backend, {}, () => {});
  const cookie = cookieOf(await request(handler));
  for (const data of [{ targetId: "vault-reentrancy", requestId, alias: "qwen" }, { targetId: "custom", requestId }, { targetId: "vault-reentrancy", requestId: "invalid" }, [], null, "{"]) assert.equal((await request(handler, { method: "POST", cookie, data })).statusCode, 400);
  assert.equal((await request(handler, { method: "POST", cookie, data: "a".repeat(1025) })).statusCode, 413);
  assert.equal((await request(handler, { method: "POST", cookie, data: {}, headers: { "content-type": "text/plain" } })).statusCode, 415);
  assert.equal((await request(handler, { method: "POST", cookie, data: {}, headers: { origin: undefined } })).statusCode, 403);
  assert.equal((await request(handler, { cookie, headers: { origin: "https://evil.test" } })).statusCode, 403);
  assert.equal(backend.rows.size, 0);
});

test("session and IP start caps fail closed on corrupt persisted state", (t) => {
  const { config } = fixture(t), owner = "a".repeat(64), ip = "b".repeat(64);
  const starts = demoStarts(config.ratesFile); starts.reserve(owner, ip); starts.reserve(owner, ip);
  assert.throws(() => starts.reserve(owner, ip), { status: 429 });
  for (let i = 0; i < 3; i++) starts.reserve(String(i).repeat(64), ip);
  assert.throws(() => demoStarts(config.ratesFile).reserve("c".repeat(64), ip), { status: 429 });
  writeFileSync(config.ratesFile, "{}"); assert.throws(() => demoStarts(config.ratesFile));
});

test("production serves only inventoried built files, injects demo metadata without console token, and refuses source and fallback routes", async (t) => {
  const { dir, config } = fixture(t), dist = join(dir, "dist"); mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<html><head><script type="module" src="/assets/app-a.js"></script></head><body>Demo</body></html>');
  writeFileSync(join(dist, "assets", "app-a.js"), "console.log('built')"); writeFileSync(join(dist, "assets", "app-a.js.map"), "private map"); writeFileSync(join(dist, "source.ts"), "private source");
  const api = createDemoHandler(config, fakeBackend(), {}, () => {}), handler = createDemoServerHandler(config, api, demoAssets(dist));
  const page = await request(handler, { url: "/" }); assert.equal(page.statusCode, 200); assert.match(page.text, /name="touchstone-demo" content='\{"budgetUsd":1,"maxMinutes":10\}'/); assert(!page.text.includes("console-token")); assert.equal(page.headers["cache-control"], "no-store");
  assert.equal((await request(handler, { url: "/assets/app-a.js" })).statusCode, 200);
  for (const url of ["/@vite/client", "/@fs/etc/passwd", "/src/main.tsx", "/server/runs.mjs", "/source.ts", "/assets/app-a.js.map", "/assets/app-a.js?x=1", "/anything", "/api/settings", "/.env.local", "/../index.html", "/%2e%2e/index.html"]) assert.equal((await request(handler, { url })).statusCode, 404, url);
  symlinkSync(join(dist, "source.ts"), join(dist, "assets", "linked.js")); assert.throws(() => demoAssets(dist)); rmSync(join(dist, "assets", "linked.js"));
  writeFileSync(join(dist, "index.html"), '<html><head></head><script src="/src/main.tsx"></script></html>'); assert.throws(() => demoAssets(dist));
});

test("work deadline fences setup/proof, discards late proof and requests cancellation", async () => {
  let now = 1000; const run = { ownerHash: "a".repeat(64), deadlineAt: 1100 };
  assert.equal(demoFence(run, () => now), false);
  let calls = 0;
  assert.deepEqual(await demoProve(run, [1, 2], async (found) => { calls++; now = 1200; return found; }, () => now), []);
  assert.equal(calls, 1); assert.equal(run.stopping, true);
  const timerRun = { id: "expired", ownerHash: "a".repeat(64), deadlineAt: Date.now() + 5 }; let stopped;
  armDemoDeadline(timerRun, (id) => { stopped = id; }); await new Promise((r) => setTimeout(r, 15)); assert.equal(stopped, "expired"); closeDemoRun(timerRun); assert.equal(timerRun.demoClosed, true);
});

test("owner launcher keeps the existing Vite path when demo is disabled", async () => {
  const calls = [], server = { listen: async () => calls.push("listen"), close: async () => calls.push("close") };
  assert.equal(await startServer({ TOUCHSTONE_VITE_CACHE_DIR: "/private/cache" }, async (config) => { assert.equal(config.server.host, "127.0.0.1"); calls.push("create"); return server; }), server);
  assert.deepEqual(calls, ["create", "listen"]);
});
