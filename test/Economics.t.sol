// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {UniswapV2ERC20} from "../contracts/UniswapV2ERC20.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";
import {Math} from "../contracts/libraries/Math.sol";

contract EconomicsTest is TestBase {
    UniswapV2Factory internal factory;
    UniswapV2Pair internal pair;
    TestToken internal token0;
    TestToken internal token1;

    function setUp() public {
        factory = new UniswapV2Factory(address(this));
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        token0 = TestToken(pair.token0());
        token1 = TestToken(pair.token1());
    }

    function testFuzzInitialMintMatchesFlooredGeometricMean(uint96 seed0, uint96 seed1) public {
        uint256 amount0 = uint256(seed0) % 1_000_000 ether + 1_000_001;
        uint256 amount1 = uint256(seed1) % 1_000_000 ether + 1_000_001;
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);

        uint256 liquidity = pair.mint(address(this));
        uint256 geometricMean = pair.totalSupply();
        uint256 product = amount0 * amount1;

        assertEq(liquidity + pair.MINIMUM_LIQUIDITY(), geometricMean);
        assertEq(pair.balanceOf(address(0)), pair.MINIMUM_LIQUIDITY());
        assertTrue(geometricMean * geometricMean <= product);
        assertTrue((geometricMean + 1) * (geometricMean + 1) > product);
    }

    function testFuzzSubsequentMintUsesSmallerProRataContribution(uint96 seed0, uint96 seed1) public {
        _seed(1_000 ether, 1_000 ether);
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 supplyBefore = pair.totalSupply();
        uint256 amount0 = uint256(seed0) % 1_000 ether + 1;
        uint256 amount1 = uint256(seed1) % 1_000 ether + 1;
        uint256 expected = Math.min(amount0 * supplyBefore / reserve0, amount1 * supplyBefore / reserve1);
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);

        uint256 liquidity = pair.mint(address(this));

        assertEq(liquidity, expected);
        assertEq(pair.totalSupply(), supplyBefore + expected);
        assertEq(pair.balanceOf(address(0)), pair.MINIMUM_LIQUIDITY());
    }

    function testFuzzBurnReturnsFlooredProRataBalances(uint96 shareSeed) public {
        uint256 liquidity = _seed(1_000 ether, 1_000 ether);
        uint256 shares = uint256(shareSeed) % liquidity + 1;
        uint256 supplyBefore = pair.totalSupply();
        uint256 balance0Before = token0.balanceOf(address(pair));
        uint256 balance1Before = token1.balanceOf(address(pair));
        uint256 expected0 = shares * balance0Before / supplyBefore;
        uint256 expected1 = shares * balance1Before / supplyBefore;
        pair.transfer(address(pair), shares);

        (uint256 amount0, uint256 amount1) = pair.burn(address(this));

        assertEq(amount0, expected0);
        assertEq(amount1, expected1);
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(reserve0, token0.balanceOf(address(pair)));
        assertEq(reserve1, token1.balanceOf(address(pair)));
        assertEq(pair.balanceOf(address(0)), pair.MINIMUM_LIQUIDITY());
    }

    function testFuzzProtocolFeeMatchesCanonicalDilution(uint96 inputSeed) public {
        address feeRecipient = address(0xFEE);
        factory.setFeeTo(feeRecipient);
        _seed(1_000 ether, 1_000 ether);
        uint256 baseline = pair.kLast();
        uint256 input = uint256(inputSeed) % 900 ether + 1 ether;
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 output = BDexLibrary.getAmountOut(input, reserve0, reserve1);
        token0.mint(address(pair), input);
        pair.swap(0, output, address(this), "");

        (reserve0, reserve1,) = pair.getReserves();
        uint256 supplyBefore = pair.totalSupply();
        uint256 rootK = Math.sqrt(uint256(reserve0) * reserve1);
        uint256 rootKLast = Math.sqrt(baseline);
        uint256 expectedFee = supplyBefore * (rootK - rootKLast) / (rootK * 5 + rootKLast);
        uint256 amount0 = 10 ether;
        uint256 amount1 = amount0 * reserve1 / reserve0;
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);

        pair.mint(address(this));

        assertEq(pair.balanceOf(feeRecipient), expectedFee);
        (reserve0, reserve1,) = pair.getReserves();
        assertEq(pair.kLast(), uint256(reserve0) * reserve1);
    }

    function testFeeOffLiquidityEventResetsBaselineBeforeReenable() public {
        address feeRecipient = address(0xFEE);
        factory.setFeeTo(feeRecipient);
        _seed(1_000 ether, 1_000 ether);
        assertTrue(pair.kLast() > 0);

        factory.setFeeTo(address(0));
        token0.mint(address(pair), 1 ether);
        token1.mint(address(pair), 1 ether);
        pair.mint(address(this));
        assertEq(pair.kLast(), 0);

        factory.setFeeTo(feeRecipient);
        token0.mint(address(pair), 1 ether);
        token1.mint(address(pair), 1 ether);
        pair.mint(address(this));
        assertEq(pair.balanceOf(feeRecipient), 0);
        assertTrue(pair.kLast() > 0);
    }

    function testFeeToggleWithoutLiquidityEventPreservesBaseline() public {
        address feeRecipient = address(0xFEE);
        factory.setFeeTo(feeRecipient);
        _seed(1_000 ether, 1_000 ether);
        uint256 baseline = pair.kLast();
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 input = 500 ether;
        token0.mint(address(pair), input);
        pair.swap(0, BDexLibrary.getAmountOut(input, reserve0, reserve1), address(this), "");
        factory.setFeeTo(address(0));
        assertEq(pair.kLast(), baseline);
        factory.setFeeTo(feeRecipient);

        (reserve0, reserve1,) = pair.getReserves();
        uint256 rootK = Math.sqrt(uint256(reserve0) * reserve1);
        uint256 rootKLast = Math.sqrt(baseline);
        uint256 expectedFee = pair.totalSupply() * (rootK - rootKLast) / (rootK * 5 + rootKLast);
        token0.mint(address(pair), 1 ether);
        token1.mint(address(pair), uint256(reserve1) * 1 ether / reserve0);
        pair.mint(address(this));

        assertTrue(expectedFee > 0);
        assertEq(pair.balanceOf(feeRecipient), expectedFee);
    }

    function testUint112MaximumMintAndBurnRemainBacked() public {
        uint256 maximum = type(uint112).max;
        token0.mint(address(pair), maximum);
        token1.mint(address(pair), maximum);
        uint256 liquidity = pair.mint(address(this));
        assertEq(pair.totalSupply(), maximum);
        assertEq(liquidity, maximum - pair.MINIMUM_LIQUIDITY());
        pair.transfer(address(pair), liquidity);

        (uint256 amount0, uint256 amount1) = pair.burn(address(this));

        assertEq(amount0, maximum - pair.MINIMUM_LIQUIDITY());
        assertEq(amount1, maximum - pair.MINIMUM_LIQUIDITY());
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(reserve0, pair.MINIMUM_LIQUIDITY());
        assertEq(reserve1, pair.MINIMUM_LIQUIDITY());
    }

    function testPermitCannotReplayAcrossVerifyingContracts() public {
        UniswapV2ERC20 first = new UniswapV2ERC20();
        UniswapV2ERC20 second = new UniswapV2ERC20();
        address owner = vm.addr(0xABCD);
        uint256 deadline = block.timestamp + 1;
        bytes32 message = keccak256(abi.encode(first.PERMIT_TYPEHASH(), owner, address(this), 123, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xABCD, keccak256(abi.encodePacked(hex"1901", first.DOMAIN_SEPARATOR(), message)));

        vm.expectRevert(bytes("BDEX: INVALID_SIGNATURE"));
        second.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(second.nonces(owner), 0);
        first.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(first.nonces(owner), 1);
    }

    function testExpiredPermitDoesNotConsumeNonce() public {
        UniswapV2ERC20 lp = new UniswapV2ERC20();
        address owner = vm.addr(0xDCBA);
        uint256 deadline = block.timestamp;
        bytes32 message = keccak256(abi.encode(lp.PERMIT_TYPEHASH(), owner, address(this), 123, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0xDCBA, keccak256(abi.encodePacked(hex"1901", lp.DOMAIN_SEPARATOR(), message)));
        vm.warp(deadline + 1);

        vm.expectRevert(bytes("BDEX: EXPIRED"));
        lp.permit(owner, address(this), 123, deadline, v, r, s);

        assertEq(lp.nonces(owner), 0);
        assertEq(lp.allowance(owner, address(this)), 0);
    }

    function _seed(uint256 amount0, uint256 amount1) private returns (uint256 liquidity) {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        liquidity = pair.mint(address(this));
    }
}
