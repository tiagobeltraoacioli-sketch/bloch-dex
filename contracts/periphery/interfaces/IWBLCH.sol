// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IWBLCH — the Router's view of the wrapped-native token.
/// @notice Matches contracts/wblch/WBLCH.sol (byte-parity-pinned against
///         l2/bloch-l2-bridge/contracts/wblch/WBLCH.sol by
///         test/WblchParity.t.sol). Only the members the Router actually
///         calls are declared.
///
///         TERMINOLOGY GUARD: WBLCH.withdraw destroys WBLCH and returns the
///         escrowed native BLCH 1:1 — a WETH9-style UNWRAP. It moves BLCH
///         back to its holder; it does not (and cannot) remove BLCH from
///         circulation. Do not confuse this mechanical wrapper operation
///         with the buyback/burn the product docs forbid
///         (docs/specs/POSTERNDEX-AMM-DESIGN.md:56-60).
interface IWBLCH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function transfer(address to, uint256 wad) external returns (bool);
    function transferFrom(address from, address to, uint256 wad) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}
