// The locked channel: value that is stuck, not stolen.
//
//   node --experimental-test-module-mocks --test spike/test/oracle-locked.test.mjs
//
// This channel exists because a whole class of real incidents moves nothing: the
// holder keeps their receipt and cannot turn it into assets. It is also the second
// half of `lab/vault-shares`, whose own reference exploit proves the lock with
// vm.expectRevert() and which the gate scored as "no harm" until now.
//
// The rules it must keep, each one a way a common revert could be mistaken for harm:
//   1. the caller is not the test or a contract the test deployed (that is fixture);
//   2. the reverted call targets a SCOPE contract (code we hold);
//   3. the selector is a withdrawal family member, from the compiled ABI;
//   4. the holder still has a claim afterwards, read from the target's storage.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "ethers";
import { judgeLocked, scopeWithdrawals } from "../lib/oracle-locked.mjs";

const VICTIM = "0x00000000000000000000000000000000000a11ce";
const VAULT = "0x00000000000000000000000000000000000e1a17";
const TESTC = "0x000000000000000000000000000000000007e57e";
const BASE = "0x" + "0".repeat(63) + "3";
const slotFor = (holder) => keccak256("0x" + holder.replace(/^0x/, "").padStart(64, "0") + BASE.replace(/^0x/, "")).replace(/^0x/, "").toLowerCase();

// A workspace whose compiled ABI has redeem() and a sharesOf mapping, which is what
// the channel reads. Forge's real artifact shape, minimal.
function artifact(ws) {
  mkdirSync(join(ws, "out", "V.sol"), { recursive: true });
  writeFileSync(join(ws, "out", "V.sol", "V.json"), JSON.stringify({
    metadata: { settings: { compilationTarget: { "src/V.sol": "V" } } },
    methodIdentifiers: { "redeem(uint256)": "db006a75", "deposit(uint256)": "b6b55f25" },
    storageLayout: {
      storage: [{ label: "sharesOf", slot: "3", type: "t_mapping" }],
      types: { t_mapping: { encoding: "mapping", key: "t_address", value: "t_uint256" }, t_address: { label: "address" }, t_uint256: { label: "uint256" } },
    },
  }));
}

const traced = (nodes) => [["Execution", { arena: nodes }]];
const call = (over) => ({ trace: { kind: "CALL", success: true, address: VAULT, caller: VICTIM, data: "0xb6b55f25", ...over } });
const sstore = (holder, value, reason = "SLOAD") => ({ trace: { kind: "CALL", success: true, address: VAULT, caller: VICTIM, data: "0x", steps: [{ storage_change: { key: "0x" + slotFor(holder), reason, value } }] } });

const withWs = (fn) => {
  const ws = mkdtempSync(join(tmpdir(), "locked-"));
  try { artifact(ws); return fn(ws); } finally { rmSync(ws, { recursive: true, force: true }); }
};
const targets = new Map([[VAULT, "V"]]);

test("the ABI reader finds withdrawal functions and claim slots, and nothing else", () => withWs((ws) => {
  const r = scopeWithdrawals(ws);
  assert.deepEqual([...r.bySelector.entries()], [["db006a75", "redeem"]], "deposit is not a withdrawal");
  assert.deepEqual(r.claims.get("V").map((x) => x.label), ["sharesOf"]);
}));

test("a holder whose redemption reverted while still holding shares is a lock", () => withWs((ws) => {
  const h = judgeLocked(traced([call({ success: false, data: "0xdb006a75" }), sstore(VICTIM, "0x3b9aca00")]), { ws, targets });
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.kind, "locked");
  assert.equal(h.victim, VICTIM);
  assert.equal(h.via, "redeem");
  assert.equal(h.stillOwed, "1000000000");
}));

test("the test withdrawing its own fixture is not a victim", () => withWs((ws) => {
  const t = [call({ success: false, data: "0xdb006a75", caller: TESTC }), sstore(TESTC, "0x3b9aca00")];
  const root = { trace: { kind: "CALL", success: true, address: TESTC, caller: "0x1804c8ab" } };
  const h = judgeLocked([["Execution", { arena: [root, ...t] }]], { ws, targets });
  assert.equal(h.ok, false);
  assert.match(h.reason, /no holder's withdrawal reverted/);
}));

test("a reverted call that is not a withdrawal is not a lock", () => withWs((ws) => {
  // A guard working correctly: deposit reverts, which is not harm.
  const h = judgeLocked(traced([call({ success: false, data: "0xb6b55f25" }), sstore(VICTIM, "0x3b9aca00")]), { ws, targets });
  assert.equal(h.ok, false);
}));

test("a revert on a contract outside the scope is not our business", () => withWs((ws) => {
  const other = "0x00000000000000000000000000000000000000ff";
  const h = judgeLocked(traced([call({ success: false, address: other, data: "0xdb006a75" }), sstore(VICTIM, "0x3b9aca00")]), { ws, targets });
  assert.equal(h.ok, false);
}));

test("a successful withdrawal is the funds channel's business, not a lock", () => withWs((ws) => {
  const h = judgeLocked(traced([call({ success: true, data: "0xdb006a75" }), sstore(VICTIM, "0x0")]), { ws, targets });
  assert.equal(h.ok, false);
}));

test("a reverted withdrawal with no claim left is a correct refusal", () => withWs((ws) => {
  // They already took everything out: the revert protects them, it does not harm them.
  const h = judgeLocked(traced([call({ success: false, data: "0xdb006a75" }), sstore(VICTIM, "0x0")]), { ws, targets });
  assert.equal(h.ok, false);
  assert.match(h.reason, /still held a claim/);
}));

test("no compiled ABI means the channel says so rather than guessing", () => {
  const ws = mkdtempSync(join(tmpdir(), "locked-empty-"));
  try {
    const h = judgeLocked(traced([call({ success: false, data: "0xdb006a75" })]), { ws, targets });
    assert.equal(h.ok, false);
    assert.match(h.reason, /no withdrawal function/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("the biggest claim wins when several holders are locked out", () => withWs((ws) => {
  const small = "0x00000000000000000000000000000000000000a1";
  const big = "0x00000000000000000000000000000000000000b2";
  const h = judgeLocked(traced([
    call({ success: false, data: "0xdb006a75", caller: small }), sstore(small, "0x10"),
    call({ success: false, data: "0xdb006a75", caller: big }), sstore(big, "0x1000"),
  ]), { ws, targets });
  assert.equal(h.ok, true);
  assert.equal(h.victim, big);
  assert.equal(h.stillOwed, "4096");
}));
