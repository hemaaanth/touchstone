// N3, old records: a stored finding whose replay only repeated a measurement
// reads as a measured candidate, at read time. Nothing rewrites a record or a
// stream. The fixtures are the stored shapes (titles are check ids), with
// made-up hosts and no secret.
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "measured-records-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const HASH = "cd".repeat(32);
const site = (check, k) => ({
  title: check, severity: "low", poc: `lead-${k}`, explanation: `The pinned snapshot shows ${check}.`, pocProved: true, proven: true,
  evidence: { check, where: { host: "site.test" }, snapshotHash: HASH },
  proof: { kind: "evidence", status: "pass", check, snapshotHash: HASH, detail: "Allowlisted detector confirmed the pinned evidence." },
});
const SIX = ["tls-cipherlist_3des_idea", "tls-breach", "weak-csp", "email-dmarc-no-reporting", "tls-dns_caarecord", "dnssec-no-ds"];
const agentCandidate = { n: 1, pack: "web", title: "Admin export needs no session", severity: "high", poc: "probe", evidence: { kind: "transcript" }, explanation: "x\nFix: y", cites: [], kind: "candidate", candidate: true, assertedBy: "agent", proven: false, provedBy: null };

// 1. The owner's site run: six evidence findings, all once shown "Proven".
const OWNER = "qwen-abl-2611131928-5905930002";
const ownerRecord = { result: { pack: "web", target: { title: "My site", pack: "web" }, outcome: "recorded", recorded: true, decision: "approved", findings: SIX.map(site), candidates: [agentCandidate] } };
const ids = SIX.map((_, k) => `${OWNER}.${k + 1}`);
const stream = [
  { t: 1, ev: "scope", scope: { title: "My site", pack: "web" } },
  { t: 2, ev: "status", status: "running" },
  { t: 3, ev: "candidate-submitted", candidate: agentCandidate },
  ...SIX.map((check, k) => ({ t: 4 + k, ev: "finding-submitted", n: k + 1, title: check, severity: "low", poc: `lead-${k}` })),
  { t: 20, ev: "status", status: "deciding" },
  ...SIX.flatMap((check, k) => [
    { t: 21, ev: "finding", id: ids[k], runId: OWNER, title: check, severity: "low", poc: `lead-${k}`, proofKind: "evidence", proven: true },
    { t: 21, ev: "artifact-open", id: `proof-${ids[k]}`, title: "Replay proof", kind: "proof", findingId: ids[k] },
    { t: 21, ev: "artifact-done", id: `proof-${ids[k]}` },
  ]),
  { t: 22, ev: "status", status: "recorded", decision: "approve", findingId: ids[0], findingIds: ids },
  { t: 23, ev: "closed" },
];
writeFileSync(join(dir, `run-${OWNER}.json`), JSON.stringify(ownerRecord));
writeFileSync(join(dir, `run-${OWNER}.stream.jsonl`), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");

// 2. An older run with no stream: one proven http finding, one measured fact.
const MIXED = "ds-abl-2611101200-1";
const proven = { title: "A user can read another user's wallet", severity: "high", poc: "s1", pocProved: true, script: "await request('GET','/api/users/2')", proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor", detail: "user B read user A", passed: true }, log: [] } };
writeFileSync(join(dir, `run-${MIXED}.json`), JSON.stringify({ result: { pack: "web", target: { title: "Lab", pack: "web" }, outcome: "recorded", recorded: true, decision: "approved", findings: [site("weak-csp", 9), proven] } }));

const bytes = () => Object.fromEntries([`run-${OWNER}.json`, `run-${OWNER}.stream.jsonl`, `run-${MIXED}.json`].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const before = bytes();

const { listFindings, listCandidates, getFinding } = await import("../../app/server/findings.mjs");
const { handleFindings } = await import("../../app/server/runs-http.mjs");
const { handleApi } = await import("../../app/server/api.mjs");
const { getRun, listRuns } = await import("../../app/server/runs.mjs");

function call(url) {
  const req = { method: "GET", url, headers: {}, on() { return req; } };
  const out = { status: 0, body: "" };
  const res = { set statusCode(v) { out.status = v; }, get statusCode() { return out.status; }, setHeader() {}, end(b) { out.body = b == null ? "" : String(b); } };
  return handleFindings(req, res).then(() => out);
}

test("the owner's run lists no finding; its six read as measured candidates beside the agent's", async () => {
  const findings = await listFindings();
  assert.deepEqual(findings.filter((f) => f.runId === OWNER), []);
  const cands = (await listCandidates()).filter((c) => c.runId === OWNER);
  assert.deepEqual(cands.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7].map((k) => `${OWNER}.c${k}`));
  assert.deepEqual(cands.map((c) => c.origin), ["agent", ...SIX.map(() => "measured")]);
  for (const c of cands) {
    assert.equal(c.proven, false);
    assert.ok(!/^[^\s]+$/.test(c.title), `readable title: ${c.title}`);
  }
  assert.equal(cands[1].measured.words, "Measurement repeated: the replay found the same fact again. It shows no harm.");
});

test("(a) ids stay the same across two reads, for findings and candidates", async () => {
  const one = [await listFindings(), await listCandidates()];
  const two = [await listFindings(), await listCandidates()];
  assert.deepEqual(two.map((l) => l.map((x) => x.id)), one.map((l) => l.map((x) => x.id)));
  // The proven finding of the mixed run keeps its own id (.2); the measured row is c1.
  assert.deepEqual(one[0].filter((f) => f.runId === MIXED).map((f) => [f.id, f.proven]), [[`${MIXED}.2`, true]]);
  assert.deepEqual(one[1].filter((c) => c.runId === MIXED).map((c) => [c.id, c.origin, c.title]), [[`${MIXED}.c1`, "measured", "The Content-Security-Policy allows unsafe sources"]]);
});

test("(b) the list API, the copy texts, the report and the bundle hold no measured item as proven", async () => {
  const api = await handleApi("/api/findings");
  const listed = api.json ?? api;
  const items = Array.isArray(listed) ? listed : listed.findings;
  assert.ok(items.every((f) => !String(f.id).startsWith(OWNER)), "no owner row in the list");
  assert.deepEqual(items.filter((f) => f.proven).map((f) => f.id), [`${MIXED}.2`]);
  for (const id of [...ids, `${MIXED}.1`]) {
    assert.equal(await getFinding(id), null, id);
    for (const format of ["json", "md", "agent", "html", "bundle", "bundle-check"]) {
      assert.equal((await call(`/api/findings/${id}/report?format=${format}`)).status, 404, `${id} ${format}`);
    }
  }
  const md = await call(`/api/findings/${MIXED}.2/report?format=md`);
  assert.equal(md.status, 200);
  assert.ok(!md.body.includes("weak-csp"));
});

test("the run view at load: the six are measured candidates, the run is No finding, and nothing on disk changed", async () => {
  const run = getRun(OWNER);
  assert.equal(run.status, "no-finding");
  assert.deepEqual(run.findingIds, []);
  assert.deepEqual(run.submitted, []);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding"), []);
  assert.deepEqual(run.events.filter((e) => String(e.id ?? "").startsWith("proof-")), []);
  assert.deepEqual(run.candidates.map((c) => c.origin), ["agent", ...SIX.map(() => "measured")]);
  assert.ok(run.candidates.every((c) => c.proven === false && c.provedBy === null));
  assert.equal(listRuns().find((r) => r.id === OWNER).findings, 0);
  const mixed = getRun(MIXED);
  assert.equal(mixed.status, "recorded");
  assert.deepEqual(mixed.events.filter((e) => e.ev === "finding").map((e) => [e.id, e.proven]), [[`${MIXED}.2`, true]]);
  assert.deepEqual(mixed.candidates.map((c) => c.origin), ["measured"]);
  assert.deepEqual(bytes(), before, "no record or stream is rewritten");
});
