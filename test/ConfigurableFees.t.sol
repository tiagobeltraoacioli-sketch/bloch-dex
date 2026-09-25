// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

contract ConfigurableFeesTest is TestBase {
    UniswapV2Factory factory;
    BDexRouter router;
    BDexLens lens;
    TestToken a;
    TestToken b;
    UniswapV2Pair pair;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public {
        factory = new UniswapV2Factory(address(this));
        a = new TestToken();
        b = new TestToken();
        router = new BDexRouter(address(factory), address(new TestWrappedNative()));
        lens = new BDexLens(address(factory));
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        a.mint(address(pair), 1000 ether);
        b.mint(address(pair), 1000 ether);
        pair.mint(address(this));
        a.mint(ALICE, 100 ether);
        a.mint(BOB, 100 ether);
        vm.prank(ALICE);
        a.approve(address(router), type(uint256).max);
        vm.prank(BOB);
        a.approve(address(router), type(uint256).max);
    }

    function path() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(a);
        p[1] = address(b);
    }

    function testOnlyAuthorityMayConfigureCanonicalPoolsAndBoundedRates() public {
        assertEq(factory.poolFeeBps(address(pair)), 30);
        vm.prank(ALICE);
        vm.expectRevert(bytes("BDEX: FORBIDDEN"));
        factory.setPoolFee(address(pair), 5);
        vm.expectRevert(bytes("BDEX: UNKNOWN_PAIR"));
        factory.setPoolFee(BOB, 5);
        vm.expectRevert(bytes("BDEX: FEE_LIMIT"));
        factory.setPoolFee(address(pair), 1001);
        vm.expectRevert(bytes("BDEX: REBATE_LIMIT"));
        factory.setAddressRebate(address(pair), ALICE, 10001);
        vm.expectRevert(bytes("BDEX: ZERO_ADDRESS"));
        factory.setAddressRebate(address(pair), address(0), 100);
        vm.prank(ALICE);
        vm.expectRevert(bytes("BDEX: FORBIDDEN"));
        factory.setAddressRebate(address(pair), ALICE, 10000);
        vm.prank(ALICE);
        vm.expectRevert(bytes("BDEX: FORBIDDEN"));
        factory.setFeeRouter(address(router), true);
    }

    function testRebateFollowsPayerAndDoesNotFollowRecipient() public {
        factory.setPoolFee(address(pair), 100);
        factory.setAddressRebate(address(pair), ALICE, 5000);
        factory.setFeeRouter(address(router), true);
        vm.prank(ALICE);
        uint256[] memory discounted = router.getAmountsOut(10 ether, path());
        vm.prank(BOB);
        uint256[] memory ordinary = router.getAmountsOut(10 ether, path());
        assertTrue(discounted[1] > ordinary[1]);
        assertEq(lens.quoteExactInputFor(10 ether, path(), 0, ALICE, address(router)).amountOut, discounted[1]);
        assertEq(lens.quoteExactInput(10 ether, path(), 0).amountOut, ordinary[1]);
        vm.prank(BOB);
        router.swapExactTokensForTokens(10 ether, ordinary[1], path(), ALICE, block.timestamp);
        assertEq(b.balanceOf(ALICE), ordinary[1]);
        vm.prank(ALICE);
        uint256[] memory current = router.getAmountsOut(10 ether, path());
        vm.prank(ALICE);
        router.swapExactTokensForTokens(10 ether, current[1], path(), BOB, block.timestamp);
        assertEq(b.balanceOf(BOB), current[1]);
        assertEq(factory.swapFeeBps(address(pair), ALICE, address(router)), 50);
    }

    function testUntrustedExecutorCannotBorrowAnotherAddressRebate() public {
        factory.setAddressRebate(address(pair), ALICE, 10000);
        assertEq(factory.swapFeeBps(address(pair), ALICE, BOB), 30);
        vm.prank(BOB);
        vm.expectRevert(bytes("BDEX: UNTRUSTED_ROUTER"));
        pair.swapFor(1, 0, BOB, ALICE);
        vm.prank(ALICE);
        uint256[] memory quote = router.getAmountsOut(1 ether, path());
        assertEq(quote[1], BDexLibrary.getAmountOut(1 ether, 1000 ether, 1000 ether));
        factory.setFeeRouter(address(router), true);
        assertEq(factory.swapFeeBps(address(pair), ALICE, address(router)), 0);
        factory.setFeeRouter(address(router), false);
        assertEq(factory.swapFeeBps(address(pair), ALICE, address(router)), 30);
    }

    function testUnapprovedRouterAddressRebateHasExactQuoteParity() public {
        factory.setPoolFee(address(pair), 100);
        factory.setAddressRebate(address(pair), address(router), 5000);
        vm.prank(ALICE);
        uint256[] memory quote = router.getAmountsOut(10 ether, path());
        assertEq(quote[1], BDexLibrary.getAmountOutWithFee(10 ether, 1000 ether, 1000 ether, 50));
        assertEq(lens.quoteExactInputFor(10 ether, path(), 0, ALICE, address(router)).amountOut, quote[1]);
        vm.prank(ALICE);
        router.swapExactTokensForTokens(10 ether, quote[1], path(), ALICE, block.timestamp);
        assertEq(b.balanceOf(ALICE), quote[1]);
    }

    function testFeeChangeStillEnforcesSignedOutputBound() public {
        vm.prank(ALICE);
        uint256[] memory quoted = router.getAmountsOut(10 ether, path());
        factory.setPoolFee(address(pair), 1000);
        vm.prank(ALICE);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(10 ether, quoted[1], path(), ALICE, block.timestamp);
        assertEq(a.balanceOf(ALICE), 100 ether);
    }

    function testTaxedInputUsesActualReceivedAmountAndCustomFee() public {
        factory.setPoolFee(address(pair), 60);
        factory.setAddressRebate(address(pair), ALICE, 5000);
        factory.setFeeRouter(address(router), true);
        a.setTax(100);
        uint256 expected = BDexLibrary.getAmountOutWithFee(9.9 ether, 1000 ether, 1000 ether, 30);
        vm.prank(ALICE);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(10 ether, expected, path(), ALICE, block.timestamp);
        assertEq(b.balanceOf(ALICE), expected);
    }

    function testFuzzQuoteExecutionParityAndConservation(uint16 rawFee, uint16 rawRebate, uint64 rawInput) public {
        uint16 fee = rawFee % 1001;
        uint16 rebate = rawRebate % 10001;
        uint256 input = uint256(rawInput) % 10 ether + 1e10;
        factory.setPoolFee(address(pair), fee);
        factory.setAddressRebate(address(pair), ALICE, rebate);
        factory.setFeeRouter(address(router), true);
        uint16 effective = fee - uint16(uint256(fee) * rebate / 10000);
        uint256 expected = BDexLibrary.getAmountOutWithFee(input, 1000 ether, 1000 ether, effective);
        vm.prank(ALICE);
        uint256[] memory quote = router.getAmountsOut(input, path());
        assertEq(quote[1], expected);
        vm.prank(ALICE);
        router.swapExactTokensForTokens(input, expected, path(), ALICE, block.timestamp);
        assertEq(b.balanceOf(ALICE), expected);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertTrue(uint256(r0) * r1 >= 1000 ether * 1000 ether);
    }

    function testMultiHopUsesEachPoolFeeAndExactOutputQuote() public {
        TestToken c = new TestToken();
        UniswapV2Pair other = UniswapV2Pair(factory.createPair(address(b), address(c)));
        b.mint(address(other), 1000 ether);
        c.mint(address(other), 1000 ether);
        other.mint(address(this));
        factory.setPoolFee(address(pair), 50);
        factory.setPoolFee(address(other), 100);
        factory.setAddressRebate(address(other), ALICE, 5000);
        factory.setFeeRouter(address(router), true);
        address[] memory p = new address[](3);
        p[0] = address(a);
        p[1] = address(b);
        p[2] = address(c);
        vm.prank(ALICE);
        uint256[] memory quote = router.getAmountsIn(1 ether, p);
        uint256 middle = BDexLibrary.getAmountInWithFee(1 ether, 1000 ether, 1000 ether, 50);
        assertEq(quote[0], BDexLibrary.getAmountInWithFee(middle, 1000 ether, 1000 ether, 50));
        vm.prank(ALICE);
        router.swapTokensForExactTokens(1 ether, quote[0], p, ALICE, block.timestamp);
        assertEq(c.balanceOf(ALICE), 1 ether);
    }
}
