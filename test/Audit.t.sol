// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";
import {Math} from "../contracts/libraries/Math.sol";

interface AuditVm {
    function roll(uint256 blockNumber) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
}

/// Token whose transfer hook calls back into a configurable target. Used to
/// prove that every pool mutation is behind the pair's storage latch.
contract HookToken is TestToken {
    address public hookTarget;
    bytes public hookCall;
    bool public hookReverted;
    bytes public hookRevertData;

    function arm(address target, bytes calldata data) external {
        hookTarget = target;
        hookCall = data;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        address target = hookTarget;
        if (target != address(0)) {
            hookTarget = address(0);
            (bool ok, bytes memory ret) = target.call(hookCall);
            hookReverted = !ok;
            hookRevertData = ret;
        }
    }
}

/// Flash-swap callee that reenters the pair and then repays (or not).
contract FlashBorrower {
    UniswapV2Pair public immutable pair;
    bytes public reentry;
    bool public reentryReverted;
    bytes public reentryRevertData;
    address public repayToken;
    uint256 public repayAmount;

    constructor(UniswapV2Pair pair_) {
        pair = pair_;
    }

    function configure(bytes calldata reentry_, address repayToken_, uint256 repayAmount_) external {
        reentry = reentry_;
        repayToken = repayToken_;
        repayAmount = repayAmount_;
    }

    function borrow(uint256 out0, uint256 out1) external {
        pair.swap(out0, out1, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        require(msg.sender == address(pair), "callee: not pair");
        if (reentry.length != 0) {
            (bool ok, bytes memory ret) = address(pair).call(reentry);
            reentryReverted = !ok;
            reentryRevertData = ret;
        }
        if (repayAmount != 0) TestToken(repayToken).transfer(address(pair), repayAmount);
    }
}

/// Internal pre-audit review: adversarial fuzz and regression tests for the
/// changes against upstream Uniswap V2 (reserve caps, fixed fee recipient,
/// removed setters, anchored swaps) and the classic V2 attack classes.
contract DexAuditTest is TestBase {
    AuditVm internal constant avm = AuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant CAP0 = 1_000 ether;
    uint256 internal constant CAP1 = 5_000 ether;
    address internal constant FEE_TO = address(0xFEE5AFE);

    UniswapV2Factory internal factory;
    UniswapV2Pair internal pair;
    TestToken internal token0;
    TestToken internal token1;

    function setUp() public {
        vm.warp(1_000);
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        (TestToken lo, TestToken hi) = address(a) < address(b) ? (a, b) : (b, a);
        address[] memory capTokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (capTokens[0], caps[0], capTokens[1], caps[1]) = (address(lo), CAP0, address(hi), CAP1);
        factory = new UniswapV2Factory(FEE_TO, capTokens, caps);
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        token0 = TestToken(pair.token0());
        token1 = TestToken(pair.token1());
        assertEq(address(token0), address(lo));
    }

    function _seed(uint256 amount0, uint256 amount1) internal returns (uint256 liquidity) {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        liquidity = pair.mint(address(this));
    }

    function _burn(uint256 shares) internal returns (uint256 amount0, uint256 amount1) {
        require(pair.transfer(address(pair), shares));
        return pair.burn(address(this));
    }

    function _k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * r1;
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }

    // ------------------------------------------------------------------ //
    // Reserve caps                                                        //
    // ------------------------------------------------------------------ //

    /// Regression (finding DEX-01): a donation that left the post-burn balance
    /// above both the cap and the pre-burn reserve made burn revert with
    /// RESERVE_CAP, so a donor could block LP exits. Burn must always work.
    function testDonationAboveCapCannotBlockSmallBurn() public {
        uint256 liquidity = _seed(CAP0, 1_000 ether);
        token0.mint(address(pair), 500 ether);
        (uint256 amount0, uint256 amount1) = _burn(liquidity / 10);
        assertTrue(amount0 > 0 && amount1 > 0);
        (uint112 r0,,) = pair.getReserves();
        assertTrue(r0 <= CAP0);
        uint256 excess = token0.balanceOf(address(pair)) - r0;
        pair.skim(address(0xD0));
        assertEq(token0.balanceOf(address(0xD0)), excess);
        assertEq(token0.balanceOf(address(pair)), r0);
    }

    function testFuzzBurnNeverBlockedByDonation(uint256 seed0, uint256 seed1, uint256 don0, uint256 don1, uint256 frac)
        public
    {
        uint256 s0 = _bound(seed0, 1 ether, CAP0);
        uint256 s1 = _bound(seed1, 1 ether, CAP1);
        uint256 liquidity = _seed(s0, s1);
        token0.mint(address(pair), _bound(don0, 0, 1e30));
        token1.mint(address(pair), _bound(don1, 0, 1e30));
        uint256 b0 = token0.balanceOf(address(pair));
        uint256 b1 = token1.balanceOf(address(pair));
        uint256 supply = pair.totalSupply();
        uint256 minShares = supply / (b0 < b1 ? b0 : b1) + 1;
        if (minShares > liquidity) return;
        uint256 shares = _bound(frac, minShares, liquidity);
        (uint112 p0, uint112 p1,) = pair.getReserves();
        _burn(shares);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertTrue(r0 <= (CAP0 > p0 ? CAP0 : p0) && r1 <= (CAP1 > p1 ? CAP1 : p1));
        assertTrue(r0 <= token0.balanceOf(address(pair)) && r1 <= token1.balanceOf(address(pair)));
        pair.skim(address(0xD0));
        (r0, r1,) = pair.getReserves();
        assertEq(token0.balanceOf(address(pair)), r0);
        assertEq(token1.balanceOf(address(pair)), r1);
    }

    /// Cap bypass via direct transfer + sync is refused at any size above the cap.
    function testFuzzTransferThenSyncCannotExceedCap(uint256 seed0, uint256 extra) public {
        uint256 s0 = _bound(seed0, 1 ether, CAP0);
        _seed(s0, 1_000 ether);
        uint256 room = CAP0 - s0;
        uint256 over = room + _bound(extra, 1, 1e30);
        token0.mint(address(pair), over);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        pair.sync();
        pair.skim(address(0xD0));
        token0.mint(address(pair), room);
        pair.sync();
        (uint112 r0,,) = pair.getReserves();
        assertEq(r0, CAP0);
    }

    /// Cap bypass via mint: a deposit above the cap reverts whatever the ratio.
    function testFuzzMintCannotExceedCap(uint256 seed0, uint256 extra) public {
        uint256 s0 = _bound(seed0, 1 ether, CAP0 - 1);
        _seed(s0, s0);
        uint256 add0 = CAP0 - s0 + _bound(extra, 1, 1e24);
        token0.mint(address(pair), add0);
        token1.mint(address(pair), add0);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        pair.mint(address(this));
    }

    /// Cap bypass via a flash swap that repays in the capped token.
    function testFlashSwapRepaidInCappedTokenCannotExceedCap() public {
        _seed(900 ether, 900 ether);
        FlashBorrower borrower = new FlashBorrower(pair);
        token0.mint(address(borrower), 1_000 ether);
        uint256 out1 = 100 ether;
        uint256 in0 = BDexLibrary.getAmountIn(out1, 900 ether, 900 ether);
        assertTrue(900 ether + in0 > CAP0);
        borrower.configure("", address(token0), in0);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        borrower.borrow(0, out1);
    }

    /// Outflows stay open with the capped side at its cap.
    function testSwapOutOfCappedSideAtCapSucceeds() public {
        _seed(CAP0, 1_000 ether);
        uint256 out = BDexLibrary.getAmountOut(10 ether, 1_000 ether, CAP0);
        token1.mint(address(pair), 10 ether);
        pair.swap(out, 0, address(0xD0), "");
        (uint112 r0,,) = pair.getReserves();
        assertEq(r0, CAP0 - out);
    }

    // ------------------------------------------------------------------ //
    // Constant product and rounding                                       //
    // ------------------------------------------------------------------ //

    function testFuzzSwapPreservesKAndOverquoteFails(uint256 seed0, uint256 seed1, uint256 amountIn, bool zeroForOne)
        public
    {
        uint256 s0 = _bound(seed0, 1e6, CAP0);
        uint256 s1 = _bound(seed1, 1e6, CAP1);
        _seed(s0, s1);
        (uint256 rIn, uint256 rOut, uint256 capIn) = zeroForOne ? (s0, s1, CAP0) : (s1, s0, CAP1);
        if (capIn < rIn + 1000) return;
        uint256 amount = _bound(amountIn, 1000, capIn - rIn);
        uint256 out = BDexLibrary.getAmountOut(amount, rIn, rOut);
        if (out == 0) return;
        uint256 kBefore = _k();
        (zeroForOne ? token0 : token1).mint(address(pair), amount);
        if (out + 1 < rOut) {
            vm.expectRevert(bytes("BDEX: K"));
            pair.swap(zeroForOne ? 0 : out + 1, zeroForOne ? out + 1 : 0, address(0xD0), "");
        }
        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(0xD0), "");
        assertTrue(_k() >= kBefore);
    }

    function testFuzzGetAmountInCoversRequestedOutput(uint256 r0, uint256 r1, uint256 outSeed) public pure {
        uint256 reserveIn = _bound(r0, 1e3, 1e30);
        uint256 reserveOut = _bound(r1, 1e3, 1e30);
        uint256 amountOut = _bound(outSeed, 1, reserveOut * 99 / 100);
        uint256 amountIn = BDexLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
        assertTrue(BDexLibrary.getAmountOut(amountIn, reserveIn, reserveOut) >= amountOut);
    }

    /// Mint never over-issues and burn never over-pays, at any size.
    function testFuzzMintBurnRoundingFavoursPool(uint256 seed0, uint256 seed1, uint256 add0, uint256 add1, uint256 out)
        public
    {
        uint256 s0 = _bound(seed0, 1e4, CAP0 / 2);
        uint256 s1 = _bound(seed1, 1e4, CAP1 / 2);
        _seed(s0, s1);
        uint256 a0 = _bound(add0, 1, CAP0 / 2);
        uint256 a1 = _bound(add1, 1, CAP1 / 2);
        uint256 supply = pair.totalSupply();
        token0.mint(address(pair), a0);
        token1.mint(address(pair), a1);
        try pair.mint(address(0xA11CE)) returns (uint256 minted) {
            assertTrue(minted * s0 <= a0 * supply && minted * s1 <= a1 * supply);
        } catch {
            pair.skim(address(0xD0));
        }
        uint256 held = pair.balanceOf(address(this));
        uint256 shares = _bound(out, 1, held);
        supply = pair.totalSupply();
        uint256 b0 = token0.balanceOf(address(pair));
        uint256 b1 = token1.balanceOf(address(pair));
        if (shares * b0 < supply || shares * b1 < supply) return;
        (uint256 o0, uint256 o1) = _burn(shares);
        assertTrue(o0 * supply <= shares * b0 && o1 * supply <= shares * b1);
    }

    // ------------------------------------------------------------------ //
    // DEX-09: an empty pair cannot be bricked                              //
    // ------------------------------------------------------------------ //

    /// Regression (finding DEX-09): donations exactly at both caps could be synced
    /// into the reserves of an empty pair, after which mint and swap reverted forever.
    function testDonationsAtBothCapsCannotBrickTheEmptyPair() public {
        token0.mint(address(pair), CAP0);
        token1.mint(address(pair), CAP1);
        vm.expectRevert(bytes("BDEX: EMPTY_POOL"));
        pair.sync();
        // Above the caps, the unsynced donation blocks the deposit only until skim.
        token0.mint(address(pair), 1);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        pair.mint(address(this));
        pair.skim(address(0xD0));
        assertEq(token0.balanceOf(address(0xD0)), CAP0 + 1);
        assertEq(token1.balanceOf(address(0xD0)), CAP1);
        assertTrue(_seed(CAP0 / 2, CAP1 / 2) > 0);
    }

    /// The reserves of a pair with no LP shares stay zero for any donation, and
    /// the seed works after a skim (this also closes the synced form of DEX-04).
    function testFuzzEmptyPairReservesStayZero(uint256 donation0, uint256 donation1) public {
        uint256 d0 = _bound(donation0, 0, CAP0 * 2);
        uint256 d1 = _bound(donation1, 0, CAP1 * 2);
        token0.mint(address(pair), d0);
        token1.mint(address(pair), d1);
        vm.expectRevert(bytes("BDEX: EMPTY_POOL"));
        pair.sync();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(uint256(r0) + r1, 0);
        pair.skim(address(0xD0));
        assertEq(token0.balanceOf(address(pair)) + token1.balanceOf(address(pair)), 0);
        assertTrue(_seed(CAP0 / 2, CAP1 / 2) > 0);
        (r0, r1,) = pair.getReserves();
        assertEq(r0, CAP0 / 2);
        assertEq(r1, CAP1 / 2);
    }

    // ------------------------------------------------------------------ //
    // First depositor / donation inflation                                //
    // ------------------------------------------------------------------ //

    /// The attacker opens the pool with the minimum, inflates the share price
    /// with a donation, and a victim deposits. The attacker can make the victim
    /// lose value but never profits: the locked 1000 shares absorb the bulk of
    /// every donation.
    function testFuzzFirstDepositorInflationIsUnprofitable(uint256 donation, uint256 victimDeposit) public {
        address attacker = address(0xBAD);
        address victim = address(0x71C);
        token0.mint(address(pair), 1001);
        token1.mint(address(pair), 1001);
        pair.mint(attacker);
        assertEq(pair.balanceOf(attacker), 1);
        uint256 d = _bound(donation, 1, CAP0 - 1001);
        token0.mint(address(pair), d);
        token1.mint(address(pair), d * (CAP1 - 1001) / (CAP0 - 1001));
        pair.sync();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 attackerCost0 = 1001 + d;
        if (r0 >= CAP0) return;
        uint256 v0 = _bound(victimDeposit, 1, CAP0 - r0);
        uint256 v1 = v0 * r1 / r0 + 1;
        if (uint256(r1) + v1 > CAP1) return;
        token0.mint(address(pair), v0);
        token1.mint(address(pair), v1);
        try pair.mint(victim) {}
        catch {
            return;
        }
        uint256 supply = pair.totalSupply();
        uint256 attackerValue0 = token0.balanceOf(address(pair)) * pair.balanceOf(attacker) / supply;
        assertTrue(attackerValue0 <= attackerCost0);
    }

    // ------------------------------------------------------------------ //
    // Protocol fee                                                        //
    // ------------------------------------------------------------------ //

    /// The recipient's mint equals the v2 closed form and never exceeds 1/6 of
    /// the sqrt(k) growth since the last liquidity event.
    function testFuzzMintFeeMatchesClosedFormAndOneSixthBound(uint256 trades, uint256 size) public {
        _seed(500 ether, 2_000 ether);
        uint256 n = _bound(trades, 1, 12);
        for (uint256 i; i < n; ++i) {
            (uint112 r0, uint112 r1,) = pair.getReserves();
            bool zeroForOne = (i % 2) == 0;
            uint256 amount = _bound(uint256(keccak256(abi.encode(size, i))), 1e9, 20 ether);
            if (zeroForOne && uint256(r0) + amount > CAP0) continue;
            uint256 out = BDexLibrary.getAmountOut(amount, zeroForOne ? r0 : r1, zeroForOne ? r1 : r0);
            (zeroForOne ? token0 : token1).mint(address(pair), amount);
            pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(0xD0), "");
        }
        (uint112 q0, uint112 q1,) = pair.getReserves();
        uint256 rootK = Math.sqrt(uint256(q0) * q1);
        uint256 rootKLast = Math.sqrt(pair.kLast());
        uint256 supply = pair.totalSupply();
        uint256 expected = rootK > rootKLast ? supply * (rootK - rootKLast) / (rootK * 5 + rootKLast) : 0;
        uint256 before = pair.balanceOf(FEE_TO);
        _burn(1_000);
        uint256 fee = pair.balanceOf(FEE_TO) - before;
        assertEq(fee, expected);
        assertTrue(fee * 6 * rootK <= (supply + fee) * (rootK - rootKLast));
        (q0, q1,) = pair.getReserves();
        assertEq(pair.kLast(), uint256(q0) * q1);
    }

    /// Donations followed by sync also grow sqrt(k), so they also pay the
    /// recipient 1/6 of their growth at the next liquidity event (canonical).
    function testDonationSyncAccruesProtocolFee() public {
        _seed(500 ether, 500 ether);
        token0.mint(address(pair), 10 ether);
        token1.mint(address(pair), 10 ether);
        pair.sync();
        _burn(1_000);
        assertTrue(pair.balanceOf(FEE_TO) > 0);
    }

    /// No fee is minted when the recipient is address(0), and kLast stays 0.
    function testFeeOffFactoryNeverTracksKLast() public {
        UniswapV2Factory off = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        UniswapV2Pair p = UniswapV2Pair(off.createPair(address(token0), address(token1)));
        token0.mint(address(p), 100 ether);
        token1.mint(address(p), 100 ether);
        p.mint(address(this));
        assertEq(p.kLast(), 0);
    }

    // ------------------------------------------------------------------ //
    // No setter paths                                                     //
    // ------------------------------------------------------------------ //

    function testNoAdminSelectorsOnFactoryOrPair() public {
        _seed(100 ether, 100 ether);
        bytes[] memory calls = new bytes[](12);
        calls[0] = abi.encodeWithSignature("setFeeTo(address)", address(this));
        calls[1] = abi.encodeWithSignature("setFeeToSetter(address)", address(this));
        calls[2] = abi.encodeWithSignature("setReserveCap(address,uint256)", address(token0), 0);
        calls[3] = abi.encodeWithSignature("setCap(address,uint256)", address(token0), 0);
        calls[4] = abi.encodeWithSignature("transferOwnership(address)", address(this));
        calls[5] = abi.encodeWithSignature("owner()");
        calls[6] = abi.encodeWithSignature("feeToSetter()");
        calls[7] = abi.encodeWithSignature("pause()");
        calls[8] = abi.encodeWithSignature("upgradeTo(address)", address(this));
        calls[9] = abi.encodeWithSignature("setReserveCaps(uint112,uint112)", 0, 0);
        calls[10] = abi.encodeWithSignature("acceptFeeToSetter()");
        calls[11] = abi.encodeWithSignature("rescue(address,address,uint256)", address(token0), address(this), 1);
        for (uint256 i; i < calls.length; ++i) {
            (bool okFactory,) = address(factory).call(calls[i]);
            (bool okPair,) = address(pair).call(calls[i]);
            assertTrue(!okFactory && !okPair);
        }
        vm.prank(address(factory));
        vm.expectRevert(bytes("BDEX: ALREADY_INITIALIZED"));
        pair.initialize(address(token0), address(token1));
        vm.expectRevert(bytes("BDEX: FORBIDDEN"));
        pair.initialize(address(1), address(2));
        (uint112 c0, uint112 c1) = pair.reserveCaps();
        assertEq(c0, CAP0);
        assertEq(c1, CAP1);
        assertEq(factory.feeTo(), FEE_TO);
    }

    // ------------------------------------------------------------------ //
    // Reentrancy                                                          //
    // ------------------------------------------------------------------ //

    function _reentryCalls() internal view returns (bytes[] memory calls) {
        calls = new bytes[](5);
        calls[0] = abi.encodeCall(UniswapV2Pair.swap, (1, 0, address(0xD0), bytes("")));
        calls[1] = abi.encodeCall(UniswapV2Pair.mint, (address(this)));
        calls[2] = abi.encodeCall(UniswapV2Pair.burn, (address(this)));
        calls[3] = abi.encodeCall(UniswapV2Pair.skim, (address(this)));
        calls[4] = abi.encodeCall(UniswapV2Pair.sync, ());
    }

    function _isLocked(bytes memory revertData) internal pure returns (bool) {
        return keccak256(revertData) == keccak256(abi.encodeWithSignature("Error(string)", "BDEX: LOCKED"));
    }

    function testFlashCallbackReentryHitsLockOnEveryEntrypoint() public {
        _seed(500 ether, 500 ether);
        FlashBorrower borrower = new FlashBorrower(pair);
        token1.mint(address(borrower), 100 ether);
        bytes[] memory calls = _reentryCalls();
        uint256 out0 = 1 ether;
        uint256 in1 = BDexLibrary.getAmountIn(out0, 500 ether, 500 ether);
        for (uint256 i; i < calls.length; ++i) {
            borrower.configure(calls[i], address(token1), in1);
            borrower.borrow(out0, 0);
            assertTrue(borrower.reentryReverted());
            assertTrue(_isLocked(borrower.reentryRevertData()));
            (uint112 r0, uint112 r1,) = pair.getReserves();
            in1 = BDexLibrary.getAmountIn(out0, r1, r0);
        }
    }

    function testTokenHookReentryHitsLockOnEveryEntrypoint() public {
        HookToken hook = new HookToken();
        TestToken plain = new TestToken();
        UniswapV2Factory f = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        UniswapV2Pair p = UniswapV2Pair(f.createPair(address(hook), address(plain)));
        hook.mint(address(p), 500 ether);
        plain.mint(address(p), 500 ether);
        uint256 liquidity = p.mint(address(this));
        bytes[] memory calls = new bytes[](5);
        calls[0] = abi.encodeCall(UniswapV2Pair.swap, (1, 0, address(0xD0), bytes("")));
        calls[1] = abi.encodeCall(UniswapV2Pair.mint, (address(this)));
        calls[2] = abi.encodeCall(UniswapV2Pair.burn, (address(this)));
        calls[3] = abi.encodeCall(UniswapV2Pair.skim, (address(this)));
        calls[4] = abi.encodeCall(UniswapV2Pair.sync, ());
        for (uint256 i; i < calls.length; ++i) {
            // The pair pays `hook` out during burn, which fires the hook mid-burn.
            require(p.transfer(address(p), liquidity / 100));
            hook.arm(address(p), calls[i]);
            p.burn(address(this));
            assertTrue(hook.hookReverted());
            assertTrue(_isLocked(hook.hookRevertData()));
        }
        p.sync();
    }

    // ------------------------------------------------------------------ //
    // Donation / skim / sync                                              //
    // ------------------------------------------------------------------ //

    /// A donation is taken by whoever calls skim; it never changes reserves,
    /// shares or kLast.
    function testFuzzSkimReturnsExactExcessOnly(uint256 d0, uint256 d1) public {
        _seed(500 ether, 500 ether);
        uint256 a = _bound(d0, 0, 1e30);
        uint256 b = _bound(d1, 0, 1e30);
        token0.mint(address(pair), a);
        token1.mint(address(pair), b);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 supply = pair.totalSupply();
        uint256 kl = pair.kLast();
        pair.skim(address(0xD0));
        (uint112 n0, uint112 n1,) = pair.getReserves();
        assertEq(n0, r0);
        assertEq(n1, r1);
        assertEq(token0.balanceOf(address(0xD0)), a);
        assertEq(token1.balanceOf(address(0xD0)), b);
        assertEq(pair.totalSupply(), supply);
        assertEq(pair.kLast(), kl);
    }

    /// A standing donation of the input token cannot be stolen by a swapper
    /// beyond what the k check allows: the donation counts as input.
    function testDonationIsUsableAsSwapInputOnlyWithinK() public {
        _seed(500 ether, 500 ether);
        token0.mint(address(pair), 10 ether);
        uint256 out = BDexLibrary.getAmountOut(10 ether, 500 ether, 500 ether);
        vm.expectRevert(bytes("BDEX: K"));
        pair.swap(0, out + 1, address(0xD0), "");
        pair.swap(0, out, address(0xD0), "");
    }

    // ------------------------------------------------------------------ //
    // Anchored swaps                                                      //
    // ------------------------------------------------------------------ //

    function testAnchorRejectsFutureCurrentZeroAndExpiredBlocks() public {
        TestWrappedNative w = new TestWrappedNative();
        UniswapV2Factory f = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        BDexRouter router = new BDexRouter(address(f), address(w));
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(token0), address(token1));
        avm.roll(1_000);
        avm.setBlockhash(990, keccak256("seen"));
        uint256[4] memory numbers = [uint256(1_000), 1_001, 990, 700];
        bytes32[4] memory hashes = [keccak256("seen"), keccak256("seen"), bytes32(0), keccak256("seen")];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(bytes("BDEX: ANCHOR"));
            router.swapExactTokensForTokensAnchored(1, 0, path, address(0xD0), block.timestamp, numbers[i], hashes[i]);
        }
        vm.expectRevert(bytes("BDEX: ANCHOR"));
        router.swapExactTokensForTokensAnchored(1, 0, path, address(0xD0), block.timestamp, 990, keccak256("fork"));
    }
}
