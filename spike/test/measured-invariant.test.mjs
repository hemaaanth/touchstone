// N3 repair 3: the run view and the Findings page agree.
//
//   For a run, after any sequence of {load an old record, rename, archive,
//   follow-up that proves harm, follow-up that only measures, follow-up
//   reusing a label, dismissal, reload}, the run view's set of (id, proven)
//   findings and its set of live candidates equal what /api/findings lists
//   for that run.
//
// Driven over fixed sequences, including the engine re-review's probes D
// (a proven follow-up on an older run with a measured row), B (a rule that
// changed since the stream was written) and C (a proven finding that ends a
// derived candidate). No model call and no Docker: the worker and the pack
// are fakes, as in candidate-surfaces.
import "./helpers/isolated-env.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "measured-invariant-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
process.env.SPEND_LEDGER = join(dir, "spend.json");
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };
const H = "ab".repeat(32);

// Evidence: a repeated measurement. `xss`: reflected-xss (no effect shown).
// Anything else: a harm oracle, so the replay proves it.
const realPacks = await import("../packs/index.mjs");
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async () => ({ record: { pack: "web", coverage: [], leads: [] }, env: {} }),
  teardown: async () => {},
  prove: async (_ws, found) => found.map((f) => ({ ...f, proof: f.evidence ? { kind: "evidence", status: "pass", check: f.evidence.check, snapshotHash: H } : f.xss ? { kind: "http", status: "pass", oracle: { name: "reflected-xss" } } : { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } })),
}) } });
const workers = [];
const realChild = await import("node:child_process");
mock.module("node:child_process", { exports: { ...realChild, spawn: (_c, args, opts) => {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => c.emit("exit", null, "SIGTERM");
  workers.push({ args, env: opts.env, child: c });
  return c;
} } });

const made = [];
const workspace = () => {
  const ws = mkdtempSync(join(tmpdir(), "redteam-run-"));
  writeFileSync(join(ws, ".touchstone.json"), JSON.stringify({ kind: "lab", pack: "web" }));
  made.push(ws);
  return ws;
};
const idOf = (name) => `${name}-2611131200-1`;
const head = [{ t: 1, ev: "scope", scope: target }, { t: 2, ev: "budget", usd: 5 }, { t: 3, ev: "mode", mode: "fleet" }, { t: 4, ev: "provider", provider: "boundless", model: "fake-model" }, { t: 5, ev: "status", status: "running" }];
// A kept workspace the server accepts for a follow-up (its mark names the run).
const keep = (id) => {
  const ws = workspace();
  writeFileSync(join(ws, ".touchstone-run"), `${id}\n${realpathSync(dir)}`);
  writeFileSync(join(dir, `run-${id}.workspace.json`), JSON.stringify({ ws, target }));
};
const b7Row = { n: 1, title: "Old drain", severity: "high", poc: "OldTest", pocProved: true, proof: { kind: "forge", pass: true, status: "pass" } };
const cspRow = (k, host) => ({ n: k, title: "weak-csp", severity: "low", poc: `lead-${k}`, pocProved: true, evidence: { check: "weak-csp", where: { host } }, proof: { kind: "evidence", status: "pass", check: "weak-csp", snapshotHash: H } });
// An older record-only run (no stream), with a session and, if asked, a kept workspace.
const recordOnly = (name, rows, kept = false) => {
  const id = idOf(name);
  writeFileSync(join(dir, `run-${id}.json`), JSON.stringify({ result: { outcome: "recorded", target, findings: rows } }));
  writeFileSync(join(dir, `run-${id}.sqlite`), "s");
  if (kept) keep(id);
  return id;
};
// An older run with a stream whose record holds one measured row as finding .1.
const oldStream = (name) => {
  const id = idOf(name);
  const evs = [...head, { t: 21, ev: "finding-submitted", n: 1, title: "weak-csp", severity: "low", poc: "lead-1" }, { t: 30, ev: "finding", id: `${id}.1`, runId: id, title: "weak-csp", severity: "low", poc: "lead-1", proven: true }, { t: 31, ev: "status", status: "recorded", decision: "approve", findingId: `${id}.1`, findingIds: [`${id}.1`] }, { t: 32, ev: "closed" }];
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), evs.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${id}.sqlite`), "s");
  writeFileSync(join(dir, `run-${id}.json`), JSON.stringify({ result: { outcome: "recorded", target, findings: [cspRow(1, "a.test")] } }));
  keep(id);
  return id;
};

const dId = oldStream("seq-d");
const bId = recordOnly("seq-b", [b7Row]);
const cId = recordOnly("seq-c", [b7Row], true);
const mixId = oldStream("seq-mix");
const afterLoadId = recordOnly("after-load", [b7Row]);
// A run the server stopped in its proof phase after it wrote its record: the
// boot finishes it from the record (resumeRun). The record holds a measured
// row (.1) and a proven one (.2), as an older run's record can.
const proofId = idOf("seq-proof");
{
  const proven = { n: 2, title: "IDOR, proven", severity: "high", poc: "idor-9", pocProved: true, proof: { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } };
  writeFileSync(join(dir, `run-${proofId}.stream.jsonl`), [...head, { t: 30, ev: "status", status: "deciding" }].map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${proofId}.state.json`), JSON.stringify({ target, mode: "fleet", budget: 5, provider: "boundless", model: "fake-model", modules: [], ws: workspace(), phase: "proof", settled: { status: "done", findings: [], summary: { calls: [] } } }));
  writeFileSync(join(dir, `run-${proofId}.sqlite`), "s");
  writeFileSync(join(dir, `run-${proofId}.json`), JSON.stringify({ result: { outcome: "recorded", target, findings: [cspRow(1, "a.test"), proven] } }));
}

const { handleApi } = await import("../../app/server/api.mjs");
const { dismissFinding } = await import("../../app/server/findings.mjs");
let runs = await import("../../app/server/runs.mjs");
after(() => {
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const closed = async (id) => {
  for (let i = 0; i < 300 && !runs.getRun(id)?.events.some((e) => e.ev === "closed"); i++) await new Promise((r) => setTimeout(r, 10));
  return runs.getRun(id);
};
async function reload() {
  const shared = globalThis.__touchstoneRuns;
  delete globalThis.__touchstoneRuns;
  try {
    runs = await import(`../../app/server/runs.mjs?reload-${Date.now()}-${Math.random()}`);
  } finally {
    globalThis.__touchstoneRuns = shared;
  }
}
async function follow(id, findings) {
  await closed(id);
  for (let k = 0; k < 100 && runs.getRun(id)?.replying; k++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runs.steerRun(id, "more"), { ok: true, followUp: true });
  const w = workers.filter((x) => x.env.EVENTS_FILE?.includes(id)).at(-1);
  const say = (e) => w.child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
  for (const f of findings) say({ ev: "finding-submitted", n: f.n, title: f.title, severity: f.severity, poc: f.poc });
  say({ ev: "settled", status: "done", summary: { final: { text: "Done." }, calls: [] }, findings, candidates: [], usage: { usd: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  w.child.emit("exit", 0, null);
  for (let k = 0; k < 300 && runs.getRun(id).replying; k++) await new Promise((r) => setTimeout(r, 10));
  return runs.getRun(id);
}

// THE invariant: the run view equals what /api/findings lists for the run.
async function agree(id, step) {
  const run = runs.getRun(id);
  const { json } = await handleApi("/api/findings");
  const viewF = run.events.filter((e) => e.ev === "finding").map((e) => [String(e.id), e.proven === true]).sort();
  const apiF = json.findings.filter((f) => f.runId === id).map((f) => [f.id, f.proven]).sort();
  assert.deepEqual(viewF, apiF, `${step}: findings (id, proven)`);
  const viewC = run.candidates.map((c) => [c.origin, c.poc]).sort();
  const apiC = json.candidates.filter((c) => c.runId === id).map((c) => [c.origin, c.poc]).sort();
  assert.deepEqual(viewC, apiC, `${step}: live candidates`);
  return { findings: apiF, candidates: apiC };
}

const harm = (n, poc, title = "IDOR, proven") => ({ n, title, severity: "high", poc, script: "s" });

test("D: a follow-up that proves harm on an older run with a measured row", async () => {
  await closed(dId);
  await agree(dId, "load");
  const run = await follow(dId, [harm(1, "idor-1")]);
  const live = run.events.filter((e) => e.ev === "finding").map((e) => [e.id, e.proven]);
  assert.deepEqual(live, [[`${dId}.2`, true]], "the finding event has the record's id");
  assert.ok(run.events.some((e) => e.ev === "artifact-open" && e.id === `proof-${dId}.2`), "its proof has the record's id");
  assert.deepEqual((await agree(dId, "after the follow-up")).findings, [[`${dId}.2`, true]]);
  await reload();
  await closed(dId);
  const got = await agree(dId, "after a reload");
  assert.deepEqual(got.findings, [[`${dId}.2`, true]]);
  assert.deepEqual(got.candidates, [["measured", "lead-1"]]);
});

test("B: rename, then a rule flip (the row becomes harm), then a reload: both read it proven", async () => {
  await closed(bId);
  await agree(bId, "load");
  runs.renameRun(bId, "flip me");
  await new Promise((r) => setTimeout(r, 30));
  await agree(bId, "after a rename");
  // The rule changed: the record's row now carries a funds harm verdict.
  const f = join(dir, `run-${bId}.json`);
  const raw = JSON.parse(readFileSync(f, "utf8"));
  raw.result.findings[0].proof.harm = { ok: true, kind: "funds", victim: "0x1" };
  writeFileSync(f, JSON.stringify(raw));
  await reload();
  await closed(bId);
  const got = await agree(bId, "after the flip and a reload");
  assert.deepEqual(got.findings, [[`${bId}.1`, true]]);
  assert.deepEqual(got.candidates, []);
});

test("C: a follow-up proves a harm finding with the old row's poc: the derived candidate is gone from both", async () => {
  await closed(cId);
  assert.deepEqual((await agree(cId, "load")).candidates, [["measured", "OldTest"]]);
  await follow(cId, [harm(1, "OldTest", "Drain, proven")]);
  assert.deepEqual((await agree(cId, "after the follow-up")).candidates, []);
  await reload();
  await closed(cId);
  const got = await agree(cId, "after a reload");
  assert.deepEqual(got.candidates, []);
  assert.deepEqual(got.findings, [[`${cId}.2`, true]]);
});

test("mixed: measure, reuse a label twice, prove, dismiss, archive, reload", async () => {
  await closed(mixId);
  await agree(mixId, "load");
  await follow(mixId, [{ ...cspRow(2, "b.test"), explanation: "x" }]);
  await agree(mixId, "a follow-up that only measures");
  await follow(mixId, [{ n: 1, title: "XSS on /a", severity: "medium", poc: "xss-1", xss: true, script: "a" }]);
  await follow(mixId, [{ n: 1, title: "XSS on /b", severity: "medium", poc: "xss-1", xss: true, script: "b" }]);
  const reused = await agree(mixId, "two follow-ups reusing a label");
  assert.equal(reused.candidates.filter(([, poc]) => poc.startsWith("xss-1")).length, 2);
  await follow(mixId, [harm(1, "idor-1")]);
  const proved = await agree(mixId, "a follow-up that proves harm");
  const provedId = proved.findings.find(([, p]) => p)?.[0];
  assert.ok(provedId);
  await dismissFinding(provedId, true);
  await agree(mixId, "a dismissal");
  runs.archiveRun(mixId, true);
  await agree(mixId, "an archive");
  await reload();
  await closed(mixId);
  const got = await agree(mixId, "after a reload");
  assert.deepEqual(got.findings, proved.findings);
  assert.deepEqual(got.candidates, reused.candidates);
});

test("a restart in the proof phase of a record with a measured row: only the proven row is announced, with its id", async () => {
  const run = await closed(proofId);
  assert.deepEqual(run.events.filter((e) => e.ev === "finding").map((e) => [e.id, e.proven]), [[`${proofId}.2`, true]]);
  const got = await agree(proofId, "after the proof-phase restart");
  assert.deepEqual(got.candidates, [["measured", "lead-1"]]);
  await reload();
  await closed(proofId);
  await agree(proofId, "after a reload");
});

// The stream of a record-only run is written from the record's events plus
// every event that came after the load (ensureFiles).
test("a record-only run's stream keeps the events that came after the load", async () => {
  const run = await closed(afterLoadId);
  run.events.push({ t: 99, ev: "note-after-load", text: "kept" });
  runs.renameRun(afterLoadId, "renamed after load");
  const evs = readFileSync(join(dir, `run-${afterLoadId}.stream.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.some((e) => e.ev === "note-after-load"), "the event after the load is in the stream");
  assert.ok(evs.some((e) => e.ev === "renamed"));
  assert.equal(evs.filter((e) => e.ev === "candidate-submitted" && e.candidate?.derived).length, 0);
  assert.ok(existsSync(join(dir, `run-${afterLoadId}.json`)));
});
