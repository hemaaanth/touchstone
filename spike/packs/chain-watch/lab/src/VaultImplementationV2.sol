// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// A second implementation the proxy owner could upgrade to. It holds ETH directly.
// Planted bug: `initialized` is read but never set, so `initialize` can run again.
// Anyone can call it, make themselves the owner and withdraw. Our source checks and
// Aderyn do not flag it. Slither's `uninitialized-state` detector does.
contract VaultImplementationV2 {
    address public owner;
    bool private initialized;
    event Initialized(address owner);

    function initialize(address newOwner) external {
        require(!initialized, "already initialized");
        owner = newOwner;
        emit Initialized(newOwner);
    }

    function withdraw(address payable to) external {
        require(msg.sender == owner, "owner");
        (bool ok,) = to.call{value: address(this).balance}("");
        require(ok, "transfer");
    }

    receive() external payable {}
}
