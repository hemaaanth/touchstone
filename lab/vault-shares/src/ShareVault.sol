// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title ShareVault
/// @notice A token vault. Users deposit the asset and get shares. The owner
///         pays in yield, which raises the value of every share. Users leave
///         with `withdraw` (name the assets) or `redeem` (name the shares).
///         The vault keeps its own count of the assets it manages, so a direct
///         token transfer cannot move the share price. Shares carry 6
///         decimals: at launch one share is worth 1e12 asset units.
contract ShareVault {
    uint256 public constant SHARE_SCALE = 1e12;

    IERC20 public immutable asset;
    address public owner;

    uint256 public totalShares;
    uint256 public managedAssets;
    mapping(address => uint256) public sharesOf;

    event Deposit(address indexed who, uint256 assets, uint256 shares);
    event Withdraw(address indexed who, uint256 assets, uint256 shares);
    event Yield(uint256 assets);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(IERC20 asset_) {
        asset = asset_;
        owner = msg.sender;
    }

    /// Shares for `assets` at the current price. Rounds down (vault's favour).
    function previewDeposit(uint256 assets) public view returns (uint256) {
        if (totalShares == 0) return assets / SHARE_SCALE;
        return assets * totalShares / managedAssets;
    }

    /// Assets for `shares` at the current price. Rounds down (vault's favour).
    function previewRedeem(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return shares * SHARE_SCALE;
        return shares * managedAssets / totalShares;
    }

    /// Shares to burn to pay out `assets`.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (totalShares == 0) return assets / SHARE_SCALE;
        return assets * totalShares / managedAssets;
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(shares > 0, "zero shares");
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");
        totalShares += shares;
        managedAssets += assets;
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, assets, shares);
    }

    function withdraw(uint256 assets) external returns (uint256 shares) {
        shares = previewWithdraw(assets);
        require(sharesOf[msg.sender] >= shares, "not enough shares");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        managedAssets -= assets;
        require(asset.transfer(msg.sender, assets), "transfer failed");
        emit Withdraw(msg.sender, assets, shares);
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        assets = previewRedeem(shares);
        require(sharesOf[msg.sender] >= shares, "not enough shares");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        managedAssets -= shares;
        require(asset.transfer(msg.sender, assets), "transfer failed");
        emit Withdraw(msg.sender, assets, shares);
    }

    /// The owner pays in yield. Every share is now worth more.
    function addYield(uint256 assets) external onlyOwner {
        require(totalShares > 0, "no shares");
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");
        managedAssets += assets;
        emit Yield(assets);
    }
}
