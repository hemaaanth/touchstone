import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daytonaFixture } from "./helpers/daytona-fixture.mjs";
import { writeConfig } from "../lib/providers.mjs";

// Exercise the same config-loader lifecycle as the owner release. A late
// dynamic import in a route fails after Vite has closed its config runner.
test("the actual Vite Settings route can finish a disposable shell test after startup", async () => daytonaFixture(async ({ dir, config, f, deps }) => {
  const names = ["TOUCHSTONE_RESULTS_DIR", "AGENT_RESULTS_DIR", "SPEND_LEDGER"];
  const old = names.map((k) => process.env[k]);
  process.env.TOUCHSTONE_RESULTS_DIR = process.env.AGENT_RESULTS_DIR = join(dir, "results");
  process.env.SPEND_LEDGER = join(dir, "spend.json");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = deps.fetch;
  writeConfig({ execution: { ...config, keyHost: "fixture.test" } });
  let server;
  try {
    const app = fileURLToPath(new URL("../../app/", import.meta.url));
    assert.equal(existsSync(join(app, "../spike/.env.local")), false, "Run this integration check from a test checkout without spike/.env.local.");
    const require = createRequire(join(app, "package.json"));
    const { createServer } = await import(require.resolve("vite"));
    server = await createServer({
      root: app, configFile: join(app, "vite.config.ts"), configLoader: "runner", envDir: dir, cacheDir: join(dir, "cache"),
      plugins: [{ name: "test-no-watch", configResolved(c) { c.server.watch = null; } }],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, open: false },
    });
    await server.listen();
    const port = server.httpServer.address().port;
    const http = (method, path, body) => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-touchstone-grant-token": "test-grant-token" } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (b) => text += b); res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    assert.equal((await http("GET", "/api/settings/execution/status")).body.ready, false);
    assert.equal(f.posts, 0);
    const accepted = await http("POST", "/api/settings/execution/test", { confirm: true, requestId: randomUUID() });
    assert.equal(accepted.status, 202);
    let current;
    for (let i = 0; i < 100; i++) {
      current = (await http("GET", "/api/settings/execution/status")).body;
      if (current.ready || current.operation?.phase === "complete" || current.operation?.phase === "rejected") break;
    }
    assert.equal(current.ready, true, JSON.stringify(current));
    assert.equal(f.posts, 1);
    assert.equal(f.deletes, 1);
    assert.ok(f.calls.some((c) => c.method === "GET" && c.path.startsWith("/api/sandbox/")), "deletion is confirmed by a resource read");
  } finally {
    await server?.close(); globalThis.fetch = savedFetch;
    names.forEach((key, i) => old[i] == null ? delete process.env[key] : process.env[key] = old[i]);
  }
}));
