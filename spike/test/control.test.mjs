// Unit tests for control harm. Pure: synthetic replay traces, no Docker, no model.
//
//   node --experimental-test-module-mocks --test test/control.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, toBeHex } from "ethers";
import { KNOWN_KEYS, harmOf } from "../packs/keys/common.mjs";
import { controlChanges, labOf } from "../packs/keys/control.mjs";
import { extractControlTrace } from "../lib/control-trace.mjs";

const SAFE = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";
const PROXY = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OWNER = KNOWN_KEYS[0].toLowerCase();
const OTHER = "0x1000000000000000000000000000000000000001";
const ATTACKER = "0x00000000000000000000000000000000000bad01";
const EVIL = "0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9";
const TEST = "0x7fa9385be102ac3eac297483dd6233d62b3e1496";
const VM = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const w = (n) => toBeHex(BigInt(n), 32);
const addrWord = (a) => "0x" + "0".repeat(24) + a.slice(2);
const mapSlot = (key, base) => keccak256(concat([addrWord(key), w(base)]));
const IMPL = toBeHex(BigInt(keccak256(new TextEncoder().encode("eip1967.proxy.implementation"))) - 1n, 32);
const GUARD = keccak256(new TextEncoder().encode("guard_manager.guard.address"));

const obs = { safes: [{ address: SAFE, owners: [KNOWN_KEYS[0], OTHER], threshold: 1 }], code: { [OWNER]: { delegate: null } } };
const lab = labOf(obs, KNOWN_KEYS);
const write = (context, slot, after, before = w(0)) => ({ context, slot, before, after });
const trace = (over = {}) => ({ created: [], testContract: TEST, selectors: {}, words: {}, writes: [], etches: [], calls: [], ...over });
const safeLike = { [SAFE]: ["0x6a761202"] };

test("an owner-list write on a lab Safe is control harm and names the entry", () => {
  const t = trace({ selectors: safeLike, words: { [SAFE]: [ATTACKER] }, writes: [write(SAFE, mapSlot(ATTACKER, 2), addrWord(OTHER))] });
  const [change] = controlChanges(t, lab);
  assert.equal(change.target, SAFE);
  assert.equal(change.field, `Safe owner list (entry for ${ATTACKER})`);
  assert.equal(change.slot, mapSlot(ATTACKER, 2));
});

test("threshold, owner count, guard and module entries are named", () => {
  const t = trace({ selectors: safeLike, words: { [SAFE]: [ATTACKER] }, writes: [
    write(SAFE, w(4), w(2), w(1)), write(SAFE, w(3), w(3), w(2)), write(SAFE, GUARD, addrWord(ATTACKER)),
    write(SAFE, mapSlot(ATTACKER, 1), addrWord(OTHER)),
  ] });
  assert.deepEqual(controlChanges(t, lab).map((c) => c.field),
    ["Safe threshold", "Safe owner count", "Safe guard", `Safe module list (entry for ${ATTACKER})`]);
});

test("the nonce slot and unknown slots are not control", () => {
  const t = trace({ selectors: safeLike, writes: [write(SAFE, w(5), w(1)), write(SAFE, w(99), w(1))] });
  assert.deepEqual(controlChanges(t, lab), []);
});

test("an EIP-1967 implementation write on a lab proxy is control harm", () => {
  const proxyLab = labOf({ address: PROXY }, KNOWN_KEYS);
  const t = trace({ writes: [write(PROXY, IMPL, addrWord(EVIL), addrWord(OTHER))] });
  const [change] = controlChanges(t, proxyLab);
  assert.equal(change.field, "EIP-1967 implementation");
  assert.equal(change.slot, IMPL);
  assert.equal(change.after, addrWord(EVIL));
});

test("slot 0 of a lab proxy is its owner, but slot 0 of a Safe is the singleton", () => {
  const proxyLab = labOf({ address: PROXY }, KNOWN_KEYS);
  assert.equal(controlChanges(trace({ writes: [write(PROXY, w(0), addrWord(ATTACKER))] }), proxyLab)[0].field, "owner");
  const t = trace({ selectors: safeLike, writes: [write(SAFE, w(0), addrWord(ATTACKER))] });
  assert.equal(controlChanges(t, lab)[0].field, "Safe singleton");
});

test("a write to a contract that is neither created in the replay nor a lab target is ignored", () => {
  const t = trace({ writes: [write(OTHER, IMPL, addrWord(EVIL))] });
  assert.deepEqual(controlChanges(t, labOf({ address: PROXY }, KNOWN_KEYS)), []);
});

test("the test contract itself is never a victim", () => {
  const t = trace({ created: [TEST], writes: [write(TEST, IMPL, addrWord(EVIL))] });
  assert.deepEqual(controlChanges(t, labOf({ address: PROXY }, KNOWN_KEYS)), []);
});

const designator = (delegate) => "0xef0100" + delegate.slice(2);
test("an etched 7702 designator on a lab EOA, then a call to it, is a delegation change", () => {
  const t = trace({ etches: [{ index: 0, target: OWNER, code: designator(EVIL), kept: true }], calls: [{ address: OWNER, caller: TEST }] });
  const [change] = controlChanges(t, lab);
  assert.equal(change.field, "EIP-7702 delegation");
  assert.equal(change.target, OWNER);
  assert.equal(change.before, "none");
  assert.equal(change.after, EVIL);
});

test("a 7702 etch with no later call, on a non-lab EOA, with plain code, or to the same delegate is not control", () => {
  const call = [{ address: OWNER, caller: TEST }];
  assert.deepEqual(controlChanges(trace({ etches: [{ index: 1, target: OWNER, code: designator(EVIL), kept: true }], calls: call }), lab), []);
  assert.deepEqual(controlChanges(trace({ etches: [{ index: 0, target: OTHER, code: designator(EVIL), kept: true }], calls: [{ address: OTHER, caller: TEST }] }), lab), []);
  assert.deepEqual(controlChanges(trace({ etches: [{ index: 0, target: OWNER, code: "0x6001600155", kept: true }], calls: call }), lab), []);
  const delegated = labOf({ ...obs, code: { [OWNER]: { delegate: EVIL } } }, KNOWN_KEYS);
  assert.deepEqual(controlChanges(trace({ etches: [{ index: 0, target: OWNER, code: designator(EVIL), kept: true }], calls: call }), delegated), []);
});

test("harmOf: control changes alone prove harm with kind control and show the changed field", () => {
  const t = trace({ selectors: safeLike, writes: [write(SAFE, w(4), w(1), w(2))] });
  const harm = harmOf({ pass: true, transfers: [], controlTrace: t }, lab);
  assert.equal(harm.ok, true);
  assert.equal(harm.kind, "control");
  assert.equal(harm.victim, SAFE);
  assert.equal(harm.changes[0].field, "Safe threshold");
  assert.equal(harm.changes[0].slot, w(4));
});

test("harmOf: a probe that changes nothing still fails, with and without a trace", () => {
  const probe = harmOf({ pass: true, transfers: [], controlTrace: trace() }, lab);
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /changed no owner, threshold, module, guard, implementation, admin or delegation/);
  assert.equal(harmOf({ pass: true, transfers: [] }, lab).ok, false);
  assert.equal(harmOf({ pass: false, transfers: [], controlTrace: trace({ selectors: safeLike, writes: [write(SAFE, w(4), w(1))] }) }, lab).ok, false);
});

test("harmOf: ETH moving out is kind funds, and carries control changes when there are any", () => {
  const rows = [
    { address: SAFE, label: "Account", netWei: "-1000", gained: false },
    { address: ATTACKER, label: "Account", netWei: "1000", gained: true },
  ];
  const funds = harmOf({ pass: true, transfers: rows }, lab);
  assert.equal(funds.kind, "funds");
  assert.equal(funds.changes, undefined);
  const t = trace({ selectors: safeLike, writes: [write(SAFE, w(4), w(1), w(2))] });
  const both = harmOf({ pass: true, transfers: rows, controlTrace: t }, lab);
  assert.equal(both.kind, "funds");
  assert.equal(both.changes[0].field, "Safe threshold");
});

// A fake forge arena. Each node is one call. Steps carry the SSTORE storage_change.
const sstore = (key, value, had = w(0)) => ({ storage_change: { key, value, had_value: had, reason: "SSTORE" } });
const node = (parent, trace) => ({ parent, trace: { kind: "CALL", success: true, steps: [], data: "0x", ...trace } });
const arenaOf = (...nodes) => [["Execution", { arena: nodes }]];

test("extract: a real SSTORE in a successful call is kept, a same-value write is not", () => {
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: SAFE, caller: TEST, data: "0x0d582f13", steps: [sstore(w(4), w(2), w(1)), sstore(w(5), w(1), w(1))] }),
  ));
  assert.deepEqual(out.writes, [{ context: SAFE, slot: w(4), before: w(1), after: w(2) }]);
  assert.equal(out.testContract, TEST);
});

test("extract: a delegatecall write belongs to the caller, the storage owner", () => {
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: SAFE, caller: TEST }),
    node(1, { kind: "DELEGATECALL", address: EVIL, caller: SAFE, steps: [sstore(w(4), w(2), w(1))] }),
  ));
  assert.equal(out.writes[0].context, SAFE);
});

test("extract: writes in a reverted call or a constructor are dropped, and Safe setup writes are tagged", () => {
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: SAFE, caller: TEST, success: false, steps: [sstore(w(4), w(2))] }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(ATTACKER))] }),
    node(0, { address: SAFE, caller: TEST, data: "0xb63e800d00", steps: [sstore(w(3), w(2))] }),
    node(3, { kind: "DELEGATECALL", address: EVIL, caller: SAFE, steps: [sstore(w(4), w(1))] }),
  ));
  assert.deepEqual(out.writes, [
    { context: SAFE, slot: w(3), before: w(0), after: w(2), setup: true },
    { context: SAFE, slot: w(4), before: w(0), after: w(1), setup: true },
  ]);
  assert.deepEqual(out.created, [PROXY]);
});

test("a Safe setup write is deployment on a Safe, and a takeover on a lab EOA", () => {
  const setupWrite = (context) => ({ ...write(context, w(3), w(1)), setup: true });
  const t = (context) => trace({ selectors: { [context]: ["0xb63e800d"] }, writes: [setupWrite(context)] });
  assert.deepEqual(controlChanges(t(SAFE), lab), []);
  assert.deepEqual(controlChanges(t(PROXY), lab), []);
  const [change] = controlChanges(t(OWNER), lab);
  assert.equal(change.target, OWNER);
  assert.equal(change.field, "Safe owner count");
});

test("extract: a trace that is not the Execution trace adds no writes (setUp deployment)", () => {
  const out = extractControlTrace([["Setup", { arena: [node(null, { address: TEST }), node(0, { address: SAFE, caller: TEST, steps: [sstore(w(4), w(2))] })] }]]);
  assert.deepEqual(out.writes, []);
});

test("extract: an etch is read from the cheatcode call data, in call order (the root test call is call 0)", () => {
  const code = designator(EVIL).slice(2);
  const data = "0xb4d6c782" + addrWord(OWNER).slice(2) + w(64).slice(2) + w(23).slice(2) + code + "00".repeat(9);
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: SAFE, caller: TEST }),
    node(0, { address: VM, caller: TEST, data }),
    node(0, { address: OWNER, caller: TEST }),
  ));
  assert.deepEqual(out.etches, [{ index: 2, target: OWNER, code: "0x" + code, kept: true }]);
  assert.deepEqual(controlChanges({ ...out, testContract: TEST }, lab).map((c) => c.field), ["EIP-7702 delegation"]);
});

// H1d n2: every etch is recorded, with a `kept` flag. The control pack proves a
// delegation only from code that landed, so it ignores an etch in a reverted frame.
test("extract: an etch in a reverted frame is recorded as not kept, and is no delegation change", () => {
  const code = designator(EVIL).slice(2);
  const data = "0xb4d6c782" + addrWord(OWNER).slice(2) + w(64).slice(2) + w(23).slice(2) + code + "00".repeat(9);
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: TEST, caller: TEST, success: false }),
    node(1, { address: VM, caller: TEST, data }),
    node(0, { address: OWNER, caller: TEST }),
  ));
  assert.deepEqual(out.etches, [{ index: 1, target: OWNER, code: "0x" + code, kept: false }]);
  assert.deepEqual(controlChanges({ ...out, testContract: TEST }, lab), []);
});

test("a designator etch with no kept flag is no delegation change (fail closed)", () => {
  const t = trace({ etches: [{ index: 0, target: OWNER, code: designator(EVIL) }], calls: [{ address: OWNER, caller: TEST }] });
  assert.deepEqual(controlChanges(t, lab), []);
});

// H1d n1: cloneAccount and mockFunction are recorded also when the call was not
// kept. Forge keeps a mock in its inspector, and a recorded entry can only drop a
// target, so the record must not depend on the frame's outcome.
for (const [name, data] of [
  ["cloneAccount", "0x533d61c9" + addrWord(EVIL).slice(2) + addrWord(OWNER).slice(2)],
  ["mockFunction", "0xadf84d21" + addrWord(OWNER).slice(2) + addrWord(EVIL).slice(2) + w(96).slice(2) + w(0).slice(2)],
]) {
  test(`extract: a ${name} that was not kept is still recorded as an etch of the scope address`, () => {
    for (const arena of [
      arenaOf(node(null, { address: TEST }), node(0, { address: VM, caller: TEST, data, success: false })),
      arenaOf(node(null, { address: TEST }), node(0, { address: TEST, caller: TEST, success: false }), node(1, { address: VM, caller: TEST, data })),
    ]) {
      const out = extractControlTrace(arena);
      assert.deepEqual(out.etches.map((e) => [e.target, e.kept]), [[OWNER, false]]);
    }
  });
}

// H1b: cheatcodes that write storage or fake answers are recorded with the address
// they act on, in any frame, kept or not. store keeps its slot; copyStorage acts on
// its SECOND address; loadAllocs can write any account ("*").
test("extract: store, copyStorage, mockCall and loadAllocs are recorded as tampers, kept or not", () => {
  const SLOT = w(7);
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { address: VM, caller: TEST, data: "0x70ca10bb" + addrWord(SAFE).slice(2) + SLOT.slice(2) + w(1).slice(2) }),
    node(0, { address: TEST, caller: TEST, success: false }),
    node(2, { address: VM, caller: TEST, data: "0x203dac0d" + addrWord(OTHER).slice(2) + addrWord(PROXY).slice(2) }),
    node(0, { kind: "STATICCALL", address: VM, caller: TEST, data: "0xb96213e4" + addrWord(OWNER).slice(2) + w(96).slice(2) + w(128).slice(2) }),
    node(0, { address: VM, caller: TEST, data: "0xb3a056d7" + w(32).slice(2) + w(0).slice(2) }),
  ));
  assert.deepEqual(out.tampers, [
    { target: SAFE, how: "store", slot: SLOT, kept: true },
    { target: PROXY, how: "copyStorage", kept: false },
    { target: OWNER, how: "mockCall", kept: true },
    { target: "*", how: "loadAllocs", kept: true },
  ]);
  assert.deepEqual(out.writes, []);
});

test("extract: vm.store makes no SSTORE step, so it leaves no write", () => {
  const out = extractControlTrace(arenaOf(node(null, { address: TEST }), node(0, { address: VM, caller: TEST, data: "0x70ca10bb" })));
  assert.deepEqual(out.writes, []);
});

// Caller gate: the owner or admin handing over control is legitimate, an outsider is harm.
const proxyLab = labOf({ address: PROXY }, KNOWN_KEYS);
const ownerTrace = (caller) => extractControlTrace(arenaOf(
  node(null, { address: TEST }),
  node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(TEST))] }),
  node(0, { address: PROXY, caller, steps: [sstore(w(0), addrWord(ATTACKER), addrWord(TEST))] }),
));

test("extract: each write records its caller and the owner it saw just before", () => {
  const out = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(TEST))] }),
    node(0, { address: PROXY, caller: ATTACKER }),
    node(2, { kind: "DELEGATECALL", address: EVIL, caller: PROXY, steps: [sstore(w(0), addrWord(ATTACKER), addrWord(TEST))] }),
  ));
  assert.equal(out.writes.length, 1);
  assert.equal(out.writeMeta.length, 1);
  assert.equal(out.writeMeta[0].caller, ATTACKER);
  assert.deepEqual(out.writeMeta[0].authority, [TEST]);
});

test("a proxy owner change made by the owner is not harm", () => {
  assert.deepEqual(controlChanges(ownerTrace(TEST), proxyLab), []);
});

test("a proxy owner change made by an outsider is harm", () => {
  const [change] = controlChanges(ownerTrace(ATTACKER), proxyLab);
  assert.equal(change.field, "owner");
});

// ---- repair cycle 2 ----
const E = "0x00000000000000000000000000000000000e0001";
const A2 = "0x00000000000000000000000000000000000a0002";
const ADMIN_SLOT_HEX = toBeHex(BigInt(keccak256(new TextEncoder().encode("eip1967.proxy.admin"))) - 1n, 32);

test("a constructor that takes another contract's owner slot does not become its owner", () => {
  // E takes PROXY slot 0 inside its own constructor. Later E changes it again.
  const t = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(TEST))] }),
    node(0, { kind: "CREATE", address: E, caller: ATTACKER, steps: [] }),
    node(2, { address: PROXY, caller: E, steps: [sstore(w(0), addrWord(E), addrWord(TEST))] }),
    node(0, { address: PROXY, caller: E, steps: [sstore(w(0), addrWord(A2), addrWord(E))] }),
  ));
  const changes = controlChanges(t, proxyLab);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "owner");
  assert.equal(changes[0].after, addrWord(A2));
});

test("source mode: an admin's EIP-1967 upgrade is legitimate, an outsider's is harm", () => {
  const source = labOf(null);
  const run = (caller) => extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(ADMIN_SLOT_HEX, addrWord(TEST))] }),
    node(0, { address: PROXY, caller, steps: [sstore(IMPL, addrWord(EVIL), addrWord(OTHER))] }),
  ));
  assert.deepEqual(controlChanges(run(TEST), source), []);
  const [change] = controlChanges(run(ATTACKER), source);
  assert.equal(change.field, "EIP-1967 implementation");
});

test("source mode: the prompt does not promise a slot-0 owner the engine will not count", async () => {
  const { sourceSystem } = await import("../packs/keys/common.mjs");
  const text = sourceSystem("keys");
  assert.doesNotMatch(text, /changes the owner \(slot 0\)/);
  assert.match(text, /plain owner variable \(slot 0\) is\s+NOT counted/);
  assert.deepEqual(controlChanges(trace({ created: [PROXY], writes: [write(PROXY, w(0), addrWord(ATTACKER), addrWord(TEST))] }), labOf(null)), []);
});

// ---- repair cycle 3 ----
test("source mode: an outsider who takes slot 0 does not become the authority for the upgrade", () => {
  // TEST builds the proxy (slot 0 = TEST). ATTACKER calls an open setOwner (slot 0 = ATTACKER),
  // then writes the implementation slot. Slot 0 is not counted as control in source mode, but the
  // upgrade is harm all the same.
  const t = extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(TEST))] }),
    node(0, { address: PROXY, caller: ATTACKER, steps: [sstore(w(0), addrWord(ATTACKER), addrWord(TEST))] }),
    node(0, { address: PROXY, caller: ATTACKER, steps: [sstore(IMPL, addrWord(EVIL), addrWord(OTHER))] }),
  ));
  const source = controlChanges(t, labOf(null));
  assert.deepEqual(source.map((c) => c.field), ["EIP-1967 implementation"]);
  // With a lab proxy both writes are harm: the takeover is not adopted as authority.
  assert.deepEqual(controlChanges(t, proxyLab).map((c) => c.field), ["owner", "EIP-1967 implementation"]);
});

// ---- repair cycle 4 ----
const OWNER2 = "0x00000000000000000000000000000000000a0003";
const uupsTrace = (caller, build = true) => extractControlTrace(arenaOf(
  node(null, { address: TEST }),
  ...(build ? [node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(OWNER2))] })] : []),
  node(0, { address: PROXY, caller, steps: [sstore(IMPL, addrWord(EVIL), addrWord(OTHER))] }),
));

test("source mode: a UUPS proxy has its owner in slot 0 and no admin slot; the owner's upgrade is legitimate", () => {
  assert.deepEqual(controlChanges(uupsTrace(OWNER2), labOf(null)), []);
  assert.deepEqual(controlChanges(uupsTrace(ATTACKER), labOf(null)).map((c) => c.field), ["EIP-1967 implementation"]);
});

test("source mode: an owner hand-over by the owner passes the authority on; a takeover does not", () => {
  const chain = (first, second) => extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [sstore(w(0), addrWord(OWNER2))] }),
    node(0, { address: PROXY, caller: first, steps: [sstore(w(0), addrWord(OTHER), addrWord(OWNER2))] }),
    node(0, { address: PROXY, caller: second, steps: [sstore(IMPL, addrWord(EVIL), addrWord(A2))] }),
  ));
  // OWNER2 hands slot 0 to OTHER, then OTHER upgrades: legitimate.
  assert.deepEqual(controlChanges(chain(OWNER2, OTHER), labOf(null)), []);
  // ATTACKER writes slot 0 (not entitled), then upgrades as ATTACKER: harm.
  assert.deepEqual(controlChanges(chain(ATTACKER, ATTACKER), labOf(null)).map((c) => c.field), ["EIP-1967 implementation"]);
});

test("the test contract may initialize an empty owner slot; an outsider may not", () => {
  const init = (caller) => extractControlTrace(arenaOf(
    node(null, { address: TEST }),
    node(0, { kind: "CREATE", address: PROXY, caller: TEST, steps: [] }),
    node(0, { address: PROXY, caller, steps: [sstore(w(0), addrWord(caller))] }),
    node(0, { address: PROXY, caller, steps: [sstore(IMPL, addrWord(EVIL), addrWord(OTHER))] }),
  ));
  assert.deepEqual(controlChanges(init(TEST), labOf(null)), []);
  assert.deepEqual(controlChanges(init(ATTACKER), labOf(null)).map((c) => c.field), ["EIP-1967 implementation"]);
});
