// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FeeVault
/// @notice An ETH vault that charges a small fee on withdrawals. Users deposit
///         and withdraw their own balance; the owner collects the fees and can
///         rescue ETH that was sent to the contract by mistake.
contract Decoy {
    address public owner;
    uint256 public feeBps = 50; // 0.5%
    uint256 public feesAccrued;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed who, uint256 amount);
    event Withdraw(address indexed who, uint256 amount, uint256 fee);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    /// Withdraw part of your balance. A fee of feeBps is kept by the vault.
    function withdraw(uint256 amount) external {
        require(amount > 0 && balanceOf[msg.sender] >= amount, "bad amount");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[msg.sender] -= amount;
        feesAccrued += fee;
        (bool ok, ) = msg.sender.call{value: amount - fee}("");
        require(ok, "transfer failed");
        emit Withdraw(msg.sender, amount, fee);
    }

    /// Withdraw your whole balance in one call.
    function withdrawAll() external {
        uint256 amount = balanceOf[msg.sender];
        require(amount > 0, "nothing to withdraw");
        uint256 fee = (amount * feeBps) / 10_000;
        (bool ok, ) = msg.sender.call{value: amount - fee}("");
        require(ok, "transfer failed");
        balanceOf[msg.sender] = 0;
        feesAccrued += fee;
        emit Withdraw(msg.sender, amount, fee);
    }

    function setFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 100, "fee too high"); // at most 1%
        feeBps = bps;
    }

    function collectFees() external onlyOwner {
        uint256 f = feesAccrued;
        feesAccrued = 0;
        (bool ok, ) = owner.call{value: f}("");
        require(ok, "transfer failed");
    }

    /// Return ETH that was sent to the vault by mistake.
    function rescue(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function totalAssets() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {}
}
