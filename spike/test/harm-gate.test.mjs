// The forge harm gate: a passing test is not a proof. A finding is proven only
// when its replay calls a contract deployed from the audited scope AND harms it,
// by ETH leaving it (funds) or a storage write in it (control).
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
import { judgeHarm } from "../lib/proof.mjs";
import { extractControlTrace } from "../lib/control-trace.mjs";
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
