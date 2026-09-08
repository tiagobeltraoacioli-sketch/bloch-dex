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
        factory = new UniswapV2Factory(address(this));
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
}
