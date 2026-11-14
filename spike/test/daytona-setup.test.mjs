import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkRoamSelection, startRoamShellTest, startRoamSnapshotBuild, reconcileRoamShellTest, reconcileRoamSnapshot, roamSetupView } from "../lib/daytona-setup.mjs";
import { daytonaError } from "../lib/daytona-api.mjs";
import { allRoamOperations, roamBinding, roamSelectionState } from "../lib/daytona-state.mjs";

import { daytonaFixture as fixture, settle } from "./helpers/daytona-fixture.mjs";

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
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(f.posts, 2);
  assert.equal(f.deletes, 2);
  assert.equal(roamSetupView(config).ready, true, "a later explicit test uses a fresh supervisor");
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
  assert.deepEqual(body.buildInfo.contextHashes, []);
  assert.deepEqual(Object.keys(body.buildInfo).sort(), ["contextHashes", "dockerfileContent"]);
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

test("accepted DELETE does not establish deletion or shell readiness", async () => fixture(async ({ config, f, deps }) => {
  f.acceptedDelete = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(f.posts, 1);
  assert.equal(allRoamOperations()[0].phase, "cleanup");
  assert.equal(roamSetupView(config).ready, false);
  assert.ok(f.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/sandbox/")).length >= 10);
  f.acceptedDelete = false;
  await reconcileRoamShellTest(config, allRoamOperations()[0].id, deps);
  assert.equal(allRoamOperations()[0].phase, "complete");
  assert.equal(roamSetupView(config).ready, false);
}));

test("a second real setup proof cannot bypass an uncertain runtime create for the same child", async () => fixture(async ({ dir, config, f, deps }) => {
  const { roamMachine } = await import("../lib/daytona.mjs");
  const env = { TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: config.apiKey, DAYTONA_API_URL: config.apiUrl, DAYTONA_TARGET: config.target, TOUCHSTONE_ROAM_SNAPSHOT: config.roamSnapshot };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  Object.assign(process.env, env); globalThis.fetch = deps.fetch;
  try {
    startRoamShellTest(config, randomUUID(), deps);
    await settle();
    assert.equal(roamSetupView(config).ready, true);
    f.uncertainRuntime = true; f.hideMachine = true;
    await assert.rejects(roamMachine(join(dir, "run"), "child"));
    startRoamShellTest(config, randomUUID(), deps);
    await settle();
    assert.equal(roamSetupView(config).ready, true);
    await assert.rejects(roamMachine(join(dir, "run"), "child"));
    const posts = f.calls.filter((c) => c.method === "POST" && c.path === "/api/sandbox" && c.body.labels.loadout === "free-roam");
    assert.equal(posts.length, 1);
    assert.equal(allRoamOperations().filter((o) => o.action === "runtime").length, 1);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(old)) v == null ? delete process.env[k] : process.env[k] = v;
  }
}));

test("setup waits for the accepted machine to start before checking capabilities", async () => fixture(async ({ config, f, deps }) => {
  f.initialBootReads = 3;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, true);
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
  const create = f.calls.findIndex((c) => c.path === "/api/sandbox" && c.method === "POST");
  const execute = f.calls.findIndex((c) => c.path.endsWith("/process/execute"));
  assert.ok(f.calls.slice(create + 1, execute).filter((c) => c.method === "GET").length >= 4);
}));

test("a machine that never starts is cleaned up without testing capabilities or creating another", async () => fixture(async ({ config, f, deps }) => {
  f.neverStarts = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, false);
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
  assert.equal(allRoamOperations()[0].errorCode, "daytona_sandbox_start_failed");
  assert.ok(!f.calls.some((c) => c.path.endsWith("/process/execute")));
}));

test("startup retains the validated POST toolbox URL when the same-ID GET omits it", async () => fixture(async ({ config, f, deps }) => {
  f.omitToolboxOnGet = true;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, true);
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
}));

test("slow GET responses cannot admit toolbox commands after the startup deadline", async () => fixture(async ({ config, f, deps }) => {
  let clock = 0;
  deps.now = () => clock;
  deps.sleep = async (ms) => { clock += ms; };
  f.onSandboxRead = () => { clock += 10_000; };
  f.initialBootReads = 5;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  assert.equal(roamSetupView(config).ready, false);
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
  assert.ok(!f.calls.some((c) => c.path.endsWith("/process/execute")));
  assert.equal(allRoamOperations()[0].errorCode, "daytona_sandbox_start_failed");
}));

for (const status of [71,72,73,74,75,76,77,78,79,80]) test(`prerequisite ${status} survives setup storage with its fixed public message`, async () => fixture(async ({ config, f, deps }) => {
  f.prerequisiteStatus = status;
  startRoamShellTest(config, randomUUID(), deps);
  await settle();
  const view = roamSetupView(config);
  assert.equal(view.ready, false);
  assert.equal(view.operation.phase, "complete");
  assert.equal(view.operation.errorMessage, daytonaError(view.operation.errorCode).message);
  assert.ok(!view.operation.errorMessage.includes("synthetic"));
  assert.equal(f.posts, 1);
  assert.equal(f.deletes, 1);
}));

test("snapshot polling rejection preserves the accepted resource for reconciliation", async () => fixture(async ({ config, f, deps }) => {
  const deniedPoll = { ...deps, fetch: (url, init) => new URL(url).pathname === "/api/snapshots/built-id"
    ? Promise.resolve(new Response("{}", { status: 403 })) : deps.fetch(url, init) };
  startRoamSnapshotBuild(config, randomUUID(), deniedPoll);
  await settle();
  const op = allRoamOperations()[0];
  assert.equal(op.phase, "unknown");
  assert.equal(op.resourceId, "built-id");
  assert.equal(op.errorStatus, 403);
  startRoamSnapshotBuild(config, randomUUID(), deps);
  await settle();
  assert.equal(f.builds, 1, "accepted resource blocks another build");
  await reconcileRoamSnapshot(config, op.id, deps);
  assert.equal(allRoamOperations()[0].phase, "complete");
  assert.equal(f.builds, 1);
}));
