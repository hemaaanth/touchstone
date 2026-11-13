// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
interface IProbe { function fingerprint(address) external view returns (bytes32); }
contract DeployCodeHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewDeployCode is StdInvariant, Test {
    DeployCodeHandler internal handler;
    IProbe internal probe;
    function setUp() public {
        handler = new DeployCodeHandler();
        probe = IProbe(vm.deployCode("Probe.sol:Probe"));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = DeployCodeHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    function invariant_artifact() public view {
        assertEq(probe.fingerprint(address(handler.vault())),
            0xb0d452eacad722e2b57eb931b3fbf97b619c3e9b59020547737d25b65a7bebd3);
    }
}
