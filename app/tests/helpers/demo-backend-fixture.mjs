// Invoked in a private Node process. No real worker, model, network, dotenv or owner store.
import { mock } from "node:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { join } from "node:path";
const [phase, directory] = process.argv.slice(2);
const base = new URL("../../server/runs.mjs", import.meta.url);
const { demoConfig, demoEnvironment } = await import("../../server/demo-config.mjs");
const config = demoConfig({ TOUCHSTONE_DEMO: "1", TOUCHSTONE_DEMO_STATE_DIR: directory, TOUCHSTONE_DEMO_ORIGIN: "https://touchstone.hem.so", SPEND_CAP_USD: "20" });
Object.assign(process.env, demoEnvironment(config), { TOUCHSTONE_DEMO: "1", SPEND_CAP_USD: "20" });
fs.mkdirSync(config.stores.TOUCHSTONE_RESULTS_DIR, { recursive: true });
const realResources = phase.startsWith("resources") ? await import("../../../spike/lib/demo-resources.mjs") : null;
globalThis.fetch = () => { throw Error("Network forbidden"); };
globalThis.__touchstoneRuns = { runs: new Map(), retry: null, swept: true };
const nativeFs = { ...fs }, nativeFsp = { ...fsp };
delete nativeFs.default; delete nativeFsp.default;
const reads = [];
mock.module("node:fs", { exports: { ...nativeFs, existsSync(file) { if (String(file).endsWith("/.env.local")) throw Error("Dotenv forbidden"); return nativeFs.existsSync(file); }, readFileSync(file, ...rest) { if (String(file).endsWith("/.env.local")) throw Error("Dotenv forbidden"); return nativeFs.readFileSync(file, ...rest); } } });
mock.module("node:fs/promises", { exports: { ...nativeFsp, readFile(file, ...rest) { reads.push(String(file)); return nativeFsp.readFile(file, ...rest); } } });
let reachWait, reachStarted = 0, workspaceCalls = 0, workerCalls = 0, cleanupWait;
const children = [];
const spawnFake = () => {
  workerCalls++; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit("exit", null, signal)); return true; };
  children.push(child); return child;
};
mock.module("node:child_process", { exports: { spawn: spawnFake } });
assert.equal((await import("node:child_process")).spawn, spawnFake);
const target = (id) => ({ id, title: id, kind: "lab", pack: "contracts", links: [] });
const provider = { id: "near", label: "NEAR AI Cloud", baseUrl: "https://cloud-api.near.ai/v1", models: { "ds-abl": { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated", input: .3, output: 1.2 } } };
const allowed = {
  readConfig: () => ({}), activeProvider: () => provider, allProviders: () => ({ near: provider }), defaultAlias: () => "ds-abl", providerSetupError: () => null,
  appRunBudgetUsd: () => 1, appSpendCapUsd: () => 20, spendCapRefusal: () => null, totalSpendState: () => ({ usd: 0, capUsd: 20, ledgerError: null }), validateRunBudget: (n) => n,
  listTargets: () => [target("vault-reentrancy"), target("vault-accounting")], pickTarget: ({ id }) => target(id), withPack: (t) => t, targetSummary: (t) => t,
  briefOf: () => "", enforceReach: () => ({ grants: [] }), openReach: async () => {
    reachStarted++;
    // Ownership must already be in the real checkpoint before any setup starts.
    const checkpoints = fs.readdirSync(config.stores.TOUCHSTONE_RESULTS_DIR).filter((f) => f.endsWith(".state.json"));
    assert(checkpoints.some((file) => /^[a-f0-9]{64}$/.test(JSON.parse(fs.readFileSync(join(config.stores.TOUCHSTONE_RESULTS_DIR, file), "utf8")).ownerHash)));
    await reachWait; return { env: {}, stop: async () => {} };
  },
  prepareRunWorkspace: async () => { workspaceCalls++; const ws = join(directory, `workspace-${workspaceCalls}`); fs.mkdirSync(ws, { recursive: true }); return ws; },
  cleanupWorkspace: async (ws) => { await cleanupWait; if (typeof ws === "string") fs.rmSync(ws, { recursive: true, force: true }); },
  readTouchstone: () => ({ pack: "contracts" }), closeRun: async () => {},
  planModules: () => [{ id: "agent", on: true, mandatory: true }, { id: "replay", on: true, mandatory: true }, { id: "slither", on: false }], modulesEvent: (modules) => ({ ev: "modules", modules }),
  PACKS: { contracts: { id: "contracts" } }, packList: () => [{ id: "contracts", title: "Contracts" }], packFor: () => ({ prepass: async () => ({ record: null, env: {} }), teardown: async () => {}, prove: async (_ws, found) => found }),
  sortFindings: (list) => list, sourceCoverage: () => ({}), coverageFailure: () => null, leadsFrom: () => [],
  isProven: (f) => Boolean(f?.proof?.pass), proofKind: () => "forge", proofView: () => null, withProven: (rows) => rows ?? [],
  scopeEnv: () => ({}), prepassViewOf: () => null, prepassFailed: () => ({}),
  candidatesOf: (events) => events.filter((e) => e.ev === "candidate"), agentFindingsOf: () => [], dropMeasuredSubmitted: () => {},
  createSessionArtifactsApi: () => () => { throw Error("Artifacts forbidden"); }, recordCandidates: (run) => run.candidates ?? [],
  recordMeasured: (_run, findings) => findings, supersedeProven: () => {}, measuredAtLoad: () => {},
  isMeasured: (f) => f?.measured === true, isCandidate: (f) => f?.kind === "candidate", makeCandidate: (c) => c, makeAgentFinding: () => null, measuredRule: () => null,
  measuredOfRecord: (_id, r) => ({ ids: new Set(r.measuredMock ? [`${_id}.1`] : []), candidates: [] }), recordRowOf: () => ({}),
  readableTitle: (t) => t,
  createRoamControlApi: () => ({ invalidate: async () => {}, assertIdle() {}, begin() {}, consume() { return false; } }),
  roamSelection: (freeRoam, options) => ({ freeRoam, options }),
  checkRecordedReplays: async () => {}, pruneReplayStore: () => {},
  checkDemoResourceRuntime: () => {},
  createDemoResources: (file) => { fs.writeFileSync(file, JSON.stringify({ complete: false })); return { file, namespace: "a".repeat(64) }; },
  demoResourcesComplete: (ctx) => Boolean(ctx?.file && JSON.parse(fs.readFileSync(ctx.file, "utf8")).complete),
  registerDemoDirectory: (_ctx, dir) => dir,
  withDemoResources: (_ctx, fn) => fn(),
  reopenDemoResources: (ctx) => fs.writeFileSync(ctx.file, JSON.stringify({ complete: false })),
  spawnDemoWorker: (ctx) => { const child = spawnFake(); child.context = ctx; return child; },
  settleDemoResources: async (ctx) => {
    if (!ctx) throw Error("Missing execution ownership");
    for (const child of children) if (child.context?.file === ctx.file && child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    fs.writeFileSync(ctx.file, JSON.stringify({ complete: true }));
  },
};
if (realResources) Object.assign(allowed, realResources, {
  spawnDemoWorker: (ctx, _engine, args, options) => {
    workerCalls++;
    return realResources.spawnDemoWorker(ctx, new URL("./demo-forge-worker.mjs", import.meta.url).pathname, ["forge", args[3], join(directory, "producer-result.json")], options);
  },
});
// Mock unrelated imports before loading runs. Keep real persistence, routing,
// finding readers, reports, and demo policy. Every unexpected call fails.
const imports = [...fs.readFileSync(base, "utf8").matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^\"]+)"/g)];
for (const match of imports) {
  const spec = match[2];
  if (!spec.startsWith(".") || ["./findings.mjs", "./settings.mjs", "../../spike/lib/daytona-setup.mjs"].includes(spec) || spec.startsWith("./demo-")) continue;
  const exports = Object.fromEntries(match[1].split(",").map((name) => { name = name.trim().split(/\s+as\s+/)[0]; return [name, allowed[name] ?? (() => { throw Error(`Unexpected dependency ${name}`); })]; }));
  // Findings shares these exports although runs does not import them all.
  if (spec.endsWith("/scopes-store.mjs")) for (const name of ["setScopeBrief", "setScopeNetworkPolicy", "secretContent"]) exports[name] = () => { throw Error("Owner scopes forbidden"); };
  if (spec.endsWith("/candidate.mjs")) Object.assign(exports, Object.fromEntries(["isCandidate", "makeCandidate", "makeAgentFinding", "measuredRule"].map((k) => [k, allowed[k]])));
  if (spec === "./candidates.mjs") Object.assign(exports, { measuredOfRecord: allowed.measuredOfRecord, recordRowOf: allowed.recordRowOf });
  if (spec.endsWith("/proof-view.mjs")) exports.proofView = allowed.proofView;
  mock.module(new URL(spec, base).href, { exports });
}
// HTTP imports extra store/settings exports that must never run in public mode.
const settings = Object.fromEntries(imports.find((m) => m[2] === "./settings.mjs")[1].split(",").map((k) => [k.trim(), allowed[k.trim()]]));
Object.assign(settings, { consoleWriteRefusal: () => null });
for (const name of ["getSettings", "saveProvider", "deleteProvider", "setDefault", "setRunBudget", "discoverModels", "setExecution", "setStrixSettings"]) settings[name] = () => { throw Error("Owner settings forbidden"); };
mock.module(new URL("./settings.mjs", base).href, { exports: settings });
for (const [spec, names] of [["../../spike/lib/grant-store.mjs", ["readGrants", "addGrant", "removeGrant", "grantActive"]], ["../../spike/lib/daytona-setup.mjs", ["requireRoamReady", "discoverRoamSnapshots", "checkRoamSelection", "startRoamSnapshotBuild", "startRoamShellTest", "reconcileRoamShellTest", "reconcileRoamSnapshot", "roamSetupView"]]]) mock.module(new URL(spec, base).href, { exports: Object.fromEntries(names.map((n) => [n, () => { throw Error("Owner store forbidden"); }])) });
const bundleCalls = [];
mock.module(new URL("./replay-bundle.mjs", base).href, { exports: { buildReplayBundle: () => { throw Error("No synthetic replay"); }, loadRecordedReplay: (id) => { bundleCalls.push(id); return {}; }, bundleRefusal: () => "No synthetic replay bundle.", planReplayBundle: () => { throw Error("No synthetic replay"); }, UNJUDGED_NOTE: "" } });
const runs = await import(base.href);
const findings = await import("../../server/findings.mjs");
const { handleFindings } = await import("../../server/runs-http.mjs");
const { createDemoHandler } = await import("../../server/demo-http.mjs");
const handler = createDemoHandler(config, runs, findings, handleFindings);
class Response extends EventEmitter {
  statusCode = 0; headers = {}; text = "";
  setHeader(k, v) { this.headers[k] = v; } flushHeaders() { this.headersSent = true; }
  write(text) { this.text += text; } end(text = "") { this.text += text; this.emit("close"); }
  get json() { return JSON.parse(this.text); }
}
const request = async (url, cookie, method = "GET", data) => {
  const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
  Object.assign(req, { url, method, headers: { cookie, ...(method === "POST" ? { origin: config.origin, "content-type": "application/json" } : {}) }, socket: { remoteAddress: "127.0.0.1" } });
  const res = new Response(); await handler(req, res); return res;
};
const tick = () => new Promise((r) => setTimeout(r, 10));
const rid = "11111111-2222-4333-8444-555555555555";
const stateFile = join(directory, "test-state.json");
const sourceFile = (id) => join(config.stores.TOUCHSTONE_RESULTS_DIR, `run-${id}.json`);
if (phase === "resources" || phase === "resources-recover") {
  const waitFor = async (fn) => { for (let i = 0; i < 500; i++) { if (fn()) return; await tick(); } assert.fail("Resource/API transition did not finish"); };
  const savedFile = join(directory, "resource-api-state.json");
  if (phase === "resources") {
    const cookie = (await request("/api/runs")).headers["set-cookie"].split(";")[0];
    const accepted = await request("/api/runs", cookie, "POST", { targetId: "vault-reentrancy", requestId: rid });
    assert.equal(accepted.statusCode, 201); const id = accepted.json.id;
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(join(process.env.DEMO_TEST_DOCKER, "containers.json"), "utf8")).some((c) => c.State.Running); } catch { return false; } });
    const checkpoint = JSON.parse(fs.readFileSync(join(config.stores.TOUCHSTONE_RESULTS_DIR, `run-${id}.state.json`), "utf8"));
    assert(checkpoint.demoResources.namespace); assert(!JSON.stringify(runs.getRun(id)).includes(checkpoint.demoResources.namespace));
    assert.equal((await request(`/api/runs/${id}/stop`, cookie, "POST", {})).statusCode, 200);
    await waitFor(() => runs.getRun(id).errorInfo?.kind === "cleanup");
    assert.equal(runs.demoBusy(), true); assert.equal(runs.getRun(id).events.some((e) => e.ev === "closed"), false);
    const busy = await request("/api/runs", cookie, "POST", { targetId: "vault-reentrancy", requestId: "21111111-2222-4333-8444-555555555555" });
    assert.equal(busy.statusCode, 429); assert.equal(busy.json.code, "demo_busy");
    fs.writeFileSync(savedFile, JSON.stringify({ cookie, id }));
  } else {
    const { cookie, id } = JSON.parse(fs.readFileSync(savedFile, "utf8"));
    await waitFor(() => !runs.demoBusy());
    assert.equal(workerCalls, 0);
    assert.equal((await request(`/api/runs/${id}`, cookie)).statusCode, 200);
    assert(runs.getRun(id).events.some((e) => e.ev === "closed"));
  }
} else if (phase === "write") {
  const cookie = async () => (await request("/api/runs")).headers["set-cookie"].split(";")[0];
  const a = await cookie(), b = await cookie();
  let releaseReach; reachWait = new Promise((r) => { releaseReach = r; });
  const accepted = await request("/api/runs", a, "POST", { targetId: "vault-reentrancy", requestId: rid });
  assert.equal(accepted.statusCode, 201); const idA = accepted.json.id;
  assert.equal(runs.demoBusy(), true); assert.equal(reachStarted, 1); assert.equal(workerCalls, 0);
  const checkpoint = JSON.parse(fs.readFileSync(join(config.stores.TOUCHSTONE_RESULTS_DIR, `run-${idA}.state.json`), "utf8"));
  assert(/^[a-f0-9]{64}$/.test(checkpoint.ownerHash)); assert(!JSON.stringify(accepted.json).includes(checkpoint.ownerHash));
  assert.equal((await request("/api/runs", a, "POST", { targetId: "vault-reentrancy", requestId: rid })).json.id, idA);
  assert.equal((await request("/api/runs", b, "POST", { targetId: "vault-reentrancy", requestId: rid })).statusCode, 429);
  assert.equal((await request(`/api/runs/${idA}/stop`, b, "POST", {})).statusCode, 404);
  assert.equal((await request(`/api/runs/${idA}/stop`, a, "POST", {})).statusCode, 200);
  releaseReach(); await tick(); assert.equal(workspaceCalls, 0); assert.equal(workerCalls, 0); assert.equal(runs.demoBusy(), false);
  reachWait = undefined;
  const acceptedB = await request("/api/runs", b, "POST", { targetId: "vault-accounting", requestId: rid });
  assert.equal(acceptedB.statusCode, 201); const idB = acceptedB.json.id; assert.notEqual(idA, idB);
  await tick(); assert.equal(workerCalls, 1, JSON.stringify({ phase: globalThis.__touchstoneRuns.runs.get(idB).phase, child: globalThis.__touchstoneRuns.runs.get(idB).child?.constructor?.name, stderr: globalThis.__touchstoneRuns.runs.get(idB).stderr, state: runs.getRun(idB).status }));
  let releaseCleanup; cleanupWait = new Promise((r) => { releaseCleanup = r; });
  assert.equal((await request(`/api/runs/${idB}/stop`, b, "POST", {})).statusCode, 200);
  await tick(); assert.equal(runs.demoBusy(), true); releaseCleanup(); await tick(); cleanupWait = undefined; assert.equal(runs.demoBusy(), false);
  // A real timer stopping setup must prevent workspace and worker creation.
  let releaseLate; reachWait = new Promise((r) => { releaseLate = r; });
  const setupRun = runs.acceptRun({ targetId: "vault-reentrancy", requestId: "21111111-2222-4333-8444-555555555555", ownerHash: checkpoint.ownerHash, deadlineAt: Date.now() + 15, alias: "ds-abl", budgetUsd: 1, mode: "fleet", freeRoam: false, options: [], pack: "contracts", modules: [] });
  await new Promise((r) => setTimeout(r, 30)); assert(runs.getRun(setupRun.id).events.some((e) => e.ev === "stop-requested"));
  releaseLate(); await tick(); assert.equal(workspaceCalls, 1); assert.equal(workerCalls, 1); assert.equal(runs.getRun(setupRun.id).errorInfo.kind, "timeout"); assert.equal(runs.demoBusy(), false);
  reachWait = undefined;
  for (const [id, title] of [[idA, "Visitor A private finding"], [idB, "Visitor B private finding"]]) {
    const result = JSON.parse(fs.readFileSync(sourceFile(id), "utf8")).result;
    Object.assign(result, { findings: [{ title, severity: "high", poc: "Proof", proof: { pass: true, harm: { ok: true }, transfers: [] } }], candidates: [{ kind: "candidate", n: 1, title: title + " candidate", pack: "contracts", poc: "Idea", severity: "low" }] });
    fs.writeFileSync(sourceFile(id), JSON.stringify({ result, transcript: {} }));
  }
  const cleanupRun = runs.acceptRun({ targetId: "vault-reentrancy", requestId: "31111111-2222-4333-8444-555555555555", ownerHash: checkpoint.ownerHash, deadlineAt: Date.now() + 60000, alias: "ds-abl", budgetUsd: 1, mode: "fleet", freeRoam: false, options: [], pack: "contracts", modules: [] });
  await tick();
  let rejectCleanup; cleanupWait = new Promise((_resolve, reject) => { rejectCleanup = reject; });
  assert.equal((await request(`/api/runs/${cleanupRun.id}/stop`, a, "POST", {})).statusCode, 200);
  await tick(); rejectCleanup(new Error("Synthetic cleanup failure")); await tick();
  assert.equal(runs.getRun(cleanupRun.id).errorInfo.kind, "cleanup");
  assert.equal(runs.getRun(cleanupRun.id).events.some((event) => event.ev === "closed"), false);
  assert.equal(runs.demoBusy(), true);
  fs.writeFileSync(stateFile, JSON.stringify({ a, b, idA, idB, owner: checkpoint.ownerHash }));
  for (const stage of ["setup", "prepass", "agent", "proof"]) {
    const id = `interrupted-${stage}-2611141200-99001`;
    const prefix = join(config.stores.TOUCHSTONE_RESULTS_DIR, `run-${id}`);
    fs.writeFileSync(`${prefix}.stream.jsonl`, [{ t: Date.now(), ev: "scope", scope: target("vault-reentrancy") }, { ev: "mode", mode: "solo" }, { ev: "status", status: stage === "proof" ? "deciding" : "starting" }].map((e) => JSON.stringify(e) + "\n").join(""));
    fs.writeFileSync(`${prefix}.state.json`, JSON.stringify({ phase: stage, ownerHash: checkpoint.ownerHash, deadlineAt: Date.now() - 1, demoResources: allowed.createDemoResources(`${prefix}.demo-resources.sqlite`), ws: stage === "setup" ? null : join(directory, `interrupted-${stage}`), target: target("vault-reentrancy"), mode: "solo" }));
  }
} else if (phase === "missing") {
  const { b, idB } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal((await request(`/api/runs/${idB}`, b)).statusCode, 404);
  assert.equal((await request(`/api/runs/${idB}/stream`, b)).statusCode, 404);
  assert.equal(workerCalls, 0);
} else {
  const { a, b, idA, idB, owner } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert(runs.runOwnedBy(idA, owner)); assert.equal(workerCalls, 0); assert.equal(workspaceCalls, 0);
  await tick();
  for (const stage of ["setup", "prepass", "agent", "proof"]) assert.equal(runs.getRun(`interrupted-${stage}-2611141200-99001`).status, "error");
  assert.equal((await request(`/api/runs?requestId=${rid}`, a)).json.run.id, idA);
  assert.equal((await request(`/api/runs?requestId=${rid}`, b)).json.run.id, idB);
  assert.equal((await request(`/api/runs/${idA}`, b)).statusCode, 404);
  assert.equal((await request(`/api/runs/${idA}/stream`, b)).statusCode, 404);
  const stream = await request(`/api/runs/${idA}/stream`, a); assert.equal(stream.statusCode, 200); assert(stream.text.includes('"ev":"closed"')); assert(!stream.text.includes(owner)); stream.end();
  const listed = await request("/api/findings", a); assert.equal(listed.statusCode, 200); assert.equal(listed.json.findings[0].runId, idA); assert.equal(listed.json.candidates[0].runId, idA); assert(!listed.text.includes("Visitor B")); assert(!listed.text.includes(owner));
  for (const format of ["json", "md", "markdown", "html", "agent", "bundle", "zip", "bundle-check"]) {
    reads.length = 0; bundleCalls.length = 0;
    const foreign = await request(`/api/findings/${idB}.1/report?format=${format}`, a);
    assert.equal(foreign.statusCode, 404, format); assert(!foreign.text.includes("Visitor B")); assert(!reads.includes(sourceFile(idB)), format); assert.equal(bundleCalls.length, 0);
    const own = await request(`/api/findings/${idA}.1/report?format=${format}`, a); assert.equal(own.statusCode, ["bundle", "zip", "bundle-check"].includes(format) ? 409 : 200, `${format}: ${own.text}`);
  }
  reads.length = 0;
  const detail = await request(`/api/findings/${idB}.1?events=0`, a); assert.equal(detail.statusCode, 404); assert(!reads.includes(sourceFile(idB)));
  const raw = JSON.parse(fs.readFileSync(sourceFile(idB), "utf8")); raw.result.findings[0].measured = true; raw.result.measuredMock = true; fs.writeFileSync(sourceFile(idB), JSON.stringify(raw));
  const movedForeign = await request(`/api/findings/${idB}.1`, a); assert.equal(movedForeign.statusCode, 404); assert(!movedForeign.json.candidate); assert(!movedForeign.json.runId);
  const movedOwn = await request(`/api/findings/${idB}.1`, b); assert.equal(movedOwn.statusCode, 404); assert.equal(movedOwn.json.candidate, true); assert.equal(movedOwn.json.runId, idB);
  // A missing checkpoint owner never falls back to run-ID or event authorization.
  const file = join(config.stores.TOUCHSTONE_RESULTS_DIR, `run-${idB}.state.json`), saved = JSON.parse(fs.readFileSync(file, "utf8")); delete saved.ownerHash; fs.writeFileSync(file, JSON.stringify(saved));
}
clearInterval(globalThis.__touchstoneRuns.retry);
console.log(JSON.stringify({ phase, workerCalls, workspaceCalls, ok: true }));
