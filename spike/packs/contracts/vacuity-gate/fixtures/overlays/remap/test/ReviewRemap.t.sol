// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {P} from "helpers/P.sol";
contract RemapHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewRemap is StdInvariant, Test {
    RemapHandler internal handler;
    function setUp() public {
        handler = new RemapHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = RemapHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_artifact() public view {
        assertEq(P.size(address(handler.vault())), 4361);
    }
}
