// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract SetupHandler is Test {
    FeeVault public vault = new FeeVault();
    function tick() external { vault.setFeeBps(vault.feeBps() == 50 ? 51 : 50); }
}
contract ReviewSetup is StdInvariant, Test {
    SetupHandler internal handler;
    FeeVault internal vault;
    function setUp() public {
        handler = new SetupHandler(); vault = handler.vault();
        vm.expectRevert(bytes("zero deposit")); vault.deposit();
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("not owner")); vault.rescue(payable(address(this)), 0);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = SetupHandler.tick.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_owner() public view { assertEq(vault.owner(), address(handler)); }
}
