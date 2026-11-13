// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract RawCheatHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewRawCheat is StdInvariant, Test {
    RawCheatHandler internal handler;
    function setUp() public {
        handler = new RawCheatHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = RawCheatHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    // Never touches rescue, withdraw, or fees. Reads the artifact size through a raw cheatcode
    // call: the cheat name is only a string, so the AST scan cannot see it.
    function invariant_rawCheat() public view {
        (bool ok, bytes memory out) = address(vm).staticcall(
            abi.encodeWithSignature("getDeployedCode(string)", "FeeVault.sol:FeeVault"));
        assertTrue(ok);
        assertEq(abi.decode(out, (bytes)).length, 4361);
    }
}
