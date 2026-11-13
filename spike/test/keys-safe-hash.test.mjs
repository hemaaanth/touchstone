// Tests for the Keys pack blind-signing check (packs/keys/safe-hash.mjs): safe-hash-rs
// hashes the Safe queue the signers saw, and the pack compares that with the chain.
// The pure parts need no Docker. The real runs need the safe-hash image and the
// chain-tools image, and skip when one is not built.
//
//   node --experimental-test-module-mocks --test test/keys-safe-hash.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareQueue, hashWithSafeHash, parseSafeHash, queueJobs, runQueueWorld, safeHashLeads, safeHashNote, safeTxTypedData, underTimeout } from "../packs/keys/safe-hash.mjs";
import { keysLeads, leadsFor } from "../packs/keys/common.mjs";
import keys from "../packs/keys/pack.mjs";
import { cleanupWorkspace, makeWorkspace } from "../lib/sandbox.mjs";
import { runTool } from "../lib/wrap.mjs";

const has = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const hasSafeHash = has("touchstone/safe-hash:0.0.19");
const hasChain = has("touchstone-chain-tools:wave1");
const skipReal = (!hasSafeHash && "safe-hash image not built") || (!hasChain && "chain-tools image not built");
const LAB = new URL("../packs/keys/lab", import.meta.url).pathname;
// Anvil accounts 6 and 8. The main Keys lab uses accounts 0 to 2.
const OWNER0 = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
const OWNER2 = "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f";

// ---- pure parts

const h = (c) => `0x${c.repeat(64)}`;
const OUTPUT = `EIP 712 Hash:            ${h("a")}\nDomain Hash:             ${h("b")}\nMessage Hash:            ${h("c")}\n`;

test("parseSafeHash reads the three hashes of `safe-hash typed` and rejects anything less", () => {
  assert.deepEqual(parseSafeHash(OUTPUT), { safeTxHash: h("a"), domainHash: h("b"), messageHash: h("c") });
  assert.equal(parseSafeHash(OUTPUT.split("\n").slice(0, 2).join("\n")), null, "a missing hash is not a result");
  assert.equal(parseSafeHash("thread 'main' panicked at crates/safe-hash/src/main.rs"), null);
  assert.equal(parseSafeHash(OUTPUT.replace(h("a"), "0x1234")), null, "a short hash is not a result");
  assert.equal(parseSafeHash(""), null);
});

test("safeTxTypedData builds the Safe 1.3+ SafeTx typed data with the domain the signer sees", () => {
  const typed = safeTxTypedData(11155111, "0xabc", { to: "0xdef", value: "5", data: "0x", operation: "0", safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0", refundReceiver: "0x0" }, 7);
  assert.equal(typed.primaryType, "SafeTx");
  assert.deepEqual(typed.domain, { chainId: 11155111, verifyingContract: "0xabc" });
  assert.deepEqual(typed.types.SafeTx.map((f) => f.name), ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"]);
  assert.equal(typed.message.nonce, "7");
  assert.equal(typed.message.operation, 0);
});

const SAFE = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";
const fields = { to: "0x000000000000000000000000000000000000beef", value: "1", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO };
const queueOf = (over = {}) => ({ chainId: 11155111, block: 9, safes: [{ name: "s", address: SAFE,
  queue: [{ nonce: 0, shown: fields }, { nonce: 1, shown: fields }],
  executions: [{ nonce: 0, hash: h("1"), block: 3, fields }],
  approvals: [{ owner: "0x01", hash: h("2"), block: 4 }], ...over }] });
const hashesOf = (map) => new Map(Object.entries(map).map(([k, v]) => [`${SAFE}:${k}`, { safeTxHash: v }]));

test("compareQueue is unavailable, with no lead, when the tool's hash of an executed call is not the Safe's hash", () => {
  const out = compareQueue(queueOf(), hashesOf({ "executed:0": h("9"), "shown:0": h("1"), "shown:1": h("2") }));
  assert.equal(out.available, false);
  assert.match(out.reason, /calibration failed/);
  assert.deepEqual(out.leads, []);
});

test("compareQueue does not check a Safe it cannot calibrate, and says so", () => {
  const out = compareQueue(queueOf({ executions: [] }), hashesOf({ "shown:0": h("1"), "shown:1": h("2") }));
  assert.equal(out.available, false);
  assert.match(out.reason, /no executed transaction to calibrate/);
  assert.match(safeHashNote(out), /did NOT check/);
});

test("an empty queue is unavailable, not clean", () => {
  for (const queue of [{}, { chainId: 11155111, safes: [] }, { chainId: 11155111, safes: null }]) {
    const out = compareQueue(queue, new Map());
    assert.equal(out.available, false);
    assert.deepEqual(out.leads, []);
    assert.match(safeHashNote(out), /did NOT check/);
  }
});

test("a Safe that is a gap is named in the note, next to one that was checked", () => {
  const good = queueOf().safes[0];
  const other = { ...good, name: "other", address: "0x00000000000000000000000000000000000000bb", executions: [] };
  const out = compareQueue({ chainId: 11155111, safes: [good, other] }, hashesOf({ "executed:0": h("1"), "shown:0": h("1"), "shown:1": h("2") }));
  assert.equal(out.available, true);
  assert.equal(out.checked.length, 1);
  assert.equal(out.gaps.length, 1);
  assert.match(safeHashNote(out), /for 1 Safe\(s\).*Not checked: Safe "other" 0x0000…00bb: no executed transaction to calibrate/);
});

test("compareQueue is unavailable when a shown hash is for another domain (chain or Safe)", () => {
  const hashes = hashesOf({ "executed:0": h("1"), "shown:0": h("1"), "shown:1": h("2") });
  for (const [k, v] of hashes) hashes.set(k, { ...v, domainHash: h("d") });
  assert.equal(compareQueue(queueOf(), hashes).available, true);
  hashes.set(`${SAFE}:shown:1`, { safeTxHash: h("2"), domainHash: h("e") });
  const out = compareQueue(queueOf(), hashes);
  assert.equal(out.available, false);
  assert.match(out.reason, /more than one domain/);
  assert.deepEqual(out.leads, []);
});

test("compareQueue is unavailable when a shown transaction has no hash", () => {
  const out = compareQueue(queueOf(), hashesOf({ "executed:0": h("1"), "shown:0": h("1") }));
  assert.equal(out.available, false);
  assert.deepEqual(out.leads, []);
});

test("compareQueue flags an approval no shown transaction hashes to, and an executed call that differs from what was shown", () => {
  const clean = compareQueue(queueOf(), hashesOf({ "executed:0": h("1"), "shown:0": h("1"), "shown:1": h("2") }));
  assert.equal(clean.available, true);
  assert.deepEqual(clean.leads, [], "the approval matches shown nonce 1");
  const blind = compareQueue(queueOf(), hashesOf({ "executed:0": h("1"), "shown:0": h("1"), "shown:1": h("3") }));
  assert.equal(blind.leads.length, 1);
  assert.equal(blind.leads[0].check, "safe-hash-mismatch");
  assert.equal(blind.leads[0].block, 4);
  assert.equal(blind.leads[0].where, `chain 11155111 ${SAFE}`, "never a bare address: the queue lab is not the target chain");
  const swapped = compareQueue(queueOf({ approvals: [] }), hashesOf({ "executed:0": h("1"), "shown:0": h("5"), "shown:1": h("2") }));
  assert.equal(swapped.leads.length, 1);
  assert.match(swapped.leads[0].description, /What ran is not what they saw/);
});

test("the check does not run in source mode, and the note says it did not", async () => {
  const out = await safeHashLeads("/tmp", { world: false });
  assert.equal(out.available, false);
  assert.deepEqual(out.leads, []);
  assert.match(out.note, /did NOT check the Safe queue \(source mode/);
});

// ---- failure cases in the prepass hook (safeHashLeads), the path the pack really calls

const assertUnavailable = (out, why) => {
  assert.equal(out.available, false);
  assert.deepEqual(out.leads, []);
  assert.match(out.note, /did NOT check the Safe queue/);
  assert.match(out.reason, why);
};

test("the hook is unavailable, with no lead, when the safe-hash image is missing", { skip: !hasChain && "chain-tools image not built", timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const before = readdirSync(ws).sort();
    assertUnavailable(await safeHashLeads(ws, { world: true }, { images: { "safe-hash-rs": "touchstone/safe-hash:does-not-exist" } }), /not built/);
    assert.deepEqual(readdirSync(ws).sort(), before, "the queue file is gone");
  } finally { cleanupWorkspace(ws); }
});

test("the hook is unavailable, with no lead, when the Safe queue lab does not run", async () => {
  const ws = makeWorkspace(LAB);
  try {
    assertUnavailable(await safeHashLeads(ws, { world: true }, { worldImage: "touchstone-chain-tools:does-not-exist" }), /Safe queue lab did not run .*not built/);
  } finally { cleanupWorkspace(ws); }
});

test("the hook is unavailable, with no lead, when something throws", async () => {
  assertUnavailable(await safeHashLeads("/nonexistent/touchstone-ws", { world: true }), /ENOENT/);
});

// ---- the docker call itself, through the real runTool() with a fake `docker` on PATH

// The fake prints FAKE_OUT, exits FAKE_CODE and writes its argv to FAKE_ARGS.
async function withFakeDocker(stdout, code, fn) {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const path = process.env.PATH;
  writeFileSync(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGS"\nprintf "%s" "$FAKE_OUT"\nexit "$FAKE_CODE"\n');
  chmodSync(join(dir, "docker"), 0o755);
  Object.assign(process.env, { PATH: `${dir}:${path}`, FAKE_ARGS: join(dir, "args"), FAKE_OUT: stdout, FAKE_CODE: String(code) });
  try { return await fn(() => readFileSync(join(dir, "args"), "utf8").split("\n").slice(0, -1)); }
  finally {
    process.env.PATH = path;
    for (const k of ["FAKE_ARGS", "FAKE_OUT", "FAKE_CODE"]) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
}
const job0 = { id: "j0", typed: safeTxTypedData(1, SAFE, fields, 0) };
const section = (i) => `@@ job ${i}\n${OUTPUT}@@ exit 0\n`;

test("the safe-hash call runs with no network, no pull, no workspace, under timeout", async () => {
  await withFakeDocker(section(0), 0, async (argv) => {
    const out = await hashWithSafeHash([job0]);
    assert.equal(out.ok, true, out.reason);
    const a = argv();
    assert.equal(a[a.indexOf("--network") + 1], "none");
    assert.ok(a.includes("--pull=never"));
    assert.ok(!a.includes("-v"), "the tool sees no workspace");
    assert.deepEqual(a.slice(a.indexOf("touchstone/safe-hash:0.0.19") + 1, -3), ["timeout", "-k", "5", "60"]);
  });
});

test("an empty report from a container that exits 0 is unavailable, not clean", async () => {
  for (const out of ["", "@@ exit 0\n", "@@ job 0\n@@ exit 0\n"]) {
    await withFakeDocker(out, 0, async () => {
      assert.equal((await hashWithSafeHash([job0])).ok, false, JSON.stringify(out));
    });
  }
});

test("a nonzero container exit is not a result, even when every job parsed", async () => {
  await withFakeDocker(section(0), 1, async () => {
    const out = await hashWithSafeHash([job0]);
    assert.equal(out.ok, false);
    assert.match(out.reason, /exit 1/);
  });
  // One job whose own exit is 1, inside a container that exits 0.
  await withFakeDocker(section(0).replace("@@ exit 0", "@@ exit 1"), 0, async () => {
    assert.equal((await hashWithSafeHash([job0])).ok, false);
  });
});

test("a job number outside the job list, or a job printed twice, is unavailable and does not throw", async () => {
  await withFakeDocker(section(0) + section(1), 0, async () => {
    const out = await hashWithSafeHash([job0]);
    assert.equal(out.ok, false);
    assert.match(out.reason, /job 1, which is not one of the 1 jobs/);
  });
  await withFakeDocker(section(0) + section(0), 0, async () => {
    assert.equal((await hashWithSafeHash([job0, { ...job0, id: "j1" }])).ok, false);
  });
});

// ---- failure cases through the real runTool() and the real image

test("safe-hash reports unavailable, not clean, when its image is missing", async () => {
  process.env.SAFE_HASH_IMAGE = "touchstone/safe-hash:does-not-exist";
  try {
    const mod = await import("../packs/keys/safe-hash.mjs?missing");
    const job = { id: "x", typed: safeTxTypedData(1, SAFE, fields, 0) };
    const out = await mod.hashWithSafeHash([job], { timeoutMs: 20_000 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /not built/);
  } finally { delete process.env.SAFE_HASH_IMAGE; }
});

test("safe-hash reports unavailable when the tool fails on bad input", { skip: !hasSafeHash && "safe-hash image not built" }, async () => {
  const good = { id: "good", typed: safeTxTypedData(1, SAFE, fields, 0) };
  const bad = { id: "bad", typed: { domain: {}, types: {}, primaryType: "SafeTx", message: {} } };
  const out = await hashWithSafeHash([good, bad]);
  assert.equal(out.ok, false);
  assert.match(out.reason, /failed on bad/);
});

test("safe-hash reports unavailable when it times out", { skip: !hasSafeHash && "safe-hash image not built" }, async () => {
  const out = await hashWithSafeHash([{ id: "x", typed: safeTxTypedData(1, SAFE, fields, 0) }], { timeoutMs: 1 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /timed out/);
});

test("a container that really hangs is stopped at the timeout, and nothing is left running", { skip: !hasSafeHash && "safe-hash image not built", timeout: 60_000 }, async () => {
  // The same wrapper hashWithSafeHash uses, around a command that never ends.
  const tag = `HANG_${process.pid}_${Date.now()}`;
  const start = Date.now();
  const run = await runTool({ image: "touchstone/safe-hash:0.0.19", ws: null, env: { [tag]: "1" }, timeoutMs: 4000, cmd: underTimeout(4000, ["sh", "-c", "sleep 300"]) });
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - start < 20_000, `the call returned after ${Date.now() - start} ms`);
  const left = execFileSync("docker", ["ps", "-aq", "--filter", "ancestor=touchstone/safe-hash:0.0.19"], { encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((id) => execFileSync("docker", ["inspect", "-f", "{{.Config.Env}}", id], { encoding: "utf8" }).includes(tag));
  assert.deepEqual(left, []);
});

// ---- the real run against the lab

test("safe-hash-rs, run on the Safe queue lab, matches the Safe's own hash and flags the blind approval", { skip: skipReal, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const before = readdirSync(ws).sort();
    const lab = await runQueueWorld(ws);
    assert.equal(lab.ok, true, lab.reason);
    assert.deepEqual(readdirSync(ws).sort(), before, "nothing is left behind: the queue file is read, then deleted");
    const safe = lab.queue.safes[0];
    assert.equal(lab.queue.chainId, 11155111);
    assert.equal(safe.version, "1.4.1");
    assert.equal(safe.executions.length, 1);
    assert.equal(safe.approvals.length, 3);

    const hashed = await hashWithSafeHash(queueJobs(lab.queue));
    assert.equal(hashed.ok, true, hashed.reason);
    // Calibration: the tool's offline hash equals the hash the Safe contract emitted on chain.
    assert.equal(hashed.hashes.get(`${safe.address.toLowerCase()}:executed:0`).safeTxHash, safe.executions[0].hash.toLowerCase());

    const out = compareQueue(lab.queue, hashed.hashes);
    assert.equal(out.available, true, out.reason);
    assert.equal(out.leads.length, 1, "only the compromised approval is a lead");
    const [lead] = out.leads;
    assert.equal(lead.engine, "safe-hash-rs");
    assert.equal(lead.check, "safe-hash-mismatch");
    assert.equal(lead.impact, "High");
    assert.equal(lead.owner, OWNER0);
    assert.equal(lead.where, `chain 11155111 ${safe.address.toLowerCase()}`);
    assert.ok(!Object.values(out.checked[0].shown).includes(lead.hash));
    const honest = safe.approvals.find((a) => a.owner.toLowerCase() === OWNER2);
    assert.equal(honest.hash.toLowerCase(), out.checked[0].shown["1"], "owner 2 approved what was shown: no lead");
  } finally { cleanupWorkspace(ws); }
});

test("the Keys prepass now raises the blind-signing lead its own checks never found", { skip: skipReal, timeout: 900_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const events = [];
    const prep = await keys.prepass(ws, { emit: (e) => events.push(e) });
    // Before: the pack's own checks over the lab world and the source.
    const own = leadsFor(ws, keysLeads);
    assert.ok(own.length > 0);
    assert.ok(!own.some((l) => /hash|blind/i.test(`${l.check} ${l.description}`)), "the pack had no blind-signing check");
    // After: the safe-hash-rs lead is in the brief, the record and the event.
    assert.equal(prep.record.safeHash, true);
    assert.ok(!readdirSync(ws).includes("safe-queue.json"), "the agent sees one chain only");
    // The queue lab's Safe and owners are not a contract or owner in the target lab.
    const obs = readFileSync(join(ws, "chain-observation.json"), "utf8").toLowerCase();
    const lead = events[0].top.find((l) => l.check === "safe-hash-mismatch");
    const queueSafe = lead.where.split(" ").pop();
    assert.match(lead.where, /^chain 11155111 0x[0-9a-f]{40}$/);
    for (const addr of [queueSafe, OWNER0, OWNER2]) assert.ok(!obs.includes(addr.slice(2)), `${addr} is in the main observation`);
    // The pack runs both engines. They agree on the blind approval.
    assert.match(prep.env.CHAIN_BRIEF, /safe-hash-mismatch .* safe-hash-rs \+ safe-tx-hashes-util AGREE/);
    assert.match(prep.env.CHAIN_BRIEF, /blind signing/);
    assert.match(prep.env.CHAIN_BRIEF, /matched the hash the Safe emitted/);
    assert.ok(events[0].top.some((l) => l.check === "safe-hash-mismatch" && l.engines.includes("safe-hash-rs")));
  } finally { cleanupWorkspace(ws); }
});
