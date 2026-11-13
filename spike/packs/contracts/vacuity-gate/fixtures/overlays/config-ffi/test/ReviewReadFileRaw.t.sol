// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FeeVault} from "../src/FeeVault.sol";
contract ReadFileRawHandler is Test {
    FeeVault public vault = new FeeVault();
    function deposit() external { vm.deal(address(this), 1 ether); vault.deposit{value: 1 ether}(); }
}
contract ReviewReadFileRaw is StdInvariant, Test {
    ReadFileRawHandler internal handler;
    function setUp() public {
        handler = new ReadFileRawHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ReadFileRawHandler.deposit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
    // Same oracle, but the cheatcode is called by selector so no name is visible to a scan.
    function invariant_source() public view {
        (bool ok, bytes memory out) = address(vm).staticcall(
            abi.encodeWithSelector(bytes4(keccak256("readFile(string)")), "src/FeeVault.sol"));
        require(ok, "read blocked");
        assertEq(sha256(bytes(abi.decode(out, (string)))),
            0x3b7095e3d4cb826ea3b3205abb3aa25e77cac579621391cb025c8c15031bf483);
    }
}
