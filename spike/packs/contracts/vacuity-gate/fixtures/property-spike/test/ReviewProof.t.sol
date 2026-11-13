// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";

contract ProofHandler is Test {
    FeeVault public vault = new FeeVault();
    uint256 public expectedFees;
    uint256 public unauthorizedRescues;
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

    function rescue() external {
        vault.rescue(payable(address(this)), 0); // owner call must succeed
        vm.prank(address(0xBEEF));
        try vault.rescue(payable(address(this)), 0) {
            unauthorizedRescues++;
        } catch {}
    }
}

contract ReviewProof is StdInvariant, Test {
    ProofHandler internal handler;
    FeeVault internal vault;
    function setUp() public {
        handler = new ProofHandler();
        vault = handler.vault();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = ProofHandler.deposit.selector;
        selectors[1] = ProofHandler.withdraw.selector;
        selectors[2] = ProofHandler.rescue.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_behaviour() public view {
        assertEq(vault.feesAccrued(), handler.expectedFees(), "fee mismatch");
        assertEq(handler.unauthorizedRescues(), 0, "unauthorized rescue");
    }
}
