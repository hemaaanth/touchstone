// N3 repair 1: measured candidates across follow-ups and failed runs (from
// the engine review's failing tests, thr_cm7y78af9r). No model call and no
// Docker: the worker and the pack are fakes, as in candidate-surfaces.
//   E1  two follow-ups that each fold one check keep every place;
//   E2  a follow-up on an older record does not write its load-time
//       candidates into the record;
//   E3  a run whose inference failed reads the same whether or not its
//       submitted findings were measured.
// The invariant: after any record and follow-ups, every finding the engine
// replayed is in exactly one of the record's findings or its candidates.
import "./helpers/isolated-env.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "measured-followup-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
process.env.SPEND_LEDGER = join(dir, "spend.json");
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };
const HASH = "ab".repeat(32);

// A finding with evidence gets an evidence replay (a repeated measurement);
// any other gets an http replay by a harm oracle.
const replayed = [];
const realPacks = await import("../packs/index.mjs");
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async () => ({ record: { pack: "web", coverage: [], leads: [] }, env: {} }),
  teardown: async () => {},
  prove: async (_ws, found) => {
    replayed.push(...found.map((f) => f.poc));
    return found.map((f) => ({ ...f, proof: f.evidence ? { kind: "evidence", status: "pass", check: f.evidence.check, snapshotHash: HASH } : { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } }));
  },
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
const head = (mode) => [{ t: 1, ev: "scope", scope: target }, { t: 2, ev: "budget", usd: 5 }, { t: 3, ev: "mode", mode }, { t: 4, ev: "provider", provider: "boundless", model: "fake-model" }, { t: 5, ev: "status", status: "running" }];
function save(name, events, state, mode = "fleet") {
  const id = `${name}-2611131200-1`;
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ target, mode, budget: 5, provider: "boundless", model: "fake-model", modules: [], ...state }));
  writeFileSync(join(dir, `run-${id}.sqlite`), "the agent session");
  return id;
}
const measured = (n, check, host) => ({ n, title: check, severity: "low", poc: `lead-${n}`, explanation: "x", evidence: { check, where: { host }, snapshotHash: HASH } });
const agentCandidate = (poc) => ({ n: 1, pack: "web", title: `T ${poc}`, severity: "high", poc, evidence: { kind: "transcript", transcript: [] }, explanation: "e", cites: [], rootCause: `script:${poc}`, evidenceHash: `h-${poc}` });

// E1: a fleet cut at the restart, then two follow-ups.
const foldId = save("fold", head("fleet"), { ws: workspace(), phase: "agent" });
// E2: an older record with one passing evidence row.
const oldId = save("old", head("fleet"), { ws: workspace(), phase: "agent" });
writeFileSync(join(dir, `run-${oldId}.json`), JSON.stringify({ result: { outcome: "recorded", findings: [{ n: 1, title: "weak-csp", severity: "low", poc: "old-1", evidence: { check: "weak-csp" }, pocProved: true, proof: { kind: "evidence", status: "pass", check: "weak-csp", snapshotHash: HASH } }], candidates: [] } }));
// E3: a run in its proof check whose inference did not complete.
const found = [measured(1, "weak-csp", "a.test"), measured(2, "tls-breach", "a.test")];
const sub = (f) => ({ t: 21 + f.n, ev: "finding-submitted", n: f.n, title: f.title, severity: f.severity, poc: f.poc });
const unansweredMeasured = save("unanswered-measured", [...head("solo"), ...found.map(sub), { t: 30, ev: "status", status: "deciding" }], { ws: workspace(), phase: "proof", settled: { status: "unanswered", findings: found, candidates: [], summary: { calls: [] } } }, "solo");
// Saved before the import below: runs.mjs registers what exists at load time.
const restatusId = save("restatus", [...head("solo"), { t: 9, ev: "status", status: "error" }], { ws: workspace(), phase: "agent" }, "solo");
const unansweredNone = save("unanswered-none", [...head("solo"), { t: 30, ev: "status", status: "deciding" }], { ws: workspace(), phase: "proof", settled: { status: "unanswered", findings: [], candidates: [], summary: { calls: [] } } }, "solo");

const { getRun, steerRun } = await import("../../app/server/runs.mjs");
const { listCandidates } = await import("../../app/server/findings.mjs");
after(() => {
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// Settled, then finished replying with no live worker. A run keeps `closed` from
// an earlier ending, so the event alone returns at once and the next message can
// land while the previous reply is still proving.
const closed = async (id) => {
  const done = () => {
    const run = getRun(id);
    return run && !run.replying && !run.child && (run.submitted ?? []).length === 0;
  };
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  return getRun(id);
};
const recordOf = (id) => JSON.parse(readFileSync(join(dir, `run-${id}.json`), "utf8")).result;
async function follow(id, findings, candidates = []) {
  await closed(id);
  assert.deepEqual(steerRun(id, "more"), { ok: true, followUp: true });
  const w = workers.filter((x) => x.env.EVENTS_FILE?.includes(id)).at(-1);
  const say = (e) => w.child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
  for (const c of candidates) say({ ev: "candidate-submitted", agent: "a-2", candidate: c });
  for (const f of findings) say({ ev: "finding-submitted", agent: "a-2", n: f.n, title: f.title, severity: f.severity, poc: f.poc });
  say({ ev: "settled", status: "done", summary: { final: { text: "Done." }, calls: [] }, findings, candidates, usage: { usd: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  w.child.emit("exit", 0, null);
  for (let i = 0; i < 300 && getRun(id).replying; i++) await new Promise((r) => setTimeout(r, 10));
  return getRun(id);
}
const placesOf = (cands) => (cands ?? []).flatMap((c) => c.evidence?.items?.map((i) => i.poc) ?? []);

test("a follow-up makes a settled run read as working again", async () => {
  // The top bar kept the terminal word ("error") while its agents ran, because
  // nothing set the status back. The worker start does it now.
  const id = restatusId;
  assert.equal(getRun(id).status, "error");
  await closed(id);
  assert.deepEqual(steerRun(id, "continue"), { ok: true, followUp: true });
  const w = workers.filter((x) => x.env.EVENTS_FILE?.includes(id)).at(-1);
  assert.equal(getRun(id).status, "running", "the run reads as working again");
  assert.ok(w, "the follow-up started a worker");
});

test("E1: two follow-ups that each fold one check at new places keep every place; nothing replayed is lost", async () => {
  replayed.length = 0;
  await follow(foldId, [measured(1, "weak-csp", "a.test"), measured(2, "weak-csp", "b.test")]);
  const run = await follow(foldId, [measured(3, "weak-csp", "c.test"), measured(4, "weak-csp", "d.test")]);
  const r = recordOf(foldId);
  assert.deepEqual(placesOf(r.candidates).sort(), ["lead-1", "lead-2", "lead-3", "lead-4"]);
  assert.deepEqual(placesOf(run.candidates).sort(), ["lead-1", "lead-2", "lead-3", "lead-4"]);
  // The invariant: each replayed finding is in exactly one place. A replay may
  // be repeated by the second proof pass, so compare the places, not the count.
  const places = [...(r.findings ?? []).map((f) => f.poc), ...placesOf(r.candidates)];
  assert.deepEqual([...new Set(places)].sort(), [...new Set(replayed)].sort());
  assert.equal(new Set(places).size, places.length, "no place is in two records");
});

test("E2: a follow-up on an older record does not write its load-time candidates into the record", async () => {
  const before = (await listCandidates()).filter((c) => c.runId === oldId);
  assert.deepEqual(before.map((c) => c.origin), ["measured"]);
  await follow(oldId, [], [agentCandidate("upload_probe")]);
  const r = recordOf(oldId);
  assert.deepEqual(r.candidates.map((c) => c.origin), ["agent"], "only the agent's candidate is written");
  const after = (await listCandidates()).filter((c) => c.runId === oldId);
  assert.deepEqual(after.map((c) => c.origin).sort(), ["agent", "measured"], "one agent candidate and one measured row, each once");
  // m8: the measured row keeps its id when the follow-up adds a candidate.
  assert.equal(after.find((c) => c.origin === "measured").id, before[0].id);
});

test("E3: a run whose inference failed reads the same whether or not its submitted findings were measured", async () => {
  const a = await closed(unansweredMeasured);
  const b = await closed(unansweredNone);
  assert.equal(b.status, "error");
  assert.equal(a.status, b.status);
  // Its candidates are kept.
  assert.deepEqual(recordOf(unansweredMeasured).candidates.map((c) => c.origin), ["measured", "measured"]);
});
