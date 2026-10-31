// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";

abstract contract DexFixture is TestBase {
    UniswapV2Factory internal factory;
    BDexRouter internal router;
    TestToken internal token;
    TestWrappedNative internal wrapped;
    TreasuryFeeCollector internal collector;
    address internal constant RECIPIENT = address(0xBEEF);

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000);
        vm.deal(address(this), 10_000 ether);
        factory = new UniswapV2Factory(address(0), address(0), new address[](0), new uint256[](0));
        token = new TestToken();
        wrapped = new TestWrappedNative();
        router = new BDexRouter(address(factory), address(wrapped));
        collector = new TreasuryFeeCollector(address(factory), RECIPIENT, address(wrapped));
        token.mint(address(this), 10_000 ether);
        token.approve(address(router), type(uint256).max);
    }

    function seed() internal returns (UniswapV2Pair pair, uint256 liquidity) {
        (,, liquidity) = router.addLiquidityBLCH{value: 100 ether}(
            address(token), 100 ether, 100 ether, 100 ether, address(this), block.timestamp
        );
        pair = UniswapV2Pair(factory.getPair(address(token), address(wrapped)));
        pair.approve(address(router), type(uint256).max);
    }
}

contract SecurityRegressionTest is DexFixture {
    function testEmptyPoolCannotStartTwapWindow() public {
        address pair = factory.createPair(address(token), address(wrapped));
        vm.expectRevert(bytes("TFC: NO_LIQUIDITY"));
        collector.checkpoint(pair);
    }

    function testTaxedRemovalEnforcesRecipientMinimum() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        token.setTax(2_000);
        uint256 shares = liquidity / 10;
        uint256 grossToken = shares * token.balanceOf(address(pair)) / pair.totalSupply();
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.removeLiquidityBLCHSupportingFeeOnTransferTokens(
            address(token), shares, grossToken * 95 / 100, 0, RECIPIENT, block.timestamp
        );
    }

    function testFreshPoolEnforcesBothDepositMinimums() public {
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidityBLCH{value: 100 ether}(
            address(token), 100 ether, 101 ether, 99 ether, address(this), block.timestamp
        );
    }

    function testPrecreatedEmptyPairAcceptsFirstLiquidity() public {
        address pair = factory.createPair(address(token), address(wrapped));

        (uint256 amountToken, uint256 amountNative, uint256 liquidity) = router.addLiquidityBLCH{value: 100 ether}(
            address(token), 100 ether, 100 ether, 100 ether, address(this), block.timestamp
        );

        assertEq(factory.getPair(address(token), address(wrapped)), pair);
        assertEq(amountToken, 100 ether);
        assertEq(amountNative, 100 ether);
        assertTrue(liquidity > 0);
    }

    function testPrefundedPairRatioCannotBypassLiquidityMinimums() public {
        address pairAddress = factory.createPair(address(token), address(wrapped));
        token.transfer(pairAddress, 1_000 ether);
        wrapped.mint(pairAddress, 1 ether);
        UniswapV2Pair pair = UniswapV2Pair(pairAddress);
        pair.mint(address(0xBAD));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        vm.expectRevert(bytes("BDEX: INSUFFICIENT_B_AMOUNT"));
        router.addLiquidityBLCH{value: 100 ether}(
            address(token), 100 ether, 90 ether, 90 ether, address(this), block.timestamp
        );

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
        assertEq(token.balanceOf(address(this)), tokenBefore);
        assertEq(address(this).balance, nativeBefore);
    }
}
