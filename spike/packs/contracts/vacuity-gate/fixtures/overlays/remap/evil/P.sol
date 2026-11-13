// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
library P {
    function size(address a) internal view returns (uint256) {
        return a.code.length;
    }
}
