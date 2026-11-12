// Tests for the Web and sign-in pack (packs/web/pack.mjs). The oracle checks are
// pure functions over a transcript, so most of this needs no Docker and no model.
// The last test runs the real lab in Docker end to end. It skips when the image
// is not built.
//
//   node --experimental-test-module-mocks --test test/web.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import web, { ORACLES, matchOracle } from "../packs/web/pack.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import { docQueryUrls, mergeLeads, parseDalfox, parseNuclei, parseZap, scanWeb, zapQueryUrls } from "../packs/web/scan.mjs";
import { PACKS, packFor } from "../packs/index.mjs";
import { cleanupWorkspace, makeWorkspace, readTouchstone } from "../lib/sandbox.mjs";
import { proofView } from "../lib/proof-view.mjs";

const nonceReplay = ORACLES.find((o) => o.name === "siwe-nonce-replay");
const bola = ORACLES.find((o) => o.name === "bola-wallet-idor");
const debugLeak = ORACLES.find((o) => o.name === "debug-route-signer-key-leak");
const xss = ORACLES.find((o) => o.name === "reflected-xss");

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

test("bola-wallet-idor: signed in as user 1, reading user 2's wallet with user 1's token is a pass", () => {
  const t = [verify(), { path: "/api/users/2/wallet", status: 200, reqHeaders: { authorization: "Bearer t1" }, resBody: { id: 2, wallet: "0xabc", apiKey: "tk_bob" } }];
  const v = bola.check(t);
  assert.equal(v.pass, true);
  assert.match(v.detail, /user 1/);
  assert.match(v.detail, /2/);
});

test("bola-wallet-idor: reading your own profile, or no session, is not a pass", () => {
  const own = [verify(), { path: "/api/users/1", status: 200, reqHeaders: { authorization: "Bearer t1" }, resBody: { id: 1, wallet: "0xabc" } }];
  assert.equal(bola.check(own).pass, false);
  const noSession = [{ path: "/api/users/2/wallet", status: 200, resBody: { id: 2, wallet: "0xabc" } }];
  assert.equal(bola.check(noSession).pass, false);
  const blocked = [verify(), { path: "/api/users/2/wallet", status: 403, reqHeaders: { authorization: "Bearer t1" }, resBody: { error: "forbidden" } }];
  assert.equal(bola.check(blocked).pass, false);
});

test("bola-wallet-idor: signing in as BOTH users and reading user 2's wallet with user 2's OWN token is not a pass", () => {
  // Forgery the recording proxy surfaces but the oracle must still reject: two
  // real sign-ins, then a legitimate self-read. The leaking call's token belongs
  // to user 2, so it is not a cross-user read even though a user-1 session exists.
  const t = [
    verify(), // alice: token t1 -> user 1
    { path: "/siwe/verify", status: 200, resBody: { token: "t2", user: { id: 2, name: "bob" } } },
    { path: "/api/users/2/wallet", status: 200, reqHeaders: { authorization: "Bearer t2" }, resBody: { id: 2, wallet: "0xabc", apiKey: "tk_bob" } },
  ];
  assert.equal(bola.check(t).pass, false);
  // But user 1's token reading user 2 in the same transcript IS the IDOR.
  const real = [...t, { path: "/api/users/2/wallet", status: 200, reqHeaders: { authorization: "Bearer t1" }, resBody: { id: 2, wallet: "0xabc", apiKey: "tk_bob" } }];
  assert.equal(bola.check(real).pass, true);
});

const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const leakBody = { signerPrivateKey: KEY, signerAddress: ADDR, chainId: 1 };
const dbgCall = (reqHeaders, over = {}) => ({ method: "GET", path: "/internal/debug/config", status: 200, reqHeaders, resBody: leakBody, ...over });

test("debug-route-signer-key-leak: bare call AND junk-token call, both 200 with the same body, is a pass", () => {
  const v = debugLeak.check([dbgCall({ host: "lab" }), dbgCall({ authorization: "Bearer junk" })]);
  assert.equal(v.pass, true);
  assert.match(v.detail, /junk token/);
  assert.doesNotMatch(v.detail, new RegExp(KEY));
});

test("debug-route-signer-key-leak: the lab's leaked key really is a valid 66-char key for the reported address", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../packs/web/lab/dapp/oracle/server.mjs", import.meta.url), "utf8");
  const key = /signerPrivateKey:\s*"(0x[0-9a-f]+)"/.exec(src)[1];
  assert.equal(key.length, 66);
  const { Wallet } = await import("ethers");
  assert.equal(new Wallet(key).address, /signerAddress:\s*"(0x\w+)"/.exec(src)[1]);
});

test("debug-route-signer-key-leak: no proof of 'no authentication' is not a pass", () => {
  // Only ever called with a (real) session token: auth never shown to be unneeded.
  const t = [verify(), dbgCall({ authorization: "Bearer t1" })];
  const v = debugLeak.check(t);
  assert.equal(v.pass, false);
  assert.match(v.detail, /NO headers|no credentials/i);
  // Bare call only, no junk-token call.
  assert.equal(debugLeak.check([dbgCall({ host: "lab" })]).pass, false);
  // The 'junk' token is actually a server-minted one: not junk.
  assert.equal(debugLeak.check([verify(), dbgCall({ host: "lab" }), dbgCall({ authorization: "Bearer t1" })]).pass, false);
  // The junk call returned a different body: the route does look at the credential.
  assert.equal(debugLeak.check([dbgCall({ host: "lab" }), dbgCall({ authorization: "Bearer junk" }, { resBody: { ...leakBody, chainId: 2 } })]).pass, false);
  assert.equal(debugLeak.check([dbgCall({ host: "lab" }, { status: 404 })]).pass, false);
  assert.equal(debugLeak.check([]).pass, false);
});

test("debug-route-signer-key-leak: a malformed or mismatched key is not a pass (63 hex chars, wrong address)", () => {
  const bad = (body) => [dbgCall({ host: "lab" }, { resBody: body }), dbgCall({ authorization: "Bearer junk" }, { resBody: body })];
  assert.equal(debugLeak.check(bad({ signerPrivateKey: KEY.slice(0, -1), signerAddress: ADDR })).pass, false);
  assert.equal(debugLeak.check(bad({ signerPrivateKey: KEY, signerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })).pass, false);
  assert.equal(debugLeak.check(bad({ signerPrivateKey: "0xabc", signerAddress: ADDR })).pass, false);
});

test("query strings do not hide a call from the oracles (BOLA and debug route)", () => {
  // The proxy records path as the bare pathname; the full url keeps the query.
  const t = [verify(), { path: "/api/users/2/wallet", url: "http://lab:8080/api/users/2/wallet?x=1", status: 200, reqHeaders: { authorization: "Bearer t1" }, resBody: { id: 2, wallet: "0xabc", apiKey: "k" } }];
  assert.equal(bola.check(t).pass, true);
});

const html = (over = {}) => ({ method: "GET", path: "/explorer", url: "http://lab:8080/explorer?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E", status: 200, resHeaders: { "content-type": "text/html; charset=utf-8" }, resBody: "<p>No results for <b><img src=x onerror=alert(1)></b></p>", ...over });

test("reflected-xss: markup in the query, written back unescaped in a 200 HTML page, is a pass", () => {
  const v = xss.check([html()]);
  assert.equal(v.pass, true);
  assert.match(v.detail, /\/explorer/);
});

test("reflected-xss: an escaped page, plain text, a CSP, JSON, or a plain value is not a pass", () => {
  assert.equal(xss.check([html({ resBody: "<p>No results for <b>&lt;img src=x onerror=alert(1)&gt;</b></p>" })]).pass, false);
  assert.equal(xss.check([html({ resHeaders: { "content-type": "text/plain" } })]).pass, false);
  assert.equal(xss.check([html({ resHeaders: { "content-type": "text/html", "content-security-policy": "default-src 'none'" } })]).pass, false);
  assert.equal(xss.check([html({ status: 404 })]).pass, false);
  assert.equal(xss.check([html({ url: "http://lab:8080/explorer?q=hello", resBody: "<b>hello</b>" })]).pass, false);
  // The page must hold the REQUEST's value, not just any tag.
  assert.equal(xss.check([html({ resBody: "<p>nothing here</p>" })]).pass, false);
  assert.equal(xss.check([]).pass, false);
});

test("reflected-xss: the payload inside an attribute value or a <script> string is inert, not a pass", () => {
  const url = "http://lab:8080/explorer?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E";
  const P = "<img src=x onerror=alert(1)>";
  assert.equal(xss.check([html({ url, resBody: `<input value="${P}">` })]).pass, false);
  assert.equal(xss.check([html({ url, resBody: `<input value='${P}'>` })]).pass, false);
  assert.equal(xss.check([html({ url, resBody: `<script>var q = "${P}";</script>` })]).pass, false);
  assert.equal(xss.check([html({ url, resBody: `<textarea>${P}</textarea>` })]).pass, false);
  assert.equal(xss.check([html({ url, resBody: `<!-- ${P} -->` })]).pass, false);
  // An earlier, harmless tag with quotes does not confuse the scanner.
  assert.equal(xss.check([html({ url, resBody: `<a href="/x" title='t'>l</a><p>${P}</p>` })]).pass, true);
});

test("reflected-xss: a breakout payload that closes the attribute or script is a pass", () => {
  const brk = (q) => `http://lab:8080/explorer?q=${encodeURIComponent(q)}`;
  const A = '"><img src=x onerror=alert(1)>';
  assert.equal(xss.check([html({ url: brk(A), resBody: `<input value="${A}">` })]).pass, true);
  const S = "</script><img src=x onerror=alert(1)>";
  assert.equal(xss.check([html({ url: brk(S), resBody: `<script>var q = "${S}";</script>` })]).pass, true);
});

test("reflected-xss: only a CSP that really blocks inline script stops the pass", () => {
  const withCsp = (csp) => xss.check([html({ resHeaders: { "content-type": "text/html", "content-security-policy": csp } })]).pass;
  // Does not limit script at all -> still exploitable.
  assert.equal(withCsp("frame-ancestors 'none'"), true);
  assert.equal(withCsp("img-src 'self'; style-src 'self'"), true);
  // Allows inline -> still exploitable.
  assert.equal(withCsp("script-src 'self' 'unsafe-inline'"), true);
  assert.equal(withCsp("default-src 'self' 'unsafe-inline'"), true);
  // Blocks inline.
  assert.equal(withCsp("script-src 'self'"), false);
  assert.equal(withCsp("default-src 'none'"), false);
  assert.equal(withCsp("script-src 'self' 'unsafe-inline' 'nonce-abc123'"), false);
  assert.equal(withCsp("script-src 'sha256-xyz' 'unsafe-inline'"), false);
  // Two policies: the blocking one wins.
  assert.equal(withCsp("script-src 'unsafe-inline', script-src 'self'"), false);
});

test("reflected-xss: a ?query on the page path still matches (path is the bare pathname)", () => {
  assert.equal(xss.check([html({ path: "/explorer" })]).pass, true);
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
  assert.deepEqual(names, ["web_leads", "run_request_script", "submit_finding"]);
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

// ---- scan parsers and runner: pure, no Docker

const DALFOX = JSON.stringify([
  { type: "V", inject_type: "inHTML-none(1)", data: "http://lab:8080/explorer?=&q=test%3Csummary", param: "", payload: "<summary ontoggle=x>", severity: "High" },
  { type: "R", inject_type: "inHTML-URL", data: "http://lab:8080/explorer?q=test%27", param: "q", payload: "'><math>", severity: "Medium" },
  {},
]);
const NUCLEI = JSON.stringify({ "template-id": "touchstone-debug-config-exposed", info: { name: "Debug configuration route exposed without auth", severity: "high", description: "d" }, "matched-at": "http://lab:8080/internal/debug/config", "extracted-results": ["signerPrivateKey"], response: "SECRET-BODY-0xdeadbeef" }) + "\nnot json\n";
const ZAP = JSON.stringify({ site: [{ alerts: [
  { pluginid: "10038", name: "Content Security Policy (CSP) Header Not Set", riskcode: "2", cweid: "693", instances: [{ uri: "http://lab:8080/", param: "" }, { uri: "http://lab:8080/explorer?q=ZAP", param: "" }] },
  { pluginid: "10037", name: "X-Powered-By leak", riskcode: "1", cweid: "497", instances: [{ uri: "http://lab:8080/", param: "" }] },
] }] });

test("parseDalfox keeps one lead per URL: the verified hit, with the real parameter name", () => {
  const leads = parseDalfox(DALFOX);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].check, "reflected-xss");
  assert.equal(leads[0].impact, "High");
  assert.equal(leads[0].path, "/explorer");
  assert.equal(leads[0].param, "q");
  assert.deepEqual(parseDalfox("not json"), []);
});

test("parseNuclei makes a lead from a match and never copies the response body", () => {
  const leads = parseNuclei(NUCLEI);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].check, "debug-config-exposed");
  assert.equal(leads[0].impact, "High");
  assert.equal(leads[0].where, "/internal/debug/config");
  assert.match(leads[0].description, /signerPrivateKey/);
  assert.doesNotMatch(JSON.stringify(leads), /SECRET-BODY|deadbeef/);
});

test("parseZap makes one lead per alert and zapQueryUrls lists the URLs that take input", () => {
  const leads = parseZap(ZAP);
  assert.equal(leads.length, 2);
  assert.equal(leads[0].impact, "Medium");
  assert.match(leads[0].where, /\+1 more/);
  assert.deepEqual(zapQueryUrls(ZAP), ["http://lab:8080/explorer?q=ZAP"]);
});

test("mergeLeads sorts worst first and marks a path two tools flag as corroborated", () => {
  const merged = mergeLeads([
    { engine: "zap", check: "csp", impact: "Medium", path: "/explorer", where: "/explorer" },
    { engine: "dalfox", check: "reflected-xss", impact: "High", path: "/explorer", where: "/explorer" },
    { engine: "zap", check: "low", impact: "Low", path: "/", where: "/" },
  ]);
  assert.deepEqual(merged.map((l) => l.impact), ["High", "Medium", "Low"]);
  assert.equal(merged[0].corroborated, true);
  assert.equal(merged[2].corroborated, false);
});

test("docQueryUrls pulls documented input URLs out of the brief and the OpenAPI file", () => {
  const brief = "It has `GET /explorer?q=<address or tx hash>`. Also /api/users/1 and https://x.test/a?b=1 and /search?term=a&page=2.";
  assert.deepEqual(docQueryUrls(brief, "http://lab:8080/"), ["http://lab:8080/explorer?q=x", "http://lab:8080/search?term=a&page=2"]);
  assert.deepEqual(docQueryUrls("no queries here /api/me", "http://lab:8080"), []);
  assert.deepEqual(docQueryUrls(null, "http://lab:8080"), []);
});

test("scanWeb feeds dalfox the supplied input URLs, and reports 'no-input' (not 'ran') when it has none", async () => {
  const dalfoxCalls = [];
  const run = async ({ image, ws, cmd }) => {
    if (image.includes("zaproxy")) { writeFileSync(join(ws, "zap.json"), JSON.stringify({ site: [] })); return { code: 0 }; }
    if (image.includes("nuclei")) return { code: 0 };
    dalfoxCalls.push(cmd[2]);
    return { code: 0 };
  };
  const withUrls = await scanWeb({ net: "n", baseUrl: "http://lab:8080", run, urls: ["http://lab:8080/explorer?q=x"] });
  assert.deepEqual(dalfoxCalls, ["http://lab:8080/explorer?q=x"]);
  assert.equal(withUrls.coverage.find((c) => c.engine === "dalfox").status, "ran");

  dalfoxCalls.length = 0;
  const none = await scanWeb({ net: "n", baseUrl: "http://lab:8080", run });
  assert.deepEqual(dalfoxCalls, [], "dalfox is not launched with nothing to test");
  const d = none.coverage.find((c) => c.engine === "dalfox");
  assert.equal(d.status, "no-input");
  assert.match(d.reason, /not a clean result/);
  // The run view shows it as unavailable, with that reason, never as a clean run.
  const view = prepassView({ pack: "web", coverage: none.coverage, leads: [] });
  const tool = view.tools.find((t) => t.name === "dalfox");
  assert.notEqual(tool.status, "ran");
  assert.match(tool.reason, /not a clean result/);
});

test("prepass fails loudly, naming the build script, when the lab image is not built", async () => {
  const ws = mkdtempSync(join(tmpdir(), "web-noimg-"));
  try {
    await assert.rejects(() => web.prepass(ws, { image: "touchstone/no-such-lab:0" }), /not built[\s\S]*build-labs\.sh web/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("scanWeb runs all three tools, reads their files, and reports a failed tool as unavailable", async () => {
  const calls = [];
  const run = async ({ image, ws, network, cmd }) => {
    calls.push({ image, network });
    if (image.includes("zaproxy")) { writeFileSync(join(ws, "zap.json"), ZAP); return { code: 0, stdout: "", stderr: "" }; }
    if (image.includes("nuclei")) { writeFileSync(join(ws, "nuclei.jsonl"), NUCLEI); return { code: 0, stdout: "", stderr: "" }; }
    // dalfox is the tool that fails here, with no output.
    return { code: 127, stdout: "", stderr: "boom", timedOut: false };
  };
  const out = await scanWeb({ net: "n1", baseUrl: "http://lab:8080", run });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.network === "n1"));
  const status = Object.fromEntries(out.coverage.map((c) => [c.engine, c.status]));
  assert.deepEqual(status, { zap: "ran", nuclei: "ran", dalfox: "unavailable" });
  assert.ok(out.leads.some((l) => l.check === "debug-config-exposed"));
  const only = await scanWeb({ net: "n1", baseUrl: "http://lab:8080", run, only: ["nuclei"] });
  assert.deepEqual(only.coverage.map((c) => c.engine), ["nuclei"]);
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
await request("GET", "/internal/debug/config", { headers: { authorization: "Bearer junk-token" } });
`,
  "xss": `
await request("GET", "/explorer?q=" + encodeURIComponent("<img src=x onerror=alert(1)>"));
`,
}[name]);

test("web smoke: run_request_script finds all four planted bugs and prove() replays each on a fresh lab", { skip: !hasImage && "image not built", timeout: 600_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    assert.equal(packFor(readTouchstone(ws)).id, "web");
    const events = [];
    const prep = await web.prepass(ws, { emit: (e) => events.push(e) });
    assert.equal(events[0].ev, "web-lab-started");

    // The prepass ran all three tools and found the planted leads. It must NOT
    // find the two bugs that need a signed-in session: a clean scan misses them.
    assert.deepEqual(prep.record.coverage.map((c) => `${c.engine}:${c.status}`).sort(), ["dalfox:ran", "nuclei:ran", "zap:ran"]);
    const checks = prep.record.leads.map((l) => l.check);
    assert.ok(checks.includes("reflected-xss"), checks.join(","));
    assert.ok(checks.includes("debug-config-exposed"), checks.join(","));
    assert.ok(!checks.some((c) => /idor|nonce|bola/i.test(c)), "a clean scan must not see the session bugs");
    assert.doesNotMatch(JSON.stringify(prep), /signerPrivateKey"\s*:\s*"0x/);

    const state = { poc: 0, passed: new Map(), found: [] };
    const tools = Object.fromEntries(web.tools(ws, state).map((t) => [t.name, t]));

    const labels = { "siwe-nonce-replay": "nonce-replay", "bola-wallet-idor": "idor", "debug-route-signer-key-leak": "debug-leak", "reflected-xss": "xss" };
    for (const [oracleName, label] of Object.entries(labels)) {
      const run = await tools.run_request_script.execute({ label, script: scriptFor(label) });
      assert.ok(!run.isError, run.output?.[0]?.text);
      assert.match(run.output[0].text, /MATCH/, `${label} should match a known pattern:\n${run.output[0].text}`);
      assert.equal(state.passed.get(label)?.oracleName, oracleName);
      const sub = await tools.submit_finding.execute({ title: label, severity: "high", label, explanation: "x. Fix: x" });
      assert.ok(!sub.isError, sub.output?.[0]?.text);
    }
    assert.equal(state.found.length, 4);

    const proved = await web.prove(ws, state.found, [], () => {});
    assert.equal(proved.length, 4);
    for (const finding of proved) {
      assert.equal(finding.proof.kind, "http", finding.poc);
      assert.equal(finding.proof.status, "pass", `${finding.poc}: ${finding.proof.detail}`);
      assert.equal(finding.proof.oracle.passed, true, finding.poc);
    }

    // No raw secret reaches what the app renders. The viewer's own sha256
    // fingerprints (64 hex) are hashes, so they are dropped before the check.
    for (const finding of proved) {
      const shown = JSON.stringify(proofView(finding)).replace(/"sha256":"[0-9a-f]{64}"/g, "");
      assert.doesNotMatch(shown, /[0-9a-fA-F]{64}|sk-lab-|PAYROLL/, `${finding.poc}: a raw secret is rendered`);
    }
  } finally {
    cleanupWorkspace(ws);
  }
});
