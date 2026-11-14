// No Docker, image checks, network or model calls, including on a regression.
import "./helpers/isolated-env.mjs";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as child from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const externalCalls = [];
const forbidden = (name) => () => { externalCalls.push(name); throw new Error(`Unexpected external operation: ${name}`); };
const blocked = Object.fromEntries(["spawn", "exec", "execFile", "execSync", "execFileSync", "spawnSync", "fork"].map((name) => [name, forbidden(name)]));
mock.module("node:child_process", { exports: { ...child, ...blocked, default: { ...child, ...blocked } } });
const proof = await import("../lib/proof-http.mjs");
mock.module("../lib/proof-http.mjs", { exports: { ...proof, requireImage: forbidden("requireImage") } });
const fetch = globalThis.fetch;
globalThis.fetch = forbidden("fetch");
const { PACKS } = await import("../packs/index.mjs");
const { liveProof, liveTarget } = await import("../lib/live.mjs");
const dir = mkdtempSync(join(tmpdir(), "live-unavailable-"));
after(() => { globalThis.fetch = fetch; rmSync(dir, { recursive: true, force: true }); });

test("live binding remains readable for a prepared workspace", () => {
  const ws = join(dir, "prepared");
  mkdirSync(ws);
  const live = { net: "synthetic-active-network", gate: "http://synthetic-gate:8080", baseUrl: "https://app.example.com", image: "synthetic-image" };
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "live", pack: "web", live }));
  assert.deepEqual(liveTarget(ws), live);
  assert.deepEqual(externalCalls, []);
});

for (const pack of ["web", "ai-mcp"]) {
  for (const live of [undefined, { net: "old-network" }, { gate: "http://old-gate:8080" }]) {
    test(`unavailable ${pack} request tool refuses before execution (${JSON.stringify(live)})`, async () => {
      const ws = join(dir, `${pack}-${live?.net ? "net" : live?.gate ? "gate" : "fresh"}`);
      mkdirSync(ws);
      writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "live", pack, baseUrl: "https://app.example.com", live }));
      const state = { poc: 0, found: [], passed: new Map() };
      const tool = PACKS[pack].tools(ws, state).find((t) => t.name === "run_request_script");
      assert.ok(tool);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await tool.execute({ label: `unavailable-${attempt}`, script: 'await request("GET", "/")' });
        assert.equal(result.isError, true);
        const text = result.output.map((o) => o.text).join("\n");
        assert.match(text, /Live requests are unavailable/);
        assert.match(text, /no confinement boundary/);
        assert.match(text, /Do not retry/);
        assert.match(text, /Start a new run/);
        assert.doesNotMatch(text, /Keep investigating|No known harm pattern/);
      }
      assert.throws(() => liveTarget(ws), /no confinement boundary/);
      let oracleCalled = false;
      await assert.rejects(() => liveProof(ws, 'await request("GET", "/")', { check() { oracleCalled = true; return { pass: true }; } }), /Live requests are unavailable/);
      assert.equal(oracleCalled, false);
      assert.deepEqual(externalCalls, []);
    });
  }
}
