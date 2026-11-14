// chain-bench as an opt-in networked tool (packs/supply-chain/chain-bench.mjs),
// and raven, which stays blocked (networked-blocked.mjs).
//
// chain-bench runs in capture mode, behind the same gate as Scorecard and
// Legitify. Its image reads the token from SCM_TOKEN (the real-Docker proof is
// supply-chain-chain-bench-env.test.mjs). Here a capture seam stands in for the
// network: it checks what the pack asks for and answers with
// a synthetic report in chain-bench's real shape (fixtures/supply-chain-networked/chain-bench-example.json).
// A fake token must be in no argv, no record, no snapshot, no lead, no gap.
//
//   node --experimental-test-module-mocks --test spike/test/supply-chain-chain-bench.test.mjs
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "chain-bench-test-stores-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(storeDir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(storeDir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
after(() => rmSync(storeDir, { recursive: true, force: true }));

const { RAVEN, captureBlocked } = await import("../packs/supply-chain/networked-blocked.mjs");
const { CHAIN_BENCH, captureChainBench, chainBenchFrom } = await import("../packs/supply-chain/chain-bench.mjs");
const { prepareNetworkedSnapshot, networkedResults, networkedDetectors, NETWORKED_TOOLS } = await import("../packs/supply-chain/networked.mjs");
const { captureArgs } = await import("../lib/capture.mjs");
const { sha256 } = await import("../lib/proof-evidence.mjs");
// The run's own saved scope, made as the console's permission tick makes it.
const { addLiveScope } = await import("../lib/scopes-store.mjs");
const scopeId = addLiveScope({ hosts: ["example-org/example-repo"], pack: "supply-chain", permission: true }).id;

const FAKE_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKE0123456789ab";
const TARGET = { owner: "example-org", repo: "example-repo" };
const REPORT = readFileSync(new URL("./fixtures/supply-chain-networked/chain-bench-example.json", import.meta.url), "utf8");
const B64 = Buffer.from(FAKE_TOKEN).toString("base64");

// A capture seam: records what the pack asked for, builds the real docker argv
// from it (captureArgs), writes `report` where chain-bench would, and answers.
function seam({ report = REPORT, answer = {} } = {}) {
  const calls = [];
  const capture = async (opts) => {
    const argv = captureArgs({ name: "touchstone-capture-test", image: opts.image, cmd: opts.cmd, ws: opts.ws, network: "touchstone-capture-net", gate: "http://touchstone-gate:3128",
      user: "1000:1000", env: opts.env, secretNames: Object.keys(opts.secrets ?? {}) });
    calls.push({ ...opts, argv });
    if (report != null) writeFileSync(join(opts.ws, CHAIN_BENCH.report), report);
    return { code: 0, stdout: "", stderr: "", timedOut: false, egress: { tunnels: { "api.github.com": 1 }, blocked: {} }, ...answer };
  };
  return { capture, calls };
}
const holds = (x) => JSON.stringify(x).includes(FAKE_TOKEN);

test("the capture passes the token by name only: no argv, no env value, no record holds it", async () => {
  assert.ok(NETWORKED_TOOLS.includes("chain-bench"));
  const { capture, calls } = seam();
  const c = await captureChainBench({ target: TARGET, scopeId, token: FAKE_TOKEN, capture });
  assert.equal(calls.length, 1);
  const call = calls[0];
  // The gate: the run's own scope, one repo, GitHub API only.
  assert.equal(call.scopeId, scopeId);
  assert.deepEqual(call.targets, [TARGET]);
  assert.deepEqual(call.hosts, ["api.github.com"]);
  assert.equal(call.image, "touchstone/chain-bench:0.1.10-env");
  // The token: only as the secret SCM_TOKEN, which the capture passes by name.
  assert.deepEqual(Object.keys(call.secrets), ["SCM_TOKEN"]);
  assert.equal(call.secrets.SCM_TOKEN, FAKE_TOKEN);
  assert.equal(holds(call.cmd), false, "the token is in the tool's command");
  assert.equal(holds(call.env), false, "the token is in the env values put on the docker command line");
  assert.equal(holds(call.argv), false, "the token is in the docker argv");
  const e = call.argv.indexOf("SCM_TOKEN");
  assert.ok(e > 0 && call.argv[e - 1] === "-e", "the docker argv carries -e SCM_TOKEN, the name only");
  assert.deepEqual(call.cmd, ["scan", "--repository-url", "https://github.com/example-org/example-repo", "--output-file", "/work/chain-bench.json", "--quiet", "--no-color"]);
  // What the engine keeps.
  assert.equal(c.status, "ran");
  assert.equal(c.code, 0);
  assert.equal(c.text, REPORT);
  assert.equal(holds(c), false, "the token is in the saved record");
  // The scratch folder the report went to is gone.
  assert.throws(() => readdirSync(call.ws), /ENOENT/);
});

test("an opt-in capture through prepareNetworkedSnapshot: the report gives 1 lead, 4 gaps, partial coverage, and no token anywhere", async () => {
  const { capture } = seam();
  const ws = mkdtempSync(join(tmpdir(), "touchstone-cb-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["chain-bench"], networkTarget: "example-org/example-repo", scopeId }, { token: FAKE_TOKEN, capture, base });
    const d = networkedResults(snapshot);
    assert.deepEqual(d.leads.map((l) => [l.engine, l.check, l.impact]), [["chain-bench", "chain-bench/1.1.16", "Low"]]);
    assert.match(d.leads[0].description, /Ensure force pushes code to branches is denied.*severity Critical.*unproven lead/);
    assert.deepEqual(d.coverage.map((r) => [r.engine, r.status, r.reason, r.leads]), [["chain-bench", "ok", "5 of 7 rules unchecked", 1]]);
    assert.deepEqual(d.gaps.map((g) => g.kind).sort(), ["chain-bench-check-unknown", "chain-bench-check-unknown", "chain-bench-check-unknown", "not-covered-needs-scope"]);
    assert.ok(d.gaps.find((g) => g.kind === "not-covered-needs-scope").detail.startsWith("chain-bench could not check 2 rules (1.1.14, 1.1.15)"));
    // Everything the engine keeps: the pinned snapshot on disk, the results.
    for (const f of readdirSync(ws)) assert.equal(readFileSync(join(ws, f), "utf8").includes(FAKE_TOKEN), false, `${f} holds the token`);
    assert.equal(holds(snapshot) || holds(d), false);
    // Replay never confirms a chain-bench lead: it is a repo setting.
    const det = networkedDetectors()["tool:chain-bench"];
    assert.deepEqual(det(snapshot, d.leads[0].where), { ok: false });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a whole copy of the token in stderr is redacted; an encoded or partial copy anywhere drops the output", async () => {
  {
    const { capture } = seam({ answer: { stderr: `Authorization: token ${FAKE_TOKEN}` } });
    const c = await captureChainBench({ target: TARGET, scopeId, token: FAKE_TOKEN, capture });
    assert.equal(c.stderr, "Authorization: token [REDACTED]");
    assert.equal(holds(c), false);
  }
  for (const [where, answer, report] of [
    ["stdout", { stdout: `debug ${B64}` }, REPORT],
    ["report", {}, REPORT.replace('"url":', `"leak":"${FAKE_TOKEN.slice(3, 20)}","url":`)],
  ]) {
    const { capture } = seam({ report, answer });
    const c = await captureChainBench({ target: TARGET, scopeId, token: FAKE_TOKEN, capture });
    assert.equal(c.status, "unavailable", where);
    assert.equal(c.reason, "output contained part of the token", where);
    assert.equal(c.text, "", where);
    assert.equal(holds(c) || JSON.stringify(c).includes(B64) || JSON.stringify(c).includes(FAKE_TOKEN.slice(3, 20)), false, where);
  }
});

test("fail closed: no target, no token, a refused capture, a timeout, a bad exit, no report, a report for another repo", async () => {
  const run = (opts, s = seam()) => captureChainBench({ target: TARGET, scopeId, token: FAKE_TOKEN, capture: s.capture, ...opts });
  const cases = [
    [{ target: null }, /no GitHub repo target/],
    [{ token: "" }, /no GITHUB_TOKEN/],
    [{}, /capture refused: no grant/, seam({ report: null, answer: { code: -1, refused: "no grant" } })],
    [{}, /timed out/, seam({ answer: { code: 137, timedOut: true } })],
    [{}, /token rejected \(401\)/, seam({ report: null, answer: { code: 1, stdout: "401 Bad credentials" } })],
    [{}, /tool exited 1/, seam({ answer: { code: 1 } })],
    [{}, /no report/, seam({ report: null })],
    [{}, /no report/, seam({ report: "{}" })],
    [{}, /report is for https:\/\/github\.com\/someone\/else/, seam({ report: REPORT.replace("example-org/example-repo", "someone/else") })],
  ];
  for (const [opts, why, s] of cases) {
    const c = await run(opts, s);
    assert.equal(c.status, "unavailable", String(why));
    assert.match(c.reason, why);
    const d = chainBenchFrom({ captures: { "chain-bench": c } });
    assert.deepEqual(d.coverage.map((r) => r.status), ["unavailable"]);
    assert.equal(d.leads.length, 0);
    assert.ok(d.gaps.some((g) => /not a clean result/.test(g.detail)));
  }
});

test("a saved report that no longer matches its SHA-256, or has every rule unknown, gives no lead", () => {
  const ran = { tool: "chain-bench", status: "ran", code: 0, text: REPORT, sha256: sha256(REPORT), target: "example-org/example-repo" };
  assert.equal(chainBenchFrom({ captures: { "chain-bench": { ...ran, text: REPORT.replace("Failed", "Passed") } } }).coverage[0].reason, "saved output does not match its SHA-256");
  const all = JSON.parse(REPORT);
  for (const r of all.results) { r.result = "Unknown"; r.reason = "Organization is not fetched"; }
  const text = JSON.stringify(all);
  const d = chainBenchFrom({ captures: { "chain-bench": { ...ran, text, sha256: sha256(text) } } });
  assert.deepEqual([d.coverage[0].status, d.coverage[0].reason, d.leads.length], ["unavailable", "all 7 rules unchecked", 0]);
});

test("raven stays blocked: no docker call, a gap that names each true blocker, no lead", async () => {
  assert.ok(NETWORKED_TOOLS.includes("raven"));
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; };
  const c = await captureBlocked("raven", { target: TARGET, scopeId, token: FAKE_TOKEN, capture: run });
  assert.equal(calls, 0, "no docker call");
  assert.equal(c.status, "unavailable");
  assert.equal(c.reason, RAVEN.reason);
  for (const why of [/no single-repository mode/, /Redis plus Neo4j/, /raw\.githubusercontent\.com/]) assert.match(c.reason, why);
  const ws = mkdtempSync(join(tmpdir(), "touchstone-raven-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["raven"], networkTarget: "example-org/example-repo", scopeId }, { token: FAKE_TOKEN, run, capture: run, base });
    assert.equal(calls, 0, "prepare makes no docker call either");
    const d = networkedResults(snapshot);
    assert.equal(d.leads.length, 0);
    assert.deepEqual(d.coverage.map((r) => [r.engine, r.status]), [["raven", "unavailable"]]);
    assert.ok(d.gaps.some((g) => g.kind === "not-covered-tool-scope" && /raven is unavailable/.test(g.detail)));
    assert.equal(holds(snapshot), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
