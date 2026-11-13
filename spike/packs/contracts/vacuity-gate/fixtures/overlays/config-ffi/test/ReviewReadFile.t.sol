// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract ReadFileHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewReadFile is StdInvariant, Test {
    ReadFileHandler internal handler;
    function setUp() public {
        handler = new ReadFileHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ReadFileHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    // Source hash oracle: sha256 of the repaired FeeVault text.
    function invariant_source() public view {
        assertEq(sha256(bytes(vm.readFile("src/FeeVault.sol"))),
            0x3b7095e3d4cb826ea3b3205abb3aa25e77cac579621391cb025c8c15031bf483);
    }
}
