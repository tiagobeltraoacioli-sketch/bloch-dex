// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

contract RouterSurfaceTest is TestBase {
    UniswapV2Factory private factory;
    BDexRouter private router;
    TestToken private tokenA;
    TestToken private tokenB;
    TestWrappedNative private wrapped;

    receive() external payable {}

    function setUp() public {
        vm.deal(address(this), 1_000 ether);
        factory = new UniswapV2Factory(address(this));
        tokenA = new TestToken();
        tokenB = new TestToken();
        wrapped = new TestWrappedNative();
        router = new BDexRouter(address(factory), address(wrapped));
        tokenA.mint(address(this), 100_000 ether);
        tokenB.mint(address(this), 100_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);

        router.addLiquidity(
            address(tokenA),
            address(tokenB),
            1_000 ether,
            2_000 ether,
            1_000 ether,
            2_000 ether,
            address(this),
            block.timestamp
        );
        router.addLiquidityBLCH{value: 100 ether}(
            address(tokenA), 1_000 ether, 1_000 ether, 100 ether, address(this), block.timestamp
        );
        router.addLiquidityBLCH{value: 100 ether}(
            address(tokenB), 2_000 ether, 2_000 ether, 100 ether, address(this), block.timestamp
        );
    }

    function testExactOutputNativeInputRefundsOnlyUnusedValue() public {
        address[] memory path = _path(address(wrapped), address(tokenA));
        uint256 amountOut = 5 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = tokenA.balanceOf(address(this));

        uint256[] memory amounts =
            router.swapBLCHForExactTokens{value: quote[0] + 7 ether}(amountOut, path, address(this), block.timestamp);

        assertEq(amounts[0], quote[0]);
        assertEq(amounts[1], amountOut);
        assertEq(nativeBefore - address(this).balance, quote[0]);
        assertEq(tokenA.balanceOf(address(this)) - tokenBefore, amountOut);
        assertEq(address(router).balance, 0);
        assertEq(wrapped.balanceOf(address(router)), 0);
    }

    function testExactOutputNativeReturnSpendsOnlyQuotedTokens() public {
        address[] memory path = _path(address(tokenA), address(wrapped));
        uint256 amountOut = 1 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = tokenA.balanceOf(address(this));

        uint256[] memory amounts =
            router.swapTokensForExactBLCH(amountOut, quote[0], path, address(this), block.timestamp);

        assertEq(amounts[0], quote[0]);
        assertEq(amounts[1], amountOut);
        assertEq(tokenBefore - tokenA.balanceOf(address(this)), quote[0]);
        assertEq(address(this).balance - nativeBefore, amountOut);
        assertEq(address(router).balance, 0);
        assertEq(wrapped.balanceOf(address(router)), 0);
    }

    function testExactInputNativeReturnMatchesForwardQuote() public {
        address[] memory path = _path(address(tokenA), address(wrapped));
        uint256 amountIn = 10 ether;
        uint256[] memory quote = router.getAmountsOut(amountIn, path);
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = tokenA.balanceOf(address(this));

        uint256[] memory amounts =
            router.swapExactTokensForBLCH(amountIn, quote[1], path, address(this), block.timestamp);

        assertEq(amounts[0], amountIn);
        assertEq(amounts[1], quote[1]);
        assertEq(tokenBefore - tokenA.balanceOf(address(this)), amountIn);
        assertEq(address(this).balance - nativeBefore, quote[1]);
        assertEq(address(router).balance, 0);
        assertEq(wrapped.balanceOf(address(router)), 0);
    }

    function testExactOutputTokenPathMatchesBackwardQuote() public {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountOut = 5 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        uint256 inputBefore = tokenA.balanceOf(address(this));
        uint256 outputBefore = tokenB.balanceOf(address(this));

        uint256[] memory amounts =
            router.swapTokensForExactTokens(amountOut, quote[0], path, address(this), block.timestamp);

        assertEq(amounts[0], quote[0]);
        assertEq(amounts[1], amountOut);
        assertEq(inputBefore - tokenA.balanceOf(address(this)), quote[0]);
        assertEq(tokenB.balanceOf(address(this)) - outputBefore, amountOut);
        assertEq(tokenA.balanceOf(address(router)), 0);
        assertEq(tokenB.balanceOf(address(router)), 0);
    }

    function testExactOutputMultiHopMatchesBackwardQuote() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(wrapped);
        uint256 amountOut = 1 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        uint256 tokenBefore = tokenA.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        uint256[] memory amounts =
            router.swapTokensForExactBLCH(amountOut, quote[0], path, address(this), block.timestamp);

        assertEq(amounts[0], quote[0]);
        assertEq(amounts[1], quote[1]);
        assertEq(amounts[2], amountOut);
        assertEq(tokenBefore - tokenA.balanceOf(address(this)), quote[0]);
        assertEq(address(this).balance - nativeBefore, amountOut);
    }

    function testFeeOnTransferTokenPathUsesActualInputAndRecipientOutput() public {
        tokenA.setTax(1_000);
        tokenB.setTax(500);
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 recipientBefore = tokenB.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: K"));
        router.swapExactTokensForTokens(10 ether, 1, path, address(this), block.timestamp);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(10 ether, 1, path, address(this), block.timestamp);

        assertTrue(tokenB.balanceOf(address(this)) > recipientBefore);
        assertEq(tokenA.balanceOf(address(router)), 0);
        assertEq(tokenB.balanceOf(address(router)), 0);
    }

    function testFeeOnTransferNativePathChecksNetRecipientAmount() public {
        tokenB.setTax(500);
        address[] memory path = _path(address(wrapped), address(tokenB));
        uint256 recipientBefore = tokenB.balanceOf(address(this));

        router.swapExactBLCHForTokensSupportingFeeOnTransferTokens{value: 1 ether}(
            1, path, address(this), block.timestamp
        );

        assertTrue(tokenB.balanceOf(address(this)) > recipientBefore);
        assertEq(address(router).balance, 0);
        assertEq(wrapped.balanceOf(address(router)), 0);
        assertEq(tokenB.balanceOf(address(router)), 0);
    }

    function _path(address a, address b) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }
}
