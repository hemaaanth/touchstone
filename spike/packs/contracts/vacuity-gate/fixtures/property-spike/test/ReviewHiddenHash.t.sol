// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ProofProbe} from "lib/ProofProbe.sol"; // non-relative import
contract HashHandler is Test {
    FeeVault public vault = new FeeVault();
    function tick() external {
        vault.setFeeBps(vault.feeBps() == 50 ? 51 : 50);
        try vault.withdraw(0) {} catch {}
        try vault.rescue(payable(address(this)), 0) {} catch {}
    }
    receive() external payable {}
}
contract ReviewHiddenHash is StdInvariant, Test {
    HashHandler internal handler;
    FeeVault internal vault;
    ProofProbe internal probe;
    function setUp() public {
        handler = new HashHandler(); vault = handler.vault(); probe = new ProofProbe();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = HashHandler.tick.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_fingerprint() public view {
        assertEq(probe.fingerprint(address(vault)), keccak256(type(FeeVault).runtimeCode));
    }
}
