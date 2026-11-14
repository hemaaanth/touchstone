// Legitify as an opt-in networked tool (packs/supply-chain/networked-blocked.mjs).
//
// Legitify always fails closed: no lead parser has been checked against a real
// successful result. The fixture is the REAL capture against the target
// (fixtures/supply-chain-networked/legitify.json): Legitify rejects the
// fine-grained token before any request. No canned output stands in for it.
//
// Throwaway scope and grant stores; no real store or console token is read.
//
//   node --experimental-test-module-mocks --test spike/test/supply-chain-legitify.test.mjs
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "legitify-test-stores-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(storeDir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(storeDir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
after(() => rmSync(storeDir, { recursive: true, force: true }));

const { holdsSecret, runCapture } = await import("../lib/capture.mjs");
const { sha256 } = await import("../lib/proof-evidence.mjs");
const { LEGITIFY, captureLegitify, blockedFrom, legitifyReason } = await import("../packs/supply-chain/networked-blocked.mjs");
const { prepareNetworkedSnapshot, networkedResults, NETWORKED_TOOLS } = await import("../packs/supply-chain/networked.mjs");
// The run's own saved scope, made as the console's permission tick makes it.
const { addLiveScope } = await import("../lib/scopes-store.mjs");
const scopeId = addLiveScope({ hosts: ["hemaaanth/touchstone"], pack: "supply-chain", permission: true }).id;

const real = JSON.parse(readFileSync(new URL("./fixtures/supply-chain-networked/legitify.json", import.meta.url), "utf8"));
const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789ab";
const target = { owner: "hemaaanth", repo: "touchstone" };
const confine = async () => ({ netClient: "touchstone-reach-client-t", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} });
const seam = (exec) => async (o) => runCapture({ ...o, confine, exec });
const legRow = (d) => d.coverage.find((c) => c.engine === "legitify");

test("real capture: Legitify rejects the fine-grained token; the result is a not-covered gap, no lead, never clean", () => {
  assert.equal(real.image, "touchstone/legitify:1.0.11");
  assert.equal(real.code, 1);
  assert.equal(real.text, "");
  assert.equal(real.sha256, sha256(""));
  assert.deepEqual(real.egress, { tunnels: {}, blocked: {} }, "no request left the container");
  assert.match(real.stderr, /fine-grained tokens are not supported/);
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(JSON.stringify(real)), "the saved fixture holds no token");

  const d = networkedResults({ files: {}, captures: { legitify: real } });
  assert.equal(d.leads.length, 0);
  assert.equal(legRow(d).status, "unavailable");
  assert.match(legRow(d).reason, /^not covered: needs a classic PAT/);
  const gap = d.gaps.find((g) => g.kind === "not-covered-needs-token");
  assert.ok(gap && /not a clean result/.test(gap.detail));
});

test("capture argv for Legitify: --pull=never, the confined network, the exact tag, SCM_TOKEN by name, read-only flags", async () => {
  const calls = [];
  const exec = async (args, { env }) => { calls.push({ args, env }); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  await captureLegitify({ target, scopeId, token: FAKE_TOKEN, capture: seam(exec) });
  const { args, env } = calls.find((c) => c.args[0] === "run");
  assert.ok(args.includes("--pull=never"));
  assert.equal(args.filter((a) => a === "--network").length, 1);
  assert.equal(args[args.indexOf("--network") + 1], "touchstone-reach-client-t");
  assert.equal(LEGITIFY.image, "touchstone/legitify:1.0.11");
  assert.ok(args.includes("touchstone/legitify:1.0.11"));
  assert.deepEqual(args.slice(args.indexOf(LEGITIFY.image) + 1), LEGITIFY.cmd(target));
  assert.equal(args[args.indexOf("SCM_TOKEN") - 1], "-e");
  assert.ok(!args.join(" ").includes(FAKE_TOKEN), "the token value is not in argv");
  assert.equal(env.SCM_TOKEN, FAKE_TOKEN);
  const cmd = args.slice(args.indexOf(LEGITIFY.image) + 1);
  assert.equal(cmd[0], "analyze", "analyze only reads");
  for (const bad of ["-t", "--token", "gpt-analysis", "--server-url", "--ignore-invalid-certificate"]) assert.ok(!cmd.includes(bad), bad);
  assert.equal(cmd[cmd.indexOf("--scorecard") + 1], "no", "no nested Scorecard run");
  assert.deepEqual([cmd[cmd.indexOf("--repo") + 1], cmd[cmd.indexOf("-n") + 1]], ["hemaaanth/touchstone", "repository"], "one granted repo, nothing else");
});

test("fail closed: no target, no token, no grant, timeout, empty success, an undocumented exit code", async () => {
  let calls = 0;
  const never = seam(async () => { calls++; return { code: 0, stdout: "", stderr: "" }; });
  assert.match((await captureLegitify({ target: null, scopeId, token: FAKE_TOKEN, capture: never })).reason, /no GitHub repo target/);
  assert.match((await captureLegitify({ target, scopeId, token: "", capture: never })).reason, /no GITHUB_TOKEN/);
  // The real gate refuses before any container starts: no scope, or a repo the scope does not list.
  let c = await captureLegitify({ target, scopeId: null, token: FAKE_TOKEN, capture: never });
  assert.match(c.reason, /^not covered: capture refused: A capture needs the run's own saved scope/);
  assert.equal(c.gapKind, "not-covered-capture-refused");
  c = await captureLegitify({ target: { owner: "hemaaanth", repo: "other" }, scopeId, token: FAKE_TOKEN, capture: never });
  assert.match(c.reason, /capture refused: hemaaanth\/other is not a repo of this scope/);
  assert.ok(blockedFrom({ captures: { legitify: c } }).gaps.some((g) => g.kind === "not-covered-capture-refused"));
  assert.equal(calls, 0, "no docker call without a target, a token and a grant");

  const out = async (r) => captureLegitify({ target, scopeId, token: FAKE_TOKEN, capture: async () => ({ stderr: "", ...r }) });
  c = await out({ code: 0, stdout: '{"ok":1}', timedOut: true });
  assert.equal(c.status, "unavailable"); assert.equal(c.reason, "timed out");
  c = await out({ code: 0, stdout: "  \n" });
  assert.equal(c.status, "unavailable"); assert.equal(c.reason, "unparsable report: empty output");
  for (const code of [1, 2, 137]) {
    c = await out({ code, stdout: '{"violations":[]}' });
    assert.equal(c.status, "unavailable", `code ${code}`);
    assert.match(c.reason, new RegExp(`exited ${code}, which is not an accepted Legitify exit`));
  }
  assert.equal(legitifyReason({ code: 1, stderr: "GET https://api.github.com/x: 403 API rate limit exceeded" }), "rate limited");
  assert.equal(legitifyReason({ code: 1, stderr: "401 Bad credentials" }), "token rejected (401)");

  // Even exit 0 with output gives no lead and an unavailable row: no parser is trusted.
  c = await out({ code: 0, stdout: '{"violations":[{"policy":"x"}]}' });
  assert.equal(c.status, "ran");
  const d = blockedFrom({ captures: { legitify: c } });
  assert.equal(d.leads.length, 0);
  assert.equal(legRow(d).status, "unavailable");
  assert.match(legRow(d).reason, /no lead parser has been checked against a real legitify result/);
  // A saved output that does not match its pin is reported as such.
  assert.match(legRow(blockedFrom({ captures: { legitify: { ...c, text: c.text + "x" } } })).reason, /does not match its SHA-256/);
});

test("a base64 copy of the token from Legitify: unavailable, and the snapshot holds no part of it", async () => {
  const exec = async (args, { env }) => ({ code: 0, stdout: `{"auth":"${Buffer.from(`x:${env.SCM_TOKEN}`).toString("base64")}"}`, stderr: "", timedOut: false });
  const ws = mkdtempSync(join(tmpdir(), "touchstone-legit-leak-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["legitify"], networkTarget: "hemaaanth/touchstone", scopeId }, { token: FAKE_TOKEN, capture: seam(exec), base });
    assert.equal(snapshot.captures.legitify.status, "unavailable");
    assert.equal(snapshot.captures.legitify.reason, "output contained part of the token");
    for (const f of readdirSync(ws)) assert.ok(!holdsSecret(readFileSync(join(ws, f), "utf8"), [FAKE_TOKEN]), `${f} holds part of the token`);
    assert.equal(legRow(networkedResults(snapshot)).status, "unavailable");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("the token value appears nowhere in the pinned snapshot, even when Legitify prints it", async () => {
  assert.ok(NETWORKED_TOOLS.includes("legitify"));
  const exec = async (args, { env }) => ({ code: 0, stdout: `{"token":"${env.SCM_TOKEN}"}`, stderr: `401 Bad credentials for ${env.SCM_TOKEN}`, timedOut: false });
  const ws = mkdtempSync(join(tmpdir(), "touchstone-legit-tok-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["legitify"], networkTarget: "hemaaanth/touchstone", scopeId }, { token: FAKE_TOKEN, capture: seam(exec), base });
    assert.equal(snapshot.captures.legitify.status, "ran");
    assert.equal(snapshot.captures.scorecard, undefined, "only the opted-in tool ran");
    for (const f of readdirSync(ws)) assert.ok(!readFileSync(join(ws, f), "utf8").includes(FAKE_TOKEN), `${f} holds the token`);
    assert.ok(readFileSync(join(ws, "snapshot.json"), "utf8").includes("[REDACTED]"));
    assert.ok(!JSON.stringify(networkedResults(snapshot)).includes(FAKE_TOKEN));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
