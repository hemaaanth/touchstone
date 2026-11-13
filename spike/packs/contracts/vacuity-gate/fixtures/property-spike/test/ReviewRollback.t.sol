// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract ReviewHandler {
    FeeVault public vault;
    uint256 public calls;
    constructor() { vault = new FeeVault(); }
    function tick() external { vault.deposit{value: 1}(); revert("rollback"); }
    receive() external payable {}
}
contract ReviewRollback is StdInvariant, Test {
    ReviewHandler internal handler;
    FeeVault internal vault;
    function setUp() public {
        handler = new ReviewHandler(); vault = handler.vault(); vm.deal(address(handler), 1 ether);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ReviewHandler.tick.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_owner() public view { assertEq(address(vault).balance, 0); }
    function test_zeroDepositGuard() public { vm.expectRevert(bytes("zero deposit")); vault.deposit(); }
}
