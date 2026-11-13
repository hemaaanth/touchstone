// garak in the ai-mcp prepass: the parser, the live-only plan, and the
// scanMcp wiring. No Docker: runTool is a stub that returns real garak output
// recorded once from the echo stub (test/fixtures/garak/).
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GARAK_TIMEOUT_MS, IMAGES, parseGarak, scanMcp } from "../packs/ai-mcp/scan.mjs";
import { garakPlan } from "../packs/ai-mcp/pack.mjs";
import { liveAssistant } from "../lib/scopes-store.mjs";

const FX = (name) => readFileSync(new URL(`./fixtures/garak/${name}`, import.meta.url), "utf8");

test("parseGarak turns real garak output into one lead per probe whose detector matched, with counts only", () => {
  const p = parseGarak(FX("echo.json"), { path: "/agent/chat" });
  assert.equal(p.ok, true);
  assert.equal(p.budget, 16);
  assert.equal(p.requests, 16);
  assert.equal(p.replies, 16);
  // The echo stub repeats every prompt, so the phrase, trigger and script-tag
  // checks match. The markdown-exfil checks need a rendered image URL, which a
  // plain echo does not produce, so those two probes give no lead.
  assert.deepEqual(p.leads.map((l) => l.check).sort(), [
    "garak-latentinjection.LatentInjectionReport",
    "garak-latentinjection.LatentInjectionResume",
    "garak-latentinjection.LatentWhois",
    "garak-promptinject.HijackHateHumans",
    "garak-promptinject.HijackKillHumans",
    "garak-web_injection.TaskXSS",
  ]);
  for (const l of p.leads) {
    assert.equal(l.engine, "garak");
    assert.equal(l.where, "assistant /agent/chat");
    assert.equal(l.impact, "Medium");
    assert.match(l.description, /2 of 2 replies matched .* A string match is a lead only/);
  }
  // No prompt or reply text is ever copied.
  assert.doesNotMatch(JSON.stringify(p), /You said|<script|ignore|hate humans/i);
});

test("parseGarak: a refused token, an error, garbage, or an unknown probe is never a clean scan or a lead", () => {
  const denied = parseGarak(FX("unauthorized.json"));
  assert.equal(denied.ok, false);
  assert.match(denied.error, /no reply came back from the endpoint \(1 requests, status \{'401': 1\}\)/);
  assert.equal(parseGarak("").ok, false);
  assert.equal(parseGarak("not json").ok, false);
  assert.equal(parseGarak(JSON.stringify({ ok: true })).ok, false, "no evals is not a clean scan");
  const odd = parseGarak(JSON.stringify({ ok: true, evals: [{ probe: "dan.Dan_11_0", detector: "x", fails: 3, total: 3 }] }));
  assert.equal(odd.ok, true);
  assert.equal(odd.leads.length, 0, "a probe we did not choose never becomes a lead");
});

test("garakPlan: garak runs only with a chat path and a budget from 8 to 200", () => {
  assert.match(garakPlan(null).skip, /sets no assistant chat path and budget/);
  assert.match(garakPlan({ budget: 20 }).skip, /no assistant chat path/);
  assert.match(garakPlan({ path: "/agent/chat" }).skip, /budget must be a whole number from 8 to 200/);
  assert.match(garakPlan({ path: "/agent/chat", budget: 7 }).skip, /from 8 to 200/);
  assert.match(garakPlan({ path: "/agent/chat", budget: 201 }).skip, /from 8 to 200/);
  assert.match(garakPlan({ path: "/agent/chat", budget: 1.5 }).skip, /whole number/);
  assert.match(garakPlan({ path: "https://evil.example/x", budget: 20 }).skip, /must start with \//);
  assert.match(garakPlan({ path: "/a/../b", budget: 20 }).skip, /must start with \//);
  assert.match(garakPlan({ path: "/chat?x=1", budget: 20 }).skip, /must start with \//);
  assert.match(garakPlan({ path: "/chat", budget: 20, reqKey: "a b" }).skip, /reqKey is not a plain JSON key/);
  assert.deepEqual(garakPlan({ path: "/agent/chat", budget: 20 }), { path: "/agent/chat", budget: 20, reqKey: undefined, replyKey: undefined });
});

test("liveAssistant: the scope store keeps a valid chat path and budget and refuses a bad one", () => {
  assert.equal(liveAssistant(undefined), null);
  assert.equal(liveAssistant({ path: "", budget: "" }), null);
  assert.deepEqual(liveAssistant({ path: " /agent/chat ", budget: 24 }), { path: "/agent/chat", budget: 24 });
  assert.throws(() => liveAssistant({ path: "/agent/chat" }), /budget to a whole number from 8 to 200/);
  assert.throws(() => liveAssistant({ path: "/agent/chat", budget: 500 }), /from 8 to 200/);
  assert.throws(() => liveAssistant({ path: "agent/chat", budget: 20 }), /must start with \//);
  assert.throws(() => liveAssistant({ budget: 20 }), /must start with \//);
});

test("scanMcp: garak gets the chat URL, the budget and token in its env, the scan network, and its own time cap", async () => {
  const calls = [];
  const run = async (o) => { calls.push(o); return { code: 0, stdout: FX("echo.json"), stderr: "", timedOut: false }; };
  const out = await scanMcp({ net: "bridge", baseUrl: "https://mcp.example.com", token: "tok_live", garak: { path: "/agent/chat", budget: 16 }, only: ["garak"], run, hasImage: async () => true });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.image, IMAGES.garak);
  assert.equal(c.image, "touchstone/garak:0.17.1");
  assert.deepEqual(c.cmd, ["https://mcp.example.com/agent/chat"]);
  assert.equal(c.network, "bridge");
  assert.equal(c.timeoutMs, GARAK_TIMEOUT_MS);
  assert.deepEqual(c.env, { GARAK_BUDGET: "16", GARAK_DEADLINE_S: "480", MCP_TOKEN: "tok_live" });
  assert.equal(c.ws, undefined, "garak needs no workspace mount");
  assert.doesNotMatch(JSON.stringify(c), /openai|anthropic|api[-_]?key|hf_token/i);
  assert.deepEqual(out.coverage, [{ engine: "garak", status: "ran", code: 0, timedOut: false, leads: 6, reason: "16 of 16 requests used, 16 replies." }]);
  assert.equal(out.leads.filter((l) => l.engines.includes("garak")).length, 6);
});

test("scanMcp: a lab scan (no garak plan) never lists or runs garak", async () => {
  const images = [];
  const out = await scanMcp({ net: "n", baseUrl: "http://lab:8080", token: "t", run: async (o) => { images.push(o.image); return { code: 0, stdout: "", stderr: "" }; }, hasImage: async () => true });
  assert.ok(!images.includes(IMAGES.garak));
  assert.ok(!out.coverage.some((c) => c.engine === "garak"));
});

test("scanMcp: garak without a plan, a missing image, or a tool error is a coverage error with a reason", async () => {
  let ran = false;
  const never = async () => { ran = true; return { code: 0, stdout: FX("echo.json"), stderr: "" }; };

  const skip = await scanMcp({ net: "bridge", baseUrl: "https://x.example", garak: garakPlan(null), only: ["garak"], run: never, hasImage: async () => true });
  assert.equal(ran, false, "no plan, no request");
  assert.deepEqual(skip.coverage, [{ engine: "garak", status: "unavailable", applicable: false, code: null, timedOut: false, leads: 0, reason: "garak did not run: the live scope sets no assistant chat path and budget." }]);

  const missing = await scanMcp({ net: "bridge", baseUrl: "https://x.example", garak: { path: "/chat", budget: 8 }, only: ["garak"], run: never, hasImage: async () => false });
  assert.equal(ran, false, "a missing local image must never reach docker run (it would try to pull)");
  assert.equal(missing.coverage[0].status, "unavailable");
  assert.match(missing.coverage[0].reason, /touchstone\/garak:0\.17\.1 is not built.*build:labs -- garak/);

  const denied = await scanMcp({ net: "bridge", baseUrl: "https://x.example", garak: { path: "/chat", budget: 8 }, only: ["garak"], run: async () => ({ code: 2, stdout: FX("unauthorized.json"), stderr: "", timedOut: false }), hasImage: async () => true });
  assert.equal(denied.coverage[0].status, "unavailable");
  assert.match(denied.coverage[0].reason, /garak failed: no reply came back from the endpoint/);

  const silent = await scanMcp({ net: "bridge", baseUrl: "https://x.example", garak: { path: "/chat", budget: 8 }, only: ["garak"], run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), hasImage: async () => true });
  assert.equal(silent.coverage[0].status, "unavailable");
  assert.match(silent.coverage[0].reason, /garak failed: garak printed no JSON result/);

  const slow = await scanMcp({ net: "bridge", baseUrl: "https://x.example", garak: { path: "/chat", budget: 8 }, only: ["garak"], run: async () => ({ code: 137, stdout: "", stderr: "", timedOut: true }), hasImage: async () => true });
  assert.equal(slow.coverage[0].status, "unavailable");
  assert.equal(slow.coverage[0].reason, "garak timed out.");
});
