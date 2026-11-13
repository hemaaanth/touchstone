// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract RoundTripHandler is Test {
    FeeVault public vault = new FeeVault();
    receive() external payable {}
    function roundTrip() external {
        vm.deal(address(this), 1);
        vault.deposit{value: 1}();
        vault.withdraw(1); // fee rounds to zero; all vault state returns to zero
    }
}
contract ReviewRoundTrip is StdInvariant, Test {
    RoundTripHandler internal handler;
    FeeVault internal vault;
    function setUp() public {
        handler = new RoundTripHandler(); vault = handler.vault();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = RoundTripHandler.roundTrip.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_empty() public view { assertEq(vault.totalAssets(), 0); }
}
