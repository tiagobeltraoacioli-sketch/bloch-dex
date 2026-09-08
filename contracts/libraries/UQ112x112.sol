// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UQ112x112 — binary fixed-point (112 integer bits . 112 fraction
///        bits), ported verbatim from the canonical Uniswap V2 core.
/// @dev WHY Q112 and not Q128: the Pair packs reserve0 (uint112), reserve1
///      (uint112) and blockTimestampLast (uint32) into a SINGLE storage slot
///      (112+112+32 = 256 bits exactly), so every swap touches one warm slot
///      instead of three. Reserves are therefore uint112-bounded, and the
///      price ratio reserveA/reserveB fits a UQ112.112 in the full range of
///      possible reserves: encode() below can never overflow because
///      uint112.max << 112 < uint224.max.
/// @dev The TWAP accumulators in UniswapV2Pair._update add
///      uint(UQ112x112 price) * timeElapsed into a uint256 and are EXPECTED
///      to overflow eventually; consumers subtract two observations
///      modularly. That wrap lives in the Pair (inside `unchecked`), not
///      here — everything in this library is exact.
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    /// @dev Encode a uint112 as a UQ112.112. Cannot overflow (see above).
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112; // never overflows
    }

    /// @dev Divide a UQ112.112 by a uint112, returning a UQ112.112. Division
    ///      by zero is excluded by the caller (_update skips the accumulator
    ///      when either reserve is zero — UniswapV2Pair.sol).
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
