import { test } from "node:test";
import assert from "node:assert/strict";
import { daytonaShellApi } from "../lib/daytona-api.mjs";

const config = { apiUrl: "https://fixture.test/api", apiKey: "synthetic-private-key", target: "selected-region" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id) => ({ id, name: id, state: "active", regionIds: ["region-id"], sandboxClass: "container", internalToken: "NEVER-PUBLIC" });

test("snapshot discovery follows complete pagination and returns only named public fields", async () => {
  const calls = [];
  const api = daytonaShellApi(config, { fetch: async (url, init) => {
    calls.push({ url, init });
    const page = Number(new URL(url).searchParams.get("page"));
    return json({ items: [item(`snapshot-${page}`)], page, totalPages: 2 });
  } });
  const rows = await api.snapshots();
  assert.deepEqual(rows.map((r) => r.id), ["snapshot-1", "snapshot-2"]);
  assert.ok(!JSON.stringify(rows).includes("NEVER-PUBLIC"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init.method === "GET" && c.init.redirect === "error" && c.init.headers.Authorization === `Bearer ${config.apiKey}`));
});

test("a missing later page or excessive pagination does not masquerade as an empty catalog", async () => {
  for (const mode of ["missing", "excessive", "repeated"]) {
    let calls = 0;
    const api = daytonaShellApi(config, { fetch: async () => {
      calls++;
      if (mode === "excessive") return json({ items: [], page: 1, totalPages: 1000 });
      if (calls === 1 || mode === "repeated") return json({ items: [item("first")], page: 1, totalPages: 2 });
      throw new Error("secret provider response");
    } });
    await assert.rejects(api.snapshots(), (e) => {
      assert.ok(["daytona_response_invalid", "daytona_unreachable"].includes(e.code));
      assert.ok(!e.message.includes("secret"));
      return true;
    });
    assert.ok(calls <= 2);
  }
});

test("missing class and region metadata remain unknown instead of ready", async () => {
  const api = daytonaShellApi(config, { fetch: async () => json({ id: "snapshot", name: "snapshot", state: "active" }) });
  const value = await api.snapshot("snapshot");
  assert.deepEqual({ ...value, metadataHash: undefined }, { id: "snapshot", name: "snapshot", state: "active", regionIds: [], sandboxClass: null, metadataHash: undefined });
  assert.match(value.metadataHash, /^[a-f0-9]{64}$/);
});

test("only the exact unavailable snapshot rejection invalidates the selection", async () => {
  for (const [message, expected] of [
    ["Snapshot selected-snapshot is not available in region selected-region", "daytona_snapshot_unavailable"],
    ["Snapshot another-snapshot is not available in region selected-region", "daytona_rejected"],
    ["Quota exceeded synthetic-private-key", "daytona_rejected"],
  ]) {
    const api = daytonaShellApi(config, { fetch: async () => json({ message }, 400) });
    await assert.rejects(api.createSandbox({ nonce: "operation" }, "selected-snapshot"), (e) => {
      assert.equal(e.code, expected);
      assert.equal(e.status, 400);
      assert.equal(e.cause, undefined);
      assert.ok(!e.message.includes(config.apiKey));
      return true;
    });
  }
});

test("creation preserves the selected region, snapshot and normal lifetime", async () => {
  let request;
  const api = daytonaShellApi(config, { fetch: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return json({ id: "machine" });
  } });
  await api.createSandbox({ nonce: "operation" }, "selected-snapshot");
  assert.equal(request.url, "https://fixture.test/api/sandbox");
  assert.deepEqual(request.body, { snapshot: "selected-snapshot", target: "selected-region", user: "root", labels: { nonce: "operation" }, autoStopInterval: 60, autoDeleteInterval: 240 });
});

test("oversized and malformed responses fail with fixed errors", async () => {
  for (const body of ["{", "x".repeat(256 * 1024 + 1)]) {
    const api = daytonaShellApi(config, { fetch: async () => new Response(body) });
    await assert.rejects(api.regions(), (e) => e.code === "daytona_response_invalid" && e.cause === undefined);
  }
});

test("repeated sandbox cursors fail closed and a timeout is an uncertain result", async () => {
  let calls = 0;
  const api = daytonaShellApi(config, { fetch: async () => { calls++; return json({ items: [], nextCursor: "same" }); } });
  await assert.rejects(api.sandboxes({ nonce: "operation" }), (e) => e.code === "daytona_response_invalid");
  assert.equal(calls, 2);
  const timeout = daytonaShellApi(config, { fetch: async () => { throw new Error("synthetic-private-key in an error"); } });
  await assert.rejects(timeout.createSandbox({}, "snapshot"), (e) => e.code === "daytona_unreachable" && !e.message.includes(config.apiKey) && e.cause === undefined);
});

test("unsafe URLs are rejected before a key can be sent", () => {
  for (const apiUrl of ["http://fixture.test/api", "https://user:pass@fixture.test/api", "https://fixture.test/api?key=secret"]) {
    assert.throws(() => daytonaShellApi({ ...config, apiUrl }), (e) => e.code === "daytona_unconfigured");
  }
});

for (const field of ["exitCode", "code"]) test(`toolbox ${field} is normalized at the wire boundary`, async () => {
  const api = daytonaShellApi(config, { fetch: async () => json({ [field]: 7, result: "own fixed output" }) });
  const machine = api.machine({ id: "machine-1", toolboxProxyUrl: "https://toolbox.fixture.test" });
  assert.deepEqual(await machine.exec("own fixed command", 5), { exitCode: 7, result: "own fixed output" });
});

test("malformed toolbox status is refused without returning its private response", async () => {
  const api = daytonaShellApi(config, { fetch: async () => json({ code: "synthetic-private-output", result: {} }) });
  await assert.rejects(api.machine({ id: "machine-1", toolboxProxyUrl: "https://toolbox.fixture.test" }).exec("true", 5), (e) => e.code === "daytona_response_invalid" && !e.message.includes("synthetic-private-output"));
});
