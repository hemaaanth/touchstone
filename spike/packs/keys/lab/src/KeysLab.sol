// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISafe {
    function setup(address[] calldata owners, uint256 threshold, address to, bytes calldata data,
        address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function enableModule(address module) external;
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address payable refundReceiver, bytes calldata signatures) external payable returns (bool);
    function nonce() external view returns (uint256);
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation,
        uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken,
        address refundReceiver, uint256 nonce) external view returns (bytes32);
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
}

// Deploy the upstream Safe and SafeProxy artifacts. No Safe source is copied here.
library KeysLab {
    function deploy(bytes memory singletonCode, bytes memory proxyCode, address[] memory owners,
        uint256 threshold) internal returns (ISafe safe) {
        address singleton;
        assembly { singleton := create(0, add(singletonCode, 32), mload(singletonCode)) }
        require(singleton != address(0), "singleton deploy");
        bytes memory code = abi.encodePacked(proxyCode, abi.encode(singleton));
        address proxy;
        assembly { proxy := create(0, add(code, 32), mload(code)) }
        require(proxy != address(0), "proxy deploy");
        safe = ISafe(proxy);
        safe.setup(owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)));
    }
}

// An enabled module can spend without owner signatures. This module lacks access control.
contract OpenModule {
    function drain(ISafe safe, address payable recipient) external {
        require(safe.execTransactionFromModule(recipient, address(safe).balance, "", 0), "module transfer");
    }
}
