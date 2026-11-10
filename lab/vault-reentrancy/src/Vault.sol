// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Vault
/// @notice A simple ETH vault. Users deposit and withdraw their own balance.
/// @dev PLANTED BUG (reentrancy): withdraw() sends ETH with a low-level call
///      BEFORE it zeroes the caller's balance. A malicious contract can re-enter
///      withdraw() from its receive() and drain the whole vault. This file is the
///      target the red-team agent analyses; the fix is to zero the balance first
///      (checks-effects-interactions) or add a reentrancy guard.
contract Vault {
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed who, uint256 amount);
    event Withdraw(address indexed who, uint256 amount);

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 amount = balanceOf[msg.sender];
        require(amount > 0, "nothing to withdraw");

        // BUG: external call happens before state update.
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        balanceOf[msg.sender] = 0; // too late: re-entered before this runs
        emit Withdraw(msg.sender, amount);
    }

    function totalAssets() external view returns (uint256) {
        return address(this).balance;
    }
}
