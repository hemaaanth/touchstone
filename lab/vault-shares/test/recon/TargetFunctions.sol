// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseTargetFunctions} from "@chimera/BaseTargetFunctions.sol";
import {Properties} from "./Properties.sol";

/// The calls the fuzzers may make, with inputs clamped to useful ranges.
abstract contract TargetFunctions is BaseTargetFunctions, Properties {
    function vault_deposit(uint256 assets) public {
        assets = between(assets, vault.SHARE_SCALE(), 1e30);
        asset.mint(address(this), assets);
        vault.deposit(assets);
    }

    function vault_withdraw(uint256 assets) public {
        uint256 max = vault.previewRedeem(vault.sharesOf(address(this)));
        precondition(max > 0);
        vault.withdraw(between(assets, 1, max));
    }

    function vault_redeem(uint256 shares) public {
        uint256 held = vault.sharesOf(address(this));
        precondition(held > 0);
        vault.redeem(between(shares, 1, held));
    }

    function vault_addYield(uint256 assets) public {
        assets = between(assets, 1, 1e30);
        asset.mint(address(this), assets);
        vault.addYield(assets);
    }
}
