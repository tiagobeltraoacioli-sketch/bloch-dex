// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2Pair.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title TreasuryFeeCollector
/// @notice Immutable treasury destination for optional V2 protocol LP fees.
/// @dev sweep redeems LP directly to the treasury. convertViaTwap additionally
///      sells the non-wrapped leg of a wrapped-native pair, using a caller-owned
///      observation aged 30 minutes to 6 hours and a 1% price discount limit.
///      Checkpoints require nonzero reserves. A mature TWAP is not manipulation
///      proof: sustained displacement in shallow markets can still be profitable.
///      Conversion requires exact redemption deltas; direct sweep is available
///      for taxed tokens. There is no rescue key or arbitrary recipient argument.

contract TreasuryFeeCollector {
    using UQ112x112 for uint224;

    // ------------------------------------------------------------------ //
    // Immutables — the ONLY configuration this contract will ever have.   //
    // ------------------------------------------------------------------ //

    /// @notice The UniswapV2Factory whose pairs this collector serves. Used
    ///         to verify that an address claimed to be a pair really was
    ///         deployed by the factory (createPair registry) before any
    ///         token-moving call is made to it.
    IUniswapV2Factory public immutable factory;

    /// @notice The single, fixed destination of every unit of value that
    ///         flows through this contract: Postern's OPERATIONS treasury
    ///         for operating the application. Immutable on
    ///         purpose: redirecting proceeds requires a new deployment plus a
    ///         feeToSetter act, never a quiet setter call.
    address public immutable treasury;

    /// @notice The canonical wrapped-BLCH token. Only pairs with a WBLCH side
    ///         are eligible for convertViaTwap (the treasury's optional
    ///         request to receive WBLCH instead of mixed underlyings).
    address public immutable wblch;

    // ------------------------------------------------------------------ //
    // Guard constants — compile-time, no function can change them.        //
    // ------------------------------------------------------------------ //

    /// @dev A TWAP window shorter than this is too easy to manipulate with
    ///      sustained pressure. A short window lowers the
    ///      cost of holding the price displaced across it).
    uint256 public constant MIN_TWAP_WINDOW = 30 minutes;

    /// @dev A window longer than this is stale: the anchor price predates
    ///      current conditions so far that the guard would reject honest
    ///      conversions (or, worse, accept against an obsolete price).
    uint256 public constant MAX_TWAP_WINDOW = 6 hours;

    /// @dev Maximum discount from the TWAP-implied output the conversion may
    ///      realize (spread + own price impact). 100 bps = 1%.
    uint256 public constant MAX_SLIPPAGE_BPS = 100;
    uint256 private constant BPS = 10_000;

    // ------------------------------------------------------------------ //
    // The only storage: per-caller TWAP checkpoints.                      //
    // ------------------------------------------------------------------ //

    struct Observation {
        uint256 price0Cumulative; // pair.price0CumulativeLast, counterfactually advanced
        uint256 price1Cumulative; // pair.price1CumulativeLast, counterfactually advanced
        uint256 timestamp; // full-width block.timestamp of the observation
    }

    /// @dev Keyed caller => pair => observation. WHY per-caller: checkpoint()
    ///      is permissionless, and a single global slot per pair would let an
    ///      attacker re-checkpoint every block, keeping `elapsed` forever
    ///      below MIN_TWAP_WINDOW and denying convertViaTwap to everyone.
    ///      With per-caller slots the attacker only ever resets their own.
    mapping(address => mapping(address => Observation)) public observations;

    /// @dev Canonical-style reentrancy latch. The collector's storage cannot
    ///      be meaningfully corrupted by reentry (there are no balances), but
    ///      convertViaTwap transiently custodies tokens between burn and
    ///      swap, and underlyings with transfer hooks are exactly the "weird
    ///      token" class. Use the same pattern as UniswapV2Pair.lock.
    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "TFC: LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    event Sweep(address indexed pair, uint256 lpBurned, uint256 amount0, uint256 amount1);
    event Checkpoint(address indexed caller, address indexed pair, uint256 timestamp);
    event ConvertViaTwap(address indexed pair, uint256 lpBurned, uint256 nonWblchSold, uint256 wblchOut);

    constructor(address _factory, address _treasury, address _wblch) {
        require(_factory != address(0) && _treasury != address(0) && _wblch != address(0), "TFC: ZERO_ADDR");
        require(_factory.code.length > 0 && _wblch.code.length > 0, "TFC: NOT_A_CONTRACT");
        factory = IUniswapV2Factory(_factory);
        treasury = _treasury;
        wblch = _wblch;
    }

    // ------------------------------------------------------------------ //
    // Default path: price-neutral redemption straight to the treasury.    //
    // ------------------------------------------------------------------ //

    /// @notice Redeem ALL LP shares of `pair` held by this collector and
    ///         deliver both underlying tokens directly to the treasury.
    /// @dev Permissionless: anyone may crank it; the destination is fixed, so
    ///      the caller can steer nothing. No swap leg exists — pair.burn
    ///      removes reserves pro-rata, preserving reserve0/reserve1 and hence
    ///      the reserve ratio for standard tokens. Note that burn()
    ///      itself runs _mintFee first, so calling sweep also CRYSTALLIZES
    ///      the protocol cut accrued since kLast without waiting for an LP
    ///      liquidity event — the freshly minted shares (minted to this
    ///      collector, the feeTo) are simply picked up by the next sweep.
    function sweep(address pair) external lock {
        _requireCanonicalPair(pair);
        uint256 bal = IUniswapV2Pair(pair).balanceOf(address(this));
        require(bal > 0, "TFC: NOTHING_TO_SWEEP");
        // The LP token is our own UniswapV2ERC20 port (reverts on shortfall,
        // returns true otherwise); the explicit check still costs nothing and
        // keeps the erc20-unchecked-transfer lint honest.
        require(IUniswapV2Pair(pair).transfer(pair, bal), "TFC: LP_TRANSFER");
        (uint256 amount0, uint256 amount1) = IUniswapV2Pair(pair).burn(treasury);
        emit Sweep(pair, bal, amount0, amount1);
    }

    // ------------------------------------------------------------------ //
    // Optional path: TWAP-guarded conversion of the non-WBLCH side.       //
    // ------------------------------------------------------------------ //

    /// @notice Record the caller's TWAP anchor for `pair`. Must be called at
    ///         least MIN_TWAP_WINDOW (and at most MAX_TWAP_WINDOW) before the
    ///         caller's convertViaTwap.
    function checkpoint(address pair) external {
        _requireCanonicalPair(pair);
        // An empty interval is not a price observation: accepting it would
        // dilute the eventual average to zero after a just-in-time first mint.
        _requireLiquidity(pair);
        (uint256 p0, uint256 p1) = _currentCumulatives(pair);
        observations[msg.sender][pair] = Observation(p0, p1, block.timestamp);
        emit Checkpoint(msg.sender, pair, block.timestamp);
    }

    /// @notice Redeem `lpAmount` of the collector's LP in `pair` (which must
    ///         have a WBLCH side) and sell the non-WBLCH underlying into the
    ///         pair, delivering ALL resulting WBLCH to the treasury.
    /// @dev The minimum output is computed HERE, from the pair's own
    ///      cumulative-price TWAP against the caller's checkpoint — the
    ///      caller cannot pass a price, a minimum, or a window. All guard
    ///      parameters are constants; there is no code path that relaxes
    ///      them. A front-run that moves the realized output below
    ///      TWAP*(1 - MAX_SLIPPAGE_BPS) reverts the whole call (attack and
    ///      control tests in test/Treasury.t.sol).
    ///      If the pool is too shallow for `lpAmount` within the discount,
    ///      the call reverts and the caller retries smaller — deliberately no
    ///      automated chunking. Sustained (multi-block, fee-paying) TWAP
    ///      displacement in a shallow pool remains possible; the DEFAULT path
    ///      is sweep(), and conversion in shallow pools should simply not be
    ///      used (documented residual).
    function convertViaTwap(address pair, uint256 lpAmount) external lock {
        _requireCanonicalPair(pair);
        bool wblchIs0 = IUniswapV2Pair(pair).token0() == wblch;
        require(wblchIs0 || IUniswapV2Pair(pair).token1() == wblch, "TFC: NO_WBLCH_SIDE");

        // TWAP of the NON-WBLCH token in WBLCH over the caller's window
        // (window checks + counterfactual accumulator advance inside).
        uint256 avgPriceQ112 = _twapPriceNonWblch(pair, wblchIs0);

        // --- Redeem the LP (price-neutral, ratio preserved) ------------- //
        require(lpAmount > 0, "TFC: ZERO_LP");
        (uint256 amtNonWblch, uint256 amtWblch) = _redeemExact(pair, lpAmount, wblchIs0);

        // --- Guarded sell of the non-WBLCH side, all WBLCH to treasury --- //
        uint256 out = _sellNonWblchGuarded(pair, wblchIs0, amtNonWblch, avgPriceQ112);
        if (amtWblch > 0) _safeTransfer(wblch, treasury, amtWblch);
        emit ConvertViaTwap(pair, lpAmount, amtNonWblch, out + amtWblch);
    }

    /// @dev Conversion supports ordinary transfer semantics only. Never use
    ///      unrelated balances held here to make up a taxed/rebased redemption.
    ///      sweep() remains the direct-to-treasury path for other token types.
    function _redeemExact(address pair, uint256 lpAmount, bool wblchIs0)
        private
        returns (uint256 nonWblchAmount, uint256 wblchAmount)
    {
        address token0 = IUniswapV2Pair(pair).token0();
        address token1 = IUniswapV2Pair(pair).token1();
        uint256 before0 = IERC20(token0).balanceOf(address(this));
        uint256 before1 = IERC20(token1).balanceOf(address(this));
        require(IUniswapV2Pair(pair).transfer(pair, lpAmount), "TFC: LP_TRANSFER");
        (uint256 a0, uint256 a1) = IUniswapV2Pair(pair).burn(address(this));
        require(IERC20(token0).balanceOf(address(this)) - before0 == a0, "TFC: NONSTANDARD_REDEMPTION");
        require(IERC20(token1).balanceOf(address(this)) - before1 == a1, "TFC: NONSTANDARD_REDEMPTION");
        return wblchIs0 ? (a1, a0) : (a0, a1);
    }

    /// @dev Window-checked TWAP (UQ112x112) of the non-WBLCH token priced in
    ///      WBLCH, from the caller's own checkpoint to now.
    function _twapPriceNonWblch(address pair, bool wblchIs0) private view returns (uint256 avgPriceQ112) {
        _requireLiquidity(pair);
        Observation memory obs = observations[msg.sender][pair];
        require(obs.timestamp != 0, "TFC: NO_CHECKPOINT");
        uint256 elapsed = block.timestamp - obs.timestamp;
        require(elapsed >= MIN_TWAP_WINDOW, "TFC: WINDOW_TOO_SHORT");
        require(elapsed <= MAX_TWAP_WINDOW, "TFC: WINDOW_TOO_LONG");
        // The cumulative counters are DESIGNED to wrap (UniswapV2Pair._update);
        // the modular subtraction below is the canonical consumer-side idiom.
        (uint256 p0Now, uint256 p1Now) = _currentCumulatives(pair);
        unchecked {
            // price0Cumulative accumulates token1/token0 (price of token0 in
            // token1). We want nonWBLCH priced in WBLCH:
            //   wblch == token0  =>  price of token1 in token0  => price1Cum
            //   wblch == token1  =>  price of token0 in token1  => price0Cum
            avgPriceQ112 = (wblchIs0 ? p1Now - obs.price1Cumulative : p0Now - obs.price0Cumulative) / elapsed;
        }
        require(avgPriceQ112 > 0, "TFC: ZERO_TWAP");
    }

    /// @dev Sell `amtNonWblch` into the pair with the TWAP floor enforced;
    ///      the WBLCH output goes straight to the treasury.
    function _sellNonWblchGuarded(address pair, bool wblchIs0, uint256 amtNonWblch, uint256 avgPriceQ112)
        private
        returns (uint256 out)
    {
        // Checked multiplication on purpose: if avg*amount overflows uint256
        // the market is so degenerate that reverting IS the guard.
        uint256 minOut = ((avgPriceQ112 * amtNonWblch) >> 112) * (BPS - MAX_SLIPPAGE_BPS) / BPS;
        require(minOut > 0, "TFC: DUST_CONVERSION");
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves(); // post-burn: ratio unchanged
        (uint256 rNon, uint256 rW) = wblchIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        out = _getAmountOut(amtNonWblch, rNon, rW);
        require(out >= minOut, "TFC: TWAP_SLIPPAGE");

        address nonWblchToken = wblchIs0 ? IUniswapV2Pair(pair).token1() : IUniswapV2Pair(pair).token0();
        _safeTransfer(nonWblchToken, pair, amtNonWblch);
        (uint256 o0, uint256 o1) = wblchIs0 ? (out, uint256(0)) : (uint256(0), out);
        IUniswapV2Pair(pair).swap(o0, o1, treasury, "");
    }

    // ------------------------------------------------------------------ //
    // Internals                                                           //
    // ------------------------------------------------------------------ //

    /// @dev A pair is only touched if the factory's own registry deployed it.
    ///      This is a liveness/robustness check, not a custody one (the
    ///      collector holds no balances a fake pair could exfiltrate), but it
    ///      keeps every token-moving call inside audited code.
    function _requireCanonicalPair(address pair) private view {
        address t0 = IUniswapV2Pair(pair).token0();
        address t1 = IUniswapV2Pair(pair).token1();
        require(factory.getPair(t0, t1) == pair, "TFC: NOT_A_PAIR");
    }

    function _requireLiquidity(address pair) private view {
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        require(reserve0 != 0 && reserve1 != 0, "TFC: NO_LIQUIDITY");
    }

    /// @dev Counterfactually advance the pair's cumulative prices to NOW, the
    ///      canonical UniswapV2OracleLibrary idiom: if no swap has touched
    ///      the pair this block, its stored accumulators lag; add the current
    ///      spot price times the gap so an observation taken in a tradeless
    ///      block still measures honestly.
    function _currentCumulatives(address pair) private view returns (uint256 p0, uint256 p1) {
        p0 = IUniswapV2Pair(pair).price0CumulativeLast();
        p1 = IUniswapV2Pair(pair).price1CumulativeLast();
        (uint112 r0, uint112 r1, uint32 tsLast) = IUniswapV2Pair(pair).getReserves();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 now32 = uint32(block.timestamp); // same truncation the Pair uses
        if (tsLast != now32 && r0 != 0 && r1 != 0) {
            unchecked {
                uint32 gap = now32 - tsLast; // wraps by design, like the Pair
                p0 += uint256(UQ112x112.encode(r1).uqdiv(r0)) * gap;
                p1 += uint256(UQ112x112.encode(r0).uqdiv(r1)) * gap;
            }
        }
    }

    /// @dev Canonical v2 exact-in output with the 0.30% fee — must stay in
    ///      lockstep with UniswapV2Pair's adjusted k-check.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// @dev Missing-return-tolerant ERC-20 transfer, same rationale as
    ///      UniswapV2Pair._safeTransfer (USDT-style tokens return nothing).
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TFC: TRANSFER_FAILED");
    }
}
