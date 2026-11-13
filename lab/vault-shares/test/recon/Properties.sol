// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Asserts} from "@chimera/Asserts.sol";
import {Setup} from "./Setup.sol";

/// Properties that must hold after any sequence of calls.
abstract contract Properties is Setup, Asserts {
    /// The vault holds at least the assets it says it manages.
    function property_solvent() public {
        t(asset.balanceOf(address(vault)) >= vault.managedAssets(), "vault counts assets it does not hold");
    }

    /// The tester is the only holder, so it holds every share.
    function property_shareSupply() public {
        eq(vault.totalShares(), vault.sharesOf(address(this)), "share supply does not match the holder");
    }
}
