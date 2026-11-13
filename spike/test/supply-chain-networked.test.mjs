// Networked tools in the supply-chain pack (packs/supply-chain/networked.mjs).
//
// The offline tests read the REAL saved Scorecard output in
// fixtures/supply-chain-networked/scorecard.json: a `--local` run on the
// target's committed files, and a real capture-mode run against the GitHub API.
// No canned tool output stands in for a success. Replay never runs a tool.
//
//   node --test spike/test/supply-chain-networked.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "../lib/wrap.mjs";
import { pinSnapshot, replayEvidence, sha256 } from "../lib/proof-evidence.mjs";
import { SCORECARD, captureScorecard, prepareNetworkedSnapshot, scorecardFrom, networkedResults, networkedDetectors, scorecardReason } from "../packs/supply-chain/networked.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/supply-chain-networked/scorecard.json", import.meta.url), "utf8"));
const FAKE_TOKEN = "github_pat_FAKEFAKEFAKEFAKEFAKE_0123456789abcdef";
const reach = { granted: true, scope: ["hemaaanth/touchstone"] };
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
  const runs = [];
  const run = async (o) => { runs.push(o); return o.capture ? runTool(o) : { code: 0, stdout: "", stderr: "", timedOut: false }; };

  let c = await captureScorecard(snap, { target: null, reach, token: FAKE_TOKEN, run });
  assert.equal(c.api.status, "unavailable"); assert.match(c.api.reason, /no GitHub repo target/);
  assert.equal(c.local.status, "unavailable", "empty local output is not a clean run");

  c = await captureScorecard(snap, { target, reach, token: "", run });
  assert.match(c.api.reason, /no GITHUB_TOKEN/);

  // The real runTool refuses an ungranted capture before any container starts.
  c = await captureScorecard(snap, { target, reach: { granted: true, scope: ["hemaaanth/other"] }, token: FAKE_TOKEN, run });
  assert.match(c.api.reason, /capture refused: .*not in the granted scope/);
  c = await captureScorecard(snap, { target, reach: undefined, token: FAKE_TOKEN, run });
  assert.match(c.api.reason, /capture refused/);

  const timed = async (o) => ({ code: 1, stdout: '{"checks":[]}', stderr: "", timedOut: true });
  c = await captureScorecard(snap, { target, reach, token: FAKE_TOKEN, run: timed });
  assert.equal(c.api.status, "unavailable"); assert.equal(c.api.reason, "timed out");

  for (const stdout of ["not json", "{}", JSON.stringify({ ...JSON.parse(fx.captures.scorecard.local.text), scorecard: { version: "v9.9.9" } })]) {
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
  const run = async (o) => (o.capture ? runTool({ ...o, capture: { ...o.capture, confine, exec } }) : (localRuns.push(o), { code: 0, stdout: "", stderr: "" }));
  await captureScorecard({ version: 1, scope: "github-commit", commit: "a".repeat(40), files: { "a.txt": "x" } }, { target, reach, token: FAKE_TOKEN, run });

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
  assert.equal(localRuns[0].network, undefined, "the local run keeps runTool's default --network none");
});

test("the token value appears nowhere in the pinned snapshot, even when the tool prints it", async () => {
  const confine = async () => ({ netClient: "touchstone-reach-client-t", proxyName: null, gateUrl: "http://scope-gate:8080", stop: async () => {} });
  const exec = async (args, { env }) => ({ code: 1, stdout: `{"token":"${env.GITHUB_TOKEN}"}`, stderr: `401 Bad credentials for ${env.GITHUB_TOKEN}`, timedOut: false });
  const run = async (o) => (o.capture ? runTool({ ...o, capture: { ...o.capture, confine, exec } }) : { code: 0, stdout: `echo ${FAKE_TOKEN}`, stderr: "" });
  const ws = mkdtempSync(join(tmpdir(), "touchstone-net-tok-"));
  try {
    const base = { version: 1, scope: "folder", files: { "a.txt": "x" }, skipped: [] };
    const { snapshot } = await prepareNetworkedSnapshot(ws, { networkTools: ["scorecard"], networkTarget: "hemaaanth/touchstone", reach }, { token: FAKE_TOKEN, run, base });
    assert.equal(snapshot.captures.scorecard.api.status, "ran");
    for (const f of readdirSync(ws)) assert.ok(!readFileSync(join(ws, f), "utf8").includes(FAKE_TOKEN), `${f} holds the token`);
    assert.ok(readFileSync(join(ws, "snapshot.json"), "utf8").includes("[REDACTED]"));
    const d = networkedResults(snapshot);
    assert.ok(!JSON.stringify(d).includes(FAKE_TOKEN));
    // The pinned snapshot is reused: a second prepare does not run the tool again.
    let reran = false;
    await prepareNetworkedSnapshot(ws, { networkTools: ["scorecard"] }, { token: FAKE_TOKEN, run: async () => { reran = true; return {}; } });
    assert.equal(reran, false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(JSON.stringify(fx)), "the saved real fixture holds no token");
});

test("no opt-in: a snapshot without captures gives no networked leads, coverage or gaps", async () => {
  assert.deepEqual(networkedResults({ files: {} }), { leads: [], coverage: [], gaps: [] });
  await assert.rejects(prepareNetworkedSnapshot(mkdtempSync(join(tmpdir(), "touchstone-net-bad-")), { networkTools: ["nmap"] }, { base: { files: {} } }), /Unknown networked tool/);
});
