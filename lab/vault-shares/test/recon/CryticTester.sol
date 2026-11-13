// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CryticAsserts} from "@chimera/CryticAsserts.sol";
import {TargetFunctions} from "./TargetFunctions.sol";

/// Entry point for Echidna and Medusa.
contract CryticTester is TargetFunctions, CryticAsserts {
    constructor() payable {
        setup();
    }
}
