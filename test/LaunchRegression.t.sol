// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexFixture} from "./SecurityRegression.t.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";

contract LaunchRegressionTest is DexFixture {
    struct PermitSignature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function testFirstDepositSurvivesOneSidedDonationAndSync() public {
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(token), address(wrapped)));
        token.transfer(address(pair), 1);
        pair.sync();
        (,, uint256 liquidity) = router.addLiquidityBLCH{value: 1 ether}(
            address(token), 1 ether, 1 ether, 1 ether, address(this), block.timestamp
        );
        assertTrue(liquidity > 0);
        assertEq(pair.balanceOf(address(this)), liquidity);
    }

    function testWrappedDonationCannotSubsidizeSwapMinimum() public {
        seed();
        wrapped.deposit{value: 1 ether}();
        wrapped.transfer(address(router), 1 ether);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(wrapped);
        uint256[] memory quote = router.getAmountsOut(1 ether, path);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForBLCHSupportingFeeOnTransferTokens(
            1 ether, quote[1] + 1, path, RECIPIENT, block.timestamp
        );
        router.swapExactTokensForBLCHSupportingFeeOnTransferTokens(1 ether, quote[1], path, RECIPIENT, block.timestamp);
        assertEq(RECIPIENT.balance, quote[1]);
        assertEq(wrapped.balanceOf(address(router)), 1 ether);
    }

    function testCollectorRejectsNonContractDependencies() public {
        vm.expectRevert(bytes("TFC: NOT_A_CONTRACT"));
        new TreasuryFeeCollector(address(123), RECIPIENT, address(wrapped));
        vm.expectRevert(bytes("TFC: NOT_A_CONTRACT"));
        new TreasuryFeeCollector(address(factory), RECIPIENT, address(123));
    }

    function testFuzzFrontRunPermitDoesNotBlockAnyRemoval(uint8 variantSeed, bool approveMax) public {
        uint8 variant = variantSeed % 3;
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        uint256 shares = liquidity / 10;
        address owner = vm.addr(0x1234);
        pair.transfer(owner, shares);
        uint256 value = approveMax ? type(uint256).max : shares;
        bytes32 message =
            keccak256(abi.encode(pair.PERMIT_TYPEHASH(), owner, address(router), value, 0, block.timestamp));
        PermitSignature memory sig;
        (sig.v, sig.r, sig.s) =
            vm.sign(0x1234, keccak256(abi.encodePacked(hex"1901", pair.DOMAIN_SEPARATOR(), message)));
        // A third party submits the publicly visible signature first.
        vm.prank(address(0xCAFE));
        pair.permit(owner, address(router), value, block.timestamp, sig.v, sig.r, sig.s);
        vm.prank(owner);
        _removeWithSignature(variant, shares, approveMax, sig);
        assertEq(pair.balanceOf(owner), 0);
        assertEq(pair.nonces(owner), 1);
        assertTrue(token.balanceOf(RECIPIENT) > 0);
    }

    function _removeWithSignature(uint8 variant, uint256 shares, bool approveMax, PermitSignature memory sig) private {
        if (variant == 0) {
            router.removeLiquidityWithPermit(
                address(token),
                address(wrapped),
                shares,
                0,
                0,
                RECIPIENT,
                block.timestamp,
                approveMax,
                sig.v,
                sig.r,
                sig.s
            );
        } else if (variant == 1) {
            router.removeLiquidityBLCHWithPermit(
                address(token), shares, 0, 0, RECIPIENT, block.timestamp, approveMax, sig.v, sig.r, sig.s
            );
        } else {
            router.removeLiquidityBLCHWithPermitSupportingFeeOnTransferTokens(
                address(token), shares, 0, 0, RECIPIENT, block.timestamp, approveMax, sig.v, sig.r, sig.s
            );
        }
    }

    function testInvalidPermitWithoutAllowanceCannotRemoveLiquidity() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        pair.approve(address(router), 0);
        vm.expectRevert();
        router.removeLiquidityBLCHWithPermit(
            address(token), liquidity, 0, 0, RECIPIENT, block.timestamp, false, 0, bytes32(0), bytes32(0)
        );
        assertEq(pair.balanceOf(address(this)), liquidity);
    }

    function testInvalidNativeRecipientRollsBackPermitAndLiquidity() public {
        (UniswapV2Pair pair, uint256 liquidity) = seed();
        uint256 shares = liquidity / 10;
        address owner = vm.addr(0x5678);
        pair.transfer(owner, shares);
        bytes32 message =
            keccak256(abi.encode(pair.PERMIT_TYPEHASH(), owner, address(router), shares, 0, block.timestamp));
        PermitSignature memory sig;
        (sig.v, sig.r, sig.s) =
            vm.sign(0x5678, keccak256(abi.encodePacked(hex"1901", pair.DOMAIN_SEPARATOR(), message)));

        vm.prank(owner);
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.removeLiquidityBLCHWithPermit(
            address(token), shares, 0, 0, address(0), block.timestamp, false, sig.v, sig.r, sig.s
        );

        assertEq(pair.nonces(owner), 0);
        assertEq(pair.allowance(owner, address(router)), 0);
        assertEq(pair.balanceOf(owner), shares);
        assertEq(wrapped.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }
}
