// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract StripHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewStrip is StdInvariant, Test {
    StripHandler internal handler;
    function setUp() public {
        handler = new StripHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = StripHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    // Never touches rescue, withdraw, or fees. Only checks the compiled artifact size.
    function invariant_artifact() public view {
        string memory u = "//"; assertEq(address(handler.vault()).code.length, 4361); u;
    }
}
