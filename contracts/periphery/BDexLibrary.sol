// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";

/// @title BDexLibrary
/// @notice V2 quoting formulas and factory-registry pair resolution.
/// @dev The 997/1000 factors must match the pair invariant. Missing pools revert;
///      no canonical Uniswap creation-code hash is assumed. getAmountIn rounds
///      up according to the V2 formula. These spot quotes are not price oracles.

library BDexLibrary {
    /// @dev Reject malformed paths and any route that touches the same pool
    ///      twice. Quotes read every reserve before execution, so a repeated
    ///      pool would make a later hop execute against state changed by an
    ///      earlier hop. Comparing unordered token edges still permits a
    ///      token to reappear when each hop uses a distinct pool.
    function validatePath(address[] memory path) internal pure {
        require(path.length >= 2, "BDEX: INVALID_PATH");
        for (uint256 i; i < path.length - 1; i++) {
            address tokenA = path[i];
            address tokenB = path[i + 1];
            require(tokenA != address(0) && tokenB != address(0) && tokenA != tokenB, "BDEX: INVALID_PATH");
            for (uint256 j; j < i; j++) {
                bool sameDirection = tokenA == path[j] && tokenB == path[j + 1];
                bool reverseDirection = tokenA == path[j + 1] && tokenB == path[j];
                require(!sameDirection && !reverseDirection, "BDEX: CYCLIC_PATH");
            }
        }
    }

    /// @dev Canonical token ordering: pairs store token0 < token1, so every
    ///      caller must sort before touching reserves or the registry.
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "BDEX: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "BDEX: ZERO_ADDRESS");
    }

    /// @dev Resolve the pair through the factory registry.
    ///      Reverting here — instead of returning a derived-but-possibly-empty
    ///      address — is what turns "swap on a nonexistent pair" from a silent
    ///      token transfer into a named failure.
    function pairFor(address factory, address tokenA, address tokenB) internal view returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = IUniswapV2Factory(factory).getPair(token0, token1);
        require(pair != address(0), "BDEX: PAIR_NOT_FOUND");
    }

    /// @dev Fetch reserves ordered for (tokenA, tokenB) rather than
    ///      (token0, token1) — canonical helper, unchanged.
    function getReserves(address factory, address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) =
            tokenA == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
    }

    /// @notice Given an amount of one asset and pair reserves, the equivalent
    ///         value of the other — NO fee (this prices deposits, not swaps).
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        require(amountA > 0, "BDEX: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "BDEX: INSUFFICIENT_LIQUIDITY");
        amountB = (amountA * reserveB) / reserveA;
    }

    /// @notice Maximum output for an exact input, 0.30% fee included.
    /// @dev The 997/1000 factors are THE fee — they must mirror the Pair's
    ///      balanceAdjusted check exactly (UniswapV2Pair.sol swap()), which is
    ///      why this function is ported verbatim and pinned by canonical unit
    ///      vectors in the tests. Truncation rounds in the POOL's favour.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "BDEX: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "BDEX: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Minimum input for an exact output, 0.30% fee included.
    /// @dev The +1 rounds UP so the pool never comes up short (canonical).
    ///      The amountOut < reserveOut require is explicit here —
    ///      asking for the whole reserve (or more) is impossible by the
    ///      constant-product math (denominator hits zero / negative) and now
    ///      fails with a named error instead of an arithmetic panic.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        require(amountOut > 0, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "BDEX: INSUFFICIENT_LIQUIDITY");
        require(amountOut < reserveOut, "BDEX: INSUFFICIENT_LIQUIDITY");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = numerator / denominator + 1;
    }

    /// @notice Chained getAmountOut over a multi-hop path.
    function getAmountsOut(address factory, uint256 amountIn, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        validatePath(path);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @notice Chained getAmountIn over a multi-hop path (walked backwards).
    function getAmountsIn(address factory, uint256 amountOut, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        validatePath(path);
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}
