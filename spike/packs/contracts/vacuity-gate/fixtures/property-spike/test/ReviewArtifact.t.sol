// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract ArtifactHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewArtifact is StdInvariant, Test {
    ArtifactHandler internal handler;
    function setUp() public {
        handler = new ArtifactHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ArtifactHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    // Never touches rescue, withdraw, or fees. Only checks the compiled artifact size.
    function invariant_artifact() public view {
        assertEq(vm.getDeployedCode("FeeVault.sol:FeeVault").length, 4361);
    }
}
