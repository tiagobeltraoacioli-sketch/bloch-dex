// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2ERC20} from "./UniswapV2ERC20.sol";
import {Math} from "./libraries/Math.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Callee} from "./interfaces/IUniswapV2Callee.sol";

/// @title UniswapV2Pair
/// @notice V2 constant-product AMM with governed pool fees and locked minimum LP.
/// @dev Optimistic transfers and flash callbacks are checked against actual
///      balances after the callback. A storage latch guards every pool mutation.
///      Cumulative prices and uint32 timestamps intentionally wrap; consumers
///      must use modular differences over windows shorter than 2^32 seconds.
///      Reserve balances are bounded to uint112. Taxed/rebasing tokens require
///      explicit integration handling and are not made safe by the invariant.

contract UniswapV2Pair is UniswapV2ERC20 {
    using UQ112x112 for uint224;

    /// @dev First-depositor (share-inflation) mitigation, exactly canonical:
    ///      the first mint burns 1000 shares to address(0) forever. Without
    ///      it, an attacker could mint 1 wei of shares, donate a huge token
    ///      amount to inflate the share price, and round subsequent
    ///      depositors' shares down to 0. With it, making 1 share worth X
    ///      requires PERMANENTLY forfeiting 1000·X of donated value to the
    ///      locked shares — the attack cost floor scales 1000× faster than
    ///      the loot. This bounds, but does not eliminate, donation griefing
    ///      against integrators that skip min-amount checks; the Router owes
    ///      users amountMin/deadline guards. Quantified in
    ///      test/Core.t.sol.
    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    /// @dev transfer(address,uint256) selector for the raw-call transfer path.
    bytes4 private constant SELECTOR = bytes4(keccak256(bytes("transfer(address,uint256)")));

    address public factory;
    address public token0;
    address public token1;

    // --- single-slot reserve packing (112 + 112 + 32 = 256 bits) ---------
    // WHY: every swap reads and writes reserves + the TWAP timestamp; packing
    // them into one slot makes that a single warm SLOAD/SSTORE. This packing
    // is the reason reserves are uint112 and the TWAP price is UQ112.112
    // (libraries/UQ112x112.sol).
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    /// @notice TWAP accumulators: sum over time of (reserveOther/reserveThis)
    ///         as UQ112.112, multiplied by elapsed seconds. They OVERFLOW BY
    ///         DESIGN — consumers take the difference of two observations in
    ///         modular uint256 arithmetic, which stays correct across the
    ///         wrap. See the `unchecked` block in _update.
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    /// @notice reserve0 * reserve1 as of the LAST liquidity event (mint/burn)
    ///         — only tracked while the protocol fee is on. _mintFee charges
    ///         1/6 of sqrt(k) growth since this snapshot; snapshotting only
    ///         at liquidity events is what lets swaps stay fee-accounting-
    ///         free (the cut is settled lazily).
    uint256 public kLast;

    // --- reentrancy lock -------------------------------------------------
    // A storage lock avoids a dependency on Cancun transient-storage opcodes.
    // The constructor runs during factory deployment and initializes this latch.
    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "BDEX: LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    event SwapFeeApplied(address indexed trader, address indexed executor, uint16 feeBps);

    constructor() {
        factory = msg.sender;
    }

    /// @notice One-time token wiring, called by the Factory in the same
    ///         transaction as CREATE2 deployment. Kept separate from the
    ///         constructor (canonical design) so the init code — and thus
    ///         the CREATE2 address — does not depend on the token pair;
    ///         the salt does (Factory.createPair).
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "BDEX: FORBIDDEN");
        require(token0 == address(0) && token1 == address(0), "BDEX: ALREADY_INITIALIZED");
        require(_token0 != address(0) && _token0 < _token1, "BDEX: INVALID_TOKENS");
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @dev Raw-call transfer that tolerates non-standard ERC-20s returning
    ///      no value (USDT-style). Required because the Factory is
    ///      permissionless: the Pair cannot dictate which tokens exist.
    ///      success && (empty return || decoded true) is the canonical
    ///      acceptance rule.
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(SELECTOR, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "BDEX: TRANSFER_FAILED");
    }

    /// @dev Commit fresh balances to reserves + advance the TWAP.
    ///
    ///      THE `unchecked` BLOCK IS LOAD-BEARING — the classic V2-port bug
    ///      lives here. The canonical 0.5.16 contract RELIES on silent
    ///      wrapping in three places, and 0.8's checked arithmetic would turn
    ///      each wrap into a revert, i.e. a PERMANENT pool freeze:
    ///        1. uint32(block.timestamp % 2**32): timestamp truncation wraps
    ///           every ~136 years (canonical comment: "overflow is desired").
    ///        2. timeElapsed = blockTimestamp - blockTimestampLast: after the
    ///           2^32 wrap, last > current in uint32 terms; modular
    ///           subtraction still yields the true elapsed seconds.
    ///        3. priceXCumulativeLast += price * timeElapsed: accumulators
    ///           overflow uint256 by design; TWAP consumers subtract two
    ///           observations modularly and the difference stays correct.
    ///      Checked equivalents would brick every pool at the first wrap.
    ///      Timestamp rollover is exercised in test/Treasury.t.sol.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "BDEX: OVERFLOW");
        unchecked {
            uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
            uint32 timeElapsed = blockTimestamp - blockTimestampLast; // wraps by design (2)
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                // * never overflows the multiply BEFORE the intentional
                //   accumulator wrap: encode(r).uqdiv(r') <= 2^224 and
                //   timeElapsed < 2^32, product < 2^256.
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
            blockTimestampLast = blockTimestamp;
        }
        // casting to 'uint112' is safe: both balances were require-bounded to
        // type(uint112).max at the top of this function.
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(balance0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(balance1);
        emit Sync(reserve0, reserve1);
    }

    /// @dev Lazy protocol-fee settlement, exactly canonical. If feeTo is set,
    ///      mint feeTo LP shares equal to 1/6 of the growth of sqrt(k) since
    ///      the last liquidity event:
    ///
    ///          liquidity = totalSupply * (rootK - rootKLast)
    ///                      / (5 * rootK + rootKLast)
    ///
    ///      which is the closed form of "dilute the supply so feeTo owns
    ///      exactly 1/6 of the value the fees added" (v2 whitepaper eq. 7).
    ///      Because it dilutes only fee-driven GROWTH, the LP principal and
    ///      the LPs' 0.25% share of volume are untouched by construction —
    ///      this is the property the treasury-collector design depends on
    ///      The pending dilution is checked against redemption in test/Lens.t.sol.
    ///      A liquidity event while feeTo is off zeroes kLast. Toggling off
    ///      and back on WITHOUT such an event does not reset the baseline.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IUniswapV2Factory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast; // gas savings
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = Math.sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = Math.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    /// @notice Mint LP shares for tokens ALREADY TRANSFERRED to this pair
    ///         (low-level; the Router performs the transfer+mint dance).
    /// @dev First deposit: shares = sqrt(amount0*amount1) - MINIMUM_LIQUIDITY,
    ///      with the 1000 locked forever at address(0) — see the constant's
    ///      comment for the attack this mitigates. Geometric mean makes the
    ///      initial share count independent of the deposit ratio, so the
    ///      first LP cannot manufacture share-price extremes for free.
    ///      Subsequent deposits: pro-rata against reserves, taking the MIN of
    ///      the two ratios so depositing off-ratio donates the excess to the
    ///      pool instead of minting unbacked shares.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves(); // gas savings
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be AFTER _mintFee's dilution
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY); // permanently locked
        } else {
            liquidity = Math.min((amount0 * _totalSupply) / _reserve0, (amount1 * _totalSupply) / _reserve1);
        }
        require(liquidity > 0, "BDEX: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1; // reserve0/1 are up to date
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burn the LP shares ALREADY TRANSFERRED to this pair and send
    ///         both tokens pro-rata to `to` (low-level; Router wraps it).
    /// @dev Pro-rata against actual BALANCES, not reserves — canonical choice
    ///      that makes burn correct even when someone donated tokens since
    ///      the last sync (donations then accrue to all LPs).
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves(); // gas savings
        address _token0 = token0; // gas savings
        address _token1 = token1; // gas savings
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be AFTER _mintFee's dilution
        amount0 = (liquidity * balance0) / _totalSupply; // pro-rata distribution
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "BDEX: INSUFFICIENT_LIQUIDITY_BURNED");
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1; // reserve0/1 are up to date
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swap with OPTIMISTIC OUTPUT TRANSFER (canonical order, kept
    ///         deliberately): outputs are sent BEFORE any input is verified,
    ///         then the flash-swap callback runs, then the pair re-reads its
    ///         own balances and enforces the fee-adjusted invariant
    ///
    ///             (b0*10000 - in0*feeBps) * (b1*10000 - in1*feeBps)
    ///                 >= r0 * r1 * 10000^2
    ///
    ///         WHY transfer-before-check is safe here: the check runs on the
    ///         REAL post-callback balances, so no interleaving of transfers
    ///         and callbacks can fake repayment — either the tokens are back
    ///         (plus fee) when the callback returns, or the whole tx reverts
    ///         and the optimistic transfer never happened. Reentering
    ///         mint/burn/swap/skim/sync from the callback (or from a
    ///         malicious token's transfer hook) trips `lock`. This ordering
    ///         is also what makes flash swaps free of extra code paths.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        uint16 fee = IUniswapV2Factory(factory).swapFeeBps(address(this), msg.sender, msg.sender);
        _swap(amount0Out, amount1Out, to, data, fee);
        emit SwapFeeApplied(msg.sender, msg.sender, fee);
    }

    function swapFor(uint256 amount0Out, uint256 amount1Out, address to, address trader) external lock {
        require(IUniswapV2Factory(factory).feeRouters(msg.sender), "BDEX: UNTRUSTED_ROUTER");
        require(trader != address(0), "BDEX: ZERO_ADDRESS");
        uint16 fee = IUniswapV2Factory(factory).swapFeeBps(address(this), trader, msg.sender);
        _swap(amount0Out, amount1Out, to, "", fee);
        emit SwapFeeApplied(trader, msg.sender, fee);
    }

    function _swap(uint256 amount0Out, uint256 amount1Out, address to, bytes memory data, uint16 fee) private {
        // Snapshot before token callbacks; an in-flight governance change cannot
        // alter the fee applied to an already executing swap.
        require(amount0Out > 0 || amount1Out > 0, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves(); // gas savings
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "BDEX: INSUFFICIENT_LIQUIDITY");

        uint256 balance0;
        uint256 balance1;
        {
            // scope for _token{0,1}, avoids stack-too-deep (canonical)
            address _token0 = token0;
            address _token1 = token1;
            require(to != _token0 && to != _token1, "BDEX: INVALID_TO");
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out); // optimistic
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out); // optimistic
            if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(_token0).balanceOf(address(this)); // re-read AFTER callback
            balance1 = IERC20(_token1).balanceOf(address(this));
        }
        // Inputs are INFERRED from balance growth, never trusted from
        // arguments — the only way to "claim" an input is to have actually
        // sent it.
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "BDEX: INSUFFICIENT_INPUT_AMOUNT");
        {
            // scope for balance{0,1}Adjusted (canonical). Checked arithmetic
            // is CORRECT here (no unchecked): balances were not yet bounds-
            // checked by _update, so balance*10000 on an absurd donated
            // balance may overflow-revert — same outcome as canonical
            // SafeMath. The k comparison multiplies two <2^126 values
            // against r0*r1*1e8 < 2^252; no overflow in the honest range.
            uint256 balance0Adjusted = balance0 * 10_000 - amount0In * fee;
            uint256 balance1Adjusted = balance1 * 10_000 - amount1In * fee;
            require(balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * _reserve1 * (10_000 ** 2), "BDEX: K");
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Send any balance in excess of reserves to `to`. Escape valve
    ///         (canonical): lets anyone sweep donations/rebase surpluses that
    ///         would otherwise sit outside reserve accounting, and is the
    ///         documented recovery path when a token's balance exceeds
    ///         uint112 (sync would revert OVERFLOW; skim restores balance ==
    ///         reserves without touching reserves).
    function skim(address to) external lock {
        address _token0 = token0; // gas savings
        address _token1 = token1; // gas savings
        _safeTransfer(_token0, to, IERC20(_token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_token1, to, IERC20(_token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Force reserves to match balances. The other escape valve:
    ///         after a negative rebase, reserves overstate holdings and every
    ///         path that trusts them misprices — sync re-anchors them.
    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }
}
