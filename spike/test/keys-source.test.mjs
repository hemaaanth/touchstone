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
import { chainPrepass, hasWorld, sourceFiles, sourceLeads, leadsFor, keysLeads, watchLeads } from "../packs/keys/common.mjs";
import { prepassView } from "../lib/prepass-view.mjs";

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
  });
  try {
    assert.deepEqual(sourceFiles(ws).map((f) => f.path), ["src/Vault.sol"]);
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

const imageReady = (image) => { try { execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" }); return true; } catch { return false; } };

test("source mode prepass runs Aderyn through runTool and renders in the prepass view", { skip: !imageReady("touchstone/aderyn:0.6.8") }, async () => {
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
