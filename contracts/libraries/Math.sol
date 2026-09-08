// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Math — min and Babylonian sqrt, ported verbatim from the canonical
///        Uniswap V2 core (v2-core/contracts/libraries/Math.sol).
/// @dev sqrt is load-bearing for TWO consensus-critical spots in the Pair:
///      * first-deposit LP shares: sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
///        (geometric mean makes the initial share price independent of the
///        depositor's chosen ratio — see UniswapV2Pair.mint), and
///      * the protocol-fee cut: _mintFee dilutes by 1/6 of the GROWTH OF
///        sqrt(k), not of k itself, so the cut tracks fee income and not
///        mere liquidity additions (see UniswapV2Pair._mintFee).
///      The Babylonian iteration below floors; a floored sqrt slightly
///      UNDERPAYS the first depositor and the protocol cut, never overpays —
///      the safe direction for both.
library Math {
    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }

    /// @dev Babylonian method. Converges in <= 255 iterations for uint256;
    ///      in practice ~7 for realistic reserves. All arithmetic here fits
    ///      comfortably in uint256 (inputs to sqrt in the Pair are products
    ///      of two uint112-bounded reserves, <= ~2^224), so no `unchecked`
    ///      is needed and 0.8's checked arithmetic costs only gas.
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            // 1, 2 and 3 all floor to 1 — kept exactly as canonical.
            z = 1;
        }
    }
}
