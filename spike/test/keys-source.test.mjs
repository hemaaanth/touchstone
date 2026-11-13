// Tests for the source checks of the Keys and Chain watch packs (packs/keys/source-checks.mjs)
// and for source mode, where the packs read a real Foundry folder instead of the lab world.
// The checks are pure. The prepass test runs Aderyn in Docker and skips when its image is missing.
//
//   node --experimental-test-module-mocks --test test/keys-source.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource, scanSources, stripComments } from "../packs/keys/source-checks.mjs";
import { aderynNote, chainPrepass, hasWorld, sourceFiles, sourceLeads, leadsFor, keysLeads, watchLeads } from "../packs/keys/common.mjs";
import { prepassView } from "../lib/prepass-view.mjs";
import { skipUnlessImages } from "./docker-skip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, "..", "packs");
const checks = (leads) => leads.map((l) => l.check).sort();
const scan = (src) => scanSource("src/T.sol", src);

test("a word in a comment never counts", () => {
  const src = `contract C { // tx.origin == owner
    /* function upgradeTo(address a) external { ecrecover(h,v,r,s); } */
    function f() external {} }`;
  assert.deepEqual(scan(src), []);
  assert.equal(stripComments("a // b\nc").split("\n").length, 2);
});

test("ecrecover with no zero check, no s bound, no nonce and no domain gives four leads", () => {
  const src = `contract Pay { address signer;
    function claim(bytes32 h, uint8 v, bytes32 r, bytes32 s) external {
      require(ecrecover(h, v, r, s) == signer, "bad sig");
      payable(msg.sender).transfer(1 ether);
    } }`;
  assert.deepEqual(checks(scan(src)), ["ecrecover-zero-address", "signature-malleability", "signature-no-domain", "signature-replay-no-nonce"]);
});

test("a careful signature check raises no signature lead", () => {
  const src = `contract Pay { address signer; mapping(address => uint256) public nonces;
    bytes32 public DOMAIN_SEPARATOR;
    function claim(uint256 nonce, uint8 v, bytes32 r, bytes32 s) external {
      require(uint256(s) <= 0x7FFFFFFF5D576E7357A4501DDFE92F46681B20A0, "s");
      bytes32 h = keccak256(abi.encode(DOMAIN_SEPARATOR, block.chainid, nonce));
      address who = ecrecover(h, v, r, s);
      require(who != address(0) && who == signer, "bad sig");
      require(nonce == nonces[who]++, "nonce");
    } }`;
  assert.deepEqual(scan(src), []);
});

test("tx.origin as an auth check is High", () => {
  const src = `contract W { address owner; function send(address to) external { require(tx.origin == owner); } }`;
  const [lead] = scan(src);
  assert.equal(lead.check, "tx-origin-auth");
  assert.equal(lead.impact, "High");
});

test("an open upgradeTo and an open initialize are High; gated ones are quiet", () => {
  const open = `contract P { address impl; address owner;
    function upgradeTo(address a) external { impl = a; }
    function initialize(address o) external { owner = o; } }`;
  assert.deepEqual(checks(scan(open)), ["initializer-unprotected", "unprotected-control-function"]);
  const gated = `contract P { address impl; address owner; bool initialized;
    modifier onlyOwner() { require(msg.sender == owner); _; }
    function upgradeTo(address a) external onlyOwner { impl = a; }
    function changeAdmin(address a) external { require(msg.sender == owner, "x"); owner = a; }
    function initialize(address o) external { require(!initialized); initialized = true; owner = o; } }`;
  assert.deepEqual(scan(gated), []);
});

test("an empty _authorizeUpgrade is High", () => {
  const src = `contract U is UUPSUpgradeable { function _authorizeUpgrade(address) internal override {} }`;
  assert.ok(checks(scan(src)).includes("uups-authorize-empty"));
  assert.ok(checks(scan(src)).includes("implementation-initializable"));
});

test("the OpenZeppelin default _authorizeUpgrade(address) onlyOwner {} raises no lead", () => {
  const src = `contract U is UUPSUpgradeable, OwnableUpgradeable {
    constructor() { _disableInitializers(); }
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
  }`;
  assert.deepEqual(checks(scan(src)), []);
});

test("an empty _authorizeUpgrade with an unknown modifier is only Medium", () => {
  const src = `contract U is UUPSUpgradeable { constructor() { _disableInitializers(); } function _authorizeUpgrade(address) internal override onlyGov {} }`;
  const leads = scan(src).filter((l) => l.check === "uups-authorize-empty");
  assert.deepEqual(leads.map((l) => l.impact), ["Medium"]);
});

test("a custom gate is not High: a file-local modifier, a helper call and a mapping check", () => {
  const src = `contract G {
    mapping(address => bool) admins; address gov;
    modifier onlyGov() { require(msg.sender == gov, "gov"); _; }
    modifier guarded() { if (!admins[msg.sender]) revert(); _; }
    function setOwner(address a) external onlyGov {}
    function setAdmin(address a) external guarded {}
    function transferOwnership(address a) external { require(admins[msg.sender]); }
    function changeAdmin(address a) external { _checkGov(); }
    function upgradeTo(address a) external restricted {}
    function setGuard(address a) external {}
  }`;
  const high = scan(src).filter((l) => l.impact === "High");
  assert.deepEqual(high.map((l) => l.where), ["G.setGuard"]);
  const medium = scan(src).filter((l) => l.check === "unprotected-control-function" && l.impact === "Medium").map((l) => l.where).sort();
  assert.deepEqual(medium, ["G.changeAdmin", "G.upgradeTo"]);
});

test("a local variable named implementation is not an implementation write", () => {
  const src = `contract R { address public implementation; function peek(address x) external { address implementation = x; emit Peeked(implementation); }
    function quote(address implementation) external { implementation = address(0); } }`;
  assert.deepEqual(checks(scan(src)), []);
  const write = `contract R { address public implementation; function set(address x) external { implementation = x; } }`;
  assert.ok(checks(scan(write)).includes("unprotected-implementation-write"));
});

test("implementation-initializable reads only its own contract and its local bases", () => {
  const two = `contract A is UUPSUpgradeable { function f() external {} }
contract B is UUPSUpgradeable { constructor() { _disableInitializers(); } }`;
  assert.deepEqual(scan(two).filter((l) => l.check === "implementation-initializable").map((l) => l.where), ["A"]);
  const base = `abstract contract Base { constructor() { _disableInitializers(); } }
contract C is Base, UUPSUpgradeable {}`;
  assert.deepEqual(scan(base).filter((l) => l.check === "implementation-initializable"), []);
});

test("a module that spends with no caller check is High", () => {
  const src = `contract M { function drain(ISafe s, address to) external { s.execTransactionFromModule(to, 1, "", 0); } }`;
  assert.deepEqual(checks(scan(src)), ["module-no-access-control"]);
  const ok = `contract M { address owner; function drain(ISafe s, address to) external { require(msg.sender == owner); s.execTransactionFromModule(to, 1, "", 0); } }`;
  assert.deepEqual(scan(ok), []);
});

test("delegatecall to a caller-chosen address and an open selfdestruct are High", () => {
  const src = `contract D { function run(address t, bytes calldata d) external { t.delegatecall(d); }
    function kill() external { selfdestruct(payable(msg.sender)); } }`;
  assert.deepEqual(checks(scan(src)), ["delegatecall-user-target", "unprotected-selfdestruct"]);
});

test("a hard-coded private key is High and the lead never carries the full key", () => {
  const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const [lead] = scan(`contract K { uint256 constant PRIVATE_KEY = ${key}; }`);
  assert.equal(lead.check, "hardcoded-private-key");
  assert.ok(!lead.description.includes(key.slice(6)));
});

test("the lab sources show the planted bugs a clean scan would not rank", () => {
  const watch = scanSource("src/ChainWatchLab.sol", readFileSync(join(PACKS, "chain-watch/lab/src/ChainWatchLab.sol"), "utf8"));
  assert.deepEqual(checks(watch), ["silent-upgrade-path", "unprotected-control-function"]);
  assert.ok(watch.every((l) => l.where === "ChainWatchLab.upgradeTo"));
  const keys = scanSource("src/KeysLab.sol", readFileSync(join(PACKS, "keys/lab/src/KeysLab.sol"), "utf8"));
  assert.deepEqual(checks(keys), ["module-no-access-control"]);
  assert.equal(keys[0].where, "OpenModule.drain");
});

test("scanSources ranks High first and keeps file and line", () => {
  const leads = scanSources([
    { path: "src/B.sol", content: "contract B { function kill() external { selfdestruct(payable(msg.sender)); } }" },
    { path: "src/A.sol", content: "contract A is UUPSUpgradeable { }" },
  ]);
  assert.equal(leads[0].impact, "High");
  assert.equal(leads[0].file, "src/B.sol");
  assert.equal(leads[1].impact, "Medium");
  assert.ok(leads.every((l) => l.lines[0] > 0));
});

function folder(files) {
  const ws = mkdtempSync(join(tmpdir(), "keys-source-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), content);
  }
  return ws;
}

test("source mode skips vendored code and reports a lead with its file and line", () => {
  const ws = folder({
    "src/Vault.sol": "contract Vault {\n  address owner;\n  function setOwner(address o) external { owner = o; }\n}\n",
    "lib/forge-std/src/Vm.sol": "contract Vm { function setOwner(address o) external {} }",
    "src/node_modules/x/Y.sol": "contract Y { function setOwner(address o) external {} }",
    "src/lib/Math.sol": "library Math { function add(uint a, uint b) internal pure returns (uint) { return a + b; } }",
  });
  try {
    assert.deepEqual(sourceFiles(ws).map((f) => f.path).sort(), ["src/Vault.sol", "src/lib/Math.sol"]);
    const [lead] = sourceLeads(ws);
    assert.equal(lead.check, "unprotected-control-function");
    assert.match(lead.where, /Vault\.setOwner \(src\/Vault\.sol:3\)/);
    assert.deepEqual(lead.engines, ["Touchstone source"]);
    assert.equal(hasWorld(ws, "keys"), false);
    assert.equal(hasWorld(ws, "chain-watch"), false);
    assert.equal(leadsFor(ws, keysLeads).length, 1);
    assert.equal(leadsFor(ws, watchLeads).length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a folder that holds a lab contract has a world", () => {
  const ws = folder({ "src/KeysLab.sol": "contract X {}", "src/ChainWatchLab.sol": "contract Y {}" });
  try {
    assert.equal(hasWorld(ws, "keys"), true);
    assert.equal(hasWorld(ws, "chain-watch"), true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("source mode prepass runs Aderyn through runTool and renders in the prepass view", { skip: skipUnlessImages("touchstone/aderyn:0.6.8") }, async () => {
  const ws = folder({
    "foundry.toml": '[profile.default]\nsrc = "src"\nout = "out"\n',
    "src/Vault.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Vault {\n  address public owner;\n  function setOwner(address o) external { owner = o; }\n  function ping() external pure returns (uint256) { return 1; }\n}\n",
  });
  try {
    const events = [];
    const { env, record } = await chainPrepass(ws, { emit: (e) => events.push(e) }, { mode: "keys", analyze: keysLeads });
    assert.equal(record.source, true);
    assert.equal(record.block, null);
    assert.ok(record.suspects >= 1);
    assert.equal(events[0].ev, "chain-scan");
    assert.match(env.CHAIN_BRIEF, /unprotected-control-function/);
    const view = prepassView(record);
    assert.ok(view && view.leads.some((l) => l.check === "unprotected-control-function"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ---- smoke for source mode: a real Foundry folder, no lab world, no model spend.

const dockerReady = () => { try { execFileSync("docker", ["image", "inspect", "touchstone/aderyn:0.6.8"], { stdio: "ignore" }); return true; } catch { return false; } };
const FORGE_STD = join(PACKS, "keys/lab/lib/forge-std");

// A vault whose owner can be set by anyone. This stands for the operator's own repo.
const OPEN_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract OpenVault {
    address public owner;
    constructor() { owner = msg.sender; }
    receive() external payable {}
    function setOwner(address next) external { owner = next; }
    function sweep(address payable to) external {
        require(msg.sender == owner, "owner");
        to.transfer(address(this).balance);
    }
}
`;
const OPEN_VAULT_POC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/OpenVault.sol";
contract OpenVaultTakeover is Test {
    function test_anyoneTakesTheVault() public {
        OpenVault vault = new OpenVault();
        vm.deal(address(vault), 1 ether);
        address attacker = address(0xBAD);
        vm.startPrank(attacker);
        vault.setOwner(attacker);
        vault.sweep(payable(attacker));
        vm.stopPrank();
        assertEq(attacker.balance, 1 ether);
        assertEq(address(vault).balance, 0);
    }
}
`;

test("source mode smoke: a real folder gets source leads, and its exploit replays green with funds harm",
  { skip: !dockerReady() && "aderyn image not built", timeout: 600_000 }, async () => {
  const { cpSync } = await import("node:fs");
  const { default: keys } = await import("../packs/keys/pack.mjs");
  const { cleanupWorkspace, forgeTest, makeWorkspace, writePoc } = await import("../lib/sandbox.mjs");
  const dir = folder({
    ".touchstone.json": JSON.stringify({ pack: "keys", solc: "0.8.38" }),
    "foundry.toml": '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = ["lib"]\n',
    "src/OpenVault.sol": OPEN_VAULT,
    "test/.gitkeep": "",
  });
  cpSync(FORGE_STD, join(dir, "lib", "forge-std"), { recursive: true });
  const ws = makeWorkspace(dir);
  try {
    const events = [];
    const prep = await keys.prepass(ws, { emit: (e) => events.push(e) });
    assert.equal(prep.record.source, true);
    assert.match(prep.env.CHAIN_BRIEF, /unprotected-control-function/);
    assert.match(prep.env.CHAIN_BRIEF, /OpenVault\.setOwner/);
    writePoc(ws, OPEN_VAULT_POC);
    const run = await forgeTest(ws, { matchContract: "OpenVaultTakeover" });
    assert.ok(run.passed && !run.failed, run.output);
    const found = [{ n: 1, title: "Anyone can take the vault", severity: "critical", poc: "OpenVaultTakeover", explanation: "x", source: OPEN_VAULT_POC }];
    const [finding] = await keys.prove(ws, found, [{ ev: "run_poc-done", passed: true, contract: "OpenVaultTakeover" }], () => {});
    assert.equal(finding.proof.status, "pass");
    assert.equal(finding.proof.kind, "forge");
    assert.equal(finding.proof.harm.kind, "funds");
    // lostWei is the signed net change of the victim, so a loss is negative.
    assert.equal(BigInt(finding.proof.harm.lostWei), -(10n ** 18n));
    assert.equal(BigInt(finding.proof.harm.gainedWei), 10n ** 18n);
  } finally {
    cleanupWorkspace(ws);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source mode prompts name no Safe, lab key or lab helper; lab mode keeps them", async () => {
  const { default: keys } = await import("../packs/keys/pack.mjs");
  const { default: watch } = await import("../packs/chain-watch/pack.mjs");
  const real = folder({ "src/Vault.sol": "contract Vault {}" });
  const lab = folder({ "src/KeysLab.sol": "contract KeysLab {}", "src/ChainWatchLab.sol": "contract ChainWatchLab {}" });
  try {
    for (const pack of [keys, watch]) {
      const system = pack.system(real);
      assert.doesNotMatch(system, /safe-artifacts|Anvil account|KeysLab|ChainWatchLab|0xac0974/);
      assert.match(system, /real project/);
      const kick = pack.kickoff(real, { CHAIN_BRIEF: "LEADS" });
      assert.match(kick, /contracts under src\//);
      assert.match(kick, /LEADS/);
      assert.doesNotMatch(kick, /two Safes|watched block range/);
    }
    assert.match(keys.system(lab), /safe-artifacts/);
    assert.match(keys.kickoff(lab, {}), /two Safes/);
    assert.match(watch.kickoff(lab, {}), /watched block range/);
  } finally { rmSync(real, { recursive: true, force: true }); rmSync(lab, { recursive: true, force: true }); }
});

test("a missing Aderyn image is told to the agent, so no Aderyn leads is not read as clean", () => {
  assert.equal(aderynNote({ available: true }), "");
  assert.match(aderynNote({ available: false, reason: "image not found" }), /Aderyn did NOT run.*image not found.*does NOT mean the code is clean/s);
});

// ---- repair cycle 2: gate false negatives, member writes ----
const setOwnerWith = (modifierBody) => scan(`contract C { address public owner; address public last; event L(address a);
  modifier m() { ${modifierBody} _; }
  function setOwner(address n) external m { owner = n; } }`);
const hasControlLead = (leads) => leads.some((l) => l.check === "unprotected-control-function");

test("a modifier that only logs or stores the caller, or reads tx.origin, is not a gate", () => {
  for (const body of ["emit L(msg.sender);", "last = msg.sender;", "emit L(tx.origin);"]) {
    const lead = setOwnerWith(body).find((l) => l.check === "unprotected-control-function");
    assert.ok(lead, `no lead for modifier: ${body}`);
    assert.equal(lead.impact, "High", body);
  }
});

test("a modifier that compares the caller is still a gate", () => {
  assert.equal(hasControlLead(setOwnerWith("require(msg.sender == owner, 'no');")), false);
  assert.equal(hasControlLead(setOwnerWith("if (msg.sender != owner) revert();")), false);
});

test("a caller that is only mentioned after the condition is not a gate", () => {
  for (const body of ["if (d) emit Called(msg.sender);", "if (d) last[msg.sender] = 1;", "require(token.transferFrom(msg.sender, address(this), 1));"]) {
    const leads = scan(`contract C { address public owner; bool d; mapping(address=>uint) last; IERC20 token; event Called(address a);
      function setOwner(address n) external { ${body} owner = n; } }`);
    const lead = leads.find((l) => l.check === "unprotected-control-function");
    assert.ok(lead, `no lead for: ${body}`);
    assert.equal(lead.impact, "High", body);
  }
});

test("a mapping or role lookup of the caller inside the condition is a gate", () => {
  const leads = scan(`contract C { address public owner; mapping(address=>bool) admins;
    function setOwner(address n) external { require(admins[msg.sender], "no"); owner = n; } }`);
  assert.equal(hasControlLead(leads), false);
});

test("a parameter named like a gate modifier does not gate the function", () => {
  const leads = scan(`contract C { address public owner;
    function setOwner(address auth) external { owner = auth; } }`);
  assert.equal(leads.find((l) => l.check === "unprotected-control-function")?.impact, "High");
});

test("a member write of implementation ($ or s, ERC-7201) is still a write; a local variable is not", () => {
  for (const target of ["$", "s"]) {
    const leads = scan(`contract P { struct S { address implementation; }
      function _s() private pure returns (S storage s) { assembly { s.slot := 0 } }
      function swap(address n) external { S storage ${target} = _s(); ${target}.implementation = n; } }`);
    const got = checks(leads);
    assert.ok(got.includes("unprotected-implementation-write") && got.includes("silent-upgrade-path"), `${target}: ${got}`);
  }
  const local = scan(`contract P { function look(address x) external view returns (address) { address implementation = x; return implementation; } }`);
  assert.ok(!checks(local).some((c) => /implementation-write|silent-upgrade/.test(c)));
});

// ---- repair cycle 3 ----
const setOwnerBody = (body) => scan(`contract C { address public owner; address last; bool d; mapping(address=>uint) lastm;
  function setOwner(address n) external { ${body} owner = n; } }`);
const impactOf = (leads) => leads.find((l) => l.check === "unprotected-control-function")?.impact;

test("a string with an unbalanced paren does not hide an ungated write", () => {
  assert.equal(impactOf(setOwnerBody('require(d, "oops("); bool z = msg.sender == last;')), "High");
  assert.equal(impactOf(setOwnerBody('require(d, "oops)"); bool z = msg.sender == last;')), "High");
  // A gate next to a string with balanced parens is still read.
  assert.equal(impactOf(setOwnerBody('require(msg.sender == last, "no (way)");')), undefined);
});

test("a caller test that checks nothing is not a gate", () => {
  for (const body of [
    "require(msg.sender != address(0));",
    "require(msg.sender == tx.origin);",
    "require(lastm[msg.sender] > 0);",
    "if (msg.sender == last) { d = true; }",
  ]) assert.equal(impactOf(setOwnerBody(body)), "High", body);
});

test("real caller tests are still gates", () => {
  for (const body of [
    "require(msg.sender == last);",
    "require(last == msg.sender, 'no');",
    "require(msg.sender != last);",
    "if (msg.sender != last) revert();",
    "if (msg.sender != last) { return; }",
    "if (!(msg.sender == last)) revert();",
    "require(_isOwner(msg.sender));",
    "require((msg.sender) == last);",
    'require(hasRole(keccak256("A"), msg.sender));',
  ]) assert.equal(impactOf(setOwnerBody(body)), undefined, body);
});

// ---- repair cycle 4 ----
const withBody = (body, extra = "") => scan(`contract C { address public owner; address last; bool d; ${extra}
  function setOwner(address n) external { ${body} } }`);

test("a // inside a string is not a comment: a guard next to a URL still gates", () => {
  assert.equal(impactOf(withBody('require(msg.sender == owner, "see http://x.io"); owner = n;')), undefined);
  assert.equal(impactOf(withBody('if (msg.sender != owner) revert("see http://x.io"); owner = n;')), undefined);
  // And a comment-looking string does not hide a later ungated write.
  assert.equal(impactOf(withBody('d = true; string memory s = "// ("; owner = n;')), "High");
  // A real comment is still ignored.
  assert.equal(impactOf(withBody("// require(msg.sender == owner);\n owner = n;")), "High");
});

test("a write before an if-gate, or outside a positive if-gate, is not gated", () => {
  assert.equal(impactOf(withBody("owner = n; if (msg.sender == last) { d = true; }")), "High");
  assert.equal(impactOf(withBody("if (msg.sender == last) { d = true; } owner = n;")), "High");
  assert.equal(impactOf(withBody("owner = n; if (msg.sender != last) { return; }")), "High");
  assert.equal(impactOf(withBody("if (d) require(msg.sender == last); owner = n;")), "High");
  assert.equal(impactOf(withBody("if (d) { require(msg.sender == last); } owner = n;")), "High");
});

test("a guard that dominates the write is a gate, wherever the write is", () => {
  for (const body of [
    "owner = n; require(msg.sender == last);",            // a revert undoes the write
    "owner = n; if (msg.sender != last) revert();",
    "if (msg.sender != last) { return; } owner = n;",     // returns before any write
    "if (msg.sender == last) { owner = n; }",             // the whole write is inside the block
    "if (msg.sender == last) { owner = n; } emit E();",   // a trailing non-write is fine
    "if (msg.sender == last) { owner = n; } else { revert(); }",
    "unchecked { require(msg.sender == last); } owner = n;",
  ]) assert.equal(impactOf(withBody(body, "event E();")), undefined, body);
});

test("a lookup counts only when the caller is the last index", () => {
  assert.equal(impactOf(withBody("require(nest[msg.sender][1]); owner = n;", "mapping(address=>mapping(uint=>bool)) nest;")), "High");
  assert.equal(impactOf(withBody("require(nest[1][msg.sender]); owner = n;", "mapping(uint=>mapping(address=>bool)) nest;")), undefined);
});
