// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

contract LiquidityHandler {
    UniswapV2Pair public immutable pair;
    TestToken public immutable token0;
    TestToken public immutable token1;
    bool public swapInvariantHeld = true;
    uint256 public swaps;
    uint256 public additions;
    uint256 public removals;
    uint256 public reconciliations;

    constructor() {
        UniswapV2Factory factory = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        token0 = TestToken(pair.token0());
        token1 = TestToken(pair.token1());
        token0.mint(address(pair), 1_000_000 ether);
        token1.mint(address(pair), 1_000_000 ether);
        pair.mint(address(this));
    }

    function swap(bool zeroForOne, uint96 seed) external {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amount = uint256(seed) % 100 ether + 1_000_000;
        uint256 out = BDexLibrary.getAmountOut(amount, zeroForOne ? r0 : r1, zeroForOne ? r1 : r0);
        (zeroForOne ? token0 : token1).mint(address(pair), amount);
        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
        (uint112 n0, uint112 n1,) = pair.getReserves();
        uint256 adjusted0 = uint256(n0) * 1000 - (zeroForOne ? amount * 3 : 0);
        uint256 adjusted1 = uint256(n1) * 1000 - (zeroForOne ? 0 : amount * 3);
        swapInvariantHeld = swapInvariantHeld && adjusted0 * adjusted1 >= uint256(r0) * r1 * 1_000_000;
        ++swaps;
    }

    function add(uint96 seed) external {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amount0 = uint256(seed) % 100 ether + 1_000_000;
        uint256 amount1 = amount0 * r1 / r0;
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        pair.mint(address(this));
        ++additions;
    }

    function remove(uint96 seed) external {
        uint256 maximum = pair.balanceOf(address(this)) / 100;
        uint256 shares = uint256(seed) % maximum + 1000;
        require(pair.transfer(address(pair), shares));
        pair.burn(address(this));
        ++removals;
    }

    function reconcileDonation(bool synchronize, uint96 seed0, uint96 seed1) external {
        uint256 amount0 = uint256(seed0) % 10 ether + 1;
        uint256 amount1 = uint256(seed1) % 10 ether + 1;
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        if (synchronize) {
            pair.sync();
        } else {
            pair.skim(address(this));
        }
        ++reconciliations;
    }
}

contract DexInvariantTest is TestBase {
    LiquidityHandler internal handler;
    address[] private targets;

    function setUp() public {
        handler = new LiquidityHandler();
        targets.push(address(handler));
    }

    // Foundry's invariant discovery ABI; no external test-library dependency.
    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    function invariantReservesAndSharesRemainBacked() public view {
        UniswapV2Pair pair = handler.pair();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, handler.token0().balanceOf(address(pair)));
        assertEq(r1, handler.token1().balanceOf(address(pair)));
        assertEq(pair.totalSupply(), pair.balanceOf(address(handler)) + pair.balanceOf(address(0)));
        assertEq(pair.balanceOf(address(0)), 1000);
        assertTrue(handler.swapInvariantHeld());
    }
}
