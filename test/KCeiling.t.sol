// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";

/// F1: reserve0 * reserve1 stays at or below 64% of cap0 * cap1 on every path, so
/// the two reserves can never both sit at their caps.
contract KCeilingTest is TestBase {
    uint256 internal constant CAP_W = 10 ether;
    uint256 internal constant CAP_Q = 1_000e6;
    uint256 internal constant CEILING = CAP_W * CAP_Q * 64 / 100;

    TestToken internal w;
    TestToken internal q;
    UniswapV2Pair internal pair;
    bool internal wFirst;

    function setUp() public {
        vm.warp(1_000);
        w = new TestToken();
        q = new TestToken();
        address[] memory tokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (tokens[0], caps[0]) = (address(w), CAP_W);
        (tokens[1], caps[1]) = (address(q), CAP_Q);
        UniswapV2Factory factory = new UniswapV2Factory(address(0x5AFE), tokens, caps);
        pair = UniswapV2Pair(factory.createPair(address(w), address(q)));
        wFirst = pair.token0() == address(w);
        w.mint(address(this), 1_000_000 ether);
        q.mint(address(this), 1_000_000e6);
    }

    function reserves() internal view returns (uint256 rw, uint256 rq) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rw, rq) = wFirst ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function mintAt(uint256 aw, uint256 aq) internal {
        w.transfer(address(pair), aw);
        q.transfer(address(pair), aq);
        pair.mint(address(this));
    }

    function sell(bool sellW, uint256 amountIn) internal {
        (uint256 rw, uint256 rq) = reserves();
        (uint256 rIn, uint256 rOut) = sellW ? (rw, rq) : (rq, rw);
        uint256 out = amountIn * 997 * rOut / (rIn * 1000 + amountIn * 997);
        (sellW ? w : q).transfer(address(pair), amountIn);
        bool outIs0 = wFirst != sellW;
        pair.swap(outIs0 ? out : 0, outIs0 ? 0 : out, address(this), "");
    }

    function assertOpen() internal {
        (uint256 rw, uint256 rq) = reserves();
        assertTrue(rw * rq <= CEILING);
        pair.skim(address(0xD0));
        uint256 snapW = rw < CAP_W ? (CAP_W - rw) / 2 : 0;
        uint256 snapQ = rq < CAP_Q ? (CAP_Q - rq) / 2 : 0;
        assertTrue(snapW > 0 || snapQ > 0);
        if (snapW > 0) sell(true, snapW);
        else sell(false, snapQ);
    }

    function testMintAndSyncRefuseAboveCeiling() public {
        w.transfer(address(pair), 8 ether + 1);
        q.transfer(address(pair), 800e6);
        vm.expectRevert(bytes("BDEX: K_CEILING"));
        pair.mint(address(this));
        pair.skim(address(0xD0));
        mintAt(8 ether, 800e6);
        w.transfer(address(pair), 1 ether);
        vm.expectRevert(bytes("BDEX: K_CEILING"));
        pair.sync();
    }

    function testOneSideStillReachesItsCapBySwap() public {
        mintAt(8 ether, 800e6);
        sell(false, 200e6);
        (, uint256 rq) = reserves();
        assertEq(rq, CAP_Q);
        assertOpen();
    }

    /// The dump bound the caps exist for: a dump to the cap at the ceiling takes
    /// no more than the same dump without the ceiling.
    function testDumpBoundUnchangedAtCeiling() public {
        mintAt(8 ether, 800e6);
        (uint256 rw,) = reserves();
        uint256 before = w.balanceOf(address(this));
        sell(false, 200e6);
        uint256 taken = w.balanceOf(address(this)) - before;
        assertTrue(taken <= rw - rw * 800e6 / CAP_Q);
    }

    function testDonationThroughSwapStaysUnderCeilingAndIsSkimmable() public {
        mintAt(8 ether, 800e6);
        (uint256 rw, uint256 rq) = reserves();
        w.transfer(address(pair), CAP_W - rw);
        q.transfer(address(pair), CAP_Q - rq);
        pair.swap(wFirst ? 1 : 0, wFirst ? 0 : 1, address(this), "");
        (uint256 nw, uint256 nq) = reserves();
        assertTrue(nw * nq <= CEILING);
        // The LPs' reserves are not reduced on the side that grew.
        assertTrue(nq >= rq);
        assertOpen();
    }

    function testDonationThroughDustBurnStaysUnderCeiling() public {
        mintAt(8 ether, 800e6);
        (uint256 rw, uint256 rq) = reserves();
        w.transfer(address(pair), CAP_W - rw);
        q.transfer(address(pair), CAP_Q - rq);
        pair.transfer(address(pair), 1e9);
        pair.burn(address(this));
        assertOpen();
    }

    /// Fees cannot raise k past the ceiling: the wash that reached both caps
    /// before this fix, 2,108 swaps, with skim between swaps.
    function testWashTradeCannotReachBothCaps() public {
        mintAt(8 ether, 800e6);
        for (uint256 i; i < 3_000; ++i) {
            (uint256 rw, uint256 rq) = reserves();
            uint256 roomW = CAP_W - rw;
            uint256 roomQ = CAP_Q - rq;
            if (roomW * CAP_Q >= roomQ * CAP_W) sell(true, roomW);
            else sell(false, roomQ);
            pair.skim(address(0xD0));
            (rw, rq) = reserves();
            assertTrue(rw * rq <= CEILING);
            assertTrue(rw < CAP_W || rq < CAP_Q);
        }
        assertOpen();
    }

    /// At the ceiling, k does not fall on a swap, and the fee is what stays out.
    function testSwapAtCeilingKeepsKAndLeavesFeeOutside() public {
        mintAt(8 ether, 800e6);
        (uint256 rw, uint256 rq) = reserves();
        sell(false, 100e6);
        (uint256 nw, uint256 nq) = reserves();
        assertTrue(nw * nq <= CEILING);
        assertTrue(nw * nq * 100_001 / 100_000 >= rw * rq);
        uint256 excess = q.balanceOf(address(pair)) - nq;
        assertTrue(excess > 0 && excess <= 100e6 * 4 / 1000);
    }

    /// Exits are never blocked, from any fill.
    function testFullExitAtCeiling() public {
        mintAt(8 ether, 800e6);
        q.transfer(address(pair), 5_000e6);
        uint256 shares = pair.balanceOf(address(this));
        pair.transfer(address(pair), shares);
        (uint256 a0, uint256 a1) = pair.burn(address(this));
        assertTrue(a0 > 0 && a1 > 0);
    }
}
