// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";

/// Agent 178, scene X5: after the seeder's full exit the pool holds dust, a correcting
/// swap pays out 0, and the planner looped on it. The planner now plans a dust donation
/// plus sync (`reprice-by-donation`), then a top-up. This replays that route on the real
/// pair with the planner's arithmetic (scripts/ops/dex-seed-plan.mjs repriceByDonation).
contract SeederExitRepriceTest is TestBase {
    address internal constant SEEDER = address(0x5EED);
    address internal constant SOMEONE = address(0xA11CE);
    uint256 internal constant WRAP_CAP = 10 ether;
    uint256 internal constant QUOTE_CAP = 1_000e6;
    uint256 internal constant PRICE = 100e6; // quote base units per 1e18 wrapped
    TestToken internal w;
    TestToken internal q;
    UniswapV2Pair internal pair;

    function setUp() public {
        w = new TestToken();
        q = new TestToken();
        address[] memory t = new address[](2);
        uint256[] memory c = new uint256[](2);
        (t[0], t[1], c[0], c[1]) = (address(w), address(q), WRAP_CAP, QUOTE_CAP);
        UniswapV2Factory f = new UniswapV2Factory(address(0), SEEDER, t, c);
        pair = UniswapV2Pair(f.createPair(address(w), address(q)));
    }

    function reserves() internal view returns (uint256 rw, uint256 rq) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rw, rq) = pair.token0() == address(w) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function seedAndExit() internal {
        w.mint(address(pair), 5 ether);
        q.mint(address(pair), 500e6);
        vm.prank(SEEDER);
        pair.mint(SEEDER);
        uint256 shares = pair.balanceOf(SEEDER);
        vm.prank(SEEDER);
        pair.transfer(address(pair), shares);
        pair.burn(SEEDER);
    }

    function testFullExitThenDonationSyncAndTopUpReopen() public {
        seedAndExit();
        assertEq(pair.totalSupply(), 1000);
        (uint256 rw, uint256 rq) = reserves();
        // 178 measured 1e8 wei and 1 unit: the pool price is 100x off.
        assertEq(rw, 1e8);
        assertEq(rq, 1);

        // A correcting swap pays out 0: sell wrapped toward the target, output in quote.
        uint256 amountIn = 9e8;
        uint256 out = (amountIn * 997 * rq) / (rw * 1000 + amountIn * 997);
        assertEq(out, 0);
        w.mint(address(pair), amountIn);
        (uint256 o0, uint256 o1) = pair.token0() == address(q) ? (out, uint256(0)) : (uint256(0), out);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_OUTPUT_AMOUNT"));
        pair.swap(o0, o1, SOMEONE, "");
        pair.skim(SOMEONE);

        // The planner's route: donate wrapped up to quote * 1e18 / price, then sync.
        uint256 next = (rq * 1e18) / PRICE;
        uint256 donation = next - rw;
        assertEq(donation, 9_900_000_000);
        assertTrue(donation * 10_000 <= WRAP_CAP * 1); // under 1 bps of the cap
        w.mint(address(pair), donation);
        vm.prank(SOMEONE);
        pair.sync();
        (rw, rq) = reserves();
        assertEq((rq * 1e18) / rw, PRICE);

        // Top-up at the pool ratio to 50% of the wrapped cap, as planWithShares plans it.
        uint256 depositW = 5 ether - rw;
        uint256 depositQ = (depositW * rq) / rw + 1;
        w.mint(address(pair), depositW);
        q.mint(address(pair), depositQ);
        vm.prank(SOMEONE);
        assertTrue(pair.mint(SOMEONE) > 0);
        (rw, rq) = reserves();
        uint256 pool = (rq * 1e18) / rw;
        assertTrue(pool * 100 >= PRICE * 99 && pool * 100 <= PRICE * 101);
        assertEq(rw, 5 ether);
    }
}
