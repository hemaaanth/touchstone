// Candidates on the server paths main added after the candidate tier: a fleet
// run that a restart recovers, the proof check at the restart, and a
// follow-up in the run's kept workspace. Each path must keep a candidate
// unproven, out of the findings, and end it only for a proven finding.
// No model call and no Docker: the worker, the packs and the workspace are
// fakes, as in fleet-restart.test.mjs.
import "./helpers/isolated-env.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "candidate-surfaces-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
process.env.SPEND_LEDGER = join(dir, "spend.json");
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };

// The replay result per poc. Anything not named passes.
const replay = new Map();
const realPacks = await import("../packs/index.mjs");
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async () => ({ record: { pack: "web", coverage: [], leads: [] }, env: {} }),
  teardown: async () => {},
  // A finding that carries evidence gets an evidence replay (it repeats a
  // measurement); any other gets an http replay by a harm oracle.
  prove: async (_ws, found) => found.map((f) => ({ ...f, proof: f.evidence ? { kind: "evidence", status: "pass", check: f.evidence.check, snapshotHash: "ab".repeat(32) } : { kind: "http", status: replay.get(f.poc) ?? "pass", oracle: { name: "bola-wallet-idor" } } })),
}) } });
const workers = [];
const realChild = await import("node:child_process");
mock.module("node:child_process", { exports: { ...realChild, spawn: (_cmd, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit("exit", null, "SIGTERM");
  workers.push({ args, env: opts.env, child });
  return child;
} } });

const made = [];
function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  made.push(ws);
  return ws;
}

// Every saved candidate claims proof. The server must still keep it unproven.
const forged = (poc) => ({
  n: 1, pack: "web", title: `Export leaks rows (${poc})`, severity: "high", poc,
  evidence: { kind: "transcript", transcript: [{ method: "GET", path: "/admin/export", status: 200 }] },
  explanation: "Anyone can export rows.\nFix: check the session.", cites: ["GET /admin/export -> 200"], rootCause: `script:${poc}`, evidenceHash: `h-${poc}`,
  kind: "finding", assertedBy: "oracle", proven: true, candidate: false, provedBy: "oracle",
});
const head = [
  { t: 1, ev: "scope", scope: target },
  { t: 2, ev: "budget", usd: 5 },
  { t: 3, ev: "mode", mode: "fleet" },
  { t: 4, ev: "provider", provider: "boundless", model: "fake-model" },
  { t: 5, ev: "status", status: "running" },
  { t: 11, ev: "subagent-spawned", id: "a-2", name: "Alpha", title: "Map the export", area: "export", tier: "T1", parent: null, conv: "2" },
  { t: 12, ev: "agent-status", agent: "a-2", id: "a-2", state: "working" },
];
function save(name, events, state) {
  const id = `${name}-2611131200-1`;
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ target, mode: "fleet", budget: 5, provider: "boundless", model: "fake-model", modules: [], ...state }));
  writeFileSync(join(dir, `run-${id}.sqlite`), "the agent session");
  return id;
}
const submitted = { n: 1, title: "Login accepts a forged session", severity: "high", poc: "forged_session", source: "the passing script" };

// 1. A fleet the server stopped during its proof check. A child had recorded
// two candidates; one has the poc of the submitted finding.
const proofId = save("cand-proof", [
  ...head,
  { t: 20, ev: "candidate-submitted", agent: "a-2", candidate: forged("pause_probe") },
  { t: 21, ev: "candidate-submitted", agent: "a-2", candidate: forged("forged_session") },
  { t: 22, ev: "finding-submitted", agent: "a-2", ...submitted },
  { t: 29, ev: "settled", summary: { final: { text: "Coverage complete." } } },
  { t: 30, ev: "status", status: "deciding" },
], { ws: workspace(), phase: "proof", settled: { status: "done", findings: [submitted], candidates: [forged("pause_probe"), forged("forged_session")], summary: { calls: [] } } });

// 2. Two fleets the restart cut while a child worked. Each holds a candidate.
// The operator continues each with a message.
const cut = (name) => save(name, [...head, { t: 20, ev: "candidate-submitted", agent: "a-2", candidate: forged("pause_probe") }], { ws: workspace(), phase: "agent" });
const replyPassId = cut("cand-reply-pass");
const replyFailId = cut("cand-reply-fail");

// 3. N3: a site run the server stopped during its proof check. Every finding
// it submitted is a measured fact (an evidence replay), two of one check.
const measuredFinding = (n, check, host) => ({ n, title: check, severity: "low", poc: `lead-${n}`, explanation: `The snapshot shows ${check}.`, evidence: { check, where: { host }, snapshotHash: "ab".repeat(32) } });
const siteFound = [measuredFinding(1, "tls-cipherlist_3des_idea", "a.test"), measuredFinding(2, "weak-csp", "a.test"), measuredFinding(3, "weak-csp", "b.test")];
const siteId = save("cand-site", [
  ...head,
  { t: 20, ev: "candidate-submitted", agent: "a-2", candidate: forged("pause_probe") },
  ...siteFound.map((f, i) => ({ t: 21 + i, ev: "finding-submitted", agent: "a-2", n: f.n, title: f.title, severity: f.severity, poc: f.poc })),
  { t: 29, ev: "settled", summary: { final: { text: "Coverage complete." } } },
  { t: 30, ev: "status", status: "deciding" },
], { ws: workspace(), phase: "proof", settled: { status: "done", final: "Coverage complete.", findings: siteFound, candidates: [forged("pause_probe")], summary: { calls: [] } } });

const { getRun, listRuns, steerRun } = await import("../../app/server/runs.mjs");
after(() => {
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const closed = async (id) => {
  for (let i = 0; i < 300 && !getRun(id)?.events.some((e) => e.ev === "closed"); i++) await new Promise((r) => setTimeout(r, 10));
  return getRun(id);
};
const recordOf = (id) => JSON.parse(readFileSync(join(dir, `run-${id}.json`), "utf8")).result;
const onDisk = (id) => readFileSync(join(dir, `run-${id}.stream.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const unproven = (c) => c.proven === false && c.candidate === true && c.provedBy === null && c.kind === "candidate" && c.assertedBy === "agent";

test("a fleet restarted in its proof check keeps its child's candidate unproven; the proven finding ends only its own twin", async () => {
  const run = await closed(proofId);
  assert.equal(run.status, "recorded");
  assert.deepEqual(run.events.filter((e) => e.ev === "finding").map((e) => [e.poc, e.proven]), [["forged_session", true]]);
  assert.deepEqual(run.candidates.map((c) => c.poc), ["pause_probe"]);
  assert.ok(run.candidates.every(unproven));
  const r = recordOf(proofId);
  assert.deepEqual(r.findings.map((f) => f.poc), ["forged_session"]);
  assert.deepEqual(r.candidates.map((c) => c.poc), ["pause_probe"], "the record holds only the candidate that is left");
  assert.ok(r.candidates.every(unproven));
  assert.deepEqual(onDisk(proofId).filter((e) => e.ev === "candidate-superseded").map((e) => [e.poc, e.by]), [["forged_session", "forged_session"]]);
  assert.equal(listRuns().find((x) => x.id === proofId).findings, 1, "a candidate is not counted");
});

async function reply(id, { proof }) {
  await closed(id);
  replay.set("pause_probe", proof);
  assert.deepEqual(steerRun(id, "Prove the export leak."), { ok: true, followUp: true });
  const w = workers.filter((x) => x.env.EVENTS_FILE?.includes(id)).at(-1);
  assert.deepEqual(w.args.slice(1, 3), ["child", "chat"]);
  // The follow-up worker gets the run's candidates for its cap and guards,
  // in a short form that carries no proof field.
  const prior = JSON.parse(w.env.PRIOR_CANDIDATES);
  assert.deepEqual(prior.map((c) => c.poc), ["pause_probe"]);
  assert.ok(prior.every((c) => !("proven" in c) && !("provedBy" in c)));
  const say = (e) => w.child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
  say({ ev: "candidate-submitted", agent: "a-2", candidate: forged("upload_probe") });
  say({ ev: "finding-submitted", agent: "a-2", n: 1, title: "Export leaks rows", severity: "high", poc: "pause_probe" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(getRun(id).candidates.map((c) => c.poc), ["pause_probe", "upload_probe"], "a submitted finding does not end the candidate");
  say({ ev: "settled", status: "done", summary: { final: { text: "Done." }, calls: [] }, findings: [{ n: 1, title: "Export leaks rows", severity: "high", poc: "pause_probe", source: "script" }], candidates: [forged("upload_probe")], usage: { usd: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  w.child.emit("exit", 0, null);
  for (let i = 0; i < 300 && getRun(id).replying; i++) await new Promise((r) => setTimeout(r, 10));
  return getRun(id);
}

test("a follow-up in the kept workspace: its new candidate is recorded unproven, and a proven finding ends the old one", async () => {
  const run = await reply(replyPassId, { proof: "pass" });
  assert.deepEqual(run.candidates.map((c) => c.poc), ["upload_probe"]);
  assert.ok(run.candidates.every(unproven));
  const r = recordOf(replyPassId);
  assert.deepEqual(r.findings.map((f) => f.poc), ["pause_probe"]);
  assert.deepEqual(r.candidates.map((c) => c.poc), ["upload_probe"]);
  assert.ok(r.candidates.every(unproven));
});

test("a follow-up whose finding the replay does not prove keeps the candidate", async () => {
  const run = await reply(replyFailId, { proof: "fail" });
  assert.deepEqual(run.candidates.map((c) => c.poc), ["pause_probe", "upload_probe"]);
  const r = recordOf(replyFailId);
  assert.deepEqual(r.findings.map((f) => f.poc), ["pause_probe"], "the unproven finding is recorded as such");
  assert.deepEqual(r.candidates.map((c) => c.poc), ["pause_probe", "upload_probe"]);
  assert.ok(r.candidates.every(unproven));
  assert.equal(onDisk(replyFailId).some((e) => e.ev === "candidate-superseded"), false);
});

// N3, test (c) and the record: a run whose only results are measured facts
// records no finding, is not "Proven" and is not an error. Its measured
// candidates sit beside the agent's, and they do not reach a follow-up's cap.
test("a site run of measured facts records no finding; its candidates are measured, folded and outside the cap", async () => {
  const run = await closed(siteId);
  assert.equal(run.status, "no-finding");
  assert.deepEqual(run.findingIds, []);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding"), []);
  const r = recordOf(siteId);
  assert.deepEqual(r.findings, []);
  assert.equal(r.outcome, "no-finding");
  assert.deepEqual(r.candidates.map((c) => [c.origin, c.title]), [
    ["agent", "Export leaks rows (pause_probe)"],
    ["measured", "TLS offers weak 3DES or IDEA ciphers"],
    ["measured", "The Content-Security-Policy allows unsafe sources"],
  ]);
  const csp = r.candidates[2];
  assert.deepEqual(csp.evidence.items.map((i) => i.poc), ["lead-2", "lead-3"]);
  assert.equal(csp.measured.words, "Measurement repeated: the replay found the same fact again. It shows no harm.");
  assert.ok(r.candidates.every((c) => c.proven === false && c.provedBy === null));
  assert.equal(listRuns().find((x) => x.id === siteId).findings, 0);
  assert.equal(listRuns().find((x) => x.id === siteId).title, null, "no measured fact is the run's headline");
  // The same after a restart: the saved stream loads with the same split.
  const shared = globalThis.__touchstoneRuns;
  delete globalThis.__touchstoneRuns;
  let second;
  try {
    second = await import(`../../app/server/runs.mjs?measured-boot-${Date.now()}`);
  } finally {
    globalThis.__touchstoneRuns = shared;
  }
  const again = second.getRun(siteId);
  assert.equal(again.status, "no-finding");
  assert.deepEqual(again.submitted, []);
  assert.deepEqual(again.candidates.map((c) => c.origin), ["agent", "measured", "measured"]);
  // A follow-up's worker gets the agent's candidate only.
  const { priorCandidatesEnv } = await import("../../app/server/candidates.mjs");
  assert.deepEqual(JSON.parse(priorCandidatesEnv(run)).map((c) => c.poc), ["pause_probe"]);
});
