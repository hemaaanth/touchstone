import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRun, execConfig, roamMachine } from "../lib/daytona.mjs";
import { checkRoamSelection, SHELL_PROBE_VERSION } from "../lib/daytona-setup.mjs";
import { roamBinding, roamOperations, setRoamSelectionState } from "../lib/daytona-state.mjs";

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "daytona-readiness-"));
  const env = {
    TOUCHSTONE_EXEC: "daytona", DAYTONA_API_KEY: "synthetic-key", DAYTONA_API_URL: "https://fixture.test/api",
    DAYTONA_TARGET: "selected-region", TOUCHSTONE_ROAM_SNAPSHOT: "fixture-snapshot",
    TOUCHSTONE_DAYTONA_STATE_FILE: join(dir, "setup.json"), DAYTONA_PENDING: join(dir, "pending.json"), SPEND_LEDGER: join(dir, "spend.json"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const fake = { posts: 0, mode: "healthy", requests: [], deletes: [], list: [], snapshotAvailable: true };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.ok(["fixture.test", "toolbox.fixture.test"].includes(u.hostname), "no real provider request");
    if (u.pathname === "/api/regions") return json([{ id: "region-1", name: "selected-region" }]);
    if (u.pathname.startsWith("/api/snapshots/")) return json({ id: "fixture-snapshot-id", name: "fixture-snapshot", state: "active", regionIds: fake.snapshotAvailable ? ["region-1"] : [], sandboxClass: "container", ref: "fixture-ref" });
    if (u.pathname === "/api/sandbox" && init.method === "POST") {
      fake.posts++;
      fake.requests.push(JSON.parse(init.body));
      if (fake.mode === "unavailable") return json({ message: "Snapshot fixture-snapshot-id is not available in region selected-region" }, 400);
      if (fake.mode === "generic-400") return json({ message: "Invalid account configuration synthetic-key" }, 400);
      if (fake.mode === "timeout") throw new Error("Synthetic timeout synthetic-key");
      return json({ id: `machine-${fake.posts}`, toolboxProxyUrl: "https://toolbox.fixture.test" });
    }
    if (u.pathname === "/api/sandbox" && !init.method?.match(/POST/)) return json({ items: fake.list });
    if (u.pathname.startsWith("/api/sandbox/") && init.method === "DELETE") {
      fake.deletes.push({ id: u.pathname.split("/").at(-1), auth: init.headers.Authorization });
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/process/execute")) return json({ exitCode: 0, result: "" });
    throw new Error(`Unexpected synthetic endpoint: ${init.method} ${u.pathname}`);
  };
  try {
    const config = execConfig();
    const selection = await checkRoamSelection(config);
    setRoamSelectionState(roamBinding(config), "verified", { ...selection, probeVersion: SHELL_PROBE_VERSION, verificationId: "fixture-verification" });
    await fn({ dir, fake, config });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
    // Sidecars are beside the synthetic workspace, inside dir, so removed too.
  }
}

test("known unavailable metadata prevents all 15 create attempts", async () => fixture(async ({ dir, fake }) => {
  fake.snapshotAvailable = false;
  for (let i = 0; i < 15; i++) await assert.rejects(roamMachine(join(dir, "run"), `child-${i}`));
  assert.equal(fake.posts, 0);
}));

test("the first conclusive unavailable create is the only POST, including after restart", async () => fixture(async ({ dir, fake }) => {
  fake.mode = "unavailable";
  for (let i = 0; i < 15; i++) await assert.rejects(roamMachine(join(dir, "run"), `child-${i}`));
  const restarted = await import(`../lib/daytona.mjs?readiness-restart=${Date.now()}`);
  for (let i = 0; i < 15; i++) await assert.rejects(restarted.roamMachine(join(dir, "another-run"), `other-${i}`));
  assert.equal(fake.posts, 1);
}));

test("a generic 400 is safely blocked without claiming the snapshot is unavailable", async () => fixture(async ({ dir, fake, config }) => {
  fake.mode = "generic-400";
  let first;
  try { await roamMachine(join(dir, "run"), "child"); } catch (e) { first = e; }
  assert.equal(first.code, "daytona_rejected");
  assert.ok(!first.message.includes("synthetic-key"));
  for (let i = 0; i < 14; i++) await assert.rejects(roamMachine(join(dir, "run"), `child-${i}`));
  assert.equal(fake.posts, 1);
  assert.equal(roamOperations(roamBinding(config))[0].phase, "rejected");
}));

test("an uncertain create is not repeated after empty reconciliation, but another child remains independent", async () => fixture(async ({ dir, fake, config }) => {
  fake.mode = "timeout";
  for (let i = 0; i < 15; i++) await assert.rejects(roamMachine(join(dir, "run"), "same-child"));
  assert.equal(fake.posts, 1);
  assert.equal(roamOperations(roamBinding(config))[0].phase, "unknown");
  fake.mode = "healthy";
  const other = await roamMachine(join(dir, "run"), "different-child");
  assert.equal(other.id, "machine-2");
  assert.equal(fake.posts, 2);
}));

for (const count of [4, 10]) test(`${count} healthy children receive distinct machines and reuse their own slots`, async () => fixture(async ({ dir, fake }) => {
  const root = join(dir, "run");
  const first = await Promise.all(Array.from({ length: count }, (_, i) => roamMachine(root, `child-${i}`)));
  const again = await Promise.all(Array.from({ length: count }, (_, i) => roamMachine(root, `child-${i}`)));
  assert.equal(new Set(first.map((m) => m.id)).size, count);
  assert.deepEqual(again.map((m) => m.id), first.map((m) => m.id));
  assert.equal(fake.posts, count);
  assert.ok(fake.requests.every((body) => body.snapshot === "fixture-snapshot-id" && body.target === "selected-region" && body.autoStopInterval === 60 && body.autoDeleteInterval === 240));
}));

test("cached machines reject another account while run-end cleanup retains the captured client", async () => fixture(async ({ dir, fake }) => {
  const root = join(dir, "run");
  await roamMachine(root, "child");
  process.env.DAYTONA_API_KEY = "replacement-synthetic-key";
  await assert.rejects(roamMachine(root, "child"), { code: "daytona_shell_unverified" });
  await closeRun(root);
  assert.deepEqual(fake.deletes, [{ id: "machine-1", auth: "Bearer synthetic-key" }]);
}));

test("closing one run does not delete another run's active child", async () => fixture(async ({ dir, fake }) => {
  const root = join(dir, "run"), other = join(dir, "other-run");
  await roamMachine(root, "child");
  await roamMachine(other, "child");
  await closeRun(root);
  assert.deepEqual(fake.deletes.map((x) => x.id), ["machine-1"]);
  await closeRun(other);
  assert.deepEqual(fake.deletes.map((x) => x.id), ["machine-1", "machine-2"]);
}));

test("an unknown create keeps cleanup identity after workspace loss and refuses wrong-account cleanup", async () => fixture(async ({ dir, fake, config }) => {
  const root = join(dir, "run");
  fake.mode = "timeout";
  await assert.rejects(roamMachine(root, "child"));
  const op = roamOperations(roamBinding(config))[0];
  const labels = fake.requests[0].labels;
  fake.list = [{ id: "late-machine", labels }];
  process.env.DAYTONA_API_KEY = "replacement-synthetic-key";
  await closeRun(root);
  assert.equal(fake.deletes.length, 0);
  assert.equal(roamOperations(roamBinding(config))[0].phase, "unknown");
  process.env.DAYTONA_API_KEY = "synthetic-key";
  await closeRun(root);
  assert.deepEqual(fake.deletes.map((x) => x.id), ["late-machine"]);
  assert.equal(roamOperations(roamBinding(config)).find((x) => x.id === op.id).phase, "complete");
  assert.equal(fake.posts, 1);
}));

test("legacy unbound free-roam sidecars are preserved without account requests", async () => fixture(async ({ dir, fake }) => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const root = join(dir, "run");
  const raw = JSON.stringify({ "roam:child": { id: "legacy-machine", toolbox: "https://toolbox.fixture.test/legacy-machine" } });
  writeFileSync(`${root}.daytona.json`, raw);
  await assert.rejects(roamMachine(root, "child"), { code: "daytona_shell_unverified" });
  await closeRun(root);
  assert.equal(fake.posts, 0);
  assert.equal(fake.deletes.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(`${root}.daytona.json`, "utf8")), JSON.parse(raw));
}));
