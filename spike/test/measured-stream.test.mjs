// N3 repair 2: from the engine re-review's probe tests (thr_cm7y78af9r,
// probe-r2). No model call and no Docker: the worker and the pack are fakes.
//   R1  a rename, an archive, or a follow-up that is refused, on an older
//       record-only run with a measured row writes the stream from the
//       record's events: its finding event is there, no derived candidate;
//       after a reload the run reads as it did before.
//   m1  two follow-ups that reuse a label (xss-1) on a non-harm finding keep
//       both findings.
//   m2  a follow-up on an error run that ends clean with only measured
//       findings clears the error.
import "./helpers/isolated-env.mjs";
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const dir = mkdtempSync(join(tmpdir(), "measured-stream-"));
process.env.TOUCHSTONE_RESULTS_DIR = dir;
process.env.TOUCHSTONE_OWNER_RETRY_MS = "20";
process.env.SPEND_LEDGER = join(dir, "spend.json");
const target = { id: "lab-web", title: "Web lab", kind: "lab", pack: "web" };
const H = "ab".repeat(32);

const replayed = [];
const realPacks = await import("../packs/index.mjs");
mock.module("../packs/index.mjs", { exports: { ...realPacks, packFor: () => ({
  prepass: async () => ({ record: { pack: "web", coverage: [], leads: [] }, env: {} }),
  teardown: async () => {},
  prove: async (_ws, found) => {
    replayed.push(...found.map((f) => f.poc));
    return found.map((f) => ({ ...f, proof: f.evidence ? { kind: "evidence", status: "pass", check: f.evidence.check, snapshotHash: H } : f.xss ? { kind: "http", status: "pass", oracle: { name: "reflected-xss" } } : { kind: "http", status: "pass", oracle: { name: "bola-wallet-idor" } } }));
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
const head = [{ t: 1, ev: "scope", scope: target }, { t: 2, ev: "budget", usd: 5 }, { t: 3, ev: "mode", mode: "fleet" }, { t: 4, ev: "provider", provider: "boundless", model: "fake-model" }, { t: 5, ev: "status", status: "running" }];
const idOf = (name) => `${name}-2611131200-1`;
function save(name, events, state) {
  const id = idOf(name);
  writeFileSync(join(dir, `run-${id}.stream.jsonl`), events.map((e) => JSON.stringify(e) + "\n").join(""));
  writeFileSync(join(dir, `run-${id}.state.json`), JSON.stringify({ target, mode: "fleet", budget: 5, provider: "boundless", model: "fake-model", modules: [], ...state }));
  writeFileSync(join(dir, `run-${id}.sqlite`), "s");
  return id;
}
const measured = (n, check, host) => ({ n, title: check, severity: "low", poc: `lead-${n}`, explanation: "x", evidence: { check, where: { host }, snapshotHash: H } });
// An older record-only run: its one row is a forge proof with no harm
// verdict (B7), so it reads as a measured candidate.
const recordOnly = (name, extra = {}) => {
  const id = idOf(name);
  writeFileSync(join(dir, `run-${id}.json`), JSON.stringify({ result: { outcome: "recorded", target, findings: [{ n: 1, title: "Old drain", severity: "high", poc: "OldTest", pocProved: true, proof: { kind: "forge", pass: true, status: "pass" } }] } }));
  if (extra.session) writeFileSync(join(dir, `run-${id}.sqlite`), "s");
  return id;
};
const renameId = recordOnly("rename");
const archiveId = recordOnly("archive");
const refusedId = recordOnly("refused", { session: true });
const errRun = save("errrun", [...head, { t: 30, ev: "status", status: "deciding" }], { ws: workspace(), phase: "proof", settled: { status: "unanswered", findings: [], candidates: [], summary: { calls: [] } } });
const xssRun = save("xss", head, { ws: workspace(), phase: "agent" });

const runs = await import("../../app/server/runs.mjs");
const { getRun, steerRun, renameRun, archiveRun } = runs;
after(() => {
  for (const ws of made) rmSync(ws, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const closed = async (id, api = { getRun }) => {
  for (let i = 0; i < 300 && !api.getRun(id)?.events.some((e) => e.ev === "closed"); i++) await new Promise((r) => setTimeout(r, 10));
  return api.getRun(id);
};
const recordOf = (id) => JSON.parse(readFileSync(join(dir, `run-${id}.json`), "utf8")).result;
const streamOf = (id) => {
  const f = join(dir, `run-${id}.stream.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : null;
};
const view = (run) => ({ status: run.status, findingIds: run.findingIds, candidates: run.candidates.map((c) => [c.origin, c.poc]), findings: run.events.filter((e) => e.ev === "finding").length });
async function reboot() {
  const shared = globalThis.__touchstoneRuns;
  delete globalThis.__touchstoneRuns;
  try {
    return await import(`../../app/server/runs.mjs?reboot-${Date.now()}`);
  } finally {
    globalThis.__touchstoneRuns = shared;
  }
}
async function follow(id, findings, status = "done") {
  await closed(id);
  for (let k = 0; k < 100 && getRun(id)?.replying; k++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(steerRun(id, "more"), { ok: true, followUp: true });
  const w = workers.filter((x) => x.env.EVENTS_FILE?.includes(id)).at(-1);
  const say = (e) => w.child.stdout.write(`EVENT ${JSON.stringify({ t: Date.now(), ...e })}\n`);
  for (const f of findings) say({ ev: "finding-submitted", n: f.n, title: f.title, severity: f.severity, poc: f.poc });
  say({ ev: "settled", status, summary: { final: { text: "Done." }, calls: [] }, findings, candidates: [], usage: { usd: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  w.child.emit("exit", 0, null);
  for (let k = 0; k < 300 && getRun(id).replying; k++) await new Promise((r) => setTimeout(r, 10));
  return getRun(id);
}

for (const [name, id, act] of [
  ["a rename", renameId, (i) => renameRun(i, "my old run")],
  ["an archive", archiveId, (i) => archiveRun(i, true)],
  ["a refused follow-up", refusedId, (i) => { try { steerRun(i, "more"); } catch { /* refused: no workspace and no scope */ } }],
]) {
  test(`R1: ${name} of a record-only run writes the record's events, never the load-time view`, async () => {
    const before = view(await closed(id));
    assert.deepEqual(before.candidates, [["measured", "OldTest"]]);
    assert.equal(before.findings, 0);
    act(id);
    await new Promise((r) => setTimeout(r, 50));
    const evs = streamOf(id);
    assert.ok(evs, "the stream file is written");
    assert.equal(evs.filter((e) => e.ev === "candidate-submitted" && e.candidate?.derived === true).length, 0, "no derived candidate in the stream");
    assert.equal(evs.filter((e) => e.ev === "finding").length, 1, "the record's finding event is in the stream");
    assert.equal(recordOf(id).findings.length, 1);
    // After a reload the run reads as it did before.
    const again = (await reboot()).getRun(id);
    assert.deepEqual({ ...view(again), status: again.status }, { ...before, status: before.status });
  });
}

test("m1: two follow-ups that reuse a label on a non-harm finding keep both findings", async () => {
  replayed.length = 0;
  await follow(xssRun, [{ n: 1, title: "XSS on /a", severity: "medium", poc: "xss-1", xss: true, script: "a" }]);
  const run = await follow(xssRun, [{ n: 1, title: "XSS on /b", severity: "medium", poc: "xss-1", xss: true, script: "b" }]);
  const r = recordOf(xssRun);
  const items = (r.candidates ?? []).flatMap((c) => c.evidence?.items?.map((i) => i.title) ?? []);
  assert.deepEqual(items.sort(), ["XSS on /a", "XSS on /b"]);
  assert.equal(new Set((r.candidates ?? []).map((c) => c.poc)).size, (r.candidates ?? []).length, "each candidate has its own poc");
  // The invariant: every replayed finding is in exactly one place.
  const places = [...(r.findings ?? []).map((f) => f.poc), ...(r.candidates ?? []).flatMap((c) => c.evidence?.items?.map((i) => i.poc) ?? [])];
  assert.equal(places.length, replayed.length);
  assert.equal(run.candidates.length, 2);
});

test("m2: a follow-up on an error run that ends clean with only measured findings clears the error", async () => {
  assert.equal((await closed(errRun)).status, "error");
  const run = await follow(errRun, [measured(1, "weak-csp", "a.test")]);
  assert.equal(run.status, "no-finding");
  const r = recordOf(errRun);
  assert.equal(r.outcome, "no-finding");
  assert.deepEqual(r.candidates.map((c) => c.origin), ["measured"]);
});
