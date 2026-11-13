// Networked tools in the supply-chain pack (packs/supply-chain/networked.mjs).
//
// The offline tests read the REAL saved Scorecard output in
// fixtures/supply-chain-networked/scorecard.json: a `--local` run on the
// target's committed files, and a real capture-mode run against the GitHub API.
// No canned tool output stands in for a success. Replay never runs a tool.
//
// Scope and grant stores are throwaway files; no real store or console token
// is read. No test reaches the network: the API capture goes through a
// stand-in boundary and docker, or is refused by the real gate first.
//
//   node --experimental-test-module-mocks --test spike/test/supply-chain-networked.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

const storeDir = mkdtempSync(join(tmpdir(), "supply-net-test-stores-"));
process.env.TOUCHSTONE_SCOPES_FILE = join(storeDir, "scopes.json");
process.env.TOUCHSTONE_GRANTS_FILE = join(storeDir, "grants.json");
process.env.TOUCHSTONE_GRANT_TOKEN = "test-token-not-real";
after(() => rmSync(storeDir, { recursive: true, force: true }));

const { holdsSecret, runCapture } = await import("../lib/capture.mjs");
const { pinSnapshot, replayEvidence, sha256 } = await import("../lib/proof-evidence.mjs");
const { SCORECARD, captureScorecard, prepareNetworkedSnapshot, scorecardFrom, networkedResults, networkedDetectors, scorecardReason, scorecardExitOk } = await import("../packs/supply-chain/networked.mjs");
const { addLiveScope } = await import("../lib/scopes-store.mjs");

const fx = JSON.parse(readFileSync(new URL("./fixtures/supply-chain-networked/scorecard.json", import.meta.url), "utf8"));
const FAKE_TOKEN = "github_pat_FAKEFAKEFAKEFAKEFAKE_0123456789abcdef";
// The run's own saved scope, made as the console's permission tick makes it.
const scopeId = addLiveScope({ hosts: ["hemaaanth/touchstone"], pack: "supply-chain", permission: true }).id;
// A stand-in boundary: runCapture's real gate runs, then a fake docker.
const boundary = async () => ({ netClient: "touchstone-reach-client-t", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} });
const seam = (exec, confine = boundary) => (o) => runCapture({ ...o, confine, exec });
const target = { owner: "hemaaanth", repo: "touchstone" };

// The snapshot the real local run read: every real path, the real bytes of each
// file a lead names, and the real skipped list. Other contents are not needed:
// the detectors read only lead files and file names.
function fixtureSnapshot(over = {}) {
  const files = Object.create(null);
  for (const p of fx.paths) files[p] = fx.files[p] ?? "";
  return { version: 1, scope: fx.scope, commit: fx.commit, files, skipped: fx.skipped, gaps: [], captures: structuredClone(fx.captures), ...over };
}
const evidenceFor = (lead, snapshotHash) => ({ check: `tool:${lead.engine}`, where: lead.where, snapshotHash });
function pinned(snapshot) {
  const ws = mkdtempSync(join(tmpdir(), "touchstone-net-test-"));
  return { ws, hash: pinSnapshot(ws, snapshot), done: () => rmSync(ws, { recursive: true, force: true }) };
}

test("real local capture: Scorecard leads come from the saved bytes, with file lines from the pinned snapshot", () => {
  const d = scorecardFrom(fixtureSnapshot());
  const got = d.leads.map((l) => `${l.check} ${l.file ?? "(repo)"}${l.lines[0] ? `:${l.lines[0]}` : ""}`).sort();
  assert.deepEqual(got, [
    "scorecard/Dependency-Update-Tool (repo)",
    "scorecard/License (repo)",
    "scorecard/Pinned-Dependencies/containerImage spike/packs/ai-mcp/Dockerfile.inspector:4",
    "scorecard/Pinned-Dependencies/containerImage spike/packs/ai-mcp/lab/mcp/oracle/Dockerfile:3",
    "scorecard/Pinned-Dependencies/npmCommand spike/packs/ai-mcp/Dockerfile.inspector:5",
    "scorecard/Security-Policy (repo)",
  ]);
  for (const l of d.leads) assert.equal(l.where.sha256, fx.captures.scorecard.local.sha256);
  assert.deepEqual(d.coverage.map((c) => [c.engine, c.status]), [["scorecard-local", "ok"], ["scorecard-api", "unavailable"]]);
});

test("real API capture fails closed: exit 0 with empty output is unavailable plus a gap, never clean", () => {
  const api = fx.captures.scorecard.api;
  assert.equal(api.code, 0, "Scorecard really exits 0 when it skips an unreachable repo");
  assert.equal(api.text, "");
  assert.equal(api.status, "unavailable");
  const d = scorecardFrom(fixtureSnapshot());
  const row = d.coverage.find((c) => c.engine === "scorecard-api");
  assert.match(row.reason, /404/);
  assert.equal(row.leads, 0);
  assert.ok(d.gaps.some((g) => g.kind === "networked-tool-unavailable" && /Branch-Protection/.test(g.detail) && /not a clean result/.test(g.detail)));
  assert.deepEqual(api.egress, { tunnels: { "api.github.com": 1 }, blocked: {} }, "the capture reached only api.github.com");
});

test("results that look clean but are not become gaps: Vulnerabilities and Binary-Artifacts", () => {
  const local = JSON.parse(fx.captures.scorecard.local.text);
  assert.equal(local.checks.find((c) => c.name === "Vulnerabilities").score, 10, "the real run scored 10 with no network");
  const d = scorecardFrom(fixtureSnapshot());
  assert.ok(d.gaps.some((g) => /Vulnerabilities is not used/.test(g.detail)));
  assert.ok(d.gaps.some((g) => /Binary-Artifacts is not used/.test(g.detail)));
  assert.ok(!d.leads.some((l) => /Vulnerabilities|Binary-Artifacts|Fuzzing|SAST/.test(l.check)), "no lead or clean claim from those checks");
});

test("offline replay: every local lead passes against the pinned snapshot, from the saved bytes only", async () => {
  const snap = fixtureSnapshot();
  const { ws, hash, done } = pinned(snap);
  try {
    const { leads } = networkedResults(snap);
    assert.equal(leads.length, 6);
    for (const l of leads) assert.equal((await replayEvidence(ws, evidenceFor(l, hash), { detectors: networkedDetectors() })).status, "pass", l.check);
  } finally { done(); }
});

test("tampering fails replay: changed bytes, a changed file line, a file that appears, a truncated capture", async () => {
  const det = networkedDetectors()["tool:scorecard"];
  const base = fixtureSnapshot();
  const leads = scorecardFrom(base).leads;
  const pin = leads.find((l) => l.check.endsWith("/containerImage") && l.file === "spike/packs/ai-mcp/Dockerfile.inspector");
  const lic = leads.find((l) => l.check === "scorecard/License");
  assert.deepEqual(det(base, pin.where), { ok: true });

  const bytes = fixtureSnapshot(); bytes.captures.scorecard.local.text = bytes.captures.scorecard.local.text.replace("Pinned-Dependencies", "Pinned-Dependencie5");
  assert.deepEqual(det(bytes, pin.where), { ok: false }, "saved bytes no longer match their SHA-256");

  const resealed = fixtureSnapshot(); resealed.captures.scorecard.local.text = bytes.captures.scorecard.local.text; resealed.captures.scorecard.local.sha256 = sha256(resealed.captures.scorecard.local.text);
  assert.deepEqual(det(resealed, pin.where), { ok: false }, "a re-hashed capture does not match the lead's pinned hash");

  const line = fixtureSnapshot();
  const rows = line.files[pin.file].split("\n");
  rows[pin.lines[0] - 1] = rows[pin.lines[0] - 1].replace(/^(\s*FROM\s+\S+)/i, "$1@sha256:" + "a".repeat(64));
  line.files[pin.file] = rows.join("\n");
  assert.deepEqual(det(line, pin.where), { ok: false }, "the tool says unpinned, the pinned file says pinned: not proven");

  assert.deepEqual(det(fixtureSnapshot(), lic.where), { ok: true });
  const withLicense = fixtureSnapshot(); withLicense.files.LICENSE = "MIT";
  assert.deepEqual(det(withLicense, lic.where), { ok: false });
  const skippedLicense = fixtureSnapshot({ skipped: [...fx.skipped, { file: "LICENSE.md", reason: "too-large" }] });
  assert.deepEqual(det(skippedLicense, lic.where), { ok: false }, "a skipped file still counts as present");
  assert.deepEqual(det(fixtureSnapshot({ gaps: [{ kind: "github-tree-truncated" }] }), lic.where), { ok: false }, "absence is unknown when the capture was truncated");

  assert.deepEqual(det(base, { ...pin.where, line: pin.where.line + 1 }), { ok: false }, "a location the tool did not report");
  assert.deepEqual(det(base, { ...lic.where, capture: "api" }), { ok: false });
});

test("a repo-setting lead from an API capture never passes replay: the tool alone proves nothing", () => {
  const det = networkedDetectors()["tool:scorecard"];
  // Take the real local output and present it as an API capture of the target.
  const json = JSON.parse(fx.captures.scorecard.local.text);
  json.repo.name = "github.com/hemaaanth/touchstone";
  json.repo.commit = fx.commit;
  const text = JSON.stringify(json);
  const snap = fixtureSnapshot();
  snap.captures.scorecard.api = { ...snap.captures.scorecard.api, status: "ran", text, sha256: sha256(text), target: "hemaaanth/touchstone" };
  const api = scorecardFrom(snap).leads.filter((l) => l.where.capture === "api");
  assert.ok(api.length > 0, "SAST scored 0 in the real output, so an API lead exists");
  for (const l of api) { assert.equal(l.file, null); assert.deepEqual(det(snap, l.where), { ok: false }); }

  // A settings check the token cannot read is "not covered: needs scope X", not a score.
  json.checks.push({ name: "Branch-Protection", score: -1, reason: "internal error: GET .../branches/main/protection: 403 Resource not accessible by personal access token", details: null },
    { name: "Webhooks", score: -1, reason: "internal error: 403 Resource not accessible by personal access token", details: null });
  const t2 = JSON.stringify(json);
  snap.captures.scorecard.api = { ...snap.captures.scorecard.api, text: t2, sha256: sha256(t2) };
  const d = scorecardFrom(snap);
  assert.ok(d.gaps.some((g) => g.kind === "not-covered-needs-scope" && /Branch-Protection: not covered: needs scope Administration: read/.test(g.detail)));
  assert.ok(d.gaps.some((g) => g.kind === "not-covered-needs-scope" && /Webhooks: not covered: needs scope Webhooks: read/.test(g.detail)));
  assert.ok(!d.leads.some((l) => /Branch-Protection|Webhooks/.test(l.check)));
});

test("fail closed: no target, no token, no grant, timeout, junk output, wrong version", async () => {
  const snap = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
  let docker = 0;
  const run = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
  // The real gate, with a docker and a boundary that count calls.
  const capture = seam(async () => { docker++; return { code: 0, stdout: "", stderr: "" }; }, async () => { docker++; return boundary(); });

  let c = await captureScorecard(snap, { target: null, scopeId, token: FAKE_TOKEN, run, capture });
  assert.equal(c.api.status, "unavailable"); assert.match(c.api.reason, /no GitHub repo target/);
  assert.equal(c.local.status, "unavailable", "empty local output is not a clean run");

  c = await captureScorecard(snap, { target, scopeId, token: "", run, capture });
  assert.match(c.api.reason, /no GITHUB_TOKEN/);

  // The real gate refuses before any container starts: no scope, another repo.
  c = await captureScorecard(snap, { target, scopeId: null, token: FAKE_TOKEN, run, capture });
  assert.match(c.api.reason, /^not covered: capture refused: A capture needs the run's own saved scope/);
  c = await captureScorecard(snap, { target: { owner: "hemaaanth", repo: "other" }, scopeId, token: FAKE_TOKEN, run, capture });
  assert.match(c.api.reason, /^not covered: capture refused: hemaaanth\/other is not a repo of this scope/);
  assert.equal(docker, 0, "no boundary and no docker call for a refused capture");

  const timed = async (o) => ({ code: 1, stdout: '{"checks":[]}', stderr: "", timedOut: true });
  c = await captureScorecard(snap, { target, scopeId, token: FAKE_TOKEN, run: timed, capture: timed });
  assert.equal(c.api.status, "unavailable"); assert.equal(c.api.reason, "timed out");
  assert.equal(c.local.status, "unavailable"); assert.equal(c.local.reason, "timed out");

  for (const stdout of ["not json", "{}", '{"checks":[]}', '{"checks":null}', JSON.stringify({ ...JSON.parse(fx.captures.scorecard.local.text), scorecard: { version: "v9.9.9" } })]) {
    const s = fixtureSnapshot();
    s.captures.scorecard.local = { ...s.captures.scorecard.local, text: stdout, sha256: sha256(stdout) };
    const d = scorecardFrom(s);
    assert.equal(d.coverage.find((x) => x.engine === "scorecard-local").status, "unavailable", stdout.slice(0, 20));
    assert.equal(d.leads.length, 0);
  }
  assert.equal(scorecardReason({ code: 1, stderr: "GET https://api.github.com/rate_limit: 403 API rate limit exceeded" }), "rate limited");
  assert.equal(scorecardReason({ code: 1, stderr: "401 Bad credentials" }), "token rejected (401)");
});

test("capture argv for Scorecard: confined network, --pull=never, token by name, read-only flags; the local run has no network", async () => {
  const calls = [];
  const confine = async () => ({ netClient: "touchstone-reach-client-t", proxyName: "touchstone-reach-proxy-t", gateUrl: "http://scope-gate:8080", stop: async () => {} });
  const exec = async (args, { env }) => { calls.push({ args, env }); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const localRuns = [];
  const run = async (o) => (localRuns.push(o), { code: 0, stdout: "", stderr: "" });
  await captureScorecard({ version: 1, scope: "github-commit", commit: "a".repeat(40), files: { "a.txt": "x" } }, { target, scopeId, token: FAKE_TOKEN, run, capture: seam(exec, confine) });

  const { args, env } = calls.find((c) => c.args[0] === "run");
  assert.ok(args.includes("--pull=never"));
  assert.equal(args[args.indexOf("--network") + 1], "touchstone-reach-client-t");
  assert.equal(args[args.indexOf(SCORECARD.image) + 1], "--repo=github.com/hemaaanth/touchstone");
  assert.deepEqual(args.slice(args.indexOf(SCORECARD.image) + 1), ["--repo=github.com/hemaaanth/touchstone", `--commit=${"a".repeat(40)}`, "--format=json", "--show-details"]);
  assert.equal(args[args.indexOf("GITHUB_TOKEN") - 1], "-e");
  assert.ok(!args.join(" ").includes(FAKE_TOKEN));
  assert.equal(env.GITHUB_TOKEN, FAKE_TOKEN);
  // Scorecard's CLI has no write flags; make sure none slipped in.
  assert.ok(!args.some((a) => /^--(?:publish|serve|upload|token)/.test(a)));
  assert.equal(localRuns.length, 1);
  assert.equal(localRuns[0].capture, undefined, "the local run is not a capture");
  assert.equal(localRuns[0].image, SCORECARD.image);
  assert.equal(localRuns[0].network, undefined, "the local run keeps runTool's default --network none");
});

// The real argv of the local run: the real runTool, with a PATH docker shim
// that records its argv. A change to "bridge" or another tag fails here.
async function shimmedLocalArgv() {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-net-shim-"));
  const log = join(dir, "argv.jsonl");
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await captureScorecard({ version: 1, scope: "folder", files: { "a.txt": "x" } }, { target: null, scopeId, token: FAKE_TOKEN });
    return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((a) => a[0] === "run");
  } finally { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); }
}

test("local run argv (real runTool, PATH docker shim): --network none, the exact image tag, the local flags, no token", async () => {
  const args = await shimmedLocalArgv();
  assert.ok(args, "runTool called docker run");
  assert.equal(args.filter((a) => a === "--network").length, 1);
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(SCORECARD.image, "touchstone/scorecard:5.6.0");
  assert.ok(args.includes("touchstone/scorecard:5.6.0"));
  assert.deepEqual(args.slice(args.indexOf("touchstone/scorecard:5.6.0") + 1), SCORECARD.local);
  assert.ok(!args.join(" ").includes(FAKE_TOKEN), "the local run never gets the token");
  assert.ok(!args.some((a) => /TOKEN/.test(a)), "no token variable is passed to the local run");
  assert.match(args[args.indexOf("--name") + 1], /^touchstone-tool-[0-9a-f]{12}$/, "named, so a timeout can remove it");
});

// --pull=never on the local run comes from runTool's shared argv (from main).
test("local run argv: --pull=never", async () => {
  assert.ok((await shimmedLocalArgv()).includes("--pull=never"));
});

test("the token value appears nowhere in the pinned snapshot, even when the tool prints it", async () => {
  const confine = async () => ({ netClient: "touchstone-reach-client-t", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} });
  const exec = async (args, { env }) => ({ code: 0, stdout: `{"token":"${env.GITHUB_TOKEN}"}`, stderr: `401 Bad credentials for ${env.GITHUB_TOKEN}`, timedOut: false });
  const run = async () => ({ code: 0, stdout: `echo ${FAKE_TOKEN}`, stderr: "" });
  const ws = mkdtempSync(join(tmpdir(), "touchstone-net-tok-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["scorecard"], networkTarget: "hemaaanth/touchstone", scopeId }, { token: FAKE_TOKEN, run, capture: seam(exec, confine), base });
    assert.equal(snapshot.captures.scorecard.api.status, "ran");
    for (const f of readdirSync(ws)) assert.ok(!readFileSync(join(ws, f), "utf8").includes(FAKE_TOKEN), `${f} holds the token`);
    assert.ok(readFileSync(join(ws, "snapshot.json"), "utf8").includes("[REDACTED]"));
    const d = networkedResults(snapshot);
    assert.ok(!JSON.stringify(d).includes(FAKE_TOKEN));
    // The pinned snapshot is reused: a second prepare does not run the tool again.
    let reran = false;
    await prepareNetworkedSnapshot(ws, { networkTools: ["scorecard"], scopeId }, { token: FAKE_TOKEN, run: async () => { reran = true; return {}; }, capture: async () => { reran = true; return {}; } });
    assert.equal(reran, false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(JSON.stringify(fx)), "the saved real fixture holds no token");
});

test("an encoded or split copy of the token: the capture is unavailable and the snapshot holds no part of it", async () => {
  const confine = async () => ({ netClient: "touchstone-reach-client-t", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} });
  const half = FAKE_TOKEN.length >> 1;
  for (const leak of [(t) => Buffer.from(t).toString("base64"), (t) => `${t.slice(0, half)}\n${t.slice(half)}`]) {
    const exec = async (args, { env }) => ({ code: 0, stdout: `{"checks":[],"note":"${leak(env.GITHUB_TOKEN)}"}`, stderr: "", timedOut: false });
    const run = async () => ({ code: 1, stdout: "", stderr: "" });
    const ws = mkdtempSync(join(tmpdir(), "touchstone-net-leak-"));
    try {
      const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
      const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["scorecard"], networkTarget: "hemaaanth/touchstone", scopeId }, { token: FAKE_TOKEN, run, capture: seam(exec, confine), base });
      const api = snapshot.captures.scorecard.api;
      assert.equal(api.status, "unavailable");
      assert.equal(api.reason, "output contained part of the token");
      assert.equal(api.text, "");
      for (const f of readdirSync(ws)) assert.ok(!holdsSecret(readFileSync(join(ws, f), "utf8"), [FAKE_TOKEN]), `${f} holds part of the token`);
      const d = networkedResults(snapshot);
      assert.ok(d.gaps.some((g) => /part of the token/.test(JSON.stringify(g))), "the drop is a gap");
      assert.equal(d.leads.filter((l) => l.engine === "scorecard-api").length, 0);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test("scan.mjs refuses a --network-target outside the capture allow-list before any work", () => {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-net-cli-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x");
    let code = 0, err = "";
    try { execFileSync("node", [new URL("../packs/supply-chain/scan.mjs", import.meta.url).pathname, dir, "--network-tools", "scorecard", "--network-target", "torvalds/linux", "--authorized", "test"], { stdio: "pipe", encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } }); }
    catch (e) { code = e.status; err = String(e.stderr); }
    assert.equal(code, 2);
    assert.match(err, /--network-target must be one of: hemaaanth\/touchstone/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The CLI: a capture needs --scope (the run's own saved scope). Nothing on the
// command line grants anything.
const scanCli = (args) => {
  try { execFileSync("node", [new URL("../packs/supply-chain/scan.mjs", import.meta.url).pathname, ...args], { stdio: "pipe", encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "" } }); return { code: 0, err: "" }; }
  catch (e) { return { code: e.status, err: String(e.stderr) }; }
};
test("scan.mjs: --network-tools needs --scope, and --scope needs --network-tools, before any work", () => {
  const dir = mkdtempSync(join(tmpdir(), "touchstone-net-cli-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x");
    let r = scanCli([dir, "--network-tools", "scorecard", "--network-target", "hemaaanth/touchstone"]);
    assert.equal(r.code, 2); assert.match(r.err, /--network-tools needs --scope <id>/);
    r = scanCli([dir, "--scope", scopeId]);
    assert.equal(r.code, 2); assert.match(r.err, /--scope is for --network-tools/);
    for (const t of ["https://github.com@evil.com/hemaaanth/touchstone", "hemaaanth/touchstone/../other", "https://evil.com/hemaaanth/touchstone", "hemaaanth-x/touchstone"]) {
      r = scanCli([dir, "--network-tools", "scorecard", "--network-target", t, "--scope", scopeId]);
      assert.equal(r.code, 2, t);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Each failure of the API capture is "unavailable" with a reason and a gap,
// never a clean check. The real gate runs; only docker is a stand-in.
test("Scorecard API capture fails closed: non-zero exit, timeout, empty, partial JSON, rate limit, 404", async () => {
  const full = JSON.parse(fx.captures.scorecard.local.text);
  full.repo = { name: "github.com/hemaaanth/touchstone", commit: fx.commit };
  const good = JSON.stringify(full);
  const cases = [
    [{ code: 2, stdout: "", stderr: "boom" }, /tool exited 2 with no usable output/],
    [{ code: 2, stdout: good, stderr: "" }, /tool exited 2, which is not a documented Scorecard exit/],
    [{ code: 0, stdout: good, stderr: "", timedOut: true }, /^timed out$/],
    [{ code: 0, stdout: "", stderr: "" }, /no usable output/],
    [{ code: 0, stdout: good.slice(0, good.length >> 1), stderr: "" }, /unparsable report|no usable output/],
    [{ code: 0, stdout: '{"checks":[]}', stderr: "" }, /unparsable report/],
    [{ code: 1, stdout: "", stderr: "GET https://api.github.com/repos/hemaaanth/touchstone: 403 API rate limit exceeded" }, /^rate limited$/],
    [{ code: 1, stdout: "", stderr: "GET https://api.github.com/repos/hemaaanth/touchstone: 404 Not Found" }, /repo unreachable \(404\)/],
  ];
  for (const [out, why] of cases) {
    const capture = seam(async (args) => (args[0] === "run" ? { timedOut: false, ...out } : { code: 0, stdout: "", stderr: "" }));
    const snap = fixtureSnapshot();
    const c = await captureScorecard(snap, { target, scopeId, token: FAKE_TOKEN, run: async () => fx.captures.scorecard.local, capture });
    snap.captures.scorecard.api = c.api;
    const d = scorecardFrom(snap);
    const row = d.coverage.find((x) => x.engine === "scorecard-api");
    assert.equal(row.status, "unavailable", JSON.stringify(out).slice(0, 80));
    assert.match(row.reason, why, JSON.stringify(out).slice(0, 80));
    assert.ok(d.gaps.some((g) => g.kind === "networked-tool-unavailable" && /Scorecard api run is unavailable/.test(g.detail) && /not a clean result/.test(g.detail)));
    assert.ok(!d.leads.some((l) => l.where.capture === "api"));
  }
});

test("no opt-in: a snapshot without captures gives no networked leads, coverage or gaps", async () => {
  assert.deepEqual(networkedResults({ files: {} }), { leads: [], coverage: [], gaps: [] });
  await assert.rejects(prepareNetworkedSnapshot(mkdtempSync(join(tmpdir(), "touchstone-net-bad-")), { networkTools: ["nmap"] }, { base: { files: {} } }), /Unknown networked tool/);
});

// ---- Fail-closed checklist ----

const withLocal = (mutate, over = {}) => {
  const s = fixtureSnapshot(over);
  const json = JSON.parse(s.captures.scorecard.local.text);
  mutate(json);
  const text = JSON.stringify(json);
  s.captures.scorecard.local = { ...s.captures.scorecard.local, text, sha256: sha256(text) };
  return s;
};
const localRow = (d) => d.coverage.find((c) => c.engine === "scorecard-local");

test("exit code: only 0, or Scorecard's exact '1 + checks failed + an internal-error check' pair, is a run", async () => {
  const real = fx.captures.scorecard.local;
  assert.equal(real.code, 1, "the real --local run exits 1 because Fuzzing has no network");
  assert.ok(scorecardExitOk(real.code, real.stderr, JSON.parse(real.text)), "the real pair is accepted");
  const json = JSON.parse(real.text);
  assert.equal(scorecardExitOk(2, real.stderr, json), false);
  assert.equal(scorecardExitOk(1, "", json), false, "1 without the message");
  assert.equal(scorecardExitOk(1, real.stderr, { checks: json.checks.filter((c) => !/internal error/.test(c.reason)) }), false, "1 without an errored check");
  // Through record(): valid JSON with an unexpected code gives no run.
  for (const code of [2, 137, -1]) {
    const c = await captureScorecard({ version: 1, scope: "folder", files: { "a.txt": "x" } }, { target: null, scopeId, run: async () => ({ code, stdout: real.text, stderr: real.stderr }) });
    assert.equal(c.local.status, "unavailable", `code ${code}`);
    assert.match(c.local.reason, new RegExp(`exited ${code}`));
  }
  // And in the saved snapshot: a "ran" capture with an undocumented code gives no leads.
  const s = fixtureSnapshot(); s.captures.scorecard.local.code = 2;
  const d = scorecardFrom(s);
  assert.equal(localRow(d).status, "unavailable"); assert.equal(d.leads.length, 0);
});

test("empty success: no expected check in the report is unparsable, not a clean scan", () => {
  const d = scorecardFrom(withLocal((j) => { j.checks = j.checks.filter((c) => !["Pinned-Dependencies", "License", "Security-Policy", "Dependency-Update-Tool"].includes(c.name)); }));
  assert.equal(localRow(d).status, "unavailable");
  assert.match(localRow(d).reason, /unparsable report: none of the 4 expected checks/);
  assert.equal(d.leads.length, 0);
  assert.ok(d.gaps.some((g) => g.kind === "networked-tool-unavailable"));
});

test("bound to this snapshot: a result for a file outside it is a gap; a missing check is a gap; a wrong commit is unavailable", () => {
  const extra = ["Warn: containerImage not pinned by hash: ../outside/Dockerfile:1", "Warn: containerImage not pinned by hash: /etc/Dockerfile:2", "Warn: npmCommand not pinned by hash: not/in/snapshot/Dockerfile:3"];
  let d = scorecardFrom(withLocal((j) => { j.checks.find((c) => c.name === "Pinned-Dependencies").details.push(...extra); }));
  assert.equal(d.leads.filter((l) => l.check.startsWith("scorecard/Pinned-Dependencies")).length, 3, "only the real in-snapshot results");
  assert.equal(d.gaps.filter((g) => g.kind === "scorecard-result-outside-snapshot").length, 3);
  assert.ok(!d.leads.some((l) => /outside|^\/etc|not\/in/.test(l.file ?? "")));

  d = scorecardFrom(withLocal((j) => { j.checks = j.checks.filter((c) => c.name !== "License"); }));
  assert.ok(d.gaps.some((g) => g.kind === "scorecard-check-missing" && /License/.test(g.detail)));
  assert.equal(localRow(d).status, "ok");
  assert.match(localRow(d).reason, /^1 of 4 checks unchecked: License$/);
  assert.ok(!d.leads.some((l) => l.check === "scorecard/License"));

  // An API report for another commit than the pinned one.
  const json = JSON.parse(fx.captures.scorecard.local.text);
  json.repo = { name: "github.com/hemaaanth/touchstone", commit: "b".repeat(40) };
  const text = JSON.stringify(json);
  const s = fixtureSnapshot();
  s.captures.scorecard.api = { ...s.captures.scorecard.api, status: "ran", code: 0, text, sha256: sha256(text), target: "hemaaanth/touchstone" };
  d = scorecardFrom(s);
  const api = d.coverage.find((c) => c.engine === "scorecard-api");
  assert.equal(api.status, "unavailable"); assert.match(api.reason, /not the pinned commit/);
  assert.ok(!d.leads.some((l) => l.where.capture === "api"));
  // And a report for another repo.
  json.repo = { name: "github.com/someone/else", commit: fx.commit };
  const t2 = JSON.stringify(json);
  s.captures.scorecard.api = { ...s.captures.scorecard.api, text: t2, sha256: sha256(t2) };
  assert.match(scorecardFrom(s).coverage.find((c) => c.engine === "scorecard-api").reason, /report is for github.com\/someone\/else/);
});

test("a Warn line that does not parse: below 10 it is a gap and the check is unchecked, never clean", () => {
  const odd = ["Warn: containerImage not pinned by hash: Dockerfile", "Warn: npmCommand not pinned by hash: Dockerfile:5 (in a RUN step)"];
  const only = (j, score) => { const p = j.checks.find((c) => c.name === "Pinned-Dependencies"); p.score = score; p.details = [...odd, "Info:   0 out of   2 containerImage dependencies pinned"]; };
  let d = scorecardFrom(withLocal((j) => only(j, 3)));
  const g = d.gaps.filter((x) => x.kind === "scorecard-detail-unparsed");
  assert.equal(g.length, 1);
  assert.match(g[0].detail, /Pinned-Dependencies \(local\) scored 3\/10 with 2 Warn line/);
  assert.match(localRow(d).reason, /Pinned-Dependencies/);
  assert.equal(d.leads.filter((l) => l.check.startsWith("scorecard/Pinned-Dependencies")).length, 0);
  // Parsed lines still give leads next to the gap.
  d = scorecardFrom(withLocal((j) => { const p = j.checks.find((c) => c.name === "Pinned-Dependencies"); p.details.push(odd[0]); }));
  assert.ok(d.gaps.some((x) => x.kind === "scorecard-detail-unparsed"));
  assert.equal(d.leads.filter((l) => l.check.startsWith("scorecard/Pinned-Dependencies")).length, 3);
  // A score of 10 has nothing to lose, and the real format gives no such gap.
  assert.ok(!scorecardFrom(withLocal((j) => only(j, 10))).gaps.some((x) => x.kind === "scorecard-detail-unparsed"));
  assert.ok(!scorecardFrom(fixtureSnapshot()).gaps.some((x) => x.kind === "scorecard-detail-unparsed"));
});

test("a gap is never shown as clean: -1 scores are gaps, the row counts them, all unchecked is unavailable", () => {
  let d = scorecardFrom(withLocal((j) => { const c = j.checks.find((x) => x.name === "Security-Policy"); c.score = -1; c.reason = "no files to analyze"; }));
  assert.ok(d.gaps.some((g) => g.kind === "scorecard-check-inconclusive" && /Security-Policy/.test(g.detail)));
  assert.match(localRow(d).reason, /^1 of 4 checks unchecked: Security-Policy$/);
  assert.ok(!d.leads.some((l) => l.check === "scorecard/Security-Policy"));

  d = scorecardFrom(withLocal((j) => { for (const c of j.checks) { c.score = -1; c.reason = "internal error: boom"; } }));
  assert.equal(localRow(d).status, "unavailable");
  assert.equal(localRow(d).reason, "all 4 checks unchecked");
  assert.equal(d.leads.length, 0);

  // The real report answers all four file checks, so its row carries no reason.
  assert.equal(localRow(scorecardFrom(fixtureSnapshot())).reason, undefined);
});

const hasImages = (() => {
  try { for (const i of ["alpine:3.20", SCORECARD.image]) execFileSync("docker", ["image", "inspect", i], { stdio: "ignore" }); return true; } catch { return false; }
})();
// The shared runTool timeout fault (a PID 1 that ignores SIGTERM) is fixed in
// one shared commit that reaches this branch through main. Here: a timeout is
// "unavailable" with a reason, never a run, even with valid output.
test("a timed-out local run is unavailable with reason 'timed out', even with valid JSON", async () => {
  const real = fx.captures.scorecard.local;
  const c = await captureScorecard({ version: 1, scope: "folder", files: { "a.txt": "x" } }, { target: null, scopeId, run: async () => ({ code: 0, stdout: real.text, stderr: "", timedOut: true }) });
  assert.equal(c.local.status, "unavailable");
  assert.equal(c.local.reason, "timed out");
  const s = fixtureSnapshot(); s.captures.scorecard.local = c.local;
  assert.equal(scorecardFrom(s).leads.length, 0);
});

test("real local Scorecard run through runTool: no network, the exit pair is accepted, the lead names the pinned line", { skip: !hasImages && "docker or images missing", timeout: 120_000 }, async () => {
  const snap = { version: 1, scope: "folder", files: { "Dockerfile": "FROM alpine:3.20\nRUN npm install left-pad\n" }, skipped: [] };
  const { local } = await captureScorecard(snap, { target: null, scopeId });
  assert.equal(local.status, "ran", local.reason);
  assert.ok([0, 1].includes(local.code));
  const s = { ...snap, captures: { scorecard: { local, api: { status: "unavailable", reason: "no target" } } } };
  const d = scorecardFrom(s);
  assert.ok(d.leads.some((l) => l.check === "scorecard/Pinned-Dependencies/containerImage" && l.file === "Dockerfile" && l.lines[0] === 1));
});
