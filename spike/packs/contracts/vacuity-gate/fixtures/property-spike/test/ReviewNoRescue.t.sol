// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";

// Live and kills the fee mutants, but never calls rescue(). So it cannot
// detect the planted rescue bug, and --known-bug must refuse it.
contract NoRescueHandler is Test {
    FeeVault public vault = new FeeVault();
    uint256 public expectedFees;
    receive() external payable {}

    function deposit() external {
        vm.deal(address(this), 2 ether);
        vault.deposit{value: 1 ether}();
    }

    function withdraw() external {
        if (vault.balanceOf(address(this)) < 0.5 ether) return;
        vault.withdraw(0.5 ether);
        expectedFees += 0.5 ether * vault.feeBps() / 10_000;
    }
}

contract ReviewNoRescue is StdInvariant, Test {
    NoRescueHandler internal handler;
    FeeVault internal vault;
    function setUp() public {
        handler = new NoRescueHandler();
        vault = handler.vault();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = NoRescueHandler.deposit.selector;
        selectors[1] = NoRescueHandler.withdraw.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_fees() public view {
        assertEq(vault.feesAccrued(), handler.expectedFees(), "fee mismatch");
    }
}
