// The classified table of cheatcodes (lib/vm-cheatcodes.json) against the
// vendored forge-std `Vm.sol`. The forge harm gate will use the table to refuse
// a replay that calls a cheatcode whose class it cannot account for, so the
// table must be complete and must not drift from the pinned file: a forge-std
// upgrade fails this test until someone classifies the new functions.
//
//   node --experimental-test-module-mocks --test test/vm-cheatcodes.test.mjs
//
// The dangerous direction is a state-changing cheatcode sitting in `read` or
// `control`. Two checks close it: every entry carries the declaration's own
// `mutability`, and a `read`/`control` entry is only accepted when that
// mutability is `view` or `pure`, or when its name is in the allow-list below:
// `nonpayable` functions that the doc comment shows cannot change an account's
// state, code, balance or nonce, the caller identity, a call's answer, or what
// the chain sees later. A new `nonpayable` function from an upgrade fails until
// someone allow-lists it on purpose. Stricter is always allowed. Two classes
// sit between `control` and the account classes on purpose: `outcome` (a
// matched revert can be reported as success with replacement return data) and
// `exec` (the gas meter changes what `gasleft()` shows and whether code runs
// out of gas). Neither may claim `control`.
//
// The table also carries a few selectors the pinned file does not declare but
// the harm gate already names (newer-forge bool and bytes4 overloads). They are
// flagged `extra` and the check below keeps that flag honest: the extras must be
// exactly the gate's selectors that Vm.sol lacks. Removing them would make the
// table quietly weaker than the gate it replaces.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "ethers";
import { parseFile, selectorOf } from "../scripts/vm-cheatcodes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LABS = ["vault-accounting", "vault-bytecode", "vault-multi", "vault-reentrancy", "vault-shares"];
const vmSol = (lab) => join(ROOT, "lab", lab, "lib/forge-std/src/Vm.sol");
const CANONICAL_VM_SOL = vmSol("vault-reentrancy");
const TABLE = JSON.parse(readFileSync(join(ROOT, "spike/lib/vm-cheatcodes.json"), "utf8"));
const CONTROL_TRACE = readFileSync(join(ROOT, "spike/lib/control-trace.mjs"), "utf8");

const CLASSES = new Set(["read", "control", "time", "account", "mock", "fork", "fs", "state", "outcome", "exec"]);
const MUTABILITIES = new Set(["view", "pure", "nonpayable"]);
const SIG = /^[A-Za-z_]\w*\([0-9A-Za-z,[\]()]*\)$/;
const bySelector = new Map(TABLE.map((e) => [e.selector, e]));

// Read/control on a `nonpayable` declaration is accepted only for these names,
// keyed `<iface>:<name>`, each with the reason the call still cannot change what
// an account is or holds. Only one overload has to be nonpayable for the name to
// need an entry; a name whose overloads are all `view`/`pure` needs none.
const ALLOWED = new Map([
  // Vm, control: expectations, snapshots and skips live in the inspector.
  ["Vm:allowCheatcodes", "grants cheatcode access to an address on a fork; no account state"],
  ["Vm:deleteSnapshot", "removes a snapshot id from the inspector"],
  ["Vm:deleteSnapshots", "removes all snapshot ids from the inspector"],
  ["Vm:deleteStateSnapshot", "removes one snapshot id from the inspector"],
  ["Vm:deleteStateSnapshots", "removes all snapshot ids from the inspector"],
  ["Vm:expectCall", "sets the next-call expectation; no account state"],
  ["Vm:expectCallMinGas", "sets the next-call expectation and a gas floor"],
  ["Vm:expectEmit", "sets the next-log expectation"],
  ["Vm:expectEmitAnonymous", "sets the next anonymous-log expectation"],
  // expectRevert and expectPartialRevert are `outcome`, the gas meter is `exec`.
  ["Vm:expectSafeMemory", "sets the allowed memory window"],
  ["Vm:expectSafeMemoryCall", "sets the allowed memory window of the next subcontext"],
  ["Vm:stopExpectSafeMemory", "clears the allowed memory window"],
  ["Vm:skip", "marks the test skipped"],
  ["Vm:snapshot", "stores a snapshot id in the inspector"],
  ["Vm:snapshotGasLastCall", "stores a gas counter under a snapshot name"],
  ["Vm:snapshotState", "stores a snapshot id in the inspector"],
  ["Vm:snapshotValue", "stores a named value in the inspector"],
  ["Vm:startSnapshotGas", "starts a named gas counter"],
  ["Vm:stopSnapshotGas", "stops a named gas counter"],
  // VmSafe, control: runner flags and the terminal.
  ["VmSafe:setEnv", "writes the runner's process env"],
  ["VmSafe:sleep", "sleeps the test thread"],
  ["VmSafe:startDebugTraceRecording", "sets the debug trace flag"],
  ["VmSafe:startMappingRecording", "sets the mapping record flag"],
  ["VmSafe:startStateDiffRecording", "sets the state diff record flag"],
  ["VmSafe:stopAndReturnDebugTraceRecording", "clears the debug trace flag"],
  ["VmSafe:stopAndReturnStateDiff", "clears the state diff record flag"],
  ["VmSafe:stopMappingRecording", "clears the mapping record flag"],
  // Vm, read: prank state.
  ["Vm:readCallers", "reads the active caller modification"],
  // VmSafe, read: record sessions, disk stats, local wallet, in-memory JSON.
  ["VmSafe:accesses", "reads the record session"],
  ["VmSafe:closeFile", "resets a file read offset"],
  ["VmSafe:createWallet", "adds a key to the local wallet and labels it"],
  ["VmSafe:exists", "stats the disk"],
  ["VmSafe:getMappingKeyAndParentOf", "reads the mapping record session"],
  ["VmSafe:getMappingLength", "reads the mapping record session"],
  ["VmSafe:getMappingSlotAt", "reads the mapping record session"],
  ["VmSafe:getNonce", "reads a nonce"],
  ["VmSafe:getRecordedLogs", "reads the log record session"],
  ["VmSafe:getScriptWallets", "lists local wallet addresses"],
  ["VmSafe:getWallets", "lists local wallet addresses"],
  ["VmSafe:isDir", "stats the disk"],
  ["VmSafe:isFile", "stats the disk"],
  ["VmSafe:label", "sets a trace label"],
  ["VmSafe:prompt", "reads a value from the terminal"],
  ["VmSafe:promptAddress", "reads a value from the terminal"],
  ["VmSafe:promptSecret", "reads a value from the terminal"],
  ["VmSafe:promptSecretUint", "reads a value from the terminal"],
  ["VmSafe:promptUint", "reads a value from the terminal"],
  ["VmSafe:randomAddress", "generates a value"],
  ["VmSafe:randomUint", "generates a value"],
  ["VmSafe:record", "sets the storage record flag"],
  ["VmSafe:recordLogs", "sets the log record flag"],
  ["VmSafe:rememberKey", "adds a key to the local wallet"],
  ["VmSafe:rememberKeys", "adds keys to the local wallet"],
  ["VmSafe:serializeAddress", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeBool", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeBytes", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeBytes32", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeInt", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeJson", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeJsonType", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeString", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeUint", "writes the in-memory JSON buffer"],
  ["VmSafe:serializeUintToHex", "writes the in-memory JSON buffer"],
  ["VmSafe:sign", "signs with a wallet or key; no EVM state"],
  ["VmSafe:signCompact", "signs with a wallet or key; no EVM state"],
  ["VmSafe:unixTime", "reads the wall clock"],
]);

const signatures = (source, from, to) => {
  const slice = source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  return [...slice.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((s) => SIG.test(s));
};

// Every selector control-trace.mjs names, derived the way that file derives it:
// the literal signatures of both lists, plus the `mockCall`/`mockCallRevert`
// template overloads. Read from the source so an edit there is seen here.
function gateSelectors() {
  const named = [
    ...signatures(CONTROL_TRACE, "const IMPERSONATION_SIGS", "const IMPERSONATE"),
    ...signatures(CONTROL_TRACE, "const TAMPER_SIGS", "const TAMPER "),
  ];
  const tamper = CONTROL_TRACE.slice(CONTROL_TRACE.indexOf("const TAMPER_SIGS"), CONTROL_TRACE.indexOf("const TAMPER "));
  const templates = [...tamper.matchAll(/`\$\{name\}([^`]*)`/g)].map((m) => m[1]);
  const names = [...(/\[([^\]]*)\]\.flatMap/.exec(tamper)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  for (const body of templates) for (const name of names) named.push(`${name}${body}`);
  return [...new Set(named.map(selectorOf))];
}

const GATE = gateSelectors();

test("the guard sees the gate lists: it is not blind", () => {
  assert.ok(GATE.length >= 20, `only ${GATE.length} gate selectors parsed`);
  assert.ok(GATE.includes("0xca669fa7"), "prank(address) not parsed from control-trace");
  assert.ok(GATE.includes("0x70ca10bb"), "store(address,bytes32,bytes32) not parsed from control-trace");
  assert.ok(GATE.includes("0x08e0c537"), "mockCall(address,bytes4,bytes) not expanded from control-trace");
});

test("every lab carries the same pinned Vm.sol", () => {
  const digest = (lab) => createHash("sha256").update(readFileSync(vmSol(lab))).digest("hex");
  const reference = digest("vault-reentrancy");
  for (const lab of LABS) assert.equal(digest(lab), reference, `lab/${lab} carries a different Vm.sol`);
});

// The forge binary's own cheatcode spec, vendored at the pinned image's commit.
// The table is the union: every cheatcode of forge-std Vm.sol, plus the forge
// binary's extras (flagged `extra`). The gate reads the trace of the pinned
// binary, so the binary's spec is the authority on what may appear; a cheatcode
// the binary has and the table lacks would pass in silence.
const FORGE = JSON.parse(readFileSync(join(ROOT, "spike/vendor/foundry/cheatcodes-1.9.0.json"), "utf8"));
const FORGE_BY_SELECTOR = new Map(
  FORGE.cheatcodes
    .filter((c) => c.func?.selector && c.status !== "internal")
    .map((c) => [c.func.selector.toLowerCase(), c.func.signature]),
);

// (a) the table is exactly the vendored Vm.sol, plus binary-only extras that the
// pinned forge binary declares.
test("the table matches the vendored Vm.sol, function for function", () => {
  const parsed = parseFile(CANONICAL_VM_SOL);
  assert.ok(parsed.length > 400, `parsed only ${parsed.length} functions`);
  const parsedBySelector = new Map(parsed.map((r) => [r.selector, r]));

  for (const row of parsed) {
    const entry = bySelector.get(row.selector);
    assert.ok(entry, `missing ${row.iface}.${row.signature} (${row.selector})`);
    assert.equal(entry.name, row.name, `changed name for ${row.selector}`);
    assert.equal(entry.signature, row.signature, `changed signature for ${row.selector}`);
    assert.equal(entry.iface, row.iface, `changed interface for ${row.signature}`);
    assert.equal(entry.mutability, row.mutability, `changed mutability for ${row.signature}`);
    assert.ok(!entry.extra, `${row.signature} is in Vm.sol but flagged extra`);
  }

  // Every non-Vm.sol entry is flagged `extra` and is a cheatcode the pinned forge
  // binary declares, by selector and canonical signature. No silent extra.
  for (const entry of TABLE) {
    if (parsedBySelector.has(entry.selector)) continue;
    assert.ok(entry.extra, `${entry.signature} is not in Vm.sol but not flagged extra`);
    const sig = FORGE_BY_SELECTOR.get(entry.selector.toLowerCase());
    assert.equal(sig, entry.signature, `extra ${entry.signature} (${entry.selector}) is not a forge 1.9.0 cheatcode`);
  }

  // Completeness to the binary: every NON-INTERNAL cheatcode the pinned forge binary has is in
  // the table (the three internal `_expectCheatcodeRevert` forms are excluded; at
  // runtime they are unknown and refused, so fail closed). A forge upgrade that adds one fails here until someone classifies it.
  for (const [selector, signature] of FORGE_BY_SELECTOR) {
    assert.ok(bySelector.get(selector), `the pinned forge binary has ${signature} (${selector}); the table lacks it`);
  }
});

// The vendored forge spec is the file the comment names (digest pinned, like the
// Public Suffix List). A new image means a new spec: re-vendor and re-classify.
test("the vendored forge cheatcode spec is the pinned one", () => {
  const file = join(ROOT, "spike/vendor/foundry/cheatcodes-1.9.0.json");
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const src = readFileSync(join(ROOT, "spike/lib/control-trace.mjs"), "utf8");
  assert.ok(src.includes(sha), `control-trace.mjs records the sha256 of the vendored forge spec (${sha})`);
});

// Minor 3: the vendored spec is tied to the pinned forge image. If sandbox.mjs's
// IMG digest changes, the spec may no longer be the binary's own, so this fails
// until the spec (and the digest beside it) are re-vendored.
test("the vendored forge spec is tied to the pinned forge image digest", () => {
  const sandbox = readFileSync(join(ROOT, "spike/lib/sandbox.mjs"), "utf8");
  const imgDigest = /IMG\s*=\s*"[^"]*@(sha256:[0-9a-f]{64})"/.exec(sandbox)?.[1];
  assert.ok(imgDigest, "could not read the pinned image digest from sandbox.mjs IMG");
  const readme = readFileSync(join(ROOT, "spike/vendor/foundry/README.md"), "utf8");
  assert.ok(readme.includes(imgDigest), `the vendored spec README must record the pinned image digest ${imgDigest}; a changed IMG means re-vendor the spec`);
});

// (b) a known class, and a signature that really produces the selector.
test("every entry has a valid class and a self-consistent selector", () => {
  for (const entry of TABLE) {
    assert.ok(CLASSES.has(entry.class), `${entry.signature}: class ${entry.class}`);
    assert.ok(entry.iface === "VmSafe" || entry.iface === "Vm", `${entry.signature}: iface ${entry.iface}`);
    assert.match(entry.signature, SIG, `${entry.signature}: not a canonical signature`);
    assert.ok(MUTABILITIES.has(entry.mutability), `${entry.signature}: mutability ${entry.mutability}`);
    assert.ok(!/\s|calldata|memory|storage|payable/.test(entry.signature), `${entry.signature}: word left in`);
    assert.equal(selectorOf(entry.signature), entry.selector, `${entry.signature}: selector`);
    assert.equal(entry.name, entry.signature.slice(0, entry.signature.indexOf("(")), `${entry.signature}: name`);
    if (entry.note !== undefined) assert.equal(typeof entry.note, "string", `${entry.signature}: note`);
  }
});

// (c) one entry per selector and per signature.
test("selectors and signatures are unique", () => {
  assert.equal(bySelector.size, TABLE.length, "duplicate selector");
  assert.equal(new Set(TABLE.map((e) => e.signature)).size, TABLE.length, "duplicate signature");
});

// (d) known selectors, computed rather than written.
test("known selectors carry the expected class", () => {
  const known = {
    "store(address,bytes32,bytes32)": "0x70ca10bb",
    "prank(address)": "0xca669fa7",
    "deal(address,uint256)": "0xc88a5e6d",
    "etch(address,bytes)": "0xb4d6c782",
    "mockCall(address,bytes,bytes)": "0xb96213e4",
  };
  for (const [signature, selector] of Object.entries(known)) {
    assert.equal(id(signature).slice(0, 10), selector);
    assert.equal(bySelector.get(selector)?.signature, signature);
  }
  assert.equal(bySelector.get("0x70ca10bb").class, "account");
  assert.equal(bySelector.get("0xca669fa7").class, "account");
  assert.equal(bySelector.get("0xc88a5e6d").class, "account");
  assert.equal(bySelector.get("0xb4d6c782").class, "account");
  assert.equal(bySelector.get("0xb96213e4").class, "mock");
});

// (e) nothing the gate already handles may fall out of the table weaker.
test("every selector control-trace.mjs names is classed account or mock", () => {
  for (const selector of GATE) {
    const entry = bySelector.get(selector);
    assert.ok(entry, `control-trace names ${selector}, the table lacks it`);
    assert.ok(
      entry.class === "account" || entry.class === "mock",
      `control-trace names ${entry.signature} as ${entry.class}`,
    );
  }
});

// (f) the class is backed, not just asserted. `read` and `control` are the two
// classes a state-changing function can hide in; only a `view`/`pure`
// declaration, or a deliberate allow-list entry, may claim them.
test("a read or control class is proved by view/pure or an allow-list entry", () => {
  for (const entry of TABLE) {
    if (entry.class !== "read" && entry.class !== "control") continue;
    if (entry.mutability !== "nonpayable") continue;
    assert.ok(
      ALLOWED.get(`${entry.iface}:${entry.name}`),
      `${entry.signature} is nonpayable classed ${entry.class}: allow-list it with a reason, or class it stricter`,
    );
  }
});

// The allow-list itself must stay tight: every entry is used by a live
// read/control overload, and no entry outlives its name.
test("the allow-list has no stale or unused entry", () => {
  for (const [key, reason] of ALLOWED) {
    const entries = TABLE.filter((e) => `${e.iface}:${e.name}` === key);
    assert.ok(entries.length > 0, `${key} is allow-listed but absent from the table`);
    assert.ok(reason.trim().length > 0, `${key} has no reason`);
    assert.ok(
      entries.some((e) => (e.class === "read" || e.class === "control") && e.mutability === "nonpayable"),
      `${key} is allow-listed but no nonpayable read/control overload uses it`,
    );
  }
});

// (g) the reviewer's pin list: whatever else moves, these never drop back to
// `read` or `control`. Names are matched as patterns so every overload and the
// deprecated aliases in each family are covered.
test("state-changing names never class as read or control", () => {
  const pinned = [
    /prank/i,
    /broadcast/i,
    /^mock/,
    /^clearMockedCalls$/,
    /^revertTo/,
    /^expectRevert/,
    /^expectPartialRevert/,
    /^(pause|reset|resume)GasMetering$/,
    ...[
      "deal",
      "setNonce",
      "setNonceUnsafe",
      "resetNonce",
      "etch",
      "store",
      "copyStorage",
      "setArbitraryStorage",
      "loadAllocs",
      "cloneAccount",
      "deployCode",
      "createFork",
      "createSelectFork",
      "selectFork",
      "rollFork",
      "makePersistent",
      "revokePersistent",
      "transact",
      "rpc",
    ].map((n) => new RegExp(`^${n}$`)),
  ];
  const hit = TABLE.filter((e) => pinned.some((re) => re.test(e.name)));
  assert.ok(hit.length >= 40, `only ${hit.length} pinned functions matched`);
  for (const name of ["deal", "etch", "store"]) {
    assert.ok(TABLE.some((e) => e.name === name), `${name} vanished from the table`);
  }
  for (const entry of hit) {
    assert.ok(
      entry.class !== "read" && entry.class !== "control",
      `${entry.signature} is pinned state-changing but classed ${entry.class}`,
    );
  }
});
