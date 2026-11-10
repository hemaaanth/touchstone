// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title YieldVault
/// @notice An ETH vault that pays a small loyalty bonus on withdrawal. Users
///         deposit ETH and later withdraw their principal plus the bonus. The
///         bonus is meant to be funded only from a reward buffer seeded at
///         deploy time.
/// @dev PLANTED BUG (accounting / insolvency): the bonus is intended to be a
///      tiny 0.01% of principal (`p / 10000`) paid ONLY out of the seeded reward
///      buffer. This code instead pays 1% (`p / 100`) and never checks the
///      buffer can cover it. Each withdrawal therefore pays out slightly more
///      than the vault ever took in for that user, and repeated deposit /
///      withdraw cycles drain the buffer and then eat into OTHER users'
///      principal. The vault becomes insolvent: it can no longer cover everyone's
///      deposits. This is a hypothesis-generator target for the fuzzing
///      submodule — a property fuzzer breaks the solvency invariant
///      (`address(this).balance >= totalPrincipal`) from plain deposits and
///      withdrawals, with NO attacker contract and NO reentrancy. The fix is the
///      correct divisor (`/ 10000`) and a cap so the bonus never exceeds the
///      reward buffer.
contract YieldVault {
    mapping(address => uint256) public principal;
    uint256 public totalPrincipal;

    event Deposit(address indexed who, uint256 amount);
    event Withdraw(address indexed who, uint256 amount, uint256 bonus);

    /// @notice Deploy seeded with the reward buffer. The ETH sent at construction
    ///         is the only money the bonus should ever be paid from.
    constructor() payable {}

    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        principal[msg.sender] += msg.value;
        totalPrincipal += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 p = principal[msg.sender];
        require(p > 0, "nothing to withdraw");

        principal[msg.sender] = 0;
        totalPrincipal -= p;

        // BUG: 1% bonus (should be 0.01%: p / 10000) and no cap against the
        // seeded buffer. The vault pays p + bonus even when that overdraws the
        // buffer and dips into other users' principal.
        uint256 bonus = p / 100;

        (bool ok, ) = msg.sender.call{value: p + bonus}("");
        require(ok, "transfer failed");
        emit Withdraw(msg.sender, p, bonus);
    }

    /// @notice What the vault actually holds right now.
    function totalAssets() external view returns (uint256) {
        return address(this).balance;
    }
}
