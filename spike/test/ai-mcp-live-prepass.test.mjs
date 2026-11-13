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
const GARAK_IMAGE = "touchstone/garak:0.17.1";
const shieldOut = readFileSync(new URL("./fixtures/mcp-shield/poisoned.json", import.meta.url), "utf8");
const garakOut = readFileSync(new URL("./fixtures/garak/echo.json", import.meta.url), "utf8");

const calls = [];
let missing = new Set();
const realWrap = await import("../lib/wrap.mjs");
const realProof = await import("../lib/proof-http.mjs");
const namedOf = (ns) => Object.fromEntries(Object.entries(ns).filter(([key]) => key !== "default"));
mock.module("../lib/wrap.mjs", {
  namedExports: {
    ...namedOf(realWrap),
    runTool: async (o) => {
      calls.push(o);
      if (o.image === SHIELD_IMAGE) return { code: 0, stdout: shieldOut, stderr: "", timedOut: false };
      if (o.image === GARAK_IMAGE) return { code: 0, stdout: garakOut, stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  },
});
mock.module("../lib/proof-http.mjs", {
  namedExports: {
    ...namedOf(realProof),
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

function liveWs(mcp = { token: "tok_live_1" }) {
  const ws = mkdtempSync(join(tmpdir(), "ai-mcp-live-"));
  writeTouchstone(ws, { kind: "live", pack: "ai-mcp", baseUrl: "https://mcp.example.com", mcp });
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

test("live prepass: garak runs only with the operator's chat path and budget, and its leads reach the agent and the run view", async () => {
  calls.length = 0;
  missing = new Set();
  const ws = liveWs({ token: "tok_live_1", assistant: { path: "/agent/chat", budget: 16 } });
  try {
    const events = [];
    const prep = await pack.prepass(ws, { emit: (e) => events.push(e), reach });
    const garak = calls.filter((c) => c.image === GARAK_IMAGE);
    assert.equal(garak.length, 1, "garak runs once, on the live assistant");
    assert.deepEqual(garak[0].cmd, ["https://mcp.example.com/agent/chat"]);
    assert.equal(garak[0].network, "bridge");
    assert.deepEqual(garak[0].env, { GARAK_BUDGET: "16", GARAK_DEADLINE_S: "480", MCP_TOKEN: "tok_live_1" });
    assert.ok(events.some((e) => e.ev === "ai-mcp-scan-started" && e.engines.includes("garak")));

    const cov = prep.record.coverage.find((c) => c.engine === "garak");
    assert.deepEqual(cov, { engine: "garak", status: "ran", code: 0, timedOut: false, leads: 6, reason: "garak ran: 16 of 16 requests used, 16 replies." });
    const agent = JSON.parse(prep.env.LEADS);
    assert.ok(agent.some((l) => l.check === "garak-promptinject.HijackHateHumans" && l.where === "assistant /agent/chat"));

    // The run view shows "ran · 6 leads". The request count stays in the record.
    const view = prepassView(prep.record);
    assert.deepEqual(view.tools.find((t) => t.name === "garak"), { name: "garak", status: "ran", reason: null, leads: 6 });
    assert.equal(view.leads.filter((l) => l.tools.includes("garak")).length, 6);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("live prepass: no chat path and budget means garak sends nothing and the run view says why", async () => {
  calls.length = 0;
  missing = new Set();
  const ws = liveWs();
  try {
    const events = [];
    const prep = await pack.prepass(ws, { emit: (e) => events.push(e), reach });
    assert.equal(calls.filter((c) => c.image === GARAK_IMAGE).length, 0);
    assert.ok(!events.some((e) => e.ev === "ai-mcp-scan-started" && e.engines.includes("garak")));
    const t = prepassView(prep.record).tools.find((x) => x.name === "garak");
    assert.equal(t.status, "unavailable");
    assert.match(t.reason, /garak did not run: the live scope sets no assistant chat path and budget/);
    assert.equal(t.leads, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("live prepass: a missing garak image is a coverage error, never a clean scan", async () => {
  calls.length = 0;
  missing = new Set([GARAK_IMAGE]);
  const ws = liveWs({ token: "tok_live_1", assistant: { path: "/agent/chat", budget: 16 } });
  try {
    const prep = await pack.prepass(ws, { reach });
    assert.equal(calls.filter((c) => c.image === GARAK_IMAGE).length, 0);
    const t = prepassView(prep.record).tools.find((x) => x.name === "garak");
    assert.equal(t.status, "unavailable");
    assert.match(t.reason, /touchstone\/garak:0\.17\.1 is not built\. Build it with: npm run build:labs -- garak/);
  } finally { rmSync(ws, { recursive: true, force: true }); missing = new Set(); }
});
