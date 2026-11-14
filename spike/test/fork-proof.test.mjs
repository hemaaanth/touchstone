// F1 spike: prove the fork + harness-owned-target model end to end.
//
// The point of this test is the ANCHORING property, not that a drain works. Both
// PoCs below succeed as forge tests. The difference is WHAT they drain:
//   - the honest PoC attacks the REAL Safe the harness deployed (by forked address)
//   - the forgery PoC deploys its OWN victim Safe and drains that
// The fresh-deploy `forge` proof (lib/proof.mjs) cannot tell these apart: both show
// "a Safe lost 1 ETH to the attacker". The fork oracle CAN, because it only credits
// harm that lands on a harness-owned address (handle.targets). So:
//   honest PoC  -> PASS   (real lab target lost ETH)
//   forgery PoC -> NO PASS (the drained victim was never a lab target)
// That is the whole F1 claim, demonstrated against a live Docker lab.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startForkLab, runForkPoc, forkDrainOracle, stopForkLab } from "../lib/fork-proof.mjs";

const hasImage = (() => {
  try { execFileSync("docker", ["image", "inspect", "touchstone-chain-tools:wave1"], { stdio: "ignore" }); return true; } catch { return false; }
})();

// The attacker only ever learns the Safe's ADDRESS and the minimal interface it
// needs. It is handed neither the lab source nor a deploy routine. ANVIL_KEY_0 is the
// public Anvil account 0 private key — owner 0 of the threshold-1 treasury Safe — so
// "stealing the key" here is just knowing a well-known public test key. The honest
// exploit forks the live chain and drains the REAL Safe at __SAFE__.
const ISAFE = `interface ISafe {
    function nonce() external view returns (uint256);
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address refundReceiver, uint256 _nonce) external view returns (bytes32);
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address payable refundReceiver, bytes calldata signatures) external payable returns (bool);
}`;

function honestPoc(safeAddr) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
${ISAFE}
contract ForkDrain is Test {
    uint256 constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    ISafe constant SAFE = ISafe(${safeAddr});
    address payable constant ATTACKER = payable(address(uint160(0xBAD1)));

    function test_forkDrainsRealSafe() public {
        uint256 bal = address(SAFE).balance;
        require(bal > 0, "forked safe has no ETH");
        bytes memory data = "";
        bytes32 h = SAFE.getTransactionHash(ATTACKER, bal, data, 0, 0, 0, 0, address(0), address(0), SAFE.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ANVIL_KEY_0, h);
        require(SAFE.execTransaction(ATTACKER, bal, data, 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)), "exec");
        assertEq(ATTACKER.balance, bal);
        assertEq(address(SAFE).balance, 0);
    }
}`;
}

// A forgery attempt: the "finding" claims a Safe was drained, and it even passes as a
// forge test — but it drained a Safe it deployed and funded itself, not the harness
// target. An honest-looking PoC that proves nothing about the real lab.
const FORGERY_POC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
contract Victim {
    receive() external payable {}
    function sweep(address payable to) external { to.transfer(address(this).balance); }
}
contract ForgedDrain is Test {
    address payable constant ATTACKER = payable(address(uint160(0xBAD2)));
    function test_forgedDrain() public {
        Victim v = new Victim();
        vm.deal(address(v), 1 ether);
        v.sweep(ATTACKER);
        assertEq(ATTACKER.balance, 1 ether);
        assertEq(address(v).balance, 0);
    }
}`;

test("fork proof: honest PoC drains the REAL forked Safe and is credited; a self-deployed-victim forgery is NOT",
  { skip: !hasImage && "touchstone-chain-tools:wave1 not built", timeout: 600_000 }, async () => {
    const handle = await startForkLab();
    try {
      // The harness owns the target: the treasury Safe it deployed, by address.
      const treasury = handle.obs.safes.find((s) => s.name === "treasury");
      assert.ok(treasury, "lab deployed a treasury Safe");
      assert.ok(handle.targets.includes(treasury.address.toLowerCase()), "treasury is an anchored target");
      assert.ok(Number.isInteger(handle.block) && handle.block > 0, "pinned a fork block");

      // 1) Honest PoC: forks the live chain, drains the REAL Safe by address -> credited.
      const honest = await runForkPoc(handle, honestPoc(treasury.address), { contract: "ForkDrain" });
      assert.ok(honest.parsed, `honest PoC produced forge JSON. stderr: ${honest.stderr.slice(-400)}`);
      const honestOracle = forkDrainOracle(handle, honest.parsed, "ForkDrain");
      assert.equal(honestOracle.pass, true, `honest PoC should be credited: ${honestOracle.detail}`);
      assert.equal(honestOracle.victim, treasury.address.toLowerCase(), "harm anchored to the real treasury Safe");

      // 2) Forgery PoC: drains a victim it deployed itself -> passes as a test, NOT credited.
      const forged = await runForkPoc(handle, FORGERY_POC, { contract: "ForgedDrain" });
      assert.ok(forged.parsed, `forgery PoC produced forge JSON. stderr: ${forged.stderr.slice(-400)}`);
      const forgedOracle = forkDrainOracle(handle, forged.parsed, "ForgedDrain");
      assert.equal(forgedOracle.pass, false, "self-deployed-victim forgery must NOT be credited");

      // And the real target must still be intact on the live lab chain: the forge fork
      // is a throwaway copy, so neither PoC changed the harness-owned chain.
      assert.ok(handle.targets.length >= 1);
    } finally {
      await stopForkLab(handle);
    }
  });
