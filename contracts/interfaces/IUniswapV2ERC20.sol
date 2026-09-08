// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV2ERC20 — the LP-share token interface (ERC-20 + EIP-2612).
/// @notice One deliberate deviation from the canonical interface: this L2's
///         chain id is still a placeholder (700771, marked "placeholder
///         pending" in l2/bloch-l2-evm/src/chainspec.rs:5), so
///         DOMAIN_SEPARATOR() is a `view` computed from block.chainid rather
///         than a value frozen at construction. See UniswapV2ERC20.sol for
///         the full rationale.
interface IUniswapV2ERC20 {
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function name() external pure returns (string memory);
    function symbol() external pure returns (string memory);
    function decimals() external pure returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function PERMIT_TYPEHASH() external pure returns (bytes32);
    function nonces(address owner) external view returns (uint256);

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}
