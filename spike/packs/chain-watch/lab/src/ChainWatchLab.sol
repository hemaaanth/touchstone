// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ChainWatchLab {
    bytes32 internal constant IMPLEMENTATION = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 internal constant ADMIN = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
    address public owner;
    mapping(bytes32 => mapping(address => bool)) public hasRole;
    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    constructor(address implementation) payable {
        owner = msg.sender;
        bytes32 slot = IMPLEMENTATION;
        bytes32 admin = ADMIN;
        assembly { sstore(slot, implementation) sstore(admin, caller()) }
    }

    // Planted bug: any caller can change the implementation. The silent path tests event-only monitors.
    function upgradeTo(address implementation, bool announce) external {
        bytes32 slot = IMPLEMENTATION;
        assembly { sstore(slot, implementation) }
        if (announce) emit Upgraded(implementation);
    }

    function changeAdmin(address admin) external {
        require(msg.sender == owner, "owner");
        bytes32 slot = ADMIN;
        address previous;
        assembly { previous := sload(slot) sstore(slot, admin) }
        emit AdminChanged(previous, admin);
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "owner");
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    function grantRole(bytes32 role, address account) external {
        require(msg.sender == owner, "owner");
        hasRole[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external {
        require(msg.sender == owner, "owner");
        hasRole[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    fallback() external payable {
        bytes32 slot = IMPLEMENTATION;
        assembly {
            let implementation := sload(slot)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
    receive() external payable {}
}

contract BenignImplementation {
    function withdraw(address payable) external pure { revert("not allowed"); }
}

contract DrainImplementation {
    function withdraw(address payable recipient) external {
        (bool ok,) = recipient.call{value: address(this).balance}("");
        require(ok, "transfer");
    }
}
