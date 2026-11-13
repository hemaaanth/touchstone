// Tests for safe-tx-hashes-util as the second engine of the Keys blind-signing check
// (packs/keys/safe-tx-hashes.mjs). It runs the upstream script offline in its interactive mode.
// The pure parts need no Docker. The real runs need the safe-tx-hashes image (and the safe-hash
// and chain-tools images for the lab), and skip when one is not built.
//
//   node --experimental-test-module-mocks --test test/keys-safe-tx-hashes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORKS, SAFE_TX_HASHES_ENGINE, hashWithSafeTxHashes, jobLine, parseSafeTxHashes, txHashesJobs, warningLeads } from "../packs/keys/safe-tx-hashes.mjs";
import { SAFE_HASH_ENGINE, compareQueue, runQueueWorld, safeHashLeads } from "../packs/keys/safe-hash.mjs";
import { runTool } from "../lib/wrap.mjs";
import { keysLeads, leadsFor } from "../packs/keys/common.mjs";
import keys from "../packs/keys/pack.mjs";
import { cleanupWorkspace, makeWorkspace } from "../lib/sandbox.mjs";

const has = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const hasTool = has("touchstone/safe-tx-hashes:e295975");
const skipTool = !hasTool && "safe-tx-hashes image not built";
const skipLab = skipTool || (!has("touchstone/safe-hash:0.0.19") && "safe-hash image not built") || (!has("touchstone-chain-tools:wave1") && "chain-tools image not built");
const LAB = new URL("../packs/keys/lab", import.meta.url).pathname;

// ---- pure parts

const SAFE = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";
const fields = { to: "0x000000000000000000000000000000000000beef", value: "1", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO };
const job = { id: `${SAFE}:shown:0`, kind: "shown", chainId: 11155111, safe: SAFE, version: "1.4.1", nonce: 0, fields };
const H = (c) => `0x${c.repeat(64)}`;
// The shape of the script's real output (NO_COLOR), cut to the lines the parser reads.
const output = (over = {}) => {
  const o = { "Multisig address": "0x00000000000000000000000000000000000000AA", To: "0x000000000000000000000000000000000000bEEF", Value: "1", Data: "0x",
    Operation: "Call", "Safe Transaction Gas": "0", "Base Gas": "0", "Gas Price": "0", "Gas Token": ZERO, "Refund Receiver": ZERO, Nonce: "0",
    "Domain hash": H("B"), "Message hash": H("C"), "Safe transaction hash": H("a"), ...over };
  return Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n");
};

test("parseSafeTxHashes reads the three hashes and checks the echoed fields against the job", () => {
  assert.deepEqual(parseSafeTxHashes(output(), job), { safeTxHash: H("a"), domainHash: H("b"), messageHash: H("c"), warnings: [] });
  assert.equal(parseSafeTxHashes(output({ "Safe transaction hash": "" }), job), null, "empty hashes (chisel without solc, exit 0) are not a result");
  assert.equal(parseSafeTxHashes(output({ "Message hash": "0x1234" }), job), null);
  assert.equal(parseSafeTxHashes(output({ To: ZERO }), job), null, "the script used a default for `to`: not our transaction");
  assert.equal(parseSafeTxHashes(output({ "Base Gas": "10" }), job), null, "a shifted gas answer is caught");
  assert.equal(parseSafeTxHashes(output({ "Gas Price": undefined }), job), null, "a missing echo is caught");
  assert.equal(parseSafeTxHashes(output({ Operation: "Delegatecall (UNTRUSTED delegatecall; carefully verify before proceeding!)" }), job), null);
  assert.equal(parseSafeTxHashes(output({ Nonce: "1" }), job), null);
  assert.equal(parseSafeTxHashes("", job), null);
});

test("parseSafeTxHashes turns the script's warnings into warning names", () => {
  const dc = { ...job, fields: { ...fields, operation: 1 } };
  const text = `${output({ Operation: "Delegatecall (UNTRUSTED delegatecall; carefully verify before proceeding!)" })}\nWARNING: The transaction includes an untrusted delegate call to address \`0x…\`!`;
  assert.deepEqual(parseSafeTxHashes(text, dc).warnings, ["untrusted-delegatecall"]);
  const both = `${output()}\nWARNING: This transaction uses a custom gas token and a custom refund receiver.`;
  assert.deepEqual(parseSafeTxHashes(both, job).warnings, ["gas-token-and-refund-receiver"]);
  assert.deepEqual(parseSafeTxHashes(`${output()}\nWARNING: This transaction uses a custom refund receiver.`, job).warnings, ["custom-refund-receiver"]);
});

test("jobLine refuses a chain the script cannot name and an empty or unsafe field", () => {
  assert.equal(jobLine(job).line, `sepolia ${SAFE} 0 1.4.1 ${fields.to} 1 0x 0 0 0 0 ${ZERO} ${ZERO}`);
  assert.match(jobLine({ ...job, chainId: 31337 }).error, /not in the safe-tx-hashes-util network list/);
  assert.match(jobLine({ ...job, fields: { ...fields, data: "" } }).error, /empty or malformed/);
  assert.match(jobLine({ ...job, fields: { ...fields, to: "0xbeef; rm -rf /" } }).error, /empty or malformed/);
  assert.equal(NETWORKS[11155111], "sepolia");
});

test("warningLeads makes one lead per warning, tied to the Safe and nonce", () => {
  const dc = { ...job, nonce: 2, id: `${SAFE}:shown:2`, fields: { ...fields, operation: 1 } };
  const hashes = new Map([[job.id, { safeTxHash: H("a"), warnings: [] }], [dc.id, { safeTxHash: H("d"), warnings: ["untrusted-delegatecall", "custom-gas-token"] }]]);
  const leads = warningLeads([job, dc], hashes);
  assert.deepEqual(leads.map((l) => [l.check, l.impact, l.nonce, l.where, l.hash]), [
    ["safe-tx-untrusted-delegatecall", "High", 2, `chain 11155111 ${SAFE}`, H("d")], ["safe-tx-gas-refund", "Low", 2, `chain 11155111 ${SAFE}`, H("d")]]);
  assert.ok(leads.every((l) => l.engine === "safe-tx-hashes-util" && l.block === null));
  assert.match(leads[0].description, /queued transaction for nonce 2/);
});

test("txHashesJobs uses the same job ids as safe-hash-rs, so both engines compare the same transactions", () => {
  const queue = { chainId: 11155111, safes: [{ address: SAFE, version: "1.4.1", queue: [{ nonce: 0, shown: fields }],
    executions: [{ nonce: 0, hash: H("1"), block: 3, fields }, { nonce: 5, hash: H("2"), block: 4, fields: null }] }] };
  const jobs = txHashesJobs(queue);
  assert.deepEqual(jobs.map((j) => j.id), [`${SAFE}:executed:0`, `${SAFE}:shown:0`], "an execution with no decoded fields is not hashed");
  assert.ok(jobs.every((j) => j.version === "1.4.1" && j.chainId === 11155111));
});

// ---- the docker call itself, through the real runTool() with a fake `docker` on PATH

// The fake prints FAKE_OUT, exits FAKE_CODE and writes its argv to FAKE_ARGS.
async function withFakeDocker(stdout, code, fn) {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const path = process.env.PATH;
  writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGS"\n[ -n "$FAKE_SLEEP" ] && exec sleep "$FAKE_SLEEP"\nprintf "%s" "$FAKE_OUT"\nexit "$FAKE_CODE"\n');
  chmodSync(join(dir, "docker"), 0o755);
  Object.assign(process.env, { PATH: `${dir}:${path}`, FAKE_ARGS: join(dir, "args"), FAKE_OUT: stdout, FAKE_CODE: String(code) });
  try { return await fn(() => readFileSync(join(dir, "args"), "utf8").split("\n").slice(0, -1)); }
  finally {
    process.env.PATH = path;
    for (const k of ["FAKE_ARGS", "FAKE_OUT", "FAKE_CODE", "FAKE_SLEEP"]) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
}
const section = (i, j = job) => `@@ job ${i}\n${output({ Nonce: String(j.nonce) })}\n@@ exit 0\n`;
const job1 = { ...job, id: `${SAFE}:shown:1`, nonce: 1 };

test("the safe-tx-hashes call runs with no network, no pull, no workspace, under timeout", async () => {
  await withFakeDocker(section(0), 0, async (argv) => {
    const out = await hashWithSafeTxHashes([job]);
    assert.equal(out.ok, true, out.reason);
    const a = argv();
    assert.equal(a[a.indexOf("--network") + 1], "none");
    assert.ok(a.includes("--pull=never"));
    assert.ok(!a.includes("-v"), "the tool sees no workspace");
    const at = a.indexOf("touchstone/safe-tx-hashes:e295975");
    assert.ok(at > 0, "the pinned image tag");
    assert.deepEqual(a.slice(at + 1, at + 3), ["bash", "-c"]);
  });
});

test("a nonzero exit, of the container or of one job, is not a result", async () => {
  await withFakeDocker(section(0), 1, async () => {
    const out = await hashWithSafeTxHashes([job]);
    assert.equal(out.ok, false);
    assert.match(out.reason, /exit 1/);
  });
  await withFakeDocker(section(0).replace("@@ exit 0", "@@ exit 1"), 0, async () => {
    assert.equal((await hashWithSafeTxHashes([job])).ok, false);
  });
  await withFakeDocker(section(0), 124, async () => {
    assert.match((await hashWithSafeTxHashes([job])).reason, /exit 124/);
  });
});

test("an empty report, a job outside the list or a job printed twice is unavailable and does not throw", async () => {
  for (const out of ["", "@@ exit 0\n", "@@ job 0\n@@ exit 0\n"]) {
    await withFakeDocker(out, 0, async () => { assert.equal((await hashWithSafeTxHashes([job])).ok, false, JSON.stringify(out)); });
  }
  await withFakeDocker(section(0) + section(1, job1), 0, async () => {
    assert.match((await hashWithSafeTxHashes([job])).reason, /job 1, which is not one of the 1 jobs/);
  });
  await withFakeDocker(section(0) + section(0), 0, async () => {
    assert.equal((await hashWithSafeTxHashes([job, job1])).ok, false);
  });
});

// ---- failure cases through the real runTool()

test("safe-tx-hashes-util reports unavailable, not clean, when its image is missing", async () => {
  process.env.SAFE_TX_HASHES_IMAGE = "touchstone/safe-tx-hashes:does-not-exist";
  try {
    const mod = await import("../packs/keys/safe-tx-hashes.mjs?missing");
    const out = await mod.hashWithSafeTxHashes([job], { timeoutMs: 20_000 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not built/);
  } finally { delete process.env.SAFE_TX_HASHES_IMAGE; }
});

test("safe-tx-hashes-util reports unavailable when the script rejects an input", { skip: skipTool, timeout: 120_000 }, async () => {
  const bad = { ...job, id: "bad", fields: { ...fields, value: "abc" } };
  const out = await hashWithSafeTxHashes([job, bad]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /failed on bad \(exit 1\).*Invalid `value`/);
});

test("a script that hashes a default in place of our field (exit 0) is caught by the echo check", { skip: skipTool, timeout: 120_000 }, async () => {
  // `cast` cannot checksum "0xzz", so the script gets an empty `to`, uses the zero address,
  // and prints a valid-looking hash with exit 0. That hash is not of our transaction.
  const out = await hashWithSafeTxHashes([{ ...job, id: "badTo", fields: { ...fields, to: "0xzz" } }]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /failed on badTo \(exit 0\).*Safe transaction hash: 0x/);
});

test("a safe-tx-hashes run that runTool marks timedOut is unavailable, with a reason, and gives no hash", async () => {
  process.env.FAKE_SLEEP = "30";
  await withFakeDocker(section(0), 0, async () => {
    const out = await hashWithSafeTxHashes([job], { timeoutMs: 500 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /timed out/);
    assert.equal(out.hashes, undefined);
  });
});

test("safe-tx-hashes-util reports unavailable when it times out", { skip: skipTool }, async () => {
  const out = await hashWithSafeTxHashes([job], { timeoutMs: 1 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /timed out/);
});

test("a safe-tx-hashes container that really hangs is stopped at the timeout, and nothing is left", { skip: "needs the shared runTool timeout fix (6526bbe on pack/domains); without it the container outlives the call", timeout: 60_000 }, async () => {
  const tag = `HANG_${process.pid}_${Date.now()}`;
  const start = Date.now();
  const run = await runTool({ image: "touchstone/safe-tx-hashes:e295975", ws: null, env: { [tag]: "1" }, timeoutMs: 4000, cmd: ["bash", "-c", "sleep 300 & sleep 300; wait"] });
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - start < 20_000, `the call returned after ${Date.now() - start} ms`);
  const left = execFileSync("docker", ["ps", "-aq", "--filter", "ancestor=touchstone/safe-tx-hashes:e295975"], { encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((id) => execFileSync("docker", ["inspect", "-f", "{{.Config.Env}}", id], { encoding: "utf8" }).includes(tag));
  assert.deepEqual(left, []);
});

// ---- failure cases in the prepass hook, with both engines

test("the hook keeps safe-hash-rs when safe-tx-hashes-util is missing or throws, and says so", { skip: skipLab, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const boom = { name: "boom-engine", flag: "boom", hash: async () => { throw new Error("engine blew up"); } };
    const out = await safeHashLeads(ws, { world: true }, { engines: [SAFE_HASH_ENGINE, SAFE_TX_HASHES_ENGINE, boom],
      images: { "safe-tx-hashes-util": "touchstone/safe-tx-hashes:does-not-exist" } });
    assert.deepEqual(out.flags, { safeHash: true, safeTxHashes: false, boom: false });
    assert.ok(out.leads.length > 0 && out.leads.every((l) => l.engine === "safe-hash-rs"), "no lead from an engine that did not run");
    assert.match(out.note, /safe-tx-hashes-util did NOT check the Safe queue \(image touchstone\/safe-tx-hashes:does-not-exist not built/);
    assert.match(out.note, /boom-engine did NOT check the Safe queue \(engine blew up\)/);
    assert.match(out.reason, /safe-tx-hashes-util: .*not built .*; boom-engine: engine blew up/);
    assert.ok(!readdirSync(ws).includes("safe-queue.json"));
  } finally { cleanupWorkspace(ws); }
});

test("the hook is unavailable for both engines, with no lead, when the Safe queue lab does not run", async () => {
  const ws = makeWorkspace(LAB);
  try {
    const out = await safeHashLeads(ws, { world: true }, { engines: [SAFE_HASH_ENGINE, SAFE_TX_HASHES_ENGINE], worldImage: "touchstone-chain-tools:does-not-exist" });
    assert.equal(out.available, false);
    assert.deepEqual(out.flags, { safeHash: false, safeTxHashes: false });
    assert.deepEqual(out.leads, []);
    assert.match(out.note, /safe-hash-rs did NOT check.*safe-tx-hashes-util did NOT check/s);
  } finally { cleanupWorkspace(ws); }
});

// ---- the real run against the lab

test("safe-tx-hashes-util, run on the Safe queue lab, matches the Safe's own hash and flags the untrusted delegatecall", { skip: skipLab, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const lab = await runQueueWorld(ws);
    assert.equal(lab.ok, true, lab.reason);
    const safe = lab.queue.safes[0];
    const addr = safe.address.toLowerCase();

    const hashed = await SAFE_TX_HASHES_ENGINE.hash(lab.queue);
    assert.equal(hashed.ok, true, hashed.reason);
    // Calibration: the script's offline hash equals the hash the Safe contract emitted on chain.
    assert.equal(hashed.hashes.get(`${addr}:executed:0`).safeTxHash, safe.executions[0].hash.toLowerCase());
    assert.deepEqual(hashed.hashes.get(`${addr}:shown:2`).warnings, ["untrusted-delegatecall"]);
    assert.deepEqual(hashed.hashes.get(`${addr}:shown:1`).warnings, [], "a plain transfer gives no warning");

    const out = compareQueue(lab.queue, hashed.hashes, "safe-tx-hashes-util");
    assert.equal(out.available, true, out.reason);
    assert.deepEqual(out.leads.map((l) => [l.check, l.block]), [["safe-hash-mismatch", 8]], "it also finds the blind approval");
    const [dc] = hashed.extraLeads;
    assert.equal(hashed.extraLeads.length, 1);
    assert.equal(dc.check, "safe-tx-untrusted-delegatecall");
    assert.equal(dc.nonce, 2);
    assert.equal(dc.hash, out.checked[0].shown["2"]);
    assert.equal(dc.where, `chain 11155111 ${addr}`);
  } finally { cleanupWorkspace(ws); }
});

test("both engines hash the lab queue the same way, and both flag the blind approval", { skip: skipLab, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const out = await safeHashLeads(ws, { world: true }, { engines: [SAFE_HASH_ENGINE, SAFE_TX_HASHES_ENGINE] });
    assert.deepEqual(out.flags, { safeHash: true, safeTxHashes: true });
    assert.deepEqual(out.results["safe-hash-rs"].checked[0].shown, out.results["safe-tx-hashes-util"].checked[0].shown);
    const blind = out.leads.filter((l) => l.check === "safe-hash-mismatch");
    assert.deepEqual(blind.map((l) => l.engine).sort(), ["safe-hash-rs", "safe-tx-hashes-util"]);
    assert.equal(blind[0].hash, blind[1].hash);
    assert.match(out.note, /safe-tx-hashes-util hashed the Safe queue offline/);
  } finally { cleanupWorkspace(ws); }
});

test("the Keys prepass now raises the delegatecall lead no check found before, and the blind lead is agreed", { skip: skipLab, timeout: 900_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const events = [];
    const prep = await keys.prepass(ws, { emit: (e) => events.push(e) });
    // Before: the pack's own checks never named the queued delegatecall.
    const own = leadsFor(ws, keysLeads);
    assert.ok(!own.some((l) => /delegatecall/i.test(`${l.check} ${l.description}`)), "the pack had no delegatecall check on the queue");
    // After: in the record, the brief and the event.
    assert.equal(prep.record.safeHash, true);
    assert.equal(prep.record.safeTxHashes, true);
    assert.match(prep.env.CHAIN_BRIEF, /safe-tx-untrusted-delegatecall at chain 11155111 0x[0-9a-f]{40}[^\n]*seen only by safe-tx-hashes-util\n[^\n]*nonce 2/);
    assert.match(prep.env.CHAIN_BRIEF, /safe-hash-mismatch .* safe-hash-rs \+ safe-tx-hashes-util AGREE/);
    assert.ok(events[0].top.some((l) => l.check === "safe-tx-untrusted-delegatecall" && l.engines.includes("safe-tx-hashes-util")));
  } finally { cleanupWorkspace(ws); }
});
