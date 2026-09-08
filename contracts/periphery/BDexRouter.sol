// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBDexRouter} from "./interfaces/IBDexRouter.sol";
import {IWBLCH} from "./interfaces/IWBLCH.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {BDexLibrary} from "./BDexLibrary.sol";

/// @title BDexRouter — Router02-equivalent periphery over the Bloch DEX core,
///        authorial 0.8.24 port of the canonical UniswapV2Router02
///        (v2-periphery, solc 0.6.6).
///
/// STATUS: UNAUDITED REFERENCE, NOT DEPLOYED — same footing as the core
///         (contracts/dex/UniswapV2Factory.sol header).
///
/// DESIGN RULES this file must keep true:
///   * STATELESS. The only storage-shaped members are the two immutables
///     (factory, WBLCH). The Router holds NO balances between transactions,
///     keeps NO per-pair accounting, and owns NO privileged switch. This is
///     load-bearing twice over: (a) canonical Router02 semantics — anyone can
///     deploy a competing router against the same Factory; and (b) an earlier
///     review round found that per-pair accounting in a periphery contract is
///     corruptible by the LP-token-as-pool-token aliasing trick (a Pair IS an
///     ERC-20, so pair2 = Pair(LP1, WBLCH) is legal and permissionless) — a
///     class of bug that cannot exist where there is no accounting to corrupt.
///     test/BDexRouterBLCH.t.sol keeps a canary test trading exactly that
///     aliased pair through this Router end-to-end.
///   * NONE of the protocol-fee machinery lives here. The fee switch and its
///     policy (ships OFF; if ever ON, treasury-only) are the Factory's — see
///     contracts/dex/UniswapV2Factory.sol's FEE GOVERNANCE header and
///     docs/specs/POSTERNDEX-AMM-DESIGN.md:56-60. The Router neither reads
///     feeTo nor routes a single wei differently because of it.
///   * PAIR RESOLUTION goes through the Factory registry, never a hardcoded
///     CREATE2 hash (BDexLibrary.sol PORT NOTE 1) — the 0.8.24 init-code hash
///     differs from canonical, so the canonical constant would address
///     nonexistent pairs and every "transfer to the pair" would strand funds.
///
/// PORT NOTES (deviations from canonical Router02, each deliberate):
///   1. Naming: *ETH functions become *BLCH; the native asset is BLCH wrapped
///      by WBLCH (contracts/wblch/WBLCH.sol, WETH9-equivalent, byte-parity
///      pinned by test/WblchParity.t.sol).
///   2. receive() requires msg.sender == WBLCH (canonical uses a bare
///      assert). The Router accepts native ONLY as the return leg of a
///      WBLCH.withdraw unwrap; any other native send is a user error and
///      reverts loudly ("BDEX: NATIVE_ONLY_FROM_WBLCH") instead of silently
///      donating to whoever sweeps next.
///   3. SafeMath is gone (0.8 checked arithmetic); TransferHelper is inlined
///      as the _safeTransfer* private helpers, same low-level-call semantics:
///      missing-return tokens (USDT class) succeed, false-returning or
///      reverting tokens fail the whole transaction.
///   4. Exact-OUT fee-on-transfer variants DO NOT EXIST — see the note above
///      the Supporting section: with a transfer tax the amount that ARRIVES
///      differs from the amount SENT, so "exact output" cannot be promised
///      without iterating (unbounded) over tax rates. Canonical Router02 made
///      the same cut; we keep it and document it instead of shipping a
///      variant that lies.
contract BDexRouter is IBDexRouter {
    /// @notice The one Factory this Router serves. Immutable: a Router is a
    ///         throwaway convenience shell around a Factory, never a steward
    ///         of one — users who distrust this Router call the Pairs raw.
    address public immutable factory;
    /// @notice The wrapped-native token used for every *BLCH variant.
    address public immutable WBLCH;

    /// @dev Every state-touching entrypoint takes a user deadline. Canonical
    ///      semantics: a transaction stuck in the mempool past its deadline
    ///      reverts instead of executing at a stale price the user never saw.
    ///      block.timestamp is the sequencer's clock — the signer chooses the
    ///      deadline, same trust model as EIP-2612's.
    // forge-lint: disable-next-line(block-timestamp)
    modifier ensure(uint256 deadline) {
        // forge-lint: disable-next-line(block-timestamp)
        require(deadline >= block.timestamp, "BDEX: EXPIRED");
        _;
    }

    constructor(address _factory, address _WBLCH) {
        factory = _factory;
        WBLCH = _WBLCH;
    }

    /// @dev PORT NOTE 2: native only as the WBLCH.withdraw return leg.
    receive() external payable {
        require(msg.sender == WBLCH, "BDEX: NATIVE_ONLY_FROM_WBLCH");
    }

    // =========================================================================
    // Safe-transfer helpers (canonical TransferHelper, inlined — PORT NOTE 3)
    // =========================================================================

    /// @dev Tolerates empty returndata (missing-return tokens) but treats an
    ///      explicit `false` or a revert as failure — byte-for-byte the same
    ///      acceptance rule as UniswapV2Pair._safeTransfer, so core and
    ///      periphery agree on which tokens are usable.
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "BDEX: TRANSFER_FAILED");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "BDEX: TRANSFER_FROM_FAILED");
    }

    /// @dev Native send via call (not transfer/send): the 2300-gas stipend is
    ///      not enough for smart-contract recipients and gas costs are not a
    ///      constant of the EVM. Reverts on failure — a refund that cannot be
    ///      delivered must fail the transaction, not vanish.
    function _safeTransferNative(address to, uint256 value) private {
        (bool success, ) = to.call{value: value}("");
        require(success, "BDEX: NATIVE_TRANSFER_FAILED");
    }

    // =========================================================================
    // Liquidity
    // =========================================================================

    /// @dev Compute the deposit amounts, creating the pair when absent
    ///      (canonical: pair creation is part of first-add UX, and createPair
    ///      is permissionless anyway — refusing here would protect nothing).
    ///      For an existing pool the deposit must match the CURRENT ratio:
    ///      take the caller's desired amounts, scale one side down via quote,
    ///      and enforce the caller's per-side minimums so a ratio move between
    ///      signing and mining cannot silently repurpose their tokens.
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private returns (uint256 amountA, uint256 amountB) {
        if (IUniswapV2Factory(factory).getPair(tokenA, tokenB) == address(0)) {
            IUniswapV2Factory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = BDexLibrary.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            // Fresh pool: the caller's ratio IS the opening price.
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = BDexLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "BDEX: INSUFFICIENT_B_AMOUNT");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = BDexLibrary.quote(amountBDesired, reserveB, reserveA);
                // assert, not require: quote is monotone, so if BOptimal
                // overshot then AOptimal must undershoot — canonical keeps
                // this as an internal-consistency check, and so do we.
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "BDEX: INSUFFICIENT_A_AMOUNT");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = BDexLibrary.pairFor(factory, tokenA, tokenB);
        _safeTransferFrom(tokenA, msg.sender, pair, amountA);
        _safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IUniswapV2Pair(pair).mint(to);
    }

    /// @notice Native-side add: wraps exactly the BLCH the ratio calls for and
    ///         REFUNDS the rest of msg.value (dust refund — asserted with an
    ///         execution counter in test/BDexRouterBLCH.t.sol so the refund
    ///         branch provably runs).
    function addLiquidityBLCH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountBLCHMin,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountBLCH, uint256 liquidity) {
        (amountToken, amountBLCH) = _addLiquidity(token, WBLCH, amountTokenDesired, msg.value, amountTokenMin, amountBLCHMin);
        address pair = BDexLibrary.pairFor(factory, token, WBLCH);
        _safeTransferFrom(token, msg.sender, pair, amountToken);
        IWBLCH(WBLCH).deposit{value: amountBLCH}();
        require(IWBLCH(WBLCH).transfer(pair, amountBLCH), "BDEX: TRANSFER_FAILED");
        liquidity = IUniswapV2Pair(pair).mint(to);
        // Refund the native dust the ratio didn't need. Canonical behaviour;
        // without it the difference would sit in the Router for anyone to take.
        if (msg.value > amountBLCH) _safeTransferNative(msg.sender, msg.value - amountBLCH);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = BDexLibrary.pairFor(factory, tokenA, tokenB);
        // The Pair is itself the LP ERC-20; shares must sit in the Pair before
        // burn() (UniswapV2Pair.sol burn header). "burn" here = redeem LP
        // SHARES — the canonical pool primitive, nothing to do with BLCH.
        IUniswapV2Pair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IUniswapV2Pair(pair).burn(to);
        (address token0, ) = BDexLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "BDEX: INSUFFICIENT_A_AMOUNT");
        require(amountB >= amountBMin, "BDEX: INSUFFICIENT_B_AMOUNT");
    }

    function removeLiquidityBLCH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountBLCHMin,
        address to,
        uint256 deadline
    ) public returns (uint256 amountToken, uint256 amountBLCH) {
        // Redeem to the Router first: the Pair pays WBLCH, the user wants
        // native. removeLiquidity carries the ensure(deadline) check.
        (amountToken, amountBLCH) = removeLiquidity(token, WBLCH, liquidity, amountTokenMin, amountBLCHMin, address(this), deadline);
        _safeTransfer(token, to, amountToken);
        IWBLCH(WBLCH).withdraw(amountBLCH); // unwrap 1:1; native arrives via receive()
        _safeTransferNative(to, amountBLCH);
    }

    /// @notice Permit variant: the LP token is EIP-2612 (dynamic-chainid
    ///         domain — UniswapV2ERC20.sol PORT NOTE 2), so removal needs no
    ///         prior approve transaction. approveMax mirrors canonical:
    ///         type(uint256).max engages the LP token's infinite-allowance
    ///         fast path (never decremented again).
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = BDexLibrary.pairFor(factory, tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUniswapV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    function removeLiquidityBLCHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountBLCHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountToken, uint256 amountBLCH) {
        address pair = BDexLibrary.pairFor(factory, token, WBLCH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUniswapV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountToken, amountBLCH) = removeLiquidityBLCH(token, liquidity, amountTokenMin, amountBLCHMin, to, deadline);
    }

    /// @notice Fee-on-transfer remove (native side): the token leg is measured
    ///         off the Router's REAL balance after the burn, because a taxed
    ///         token delivers less than the Pair's accounting says it sent.
    ///         Returns only amountBLCH — the token amount that matters is
    ///         whatever actually arrived at `to`, which the caller can only
    ///         learn from balances (that is the point of the variant).
    function removeLiquidityBLCHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountBLCHMin,
        address to,
        uint256 deadline
    ) public returns (uint256 amountBLCH) {
        (, amountBLCH) = removeLiquidity(token, WBLCH, liquidity, amountTokenMin, amountBLCHMin, address(this), deadline);
        // Forward what ACTUALLY landed here, not what burn() reported.
        _safeTransfer(token, to, _balanceOf(token, address(this)));
        IWBLCH(WBLCH).withdraw(amountBLCH);
        _safeTransferNative(to, amountBLCH);
    }

    function removeLiquidityBLCHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountBLCHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountBLCH) {
        address pair = BDexLibrary.pairFor(factory, token, WBLCH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUniswapV2Pair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        amountBLCH = removeLiquidityBLCHSupportingFeeOnTransferTokens(token, liquidity, amountTokenMin, amountBLCHMin, to, deadline);
    }

    // =========================================================================
    // Swaps — standard variants (amounts computed up front, Pair-verified)
    // =========================================================================

    /// @dev Canonical multi-hop executor: for each hop the output is sent
    ///      DIRECTLY to the next pair (no Router custody between hops); the
    ///      final hop pays `_to`. Requires amounts[] precomputed — the Pair's
    ///      K check is the on-chain verifier that those numbers were honest.
    function _swap(uint256[] memory amounts, address[] memory path, address _to) private {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = BDexLibrary.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? BDexLibrary.pairFor(factory, output, path[i + 2]) : _to;
            IUniswapV2Pair(BDexLibrary.pairFor(factory, input, output)).swap(amount0Out, amount1Out, to, "");
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = BDexLibrary.getAmountsOut(factory, amountIn, path);
        // amountOutMin is the ONLY sandwich defense a swapper has — see
        // test/DexSwapSandwich.t.sol for the attack this bound prevents.
        require(amounts[amounts.length - 1] >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = BDexLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "BDEX: EXCESSIVE_INPUT_AMOUNT");
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapExactBLCHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WBLCH, "BDEX: INVALID_PATH");
        amounts = BDexLibrary.getAmountsOut(factory, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        IWBLCH(WBLCH).deposit{value: amounts[0]}();
        require(IWBLCH(WBLCH).transfer(BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]), "BDEX: TRANSFER_FAILED");
        _swap(amounts, path, to);
    }

    function swapTokensForExactBLCH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WBLCH, "BDEX: INVALID_PATH");
        amounts = BDexLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "BDEX: EXCESSIVE_INPUT_AMOUNT");
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWBLCH(WBLCH).withdraw(amounts[amounts.length - 1]);
        _safeTransferNative(to, amounts[amounts.length - 1]);
    }

    function swapExactTokensForBLCH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WBLCH, "BDEX: INVALID_PATH");
        amounts = BDexLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWBLCH(WBLCH).withdraw(amounts[amounts.length - 1]);
        _safeTransferNative(to, amounts[amounts.length - 1]);
    }

    /// @notice Exact-OUT native-in swap: wraps only what the math requires and
    ///         refunds the rest of msg.value (dust refund, counter-asserted in
    ///         test/BDexRouterBLCH.t.sol like addLiquidityBLCH's).
    function swapBLCHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        require(path[0] == WBLCH, "BDEX: INVALID_PATH");
        amounts = BDexLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= msg.value, "BDEX: EXCESSIVE_INPUT_AMOUNT");
        IWBLCH(WBLCH).deposit{value: amounts[0]}();
        require(IWBLCH(WBLCH).transfer(BDexLibrary.pairFor(factory, path[0], path[1]), amounts[0]), "BDEX: TRANSFER_FAILED");
        _swap(amounts, path, to);
        if (msg.value > amounts[0]) _safeTransferNative(msg.sender, msg.value - amounts[0]);
    }

    // =========================================================================
    // Swaps — fee-on-transfer variants (exact-IN only)
    //
    // WHY THESE EXIST: the core's Pair header (UniswapV2Pair.sol, KNOWN
    // CANONICAL LIMITATIONS) delegates fee-on-transfer handling to the Router.
    // A taxed token delivers LESS than sent, so the standard variants' pre-
    // computed amounts[] overstate the pair's input and the Pair's K check
    // correctly reverts ("BDEX: K") — failing CLOSED, never silently short-
    // changing (proven in test/BDexRouterFoT.t.sol with the Supporting
    // variant as the control). These variants instead measure the pair's REAL
    // balance delta before quoting each hop, and enforce amountOutMin on the
    // RECIPIENT's real balance delta.
    //
    // WHY THERE IS NO EXACT-OUT VARIANT: exact-out requires solving "send X
    // such that after the token's arbitrary tax, exactly amountIn(X) arrives".
    // The tax function is the token's private business (it can be nonlinear,
    // per-holder, time-varying), so no closed form exists and iteration on-
    // chain is unbounded gas. Canonical Router02 made the same cut. Callers
    // who need a fixed output from a taxed token must overshoot with exact-in
    // and accept the surplus.
    // =========================================================================

    /// @dev Balance-measuring hop executor. For each hop: input actually held
    ///      by the pair minus its reserve IS the swap input (whatever survived
    ///      the token's tax); quote the output off that and swap. The Pair's K
    ///      check still verifies every hop.
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) private {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = BDexLibrary.sortTokens(input, output);
            IUniswapV2Pair pair = IUniswapV2Pair(BDexLibrary.pairFor(factory, input, output));
            uint256 amountInput;
            uint256 amountOutput;
            {
                (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) =
                    input == token0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
                amountInput = _balanceOf(input, address(pair)) - reserveInput;
                amountOutput = BDexLibrary.getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? BDexLibrary.pairFor(factory, output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, "");
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amountIn);
        uint256 balanceBefore = _balanceOf(path[path.length - 1], to);
        _swapSupportingFeeOnTransferTokens(path, to);
        // The slippage bound is enforced on what the RECIPIENT actually
        // received — the only number that means anything under transfer taxes.
        require(_balanceOf(path[path.length - 1], to) - balanceBefore >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
    }

    function swapExactBLCHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) {
        require(path[0] == WBLCH, "BDEX: INVALID_PATH");
        uint256 amountIn = msg.value;
        IWBLCH(WBLCH).deposit{value: amountIn}();
        require(IWBLCH(WBLCH).transfer(BDexLibrary.pairFor(factory, path[0], path[1]), amountIn), "BDEX: TRANSFER_FAILED");
        uint256 balanceBefore = _balanceOf(path[path.length - 1], to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(_balanceOf(path[path.length - 1], to) - balanceBefore >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
    }

    function swapExactTokensForBLCHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path[path.length - 1] == WBLCH, "BDEX: INVALID_PATH");
        _safeTransferFrom(path[0], msg.sender, BDexLibrary.pairFor(factory, path[0], path[1]), amountIn);
        _swapSupportingFeeOnTransferTokens(path, address(this));
        // WBLCH itself is NOT fee-on-transfer (WblchParity-pinned wrapper), so
        // the Router's own balance is exactly the final hop's output.
        uint256 amountOut = IWBLCH(WBLCH).balanceOf(address(this));
        require(amountOut >= amountOutMin, "BDEX: INSUFFICIENT_OUTPUT_AMOUNT");
        IWBLCH(WBLCH).withdraw(amountOut);
        _safeTransferNative(to, amountOut);
    }

    // =========================================================================
    // Quoting views — thin wrappers over BDexLibrary so front-ends quote the
    // SAME math the swap paths execute (the desktop preview divergence class:
    // the UI must never show a number the Pair won't honour).
    // =========================================================================

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256) {
        return BDexLibrary.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        return BDexLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        return BDexLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory) {
        return BDexLibrary.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory) {
        return BDexLibrary.getAmountsIn(factory, amountOut, path);
    }

    // =========================================================================
    // Internals
    // =========================================================================

    /// @dev balanceOf via staticcall-shaped external call; every token the
    ///      Router touches must at least answer balanceOf honestly (the
    ///      Supporting variants are built on that floor — a token that lies to
    ///      balanceOf defeats ANY router, canonical included).
    function _balanceOf(address token, address owner) private view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, owner));
        require(success && data.length >= 32, "BDEX: BALANCE_OF_FAILED");
        return abi.decode(data, (uint256));
    }
}
