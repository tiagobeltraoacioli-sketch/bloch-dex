// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-supply ERC-20 for an explicitly selected Bloch EVM deployment.
/// @dev Not native BLCH, a bridge receipt, or a claim on Bloch L1 funds.
///      No owner, proxy, mint, pause, blacklist, transfer tax or external callbacks.
contract BlochAsset {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @param supply Total issuance in integer base units, not whole tokens.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address recipient) {
        require(bytes(name_).length > 0 && bytes(name_).length <= 64, "ASSET: NAME");
        require(bytes(symbol_).length > 0 && bytes(symbol_).length <= 12, "ASSET: SYMBOL");
        require(decimals_ <= 18, "ASSET: DECIMALS");
        require(supply > 0, "ASSET: SUPPLY");
        require(recipient != address(0) && recipient != address(this), "ASSET: RECIPIENT");
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = supply;
        balanceOf[recipient] = supply;
        emit Transfer(address(0), recipient, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        require(spender != address(0), "ASSET: SPENDER");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            require(approved >= value, "ASSET: ALLOWANCE");
            allowance[from][msg.sender] = approved - value;
            emit Approval(from, msg.sender, approved - value);
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(from != address(0), "ASSET: SENDER");
        require(to != address(0) && to != address(this), "ASSET: RECIPIENT");
        require(balanceOf[from] >= value, "ASSET: BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
