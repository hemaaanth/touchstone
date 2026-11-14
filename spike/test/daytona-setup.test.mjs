import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRoamSelection, startRoamShellTest, startRoamSnapshotBuild, reconcileRoamShellTest, reconcileRoamSnapshot, roamSetupView } from "../lib/daytona-setup.mjs";
import { allRoamOperations, roamBinding, roamSelectionState } from "../lib/daytona-state.mjs";

const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 100; i++) await tick();
}
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "daytona-setup-"));
  const names = ["TOUCHSTONE_DAYTONA_STATE_FILE", "EVENTS_FILE"];
  const old = names.map((k) => process.env[k]);
  process.env.TOUCHSTONE_DAYTONA_STATE_FILE = join(dir, "setup.json");
  process.env.EVENTS_FILE = join(dir, "events.jsonl");
  const config = { backend: "daytona", apiUrl: "https://fixture.test/api", apiKey: "synthetic-key", target: "fixture-region", roamSnapshot: "selected" };
  const machineId = `probe-${randomUUID()}`;
  const f = { calls: [], posts: 0, builds: 0, deletes: 0, cleanupFails: false, uncertain: false, failProbe: false, holdProbe: null, ref: "source-1", sandbox: null, snapshot: null, uploads: new Map(), epoch: 0 };
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status });
  const deps = { fetch: async (url, init) => {
    const u = new URL(url);
    assert.ok(["fixture.test", "tb.fixture.test"].includes(u.hostname), "no real provider call");
    f.calls.push({ path: u.pathname, method: init.method, auth: init.headers.Authorization, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (u.pathname === "/api/regions") return json([{ id: "region-id", name: config.target }]);
    if (u.pathname === "/api/snapshots" && init.method === "POST") {
      f.builds++;
      const body = JSON.parse(init.body);
      f.snapshot = { id: "built-id", ...body, state: "active", regionIds: ["region-id"] };
      if (f.uncertain) throw new Error("synthetic-secret");
      return json(f.snapshot);
    }
    if (u.pathname === "/api/snapshots") return json({ page: 1, totalPages: 1, items: f.snapshot ? [f.snapshot] : [] });
    if (u.pathname.startsWith("/api/snapshots/")) return json(u.pathname.endsWith("built-id") ? f.snapshot : { id: "selected-id", name: "selected", state: "active", regionIds: ["region-id"], sandboxClass: "container", ref: f.ref });
    if (u.pathname === "/api/sandbox" && init.method === "POST") {
      f.posts++;
      const body = JSON.parse(init.body);
      f.sandbox = { id: machineId, toolboxProxyUrl: "https://tb.fixture.test", labels: body.labels };
      if (f.uncertain) throw new Error("synthetic-secret");
      return json(f.sandbox);
    }
    if (u.pathname === "/api/sandbox") return json({ items: f.sandbox && !f.hideMachine ? [f.sandbox] : [] });
    if (u.pathname === `/api/sandbox/${machineId}` && init.method === "GET") return f.sandbox ? json(f.sandbox) : json({}, 404);
    if (u.pathname === `/api/sandbox/${machineId}` && init.method === "DELETE") {
      f.deletes++;
      if (f.cleanupFails) return json({ message: "synthetic-secret" }, 409);
      f.sandbox = null; return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/files/upload-v2")) {
      const path = u.searchParams.get("path");
      if (path.endsWith(".json")) { const q = JSON.parse(await init.body.get("file").text()); f.uploads.set(q.id, q); }
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/process/execute")) {
      const { command } = JSON.parse(init.body);
      if (command.includes("touchstone-prerequisites-ready")) {
        await f.holdProbe?.();
        return json({ exitCode: f.failProbe ? 1 : 0, result: "touchstone-prerequisites-ready" });
      }
      if (command.includes("nohup node")) return json({ exitCode: 0, result: "" });
      if (command.includes("touchstone-egress-ready")) return json({ exitCode: 0, result: "touchstone-egress-ready" });
      if (command.includes("tail -c")) return json({ exitCode: 0, result: Buffer.from(JSON.stringify({ t: 1, host: "127.0.0.1", method: "GET", url: "http://127.0.0.1:12345/touchstone-probe", status: 200, decision: "allow", reason: "free-roam" }) + "\n").toString("base64") });
      const q = f.uploads.get(command.split(" ").at(-1));
      assert.ok(q);
      if (["pause", "resume", "close"].includes(q.op)) f.epoch++;
      return json({ exitCode: 0, result: JSON.stringify({ ok: true, id: q.id, generation: "fixture", epoch: f.epoch, ack: true, scope: "managed-shell", state: q.op === "pause" ? "paused" : q.op === "close" ? "closed" : "active", ...(q.op === "run" ? { exitCode: 0, result: "touchstone-shell-ready" } : {}) }) });
    }
    throw new Error(`Unexpected fixture endpoint ${u.pathname}`);
  } };
  try { await fn({ config, f, deps }); await settle(); }
  finally { names.forEach((key, i) => old[i] == null ? delete process.env[key] : process.env[key] = old[i]); rmSync(dir, { recursive: true, force: true }); }
}

test("status is local only; metadata check never provisions or claims shell readiness", async () => fixture(async ({ config, f, deps }) => {
  assert.equal(roamSetupView(config).ready, false);
  assert.equal(f.calls.length, 0);
  await checkRoamSelection(config, deps);
  assert.equal(roamSetupView(config).state, "needs_test");
  assert.ok(f.calls.every((c) => c.method === "GET"));
}));

test("one explicit test uses actual supervisor exchange, bounded lifetime and confirmed cleanup", async () => fixture(async ({ config, f, deps }) => {
  const id = randomUUID();
  const initial = startRoamShellTest(config, id, deps);
  assert.equal(initial.ready, false);
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, true);
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
  assert.equal(allRoamOperations()[0].phase, "complete");
  const body = f.calls.find((c) => c.method === "POST" && c.path === "/api/sandbox").body;
  assert.deepEqual([body.autoStopInterval, body.autoDeleteInterval, body.ttlMinutes], [5, 0, 10]);
  startRoamShellTest(config, id, deps);
  await settle();
  assert.equal(f.posts, 1, "same request ID cannot provision again after success");
}));

test("failed capabilities cannot become ready even when cleanup succeeds", async () => fixture(async ({ config, f, deps }) => {
  f.failProbe = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, false);
  assert.equal(f.deletes, 1);
  assert.equal(allRoamOperations()[0].probePassed, false);
}));

test("failed cleanup blocks a second test; explicit reconciliation deletes only the saved resource", async () => fixture(async ({ config, f, deps }) => {
  f.cleanupFails = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  const op = allRoamOperations()[0];
  assert.equal(op.phase, "cleanup");
  assert.equal(roamSetupView(config).ready, false);
  startRoamShellTest(config, randomUUID(), deps);
  assert.equal(f.posts, 1);
  await assert.rejects(reconcileRoamShellTest({ ...config, apiKey: "other-key" }, op.id, deps), { code: "daytona_rejected" });
  assert.equal(f.deletes, 1);
  f.cleanupFails = false;
  await reconcileRoamShellTest(config, op.id, deps);
  assert.equal(f.deletes, 2);
  assert.equal(roamSetupView(config).ready, false, "reconciliation cannot manufacture a proof pass");
  assert.equal(allRoamOperations()[0].phase, "complete");
}));

test("a lost create response survives reload and empty listings without another POST", async () => fixture(async ({ config, f, deps }) => {
  f.uncertain = true; f.hideMachine = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  const op = allRoamOperations()[0];
  const restarted = await import(`../lib/daytona-setup.mjs?fixture=${randomUUID()}`);
  for (let i = 0; i < 3; i++) {
    await restarted.reconcileRoamShellTest(config, op.id, deps);
    restarted.startRoamShellTest(config, randomUUID(), deps);
  }
  assert.equal(f.posts, 1);
  assert.equal(allRoamOperations()[0].phase, "unknown");
  f.hideMachine = false;
  await restarted.reconcileRoamShellTest(config, op.id, deps);
  assert.equal(f.deletes, 1);
  assert.equal(allRoamOperations()[0].phase, "complete");
}));

test("an in-flight probe cleans up with its captured account and cannot verify a changed account", async () => fixture(async ({ config, f, deps }) => {
  const changed = { ...config, apiKey: "replacement-key" };
  f.holdProbe = async () => { assert.equal(roamSetupView(changed).ready, false); };
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(changed).ready, false);
  assert.ok(f.calls.filter((c) => c.method === "DELETE").every((c) => c.auth === "Bearer synthetic-key"));
  f.ref = "changed-source";
  await checkRoamSelection(config, deps);
  assert.equal(roamSetupView(config).ready, false);
  assert.equal(roamSelectionState(roamBinding(config)).state, "checked");
}));

test("the explicit snapshot action sends a fixed remote Dockerfile and never uploads host files", async () => fixture(async ({ config, f, deps }) => {
  const id = randomUUID();
  startRoamSnapshotBuild(config, id, deps);
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(f.builds, 1);
  assert.equal(f.posts, 0, "setup operations are exclusive");
  const body = f.calls.find((c) => c.method === "POST" && c.path === "/api/snapshots").body;
  assert.equal(body.regionId, "region-id");
  assert.equal(body.sandboxClass, "container");
  assert.match(body.buildInfo.dockerfileContent, /FROM --platform=linux\/amd64 node:22-bookworm-slim@sha256:/);
  assert.doesNotMatch(body.buildInfo.dockerfileContent, /^\s*(COPY|ADD)\s/im);
  assert.deepEqual(Object.keys(body.buildInfo), ["dockerfileContent"]);
  assert.equal(allRoamOperations()[0].phase, "complete");
  assert.equal(roamSetupView(config).ready, false, "a built snapshot still needs explicit selection and test");
  startRoamSnapshotBuild(config, id, deps);
  await settle();
  assert.equal(f.builds, 1);
}));

test("unknown snapshot creation is recovered by its exact unique name without another POST", async () => fixture(async ({ config, f, deps }) => {
  f.uncertain = true;
  startRoamSnapshotBuild(config, randomUUID(), deps);
  await settle();
  const op = allRoamOperations()[0];
  assert.equal(op.phase, "unknown");
  await reconcileRoamSnapshot(config, op.id, deps);
  assert.equal(allRoamOperations()[0].phase, "complete");
  assert.equal(f.builds, 1);
}));
