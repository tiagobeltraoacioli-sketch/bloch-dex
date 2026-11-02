// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {IUniswapV2Callee} from "../contracts/interfaces/IUniswapV2Callee.sol";
import {SignerMintedToken} from "./vendor/bridge-v3/bridged/SignerMintedToken.sol";
import {BridgedStablecoinV2} from "./vendor/bridge-v3/stable/BridgedStablecoinV2.sol";
import {BridgedStablecoinV3} from "./vendor/bridge-v3/stable/BridgedStablecoinV3.sol";

interface VmExtra {
    function prank(address sender, address origin) external;
    function expectRevert(bytes4 selector) external;
}

/// @notice Agent 180 (round 10): the DEX RC 86c6f2c6 against the real bridge V3 token
///         (codex/bridge-v3-r7-20261102 5fb9cf0, copied verbatim under test/vendor/bridge-v3) with the
///         mainnet bUSDC limits (T = 0, 12 h delay, 10,000 bucket) and the mainnet DEX caps (10 WBLCH, 1,000 bUSDC).
abstract contract V3Fixture is TestBase {
    VmExtra internal constant vmx = VmExtra(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant SAFE = address(0x5AFE);
    address internal constant VAULT = address(0xE7A0);
    address internal constant ETH_RECIPIENT = address(0xE7E7);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint64 internal constant DELAY = 43_200;

    WBLCH internal wblch;
    BridgedStablecoinV3 internal busdc;
    UniswapV2Factory internal factory;
    BDexRouter internal router;
    UniswapV2Pair internal pair;

    uint256[] internal signerKeys; // sorted by address
    address[] internal guardianSet;
    uint64 internal nextNonce;

    receive() external payable {}

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.deal(address(this), 1_000 ether);
        wblch = new WBLCH();
        busdc = _deployToken(VAULT, bytes32("route-1"));
        address[] memory capTokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (capTokens[0], caps[0]) = (address(wblch), 10 ether);
        (capTokens[1], caps[1]) = (address(busdc), 1_000e6);
        factory = new UniswapV2Factory(SAFE, address(this), capTokens, caps);
        router = new BDexRouter(address(factory), address(wblch));
        pair = UniswapV2Pair(factory.createPair(address(wblch), address(busdc)));
    }

    function _deployToken(address vault, bytes32 route) internal returns (BridgedStablecoinV3 t) {
        if (signerKeys.length == 0) {
            for (uint256 i = 1; i <= 7; ++i) signerKeys.push(0xC0DE00 + i);
            // insertion sort by address
            for (uint256 i = 1; i < signerKeys.length; ++i) {
                for (uint256 j = i; j > 0 && vm.addr(signerKeys[j - 1]) > vm.addr(signerKeys[j]); --j) {
                    (signerKeys[j - 1], signerKeys[j]) = (signerKeys[j], signerKeys[j - 1]);
                }
            }
            guardianSet.push(address(0x6A01));
            guardianSet.push(address(0x6A02));
            guardianSet.push(address(0x6A03));
        }
        address[] memory signers = new address[](7);
        for (uint256 i; i < 7; ++i) signers[i] = vm.addr(signerKeys[i]);
        t = new BridgedStablecoinV3(
            "Bloch Bridged USDC",
            "bUSDC",
            1,
            vault,
            route,
            signers,
            5,
            SignerMintedToken.Limits({
                supplyCap: 100_000e6,
                bucketCapacity: 10_000e6,
                refillPerSecond: 115_740,
                largeMintThreshold: 0,
                largeMintDelay: DELAY,
                minBurn: 10e6
            }),
            SignerMintedToken.Guard({guardians: guardianSet, pauseDuration: 3 days, pauseCooldown: 3 days}),
            BridgedStablecoinV2.MintSwitch({threshold: 6, delay: 14 days})
        );
    }

    function _sign(bytes32 digest, uint256 k) internal returns (bytes memory sigs) {
        for (uint256 i; i < k; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[i], digest);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
    }

    function _key(uint64 nonce) internal pure returns (bytes32) {
        return bytes32((uint256(nonce) << 192) | uint256(0xD0D0 + nonce));
    }

    /// Queues a committee mint for the next deposit nonce (T = 0: every mint queues for 12 h).
    function _queue(BridgedStablecoinV3 t, uint64 amount, address to) internal returns (bytes32 key) {
        uint64 nonce = nextNonce++;
        key = _key(nonce);
        t.mint(key, nonce, amount, to, _sign(t.mintDigest(key, nonce, amount, to), 5));
    }

    function _bridge(uint64 amount, address to) internal returns (bytes32 key) {
        key = _queue(busdc, amount, to);
        vm.warp(block.timestamp + DELAY);
        busdc.executeMint(key);
    }

    function _seed(uint64 usdc, uint256 blch) internal returns (uint256 liquidity) {
        _bridge(usdc, address(this));
        busdc.approve(address(router), type(uint256).max);
        vmx.prank(address(this), address(this));
        (,, liquidity) = router.addLiquidityBLCH{value: blch}(address(busdc), usdc, usdc, blch, address(this), block.timestamp);
        pair.approve(address(router), type(uint256).max);
    }

    function _reserves() internal view returns (uint256 rW, uint256 rU) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rW, rU) = pair.token0() == address(wblch) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
    }
}

contract V3InteractionTest is V3Fixture {
    /// A guardian pause stops only mints. Every pair, router and token path a DEX user needs still works.
    function test_guardianPauseLeavesEveryPairPathWorking() public {
        _seed(500e6, 5 ether);
        _bridge(200e6, ALICE);
        bytes32 queued = _queue(busdc, 50e6, BOB);

        vm.prank(guardianSet[0]);
        busdc.pause();
        assertTrue(busdc.paused());

        // swaps both ways
        router.swapExactBLCHForTokens{value: 0.1 ether}(0, _path(address(wblch), address(busdc)), address(this), block.timestamp);
        vm.startPrank(ALICE);
        busdc.approve(address(router), type(uint256).max);
        router.swapExactTokensForBLCH(100e6, 0, _path(address(busdc), address(wblch)), ALICE, block.timestamp);
        vm.stopPrank();
        // liquidity in and out
        router.addLiquidityBLCH{value: 0.1 ether}(address(busdc), 5e6, 0, 0, address(this), block.timestamp);
        router.removeLiquidityBLCH(address(busdc), pair.balanceOf(address(this)) / 2, 0, 0, address(this), block.timestamp);
        // escape valves
        busdc.transfer(address(pair), 1);
        pair.skim(BOB);
        pair.sync();
        // the bridge exit is never paused
        busdc.burn(10e6, ETH_RECIPIENT);
        // only the mint side stops
        vm.expectRevert(abi.encodeWithSelector(SignerMintedToken.IsPaused.selector));
        busdc.executeMint(queued);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(SignerMintedToken.IsPaused.selector));
        busdc.executeMint(queued);
    }

    /// A cancel touches only a queued mint. Tokens credited to the pair, or swapped into it, cannot be clawed back.
    function test_cancelReachesOnlyQueuedMintsNeverPairReserves() public {
        _seed(500e6, 5 ether);
        (uint256 w0, uint256 u0) = _reserves();

        // a mint queued TO THE PAIR is cancelled: the pair's balance and reserves never move
        bytes32 toPair = _queue(busdc, 100e6, address(pair));
        (address rcp, uint64 amt, uint64 readyAt) = busdc.pendingMints(toPair);
        vm.prank(guardianSet[0]);
        busdc.voteCancelMint(toPair, rcp, amt, readyAt);
        vm.prank(guardianSet[1]);
        busdc.voteCancelMint(toPair, rcp, amt, readyAt);
        (, uint64 left,) = busdc.pendingMints(toPair);
        assertEq(left, 0);
        assertEq(busdc.balanceOf(address(pair)), u0);
        (uint256 w1, uint256 u1) = _reserves();
        assertEq(w1, w0);
        assertEq(u1, u0);

        // a credited mint can no longer be cancelled (NotPending): what reached the pool stays
        bytes32 seedKey = _key(0);
        vm.prank(guardianSet[2]);
        vm.expectRevert(abi.encodeWithSelector(SignerMintedToken.NotPending.selector));
        busdc.voteCancelMint(seedKey, address(this), 500e6, uint64(0));
    }

    /// The cancel of slot k holds every later deposit until slot k is reminted and credited (credit order):
    /// bUSDC inflow to the DEX stops for at least one more 12 h delay. Swaps keep working meanwhile.
    function test_cancelHoldsLaterCreditsUntilRemintPairUnaffected() public {
        _seed(500e6, 5 ether);
        bytes32 cancelled = _queue(busdc, 100e6, ALICE); // slot 1
        bytes32 later = _queue(busdc, 100e6, BOB); // slot 2
        (address rcp, uint64 amt, uint64 readyAt) = busdc.pendingMints(cancelled);
        vm.prank(guardianSet[0]);
        busdc.voteCancelMint(cancelled, rcp, amt, readyAt);
        vm.prank(guardianSet[1]);
        busdc.voteCancelMint(cancelled, rcp, amt, readyAt);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(SignerMintedToken.NotReady.selector));
        busdc.executeMint(later);
        // the pool is unaffected
        router.swapExactBLCHForTokens{value: 0.1 ether}(0, _path(address(wblch), address(busdc)), address(this), block.timestamp);

        // the committee reminds slot 1 to its original recipient; 12 h later one execute credits both, in order
        busdc.remint(cancelled, 1, 100e6, ALICE, false, _sign(busdc.remintDigest(cancelled, 1, 100e6, ALICE, false), 5));
        vm.warp(block.timestamp + DELAY);
        busdc.executeMint(cancelled);
        assertEq(busdc.balanceOf(ALICE), 100e6);
        assertEq(busdc.balanceOf(BOB), 100e6); // drained behind it
    }

    /// A deposit whose L2 recipient is the pair (vault accepts any address) is a donation: anyone may execute the
    /// queued mint at a moment of their choosing and skim it in the same transaction. The mint chain binds the
    /// recipient, so the committee cannot remint it elsewhere without holding every later exit.
    function test_depositToPairIsCapturedByAnySkimmer() public {
        _seed(500e6, 5 ether);
        bytes32 key = _queue(busdc, 300e6, address(pair));
        vm.warp(block.timestamp + DELAY);
        Skimmer s = new Skimmer();
        s.executeAndSkim(busdc, pair, key);
        assertEq(busdc.balanceOf(address(s)), 300e6);
        (, uint256 u) = _reserves();
        assertEq(busdc.balanceOf(address(pair)), u);
    }

    /// The same misdirected deposit is captured by a flash swap: the callback executes the queued mint, the
    /// credit to the pair counts as the swap's input, and the borrower keeps the WBLCH.
    function test_flashSwapCallbackPaysWithAQueuedMintToThePair() public {
        _seed(500e6, 5 ether);
        bytes32 key = _queue(busdc, 300e6, address(pair));
        vm.warp(block.timestamp + DELAY);
        FlashExecutor f = new FlashExecutor();
        (uint256 rW, uint256 rU) = _reserves();
        uint256 out = router.getAmountOut(300e6, rU, rW);
        f.run(pair, busdc, key, address(wblch), out);
        assertEq(wblch.balanceOf(address(f)), out);
        assertTrue(out > 1 ether);
    }

    /// The pair's lock stops every reentry from the flash callback; the V3 token has no hooks of its own.
    function test_flashCallbackCannotReenterThePair() public {
        _seed(500e6, 5 ether);
        Reenterer r = new Reenterer();
        vm.expectRevert(bytes("BDEX: LOCKED"));
        r.run(pair, address(wblch));
    }

    /// No fee on transfer, no rebase: router quotes are exact and the fee collector's exact-delta conversion works.
    function test_exactTransfersAndCollectorPaths() public {
        _seed(500e6, 5 ether);
        address[] memory p = _path(address(busdc), address(wblch));
        _bridge(100e6, address(this));
        uint256[] memory q = router.getAmountsOut(50e6, p);
        uint256 before = address(this).balance;
        router.swapExactTokensForBLCH(50e6, q[1], p, address(this), block.timestamp);
        assertEq(address(this).balance - before, q[1]);
        router.swapExactTokensForBLCHSupportingFeeOnTransferTokens(10e6, 0, p, address(this), block.timestamp);
        // protocol fee: crystallise and redeem; feeTo is the Safe address here, so redeem as the Safe
        router.addLiquidityBLCH{value: 0.01 ether}(address(busdc), 1e6, 0, 0, address(this), block.timestamp);
        uint256 fee = pair.balanceOf(SAFE);
        assertTrue(fee > 0);
        vm.prank(SAFE);
        pair.transfer(address(pair), fee);
        pair.burn(SAFE);
        assertTrue(busdc.balanceOf(SAFE) > 0 && wblch.balanceOf(SAFE) > 0);
    }

    /// A forged mint that credits (all guardians failed for 12 h) is dumped into the pool: the bUSDC cap bounds
    /// the WBLCH the forger can take to what moves the bUSDC reserve from its level to the cap.
    function test_forgedCreditedMintDumpIsBoundedByTheCap() public {
        _seed(500e6, 5 ether);
        address forger = address(0xF0F0);
        _bridge(10_000e6, forger); // the forged mint: nobody cancelled it
        vm.startPrank(forger);
        busdc.approve(address(router), type(uint256).max);
        address[] memory p = _path(address(busdc), address(wblch));
        // over the cap the router-quoted swap reverts on chain
        vm.expectRevert(bytes("BDEX: RESERVE_CAP"));
        router.swapExactTokensForBLCH(600e6, 0, p, forger, block.timestamp);
        uint256 got = router.swapExactTokensForBLCH(500e6, 0, p, forger, block.timestamp)[1];
        vm.stopPrank();
        (uint256 rW, uint256 rU) = _reserves();
        assertEq(rU, 1_000e6);
        assertTrue(got < 2.51 ether && got > 2.49 ether);
        assertTrue(rW > 2.49 ether);
        assertEq(busdc.balanceOf(forger), 9_500e6);
    }

    /// BR-2 migration: a new token (new vault) has no cap in the launch factory. A pair of it in that factory is
    /// capped on the WBLCH side only, so the k ceiling is off and the bUSDC side is unbounded. Only the fixed
    /// first depositor can open it. The old pair keeps working for exits.
    function test_migratedTokenInLaunchFactoryIsUncapped() public {
        uint256 liquidity = _seed(500e6, 5 ether);
        uint64 saved = nextNonce;
        nextNonce = 0;
        BridgedStablecoinV3 v2token = _deployToken(address(0xE7A1), bytes32("route-2"));
        bytes32 k = _queue(v2token, 5_000e6, address(this));
        vm.warp(block.timestamp + DELAY);
        v2token.executeMint(k);
        nextNonce = saved;

        UniswapV2Pair newPair = UniswapV2Pair(factory.createPair(address(wblch), address(v2token)));
        (uint112 c0, uint112 c1) = newPair.reserveCaps();
        assertEq(address(v2token) < address(wblch) ? c0 : c1, 0);
        assertEq(address(v2token) < address(wblch) ? c1 : c0, 10 ether);

        // a stranger cannot open it (factory-wide first depositor) ...
        wblch.deposit{value: 1 ether}();
        v2token.transfer(address(newPair), 10e6);
        wblch.transfer(address(newPair), 0.1 ether);
        vmx.prank(ALICE, ALICE);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        newPair.mint(ALICE);
        // ... but the depositor seeds 5,000 of the new token, five times the launch bUSDC cap
        v2token.transfer(address(newPair), 4_990e6);
        newPair.mint(address(this));
        (uint112 r0, uint112 r1,) = newPair.getReserves();
        assertEq(address(v2token) < address(wblch) ? r0 : r1, 5_000e6);

        // the old pair still exits and the old token still burns
        router.removeLiquidityBLCH(address(busdc), liquidity, 0, 0, address(this), block.timestamp);
        busdc.burn(uint64(busdc.balanceOf(address(this))), ETH_RECIPIENT);
    }

    /// The gate pins the token by address and runtime code hash. The V3 code hash covers the immutables (vault,
    /// route, limits, thresholds) but not the signer and guardian sets, which are storage: a look-alike token with
    /// other signers has the same code hash. Only the address pin tells them apart.
    function test_codeHashDoesNotPinSignersOrGuardians() public {
        BridgedStablecoinV3 a = _deployToken(VAULT, bytes32("route-1"));
        uint256 saved = signerKeys[0];
        signerKeys[0] = 0xBAD; // one different signer
        address[] memory signers = new address[](7);
        for (uint256 i; i < 7; ++i) signers[i] = vm.addr(signerKeys[i]);
        signerKeys[0] = saved;
        // keep ascending order irrelevant: the constructor does not require it
        address[] memory g = new address[](3);
        (g[0], g[1], g[2]) = (address(0xBAD1), address(0xBAD2), address(0xBAD3));
        BridgedStablecoinV3 b = new BridgedStablecoinV3(
            "Bloch Bridged USDC",
            "bUSDC",
            1,
            VAULT,
            bytes32("route-1"),
            signers,
            5,
            SignerMintedToken.Limits({
                supplyCap: 100_000e6,
                bucketCapacity: 10_000e6,
                refillPerSecond: 115_740,
                largeMintThreshold: 0,
                largeMintDelay: DELAY,
                minBurn: 10e6
            }),
            SignerMintedToken.Guard({guardians: g, pauseDuration: 3 days, pauseCooldown: 3 days}),
            BridgedStablecoinV2.MintSwitch({threshold: 6, delay: 14 days})
        );
        assertEq(address(a).codehash, address(b).codehash);
        assertEq(address(busdc).codehash, address(a).codehash);
        assertTrue(a.signers()[0] != b.signers()[0] || a.signers()[1] != b.signers()[1]);
        assertEq(b.mintHead(), a.mintHead()); // same genesis too: vault, route and chain are the same
    }

    /// Transfers of the V3 token cannot be made to revert by any role: they fail only on balance or allowance.
    /// With mints paused, a mint cancelled and the mint switch proposal live, every LP still exits.
    function test_noRoleCanFreezeTransfersOrLpExit() public {
        uint256 liquidity = _seed(500e6, 5 ether);
        bytes32 q = _queue(busdc, 100e6, ALICE);
        (address rcp, uint64 amt, uint64 readyAt) = busdc.pendingMints(q);
        vm.prank(guardianSet[0]);
        busdc.voteCancelMint(q, rcp, amt, readyAt);
        vm.prank(guardianSet[1]);
        busdc.voteCancelMint(q, rcp, amt, readyAt);
        vm.prank(guardianSet[2]);
        busdc.pause();
        router.removeLiquidityBLCH(address(busdc), liquidity, 0, 0, address(this), block.timestamp);
        (uint256 rW, uint256 rU) = _reserves();
        assertTrue(rW > 0 && rU > 0); // only the locked minimum remains
        assertEq(pair.totalSupply(), 1_000);
    }
}

/// A hypothetical future bridge token whose transfers can be stopped. NOT the V3 token: it shows what the pair
/// would do, so a token change that adds a transfer pause is caught as a DEX change too.
contract TransferPausableToken {
    string public constant name = "Pausable";
    string public constant symbol = "PAUS";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    bool public frozen;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
    }

    function freeze(bool f) external {
        frozen = f;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        return _move(msg.sender, to, v);
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        return _move(f, to, v);
    }

    function _move(address f, address to, uint256 v) private returns (bool) {
        require(!frozen, "FROZEN");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract TransferPauseDependencyTest is TestBase {
    receive() external payable {}

    /// If a bridge token could stop transfers, every LP of its pair is locked (burn pays both legs) and the
    /// other side cannot leave either. The DEX relies on the V3 property that no role can do this.
    function test_aTransferPauseWouldLockEveryLp() public {
        vm.deal(address(this), 10 ether);
        WBLCH w = new WBLCH();
        TransferPausableToken t = new TransferPausableToken();
        UniswapV2Factory f = new UniswapV2Factory(address(0), address(0), new address[](0), new uint256[](0));
        BDexRouter r = new BDexRouter(address(f), address(w));
        t.mint(address(this), 1_000e6);
        t.approve(address(r), type(uint256).max);
        (,, uint256 liq) = r.addLiquidityBLCH{value: 1 ether}(address(t), 500e6, 0, 0, address(this), block.timestamp);
        UniswapV2Pair p = UniswapV2Pair(f.getPair(address(t), address(w)));
        p.approve(address(r), type(uint256).max);
        t.freeze(true);
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        r.removeLiquidityBLCH(address(t), liq, 0, 0, address(this), block.timestamp);
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(w), address(t));
        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        r.swapExactBLCHForTokens{value: 0.1 ether}(0, path, address(this), block.timestamp);
    }
}

contract Skimmer {
    function executeAndSkim(BridgedStablecoinV3 t, UniswapV2Pair p, bytes32 key) external {
        t.executeMint(key);
        p.skim(address(this));
    }
}

contract FlashExecutor is IUniswapV2Callee {
    BridgedStablecoinV3 private token;
    bytes32 private key;

    function run(UniswapV2Pair p, BridgedStablecoinV3 t, bytes32 k, address wrapped, uint256 out) external {
        (token, key) = (t, k);
        (uint256 o0, uint256 o1) = p.token0() == wrapped ? (out, uint256(0)) : (uint256(0), out);
        p.swap(o0, o1, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        token.executeMint(key); // credits the pair: the repayment is someone else's deposit
    }
}

contract Reenterer is IUniswapV2Callee {
    UniswapV2Pair private pair;

    function run(UniswapV2Pair p, address wrapped) external {
        pair = p;
        (uint256 o0, uint256 o1) = p.token0() == wrapped ? (uint256(1e15), uint256(0)) : (uint256(0), uint256(1e15));
        p.swap(o0, o1, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        pair.sync();
    }
}
