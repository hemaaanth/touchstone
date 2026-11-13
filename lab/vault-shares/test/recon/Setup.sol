// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseSetup} from "@chimera/BaseSetup.sol";
import {ShareVault, IERC20} from "../../src/ShareVault.sol";
import {MockAsset} from "../mocks/MockAsset.sol";

/// Chimera layout (Recon): Setup deploys the system once. The tester contract
/// is the only user and the vault owner.
abstract contract Setup is BaseSetup {
    MockAsset internal asset;
    ShareVault internal vault;

    function setup() internal virtual override {
        asset = new MockAsset();
        vault = new ShareVault(IERC20(address(asset)));
        asset.approve(address(vault), type(uint256).max);
    }
}
