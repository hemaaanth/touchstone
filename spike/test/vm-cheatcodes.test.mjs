// The classified table of cheatcodes (lib/vm-cheatcodes.json) against the
// vendored forge-std `Vm.sol`. The forge harm gate will use the table to refuse
// a replay that calls a cheatcode whose class it cannot account for, so the
// table must be complete and must not drift from the pinned file: a forge-std
// upgrade fails this test until someone classifies the new functions.
//
//   node --experimental-test-module-mocks --test test/vm-cheatcodes.test.mjs
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

const CLASSES = new Set(["read", "control", "time", "account", "mock", "fork", "fs"]);
const SIG = /^[A-Za-z_]\w*\([0-9A-Za-z,[\]()]*\)$/;
const bySelector = new Map(TABLE.map((e) => [e.selector, e]));
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

// (a) the table is exactly the vendored file, plus exactly the gate's extras.
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
    assert.ok(!entry.extra, `${row.signature} is in Vm.sol but flagged extra`);
  }

  // An entry that Vm.sol lacks must be a selector the gate names, and the flagged
  // extras must be exactly those: no silent extras, none of the gate's dropped.
  const gateOnly = GATE.filter((s) => !parsedBySelector.has(s));
  const extras = TABLE.filter((e) => e.extra).map((e) => e.selector);
  assert.deepEqual([...extras].sort(), [...gateOnly].sort());
  for (const entry of TABLE) {
    if (entry.extra) continue;
    assert.ok(parsedBySelector.has(entry.selector), `extra entry ${entry.signature} that the gate does not name`);
  }
});

// (b) a known class, and a signature that really produces the selector.
test("every entry has a valid class and a self-consistent selector", () => {
  for (const entry of TABLE) {
    assert.ok(CLASSES.has(entry.class), `${entry.signature}: class ${entry.class}`);
    assert.ok(entry.iface === "VmSafe" || entry.iface === "Vm", `${entry.signature}: iface ${entry.iface}`);
    assert.match(entry.signature, SIG, `${entry.signature}: not a canonical signature`);
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
