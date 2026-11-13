// The forge harm gate: a passing test is not a proof. A finding is proven only
// when its replay calls a contract deployed from the audited scope AND harms it,
// by ETH leaving it, an authenticated ERC-20 drain, or a control-slot takeover.
//
//   node --test spike/test/harm-gate.test.mjs
//
// The first tests are pure: synthetic traces in, verdict out. The last ones run
// real forge in Docker against the vault-reentrancy lab, and skip when the
// Foundry image is not present.
import "./helpers/isolated-env.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, id } from "ethers";
import { judgeHarm } from "../lib/proof.mjs";
import { extractControlTrace, word, HANDLED, TRUSTED_ACCOUNT, BACKSTOP_CLASSES, CHEAT_TABLE } from "../lib/control-trace.mjs";
import { gate, proveFindings } from "../lib/record.mjs";
import { isProven } from "../lib/proof-view.mjs";
import { formatAmount } from "../../app/src/lib/amount.mjs";
import { makeWorkspace, forgeTestJson } from "../lib/sandbox.mjs";
import contracts from "../packs/contracts/pack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// H1g: the engine shows harm amounts by the one shared rule (app/src/lib/amount.mjs),
// never cut. ethStr (proof.mjs), the txreplay and fork-proof detail formatters all
// route through formatAmount, and the exact wei is stored next to the text.
test("harm amounts use the shared formatter and are never cut (H1g)", () => {
  // the rule itself, on values the old 4-decimal cut would have mangled.
  assert.equal(formatAmount("10000000000000000000").text, "10 ETH");
  assert.equal(formatAmount("9945000000000000123").text, "≈9.945 ETH", "a non-round loss is marked, not cut");
  assert.equal(formatAmount("4200").text, "4,200 wei", "dust reads in wei, never 0 ETH");
  assert.equal(formatAmount("-1234500000000000000", { signed: true }).text, "-1.2345 ETH");
  // the engine sites import the shared formatter and keep no cutting formatter.
  for (const rel of ["lib/proof.mjs", "lib/txreplay-proof.mjs", "lib/fork-proof.mjs"]) {
    const src = readFileSync(path.join(HERE, "..", rel), "utf8");
    assert.match(src, /from "\.\.\/\.\.\/app\/src\/lib\/amount\.mjs"/, `${rel} imports the shared formatter`);
    assert.doesNotMatch(src, /10n \*\* 14n/, `${rel} still has a 4-decimal cut`);
  }
});


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

// H1d n2: the gate drops the target also for an etch in a frame that reverted.
// It does not trust that forge undid the code (fail closed). The ETH loss after
// it would prove if the etch were ignored.
test("harm gate: a target etched in a reverted frame is no longer a target (fail closed)", () => {
  const etch = "0xb4d6c782" + VAULT.slice(2).padStart(64, "0") + "40".padStart(64, "0") + "1".padStart(64, "0") + "00".padEnd(64, "0");
  const traces = [setup(), exec(
    node(0, { kind: "CALL", address: TEST, caller: TEST, success: false }),
    node(1, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST, data: etch }),
    node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" }),
    node(3, { kind: "CALL", address: ATTACKER, caller: VAULT, value: ONE }),
  )];
  const harm = verdict(traces);
  assert.equal(harm.ok, false);
  assert.match(harm.reason, /deployed no contract from the audited scope/);
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
  assert.equal(isProven({ ...base, proof: { kind: "forge", status: "pass", pass: true, harm: { ok: true, kind: "funds" } } }), true);
  // N3: a harm verdict of no known kind is not harm (fail closed).
  assert.equal(isProven({ ...base, proof: { kind: "forge", status: "pass", pass: true, harm: { ok: true } } }), false);
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

// H1d n3: the impersonation text must not hide the true cause. The test pranks
// scope target TOKEN (not the victim) and calls VAULT, which moves nothing. The
// reason names the prank AND keeps the base reason.
test("harm gate: the impersonation reason keeps the base reason after it (H1d n3)", () => {
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    prankNode(TOKEN),
    callVault(),
  ] }]];
  const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
  assert.equal(h.ok, false);
  assert.match(h.reason, new RegExp(`impersonated scope target ${TOKEN}`));
  assert.match(h.reason, /moved no ETH out of it and took over none of its control slots/);
});

// ---- H1b: cheatcode tamper of a scope target (synthetic) --------------------
//
// A real storage-channel drain of VAULT's balance in the scope token TOKEN ("Ext",
// balance base slot 0). `tamper` is a VM call placed before the drain. Without it
// the drain is proven; with a tamper of TOKEN it must not be.
const VM_ADDR = "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d";
const tamperDrain = (tamper, { reverted = false } = {}) => {
  const arena = [node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" })];
  if (tamper) {
    if (reverted) arena.push(node(0, { kind: "CALL", address: TEST, caller: TEST, success: false }));
    arena.push(node(reverted ? 1 : 0, { kind: "CALL", address: VM_ADDR, caller: TEST, data: tamper }));
  }
  arena.push(callVault(), logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [transferLog(VAULT, ATTACKER, ONE)]));
  return [setup(createToken()), ["Execution", { arena }]];
};
const tokenBalances = new Map([["Ext", [word("0x0")]]]);
const judgeTamper = (traces, balances = tokenBalances) => emptyMaps(traces, { scope: TOKEN_SCOPE, balances });
const storeData = (target, slot) => id("store(address,bytes32,bytes32)").slice(0, 10) + word(target).slice(2) + word(slot).slice(2) + word(ONE).slice(2);
const tamperReason = /the test set the state of scope target .*0x0{38}aa \(Ext\) via vm\.\w+.*cannot be the source of proven harm.*Without that target:/;

test("harm gate: the tamper base case (no cheatcode) is a proven token drain (H1b)", () => {
  const h = judgeTamper(tamperDrain(null));
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.victim, VAULT);
});

// Every recorded cheatcode, with the scope token as the address it acts on.
const TAMPER_CASES = [
  ["store(address,bytes32,bytes32)", word(TOKEN).slice(2) + word("0x1").slice(2) + word(ONE).slice(2)],
  ["copyStorage(address,address)", word(ATTACKER).slice(2) + word(TOKEN).slice(2)],
  ["setArbitraryStorage(address)", word(TOKEN).slice(2)],
  ["setArbitraryStorage(address,bool)", word(TOKEN).slice(2) + word("0x1").slice(2)],
  ...["mockCall", "mockCallRevert"].flatMap((n) => [`${n}(address,bytes,bytes)`, `${n}(address,uint256,bytes,bytes)`, `${n}(address,bytes4,bytes)`, `${n}(address,uint256,bytes4,bytes)`])
    .map((sig) => [sig, word(TOKEN).slice(2) + word("0x0").repeat(3).replace(/0x/g, "")]),
  ["mockCalls(address,bytes,bytes[])", word(TOKEN).slice(2) + word("0x0").repeat(2).replace(/0x/g, "")],
  ["mockCalls(address,uint256,bytes,bytes[])", word(TOKEN).slice(2) + word("0x0").repeat(3).replace(/0x/g, "")],
  ["loadAllocs(string)", word("0x20").slice(2) + word("0x0").slice(2)],
  ["setNonce(address,uint64)", word(TOKEN).slice(2) + word("0x5").slice(2)],
  ["setNonceUnsafe(address,uint64)", word(TOKEN).slice(2) + word("0x5").slice(2)],
  ["resetNonce(address)", word(TOKEN).slice(2)],
];
for (const [sig, args] of TAMPER_CASES) {
  test(`harm gate: a drain after ${sig} on the scope token is not proven, also in a reverted frame (H1b)`, () => {
    for (const reverted of [false, true]) {
      const h = judgeTamper(tamperDrain(id(sig).slice(0, 10) + args, { reverted }));
      assert.equal(h.ok, false, `${sig} reverted=${reverted}: ${JSON.stringify(h)}`);
      assert.match(h.reason, tamperReason);
    }
  });
}

// H1f B: tokens an exempt funding store put on the victim are the test's own. A
// take by the test side is not a loss; a take by the attacker EOA still is (below).
test("harm gate: tokens a funding deal() put on the vault, taken back by the test, are not a loss (H1f B)", () => {
  const traces = tamperDrain(storeData(TOKEN, balSlot(VAULT)));
  traces[1][1].arena.at(-1).logs = [transferLog(VAULT, TEST, ONE)];
  const h = judgeTamper(traces);
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, /no address took out more than it had put in/);
});

// A drop the body's logs do not cover has no recipient: it stays counted. Here the
// slot drops by 2 ether and the only body log returns 1 ether to ALICE, who put 1
// in during setUp(): the matched ether nets to 0, the unmatched ether counts.
test("harm gate: the part of a balance drop no Transfer log covers stays counted (H1f B)", () => {
  const traces = [setup(createToken(), logged(0, { kind: "CALL", address: TOKEN, caller: TEST }, [transferLog(ALICE, VAULT, ONE)])), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), TWO, "0x0")] }, [transferLog(VAULT, ALICE, ONE)]),
  ] }]];
  const h = judgeTamper(traces);
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.lostUnits, "1000000000000000000");
});

test("harm gate: the netted token loss is never more than the balance drop (H1f B)", () => {
  const traces = [setup(createToken()), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [transferLog(VAULT, BOB, TWO)]),
  ] }]];
  const h = judgeTamper(traces);
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.lostUnits, "1000000000000000000");
});

test("harm gate: a token deposit log in a reverted frame puts nothing in (H1f B)", () => {
  const traces = [setup(createToken(),
    node(0, { kind: "CALL", address: TEST, caller: TEST, success: false }),
    logged(3, { kind: "CALL", address: TOKEN, caller: TEST }, [transferLog(ALICE, VAULT, ONE)]),
  ), ["Execution", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
    callVault(),
    logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [transferLog(VAULT, ALICE, ONE)]),
  ] }]];
  const h = judgeTamper(traces);
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.lostUnits, "1000000000000000000");
});

// The one exempt store: forge-std deal(token, holder, x) writes the token's
// balance slot for `holder`. When the holder is a scope target (it funds the
// victim), the drain stays proven. Every other holder, or a token with no known
// balance layout, is refused (fail closed).
test("harm gate: a store of a scope token's balance slot for a scope holder is a fixture; the drain stays proven (H1b)", () => {
  const h = judgeTamper(tamperDrain(storeData(TOKEN, balSlot(VAULT))));
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.victim, VAULT);
});

test("harm gate: a store of a scope token's balance slot for the attacker is refused (H1b)", () => {
  const h = judgeTamper(tamperDrain(storeData(TOKEN, balSlot(ATTACKER))));
  assert.equal(h.ok, false);
  assert.match(h.reason, tamperReason);
});

test("harm gate: a balance-slot store on a token with no known balance layout is refused (H1b)", () => {
  const h = judgeTamper(tamperDrain(storeData(TOKEN, balSlot(VAULT))), new Map());
  assert.equal(h.ok, false);
  assert.match(h.reason, tamperReason);
});

// ---- H1f (A), the neighbours (synthetic) ----------------------------------------
const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";
const TESTKIT = "0x0000000000000000000000000000000000001e1f"; // a non-scope contract the test deploys
const TWO = "0x1bc16d674ec80000"; // 2 ether
const pay = (parent, to, value) => node(parent, { kind: "CALL", address: to, caller: VAULT, value });
const withdrawCall = () => node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b" });
const vmCall = (sig, args) => node(0, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST, data: id(sig).slice(0, 10) + args });
const returnedReason = /ETH or tokens left scope target 0x[0-9a-f]{40} \(\w+\) in the test body, but no address took out more than it had put in/;

test("harm gate: a setUp() deposit by A and a withdraw paid to B counts: pranked addresses are separate parties (H1f)", () => {
  // The gate cannot tell an attacker address from an honest user. It assumes two
  // addresses are two parties; B put nothing in, so B's take is the loss.
  const traces = [setup(node(0, { kind: "CALL", address: VAULT, caller: ALICE, value: ONE })), exec(withdrawCall(), pay(1, BOB, ONE))];
  const h = verdict(traces);
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.lostWei, "1000000000000000000");
});

test("harm gate: the test contract and the contracts it deployed are one party: a deposit by one and a take by the other is returned (H1f)", () => {
  const traces = [setup(
    node(0, { kind: "CREATE", address: TESTKIT, caller: TEST, data: "0x60016001" }),
    node(0, { kind: "CALL", address: VAULT, caller: TESTKIT, value: ONE }),
  ), exec(withdrawCall(), pay(1, TEST, ONE))];
  const h = verdict(traces);
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, returnedReason);
});

test("harm gate: the loss is never more than the body net (monotone): a body deposit by A and a take of 2 by B is 1 (H1f)", () => {
  const traces = [setup(), exec(
    node(0, { kind: "CALL", address: VAULT, caller: ALICE, value: ONE }),
    withdrawCall(),
    pay(2, BOB, TWO),
  )];
  const h = verdict(traces);
  assert.equal(h.ok, true);
  assert.equal(h.lostWei, "1000000000000000000");
});

test("harm gate: ETH sent with the vault's CREATE is put in by its creator; taking it back is returned (H1f)", () => {
  const traces = [["Setup", { arena: [
    node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x0a9254e4" }),
    node(0, { kind: "CREATE", address: VAULT, caller: TEST, data: VAULT_INIT, value: ONE }),
  ] }], exec(withdrawCall(), pay(1, TEST, ONE))];
  const h = verdict(traces);
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, returnedReason);
});

test("harm gate: a deposit in a reverted frame puts nothing in; the take still counts (H1f)", () => {
  const traces = [setup(
    node(0, { kind: "CALL", address: TEST, caller: TEST, success: false }),
    node(2, { kind: "CALL", address: VAULT, caller: ALICE, value: ONE }), // under the reverted frame (index 2)
  ), exec(withdrawCall(), pay(1, ALICE, ONE))];
  const h = verdict(traces);
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.lostWei, "1000000000000000000");
});

// ETH that reaches the vault without a value CALL from the test: vm.deal, vm.coinbase,
// or a selfdestruct of a test contract (the trace does not name the beneficiary).
// It counts as the test's own: the test side's take is not a loss. A take by another
// address (here the attacker EOA) still counts.
for (const [label, extra] of [
  ["vm.deal on the vault", () => [vmCall("deal(address,uint256)", word(VAULT).slice(2) + word(ONE).slice(2))]],
  ["vm.coinbase set to the vault", () => [vmCall("coinbase(address)", word(VAULT).slice(2))]],
  ["a selfdestruct of a test contract", () => [
    node(0, { kind: "CREATE", address: TESTKIT, caller: TEST, data: "0x60016001", value: ONE }),
    node(0, { kind: "CALL", address: TESTKIT, caller: TEST, data: "0x12345678", status: "SelfDestruct" }),
  ]],
]) {
  test(`harm gate: ETH put on the vault by ${label} is the test's own: the test's take is not a loss, an outsider's is (H1f)`, () => {
    const mine = verdict([setup(...extra()), exec(withdrawCall(), pay(1, TEST, ONE))]);
    assert.equal(mine.ok, false, JSON.stringify(mine));
    assert.match(mine.reason, returnedReason);
    const theirs = verdict([setup(...extra()), exec(withdrawCall(), pay(1, ATTACKER, ONE))]);
    assert.equal(theirs.ok, true, JSON.stringify(theirs));
    assert.equal(theirs.lostWei, "1000000000000000000");
  });
}

// ---- H1e (1): the backstop, from the classified table lib/vm-cheatcodes.json --------
const CHEAT_ROWS = JSON.parse(readFileSync(path.join(HERE, "../lib/vm-cheatcodes.json"), "utf8"));
const firstOf = (cls) => CHEAT_ROWS.find((r) => r.class === cls);
const vmData = (row) => row.selector + "00".repeat(64);
const backstopReason = /the test used .*; after it the replay trace no longer tells what really happened, so no scope target counts\. To repair: /;

for (const cls of ["state", "exec", "fork"]) {
  test(`harm gate: a ${cls} cheatcode (${firstOf(cls).name}) makes every scope target unusable, in the body or in setUp() (H1e backstop)`, () => {
    const row = firstOf(cls);
    const h = judgeTamper(tamperDrain(vmData(row)));
    assert.equal(h.ok, false, JSON.stringify(h));
    assert.match(h.reason, backstopReason);
    assert.match(h.reason, new RegExp(`vm\\.${row.name} \\(${cls}, in body\\)`));
    const inSetup = tamperDrain(null);
    inSetup[0][1].arena.push(node(0, { kind: "CALL", address: VM_ADDR, caller: TEST, data: vmData(row) }));
    const hs = judgeTamper(inSetup);
    assert.equal(hs.ok, false);
    assert.match(hs.reason, new RegExp(`vm\\.${row.name} \\(${cls}, in setUp\\)`));
  });
}

// outcome (expectRevert, expectPartialRevert) is trusted: the trace marks the
// expected call as reverted. The guard: the call it was armed for (the first later
// non-VM call at most as deep) must be a reverted frame.
const expectDrain = (armedSucceeds, { between = false, none = false } = {}) => {
  const row = CHEAT_ROWS.find((r) => r.signature === "expectRevert()");
  const arena = [node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" })];
  arena.push(callVault(), logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [transferLog(VAULT, ATTACKER, ONE)]));
  arena.push(node(0, { kind: "CALL", address: VM_ADDR, caller: TEST, data: row.selector }));
  if (between) arena.push(node(0, { kind: "CALL", address: VM_ADDR, caller: TEST, data: "0xca669fa7" + word(ALICE).slice(2) }));
  if (!none) arena.push(node(0, { kind: "CALL", address: VAULT, caller: TEST, data: "0x3ccfd60b", success: armedSucceeds }));
  return [setup(createToken()), ["Execution", { arena }]];
};
const guardReason = /vm\.expectRevert \(in body\), but the trace shows no reverted call for it to expect/;

test("harm gate: expectRevert armed for a reverted call is trusted: the drain before it stays proven (H1e outcome trusted)", () => {
  for (const between of [false, true]) {
    const h = judgeTamper(expectDrain(false, { between }));
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(h.victim, VAULT);
  }
});

test("harm gate: expectRevert armed for a call the trace shows as successful makes every scope target unusable (H1e guard)", () => {
  const h = judgeTamper(expectDrain(true));
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, guardReason);
});

test("harm gate: expectRevert with no call after it makes every scope target unusable (H1e guard)", () => {
  const h = judgeTamper(expectDrain(false, { none: true }));
  assert.equal(h.ok, false, JSON.stringify(h));
  assert.match(h.reason, guardReason);
});

test("harm gate: vm.broadcastRawTransaction makes every scope target unusable (H1e backstop)", () => {
  const row = CHEAT_ROWS.find((r) => r.name === "broadcastRawTransaction");
  const h = judgeTamper(tamperDrain(vmData(row)));
  assert.equal(h.ok, false);
  assert.match(h.reason, /vm\.broadcastRawTransaction \(account, in body\).*the gate has no rule for this cheatcode/);
});

test("harm gate: a VM call with a selector the table does not know makes every scope target unusable, and the reason names it (H1e backstop)", () => {
  assert.ok(!CHEAT_ROWS.some((r) => r.selector === "0xdeadbeef"));
  const h = judgeTamper(tamperDrain("0xdeadbeef" + "00".repeat(32)));
  assert.equal(h.ok, false);
  assert.match(h.reason, /the unknown cheatcode 0xdeadbeef \(in body\).*use only the cheatcodes of the pinned forge-std Vm\.sol/);
  // Also when the call sits in a frame that reverted.
  const r = judgeTamper(tamperDrain("0xdeadbeef" + "00".repeat(32), { reverted: true }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /the unknown cheatcode 0xdeadbeef/);
});

for (const cls of ["read", "control", "time", "fs"]) {
  test(`harm gate: a ${cls} cheatcode (${firstOf(cls).name}) is trusted: the drain stays proven (H1e backstop)`, () => {
    const h = judgeTamper(tamperDrain(vmData(firstOf(cls))));
    assert.equal(h.ok, true, JSON.stringify(h));
  });
}

// Minor 5: the runtime is an allow-list. A table that gains a class, or an account
// entry no rule reads, is refused at runtime, not only by the coverage test.
for (const [label, row] of [
  ["a class the gate does not know", { selector: "0x11111111", name: "brandNew", signature: "brandNew()", class: "brandnew" }],
  ["an account entry with no rule", { selector: "0x22222222", name: "setSomething", signature: "setSomething(address)", class: "account" }],
]) {
  test(`harm gate: ${label} in the table is refused at runtime (H1e allow-list)`, () => {
    const table = new Map([...CHEAT_TABLE, [row.selector, { name: row.name, signature: row.signature, class: row.class }]]);
    const traces = tamperDrain(row.selector + "00".repeat(32));
    const h = judgeHarm(traces, { scope: TOKEN_SCOPE, controlTrace: extractControlTrace(traces, { cheatTable: table }), layouts: new Map(), balances: tokenBalances });
    assert.equal(h.ok, false, JSON.stringify(h));
    assert.match(h.reason, new RegExp(`vm\\.${row.name} \\(${row.class}, in body\\).*the gate has no rule for this cheatcode`));
  });
}

test("harm gate: with the cheatcode table missing, nothing is proven (H1e backstop)", () => {
  const traces = tamperDrain(null);
  const h = judgeHarm(traces, { scope: TOKEN_SCOPE, controlTrace: extractControlTrace(traces, { cheatTable: null }), layouts: new Map(), balances: tokenBalances });
  assert.equal(h.ok, false);
  assert.match(h.reason, /cheatcode table \(spike\/lib\/vm-cheatcodes\.json\) is missing or does not parse/);
});

// Every class of the table has a decision here, and every account or mock entry is
// handled by a rule, trusted with a reason, or a backstop name. A forge-std upgrade
// that adds a class or such an entry fails this test until someone decides.
test("backstop: every class and every account/mock cheatcode of the table has a decision (H1e)", () => {
  const DECIDED = new Set(["read", "control", "time", "fs", "account", "mock", "outcome", ...BACKSTOP_CLASSES]);
  assert.equal(BACKSTOP_CLASSES.has("outcome"), false, "outcome is trusted, with the armed-call guard");
  assert.deepEqual([...new Set(CHEAT_ROWS.map((r) => r.class))].filter((c) => !DECIDED.has(c)), []);
  const open = CHEAT_ROWS.filter((r) => (r.class === "account" || r.class === "mock")
    && !HANDLED.has(r.selector.toLowerCase()) && !TRUSTED_ACCOUNT.has(r.signature) && r.name !== "broadcastRawTransaction");
  assert.deepEqual(open.map((r) => r.signature), []);
  assert.equal(CHEAT_TABLE?.size, CHEAT_ROWS.length);
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

// Review 2, "not checked": prank(sender, origin) also sets tx.origin. A scope
// contract can never be a real tx.origin, so an origin prank AS the victim is a
// forgery too, even when msg.sender is the attacker.
for (const sig of IMPERSONATION_SIGS.filter((s) => s.includes("(address,address"))) {
  test(`harm gate: a token drain where the test pranks the victim as tx.origin via ${sig} is not proven`, () => {
    const log = transferLog(VAULT, ATTACKER, ONE);
    const bool = sig.endsWith(",bool)") ? word("0x0").slice(2) : "";
    const traces = [setup(createToken()), ["Execution", { arena: [
      node(null, { kind: "CALL", address: TEST, caller: ATTACKER, data: "0x12345678" }),
      node(0, { kind: "CALL", address: "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", caller: TEST,
        data: id(sig).slice(0, 10) + word(ATTACKER).slice(2) + word(VAULT).slice(2) + bool }),
      callVault(),
      logged(0, { kind: "CALL", address: TOKEN, caller: TEST, steps: [sstore(balSlot(VAULT), ONE, "0x0")] }, [log]),
    ] }]];
    const h = emptyMaps(traces, { scope: TOKEN_SCOPE });
    assert.equal(h.ok, false, `${sig} origin impersonation must not be a proof`);
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

const makeWs = () => { const ws = makeWorkspace(LAB); workspaces.push(ws); return ws; };

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

// True positives, review 2: the impersonation rules must not over-fire. A real
// PoC pranks the ATTACKER (here also as tx.origin). Each shape must still prove
// the full drain, with the exact value.
for (const arm of ["vm.prank(address(0xBEEF))", "vm.startPrank(address(0xBEEF))",
  "vm.prank(address(0xBEEF), address(0xBEEF))", "vm.startPrank(address(0xBEEF), address(0xBEEF))"]) {
  test(`forge: an attacker drain after ${arm} is STILL proven with its exact value (review 2 TP)`, { skip, timeout: 300_000 }, async () => {
    const ws = makeWorkspace(LAB); workspaces.push(ws);
    const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "AttackerPrankTest", `import "../src/Tokens.sol";
contract AttackerPrankTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100e18); }
  function test_x() public { ${arm}; vault.withdraw(100e18); assertEq(tok.balanceOf(address(0xBEEF)), 100e18); }
}
`);
    assert.equal(f.forgePassed, true);
    assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
    assert.equal(f.proof.harm.asset, "token");
    assert.equal(f.proof.harm.lostUnits, "100000000000000000000");
    assert.equal(isProven(f), true);
  });
}

test("forge: the real lab ETH drain is STILL proven with its exact value (review 2 TP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await prove(ws, "VaultExploitTest", readFileSync(path.join(LAB, "oracle/VaultExploit.t.sol"), "utf8"));
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.lostWei, "10000000000000000000"); // the honest deposits: 4 + 3 + 3 ether
  assert.equal(isProven(f), true);
});

// H1e minor 2: a stray vm.deal on the victim must not drop a real drain. The dealt
// balance is credited to the test party as "put in", not the party's whole take. The
// lab drain with an extra vm.deal(address(vault), 1) stays proven; the 1 wei it adds
// is the test's own, so the loss is the 10 ether the honest users put in (± that wei).
const OPEN_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Vault {
  mapping(address => uint256) public balanceOf;
  function deposit() external payable { balanceOf[msg.sender] += msg.value; }
  function withdraw(uint256 a) external { (bool ok,) = msg.sender.call{value: a}(""); require(ok, "x"); } // BUG: no balance check
  function totalAssets() external view returns (uint256) { return address(this).balance; }
}
`;
// A test-deployed contract (the test party) drains the vault, which an honest pranked
// user funded with 10 ether and the test dealt a stray 1 wei. The strict rule dropped
// the whole test-party take, losing the 10 ether. Crediting only the dealt 1 wei as
// "put in" keeps the 10 ether proven.
test("forge: a stray vm.deal on the victim does not drop a real drain by a test contract (H1e minor 2)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Vault.sol": OPEN_VAULT }, "StrayDealTest", `import "../src/Vault.sol";
contract Drainer { function go(Vault v, uint256 a) external { v.withdraw(a); } receive() external payable {} }
contract StrayDealTest is Test {
  Vault v; Drainer d; address alice = makeAddr("alice");
  function setUp() public {
    v = new Vault(); d = new Drainer();
    vm.deal(address(v), 1); // stray: the test's own 1 wei (set before the deposit; vm.deal sets the balance)
    vm.deal(alice, 10 ether); vm.prank(alice); v.deposit{value: 10 ether}();
  }
  function test_x() public { d.go(v, 10 ether + 1); assertEq(address(d).balance, 10 ether + 1); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.lostWei, "10000000000000000000"); // the honest 10 ether; the dealt 1 wei is the test's own
  assert.equal(isProven(f), true);
});

// The other side: when the deal funds the WHOLE take, nothing is proven. The test
// deals 1 ether to the vault and a test-side contract takes exactly that 1 ether out.
// Credited as put in, the test party's excess is 0.
test("forge: a drain of only what vm.deal funded is NOT proven (H1e minor 2)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Open.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Open { function take(address payable to, uint256 a) external { to.transfer(a); } receive() external payable {} }
` }, "DealTakeTest", `import "../src/Open.sol";
contract Sink { receive() external payable {} }
contract DealTakeTest is Test {
  Open o; Sink s;
  function setUp() public { o = new Open(); s = new Sink(); vm.deal(address(o), 1 ether); }
  function test_x() public { o.take(payable(address(s)), 1 ether); assertEq(address(s).balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.equal(isProven(f), false);
});

// H1c: a forge-std deal(token, …) in the test BODY makes a replay trace above the
// 8 MiB cap (about 10 MiB on the pinned image). The cut trace is never judged; the
// proof fails and the reason tells the agent to move deal into setUp(). The same
// drain with deal in setUp() stays small and is proven with its exact value.
const DEAL_DRAIN = (poc, setupDeal) => `import "../src/Tokens.sol";
contract ${poc} is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); ${setupDeal ? "deal(address(tok), address(vault), 100e18);" : ""} }
  function test_x() public {
    ${setupDeal ? "" : "deal(address(tok), address(vault), 100e18);"}
    vm.prank(address(0xBEEF)); vault.withdraw(100e18);
    assertEq(tok.balanceOf(address(0xBEEF)), 100e18);
  }
}
`;
test("forge: a deal() in the test body makes a trace above the cap; it is not judged and the reason says use setUp() (H1c)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "DealBodyTest", DEAL_DRAIN("DealBodyTest", false));
  assert.equal(f.forgePassed, true);
  assert.ok(f.proof, "a cut trace still gives a failed proof with a reason, not null");
  assert.equal(f.proof.pass, false);
  assert.equal(f.proof.harm.ok, false);
  assert.match(f.proof.harm.reason, /larger than 8 MiB, so it was cut and the gate does not judge it.*use deal in setUp\(\) only to fund a scope contract.*get the attacker's tokens through the protocol, or use a token outside the scope/);
  assert.equal(isProven(f), false);
});

test("forge: the same drain with deal() in setUp() is STILL proven with its exact value (H1c TP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": TOKENS }, "DealSetupTest", DEAL_DRAIN("DealSetupTest", true));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.asset, "token");
  assert.equal(f.proof.harm.lostUnits, "100000000000000000000");
  assert.equal(isProven(f), true);
});

// H1b known losses (honest shapes the tamper rule now refuses, like fnsetup). Both
// are forge-std deal() fixtures that write a scope token's storage beyond funding a
// scope contract: deal to the attacker (its balance slot), and deal(…, true) (it
// also writes totalSupply). The gate cannot tell these from a forged credit, so it
// fails closed; the reason tells the agent how to restructure.
const TS_TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  uint256 public totalSupply;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
}
contract TokVault {
  Tok public tok;
  constructor(Tok t) { tok = t; }
  function withdraw(uint256 a) external { tok.transfer(msg.sender, a); } // BUG: anyone drains it
}
`;
for (const [label, extra] of [
  ["deal() that funds the attacker", "deal(address(tok), address(vault), 100e18); deal(address(tok), address(0xBEEF), 1e18);"],
  ["deal(…, true) that also writes totalSupply", "deal(address(tok), address(vault), 100e18, true);"],
]) {
  test(`forge: an honest ${label} in setUp() is refused with the tamper reason (H1b known loss)`, { skip, timeout: 300_000 }, async () => {
    const ws = makeWorkspace(LAB); workspaces.push(ws);
    const f = await proveScope(ws, { "Tokens.sol": TS_TOKENS }, "DealFixTest", `import "../src/Tokens.sol";
contract DealFixTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); ${extra} }
  function test_x() public { vm.prank(address(0xBEEF)); vault.withdraw(100e18); assertGe(tok.balanceOf(address(0xBEEF)), 100e18); }
}
`);
    assert.equal(f.forgePassed, true);
    assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
    assert.match(f.proof.harm.reason, /the test set the state of scope target 0x[0-9a-f]{40} \(Tok\) via vm\.store;.*A deal\(\) that funds a scope contract's token balance is counted as the test's own/);
    assert.equal(isProven(f), false);
  });
}

// H1e (4): forge-std stdstore ends in vm.store, so a stdstore write on a scope
// target is refused like vm.store. Honest shape (a known loss, not a forgery): the
// fixture sets an unrelated config slot of the scope vault; the drain is the
// vault's real withdraw bug.
const FEE_TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
}
contract TokVault {
  Tok public tok;
  uint256 public fee; // config only; withdraw ignores it
  constructor(Tok t) { tok = t; }
  function withdraw(uint256 a) external { tok.transfer(msg.sender, a); } // BUG: anyone drains it
}
`;
test("forge: a stdstore fixture on a scope contract is refused with the tamper reason (H1e stdstore)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": FEE_TOKENS }, "StdStoreFixTest", `import "../src/Tokens.sol";
contract StdStoreFixTest is Test {
  using stdStorage for StdStorage;
  Tok tok; TokVault vault;
  function setUp() public {
    tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100);
    stdstore.target(address(vault)).sig("fee()").checked_write(uint256(5));
  }
  function test_x() public {
    assertEq(vault.fee(), 5);
    vm.prank(address(0xBEEF)); vault.withdraw(100);
    assertEq(tok.balanceOf(address(0xBEEF)), 100);
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, /the test set the state of scope target 0x[0-9a-f]{40} \(TokVault\) via vm\.store;/);
  assert.equal(isProven(f), false);
});

// ---- H1f (A): the ETH loss is net per counterparty ------------------------------
//
// A setUp() deposit and the same address's own withdraw in the body moved ETH out
// of the vault, and the old body-only net read it as a drain. Now a loss counts
// only as what an address took out beyond what it put in, across setUp() and the
// body. Honest shapes only: none of these is an attack.
const RETURN_REASON = /ETH or tokens left scope target 0x[0-9a-f]{40} \(Vault\) in the test body, but no address took out more than it had put in.*Taking back a deposit is not a drain/;

test("forge: a setUp() deposit and the same user's own withdraw in the body is NOT proven (H1f)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Vault.sol": LAB_VAULT }, "OwnWithdrawTest", `import "../src/Vault.sol";
contract OwnWithdrawTest is Test {
  Vault v; address alice = makeAddr("alice");
  function setUp() public { v = new Vault(); vm.deal(alice, 1 ether); vm.prank(alice); v.deposit{value: 1 ether}(); }
  function test_x() public { vm.prank(alice); v.withdraw(); assertEq(alice.balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, RETURN_REASON);
  assert.equal(isProven(f), false);
});

test("forge: the test contract's own setUp() deposit and withdraw is NOT proven (H1f)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Vault.sol": LAB_VAULT }, "SelfWithdrawTest", `import "../src/Vault.sol";
contract SelfWithdrawTest is Test {
  Vault v;
  receive() external payable {}
  function setUp() public { v = new Vault(); vm.deal(address(this), 1 ether); v.deposit{value: 1 ether}(); }
  function test_x() public { v.withdraw(); assertEq(address(this).balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, RETURN_REASON);
  assert.equal(isProven(f), false);
});

// The lab reentrancy with the attacker's 1 ether deposit moved into setUp(): the old
// body-only net saw 11 ether leave. The attacker put 1 in, so the loss is the excess,
// 10 ether: the same value as the tracked lab true positive.
test("forge: a depositor that takes out more than it put in loses only the excess (H1f TP)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Vault.sol": LAB_VAULT }, "SplitReentryTest", `import "../src/Vault.sol";
contract Reenter {
  Vault public vault; uint256 public unit;
  constructor(Vault v) { vault = v; }
  function seed() external payable { unit = msg.value; vault.deposit{value: msg.value}(); }
  function go() external { vault.withdraw(); }
  receive() external payable { if (address(vault).balance >= unit) vault.withdraw(); }
}
contract SplitReentryTest is Test {
  Vault v; Reenter r;
  function setUp() public {
    v = new Vault();
    address alice = makeAddr("alice"); address bob = makeAddr("bob"); address carol = makeAddr("carol");
    vm.deal(alice, 4 ether); vm.deal(bob, 3 ether); vm.deal(carol, 3 ether);
    vm.prank(alice); v.deposit{value: 4 ether}();
    vm.prank(bob); v.deposit{value: 3 ether}();
    vm.prank(carol); v.deposit{value: 3 ether}();
    r = new Reenter(v); vm.deal(address(this), 1 ether); r.seed{value: 1 ether}();
  }
  function test_x() public { r.go(); assertEq(v.totalAssets(), 0); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.lostWei, "10000000000000000000");
  assert.equal(isProven(f), true);
});

// ---- H1f (B): the token loss is net per counterparty -----------------------------
// Each balance-slot drop gets its recipient from the token's own Transfer logs and
// is netted against what that recipient put in, across setUp() and the body.
const DEPOSIT_TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
  function transferFrom(address f, address to, uint256 a) public returns (bool) {
    allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); return true;
  }
}
contract TokVault {
  Tok public tok; mapping(address => uint256) public credit;
  constructor(Tok t) { tok = t; }
  function deposit(uint256 a) external { tok.transferFrom(msg.sender, address(this), a); credit[msg.sender] += a; }
  // BUG: checks that the caller has a credit, not that it covers the amount.
  function withdraw(uint256 a) external { require(credit[msg.sender] > 0, "none"); credit[msg.sender] = 0; tok.transfer(msg.sender, a); }
}
`;
const TOKEN_RETURNED = /ETH or tokens left scope target 0x[0-9a-f]{40} \(TokVault, token 0x[0-9a-f]{40}\) in the test body, but no address took out more than it had put in/;
const depositTest = (poc, body) => `import "../src/Tokens.sol";
contract ${poc} is Test {
  Tok tok; TokVault vault;
  address alice = makeAddr("alice"); address bob = makeAddr("bob");
  function put(address who, uint256 a) internal { tok.mint(who, a); vm.startPrank(who); tok.approve(address(vault), a); vault.deposit(a); vm.stopPrank(); }
  ${body}
}
`;

test("forge: a user's own token deposit in setUp() and its own withdraw is NOT proven (H1f B)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Tokens.sol": DEPOSIT_TOKENS }, "OwnTokenTest", depositTest("OwnTokenTest", `
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); put(alice, 100); }
  function test_x() public { vm.prank(alice); vault.withdraw(100); assertEq(tok.balanceOf(alice), 100); }`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, TOKEN_RETURNED);
  assert.equal(isProven(f), false);
});

test("forge: the test contract's own token deposit and withdraw is NOT proven (H1f B)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Tokens.sol": DEPOSIT_TOKENS }, "SelfTokenTest", depositTest("SelfTokenTest", `
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(this), 100); tok.approve(address(vault), 100); vault.deposit(100); }
  function test_x() public { vault.withdraw(100); assertEq(tok.balanceOf(address(this)), 100); }`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, TOKEN_RETURNED);
  assert.equal(isProven(f), false);
});

test("forge: a token depositor that takes out more than it put in loses only the excess (H1f B TP)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Tokens.sol": DEPOSIT_TOKENS }, "OverTokenTest", depositTest("OverTokenTest", `
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); put(alice, 100); put(bob, 100); }
  function test_x() public { vm.prank(alice); vault.withdraw(200); assertEq(tok.balanceOf(alice), 200); }`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.asset, "token");
  assert.equal(f.proof.harm.lostUnits, "100");
  assert.equal(isProven(f), true);
});

// ---- H1e ruling: outcome (expectRevert) is trusted; pinned on real forge ---------
// The harm channels read the TRACE. Under vm.expectRevert the expected call is a
// reverted frame in the trace, whatever the test sees, so its value calls, balance
// writes, Transfer logs and owner writes are not counted. One test per channel, with
// honest shapes (a scope function that does its work, then reverts). Each asserts
// the gate's verdict AND the frame status it relies on, so a forge upgrade that
// changes either fails here.
const LATE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Payer {
  address public owner;
  constructor() payable { owner = msg.sender; }
  function payThenFail(address payable to) external { to.transfer(1 ether); revert("late"); }
  function setOwnerThenFail(address o) external { owner = o; revert("late"); }
}
contract Tok {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; emit Transfer(msg.sender, to, a); return true; }
}
contract Led {
  mapping(address => uint256) public ledger; // a name the storage channel does not track: the log channel judges it
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { ledger[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) { ledger[msg.sender] -= a; ledger[to] += a; emit Transfer(msg.sender, to, a); return true; }
}
contract TokVault {
  Tok public tok; Led public led;
  constructor(Tok t, Led l) { tok = t; led = l; }
  function payOutThenFail(address to, uint256 a) external { tok.transfer(to, a); revert("late"); }
  function payLedThenFail(address to, uint256 a) external { led.transfer(to, a); revert("late"); }
}
`;
const LATE_HEAD = `import "../src/Late.sol";
contract LateTest is Test {
  Payer p; Tok tok; Led led; TokVault vault;
  function setUp() public {
    p = new Payer(); vm.deal(address(p), 1 ether); // not new Payer{value: …}(): see the deployCode test below
    tok = new Tok(); led = new Led(); vault = new TokVault(tok, led);
    tok.mint(address(vault), 100); led.mint(address(vault), 100);
  }
`;
// The frame of the expected call, read from the raw replay trace of the same workspace.
async function expectedFrame(ws, selector) {
  const { raw } = await forgeTestJson(ws, { matchContract: "LateTest", stateTrace: true });
  const r = Object.values(Object.values(JSON.parse(raw))[0].test_results)[0];
  const arena = r.traces.find(([k]) => k === "Execution")[1].arena;
  const hit = arena.filter((n) => String(n.trace.data).startsWith(selector));
  assert.equal(hit.length, 1, "one expected call in the body");
  return hit[0].trace;
}
// Judged on the trace alone: the base reason, never the backstop or the guard. The
// body first makes a successful view call into the scope contracts, so the gate
// reaches every harm channel and judges the reverted call there.
const BASE_REASON = /^the test called a scope target but moved no ETH out of it and took over none of its control slots/;
for (const [channel, body, sig] of [
  ["an ETH value call", `vm.expectRevert(bytes("late")); p.payThenFail(payable(address(0xBEEF)));`, "payThenFail(address)"],
  ["a token transfer (storage channel)", `vm.expectRevert(bytes("late")); vault.payOutThenFail(address(0xBEEF), 100);`, "payOutThenFail(address,uint256)"],
  ["a token transfer (Transfer-log channel)", `vm.expectRevert(bytes("late")); vault.payLedThenFail(address(0xBEEF), 100);`, "payLedThenFail(address,uint256)"],
  // An outsider writes the owner, so a counted write would be a takeover.
  ["an owner write (control channel)", `vm.expectRevert(bytes("late")); vm.prank(address(0xBEEF)); p.setOwnerThenFail(address(0xBEEF));`, "setOwnerThenFail(address)"],
  ["a low-level ETH call the test sees as a success", `vm.expectRevert(bytes("late")); (bool ok,) = address(p).call(abi.encodeWithSignature("payThenFail(address)", address(0xBEEF))); assertTrue(ok, "the test sees success");`, "payThenFail(address)"],
]) {
  test(`forge: ${channel} that reverts under vm.expectRevert is not counted, and its frame is reverted (H1e outcome trusted)`, { skip, timeout: 300_000 }, async () => {
    const ws = makeWs();
    const f = await proveScope(ws, { "Late.sol": LATE }, "LateTest", LATE_HEAD + `  function test_x() public { p.owner(); vault.tok(); ${body} }\n}\n`);
    assert.equal(f.forgePassed, true);
    assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
    assert.match(f.proof.harm.reason, BASE_REASON, `judged on the trace: no backstop, no guard. Got: ${f.proof.harm.reason}`);
    const frame = await expectedFrame(ws, id(sig).slice(0, 10));
    assert.equal(frame.success, false, "the trace marks the expected call as reverted");
    assert.equal(frame.status, "Revert");
  });
}

// Known loss, pinned until the cheatcode table decides it. The pinned forge links a
// scope contract dynamically and rewrites `new X{value: v}()` into the cheatcode
// H1h: forge rewrites `new X{value: v}()` of a scope contract into the cheatcode
// deployCode(string,uint256) (0x0af6a701). The forge 1.9.0 spec declares it (and its
// bytes/salt forms), so the completed table classes it account, trusted: the child
// CREATE carries the value and has the test as its caller, so ethLosses credits it
// to the test party. It is no longer refused as unknown. A test-side take of that
// ETH is not a drain; a pranked attacker's take still is.
test("forge: new ScopeContract{value: …}() is NOT refused, and a test-side take of that ETH is not proven (H1h deployCode)", { skip, timeout: 300_000 }, async () => {
  assert.ok(CHEAT_ROWS.some((r) => r.selector === "0x0af6a701"), "the table now classifies deployCode(string,uint256)");
  const f = await proveScope(makeWs(), { "Pay.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Pay { constructor() payable {} function take(address payable to) external { to.transfer(address(this).balance); } }
` }, "DeployValTest", `import "../src/Pay.sol";
contract Sink { receive() external payable {} }
contract DeployValTest is Test {
  Pay p; Sink s;
  function setUp() public { vm.deal(address(this), 1 ether); p = new Pay{value: 1 ether}(); s = new Sink(); }
  function test_x() public { p.take(payable(address(s))); assertEq(address(s).balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  // Not refused by the backstop: the reason is a harm reason, not an unknown cheatcode.
  assert.ok(!/unknown cheatcode|no scope target counts/.test(f.proof.harm.reason), f.proof.harm.reason);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.equal(isProven(f), false);
});

// The value is credited to the test party, not dropped wholesale: a pranked attacker
// draining the deployed contract is still proven. This also pins that deployCode with
// value is trusted (no backstop refusal).
test("forge: a pranked attacker draining a new X{value: …}() scope contract is proven (H1h deployCode)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Pay.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Pay { constructor() payable {} function take(address payable to) external { to.transfer(address(this).balance); } }
` }, "DeployAtkTest", `import "../src/Pay.sol";
contract DeployAtkTest is Test {
  Pay p;
  function setUp() public { vm.deal(address(this), 1 ether); p = new Pay{value: 1 ether}(); }
  function test_x() public { vm.prank(address(0xBEEF)); p.take(payable(address(0xBEEF))); assertEq(address(0xBEEF).balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  // deployCode(string,uint256) in setUp is trusted (not refused); a pranked attacker
  // (a separate party) draining the contract is still proven.
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.kind, "funds");
  assert.equal(f.proof.harm.lostWei, "1000000000000000000");
  assert.equal(isProven(f), true);
});
// ---- Major: CREATE2 is a creation everywhere CREATE is (repair round 1) ----------
// forge rewrites `new X{salt: s}()` to a salted deployCode (a CREATE2). A constructor
// that runs under CREATE2 must be skipped and attributed like one under CREATE, or an
// owned contract's own `owner = msg.sender` reads as a takeover. Honest shapes only.
const OWNED_C2 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Owned {
  address public owner; // slot 0
  constructor() { owner = msg.sender; }
  function hello() external view returns (address) { return owner; }
  function setOwner(address o) external { owner = o; } // BUG: no access check (for the TP)
}
contract Factory { function make(bytes32 s) external returns (Owned) { return new Owned{salt: s}(); } }
`;
// (1) a salted deploy of an owned scope contract in the body is NOT a takeover.
test("forge: new Owned{salt: …}() of a scope contract in the body is NOT proven (CREATE2 creation)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Owned.sol": OWNED_C2 }, "SaltTest", `import "../src/Owned.sol";
contract SaltTest is Test {
  function test_x() public { Owned o = new Owned{salt: bytes32(uint256(1))}(); assertEq(o.hello(), address(this)); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.equal(isProven(f), false);
});

// (2) a scope factory that deploys a child with CREATE2 in the body is NOT a takeover.
test("forge: a scope factory deploying an owned child with CREATE2 is NOT proven (CREATE2 creation)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Owned.sol": OWNED_C2 }, "FactoryTest", `import "../src/Owned.sol";
contract FactoryTest is Test {
  Factory fac;
  function setUp() public { fac = new Factory(); }
  function test_x() public { Owned o = fac.make(bytes32(uint256(7))); assertEq(o.hello(), address(fac)); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.equal(isProven(f), false);
});

// (3) a CREATE2 with value credits the value to its creator, as for CREATE: a test-side
// take of it is not proven.
test("forge: a CREATE2 with value credits the value to its creator (CREATE2 creation)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Pay.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Pay { constructor() payable {} function take(address payable to) external { to.transfer(address(this).balance); } }
` }, "C2ValTest", `import "../src/Pay.sol";
contract Sink { receive() external payable {} }
contract C2ValTest is Test {
  Pay p; Sink s;
  function setUp() public { vm.deal(address(this), 1 ether); p = new Pay{value: 1 ether, salt: bytes32(uint256(3))}(); s = new Sink(); }
  function test_x() public { p.take(payable(address(s))); assertEq(address(s).balance, 1 ether); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.equal(isProven(f), false);
});

// (4) a real takeover of a CREATE2-deployed scope contract stays proven (no TP lost).
test("forge: a real takeover of a CREATE2-deployed scope contract IS proven (CREATE2 creation TP)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Owned.sol": OWNED_C2 }, "SaltTakeoverTest", `import "../src/Owned.sol";
contract SaltTakeoverTest is Test {
  Owned o;
  function setUp() public { o = new Owned{salt: bytes32(uint256(9))}(); }
  function test_x() public { vm.prank(address(0xBEEF)); o.setOwner(address(0xBEEF)); assertEq(o.owner(), address(0xBEEF)); }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.kind, "control");
  assert.equal(isProven(f), true);
});


// Minor 4 and the guard's depth limit, on real forge (the reviewer's probes 2 and 3;
// honest shapes: a constructor that rejects 0, a function that reverts).
const NEEDS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Needs { constructor(uint256 x) { require(x != 0, "zero"); } }
contract Bank { function hello() external pure returns (uint256) { return 1; } function fail() external pure { revert("nope"); } }
`;
const needsTest = (body) => `import "../src/Needs.sol";
contract NeedsTest is Test {
  Bank bank;
  function setUp() public { bank = new Bank(); }
  function test_x() public { bank.hello(); ${body} }
}
`;
// Probe 2: forge makes new Needs(1) a deployCode call whose child CREATE succeeds.
// The armed call is bank.fail() (reverted). Without the depth limit, the guard
// would take that child CREATE and refuse by mistake.
test("forge: expectRevert, then new X(), then the reverting call: the guard takes the call, not the cheatcode's child CREATE (H1e depth limit)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Needs.sol": NEEDS }, "NeedsTest", needsTest(`vm.expectRevert(bytes("nope")); new Needs(1); bank.fail();`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false);
  assert.match(f.proof.harm.reason, /^the test called a scope target but moved no ETH out of it/, f.proof.harm.reason);
});

// Probe 3: expectRevert directly on new Needs(0). Forge reports Success, but the
// whole test frame reverted and no call followed. The guard refuses, and the reason
// names the real cause.
test("forge: expectRevert directly on new ScopeContract(bad) is refused, and the reason names the creation (H1e minor 4)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Needs.sol": NEEDS }, "NeedsTest", needsTest(`vm.expectRevert(bytes("zero")); new Needs(0);`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false);
  assert.match(f.proof.harm.reason, /vm\.expectRevert \(in body\) on the creation of a contract \(new X\(…\)\)\. Forge makes that creation a cheatcode call \(deployCode\).*external helper call.*try\/catch/);
});

// G1 review (b): a vm.prank between expectRevert and new X(0) must not hide the
// creation shape — the reason still names the creation, not the generic one.
test("forge: a vm.prank between expectRevert and new ScopeContract(bad) still gets the creation reason (H1e minor 4)", { skip, timeout: 300_000 }, async () => {
  const f = await proveScope(makeWs(), { "Needs.sol": NEEDS }, "NeedsTest", needsTest(`vm.expectRevert(bytes("zero")); vm.prank(address(0xBEEF)); new Needs(0);`));
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false);
  assert.match(f.proof.harm.reason, /on the creation of a contract \(new X\(…\)\)\. Forge makes that creation a cheatcode call \(deployCode\)/);
});

// The common real shape (13 of the 14 recorded proofs that use expectRevert): a real
// drain, then expectRevert as a check after it. It stays proven, at its exact value.
test("forge: the lab drain with an expectRevert check after it is STILL proven with its exact value (H1e outcome trusted)", { skip, timeout: 300_000 }, async () => {
  const src = readFileSync(path.join(LAB, "oracle/VaultExploit.t.sol"), "utf8").replace(
    `emit log_named_uint("attacker balance (wei)", address(attacker).balance);`,
    `emit log_named_uint("attacker balance (wei)", address(attacker).balance);
        vm.expectRevert(bytes("transfer failed"));
        vm.prank(makeAddr("alice"));
        vault.withdraw();`);
  assert.match(src, /vm\.expectRevert/);
  const f = await prove(makeWs(), "VaultExploitTest", src);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.lostWei, "10000000000000000000");
  assert.equal(isProven(f), true);
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

// ---- H1b: the open tamper class (vm.store / vm.mockCall on a scope target) ---
//
// Each case below makes the replay show a loss of a scope target that only the
// cheatcode produced: a storage write with vm.store that grants an allowance or
// the owner slot, or a faked answer with vm.mockCall. Forge passes and the gate
// still says PROVEN, so these are `todo`: the finding is not in the diff. The
// reviewer ran them in a scratch copy (`pr4-rereview2-result.md`, "Check 5");
// this pins them. Each case is followed by an HONEST twin that must stay proven:
// the same real loss where the store is a fixture in setUp() on a contract that
// is NOT a scope target, and a mockCall on a contract OUTSIDE the scope.
//
// vm.store and vm.mockCall write the state DB directly, so they leave no SSTORE
// step in the trace (control.test.mjs pins that): the gate sees the effect only,
// never the writer. That is why the cheatcode itself is invisible today.

const STORE_TOKENS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;   // slot 0
  mapping(address => mapping(address => uint256)) public allowance; // slot 1
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) {
    balanceOf[msg.sender] -= a; balanceOf[to] += a;
    emit Transfer(msg.sender, to, a); return true;
  }
  function transferFrom(address from, address to, uint256 a) public returns (bool) {
    allowance[from][msg.sender] -= a;
    balanceOf[from] -= a; balanceOf[to] += a;
    emit Transfer(from, to, a); return true;
  }
}
contract TokVault { Tok public tok; constructor(Tok t) { tok = t; } }
`;

// storeallow: the vault never approved anyone, the test writes the allowance
// slot of the scope token with vm.store, then pulls the vault's real balance
// with transferFrom. Today: proven, funds/token, lostUnits 100. The allowance is
// the only cheatcode: without the store the transferFrom underflows.
test("forge: an allowance written with vm.store on the scope token is NOT proven (H1b, storeallow)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": STORE_TOKENS }, "StoreAllowTest", `import "../src/Tokens.sol";
contract StoreAllowTest is Test {
  Tok tok; TokVault vault;
  function setUp() public { tok = new Tok(); vault = new TokVault(tok); tok.mint(address(vault), 100); }
  function test_x() public {
    bytes32 inner = keccak256(abi.encode(address(vault), uint256(1)));
    bytes32 slot = keccak256(abi.encode(address(0xBEEF), inner));
    vm.store(address(tok), slot, bytes32(uint256(100)));
    vm.prank(address(0xBEEF));
    tok.transferFrom(address(vault), address(0xBEEF), 100);
    assertEq(tok.balanceOf(address(0xBEEF)), 100);
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, /the test set the state of scope target 0x[0-9a-f]{40} \(Tok\) via vm\.store;.*cannot be the source of proven harm/);
  assert.equal(isProven(f), false);
});

// Honest twin: the store is a setUp() fixture on `Credit`, a contract defined in
// the test file and therefore no scope target. The vault's sweep still moves its
// real token balance, so this is a real drain and must stay proven.
const STORE_CREDIT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function mint(address to, uint256 a) external { balanceOf[to] += a; emit Transfer(address(0), to, a); }
  function transfer(address to, uint256 a) public returns (bool) {
    balanceOf[msg.sender] -= a; balanceOf[to] += a;
    emit Transfer(msg.sender, to, a); return true;
  }
}
interface ICredit { function bal(address) external view returns (uint256); }
contract TokVault {
  Tok public tok; ICredit public credit;
  constructor(Tok t, ICredit c) { tok = t; credit = c; }
  function sweep(uint256 a) external {
    require(credit.bal(msg.sender) >= a, "credit");
    tok.transfer(msg.sender, a);
  }
}
`;

test("forge: a vm.store setUp() fixture on a NON-scope contract keeps a real drain proven (H1b storeallow TP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Tokens.sol": STORE_CREDIT }, "StoreSetupTest", `import "../src/Tokens.sol";
contract Credit is ICredit { mapping(address => uint256) public bal; }
contract StoreSetupTest is Test {
  Tok tok; Credit credit; TokVault vault;
  function setUp() public {
    tok = new Tok(); credit = new Credit(); vault = new TokVault(tok, credit);
    tok.mint(address(vault), 100);
    vm.store(address(credit), keccak256(abi.encode(address(0xBEEF), uint256(0))), bytes32(uint256(100)));
  }
  function test_x() public {
    vm.prank(address(0xBEEF));
    vault.sweep(100);
    assertEq(tok.balanceOf(address(0xBEEF)), 100);
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.asset, "token");
  assert.equal(f.proof.harm.lostUnits, "100");
  assert.equal(isProven(f), true);
});

const STORE_OWNED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Owned {
  address public owner; // slot 0
  constructor() { owner = msg.sender; }
  function hello() external pure returns (uint256) { return 1; }
  function setOwner(address x) external { owner = x; }
  function drain(address payable to) external {
    require(msg.sender == owner, "owner");
    to.transfer(address(this).balance);
  }
}
`;

// storeowner: the fixture owner is another address, the test writes slot 0 of
// the scope contract with vm.store, then drains the ETH AS the stored attacker
// through the owner-gated function. The store is the only way in. Today:
// proven, funds, lostWei 1e18.
test("forge: an owner written with vm.store on the scope contract is NOT proven (H1b, storeowner)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Owned.sol": STORE_OWNED }, "StoreOwnerTest", `import "../src/Owned.sol";
contract StoreOwnerTest is Test {
  Owned o;
  function setUp() public {
    o = new Owned();
    vm.deal(address(o), 1 ether);
    vm.prank(address(0xA11CE));
    o.setOwner(address(0xA11CE));
  }
  function test_x() public {
    o.hello();
    vm.store(address(o), bytes32(0), bytes32(uint256(uint160(address(0xBEEF)))));
    vm.prank(address(0xBEEF));
    o.drain(payable(address(0xBEEF)));
    require(address(0xBEEF).balance == 1 ether, "paid");
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, /the test set the state of scope target 0x[0-9a-f]{40} \(Owned\) via vm\.store;.*cannot be the source of proven harm/);
  assert.equal(isProven(f), false);
});

// Honest twin: the owner drain is real and the store only writes the payout
// amount into `Cfg`, a test-file contract and so no scope target. Must stay proven.
const STORE_TREASURY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface ICfg { function amount() external view returns (uint256); }
contract Treasury {
  ICfg public cfg;
  address public owner;
  constructor(ICfg c) { cfg = c; owner = msg.sender; }
  function pay(address payable to) external { require(msg.sender == owner, "owner"); to.transfer(cfg.amount()); }
}
`;

test("forge: a vm.store setUp() fixture on a NON-scope contract keeps a real owner drain proven (H1b storeowner TP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Treasury.sol": STORE_TREASURY }, "TreasuryTest", `import "../src/Treasury.sol";
contract Cfg is ICfg { uint256 public amount; }
contract TreasuryTest is Test {
  Treasury t; Cfg c;
  function setUp() public {
    c = new Cfg(); t = new Treasury(c);
    vm.deal(address(t), 1 ether);
    vm.store(address(c), bytes32(0), bytes32(uint256(1 ether)));
  }
  function test_x() public {
    t.pay(payable(address(0xBEEF)));
    require(address(0xBEEF).balance == 1 ether, "paid");
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.lostWei, "1000000000000000000");
  assert.equal(isProven(f), true);
});

const MOCK_BANK = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Bank {
  mapping(address => uint256) public owed;
  function claim() external {
    uint256 a = this.owed(msg.sender); // an external self-call, so a mockCall can answer it
    require(a > 0, "nothing");
    require(address(this).balance >= a, "empty");
    payable(msg.sender).transfer(a);
  }
}
`;

// mockcall: nothing is owed to the attacker, the test fakes the answer of the
// scope contract's own getter with vm.mockCall, and claim() then pays real ETH.
// Today: proven, funds, lostWei 1e18. The mock is the only cheatcode.
test("forge: an answer faked with vm.mockCall on the scope contract is NOT proven (H1b, mockcall)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Bank.sol": MOCK_BANK }, "MockCallTest", `import "../src/Bank.sol";
contract MockCallTest is Test {
  Bank b;
  function setUp() public { b = new Bank(); vm.deal(address(b), 1 ether); }
  function test_x() public {
    b.owed(address(0xBEEF));
    vm.mockCall(address(b), abi.encodeWithSignature("owed(address)", address(0xBEEF)), abi.encode(uint256(1 ether)));
    vm.prank(address(0xBEEF));
    b.claim();
    require(address(0xBEEF).balance == 1 ether, "paid");
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, false, JSON.stringify(f.proof.harm));
  assert.match(f.proof.harm.reason, /the test set the state of scope target 0x[0-9a-f]{40} \(Bank\) via vm\.mockCall;.*cannot be the source of proven harm/);
  assert.equal(isProven(f), false);
});

// Honest twin: the mock is on `Feed`, a price feed outside the scope that the
// test does not attack. The vault pays real ETH, so this must stay proven.
const MOCK_BANK_FEED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IFeed { function price() external view returns (uint256); }
contract Bank {
  IFeed public feed;
  constructor(IFeed f) { feed = f; }
  function withdraw() external { require(feed.price() == 1 ether, "price"); payable(msg.sender).transfer(address(this).balance); }
}
`;

test("forge: a vm.mockCall on a contract OUTSIDE the scope keeps a real drain proven (H1b mockcall TP)", { skip, timeout: 300_000 }, async () => {
  const ws = makeWorkspace(LAB); workspaces.push(ws);
  const f = await proveScope(ws, { "Bank.sol": MOCK_BANK_FEED }, "MockFeedTest", `import "../src/Bank.sol";
contract Feed is IFeed { function price() external pure returns (uint256) { return 2 ether; } }
contract MockFeedTest is Test {
  Bank b; Feed f;
  function setUp() public { f = new Feed(); b = new Bank(f); vm.deal(address(b), 1 ether); }
  function test_x() public {
    vm.mockCall(address(f), abi.encodeWithSignature("price()"), abi.encode(uint256(1 ether)));
    vm.prank(address(0xBEEF));
    b.withdraw();
    require(address(0xBEEF).balance == 1 ether, "paid");
  }
}
`);
  assert.equal(f.forgePassed, true);
  assert.equal(f.proof.harm.ok, true, JSON.stringify(f.proof.harm));
  assert.equal(f.proof.harm.lostWei, "1000000000000000000");
  assert.equal(isProven(f), true);
});
