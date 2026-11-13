// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Probe {
    function fingerprint(address target) external view returns (bytes32) {
        return target.codehash;
    }
}
