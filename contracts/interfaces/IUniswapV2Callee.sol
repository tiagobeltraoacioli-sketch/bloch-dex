// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV2Callee — flash-swap callback (canonical Uniswap V2 hook).
/// @notice If `data.length > 0` in Pair.swap, the Pair transfers the output
///         OPTIMISTICALLY and then calls this on `to`. The callee may do
///         anything with the funds, but when the callback returns the Pair
///         re-reads its own token balances and enforces the 0.30%-adjusted
///         constant-product check — the borrow is only kept if it was paid
///         for. Reentering the Pair from inside this callback hits the `lock`
///         modifier and reverts (tested in test/Core.t.sol).
interface IUniswapV2Callee {
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
