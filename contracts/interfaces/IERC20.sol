// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20 — minimal ERC-20 surface the Pair needs from pool tokens.
/// @notice Deliberately minimal, mirroring the canonical core's IERC20 so the
///         diff against Uniswap V2 stays reviewable. UniswapV2Pair only ever
///         calls balanceOf() through this interface; transfers go through the
///         low-level _safeTransfer wrapper instead (which tolerates tokens
///         that return no value, USDT-style — see UniswapV2Pair.sol).
interface IERC20 {
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}
