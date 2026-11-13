// The forge harm gate: a passing test is not a proof. A finding is proven only
// when its replay calls a contract deployed from the audited scope AND harms it,
// by ETH leaving it, an authenticated ERC-20 drain, or a control-slot takeover.
//
//   node --test spike/test/harm-gate.test.mjs
//
// The first tests are pure: synthetic traces in, verdict out. The last ones run
// real forge in Docker against the vault-reentrancy lab, and skip when the
// Foundry image is not present.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, id } from "ethers";
import { judgeHarm } from "../lib/proof.mjs";
import { extractControlTrace, word } from "../lib/control-trace.mjs";
import { gate, proveFindings } from "../lib/record.mjs";
import { isProven } from "../lib/proof-view.mjs";
import { makeWorkspace } from "../lib/sandbox.mjs";
import contracts from "../packs/contracts/pack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(HERE, "../../lab/vault-reentrancy");

// ---- synthetic traces -------------------------------------------------------

const TEST = "0x7fa9385be102ac3eac297483dd6233d62b3e1496";
const VAULT = "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f";
const HELPER = "0x2e234dae75c793f67a35089c9d99245e1c58470b";
const ATTACKER = "0x000000000000000000000000000000000000beef";
const SCOPE = [{ name: "Vault", path: "src/Vault.sol", code: "6080aa__$0123456789abcdef0123456789abcdef01$__bb" }];
const VAULT_INIT = "0x6080aa" + "f".repeat(40) + "bb" + "00".repeat(32); // a linked library + ctor args
const node = (parent, trace) => ({ parent, trace: { success: true, value: "0x0", data: "0x", steps: [], ...trace } });
const setup = (...extra) => ["Setup", { arena: [node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x0a9254e4" }), node(0, { kind: "CREATE", address: VAULT, caller: TEST, data: VAULT_INIT }), ...extra] }];
const exec = (...nodes) => ["Execution", { arena: [node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }), ...nodes] }];
const sstore = (key, before, after) => ({ storage_change: { reason: "SSTORE", key, had_value: before, value: after } });
const verdict = (traces) => judgeHarm(traces, { scope: SCOPE, controlTrace: extractControlTrace(traces) });

test("harm gate: a tautology that deploys no scope contract is not harm", () => {
  const traces = [["Setup", { arena: [node(null, { kind: "CALL", address: TEST })] }], exec()];
  const h = verdict(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /deployed no contract from the audited scope/);
});

test("harm gate: a contract defined in the test file is not a scope target", () => {
  const traces = [["Setup", { arena: [node(null, { kind: "CALL", address: TEST }), node(0, { kind: "CREATE", address: HELPER, data: "0x6080cc" })] }],
    exec(node(0, { kind: "CALL", address: HELPER, caller: TEST, value: "0x10", steps: [sstore("0x1", "0x0", "0x1")] }))];
  assert.equal(verdict(traces).ok, false);
});

test("harm gate: a test that calls the target but moves nothing and writes nothing is not harm", () => {
  const traces = [setup(), exec(node(0, { kind: "STATICCALL", address: VAULT, caller: TEST, data: "0x01e1d114" }))];
  const h = verdict(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
  assert.deepEqual(h.targets, [{ address: VAULT, name: "Vault" }]);
});

test("harm gate: a deployed target the test never calls is not harm", () => {
  assert.match(verdict([setup(), exec()]).reason, /never made a successful call/);
});

test("harm gate: ETH leaving the target in the test body is funds harm", () => {
  const traces = [setup(), exec(
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" }),
    node(1, { kind: "CALL", address: TEST, caller: VAULT, value: "0x0de0b6b3a7640000" }),
  )];
  const h = verdict(traces);
  assert.equal(h.ok, true);
  assert.equal(h.kind, "funds");
  assert.equal(h.victim, VAULT);
  assert.equal(h.lostWei, "1000000000000000000");
});

test("harm gate: re-pointing the owner slot to a new address with zero ETH is control harm", () => {
  const traces = [setup(), exec(node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x13af4035", steps: [sstore("0x0", "0x" + TEST.slice(2).padStart(64, "0"), "0x" + ATTACKER.slice(2).padStart(64, "0"))] }))];
  const h = verdict(traces);
  assert.equal(h.ok, true);
  assert.equal(h.kind, "control");
  assert.equal(h.victim, VAULT);
});

test("harm gate: a benign state write in the target (a balance, not a control slot) is NOT harm", () => {
  // The reviewer's case: a normal deposit writes a balance-mapping slot in the test
  // body. It is a real SSTORE, but it re-points no control pointer, so it is not harm.
  const traces = [setup(), exec(node(0, { kind: "CALL", address: VAULT, caller: TEST, value: "0x10", data: "0xd0e30db0", steps: [sstore("0x9", "0x0", "0x10")] }))];
  const h = verdict(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /took over none of its control slots/);
});

test("harm gate: writing a non-address value into the owner slot is NOT a takeover", () => {
  // A control slot touched, but the new value is a scalar (a flag/count), not an
  // address reassignment. Nothing was taken over.
  const traces = [setup(), exec(node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x12345678", steps: [sstore("0x0", "0x0", "0x1")] }))];
  assert.equal(verdict(traces).ok, false);
});

test("harm gate: a write or payout under a reverted call does not count", () => {
  const traces = [setup(), exec(
    { parent: 0, trace: { kind: "CALL", address: VAULT, caller: TEST, success: false, value: "0x0", data: "0x", steps: [sstore("0x0", "0x0", "0x1")] } },
    node(1, { kind: "CALL", address: TEST, caller: VAULT, value: "0x10" }),
    node(0, { kind: "STATICCALL", address: VAULT, caller: TEST }),
  )];
  assert.equal(verdict(traces).ok, false);
});

test("harm gate: a target the test etched over is no longer a target", () => {
  const etch = "0xb4d6c782" + VAULT.slice(2).padStart(64, "0") + "40".padStart(64, "0") + "1".padStart(64, "0") + "00".padEnd(64, "0");
  const traces = [setup(), exec(
    node(0, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST, data: etch }),
    node(0, { kind: "CALL", address: VAULT, caller: TEST, steps: [sstore("0x0", "0x0", "0x1")] }),
  )];
  assert.match(verdict(traces).reason, /deployed no contract from the audited scope/);
});

test("harm gate: a target the test etched over in setUp() is no longer a target either", () => {
  const etch = "0xb4d6c782" + VAULT.slice(2).padStart(64, "0") + "40".padStart(64, "0") + "1".padStart(64, "0") + "00".padEnd(64, "0");
  const traces = [setup(
    node(0, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST, data: etch }),
  ), exec(
    node(0, { kind: "CALL", address: VAULT, caller: TEST, steps: [sstore("0x0", "0x0", "0x1")] }),
  )];
  const harm = verdict(traces);
  assert.equal(harm.ok, false);
  assert.match(harm.reason, /deployed no contract from the audited scope/);
  const finding = { severity: "high", poc: "X", forgePassed: true, pocProved: true, proof: { kind: "forge", status: "pass", pass: true, harm } };
  assert.equal(isProven(finding), false);
});

test("gate(): a passing replay with no harm verdict, or a failed one, is not a pass", () => {
  assert.equal(gate({ kind: "forge", status: "pass", pass: true }).pass, false);
  const no = gate({ kind: "forge", status: "pass", pass: true, harm: { ok: false, reason: "nope" } });
  assert.deepEqual([no.pass, no.status, no.reason], [false, "fail", "nope"]);
  const yes = gate({ kind: "forge", status: "pass", pass: true, harm: { ok: true, kind: "funds" } });
  assert.equal(yes.pass, true);
  // A pack judge replaces the generic verdict.
  assert.equal(gate({ kind: "forge", status: "pass", pass: true, harm: { ok: true } }, () => ({ ok: false, reason: "lab says no" })).pass, false);
});

test("isProven: a forge record with a failed harm verdict is not proven, even if pocProved says so", () => {
  const base = { severity: "high", poc: "X", forgePassed: true, pocProved: true };
  assert.equal(isProven({ ...base, proof: { kind: "forge", status: "pass", pass: true, harm: { ok: true } } }), true);
  assert.equal(isProven({ ...base, proof: { kind: "forge", status: "pass", pass: true, harm: { ok: false } } }), false);
  assert.equal(isProven({ ...base, proof: { kind: "forge", status: "fail", pass: false } }), false);
});

// ---- authenticated token drains --------------------------------------------
//
// A Transfer log is not a drain. The fallback used to net every ERC-20 Transfer
// in the test body, so a test that only calls the vault and then emits
// Transfer(vault, attacker, 1 ether) itself came back ok:true / kind:funds.
// Empty layout and balance maps are the production shape when the audited
// contract has no tracked balance slot. A log counts only when its emitter is
// the token and that token's balance slot for the victim actually decreased.

const TOKEN = "0x00000000000000000000000000000000000000aa";
// A scope token: its creation code matches a scope entry, so scanTargets marks
// TOKEN a target. The replay is offline, so a target is the ONLY emitter the
// gate trusts for a Transfer-log drain (see realTokenEmitter / B1).
const TOKEN_CODE = "6080a1";
const TOKEN_SCOPE = [...SCOPE, { name: "Ext", path: "src/Ext.sol", code: TOKEN_CODE }];
const createToken = () => node(0, { kind: "CREATE", address: TOKEN, caller: TEST, data: "0x" + TOKEN_CODE });
const ONE = "0x0de0b6b3a7640000"; // 1 ether
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const padTopic = (addr) => "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
const transferLog = (from, to, amount) => ({ raw_log: { topics: [TRANSFER, padTopic(from), padTopic(to)], data: amount } });
const logged = (parent, trace, logs) => Object.assign(node(parent, trace), { logs });
// Same slot the gate computes: keccak256(abi.encode(holder, base)).
const balSlot = (holder, base = "0x0") => keccak256(word(holder) + word(base).slice(2));
const callVault = () => node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x01e1d114" });
const emptyMaps = (traces, extra = {}) => judgeHarm(traces, {
  scope: SCOPE, controlTrace: extractControlTrace(traces), layouts: new Map(), balances: new Map(), ...extra,
});

test("harm gate: a Transfer log emitted by the test contract is not a token drain", () => {
  const log = transferLog(VAULT, ATTACKER, ONE);
  const plain = [setup(), ["Execution", { arena: [
    logged(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }, [log]),
    callVault(),
  ] }]];
  const h = emptyMaps(plain);
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
  // The same forgery, plus the test writing the victim's balance slot in its OWN
  // storage. The slot really changes, but the emitter is still the test contract.
  const planted = [setup(), ["Execution", { arena: [
    logged(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678", steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
    callVault(),
  ] }]];
  assert.equal(emptyMaps(planted).ok, false);
});

test("harm gate: a Transfer log from a contract the test created is not a token drain", () => {
  // CREATE2 on purpose: the control trace's created-set only records CREATE, and
  // a salt deploy is the obvious way past that set. The helper also writes the
  // real balance slot, so a storage-only check would accept it.
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(
    node(0, { kind: "CREATE2", address: HELPER, caller: TEST, data: "0x6080cc" }),
  ), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: HELPER, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

test("harm gate: a Transfer log from code the test etched in is not a token drain", () => {
  const etch = "0xb4d6c782" + TOKEN.slice(2).padStart(64, "0") + "40".padStart(64, "0") + "1".padStart(64, "0") + "00".padEnd(64, "0");
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    node(0, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST, data: etch }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  assert.equal(emptyMaps(traces).ok, false);
});

test("harm gate: a Transfer log is not a drain when the layout's balance slot did not move", () => {
  // The audited token's layout says the balance mapping is at base 0. The test
  // emits a Transfer and writes the base-1 slot instead. That is not the balance.
  const TOK = "0xc0ffee0000000000000000000000000000000001";
  const scope = [...SCOPE, { name: "Tok", path: "src/Tok.sol", code: "6080ee" }];
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(
    node(0, { kind: "CREATE", address: TOK, caller: TEST, data: "0x6080ee" }),
  ), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOK, caller: TEST, steps: [sstore(balSlot(VAULT, "0x1"), ONE, "0x0")] }, [log]),
  ] }]];
  const h = judgeHarm(traces, {
    scope, controlTrace: extractControlTrace(traces), layouts: new Map(), balances: new Map([["Tok", [word("0x0")]]]),
  });
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

test("harm gate: a Transfer log from a pre-existing (test-placed, offline) emitter is not a token drain", () => {
  // The B1 forgery in synthetic form. TOKEN is not created, etched or a scope
  // target: it is a bare "pre-existing" address, exactly what cloneAccount or a
  // 7702 delegation lands code at. The replay is offline, so no real external
  // ERC-20 can be there — the test put it there. The emitter writes the victim's
  // real balance slot AND emits a Transfer, yet the gate must reject it, because
  // only a scope token authenticates a drain.
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

test("harm gate: an authenticated token drain (log and balance slot) is funds harm", () => {
  // Empty layout and balance maps, as in the forgery above. The emitter is a
  // scope token (TOKEN created from scope code), and the victim's balance slot
  // in THAT token decreased.
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, true);
  assert.equal(h.kind, "funds");
  assert.equal(h.asset, "token");
  assert.equal(h.victim, VAULT);
  assert.equal(h.token, TOKEN);
  assert.equal(h.lostUnits, "1000000000000000000");
});

test("harm gate: a Transfer log cannot inflate the loss past the balance-slot write (Minor)", () => {
  // The log claims 5e18 left the vault, but the token's balance slot only fell
  // by 1e18 in the body. The storage write is the ground truth, so the reported
  // loss is the smaller of the two. A mutant that reports the logged amount
  // would say 5e18 here.
  const FIVE = "0x4563918244f40000"; // 5 ether
  const log = transferLog(VAULT, ATTACKER, FIVE);
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, true);
  assert.equal(h.asset, "token");
  assert.equal(h.victim, VAULT);
  assert.equal(h.lostUnits, "1000000000000000000");
});

test("harm gate: a scope target GAINING a token balance is not a drain (Minor, gain-counts guard)", () => {
  // The vault's balance slot in a scope token RISES in the body (0 -> 100): the
  // vault received tokens, it was not drained. balanceDrains counts only a net
  // loss (delta < 0). A mutant that drops the `delta >= 0n` guard would report
  // this gain as a drain with a negative loss.
  const TOK = "0xc0ffee0000000000000000000000000000000002";
  const scope = [...SCOPE, { name: "Tok", path: "src/Tok.sol", code: "6080ee" }];
  const traces = [setup(
    node(0, { kind: "CREATE", address: TOK, caller: TEST, data: "0x6080ee" }),
  ), exec(
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" }),
    node(0, { kind: "CALL", address: TOK, caller: TEST, data: "0xa9059cbb", steps: [sstore(balSlot(VAULT), "0x0", "0x64")] }),
  )];
  const h = judgeHarm(traces, {
    scope, controlTrace: extractControlTrace(traces), layouts: new Map(), balances: new Map([["Tok", [word("0x0")]]]),
  });
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

test("harm gate: a setUp-funded vault drained in the test body is still a token drain", () => {
  // The mint happened in setUp, so it is not an execution write. The body's
  // SSTORE still carries the funded balance as its old value (100 -> 0). No
  // Transfer log: the storage channel is what keeps this case proven.
  const TOK = "0xc0ffee0000000000000000000000000000000001";
  const scope = [...SCOPE, { name: "Tok", path: "src/Tok.sol", code: "6080ee" }];
  const traces = [setup(
    node(0, { kind: "CREATE", address: TOK, caller: TEST, data: "0x6080ee" }),
  ), exec(
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" }),
    node(0, { kind: "CALL", address: TOK, caller: TEST, data: "0xa9059cbb", steps: [sstore(balSlot(VAULT), "0x64", "0x0")] }),
  )];
  const h = judgeHarm(traces, {
    scope, controlTrace: extractControlTrace(traces), layouts: new Map(), balances: new Map([["Tok", [word("0x0")]]]),
  });
  assert.equal(h.ok, true);
  assert.equal(h.kind, "funds");
  assert.equal(h.asset, "token");
  assert.equal(h.victim, VAULT);
  assert.equal(h.token, TOK);
  assert.equal(h.lostUnits, "100");
});

// ---- cloneAccount recorded as an etch (M3) ---------------------------------
//
// vm.cloneAccount(source, target) copies source's code onto target. The gate
// used to see only vm.etch, so a fake deployed with cloneAccount read as the
// real scope contract and a forged drain/takeover built on it was proven.
// control-trace.mjs now records cloneAccount as an etch of its second argument,
// so the target stops being a scope contract — the same path a plain etch takes.

const CLONE = "0x533d61c9";
const cloneAccount = (source, target) => node(0, {
  kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST,
  data: CLONE + word(source).slice(2) + word(target).slice(2),
});

test("harm gate: cloneAccount over the scope target removes it, so a forged takeover proves nothing (M3)", () => {
  // Clone a fake over the one scope target, then re-point its owner slot. Before
  // the fix the clone was invisible, the target stayed in scope, and the owner
  // re-point read as a control takeover. Now the target is etched away.
  const SOURCE = "0x00000000000000000000000000000000000000c0";
  const traces = [setup(), exec(
    cloneAccount(SOURCE, VAULT),
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x13af4035", steps: [sstore("0x0", "0x" + TEST.slice(2).padStart(64, "0"), "0x" + ATTACKER.slice(2).padStart(64, "0"))] }),
  )];
  const h = verdict(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, /deployed no contract from the audited scope/);
});

test("harm gate: a Transfer log from a scope token the test cloned over is not a drain (M3 cloneover)", () => {
  // TOKEN is a scope token, then cloned over with a fake. A storage-plus-log
  // drain built on it must be rejected: the clone etched TOKEN away, so it is no
  // longer the audited token. The genuine victim (VAULT) stays in scope but is
  // not drained, so the verdict is no-harm.
  const SOURCE = "0x00000000000000000000000000000000000000c0";
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    cloneAccount(SOURCE, TOKEN),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, false);
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

// ---- prank-as-victim (M4) --------------------------------------------------
//
// vm.prank / vm.startPrank let the test impersonate any address. A test that
// pranks AS a scope target and then moves that target's funds is the test acting
// as the victim, not an exploit. The gate drops a target the test pranked as from
// the drain-victim set. A real PoC pranks the attacker or an EOA, never the
// victim, so a genuine drain while pranking the attacker is still proven.

// The refusal names the impersonated target, so the agent can repair its PoC
// (review 2, m1). It is the true reason: VAULT is dropped as a target.
const impersonatedVault = new RegExp(`the test impersonated scope target ${VAULT.toLowerCase()} \\(\\w+\\).*cannot be the victim`);

const prankNode = (who, selector = "0xca669fa7") => node(0, {
  kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST,
  data: selector + word(who).slice(2),
});

test("harm gate: an ETH loss where the test pranks AS the victim is not proven (M4)", () => {
  const traces = [setup(), exec(
    prankNode(VAULT),
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" }),
    node(1, { kind: "CALL", address: ATTACKER, caller: VAULT, value: ONE }),
  )];
  const h = verdict(traces);
  assert.equal(h.ok, false);
  assert.match(h.reason, impersonatedVault);
});

test("harm gate: a token drain where the test pranks AS the victim is not proven (M4)", () => {
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    prankNode(VAULT),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, false);
  assert.match(h.reason, impersonatedVault);
});

test("harm gate: a token drain while pranking AS the attacker is still proven (M4 guard)", () => {
  // The prank impersonates the attacker (0xBEEF), not the victim, so the drain
  // of VAULT stays proven. This guards against the M4 rule over-firing.
  const log = transferLog(VAULT, ATTACKER, ONE);
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    prankNode(ATTACKER),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, true);
  assert.equal(h.kind, "funds");
  assert.equal(h.victim, VAULT);
});

// m2 (review 2): the logged flow of the victim nets to zero (out and back in),
// but its balance slot dropped. The log channel counts only a net LOSER, so this
// is no drain. The mutant `delta >= 0n` -> `delta > 0n` would report a drain
// of 0 units.
test("harm gate: a net-zero logged flow with a balance-slot drop is not a token drain", () => {
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] },
      [transferLog(VAULT, ATTACKER, ONE), transferLog(ATTACKER, VAULT, ONE)]),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

// ---- the whole impersonation family (M4, delta review) ---------------------
//
// vm.prank / vm.startPrank each have four overloads: plain, with a tx.origin,
// with a delegateCall bool, and with both. vm.broadcast / vm.startBroadcast also
// set msg.sender. Every overload takes the impersonated sender as its FIRST
// address argument, so recording it is uniform. Recognising only the plain
// prank/startPrank selectors let a test impersonate the victim through any of the
// other overloads (e.g. prank(address,bool), selector 0xa7f8bf5c) and forge a
// drain the gate accepted. The gate must refuse the whole family. One test per
// signature; each must fail if its selector is dropped from the allowed set.

const IMPERSONATION_SIGS = [
  "prank(address)", "prank(address,address)", "prank(address,bool)", "prank(address,address,bool)",
  "startPrank(address)", "startPrank(address,address)", "startPrank(address,bool)", "startPrank(address,address,bool)",
  "broadcast(address)", "startBroadcast(address)",
];

for (const sig of IMPERSONATION_SIGS) {
  const selector = id(sig).slice(0, 10);
  test(`harm gate: a token drain where the test impersonates the victim via ${sig} is not proven (M4 family)`, () => {
    const log = transferLog(VAULT, ATTACKER, ONE);
    const traces = [setup(createToken()), ["Execution", { arena: [
      node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
      prankNode(VAULT, selector),
      callVault(),
      logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
    ] }]];
    const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
    assert.equal(h.ok, false, `${sig} impersonation must not be a proof`);
    assert.match(h.reason, impersonatedVault);
  });
}

// ---- real forge, in Docker --------------------------------------------------

const hasForge = (() => {
  try { execFileSync("docker", ["image", "inspect", "ghcr.io/foundry-rs/foundry:latest"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const skip = !hasForge && "foundry image not present";
const workspaces = [];
after(() => { for (const ws of workspaces) rmSync(ws, { recursive: true, force: true }); });

const HEAD = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
`;
const TAUTOLOGY = HEAD + `contract TautologyTest is Test { function test_pwned() public { assertTrue(true); } }\n`;
const HARMLESS = HEAD + `import "../src/Vault.sol";
contract HarmlessTest is Test {
  Vault v;
  function setUp() public { v = new Vault(); vm.deal(address(this), 1 ether); v.deposit{value: 1 ether}(); }
  function test_look() public { assertEq(v.totalAssets(), 1 ether); }
}
`;
// The reviewer's exposed case: the state-changing call is in the TEST BODY, not
// setUp(). A deposit writes a real balance slot in the target during the body and
// still proves nothing — it re-points no control pointer and drains no ETH. Under
// the old gate any such body write counted as "control" harm.
const HARMLESS_BODY = HEAD + `import "../src/Vault.sol";
contract HarmlessBodyTest is Test {
  Vault v;
  function setUp() public { v = new Vault(); vm.deal(address(this), 1 ether); }
  function test_deposit() public { v.deposit{value: 1 ether}(); assertEq(v.balanceOf(address(this)), 1 ether); }
}
`;

// Record one submitted finding the way a run does: run_poc passed, then prove.
async function prove(ws, poc, source) {
  const submitted = [{ title: poc, severity: "high", poc, explanation: "x", source }];
  const events = [{ ev: "run_poc-done", passed: true, contract: poc }];
  const [f] = await proveFindings(ws, submitted, events);
  return f;
}

test("forge: a tautology probe passes forge but is NOT proven", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  const f = await prove(ws, "TautologyTest", TAUTOLOGY);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.status, "fail");
  assert.match(f.proof.harm.reason, /deployed no contract from the audited scope/);
  assert.equal(f.pocProved, false);
  assert.equal(isProven(f), false);
});

test("forge: a test that calls the vault but moves and writes nothing in the test body is NOT proven", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  const f = await prove(ws, "HarmlessTest", HARMLESS);
  assert.equal(f.forgePassed, true);
  assert.match(f.proof.harm.reason, /moved no ETH out of it and took over none of its control slots/);
  assert.equal(isProven(f), false);
});

test("forge: a deposit that writes a balance slot in the test body is NOT proven", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  const f = await prove(ws, "HarmlessBodyTest", HARMLESS_BODY);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false);
  assert.match(f.proof.harm.reason, /took over none of its control slots/);
  assert.equal(isProven(f), false);
});

test("forge: the real lab drain is STILL proven through the funds channel", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  const source = readFileSync(path.join(LAB, "oracle/VaultExploit.t.sol"), "utf8");
  const f = await prove(ws, "VaultExploitTest", source);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "funds");
  assert.ok(BigInt(f.proof.harm.lostWei) > 0n);
  assert.equal(f.pocProved, true);
  assert.equal(isProven(f), true);
});

test("forge: an owner takeover with zero ETH is proven through the control channel", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  rmSync(path.join(ws, "src/Vault.sol"));
  writeFileSync(path.join(ws, "src/Owned.sol"), `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Owned {
  address public owner;
  constructor() { owner = msg.sender; }
  function setOwner(address o) external { owner = o; } // BUG: no access check
}
`);
  const source = HEAD + `import "../src/Owned.sol";
contract TakeoverTest is Test {
  Owned o;
  function setUp() public { o = new Owned(); }
  function test_takeover() public { vm.prank(address(0xBEEF)); o.setOwner(address(0xBEEF)); assertEq(o.owner(), address(0xBEEF)); }
}
`;
  const f = await prove(ws, "TakeoverTest", source);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});

test("forge: contracts submit_finding refuses a passing tautology with reason no-harm", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB);
  workspaces.push(ws);
  const state = { poc: 0, passed: new Map([["TautologyTest", TAUTOLOGY]]), found: [] };
  const submit = contracts.tools(ws, state).find((t) => t.name === "submit_finding");
  const r = await submit.execute({ title: "t", severity: "critical", poc_contract: "TautologyTest", explanation: "x" });
  assert.equal(r.isError, true);
  assert.match(r.output[0].text, /shows no harm/);
  assert.equal(state.found.length, 0);
});

// ---- reviewer cycle-2 cases: each a real forge replay of a defect the harm-gate
// repair had to fix, with the matching benign negative so no fix is a new false
// positive. These replace position/value guesses with the compiled storage layout
// and add an ERC-20 token channel. See lib/proof.mjs scopeLayouts / layoutTakeovers
// / tokenDrains.

// Shorthand: drop the lab's Vault, write scope `src` files, prove one PoC contract.
async function proveScope(ws, files, poc, body) {
  rmSync(path.join(ws, "src/Vault.sol"));
  for (const [name, code] of Object.entries(files)) writeFileSync(path.join(ws, "src", name), code);
  return prove(ws, poc, HEAD + body);
}

const TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
}
contract TokVault {
  Tok public tok;
  constructor(Tok t) { tok = t; }
  function withdraw(uint256 a) external { tok.transfer(msg.sender, a); } // BUG: no accounting, anyone drains it
}
`;

// #1 (regression fixed): an ERC-20 drain of a scope vault is proven by the token channel.
test("forge: an ERC-20 token drain of a scope vault is proven (token channel)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "TokenDrainTest", `import "../src/Tokens.sol";
contract TokenDrainTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function test_drain() public { vm.prank(address(0xBEEF)); vault.withdraw(100); assertEq(tok.balanceOf(address(0xBEEF)), 100); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.asset, "token");
  assert.ok(BigInt(f.proof.harm.lostUnits) >= 100n);
  assert.equal(isProven(f), true);
});

// #1 negative: tokens flowing INTO a scope vault (it gains) is not a drain.
test("forge: tokens flowing into a scope vault is NOT a drain (token channel negative)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "TokenDepositTest", `import "../src/Tokens.sol";
contract TokenDepositTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(this), 100); }
  function test_deposit() public { tok.transfer(address(vault), 50); assertEq(tok.balanceOf(address(vault)), 50); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// ---- forged-drain rejections, real forge (B1, M3, M4) ----------------------
//
// Each of these is a real forge replay of a forgery the reviewer raised. The
// attacker makes a Transfer and a balance-slot write look like a drain of the
// scope vault, but no scope token truly moved. These run the whole pipeline —
// forge trace, extractControlTrace, judgeHarm — so they also check that
// control-trace.mjs reads the cloneAccount and prank cheatcodes out of real
// foundry output at the right offsets.
//
// A FakeTok shares Tok's storage layout (balanceOf at slot 0) so a clone lands
// a funded victim slot. `drain` zeroes the victim's slot and emits a matching
// Transfer — a forged drain the gate must reject.
const FAKE_TOK = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract FakeTok {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function setBal(address who, uint256 a) external { balanceOf[who] = a; }
  function drain(address victim, address to) external { uint256 a = balanceOf[victim]; balanceOf[victim] = 0; emit Transfer(victim, to, a); }
}
`;

// M3: cloneAccount over the scope token overwrites its code and storage with the
// attacker's. The forged Transfer is emitted FROM the scope token's address, so
// before the fix it authenticated. Recording the clone as an etch of its target
// drops that address from the scope set, so the emitter is no longer trusted.
test("forge: a cloneAccount over the scope token forges a drain that is NOT proven (M3)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, "CloneOverTest",
    `import "../src/Tokens.sol";
import "../src/Fake.sol";
contract CloneOverTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function test_cloneover() public {
    fake.setBal(address(vault), 100);
    vm.cloneAccount(address(fake), address(tok));
    FakeTok(address(tok)).drain(address(vault), address(0xBEEF));
  }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// B1 / M3: a Transfer emitted from code the test cloned onto a NON-scope address.
// Offline there is no real external token, so a non-scope emitter is never
// trusted, and the clone is also recorded as an etch of that address.
test("forge: a Transfer from code cloned onto a non-scope address is NOT proven (B1)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, "CloneTest",
    `import "../src/Tokens.sol";
import "../src/Fake.sol";
contract CloneTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); }
  function test_clone() public {
    address fakeTok = address(0xC10E);
    fake.setBal(address(vault), 100);
    vm.cloneAccount(address(fake), fakeTok);
    FakeTok(fakeTok).drain(address(vault), address(0xBEEF));
  }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// M4: the test pranks AS the scope vault and moves the vault's real tokens with
// the real scope token. The emitter is authentic and the balance slot really
// falls, but the test is acting as the victim, so this is not an exploit.
test("forge: a drain where the test pranks AS the victim is NOT proven (M4)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "PrankVictimTest",
    `import "../src/Tokens.sol";
contract PrankVictimTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function test_prankDrain() public {
    vm.prank(address(vault));
    tok.transfer(address(0xBEEF), 100);
  }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// M4 (delta review): the same prank-as-victim forgery, but through the
// prank(address,bool) overload (selector 0xa7f8bf5c) instead of plain prank. Its
// delegateCall bool is not in the plain-prank selector set, so the impersonation
// was not recorded and the forged drain was accepted. Recording the whole family
// drops the pranked victim here too. The low-level vm.call form matches the
// reviewer's PoC and needs no cheatcode-interface import.
test("forge: a drain where the test pranks AS the victim via prank(address,bool) is NOT proven (M4 family)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "Prank2Test",
    `import "../src/Tokens.sol";
contract Prank2Test is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function test_prank2() public {
    (bool ok,) = address(vm).call(abi.encodeWithSignature("prank(address,bool)", address(vault), true));
    require(ok, "prank2");
    tok.transfer(address(0xBEEF), 100);
  }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// ---- forged drains, review 2 (real forge) -----------------------------------
//
// Each case is a forgery from the second review: forge passes, and the trace
// shows a real loss of a scope target, but the test made that loss with a
// cheatcode. The gate must say "not proven". `forged` also checks that forge
// passed: a forged case that fails forge proves nothing about the gate.
async function forged(poc, files, body) {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, files, poc, body);
  assert.equal(f.forgePassed, true, `${poc} must pass forge`);
  assert.equal(f.proof.harm.ok, false, `${poc} must not be proven: ${JSON.stringify(f.proof.harm)}`);
  assert.equal(isProven(f), false);
  return f;
}
const LAB_VAULT = readFileSync(path.join(LAB, "src/Vault.sol"), "utf8");
// A cheatcode declared `view` is reached by STATICCALL. Forge still runs it.
const VM_VIEW = `interface VmView {
  function prank(address) external view;
  function etch(address, bytes calldata) external view;
  function cloneAccount(address, address) external view;
}
`;

// B1: a cheatcode called by STATICCALL is recorded like one called by CALL.
test("forge: a prank AS the victim by STATICCALL is NOT proven (review 2 B1, staticprank)", { skip, timeout: 300_000 }, async () => {
  await forged("StaticPrankTest", { "Tokens.sol": TOKENS }, `import "../src/Tokens.sol";
${VM_VIEW}
contract StaticPrankTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function test_x() public {
    vault.tok();
    VmView(address(vm)).prank(address(vault));
    tok.transfer(address(0xBEEF), 100);
  }
}
`);
});

test("forge: an etch over the scope token by STATICCALL is NOT proven (review 2 B1, staticetch)", { skip, timeout: 300_000 }, async () => {
  await forged("StaticEtchTest", { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, `import "../src/Tokens.sol";
import "../src/Fake.sol";
${VM_VIEW}
contract StaticEtchTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function test_x() public {
    vault.tok();
    VmView(address(vm)).etch(address(tok), address(fake).code);
    FakeTok(address(tok)).drain(address(vault), address(0xBEEF));
  }
}
`);
});

test("forge: a cloneAccount over the scope token by STATICCALL is NOT proven (review 2 B1, staticclone)", { skip, timeout: 300_000 }, async () => {
  await forged("StaticCloneTest", { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, `import "../src/Tokens.sol";
import "../src/Fake.sol";
${VM_VIEW}
contract StaticCloneTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function test_x() public {
    vault.tok();
    fake.setBal(address(vault), 100);
    VmView(address(vm)).cloneAccount(address(fake), address(tok));
    FakeTok(address(tok)).drain(address(vault), address(0xBEEF));
  }
}
`);
});

test("forge: an ETH send AS the victim pranked by STATICCALL is NOT proven (review 2 B1, ethstatic)", { skip, timeout: 300_000 }, async () => {
  await forged("EthStaticTest", { "Vault.sol": LAB_VAULT }, `import "../src/Vault.sol";
${VM_VIEW}
contract EthStaticTest is Test {
  Vault v;
  function setUp() public { v = new Vault(); vm.deal(address(this), 5 ether); v.deposit{value: 5 ether}(); }
  function test_x() public {
    v.totalAssets();
    VmView(address(vm)).prank(address(v));
    (bool ok,) = address(0xBEEF).call{value: 1 ether}("");
    require(ok, "send");
  }
}
`);
});

// B2: forge keeps prank state in its inspector, not in EVM state, so a revert
// does not undo it. A prank armed in a frame that reverts still impersonates.
const REV_PRANK = (poc, arm) => `import "../src/Tokens.sol";
contract ${poc} is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function arm() external { ${arm}; revert("x"); }
  function fire() external { tok.transfer(address(0xBEEF), 100); }
  function test_x() public { vault.tok(); try this.arm() {} catch {} this.fire(); }
}
`;
test("forge: a prank AS the victim armed in a reverted frame is NOT proven (review 2 B2, revprank)", { skip, timeout: 300_000 }, async () => {
  await forged("RevPrankTest", { "Tokens.sol": TOKENS }, REV_PRANK("RevPrankTest", "vm.prank(address(vault))"));
});

test("forge: a startPrank AS the victim armed in a reverted frame is NOT proven (review 2 B2, revstart)", { skip, timeout: 300_000 }, async () => {
  await forged("RevStartTest", { "Tokens.sol": TOKENS }, REV_PRANK("RevStartTest", "vm.startPrank(address(vault))"));
});

// B3: prank(address,bool) with `true` makes the next DELEGATECALL run the test's
// code in the pranked address's storage. Pranked AS the scope token, the fake code
// zeroes the vault's balance in the real token; the vault itself was never
// pranked. Pranked AS an owned target, the fake code re-points its owner. A target
// the test impersonated is no target at all: not a victim, not a token, not a
// takeover context.
const DELEG_PRANK = (who) => `(bool ok,) = address(vm).call(abi.encodeWithSignature("prank(address,bool)", ${who}, true)); require(ok, "prank");`;
test("forge: a delegate prank AS the scope token is NOT proven (review 2 B3, delegtok)", { skip, timeout: 300_000 }, async () => {
  const f = await forged("DelegTokTest", { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, `import "../src/Tokens.sol";
import "../src/Fake.sol";
contract DelegTokTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function test_x() public {
    vault.tok();
    ${DELEG_PRANK("address(tok)")}
    (bool done,) = address(fake).delegatecall(abi.encodeCall(FakeTok.drain, (address(vault), address(0xBEEF))));
    require(done, "drain");
  }
}
`);
  assert.match(f.proof.harm.reason, /impersonated scope target 0x[0-9a-f]{40} \(Tok\)/);
});

test("forge: a delegate prank AS an owned scope target is NOT proven (review 2 B3, delegctl)", { skip, timeout: 300_000 }, async () => {
  const f = await forged("DelegCtlTest", { "Owned.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Owned {
  address public owner;
  constructor() { owner = msg.sender; }
  function hello() external pure returns (uint256) { return 1; }
}
` }, `import "../src/Owned.sol";
contract Writer { address public owner; function take(address a) external { owner = a; } }
contract DelegCtlTest is Test {
  Owned o; Writer w;
  function setUp() public { o = new Owned(); w = new Writer(); }
  function test_x() public {
    o.hello();
    ${DELEG_PRANK("address(o)")}
    (bool done,) = address(w).delegatecall(abi.encodeCall(Writer.take, (address(0xBEEF))));
    require(done, "take");
    require(o.owner() == address(0xBEEF), "owner");
  }
}
`);
  assert.match(f.proof.harm.reason, /impersonated scope target 0x[0-9a-f]{40} \(Owned\)/);
});

// Guard for the other side of B2: code is journaled EVM state, so an etch in a
// reverted frame is undone and the gate need not record it. If a forge version
// ever kept such an etch, the fake drain below would run at the real token's
// address and this test would catch it.
test("forge: an etch over the scope token in a reverted frame does not forge a drain", { skip, timeout: 300_000 }, async () => {
  await forged("RevEtchTest", { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, `import "../src/Tokens.sol";
import "../src/Fake.sol";
contract RevEtchTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function arm() external { vm.etch(address(tok), address(fake).code); revert("x"); }
  function test_x() public {
    vault.tok();
    try this.arm() {} catch {}
    try FakeTok(address(tok)).drain(address(vault), address(0xBEEF)) {} catch {}
  }
}
`);
});

// M1: vm.mockFunction(callee, target, data) runs target's code for calls to
// callee, in callee's storage. That is an etch of callee: it stops being a
// scope target.
test("forge: a mockFunction over the scope token is NOT proven (review 2 M1, mockfn)", { skip, timeout: 300_000 }, async () => {
  await forged("MockFnTest", { "Tokens.sol": TOKENS, "Fake.sol": FAKE_TOK }, `import "../src/Tokens.sol";
import "../src/Fake.sol";
contract MockFnTest is Test {
  Tok tok; TokVault vault; FakeTok fake;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); fake = new FakeTok(); tok.mint(address(vault), 100); }
  function test_x() public {
    vault.tok();
    vm.mockFunction(address(tok), address(fake), abi.encodeWithSelector(FakeTok.drain.selector));
    FakeTok(address(tok)).drain(address(vault), address(0xBEEF));
  }
}
`);
});

test("forge: a mockFunction that sweeps the ETH vault is NOT proven (review 2 M1, ethmockfn)", { skip, timeout: 300_000 }, async () => {
  await forged("EthMockFnTest", { "Vault.sol": LAB_VAULT }, `import "../src/Vault.sol";
contract Sweeper { function sweep(address to) external { payable(to).transfer(address(this).balance); } }
contract EthMockFnTest is Test {
  Vault v; Sweeper s;
  function setUp() public { v = new Vault(); s = new Sweeper(); vm.deal(address(this), 5 ether); v.deposit{value: 5 ether}(); }
  function test_x() public {
    v.totalAssets();
    vm.mockFunction(address(v), address(s), abi.encodeWithSelector(Sweeper.sweep.selector));
    Sweeper(address(v)).sweep(address(0xBEEF));
    require(address(0xBEEF).balance == 5 ether, "swept");
  }
}
`);
});

// m4: the ETH side of the impersonation rule, on real forge. The test pranks AS
// the vault and sends the vault's ETH away. The reason must name the vault.
test("forge: an ETH send AS the pranked victim is NOT proven (review 2 m4, ethprank)", { skip, timeout: 300_000 }, async () => {
  const f = await forged("EthPrankTest", { "Vault.sol": LAB_VAULT }, `import "../src/Vault.sol";
contract EthPrankTest is Test {
  Vault v;
  function setUp() public { v = new Vault(); vm.deal(address(this), 5 ether); v.deposit{value: 5 ether}(); }
  function test_x() public {
    v.totalAssets();
    vm.prank(address(v));
    (bool ok,) = address(0xBEEF).call{value: 1 ether}("");
    require(ok, "send");
    require(address(0xBEEF).balance == 1 ether, "sent");
  }
}
`);
  assert.match(f.proof.harm.reason, /the test impersonated scope target 0x[0-9a-f]{40} \(Vault\).*cannot be the victim/);
});

// A token that emits NO Transfer event — a hostile or sloppy in-scope ERC-20. Its
// balance storage is identical to TOKENS; only the advisory logs are gone. The
// ground-truth storage channel must prove a drain of it, and must NOT over-fire on
// a benign gain. This is the reviewer's FN-C regression, locked in both polarities.
const NOEVENT_TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
}
contract TokVault {
  Tok public tok;
  constructor(Tok t) { tok = t; }
  function withdraw(uint256 a) external { tok.transfer(msg.sender, a); } // BUG: no accounting, anyone drains it
}
`;

// #1b (regression fixed, no event): a drain of an event-less in-scope token is STILL
// proven — read from the balance mapping, not a Transfer log.
test("forge: an ERC-20 drain is proven even when the token emits NO Transfer event (storage channel)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": NOEVENT_TOKENS }, "NoEventDrainTest", `import "../src/Tokens.sol";
contract NoEventDrainTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100 ether); }
  function test_drain() public { address a = makeAddr("attacker"); vm.prank(a); vault.withdraw(100 ether); assertEq(tok.balanceOf(a), 100 ether); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.asset, "token");
  assert.ok(BigInt(f.proof.harm.lostUnits) >= 100n * 10n ** 18n);
  assert.equal(isProven(f), true);
});

// #1b negative (no event): tokens flowing INTO the event-less vault (it GAINS) must
// not be read as a drain — the storage channel nets a positive delta, so no harm.
test("forge: a gain of an event-less token is NOT a drain (storage channel negative)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": NOEVENT_TOKENS }, "NoEventDepositTest", `import "../src/Tokens.sol";
contract NoEventDepositTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(this), 100 ether); }
  function test_deposit() public { tok.transfer(address(vault), 50 ether); assertEq(tok.balanceOf(address(vault)), 50 ether); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// #2 (false positive fixed): a uint counter in slot 0 that changes twice is not a takeover.
test("forge: a counter in slot 0 that changes twice is NOT a takeover (layout fixes the FP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "CVault.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract CVault {
  uint256 public totalDeposits;               // slot 0 — a counter, not an owner
  mapping(address => uint256) public balanceOf;
  function deposit() external payable { totalDeposits += msg.value; balanceOf[msg.sender] += msg.value; }
}
` }, "CounterTest", `import "../src/CVault.sol";
contract CounterTest is Test {
  CVault v;
  function setUp() public { v = new CVault(); vm.deal(address(this), 2 ether); v.deposit{value: 1 ether}(); }
  function test_deposit_again() public { v.deposit{value: 1 ether}(); assertEq(v.totalDeposits(), 2 ether); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// #3 (false negative fixed): an unprotected initializer setting owner from zero is a takeover.
test("forge: an unprotected initializer that sets owner from zero IS a takeover (layout fixes the FN)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Initable.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Initable {
  address public owner;                        // slot 0, starts at zero
  function initialize() external { owner = msg.sender; } // BUG: no re-init guard, anyone can claim it
}
` }, "InitTest", `import "../src/Initable.sol";
contract InitTest is Test {
  Initable c;
  function setUp() public { c = new Initable(); }
  function test_init() public { vm.prank(address(0xBEEF)); c.initialize(); assertEq(c.owner(), address(0xBEEF)); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});

// #4 (false negative fixed): an owner living in slot 1 is still found by the layout.
test("forge: an owner takeover at a non-zero slot IS a takeover (layout fixes the FN)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Slot1Owned.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Slot1Owned {
  uint256 public fee;                          // slot 0
  address public owner;                        // slot 1
  constructor() { owner = msg.sender; }
  function setOwner(address o) external { owner = o; } // BUG: no access check
}
` }, "Slot1Test", `import "../src/Slot1Owned.sol";
contract Slot1Test is Test {
  Slot1Owned c;
  function setUp() public { c = new Slot1Owned(); }
  function test_takeover() public { vm.prank(address(0xBEEF)); c.setOwner(address(0xBEEF)); assertEq(c.owner(), address(0xBEEF)); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});

// #5 (false positive fixed): the real owner performing a UUPS upgrade is not a hijack.
test("forge: the real owner upgrading the implementation is NOT a hijack (layout fixes the FP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Up.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Up {
  uint256 public x;                            // slot 0
  address public owner;                        // slot 1
  constructor() { owner = msg.sender; }
  function upgradeTo(address impl) external {
    require(msg.sender == owner, "not owner");
    assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, impl) }
  }
}
` }, "UpgradeTest", `import "../src/Up.sol";
contract UpgradeTest is Test {
  Up c;
  function setUp() public { c = new Up(); }
  function test_legit_upgrade() public { c.upgradeTo(address(0x1234)); assertTrue(true); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// #5 positive guard: an UNPROTECTED implementation write by a non-owner IS a hijack
// (so fixing the FP above did not blind the EIP-1967 implementation channel).
test("forge: an unprotected implementation write by a non-owner IS a hijack (channel still live)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "BadUp.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract BadUp {
  uint256 public x;                            // slot 0
  address public owner;                        // slot 1
  constructor() { owner = msg.sender; }
  function upgradeTo(address impl) external {  // BUG: no owner check
    assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, impl) }
  }
}
` }, "HijackTest", `import "../src/BadUp.sol";
contract HijackTest is Test {
  BadUp c;
  function setUp() public { c = new BadUp(); }
  function test_hijack() public { vm.prank(address(0xBEEF)); c.upgradeTo(address(0x1234)); assertTrue(true); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});

// ---- reviewer cycle-2.2 cases: the classifier-blocked review raised these by
// reading the code. Each is a real forge replay that would have mis-judged before
// the fix, plus the polarity that proves the fix did not blind the channel. See
// lib/proof.mjs scopeLayouts (packed-slot skip, `address payable`) and BALANCE_NAMES.

// F7 (false positive fixed): a uint map whose NAME starts with a balance word but is
// not a balance — `depositTime`. A prefix match kept it and read a benign reset as a
// drain. Anchoring the name to the whole word drops it, so no drain is reported.
test("forge: a non-balance map named depositTime is NOT a token drain when it resets (name anchor fixes the FP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Reg.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Reg {
  mapping(address => uint256) public depositTime; // a timestamp map, NOT a balance
  function set(address who, uint256 t) external { depositTime[who] = t; }
}
contract Member { constructor(Reg r) { r.set(address(this), 0); } }
` }, "DepTimeTest", `import "../src/Reg.sol";
contract DepTimeTest is Test {
  Reg reg; Member m;
  function setUp() public { reg = new Reg(); m = new Member(reg); reg.set(address(m), 100); }
  function test_reset() public { reg.set(address(m), 0); assertEq(reg.depositTime(address(m)), 0); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// F1 (false positive fixed): an owner packed in slot 0 with another field (`bool
// paused`). The live word is owner|paused, not address-shaped, so the SLOAD
// entitlement fold never records the real owner and a benign unpause BY the owner
// read as a re-point. scopeLayouts now skips any slot shared by two fields, so a
// packed owner is not treated as a clean control pointer at all. (The symmetric cost
// — a REAL takeover of a packed owner is no longer proven through this channel — is
// the documented "rather miss an exotic packing than misread it" tradeoff.)
test("forge: a benign unpause by the real owner of a PACKED owner slot is NOT a takeover (packed-slot skip fixes the FP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Pausable.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Pausable {
  address public owner;   // slot 0, offset 0
  bool public paused;     // slot 0, offset 20 — packed above the owner
  constructor() { owner = msg.sender; }
  function pause() external { require(msg.sender == owner, "no"); paused = true; }
  function unpause() external { require(msg.sender == owner, "no"); paused = false; }
}
` }, "PauseTest", `import "../src/Pausable.sol";
contract PauseTest is Test {
  Pausable c;
  function setUp() public { c = new Pausable(); c.pause(); }
  function test_unpause() public { c.unpause(); assertTrue(!c.paused()); }
}
`);
  assert.equal(f.proof.harm.ok, false);
  assert.equal(isProven(f), false);
});

// F3 (false negative fixed): an owner declared `address payable`. The storage-layout
// type label is "address payable", which the strict `=== "address"` check dropped, so
// a takeover of that owner was never proven. The label is now accepted.
test("forge: a takeover of an `address payable` owner IS proven (payable type accepted, fixes the FN)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "PayOwned.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract PayOwned {
  address payable public owner;  // slot 0
  constructor() { owner = payable(msg.sender); }
  function setOwner(address payable o) external { owner = o; } // BUG: no access check
}
` }, "PayTest", `import "../src/PayOwned.sol";
contract PayTest is Test {
  PayOwned c;
  function setUp() public { c = new PayOwned(); }
  function test_takeover() public { vm.prank(address(0xBEEF)); c.setOwner(payable(address(0xBEEF))); assertEq(c.owner(), address(0xBEEF)); }
}
`);
  assert.equal(f.proof.harm.ok, true);
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});
