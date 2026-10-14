// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";

/// Reserve caps are fixed in the factory constructor and copied into each pair:
/// no setter, no signed approval, no renewal.
contract ReserveCapTest is TestBase {
    uint256 internal constant NATIVE_CAP = 10 ether;
    uint256 internal constant TOKEN_CAP = 10_000 ether;

    UniswapV2Factory internal factory;
    BDexRouter internal router;
    TestToken internal token;
    TestToken internal other;
    TestWrappedNative internal wrapped;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000);
        vm.deal(address(this), 1_000 ether);
        token = new TestToken();
        other = new TestToken();
        wrapped = new TestWrappedNative();
        address[] memory capTokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (capTokens[0], caps[0]) = (address(wrapped), NATIVE_CAP);
        (capTokens[1], caps[1]) = (address(token), TOKEN_CAP);
        factory = new UniswapV2Factory(address(0), capTokens, caps);
        router = new BDexRouter(address(factory), address(wrapped));
        token.mint(address(this), 1_000_000 ether);
        other.mint(address(this), 1_000_000 ether);
        token.approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
    }

    function seed(uint256 native, uint256 tokens) internal returns (UniswapV2Pair pair) {
        router.addLiquidityBLCH{value: native}(address(token), tokens, tokens, native, address(this), block.timestamp);
        pair = UniswapV2Pair(factory.getPair(address(token), address(wrapped)));
    }

    function nativeFirst(UniswapV2Pair pair) internal view returns (bool) {
        return pair.token0() == address(wrapped);
    }

    function testFactoryRecordsCapsAndPairCopiesThem() public {
        assertEq(factory.reserveCap(address(wrapped)), NATIVE_CAP);
        assertEq(factory.reserveCap(address(token)), TOKEN_CAP);
        assertEq(factory.reserveCap(address(other)), 0);
        UniswapV2Pair pair = seed(1 ether, 1_000 ether);
        (uint112 cap0, uint112 cap1) = pair.reserveCaps();
        (uint256 nativeCap, uint256 tokenCap) = nativeFirst(pair) ? (cap0, cap1) : (cap1, cap0);
        assertEq(nativeCap, NATIVE_CAP);
        assertEq(tokenCap, TOKEN_CAP);
    }

    function testLiquidityUpToCapIsAcceptedAndAboveIsRefused() public {
        seed(NATIVE_CAP, 1_000 ether);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        router.addLiquidityBLCH{value: 0.1 ether}(address(token), 100 ether, 0, 0, address(this), block.timestamp);
    }

    function testFirstDepositAboveCapIsRefused() public {
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        router.addLiquidityBLCH{value: NATIVE_CAP + 1}(
            address(token), 1_000 ether, 0, 0, address(this), block.timestamp
        );
    }

    function testSwapThatGrowsCappedReserveAboveCapIsRefused() public {
        seed(9 ether, 9_000 ether);
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(wrapped), address(token));
        router.swapExactBLCHForTokens{value: 1 ether}(0, path, address(this), block.timestamp);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        router.swapExactBLCHForTokens{value: 0.01 ether}(0, path, address(this), block.timestamp);

        // The opposite direction shrinks the capped reserve and stays open.
        (path[0], path[1]) = (address(token), address(wrapped));
        uint256[] memory amounts = router.swapExactTokensForBLCH(100 ether, 0, path, address(this), block.timestamp);
        assertTrue(amounts[1] > 0);
    }

    function testDonationAboveCapCannotLockLiquidityProviders() public {
        UniswapV2Pair pair = seed(NATIVE_CAP, 1_000 ether);
        wrapped.deposit{value: 5 ether}();
        wrapped.transfer(address(pair), 5 ether);

        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        pair.sync();

        // Burning still works with the donation in place; skim returns the excess.
        uint256 liquidity = pair.balanceOf(address(this)) / 2;
        pair.transfer(address(pair), liquidity);
        (uint256 amount0, uint256 amount1) = pair.burn(address(this));
        assertTrue(amount0 > 0 && amount1 > 0);
        pair.skim(address(0xD0));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(wrapped.balanceOf(address(pair)), nativeFirst(pair) ? reserve0 : reserve1);
    }

    function testUncappedTokensAreUnaffected() public {
        router.addLiquidity(
            address(other), address(token), 500_000 ether, 1_000 ether, 0, 0, address(this), block.timestamp
        );
        router.addLiquidity(
            address(other), address(token), 400_000 ether, 800 ether, 0, 0, address(this), block.timestamp
        );
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(other), address(token)));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 otherReserve = pair.token0() == address(other) ? reserve0 : reserve1;
        assertEq(otherReserve, 900_000 ether);
    }

    function testConstructorRefusesInvalidCaps() public {
        address[] memory one = new address[](1);
        uint256[] memory none = new uint256[](0);
        one[0] = address(token);
        vm.expectRevert(bytes("BDEX: CAP_LENGTH"));
        new UniswapV2Factory(address(0), one, none);

        uint256[] memory amount = new uint256[](1);
        vm.expectRevert(bytes("BDEX: CAP_RANGE"));
        new UniswapV2Factory(address(0), one, amount);
        amount[0] = uint256(type(uint112).max) + 1;
        vm.expectRevert(bytes("BDEX: CAP_RANGE"));
        new UniswapV2Factory(address(0), one, amount);

        one[0] = address(0);
        amount[0] = 1;
        vm.expectRevert(bytes("BDEX: ZERO_ADDRESS"));
        new UniswapV2Factory(address(0), one, amount);

        address[] memory twice = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        (twice[0], twice[1], amounts[0], amounts[1]) = (address(token), address(token), 1, 2);
        vm.expectRevert(bytes("BDEX: CAP_DUPLICATE"));
        new UniswapV2Factory(address(0), twice, amounts);
    }

    function testCapsHaveNoSetter() public {
        UniswapV2Pair pair = seed(1 ether, 1_000 ether);
        (bool ok,) = address(factory).call(abi.encodeWithSignature("setFeeTo(address)", address(0xFEE)));
        assertTrue(!ok);
        (ok,) = address(factory).call(abi.encodeWithSignature("setFeeToSetter(address)", address(0xB0B)));
        assertTrue(!ok);
        assertEq(factory.feeTo(), address(0));
        assertEq(factory.reserveCap(address(wrapped)), NATIVE_CAP);
        (uint112 cap0, uint112 cap1) = pair.reserveCaps();
        assertEq(nativeFirst(pair) ? cap0 : cap1, NATIVE_CAP);
    }

    /// Regression: the lens must not report (or rank first) a route the pair
    /// will refuse with RESERVE_CAP. Exactly reaching the cap stays available.
    function testLensQuoteRespectsReserveCaps() public {
        BDexLens lens = new BDexLens(address(factory));
        seed(1 ether, 1_000 ether);
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(token), address(wrapped));
        uint256 room = TOKEN_CAP - 1_000 ether;

        BDexLens.RouteQuote memory over = lens.quoteExactInput(room + 1, path, 50);
        assertTrue(!over.available);
        address[][] memory routes = new address[][](1);
        routes[0] = path;
        (uint256 best,) = lens.bestExactInput(room + 1, routes, 50);
        assertEq(best, type(uint256).max);
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        router.swapExactTokensForTokens(room + 1, 0, path, address(this), block.timestamp);

        BDexLens.RouteQuote memory exact = lens.quoteExactInput(room, path, 50);
        assertTrue(exact.available);
        uint256 before = wrapped.balanceOf(address(this));
        router.swapExactTokensForTokens(room, exact.minimumOut, path, address(this), block.timestamp);
        assertEq(wrapped.balanceOf(address(this)) - before, exact.amountOut);
    }
}
