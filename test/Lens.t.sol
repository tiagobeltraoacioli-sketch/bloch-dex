// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

contract LensTest is TestBase {
    UniswapV2Factory internal factory;
    BDexLens internal lens;
    BDexRouter internal router;
    TestToken internal a;
    TestToken internal b;
    TestToken internal c;

    function setUp() public {
        vm.warp(1_000);
        factory = new UniswapV2Factory(address(this));
        lens = new BDexLens(address(factory));
        router = new BDexRouter(address(factory), address(new TestWrappedNative()));
        a = new TestToken();
        b = new TestToken();
        c = new TestToken();
        seed(a, b, 100 ether, 100 ether);
        seed(a, c, 10_000 ether, 10_000 ether);
        seed(c, b, 10_000 ether, 10_000 ether);
        a.mint(address(this), 1_000 ether);
        a.approve(address(router), type(uint256).max);
    }

    function seed(TestToken t0, TestToken t1, uint256 n0, uint256 n1) internal {
        address pair = factory.createPair(address(t0), address(t1));
        t0.mint(pair, n0);
        t1.mint(pair, n1);
        UniswapV2Pair(pair).mint(address(this));
    }

    function path2(address x, address y) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = x;
        path[1] = y;
    }

    function testPaginationHasBoundedWorkAndSafeEndCursor() public {
        (BDexLens.PoolSnapshot[] memory page, uint256 next, uint256 total) = lens.pools(0, 2);
        assertEq(page.length, 2);
        assertEq(next, 2);
        assertEq(total, 3);
        assertEq(page[0].pair, factory.getPair(address(a), address(b)));
        (page, next, total) = lens.pools(next, 2);
        assertEq(page.length, 1);
        assertEq(next, total);
        (page, next, total) = lens.pools(type(uint256).max, 1);
        assertEq(page.length, 0);
        assertEq(next, total);
        vm.expectRevert(bytes("LENS: PAGE_LIMIT"));
        lens.pools(0, 65);
    }

    function testBestRouteQuoteMatchesActualMultiHopExecution() public {
        address[][] memory routes = new address[][](2);
        routes[0] = path2(address(a), address(b));
        routes[1] = new address[](3);
        routes[1][0] = address(a);
        routes[1][1] = address(c);
        routes[1][2] = address(b);
        (uint256 best, BDexLens.RouteQuote[] memory quotes) = lens.bestExactInput(10 ether, routes, 50);
        assertEq(best, 1);
        assertTrue(quotes[1].available && quotes[1].amountOut > quotes[0].amountOut);
        assertEq(quotes[1].minimumOut, quotes[1].amountOut * 9950 / 10_000);
        uint256 before = b.balanceOf(address(this));
        router.swapExactTokensForTokens(10 ether, quotes[1].minimumOut, routes[1], address(this), block.timestamp);
        assertEq(b.balanceOf(address(this)) - before, quotes[1].amountOut);
    }

    function testUnavailableRouteHasExplicitStatusAndNoBestIndex() public {
        TestToken other = new TestToken();
        address[][] memory routes = new address[][](1);
        routes[0] = path2(address(a), address(other));
        (uint256 best, BDexLens.RouteQuote[] memory quotes) = lens.bestExactInput(1 ether, routes, 50);
        assertEq(best, type(uint256).max);
        assertTrue(!quotes[0].available);
        factory.createPair(address(a), address(other));
        BDexLens.RouteQuote memory empty = lens.quoteExactInput(1 ether, routes[0], 50);
        assertTrue(!empty.available);
    }

    function testDustMinimumIsUnavailableAcrossQuoteAndRanking() public view {
        address[] memory route = path2(address(a), address(b));
        BDexLens.RouteQuote memory quote = lens.quoteExactInput(2, route, 50);
        assertEq(quote.amountOut, 1);
        assertEq(quote.minimumOut, 0);
        assertTrue(!quote.available);

        address[][] memory routes = new address[][](1);
        routes[0] = route;
        (uint256 best, BDexLens.RouteQuote[] memory quotes) = lens.bestExactInput(2, routes, 50);
        assertEq(best, type(uint256).max);
        assertTrue(!quotes[0].available);
    }

    function testCyclicRoutesAndMismatchedEndpointsAreRefused() public {
        address[] memory cycle = new address[](3);
        cycle[0] = address(a);
        cycle[1] = address(b);
        cycle[2] = address(a);
        vm.expectRevert(bytes("LENS: CYCLIC_PATH"));
        lens.quoteExactInput(1 ether, cycle, 50);
        address[] memory identical = path2(address(a), address(a));
        vm.expectRevert(bytes("LENS: CYCLIC_PATH"));
        lens.quoteExactInput(1 ether, identical, 50);
        address[][] memory routes = new address[][](2);
        routes[0] = path2(address(a), address(b));
        routes[1] = path2(address(a), address(c));
        vm.expectRevert(bytes("LENS: ENDPOINTS"));
        lens.bestExactInput(1 ether, routes, 50);
        vm.expectRevert(bytes("LENS: SLIPPAGE_RANGE"));
        lens.quoteExactInput(1 ether, routes[0], 10_001);
    }

    function testDistinctPoolCycleQuoteMatchesExecution() public {
        address[] memory path = new address[](4);
        path[0] = address(a);
        path[1] = address(c);
        path[2] = address(b);
        path[3] = address(a);

        BDexLens.RouteQuote memory quote = lens.quoteExactInput(10 ether, path, 50);
        assertTrue(quote.available);
        uint256 before = a.balanceOf(address(this));
        router.swapExactTokensForTokens(10 ether, quote.minimumOut, path, address(this), block.timestamp);
        assertEq(a.balanceOf(address(this)), before - 10 ether + quote.amountOut);
    }

    function testFuzzQuoteParityAndSlippageFloor(uint96 inputSeed, uint16 slippageSeed) public view {
        uint256 input = uint256(inputSeed) % 10 ether + 1_000;
        uint256 slippage = uint256(slippageSeed) % 10_001;
        address[] memory path = path2(address(a), address(b));
        BDexLens.RouteQuote memory quote = lens.quoteExactInput(input, path, slippage);
        uint256[] memory expected = router.getAmountsOut(input, path);
        assertEq(quote.amountOut, expected[1]);
        assertEq(quote.minimumOut, expected[1] * (10_000 - slippage) / 10_000);
        assertTrue(quote.available == (quote.minimumOut > 0));
        assertTrue(quote.executionLossBps[0] <= 10_000);

        path = new address[](3);
        path[0] = address(a);
        path[1] = address(c);
        path[2] = address(b);
        quote = lens.quoteExactInput(input, path, slippage);
        expected = router.getAmountsOut(input, path);
        assertEq(quote.amountOut, expected[2]);
        assertEq(quote.minimumOut, expected[2] * (10_000 - slippage) / 10_000);
        assertTrue(quote.available == (quote.minimumOut > 0));
        assertTrue(quote.executionLossBps[0] <= 10_000);
        assertTrue(quote.executionLossBps[1] <= 10_000);
    }

    function testPositionIncludesPendingProtocolFeeDilution() public {
        factory.setFeeTo(address(0xFEE));
        TestToken x = new TestToken();
        TestToken y = new TestToken();
        seed(x, y, 1_000 ether, 1_000 ether);
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(x), address(y)));
        TestToken(pair.token0()).mint(address(pair), 100 ether);
        pair.swap(0, BDexLibrary.getAmountOut(100 ether, 1_000 ether, 1_000 ether), address(this), "");
        BDexLens.Position memory pos = lens.position(address(pair), address(this));
        assertTrue(pos.pendingProtocolLiquidity > 0);
        assertEq(pos.dilutedSupply, pair.totalSupply() + pos.pendingProtocolLiquidity);
        BDexLens.Position memory feePosition = lens.position(address(pair), address(0xFEE));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(feePosition.liquidity, 0);
        assertEq(feePosition.pendingProtocolLiquidity, pos.pendingProtocolLiquidity);
        assertEq(feePosition.reserveShare0, feePosition.pendingProtocolLiquidity * reserve0 / feePosition.dilutedSupply);
        assertEq(feePosition.reserveShare1, feePosition.pendingProtocolLiquidity * reserve1 / feePosition.dilutedSupply);
        uint256 shares = pair.balanceOf(address(this));
        pair.transfer(address(pair), shares);
        (uint256 amount0, uint256 amount1) = pair.burn(address(this));
        assertEq(amount0, pos.reserveShare0);
        assertEq(amount1, pos.reserveShare1);
        assertEq(pair.balanceOf(address(0xFEE)), pos.pendingProtocolLiquidity);
    }

    function testQuoteRejectsReserveOverflowButAllowsExactCapacity() public {
        address[] memory path = path2(address(a), address(b));
        uint256 capacity = uint256(type(uint112).max) - 100 ether;
        a.mint(address(this), capacity + 1);
        BDexLens.RouteQuote memory tooLarge = lens.quoteExactInput(capacity + 1, path, 50);
        assertTrue(!tooLarge.available);
        vm.expectRevert(bytes("BDEX: OVERFLOW"));
        router.swapExactTokensForTokens(capacity + 1, 0, path, address(this), block.timestamp);

        BDexLens.RouteQuote memory fits = lens.quoteExactInput(capacity, path, 50);
        assertTrue(fits.available);
        uint256 before = b.balanceOf(address(this));
        router.swapExactTokensForTokens(capacity, fits.minimumOut, path, address(this), block.timestamp);
        assertEq(b.balanceOf(address(this)) - before, fits.amountOut);
        assertEq(a.balanceOf(factory.getPair(address(a), address(b))), type(uint112).max);
    }
}
