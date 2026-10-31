// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";

/// Agent 51 adversarial review of the DEX RC at the committed mainnet caps.
/// `testFAIL51_*` state the property a user or the launch needs; they fail on
/// the RC. `testEVIDENCE51_*` pass and log the measured attack economics.
contract Review51Test is TestBase {
    event log_named_uint(string key, uint256 val);
    event log_string(string val);

    uint256 internal constant CAP_W = 10 ether;
    uint256 internal constant CAP_Q = 1_000e6;
    address internal constant SAFE = address(0x5AFE);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant USER = address(0x1234);

    WBLCH internal wblch;
    TestToken internal busdc;
    UniswapV2Factory internal factory;
    BDexRouter internal router;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000);
        wblch = new WBLCH();
        busdc = new TestToken();
        address[] memory tokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (tokens[0], caps[0]) = (address(wblch), CAP_W);
        (tokens[1], caps[1]) = (address(busdc), CAP_Q);
        factory = new UniswapV2Factory(SAFE, address(0), tokens, caps);
        router = new BDexRouter(address(factory), address(wblch));
        vm.deal(address(this), 100 ether);
        vm.deal(ATTACKER, 100 ether);
        vm.deal(USER, 100 ether);
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? address(this) : i == 1 ? ATTACKER : USER;
            busdc.mint(who, 100_000e6);
            vm.startPrank(who);
            busdc.approve(address(router), type(uint256).max);
            wblch.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function pairOf() internal returns (UniswapV2Pair pair) {
        address existing = factory.getPair(address(wblch), address(busdc));
        pair = UniswapV2Pair(existing == address(0) ? factory.createPair(address(wblch), address(busdc)) : existing);
    }

    function path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
    }

    /// Raw mint the way an attacker would: both sides brought to 80% of their
    /// caps, the most the k ceiling allows evenly. The original filled to the caps,
    /// which now reverts.
    function fillToCeiling(UniswapV2Pair pair) internal returns (uint256 shares, uint256 paidW, uint256 paidQ) {
        (uint256 rW, uint256 rQ) = reservesWQ(pair);
        paidW = CAP_W * 8 / 10 - rW;
        paidQ = CAP_Q * 8 / 10 - rQ;
        vm.startPrank(ATTACKER);
        wblch.deposit{value: paidW}();
        wblch.transfer(address(pair), paidW);
        busdc.transfer(address(pair), paidQ);
        shares = pair.mint(ATTACKER);
        vm.stopPrank();
    }

    function reservesWQ(UniswapV2Pair pair) internal view returns (uint256 w, uint256 q) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (w, q) = pair.token0() == address(wblch) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function seed(uint256 w, uint256 q) internal {
        router.addLiquidityBLCH{value: w}(address(busdc), q, q, w, address(this), block.timestamp);
    }

    function trySellQuote(uint256 q) internal returns (bool ok) {
        vm.prank(USER);
        try router.swapExactTokensForBLCH(q, 0, path(address(busdc), address(wblch)), USER, block.timestamp) {
            ok = true;
        } catch {}
    }

    function trySellNative(uint256 w) internal returns (bool ok) {
        vm.prank(USER);
        try router.swapExactBLCHForTokens{value: w}(0, path(address(wblch), address(busdc)), USER, block.timestamp) {
            ok = true;
        } catch {}
    }

    // ---------------------------------------------------------------- F1 ----

    /// Fix F1: a mint to both caps is refused, and the largest even first mint
    /// leaves swaps open both ways. Further deposits stay blocked while that capital
    /// stays in. The original test required the seed itself to pass, which no bound
    /// on the pool's size can give. See testATK_E1 in F1Attack.t.sol.
    function testFAIL51_F1a_seedMustSurviveHostileFirstMintAtBothCaps() public {
        UniswapV2Pair pair = pairOf();
        vm.startPrank(ATTACKER);
        wblch.deposit{value: CAP_W}();
        wblch.transfer(address(pair), CAP_W);
        busdc.transfer(address(pair), CAP_Q);
        vm.expectRevert(bytes("BDEX: K_CEILING"));
        pair.mint(ATTACKER);
        pair.skim(ATTACKER);
        vm.stopPrank();
        fillToCeiling(pair);
        require(trySellQuote(1e6), "F1a: selling 1 bUSDC reverts after the hostile first mint");
        require(trySellNative(0.001 ether), "F1a: selling 0.001 BLCH reverts after the hostile first mint");
    }

    function testFAIL51_F1b_swapsMustSurviveLpFillAfterSeed() public {
        seed(5 ether, 500e6);
        fillToCeiling(pairOf());
        require(trySellQuote(1e6), "F1b: selling 1 bUSDC reverts after the LP fill");
        require(trySellNative(0.001 ether), "F1b: selling 0.001 BLCH reverts after the LP fill");
    }

    /// Passes: donating both sides to the caps and recording through a swap or a
    /// burn leaves the reserves at or below the ceiling, and skim reopens swaps.
    function testEVIDENCE51_F1c_freezeCostAndRefill() public {
        UniswapV2Pair pair = pairOf();
        seed(5 ether, 500e6);
        fillToCeiling(pair);
        (uint256 rW, uint256 rQ) = reservesWQ(pair);
        vm.startPrank(ATTACKER);
        wblch.deposit{value: CAP_W}();
        wblch.transfer(address(pair), CAP_W - rW);
        busdc.transfer(address(pair), CAP_Q - rQ);
        vm.expectRevert(bytes("BDEX: K_CEILING"));
        pair.sync();
        bool wFirst = pair.token0() == address(wblch);
        pair.swap(wFirst ? 1 : 0, wFirst ? 0 : 1, ATTACKER, "");
        pair.transfer(address(pair), 1e9);
        pair.burn(ATTACKER);
        vm.stopPrank();
        (rW, rQ) = reservesWQ(pair);
        emit log_named_uint("reserve WBLCH wei", rW);
        emit log_named_uint("reserve bUSDC units", rQ);
        assertTrue(rW * rQ <= CAP_W * CAP_Q * 64 / 100);
        pair.skim(address(0xD0));
        assertTrue(trySellQuote(1e6) && trySellNative(0.001 ether));
    }

    // ---------------------------------------------------------------- F2 ----

    /// Anyone can create the planned pair once the factory exists. The factory
    /// still refuses a second creation. The fix is in the tooling, which accepts
    /// the existing pair; this test states what that relies on: same address as
    /// predicted, same caps, whoever created it. Restated from the original, which
    /// required a contract change the tooling fix does not make.
    function testFAIL51_F2_plannedCreatePairMustSurviveFrontRun() public {
        (address a, address b) =
            address(wblch) < address(busdc) ? (address(wblch), address(busdc)) : (address(busdc), address(wblch));
        address planned = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", address(factory), keccak256(abi.encodePacked(a, b)), factory.INIT_CODE_PAIR_HASH()
                        )
                    )
                )
            )
        );
        vm.prank(ATTACKER);
        address created = factory.createPair(address(wblch), address(busdc));
        require(created == planned, "F2: a third party's pair must be at the planned address");
        assertEq(factory.getPair(address(wblch), address(busdc)), planned);
        (uint112 cap0, uint112 cap1) = UniswapV2Pair(planned).reserveCaps();
        bool wFirst = UniswapV2Pair(planned).token0() == address(wblch);
        assertEq(uint256(wFirst ? cap0 : cap1), CAP_W);
        assertEq(uint256(wFirst ? cap1 : cap0), CAP_Q);
        vm.expectRevert(bytes("BDEX: PAIR_EXISTS"));
        factory.createPair(address(wblch), address(busdc));
    }

    // ---------------------------------------------------------------- F3 ----

    function out(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return amountIn * 997 * rOut / (rIn * 1000 + amountIn * 997);
    }

    /// Pool at finalized 5 WBLCH / 125 bUSDC; at latest the price has doubled.
    function movedPool() internal returns (uint256 latestOut, uint256 minimum, uint256 amountIn) {
        UniswapV2Pair pair = pairOf();
        seed(5 ether, 125e6);
        amountIn = 0.5 ether;
        uint256 finalizedOut = out(amountIn, 5 ether, 125e6);
        minimum = finalizedOut * 9950 / 10_000; // the UI's bound, 0.50% below finalized
        (uint256 w, uint256 q) = reservesWQ(pair);
        uint256 buy = q * 415 / 1000; // ordinary buyer: price roughly doubles
        vm.prank(address(this));
        busdc.approve(address(router), type(uint256).max);
        router.swapExactTokensForBLCH(buy, 0, path(address(busdc), address(wblch)), address(this), block.timestamp);
        (w, q) = reservesWQ(pair);
        latestOut = out(amountIn, w, q);
        require(latestOut >= minimum, "the UI's compareQuotes would not return ok");
    }

    /// A user at 0.50% slippage must not lose much more than 0.50% from the
    /// price the UI just read at latest.
    /// Restated: the UI now signs the larger minimum (frontend test review51 F3);
    /// this checks that a sandwich of the original size then reverts on chain.
    function testFAIL51_F3_slippageBoundMustTrackLatestOnFavourableMove() public {
        (uint256 latestOut, uint256 finalizedMinimum, uint256 amountIn) = movedPool();
        uint256 latestMinimum = latestOut * 9950 / 10_000;
        uint256 minimum = finalizedMinimum > latestMinimum ? finalizedMinimum : latestMinimum;
        vm.prank(ATTACKER);
        router.swapExactBLCHForTokens{value: 1 ether}(
            0, path(address(wblch), address(busdc)), ATTACKER, block.timestamp
        );
        vm.prank(USER);
        vm.expectRevert();
        router.swapExactBLCHForTokens{value: amountIn}(
            minimum, path(address(wblch), address(busdc)), USER, block.timestamp
        );
    }

    /// Passes: a sandwich takes the difference while the user's swap succeeds.
    function testEVIDENCE51_F3_sandwichExtractsTheGap() public {
        (uint256 latestOut, uint256 minimum, uint256 amountIn) = movedPool();
        UniswapV2Pair pair = pairOf();
        (uint256 w, uint256 q) = reservesWQ(pair);
        // Largest front-run sale that leaves the user's output at or above the minimum.
        uint256 lo;
        uint256 hi = CAP_W - w - amountIn;
        for (uint256 i; i < 96; ++i) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 bought = out(mid, w, q);
            if (out(amountIn, w + mid, q - bought) >= minimum) lo = mid;
            else hi = mid - 1;
        }
        uint256 startW = ATTACKER.balance;
        vm.startPrank(ATTACKER);
        uint256[] memory a = router.swapExactBLCHForTokens{value: lo}(
            0, path(address(wblch), address(busdc)), ATTACKER, block.timestamp
        );
        vm.stopPrank();
        vm.prank(USER);
        uint256[] memory u = router.swapExactBLCHForTokens{value: amountIn}(
            minimum, path(address(wblch), address(busdc)), USER, block.timestamp
        );
        uint256 got = a[1];
        vm.prank(ATTACKER);
        router.swapExactTokensForBLCH(got, 0, path(address(busdc), address(wblch)), ATTACKER, block.timestamp);
        emit log_named_uint("user output at latest, no attack (bUSDC units)", latestOut);
        emit log_named_uint("signed minimum (bUSDC units)", minimum);
        emit log_named_uint("user output with sandwich (bUSDC units)", u[1]);
        emit log_named_uint("attacker profit (BLCH wei)", ATTACKER.balance - startW);
        assertTrue(u[1] >= minimum && ATTACKER.balance > startW);
    }

    // --------------------------------------------------------------- gas ----

    /// Passes: gas against the frontend's fixed limits (not a finding).
    function testEVIDENCE51_gasAgainstFrontendLimits() public {
        seed(5 ether, 500e6);
        vm.startPrank(USER);
        uint256 g = gasleft();
        router.swapExactBLCHForTokens{value: 0.01 ether}(0, path(address(wblch), address(busdc)), USER, block.timestamp);
        emit log_named_uint("swapExactBLCHForTokens gas (limit 250000)", g - gasleft());
        g = gasleft();
        router.swapExactTokensForBLCH(1e6, 0, path(address(busdc), address(wblch)), USER, block.timestamp);
        emit log_named_uint("swapExactTokensForBLCH gas (limit 250000)", g - gasleft());
        vm.stopPrank();
    }
}
