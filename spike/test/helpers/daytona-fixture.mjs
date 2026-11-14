import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const tick = () => new Promise((r) => setImmediate(r));
export async function settle() {
  for (let i = 0; i < 100; i++) await tick();
}
export async function daytonaFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "daytona-setup-"));
  const names = ["TOUCHSTONE_DAYTONA_STATE_FILE", "EVENTS_FILE"];
  const old = names.map((k) => process.env[k]);
  process.env.TOUCHSTONE_DAYTONA_STATE_FILE = join(dir, "setup.json");
  process.env.EVENTS_FILE = join(dir, "events.jsonl");
  const config = { backend: "daytona", apiUrl: "https://fixture.test/api", apiKey: "synthetic-key", target: "fixture-region", roamSnapshot: "selected" };
  const f = { calls: [], posts: 0, builds: 0, deletes: 0, initialBootReads: 0, bootReads: 0, cleanupFails: false, uncertain: false, failProbe: false, holdProbe: null, ref: "source-1", sandbox: null, snapshot: null, uploads: new Map(), epoch: 0 };
  const json = (x, status = 200) => {
    // Real toolbox responses can use code; the app adapter must normalize it.
    if (x && typeof x === "object" && "exitCode" in x) { const { exitCode, ...rest } = x; x = { code: exitCode, ...rest }; }
    return new Response(JSON.stringify(x), { status });
  };
  const deps = { sleep: async () => {}, fetch: async (url, init) => {
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
      f.epoch = 0;
      f.bootReads = f.initialBootReads;
      f.sandbox = { id: `probe-${randomUUID()}`, state: "creating", toolboxProxyUrl: "https://tb.fixture.test", labels: body.labels };
      if (f.uncertain || (f.uncertainRuntime && body.labels.loadout === "free-roam")) throw new Error("synthetic-secret");
      return json(f.sandbox);
    }
    if (u.pathname === "/api/sandbox") return json({ items: f.sandbox && !f.hideMachine ? [f.sandbox] : [] });
    if (u.hostname === "fixture.test" && u.pathname.startsWith("/api/sandbox/") && init.method === "GET") {
      f.onSandboxRead?.();
      return f.sandbox ? json({ ...f.sandbox, ...(f.omitToolboxOnGet ? { toolboxProxyUrl: undefined } : {}), state: f.neverStarts || f.bootReads-- > 0 ? "creating" : "started" }) : json({}, 404);
    }
    if (u.hostname === "fixture.test" && u.pathname.startsWith("/api/sandbox/") && init.method === "DELETE") {
      f.deletes++;
      if (f.cleanupFails) return json({ message: "synthetic-secret" }, 409);
      if (f.acceptedDelete) return new Response("", { status: 202 });
      f.sandbox = null; return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/files/upload-v2")) {
      const path = u.searchParams.get("path");
      if (path.endsWith(".json")) { const q = JSON.parse(await init.body.get("file").text()); f.uploads.set(q.id, q); }
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/process/execute")) {
      const { command } = JSON.parse(init.body);
      assert.ok(f.bootReads <= 0, "no command before the machine starts");
      if (command === "true") return json({ exitCode: 0, result: "" });
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
  try { await fn({ dir, config, f, deps }); await settle(); }
  finally { names.forEach((key, i) => old[i] == null ? delete process.env[key] : process.env[key] = old[i]); rmSync(dir, { recursive: true, force: true }); }
}

