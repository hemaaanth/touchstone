// Tests for the Keys pack blind-signing check (packs/keys/safe-hash.mjs): safe-hash-rs
// hashes the Safe queue the signers saw, and the pack compares that with the chain.
// The pure parts need no Docker. The real runs need the safe-hash image and the
// chain-tools image, and skip when one is not built.
//
//   node --experimental-test-module-mocks --test test/keys-safe-hash.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { compareQueue, hashWithSafeHash, parseSafeHash, queueJobs, runQueueWorld, safeHashLeads, safeHashNote, safeTxTypedData } from "../packs/keys/safe-hash.mjs";
import { keysLeads, leadsFor } from "../packs/keys/common.mjs";
import keys from "../packs/keys/pack.mjs";
import { cleanupWorkspace, makeWorkspace } from "../lib/sandbox.mjs";

const has = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };
const hasSafeHash = has("touchstone/safe-hash:0.0.19");
const hasChain = has("touchstone-chain-tools:wave1");
const skipReal = (!hasSafeHash && "safe-hash image not built") || (!hasChain && "chain-tools image not built");
const LAB = new URL("../packs/keys/lab", import.meta.url).pathname;
const OWNER0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OWNER2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

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

// ---- failure cases through the real runTool()

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

// ---- the real run against the lab

test("safe-hash-rs, run on the Safe queue lab, matches the Safe's own hash and flags the blind approval", { skip: skipReal, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  try {
    const before = readdirSync(ws).sort();
    const lab = await runQueueWorld(ws);
    assert.equal(lab.ok, true, lab.reason);
    assert.deepEqual(readdirSync(ws).sort(), [...before, "safe-queue.json"].sort(), "only the queue file is left behind");
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
    assert.match(prep.env.CHAIN_BRIEF, /safe-hash-mismatch .* seen only by safe-hash-rs/);
    assert.match(prep.env.CHAIN_BRIEF, /blind signing/);
    assert.match(prep.env.CHAIN_BRIEF, /matched the hash the Safe emitted/);
    assert.ok(events[0].top.some((l) => l.check === "safe-hash-mismatch" && l.engines.includes("safe-hash-rs")));
  } finally { cleanupWorkspace(ws); }
});
