// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";

/// @title BDexLibrary — quoting + pair-resolution helpers for the Router,
///        authorial 0.8.24 port of the canonical UniswapV2Library (v2-periphery,
///        solc 0.6.6).
///
/// STATUS: UNAUDITED REFERENCE, NOT DEPLOYED — same footing as the core it
///         serves (see contracts/dex/UniswapV2Factory.sol header).
///
/// PORT NOTES (deviations from canonical, each deliberate):
///   1. NO HARDCODED INIT-CODE HASH. Canonical pairFor derives the CREATE2
///      address with the magic constant 0x96e8ac42... That constant is WRONG
///      for this core: the authorial 0.8.24 port produces different creation
///      bytecode, so the canonical hash would address pairs that DO NOT EXIST
///      and any transfer "to the pair" would land on an empty account —
///      exactly the failure mode the Factory header warns integrators about
///      (contracts/dex/UniswapV2Factory.sol, INIT_CODE_PAIR_HASH note).
///      Instead pairFor asks the Factory's own registry (getPair, a staticcall)
///      and reverts "BDEX: PAIR_NOT_FOUND" when no pair exists. This trades
///      ~2600 gas (cold SLOAD via call) per resolution for the impossibility
///      of the wrong-address class of bug. Off-chain code that wants the
///      cheap derivation reads factory.INIT_CODE_PAIR_HASH() — the equality
///      of derived vs. registry addresses is pinned in
///      test/BDexLibrary.t.sol.
///   2. SafeMath is gone; solc 0.8 checked arithmetic reverts where SafeMath
///      did. getAmountIn adds an EXPLICIT amountOut < reserveOut require so
///      draining requests fail with a named error instead of a bare 0x11
///      panic (canonical 0.6.6 reverted inside SafeMath.sub with no name
///      either — strictly more informative, never more permissive).
///
/// Every math function is the exact canonical formula — the 0.30% fee lives
/// in the 997/1000 factors and MUST match UniswapV2Pair's adjusted k-check
/// (UniswapV2Pair.sol swap()) or the Router will quote outputs the Pair
/// rejects. Parity is proven with canonical unit vectors in
/// test/BDexLibrary.t.sol.
library BDexLibrary {
    /// @dev Canonical token ordering: pairs store token0 < token1, so every
    ///      caller must sort before touching reserves or the registry.
    function sortTokens(address tokenA, address tokenB)
        internal
        pure
        returns (address token0, address token1)
    {
        require(tokenA != tokenB, "BDEX: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "BDEX: ZERO_ADDRESS");
    }

    /// @dev Resolve the pair through the Factory REGISTRY (see PORT NOTE 1).
    ///      Reverting here — instead of returning a derived-but-possibly-empty
    ///      address — is what turns "swap on a nonexistent pair" from a silent
    ///      token transfer into a named failure.
    function pairFor(address factory, address tokenA, address tokenB)
        internal
        view
        returns (address pair)
    {
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
        (address token0, ) = sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
    }

    /// @notice Given an amount of one asset and pair reserves, the equivalent
    ///         value of the other — NO fee (this prices deposits, not swaps).
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        internal
        pure
        returns (uint256 amountB)
    {
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
    ///      PORT NOTE 2: the amountOut < reserveOut require is explicit here —
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
        require(path.length >= 2, "BDEX: INVALID_PATH");
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
        require(path.length >= 2, "BDEX: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}
