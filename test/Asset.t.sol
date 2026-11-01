// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestWrappedNative} from "./TestBase.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

contract AssetTest is TestBase {
    BlochAsset asset;
    address constant HOLDER = address(0xA11CE);
    address constant SPENDER = address(0xB0B);
    uint256 constant SUPPLY = 1_000_000 * 1e6;

    function setUp() public {
        asset = new BlochAsset("Example asset", "EXAMPLE", 6, SUPPLY, HOLDER);
    }

    function testIssuanceGoesOnlyToRecipient() public view {
        assertEq(asset.totalSupply(), SUPPLY);
        assertEq(asset.balanceOf(HOLDER), SUPPLY);
        assertEq(asset.balanceOf(address(this)), 0);
        assertEq(asset.decimals(), 6);
    }

    function testRejectInvalidIssuance() public {
        vm.expectRevert(bytes("ASSET: NAME"));
        new BlochAsset("", "A", 18, 1, HOLDER);
        vm.expectRevert(bytes("ASSET: NAME"));
        new BlochAsset(string(new bytes(65)), "A", 18, 1, HOLDER);
        vm.expectRevert(bytes("ASSET: SYMBOL"));
        new BlochAsset("Asset", "", 18, 1, HOLDER);
        vm.expectRevert(bytes("ASSET: SYMBOL"));
        new BlochAsset("Asset", "TOO_LONG_SYMBOL", 18, 1, HOLDER);
        vm.expectRevert(bytes("ASSET: DECIMALS"));
        new BlochAsset("Asset", "A", 19, 1, HOLDER);
        vm.expectRevert(bytes("ASSET: SUPPLY"));
        new BlochAsset("Asset", "A", 18, 0, HOLDER);
        vm.expectRevert(bytes("ASSET: RECIPIENT"));
        new BlochAsset("Asset", "A", 18, 1, address(0));
    }

    function testFuzzConservationAndSelfTransfer(uint256 seed) public {
        uint256 amount = seed % (SUPPLY + 1);
        vm.startPrank(HOLDER);
        asset.transfer(HOLDER, amount);
        assertEq(asset.balanceOf(HOLDER), SUPPLY);
        asset.transfer(SPENDER, amount);
        vm.stopPrank();
        assertEq(asset.balanceOf(HOLDER) + asset.balanceOf(SPENDER), SUPPLY);
        assertEq(asset.balanceOf(SPENDER), amount);
        assertEq(asset.totalSupply(), SUPPLY);
    }

    function testUnauthorizedTransferAndRevocation() public {
        vm.expectRevert(bytes("ASSET: ALLOWANCE"));
        asset.transferFrom(HOLDER, SPENDER, 1);
        vm.startPrank(HOLDER);
        asset.approve(SPENDER, 10);
        asset.approve(SPENDER, 0);
        vm.stopPrank();
        vm.prank(SPENDER);
        vm.expectRevert(bytes("ASSET: ALLOWANCE"));
        asset.transferFrom(HOLDER, SPENDER, 1);
        assertEq(asset.balanceOf(HOLDER), SUPPLY);
    }

    function testFiniteAndInfiniteAllowance() public {
        vm.prank(HOLDER);
        asset.approve(SPENDER, 10);
        vm.prank(SPENDER);
        asset.transferFrom(HOLDER, SPENDER, 4);
        assertEq(asset.allowance(HOLDER, SPENDER), 6);
        vm.prank(HOLDER);
        asset.approve(SPENDER, type(uint256).max);
        vm.prank(SPENDER);
        asset.transferFrom(HOLDER, SPENDER, 4);
        assertEq(asset.allowance(HOLDER, SPENDER), type(uint256).max);
    }

    function testRevertedTransferRestoresAllowance() public {
        vm.prank(HOLDER);
        asset.approve(SPENDER, SUPPLY + 1);
        vm.prank(SPENDER);
        vm.expectRevert(bytes("ASSET: BALANCE"));
        asset.transferFrom(HOLDER, SPENDER, SUPPLY + 1);
        assertEq(asset.allowance(HOLDER, SPENDER), SUPPLY + 1);
        assertEq(asset.balanceOf(HOLDER), SUPPLY);
    }

    function testRejectTokenAndZeroRecipients() public {
        vm.startPrank(HOLDER);
        vm.expectRevert(bytes("ASSET: RECIPIENT"));
        asset.transfer(address(0), 1);
        vm.expectRevert(bytes("ASSET: RECIPIENT"));
        asset.transfer(address(asset), 1);
        vm.expectRevert(bytes("ASSET: SPENDER"));
        asset.approve(address(0), 1);
        vm.stopPrank();
    }

    function testNoMintEntryPoint() public {
        (bool ok,) = address(asset).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        assertTrue(!ok);
        assertEq(asset.totalSupply(), SUPPLY);
    }

    function testAssetLiquiditySwapAndRedemption() public {
        UniswapV2Factory factory = new UniswapV2Factory(address(0), address(0), new address[](0), new uint256[](0));
        TestWrappedNative wrapped = new TestWrappedNative();
        BDexRouter router = new BDexRouter(address(factory), address(wrapped));
        vm.deal(HOLDER, 10 ether);
        vm.startPrank(HOLDER);
        asset.approve(address(router), SUPPLY);
        (,, uint256 liquidity) = router.addLiquidityBLCH{value: 5 ether}(
            address(asset), SUPPLY / 2, SUPPLY / 2, 5 ether, HOLDER, block.timestamp
        );
        address[] memory path = new address[](2);
        path[0] = address(asset);
        path[1] = address(wrapped);
        uint256[] memory quote = router.getAmountsOut(1e6, path);
        router.swapExactTokensForTokens(1e6, quote[1], path, HOLDER, block.timestamp);
        assertEq(wrapped.balanceOf(HOLDER), quote[1]);
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(asset), address(wrapped)));
        pair.approve(address(router), liquidity);
        router.removeLiquidity(address(asset), address(wrapped), liquidity, 1, 1, HOLDER, block.timestamp);
        vm.stopPrank();
        assertEq(pair.balanceOf(HOLDER), 0);
        assertEq(asset.balanceOf(HOLDER) + asset.balanceOf(address(pair)), SUPPLY);
        assertEq(asset.totalSupply(), SUPPLY);
        assertEq(factory.feeTo(), address(0));
    }
}
