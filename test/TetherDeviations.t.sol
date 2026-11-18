// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Round 20 (agent 409): USDT as a second listed token on the public chains (docs/MULTICHAIN-DEPLOY.md section
// 2.6). The contracts are frozen; these tests state what the unchanged pair and router do with each way in which
// a USDT differs from a plain ERC-20, against local stand-ins of the deployed tokens (test/mocks/
// TetherLegacyToken.sol; the fork rehearsal runs the same flows against the real contracts):
//   1. Ethereum's Tether contract returns no value from transfer, transferFrom and approve: the pair and the
//      router accept that everywhere they move a token (first deposit, later deposit, swaps both ways, a two-hop
//      swap between two such pools' tokens, withdrawal, skim, the protocol fee).
//   2. Its approve reverts on a change from one non-zero allowance to another: the router never calls approve, so
//      the contracts are not affected; the caller is, and the tools print approve(0) first (kit tests, rehearsal).
//   3. Its transfer fee, when the issuer switches it on, is NOT supported: the tests below record what happens
//      (not what one would wish): a strict first deposit does NOT revert, it opens the pool short of the fee; a
//      plain swap that sells the token reverts; a swap that buys it pays the buyer short. This is why the gate and
//      first-deposit.mjs read the fee parameters and refuse while one is not zero.
//   4. Pause, blacklist and deprecation: a paused token freezes the pool; a blacklisted pair can still receive but
//      can never pay the token out; a deprecated contract answers balances from another contract, so the pool's
//      reserves no longer mean anything.
//   5. The other chains' USDT (bridged on OP Mainnet, USD₮0 on Arbitrum One, Binance-Peg with 18 decimals on BNB
//      Smart Chain) are plain tokens to the pair and the router; shown with 6 and with 18 decimals.
import {TestBase} from "./TestBase.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {TetherLegacyToken, UpgradedTetherStandIn, PlainUsdtLikeToken} from "./mocks/TetherLegacyToken.sol";

interface TetherVm {
    function startPrank(address sender, address origin) external;
    function prank(address sender, address origin) external;
}

contract TetherDeviationsTest is TestBase {
    TetherVm constant tvm = TetherVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant FEE_TO = 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544;
    address constant OWNER = address(0xA11CE);
    address constant TRADER = address(0xB0B);
    address constant ISSUER = address(0x7E7);
    uint256 constant NATIVE = 10 ether;
    // 1 native = 1,764 USDT, six decimals.
    uint256 constant USDT_IN = 17_640e6;

    WBLCH wrapped;
    TetherLegacyToken usdt;
    UniswapV2Factory factory;
    BDexRouter router;

    function setUp() public {
        wrapped = new WBLCH();
        vm.prank(ISSUER);
        usdt = new TetherLegacyToken();
        vm.startPrank(ISSUER);
        usdt.issue(1_000_000e6);
        usdt.transfer(OWNER, 100_000e6);
        usdt.transfer(TRADER, 10_000e6);
        vm.stopPrank();
        vm.deal(OWNER, 100 ether);
        vm.deal(TRADER, 100 ether);
        // The package's plan: the owner's depositing account is the first depositor, no caps, no pair created.
        factory = new UniswapV2Factory(FEE_TO, OWNER, new address[](0), new uint256[](0));
        router = new BDexRouter(address(factory), address(wrapped));
    }

    function _pair(address token) private view returns (UniswapV2Pair) {
        return UniswapV2Pair(factory.getPair(address(wrapped), token));
    }

    function _reserves(UniswapV2Pair pair) private view returns (uint256 rNative, uint256 rToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rNative, rToken) = pair.token0() == address(wrapped) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// The owner's first deposit exactly as first-deposit.mjs prints it: approve the amount, minimums = amounts.
    function _open() private returns (UniswapV2Pair pair) {
        tvm.startPrank(OWNER, OWNER);
        usdt.approve(address(router), USDT_IN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdt), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        pair = _pair(address(usdt));
    }

    function _path(address a, address b) private pure returns (address[] memory path) {
        path = new address[](2);
        (path[0], path[1]) = (a, b);
    }

    /// The stand-in really returns nothing: a caller that expects a bool would revert on it.
    function test_theStandInReturnsNoValueFromTransferApproveAndTransferFrom() public {
        vm.prank(OWNER);
        (bool ok, bytes memory data) = address(usdt).call(abi.encodeWithSignature("transfer(address,uint256)", TRADER, 1));
        assertTrue(ok && data.length == 0);
        vm.prank(OWNER);
        (ok, data) = address(usdt).call(abi.encodeWithSignature("approve(address,uint256)", TRADER, 5));
        assertTrue(ok && data.length == 0);
        vm.prank(TRADER);
        (ok, data) =
            address(usdt).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", OWNER, TRADER, 3));
        assertTrue(ok && data.length == 0);
        assertEq(usdt.allowance(OWNER, TRADER), 2);
    }

    /// 1. No return value: the strict first deposit opens the pool at exactly the two amounts.
    function test_noReturnValue_theStrictFirstDepositOpensThePoolAtItsAmounts() public {
        UniswapV2Pair pair = _open();
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE);
        assertEq(rToken, USDT_IN);
        assertEq(usdt.balanceOf(address(pair)), USDT_IN);
        // The exact approval was consumed: nothing is left for a later non-zero approve to trip over.
        assertEq(usdt.allowance(OWNER, address(router)), 0);
    }

    /// 1. No return value: swaps both ways, a later deposit, the withdrawal, and skim all move the token.
    function test_noReturnValue_swapsALaterDepositWithdrawalAndSkimAllWork() public {
        UniswapV2Pair pair = _open();
        // Buy USDT with the native coin.
        uint256 before = usdt.balanceOf(TRADER);
        vm.prank(TRADER);
        uint256[] memory out =
            router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
        assertEq(usdt.balanceOf(TRADER) - before, out[1]);
        assertTrue(out[1] > 1_590e6 && out[1] < 1_764e6);
        // Sell USDT for the native coin (exact approval, as the page does).
        vm.startPrank(TRADER);
        usdt.approve(address(router), 500e6);
        uint256 nativeBefore = TRADER.balance;
        out = router.swapExactTokensForBLCH(500e6, 1, _path(address(usdt), address(wrapped)), TRADER, block.timestamp);
        vm.stopPrank();
        assertEq(TRADER.balance - nativeBefore, out[1]);
        assertEq(usdt.allowance(TRADER, address(router)), 0);
        // A later deposit by the owner at the pool's price.
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        uint256 more = (1 ether * rToken) / rNative;
        tvm.startPrank(OWNER, OWNER);
        usdt.approve(address(router), more);
        router.addLiquidityBLCH{value: 1 ether}(address(usdt), more, (more * 995) / 1000, 0.995 ether, OWNER, block.timestamp);
        // A donation of USDT is skimmed out to whoever asks (the pair pays a no-return token out).
        usdt.transfer(address(pair), 7e6);
        vm.stopPrank();
        pair.skim(TRADER);
        // The owner withdraws everything but the locked minimum; both sides arrive.
        uint256 shares = pair.balanceOf(OWNER);
        uint256 usdtBefore = usdt.balanceOf(OWNER);
        tvm.startPrank(OWNER, OWNER);
        pair.approve(address(router), shares);
        (uint256 gotToken, uint256 gotNative) =
            router.removeLiquidityBLCH(address(usdt), shares, 1, 1, OWNER, block.timestamp);
        vm.stopPrank();
        assertEq(usdt.balanceOf(OWNER) - usdtBefore, gotToken);
        assertTrue(gotToken > 17_000e6 && gotNative > 10 ether);
    }

    /// 1. A two-hop swap between the tokens of two pools (USDT -> native -> a plain token), as the page routes it.
    function test_noReturnValue_aTwoHopSwapThroughTheWrappedTokenWorks() public {
        _open();
        vm.prank(ISSUER);
        PlainUsdtLikeToken usdc = new PlainUsdtLikeToken(6);
        vm.prank(ISSUER);
        usdc.mint(OWNER, 100_000e6);
        tvm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), USDT_IN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        address[] memory path = new address[](3);
        (path[0], path[1], path[2]) = (address(usdt), address(wrapped), address(usdc));
        vm.startPrank(TRADER);
        usdt.approve(address(router), 100e6);
        uint256[] memory out = router.swapExactTokensForTokens(100e6, 1, path, TRADER, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(TRADER), out[2]);
        assertTrue(out[2] > 98e6 && out[2] < 100e6);
    }

    /// 2. approve reverts on non-zero -> non-zero (the same value included); zero first works. The router never
    ///    approves, so a deposit after a stale allowance needs the caller to reset it: the printed sequence.
    function test_approveNeedsZeroFirst_theStaleAllowanceSequence() public {
        tvm.startPrank(OWNER, OWNER);
        usdt.approve(address(router), 17_000e6);
        // An earlier run's allowance stands (its deposit was never sent). A new exact approve reverts ...
        vm.expectRevert();
        usdt.approve(address(router), USDT_IN);
        vm.expectRevert();
        usdt.approve(address(router), 17_000e6);
        // ... and the deposit for the new amount cannot be paid from the old allowance.
        vm.expectRevert();
        router.addLiquidityBLCH{value: NATIVE}(address(usdt), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        // What first-deposit.mjs prints for it: approve 0, approve the amount, the deposit.
        usdt.approve(address(router), 0);
        usdt.approve(address(router), USDT_IN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdt), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        (uint256 rNative, uint256 rToken) = _reserves(_pair(address(usdt)));
        assertEq(rNative, NATIVE);
        assertEq(rToken, USDT_IN);
    }

    /// 2. An allowance that already is the amount: no approve at all, only the deposit.
    function test_approveNeedsZeroFirst_anAllowanceEqualToTheAmountNeedsNoApprove() public {
        tvm.startPrank(OWNER, OWNER);
        usdt.approve(address(router), USDT_IN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdt), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(_pair(address(usdt)))), USDT_IN);
    }

    /// 3. The fee switched on BEFORE the first deposit: the strict deposit does NOT revert. The router checks its
    ///    minimums against the amounts it sends, not against what the pair receives; the pool opens short of the
    ///    fee, at another price than the deposit's, and the Mint log shows less than was deposited (which is what
    ///    makes first-deposit.mjs verify refuse to call the opening proven). The tools must refuse BEFORE this.
    function test_feeOn_theStrictFirstDepositDoesNotRevertAndOpensThePoolShort() public {
        vm.prank(ISSUER);
        usdt.setParams(10, 10); // 0.10%, at most 10 USDT
        uint256 issuerBefore = usdt.balanceOf(ISSUER);
        UniswapV2Pair pair = _open();
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE);
        // 0.10% of 17,640 is 17.64, capped at 10 USDT.
        assertEq(rToken, USDT_IN - 10e6);
        assertEq(usdt.balanceOf(ISSUER) - issuerBefore, 10e6);
    }

    /// 3. The fee switched on AFTER the pool is open: selling the token through the plain router call reverts
    ///    (the pair is paid short of what the router computed: BDEX: K); buying it succeeds on chain but pays the
    ///    buyer less than the router's quote and less than the minimum the router checked.
    function test_feeOn_sellingRevertsAndBuyingPaysShortOfTheCheckedMinimum() public {
        _open();
        vm.prank(ISSUER);
        usdt.setParams(10, 10);
        vm.startPrank(TRADER);
        usdt.approve(address(router), 500e6);
        vm.expectRevert(bytes("BDEX: K"));
        router.swapExactTokensForBLCH(500e6, 1, _path(address(usdt), address(wrapped)), TRADER, block.timestamp);
        vm.stopPrank();
        uint256[] memory quoted = router.getAmountsOut(1 ether, _path(address(wrapped), address(usdt)));
        uint256 before = usdt.balanceOf(TRADER);
        vm.prank(TRADER);
        // The minimum is the full quote: the router's check passes, and the trader still receives less.
        router.swapExactBLCHForTokens{value: 1 ether}(quoted[1], _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
        uint256 received = usdt.balanceOf(TRADER) - before;
        assertTrue(received < quoted[1]);
        assertEq(quoted[1] - received, (quoted[1] * 10) / 10000);
    }

    /// 3. The issuer's limits as observed on the fork: below 20 basis points and below 50 whole tokens.
    function test_feeParameters_theLimitsOfSetParams() public {
        vm.startPrank(ISSUER);
        usdt.setParams(19, 49);
        assertEq(usdt.basisPointsRate(), 19);
        assertEq(usdt.maximumFee(), 49e6);
        vm.expectRevert();
        usdt.setParams(20, 49);
        vm.expectRevert();
        usdt.setParams(19, 50);
        usdt.setParams(0, 0);
        vm.stopPrank();
        assertEq(usdt.basisPointsRate() + usdt.maximumFee(), 0);
        vm.prank(TRADER);
        vm.expectRevert();
        usdt.setParams(1, 1);
    }

    /// 4. Paused: nothing moves the token; the pool cannot be traded, added to or withdrawn from. Unpaused, it
    ///    works again: nothing was lost in the pair.
    function test_paused_thePoolIsFrozenUntilTheIssuerUnpauses() public {
        UniswapV2Pair pair = _open();
        vm.prank(ISSUER);
        usdt.pause();
        vm.prank(TRADER);
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
        uint256 shares = pair.balanceOf(OWNER);
        tvm.startPrank(OWNER, OWNER);
        pair.approve(address(router), shares);
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        router.removeLiquidityBLCH(address(usdt), shares, 1, 1, OWNER, block.timestamp);
        vm.stopPrank();
        vm.prank(ISSUER);
        usdt.unpause();
        vm.prank(TRADER);
        router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
    }

    /// 4. The pair's address blacklisted: tokens still arrive, none can leave; its USDT is stuck (and the issuer
    ///    can destroy it). The native side can still be bought with USDT, never the other way round.
    function test_blacklistedPair_canReceiveButNeverPayTheTokenOut() public {
        UniswapV2Pair pair = _open();
        vm.prank(ISSUER);
        usdt.addBlackList(address(pair));
        vm.prank(TRADER);
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
        vm.startPrank(TRADER);
        usdt.approve(address(router), 500e6);
        router.swapExactTokensForBLCH(500e6, 1, _path(address(usdt), address(wrapped)), TRADER, block.timestamp);
        vm.stopPrank();
        uint256 held = usdt.balanceOf(address(pair));
        vm.prank(ISSUER);
        usdt.destroyBlackFunds(address(pair));
        assertEq(usdt.balanceOf(address(pair)), 0);
        assertTrue(held > USDT_IN);
    }

    /// 4. Deprecated: the legacy contract answers balanceOf from another contract. The pair's recorded reserve of
    ///    17,640 USDT now faces a balance of zero there; a swap that should pay USDT out reverts in the new
    ///    contract, and `sync` would write the reserve down to whatever the new contract says.
    function test_deprecated_thePoolsBalanceIsWhateverTheNewContractSays() public {
        UniswapV2Pair pair = _open();
        UpgradedTetherStandIn next = new UpgradedTetherStandIn();
        vm.prank(ISSUER);
        usdt.deprecate(address(next));
        (, uint256 rToken) = _reserves(pair);
        assertEq(rToken, USDT_IN);
        assertEq(usdt.balanceOf(address(pair)), 0);
        vm.prank(TRADER);
        vm.expectRevert();
        router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(usdt)), TRADER, block.timestamp);
    }

    /// 5. A plain USDT with 6 decimals (bridged on OP Mainnet, USD₮0 on Arbitrum One) and one with 18 (Binance-Peg
    ///    on BNB Smart Chain): the strict first deposit, a swap each way, and an allowance changed freely.
    function test_plainUsdt_sixAndEighteenDecimals() public {
        uint8[2] memory decimals = [6, 18];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(ISSUER);
            PlainUsdtLikeToken token = new PlainUsdtLikeToken(decimals[i]);
            uint256 unit = 10 ** uint256(decimals[i]);
            vm.startPrank(ISSUER);
            token.mint(OWNER, 100_000 * unit);
            token.mint(TRADER, 10_000 * unit);
            vm.stopPrank();
            uint256 amount = 5_800 * unit; // 1 native = 580
            tvm.startPrank(OWNER, OWNER);
            token.approve(address(router), 1); // a stale allowance is simply replaced
            token.approve(address(router), amount);
            router.addLiquidityBLCH{value: NATIVE}(address(token), amount, amount, NATIVE, OWNER, block.timestamp);
            vm.stopPrank();
            (uint256 rNative, uint256 rToken) = _reserves(_pair(address(token)));
            assertEq(rNative, NATIVE);
            assertEq(rToken, amount);
            vm.startPrank(TRADER);
            uint256[] memory out = router.swapExactBLCHForTokens{value: 1 ether}(
                1, _path(address(wrapped), address(token)), TRADER, block.timestamp
            );
            assertTrue(out[1] > 520 * unit && out[1] < 580 * unit);
            token.approve(address(router), 100 * unit);
            router.swapExactTokensForBLCH(100 * unit, 1, _path(address(token), address(wrapped)), TRADER, block.timestamp);
            vm.stopPrank();
        }
    }

    /// 5. A token with a blocklist of USD₮0's kind: a pair whose address is blocked cannot pay the token out.
    function test_blockedPair_ofAPlainTokenCannotPayItOut() public {
        vm.prank(ISSUER);
        PlainUsdtLikeToken token = new PlainUsdtLikeToken(6);
        vm.prank(ISSUER);
        token.mint(OWNER, 100_000e6);
        tvm.startPrank(OWNER, OWNER);
        token.approve(address(router), USDT_IN);
        router.addLiquidityBLCH{value: NATIVE}(address(token), USDT_IN, USDT_IN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        address pair = address(_pair(address(token)));
        vm.prank(ISSUER);
        token.addToBlockedList(pair);
        vm.prank(TRADER);
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        router.swapExactBLCHForTokens{value: 1 ether}(1, _path(address(wrapped), address(token)), TRADER, block.timestamp);
    }
}
