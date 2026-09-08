// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexFixture} from "./SecurityRegression.t.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {TestToken} from "./TestBase.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

contract TreasuryTest is DexFixture {
    function testTwapConversionPaysFixedTreasuryAfterMatureWindow() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        pair.transfer(address(collector), liquidity / 1_000);
        collector.checkpoint(address(pair));
        vm.warp(block.timestamp + 1_800);
        uint256 before = wrapped.balanceOf(RECIPIENT);
        collector.convertViaTwap(address(pair), liquidity / 1_000);
        assertTrue(wrapped.balanceOf(RECIPIENT) > before);
        assertEq(token.balanceOf(address(collector)), 0);
        assertEq(wrapped.balanceOf(address(collector)), 0);
    }

    function testManipulatedSpotCannotPassMatureTwapFloor() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        pair.transfer(address(collector), liquidity / 1_000);
        collector.checkpoint(address(pair));
        vm.warp(block.timestamp + 1_800);
        (uint256 inputReserve, uint256 outputReserve) =
            BDexLibrary.getReserves(address(factory), address(token), address(wrapped));
        token.transfer(address(pair), 10 ether);
        uint256 output = BDexLibrary.getAmountOut(10 ether, inputReserve, outputReserve);
        bool wIs0 = pair.token0() == address(wrapped);
        pair.swap(wIs0 ? output : 0, wIs0 ? 0 : output, address(this), "");
        uint256 shares = pair.balanceOf(address(collector));
        vm.expectRevert(bytes("TFC: TWAP_SLIPPAGE"));
        collector.convertViaTwap(address(pair), shares);
        assertEq(pair.balanceOf(address(collector)), shares);
    }

    function testCheckpointCannotBeBorrowedOrUsedOutsideWindow() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        pair.transfer(address(collector), liquidity / 1_000);
        collector.checkpoint(address(pair));
        vm.expectRevert(bytes("TFC: WINDOW_TOO_SHORT"));
        collector.convertViaTwap(address(pair), liquidity / 1_000);
        vm.warp(block.timestamp + 1_800);
        vm.prank(address(0xCAFE));
        vm.expectRevert(bytes("TFC: NO_CHECKPOINT"));
        collector.convertViaTwap(address(pair), liquidity / 1_000);
        vm.warp(block.timestamp + 21_601);
        vm.expectRevert(bytes("TFC: WINDOW_TOO_LONG"));
        collector.convertViaTwap(address(pair), liquidity / 1_000);
    }

    function testTwapSurvivesUint32TimestampRollover() public {
        vm.warp(uint256(type(uint32).max) - 1_000);
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        pair.transfer(address(collector), liquidity / 1_000);
        collector.checkpoint(address(pair));
        vm.warp(block.timestamp + 1_800);
        collector.convertViaTwap(address(pair), liquidity / 1_000);
        assertTrue(wrapped.balanceOf(RECIPIENT) > 0);
    }

    function testTaxedConversionCannotConsumeDonatedBalances() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        uint256 shares = liquidity / 1_000;
        pair.transfer(address(collector), shares);
        token.transfer(address(collector), 1 ether);
        collector.checkpoint(address(pair));
        vm.warp(block.timestamp + 1_800);
        token.setTax(500);
        vm.expectRevert(bytes("TFC: NONSTANDARD_REDEMPTION"));
        collector.convertViaTwap(address(pair), shares);
        assertEq(token.balanceOf(address(collector)), 1 ether);
        assertEq(pair.balanceOf(address(collector)), shares);
        collector.sweep(address(pair));
        assertTrue(token.balanceOf(RECIPIENT) > 0);
        assertEq(token.balanceOf(address(collector)), 1 ether);
    }

    function testTaxedRemovalPaysNetAndLeavesUnrelatedDonations() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        token.transfer(address(router), 1 ether);
        token.setTax(2_000);
        uint256 shares = liquidity / 10;
        uint256 grossToken = shares * token.balanceOf(address(pair)) / pair.totalSupply();
        uint256 afterFirstTax = grossToken - grossToken * 2_000 / 10_000;
        uint256 net = afterFirstTax - afterFirstTax * 2_000 / 10_000;
        router.removeLiquidityBLCHSupportingFeeOnTransferTokens(
            address(token), shares, net, 0, RECIPIENT, block.timestamp
        );
        assertEq(token.balanceOf(RECIPIENT), net);
        assertEq(token.balanceOf(address(router)), 1 ether);
        assertTrue(RECIPIENT.balance > 0);
    }
}
