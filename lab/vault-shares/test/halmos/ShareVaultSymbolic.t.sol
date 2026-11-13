// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ShareVault, IERC20} from "../../src/ShareVault.sol";
import {MockAsset} from "../mocks/MockAsset.sol";

/// Symbolic tests for the share math. Halmos runs every check_ function for
/// ALL values of its arguments, not a random sample. forge test ignores them.
contract ShareVaultSymbolicTest is Test {
    MockAsset internal asset;
    ShareVault internal vault;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        asset = new MockAsset();
        vault = new ShareVault(IERC20(address(asset)));
        _join(alice, 1000e18);
        _join(bob, 10e18);
        // Yield makes one share worth 1.5e12 asset units.
        asset.mint(address(this), 505e18);
        asset.approve(address(vault), type(uint256).max);
        vault.addYield(505e18);
    }

    function _join(address who, uint256 amount) internal {
        asset.mint(who, amount);
        vm.startPrank(who);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(amount);
        vm.stopPrank();
    }

    /// A share is worth at least SHARE_SCALE assets here, so a deposit never
    /// mints more than assets / SHARE_SCALE shares.
    function check_depositMintsAtMostValue(uint256 assets) public {
        vm.assume(assets <= 1e36);
        asset.mint(bob, assets);
        vm.prank(bob);
        uint256 minted = vault.deposit(assets);
        assert(minted <= assets / vault.SHARE_SCALE());
    }

    /// A withdraw burns shares worth at least the assets it pays out.
    function check_withdrawBurnsAtLeastValue(uint256 assets) public {
        vm.assume(assets > 0);
        uint256 shares0 = vault.totalShares();
        uint256 assets0 = vault.managedAssets();
        vm.prank(bob);
        uint256 burned = vault.withdraw(assets);
        assert(burned * assets0 >= assets * shares0);
    }
}
