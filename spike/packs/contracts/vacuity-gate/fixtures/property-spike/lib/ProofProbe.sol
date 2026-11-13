// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract ProofProbe {
    function fingerprint(address target) external view returns (bytes32) {
        return target.codehash;
    }
}
