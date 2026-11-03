// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {V3Fixture} from "./V3Interaction.t.sol";
import {SignerMintedToken} from "./vendor/bridge-v3/bridged/SignerMintedToken.sol";
import {BridgedStablecoinV3} from "./vendor/bridge-v3/stable/BridgedStablecoinV3.sol";

/// @notice Agent 227 (round 11): the DEX RC against the rebuilt bridge V3 token (agent 194's decisions, integrated by
///         agent 200): T = 0 is a constructor rule, and at most MAX_PENDING (2,048) mints are queued at once. The fee is
///         in the Ethereum vault and does not reach the L2 token. Same fixture as agent 180's scenarios; with
///         `V3_INITCODE` set the token is the bridge's own shanghai creation code.
contract V3NewTokenR227Test is V3Fixture {
    /// The reviewed creation code (no constructor arguments) of the rebuilt BridgedStablecoinV3: bridge RC, shanghai,
    /// optimizer runs 1, bytecode_hash none (agent 194's 8d988ce; unchanged in agent 200's RC eb5c981).
    bytes32 internal constant REVIEWED_INITCODE_KECCAK = 0xe560441f37e247e387cebd23bb3dd798a29d34174a9fb19a4bb3877c6c721de7;

    event log_string(string);

    /// With V3_INITCODE set, it must be exactly the reviewed build: the scenarios then run on the bytes that deploy.
    function test_realBytecodeIsTheReviewedBuild() public {
        if (!_realBytecode()) {
            emit log_string("vendored source mode: V3_INITCODE is not set");
            return;
        }
        assertEq(keccak256(vmx.envOr("V3_INITCODE", bytes(""))), REVIEWED_INITCODE_KECCAK);
        assertEq(busdc.MAX_PENDING(), 2048);
    }

    function deployWithThreshold(uint256 t) external returns (address) {
        address[] memory signers = new address[](7);
        for (uint256 i; i < 7; ++i) signers[i] = vm.addr(signerKeys[i]);
        return address(_newToken(VAULT, bytes32("route-t"), signers, guardianSet, t));
    }

    /// The DEX's bound on a forged-mint dump (agent 180 I-1) assumes T = 0. The token now refuses any other value, so
    /// no deployed bUSDC can credit a forged mint before the guardians' 12 h window.
    function test_tokenRefusesEveryThresholdAboveZero() public {
        uint256[4] memory ts = [uint256(1), 100e6, 1_000e6, type(uint256).max];
        for (uint256 i; i < ts.length; ++i) {
            try this.deployWithThreshold(ts[i]) returns (address) {
                revert("a V3 token with T > 0 was created");
            } catch {}
        }
        assertTrue(this.deployWithThreshold(0) != address(0));
        assertEq(busdc.largeMintThreshold(), 0);
        assertEq(busdc.instantCapacity(), 0);
    }

    function _cancel(bytes32 k, uint256 g) internal {
        (address r, uint64 amt, uint64 at) = busdc.pendingMints(k);
        vm.prank(guardianSet[g]);
        busdc.voteCancelMint(k, r, amt, at);
        vm.prank(guardianSet[g + 1]);
        busdc.voteCancelMint(k, r, amt, at);
        (, uint64 left,) = busdc.pendingMints(k);
        assertEq(left, 0);
    }

    function _assertReserves(uint256 w0, uint256 u0) internal view {
        (uint256 w, uint256 u) = _reserves();
        assertEq(w, w0);
        assertEq(u, u0);
    }

    function test_pendingCountFollowsTheQueue() public {
        assertEq(busdc.MAX_PENDING(), 2048);
        assertEq(busdc.pendingCount(), 0);
        _seed(500e6, 5 ether);
        assertEq(busdc.pendingCount(), 0);
        bytes32 a = _queue(busdc, 20e6, address(pair));
        bytes32 b = _queue(busdc, 20e6, ALICE);
        assertEq(busdc.pendingCount(), 2);
        _cancel(a, 0);
        assertEq(busdc.pendingCount(), 1);
        vm.warp(block.timestamp + DELAY);
        busdc.remint(a, busdc.slotFor(a), 20e6, address(pair), false, _sign(busdc.remintDigest(a, busdc.slotFor(a), 20e6, address(pair), false), 5));
        assertEq(busdc.pendingCount(), 2);
        vm.warp(block.timestamp + DELAY);
        busdc.executeMint(a);
        if (busdc.pendingCount() != 0) busdc.executeMint(b);
        assertEq(busdc.pendingCount(), 0);
    }

    /// A forger with the mint quorum (or a burst) fills the queue to MAX_PENDING. Honest mints are refused until a
    /// cancel frees a place: inflow of new bUSDC stops, as under a pause. Every pool path still works, every LP exits,
    /// and nothing in the queue (mints to the pair included) changes the reserves until it credits.
    function test_pendingCapFullLeavesEveryPairPathWorking() public {
        uint256 liquidity = _seed(500e6, 5 ether);
        _bridge(200e6, ALICE);
        (uint256 w0, uint256 u0) = _reserves();
        uint256 cap = busdc.MAX_PENDING();
        bytes32 first;
        for (uint256 i; i < cap; ++i) {
            bytes32 k = _queue(busdc, 1e6, i % 8 == 0 ? address(pair) : BOB);
            if (i == 0) first = k;
        }
        assertEq(busdc.pendingCount(), cap);

        // the next mint is refused, whoever it is for
        uint64 nonce = nextNonce;
        bytes32 key = _key(nonce);
        bytes memory sigs = _sign(busdc.mintDigest(key, nonce, 50e6, ALICE), 5);
        vmx.expectRevert(BridgedStablecoinV3.PendingCapReached.selector);
        busdc.mint(key, nonce, 50e6, ALICE, sigs);

        // the queue holds 256 mints to the pair; the pair's balance and reserves have not moved
        _assertReserves(w0, u0);
        assertEq(busdc.balanceOf(address(pair)), u0);

        // every pool path
        router.swapExactBLCHForTokens{value: 0.1 ether}(0, _path(address(wblch), address(busdc)), address(this), block.timestamp);
        vm.startPrank(ALICE);
        busdc.approve(address(router), type(uint256).max);
        router.swapExactTokensForBLCH(100e6, 0, _path(address(busdc), address(wblch)), ALICE, block.timestamp);
        vm.stopPrank();
        router.addLiquidityBLCH{value: 0.1 ether}(address(busdc), 5e6, 0, 0, address(this), block.timestamp);
        busdc.transfer(address(pair), 1);
        pair.skim(BOB);
        pair.sync();
        vm.prank(ALICE);
        busdc.burn(10e6, ETH_RECIPIENT);

        // one guardian cancel frees one place, and the refused mint goes in
        _cancel(first, 0);
        assertEq(busdc.pendingCount(), cap - 1);
        busdc.mint(key, nonce, 50e6, ALICE, sigs);
        nextNonce = nonce + 1;
        assertEq(busdc.pendingCount(), cap);

        // the full exit still works while the queue is full
        router.removeLiquidityBLCH(address(busdc), pair.balanceOf(address(this)), 0, 0, address(this), block.timestamp);
        assertTrue(liquidity > 0);
        assertEq(pair.balanceOf(address(this)), 0);
    }

    /// With the queue full of forged mints and the guardians cancelling, nothing forged credits and the pool is
    /// untouched; once the slot freed by the cancel is reminted and the delay passes, credits resume in order.
    function test_creditsResumeInOrderAfterTheCapAndTheCancel() public {
        _seed(500e6, 5 ether);
        (uint256 w0, uint256 u0) = _reserves();
        uint256 cap = busdc.MAX_PENDING();
        bytes32[] memory keys = new bytes32[](cap);
        for (uint256 i; i < cap; ++i) {
            keys[i] = _queue(busdc, 1e6, address(pair));
        }
        // the guardians cancel the head of the queue; everything behind it waits for the slot
        _cancel(keys[0], 1);
        vm.warp(block.timestamp + DELAY);
        uint64 count = busdc.mintCount();
        try busdc.executeMint(keys[1]) {} catch {}
        assertEq(busdc.mintCount(), count);
        _assertReserves(w0, u0);
        // a 6-of-7 locked remint is not needed: a 5-of-7 remint fills the freed slot, and after its delay the queue drains
        uint64 slot = busdc.slotFor(keys[0]);
        busdc.remint(keys[0], slot, 1e6, address(pair), false, _sign(busdc.remintDigest(keys[0], slot, 1e6, address(pair), false), 5));
        vm.warp(block.timestamp + DELAY);
        busdc.executeMint(keys[0]);
        for (uint256 i; i < 300 && busdc.pendingCount() > 0; ++i) busdc.drain();
        assertEq(busdc.pendingCount(), 0);
        assertEq(busdc.mintCount(), count + cap);
        // all of it went to the pair as excess: reserves move only by a sync or a skim, never by the bridge
        _assertReserves(w0, u0);
        assertEq(busdc.balanceOf(address(pair)), u0 + cap * 1e6);
        pair.skim(SAFE);
        assertEq(busdc.balanceOf(SAFE), cap * 1e6);
    }
}
