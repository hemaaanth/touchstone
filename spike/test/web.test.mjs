// Tests for the Web and sign-in pack (packs/web/pack.mjs). The oracle checks are
// pure functions over a transcript, so most of this needs no Docker and no model.
// The last test runs the real lab in Docker end to end. It skips when the image
// is not built.
//
//   node --experimental-test-module-mocks --test test/web.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import web, { ORACLES, matchOracle } from "../packs/web/pack.mjs";
import { PACKS, packFor } from "../packs/index.mjs";
import { cleanupWorkspace, makeWorkspace, readTouchstone } from "../lib/sandbox.mjs";

const nonceReplay = ORACLES.find((o) => o.name === "siwe-nonce-replay");
const bola = ORACLES.find((o) => o.name === "bola-wallet-idor");
const debugLeak = ORACLES.find((o) => o.name === "debug-route-signer-key-leak");

const verify = (over = {}) => ({ path: "/siwe/verify", status: 200, resBody: { token: "t1", user: { id: 1, name: "alice" } }, ...over });

test("siwe-nonce-replay: the same signed message posted twice, minting two tokens, is a pass", () => {
  const same = { message: "m", signature: "s" };
  const t = [
    { path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "a" } },
    { path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "b" } },
  ];
  assert.equal(nonceReplay.check(t).pass, true);
});

test("siwe-nonce-replay: two different messages, or one failed verify, is not a pass", () => {
  const diff = [
    { path: "/siwe/verify", status: 200, reqBody: { message: "m1", signature: "s1" }, resBody: { token: "a" } },
    { path: "/siwe/verify", status: 200, reqBody: { message: "m2", signature: "s2" }, resBody: { token: "b" } },
  ];
  assert.equal(nonceReplay.check(diff).pass, false);
  const same = { message: "m", signature: "s" };
  const oneFailed = [
    { path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "a" } },
    { path: "/siwe/verify", status: 401, reqBody: same, resBody: { error: "stale nonce" } },
  ];
  assert.equal(nonceReplay.check(oneFailed).pass, false);
  assert.equal(nonceReplay.check([]).pass, false);
});

test("bola-wallet-idor: signed in as user 1, reading user 2's wallet is a pass", () => {
  const t = [verify(), { path: "/api/users/2/wallet", status: 200, resBody: { id: 2, wallet: "0xabc", apiKey: "tk_bob" } }];
  const v = bola.check(t);
  assert.equal(v.pass, true);
  assert.match(v.detail, /user 1/);
  assert.match(v.detail, /2/);
});

test("bola-wallet-idor: reading your own profile, or no session, is not a pass", () => {
  const own = [verify(), { path: "/api/users/1", status: 200, resBody: { id: 1, wallet: "0xabc" } }];
  assert.equal(bola.check(own).pass, false);
  const noSession = [{ path: "/api/users/2/wallet", status: 200, resBody: { id: 2, wallet: "0xabc" } }];
  assert.equal(bola.check(noSession).pass, false);
  const blocked = [verify(), { path: "/api/users/2/wallet", status: 403, resBody: { error: "forbidden" } }];
  assert.equal(bola.check(blocked).pass, false);
});

test("debug-route-signer-key-leak: any 200 response carrying a signerPrivateKey is a pass", () => {
  const t = [{ path: "/internal/debug/config", status: 200, resBody: { signerPrivateKey: "0xabc", other: 1 } }];
  assert.equal(debugLeak.check(t).pass, true);
  assert.equal(debugLeak.check([{ path: "/internal/debug/config", status: 404, resBody: {} }]).pass, false);
  assert.equal(debugLeak.check([]).pass, false);
});

test("matchOracle returns the first oracle that passes, or null", () => {
  const same = { message: "m", signature: "s" };
  const t = [
    { path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "a" } },
    { path: "/siwe/verify", status: 200, reqBody: same, resBody: { token: "b" } },
  ];
  const m = matchOracle(t);
  assert.equal(m.oracle.name, "siwe-nonce-replay");
  assert.equal(matchOracle([{ path: "/health", status: 200, resBody: {} }]), null);
});

test("the web pack is registered and has a stable tool set", () => {
  assert.equal(PACKS.web, web);
  assert.equal(web.id, "web");
  assert.equal(web.proof, "http");
  assert.equal(web.tier, "P");
  assert.equal(typeof web.prepass, "function");
  assert.equal(typeof web.prove, "function");
  const state = { poc: 0, passed: new Map(), found: [] };
  const names = web.tools("/nonexistent", state).map((t) => t.name);
  assert.deepEqual(names, ["run_request_script", "submit_finding"]);
  assert.equal(web.nudge({ poc: 0, passed: new Map(), found: [] }), null);
});

test("run_request_script refuses to run with no persisted lab handle", async () => {
  const ws = mkdtempSync(join(tmpdir(), "web-tools-"));
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));
    const res = await tools.run_request_script.execute({ label: "x", script: "await request('GET','/healthz');" });
    assert.equal(res.isError, true);
    assert.equal(state.poc, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("submit_finding refuses an unmatched or duplicate label, and dedupes by root cause", async () => {
  const ws = mkdtempSync(join(tmpdir(), "web-submit-"));
  try {
    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));
    const refused = await tools.submit_finding.execute({ title: "t", severity: "high", label: "nope", explanation: "x" });
    assert.equal(refused.isError, true);

    state.passed.set("r1", { script: "s1", oracleName: "siwe-nonce-replay" });
    const ok = await tools.submit_finding.execute({ title: "Nonce replay", severity: "high", label: "r1", explanation: "x" });
    assert.ok(!ok.isError);
    assert.equal(state.found.length, 1);
    assert.equal(state.found[0].oracleName, "siwe-nonce-replay");

    const dupLabel = await tools.submit_finding.execute({ title: "t", severity: "high", label: "r1", explanation: "x" });
    assert.equal(dupLabel.isError, true);

    state.passed.set("r2", { script: "s2", oracleName: "siwe-nonce-replay" });
    const dupRoot = await tools.submit_finding.execute({ title: "t2", severity: "high", label: "r2", explanation: "x" });
    assert.equal(dupRoot.isError, true);
    assert.equal(state.found.length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---- smoke: needs Docker and the lab image. No model spend.

const hasImage = (() => {
  try { execFileSync("docker", ["image", "inspect", "touchstone/web-lab:dev"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const LAB = new URL("../packs/web/lab/dapp", import.meta.url).pathname;

const ALICE = { addr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" };

const scriptFor = (name) => ({
  "nonce-replay": `
const n1 = await request("GET", "/siwe/nonce");
const message = buildSiwe({ domain: "touchstone.lab", address: ${JSON.stringify(ALICE.addr)}, uri: "http://touchstone.lab/siwe", version: "1", chainId: 31337, nonce: n1.resBody.nonce, issuedAt: new Date().toISOString() });
const signature = await signPersonal(${JSON.stringify(ALICE.pk)}, message);
await request("POST", "/siwe/verify", { body: { message, signature } });
await request("POST", "/siwe/verify", { body: { message, signature } });
`,
  "idor": `
const n1 = await request("GET", "/siwe/nonce");
const message = buildSiwe({ domain: "touchstone.lab", address: ${JSON.stringify(ALICE.addr)}, uri: "http://touchstone.lab/siwe", version: "1", chainId: 31337, nonce: n1.resBody.nonce, issuedAt: new Date().toISOString() });
const signature = await signPersonal(${JSON.stringify(ALICE.pk)}, message);
const verify = await request("POST", "/siwe/verify", { body: { message, signature } });
await request("GET", "/api/users/2/wallet", { headers: { authorization: "Bearer " + verify.resBody.token } });
`,
  "debug-leak": `
await request("GET", "/internal/debug/config");
`,
}[name]);

test("web smoke: run_request_script finds all three planted bugs and prove() replays each on a fresh lab", { skip: !hasImage && "image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.equal(packFor(readTouchstone(ws)).id, "web");
    const events = [];
    const prep = await web.prepass(ws, { emit: (e) => events.push(e) });
    assert.equal(events[0].ev, "web-lab-started");

    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));

    const labels = { "siwe-nonce-replay": "nonce-replay", "bola-wallet-idor": "idor", "debug-route-signer-key-leak": "debug-leak" };
    for (const [oracleName, label] of Object.entries(labels)) {
      const run = await tools.run_request_script.execute({ label, script: scriptFor(label) });
      assert.ok(!run.isError, run.output?.[0]?.text);
      assert.match(run.output[0].text, /MATCH/, `${label} should match a known pattern:\n${run.output[0].text}`);
      assert.equal(state.passed.get(label)?.oracleName, oracleName);
      const sub = await tools.submit_finding.execute({ title: label, severity: "high", label, explanation: "x. Fix: x" });
      assert.ok(!sub.isError, sub.output?.[0]?.text);
    }
    assert.equal(state.found.length, 3);

    const proved = await web.prove(ws, state.found, [], () => {});
    assert.equal(proved.length, 3);
    for (const finding of proved) {
      assert.equal(finding.proof.kind, "http", finding.poc);
      assert.equal(finding.proof.status, "pass", `${finding.poc}: ${finding.proof.detail}`);
      assert.equal(finding.proof.oracle.passed, true, finding.poc);
    }
  } finally {
    cleanupWorkspace(ws);
  }
});
