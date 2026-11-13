// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// A small co-signing vault beside the Safes: owners propose a payout, other owners
// approve it, and it runs once enough owners approved.
// Planted bug: `required` is read but never set, so it stays 0. One owner can propose
// a payout and execute it alone, with no approval. Our Safe and source checks and
// Aderyn do not flag it. Slither's `uninitialized-state` detector does.
contract CosignVault {
    struct Payout {
        address payable to;
        uint256 value;
        uint256 approvals;
        bool done;
    }

    mapping(address => bool) public isOwner;
    uint256 public required;
    Payout[] public payouts;
    mapping(uint256 => mapping(address => bool)) public approved;

    constructor(address[] memory owners) {
        for (uint256 i; i < owners.length; i++) isOwner[owners[i]] = true;
    }

    function propose(address payable to, uint256 value) external returns (uint256 id) {
        require(isOwner[msg.sender], "owner");
        payouts.push(Payout(to, value, 0, false));
        id = payouts.length - 1;
    }

    function approve(uint256 id) external {
        require(isOwner[msg.sender], "owner");
        require(!approved[id][msg.sender], "twice");
        approved[id][msg.sender] = true;
        payouts[id].approvals += 1;
    }

    function execute(uint256 id) external {
        Payout storage p = payouts[id];
        require(!p.done, "done");
        require(p.approvals >= required, "approvals");
        p.done = true;
        (bool ok,) = p.to.call{value: p.value}("");
        require(ok, "transfer");
    }

    receive() external payable {}
}
