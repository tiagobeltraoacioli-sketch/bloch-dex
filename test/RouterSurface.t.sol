// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

contract RejectingNativeReceiver {
    function swapForExactTokens(BDexRouter router, address wrapped, address token, uint256 amountOut, uint256 deadline)
        external
        payable
    {
        address[] memory path = new address[](2);
        path[0] = wrapped;
        path[1] = token;
        router.swapBLCHForExactTokens{value: msg.value}(amountOut, path, address(this), deadline);
    }

    receive() external payable {
        revert("reject native");
    }
}

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

    function testRejectedNativeRefundRollsBackSwap() public {
        address[] memory path = _path(address(wrapped), address(tokenA));
        uint256 amountOut = 5 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        RejectingNativeReceiver recipient = new RejectingNativeReceiver();
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(wrapped), address(tokenA)));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();

        vm.expectRevert(bytes("BDEX: NATIVE_TRANSFER_FAILED"));
        recipient.swapForExactTokens{value: quote[0] + 1 ether}(
            router, address(wrapped), address(tokenA), amountOut, block.timestamp
        );

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
        assertEq(tokenA.balanceOf(address(recipient)), 0);
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

    function testRejectedNativeRecipientRollsBackSwap() public {
        address[] memory path = _path(address(tokenA), address(wrapped));
        uint256 amountOut = 1 ether;
        uint256[] memory quote = router.getAmountsIn(amountOut, path);
        RejectingNativeReceiver recipient = new RejectingNativeReceiver();
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(tokenA), address(wrapped)));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();
        uint256 tokenBefore = tokenA.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: NATIVE_TRANSFER_FAILED"));
        router.swapTokensForExactBLCH(amountOut, quote[0], path, address(recipient), block.timestamp);

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
        assertEq(tokenA.balanceOf(address(this)), tokenBefore);
        assertEq(address(recipient).balance, 0);
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

    function testStaleExactInputQuoteRevertsAfterAdverseReserveMutation() public {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountIn = 10 ether;
        uint256[] memory staleQuote = router.getAmountsOut(amountIn, path);

        router.swapExactTokensForTokens(100 ether, 0, path, address(this), block.timestamp);
        uint256[] memory currentQuote = router.getAmountsOut(amountIn, path);
        assertTrue(currentQuote[1] < staleQuote[1]);
        uint256 inputBefore = tokenA.balanceOf(address(this));
        uint256 outputBefore = tokenB.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(amountIn, staleQuote[1], path, address(this), block.timestamp);

        assertEq(tokenA.balanceOf(address(this)), inputBefore);
        assertEq(tokenB.balanceOf(address(this)), outputBefore);
    }

    function testStaleExactOutputQuoteRevertsAfterAdverseReserveMutation() public {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountOut = 5 ether;
        uint256[] memory staleQuote = router.getAmountsIn(amountOut, path);

        router.swapExactTokensForTokens(100 ether, 0, path, address(this), block.timestamp);
        uint256[] memory currentQuote = router.getAmountsIn(amountOut, path);
        assertTrue(currentQuote[0] > staleQuote[0]);
        uint256 inputBefore = tokenA.balanceOf(address(this));
        uint256 outputBefore = tokenB.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: EXCESSIVE_INPUT_AMOUNT"));
        router.swapTokensForExactTokens(amountOut, staleQuote[0], path, address(this), block.timestamp);

        assertEq(tokenA.balanceOf(address(this)), inputBefore);
        assertEq(tokenB.balanceOf(address(this)), outputBefore);
    }

    function testFuzzAdverseReserveMutationCannotConsumeExactInput(uint96 targetSeed, uint96 mutationSeed) public {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountIn = uint256(targetSeed) % 9 ether + 1 ether;
        uint256 mutation = uint256(mutationSeed) % 99 ether + 1 ether;
        uint256[] memory staleQuote = router.getAmountsOut(amountIn, path);
        router.swapExactTokensForTokens(mutation, 0, path, address(this), block.timestamp);
        assertTrue(router.getAmountsOut(amountIn, path)[1] < staleQuote[1]);
        uint256 inputBefore = tokenA.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(amountIn, staleQuote[1], path, address(this), block.timestamp);

        assertEq(tokenA.balanceOf(address(this)), inputBefore);
    }

    function testFuzzAdverseReserveMutationCannotExceedExactOutputMaximum(uint96 outputSeed, uint96 mutationSeed)
        public
    {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountOut = uint256(outputSeed) % 9 ether + 1 ether;
        uint256 mutation = uint256(mutationSeed) % 99 ether + 1 ether;
        uint256[] memory staleQuote = router.getAmountsIn(amountOut, path);
        router.swapExactTokensForTokens(mutation, 0, path, address(this), block.timestamp);
        assertTrue(router.getAmountsIn(amountOut, path)[0] > staleQuote[0]);
        uint256 inputBefore = tokenA.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: EXCESSIVE_INPUT_AMOUNT"));
        router.swapTokensForExactTokens(amountOut, staleQuote[0], path, address(this), block.timestamp);

        assertEq(tokenA.balanceOf(address(this)), inputBefore);
    }

    function testExpiredQuoteCannotMoveFunds() public {
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256[] memory quote = router.getAmountsOut(10 ether, path);
        uint256 deadline = block.timestamp;
        uint256 inputBefore = tokenA.balanceOf(address(this));
        uint256 outputBefore = tokenB.balanceOf(address(this));
        vm.warp(deadline + 1);

        vm.expectRevert(bytes("BDEX: EXPIRED"));
        router.swapExactTokensForTokens(10 ether, quote[1], path, address(this), deadline);

        assertEq(tokenA.balanceOf(address(this)), inputBefore);
        assertEq(tokenB.balanceOf(address(this)), outputBefore);
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

    function testFeeOnTransferOutputCannotBypassRecipientMinimum() public {
        tokenB.setTax(500);
        address[] memory path = _path(address(tokenA), address(tokenB));
        uint256 amountIn = 10 ether;
        uint256[] memory grossQuote = router.getAmountsOut(amountIn, path);
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(tokenA), address(tokenB)));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();
        uint256 inputBefore = tokenA.balanceOf(address(this));
        uint256 outputBefore = tokenB.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, grossQuote[1], path, address(this), block.timestamp
        );

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
        assertEq(tokenA.balanceOf(address(this)), inputBefore);
        assertEq(tokenB.balanceOf(address(this)), outputBefore);
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

    function testQuotesRejectPathsThatReuseAPool() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenA);

        vm.expectRevert(bytes("BDEX: CYCLIC_PATH"));
        router.getAmountsOut(1 ether, path);
        vm.expectRevert(bytes("BDEX: CYCLIC_PATH"));
        router.getAmountsIn(1 ether, path);
    }

    function testMalformedPathsFailBeforeIndexingOrTakingValue() public {
        address[] memory empty = new address[](0);

        vm.expectRevert(bytes("BDEX: INVALID_PATH"));
        router.getAmountsOut(1 ether, empty);
        vm.expectRevert(bytes("BDEX: INVALID_PATH"));
        router.swapExactBLCHForTokens{value: 1 ether}(0, empty, address(this), block.timestamp);
        vm.expectRevert(bytes("BDEX: INVALID_PATH"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1 ether, 0, empty, address(this), block.timestamp);
    }

    function testRepeatedPoolPathRevertsBeforeTakingInput() public {
        address[] memory path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenA);
        uint256 balanceBefore = tokenA.balanceOf(address(this));

        vm.expectRevert(bytes("BDEX: CYCLIC_PATH"));
        router.swapExactTokensForTokens(1 ether, 0, path, address(this), block.timestamp);
        vm.expectRevert(bytes("BDEX: CYCLIC_PATH"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1 ether, 0, path, address(this), block.timestamp);

        assertEq(tokenA.balanceOf(address(this)), balanceBefore);
    }

    function testDistinctPoolCycleRemainsSupported() public {
        address[] memory path = new address[](4);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(wrapped);
        path[3] = address(tokenA);

        uint256 input = 1 ether;
        uint256 balanceBefore = tokenA.balanceOf(address(this));
        uint256[] memory amounts = router.getAmountsOut(input, path);
        assertEq(amounts.length, path.length);
        assertTrue(amounts[amounts.length - 1] > 0);

        router.swapExactTokensForTokens(input, amounts[amounts.length - 1], path, address(this), block.timestamp);
        assertEq(tokenA.balanceOf(address(this)), balanceBefore - input + amounts[amounts.length - 1]);
    }

    function _path(address a, address b) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }
}
