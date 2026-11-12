// The ai-mcp prepass in a LIVE run, wired end to end the way the app runs it
// (app/server/runs.mjs): pack.prepass(ws, { emit, reach }) -> record ->
// prepassView. Docker is replaced by a stub at runTool, so this test needs no
// image and sends no request. The stub returns real mcp-shield output that was
// recorded once (test/fixtures/mcp-shield/poisoned.json).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIELD_IMAGE = "touchstone/mcp-shield:1.0.4";
const shieldOut = readFileSync(new URL("./fixtures/mcp-shield/poisoned.json", import.meta.url), "utf8");

const calls = [];
let missing = new Set();
const realWrap = await import("../lib/wrap.mjs");
const realProof = await import("../lib/proof-http.mjs");
mock.module("../lib/wrap.mjs", {
  exports: {
    ...realWrap,
    runTool: async (o) => {
      calls.push(o);
      if (o.image === SHIELD_IMAGE) return { code: 0, stdout: shieldOut, stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  },
});
mock.module("../lib/proof-http.mjs", {
  exports: {
    ...realProof,
    requireImage: async (image, target) => {
      if (missing.has(image)) throw new Error(`image ${image} is not built. Build it with: npm run build:labs -- ${target}`);
    },
    // A live run must never start a lab. Fail loudly if it tries.
    startLab: async () => { throw new Error("a live run started a lab"); },
  },
});

const { default: pack } = await import("../packs/ai-mcp/pack.mjs");
const { writeTouchstone, readTouchstone } = await import("../lib/sandbox.mjs");
const { prepassView } = await import("../lib/prepass-view.mjs");

const reach = { hosts: ["mcp.example.com"], confine: { netClient: "ts-client-x", gateUrl: "http://gate:8080" } };

function liveWs() {
  const ws = mkdtempSync(join(tmpdir(), "ai-mcp-live-"));
  writeTouchstone(ws, { kind: "live", pack: "ai-mcp", baseUrl: "https://mcp.example.com", mcp: { token: "tok_live_1" } });
  return ws;
}

test("live prepass: mcp-shield scans the operator's base URL, and its leads reach the agent and the run view", async () => {
  calls.length = 0;
  missing = new Set();
  const ws = liveWs();
  try {
    const events = [];
    const prep = await pack.prepass(ws, { emit: (e) => events.push(e), reach });

    const shield = calls.filter((c) => c.image === SHIELD_IMAGE);
    assert.equal(shield.length, 1, "mcp-shield runs once, on the live target");
    assert.deepEqual(shield[0].cmd, ["https://mcp.example.com/mcp"]);
    assert.equal(shield[0].network, "bridge");
    assert.deepEqual(shield[0].env, { MCP_TOKEN: "tok_live_1" });
    assert.equal(shield[0].timeoutMs, 120_000);
    assert.equal(readTouchstone(ws).live.baseUrl, "https://mcp.example.com");

    // The record the app keeps as run.prepass.
    const cov = prep.record.coverage.find((c) => c.engine === "mcp-shield");
    assert.deepEqual(cov, { engine: "mcp-shield", status: "ran", code: 0, timedOut: false, leads: 5 });
    assert.equal(prep.record.leads.filter((l) => l.engine === "mcp-shield" || l.engines?.includes("mcp-shield")).length, 5);
    // The file mcp_leads reads back to the agent.
    assert.deepEqual(JSON.parse(readFileSync(join(ws, ".ai-mcp-leads.json"), "utf8")), prep.record);
    // The leads the agent gets in its kickoff.
    const agent = JSON.parse(prep.env.LEADS);
    assert.ok(agent.some((l) => l.check === "shield-tool-shadowing" && l.where === "tool send_message"));
    assert.ok(events.some((e) => e.ev === "ai-mcp-scan-started" && e.engines.includes("mcp-shield")));

    // What the operator sees in the app run.
    const view = prepassView(prep.record);
    assert.deepEqual(view.tools.find((t) => t.name === "mcp-shield"), { name: "mcp-shield", status: "ran", reason: null, leads: 5 });
    const shown = view.leads.filter((l) => l.tools.includes("mcp-shield")).map((l) => `${l.check}|${l.where}`).sort();
    assert.deepEqual(shown, [
      "shield-hidden-instructions|tool add_numbers",
      "shield-sensitive-file-access|tool add_numbers",
      "shield-side-channel-argument|tool add_numbers",
      "shield-side-channel-argument|tool get_weather",
      "shield-tool-shadowing|tool send_message",
    ]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("live prepass: a missing mcp-shield image shows as a coverage error in the run view, never a clean scan", async () => {
  calls.length = 0;
  missing = new Set([SHIELD_IMAGE]);
  const ws = liveWs();
  try {
    const prep = await pack.prepass(ws, { reach });
    assert.equal(calls.filter((c) => c.image === SHIELD_IMAGE).length, 0, "docker run is never called for a missing local image");
    const t = prepassView(prep.record).tools.find((x) => x.name === "mcp-shield");
    assert.equal(t.status, "unavailable");
    assert.match(t.reason, /touchstone\/mcp-shield:1\.0\.4 is not built\. Build it with: npm run build:labs -- shield/);
    assert.equal(t.leads, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); missing = new Set(); }
});
