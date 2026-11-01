// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

/// Ported from agent 61's attack suite (`test/F1Attack.t.sol`, `test/F1AttackC.t.sol` on
/// `codex/dex-f1-attack-c-r3-20261031`): the seeded invariants only. They run from a dust,
/// a 50% and a ceiling opening, so none runs on an empty pair. Its failing limit tests
/// are not here.
abstract contract F1Base is TestBase {
    event log_named_uint(string key, uint256 val);
    event log_string(string val);

    uint256 internal constant CAP_W = 10 ether;
    uint256 internal constant CAP_Q = 1_000e6;
    address internal constant SAFE = address(0x5AFE);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant ATTACKER2 = address(0xBAD2);
    address internal constant SEEDER = address(0x5EED);
    address internal constant USER = address(0x1234);
    bytes32 internal constant OK = keccak256("PROBE_OK");

    TestToken internal w; // stands in for WBLCH: the pair sees an ordinary ERC-20
    TestToken internal q; // stands in for bUSDC, which has no tax, hook or rebase
    UniswapV2Factory internal factory;
    BDexRouter internal router;
    UniswapV2Pair internal pair;

    function setUpMarket() internal {
        vm.warp(1_000);
        w = new TestToken();
        q = new TestToken();
        address[] memory tokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (tokens[0], caps[0]) = (address(w), CAP_W);
        (tokens[1], caps[1]) = (address(q), CAP_Q);
        factory = new UniswapV2Factory(SAFE, SEEDER, tokens, caps);
        pair = UniswapV2Pair(factory.createPair(address(w), address(q)));
        address[4] memory who = [ATTACKER, ATTACKER2, SEEDER, USER];
        for (uint256 i; i < who.length; ++i) {
            w.mint(who[i], 1_000 ether);
            q.mint(who[i], 100_000e6);
        }
    }

    function reservesWQ() internal view returns (uint256 rw, uint256 rq) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rw, rq) = pair.token0() == address(w) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function donate(address from, uint256 aw, uint256 aq) internal {
        vm.startPrank(from);
        if (aw > 0) w.transfer(address(pair), aw);
        if (aq > 0) q.transfer(address(pair), aq);
        vm.stopPrank();
    }

    function rawMint(address from, uint256 aw, uint256 aq) internal returns (uint256 shares) {
        donate(from, aw, aq);
        vm.prank(from);
        shares = pair.mint(from);
    }

    function burnAll(address from) internal returns (uint256 gotW, uint256 gotQ) {
        (gotW, gotQ) = burnShares(from, pair.balanceOf(from));
    }

    function burnShares(address from, uint256 shares) internal returns (uint256 gotW, uint256 gotQ) {
        vm.startPrank(from);
        pair.transfer(address(pair), shares);
        (uint256 a0, uint256 a1) = pair.burn(from);
        vm.stopPrank();
        (gotW, gotQ) = pair.token0() == address(w) ? (a0, a1) : (a1, a0);
    }

    /// Sell `amountIn` of one token through the pair, the way the router prices it.
    function rawSwap(address from, bool sellW, uint256 amountIn) internal {
        (uint256 rw, uint256 rq) = reservesWQ();
        (uint256 rIn, uint256 rOut) = sellW ? (rw, rq) : (rq, rw);
        uint256 out = amountIn * 997 * rOut / (rIn * 1000 + amountIn * 997);
        vm.startPrank(from);
        (sellW ? w : q).transfer(address(pair), amountIn);
        bool outIs0 = pair.token0() == address(sellW ? q : w);
        pair.swap(outIs0 ? out : 0, outIs0 ? 0 : out, from, "");
        vm.stopPrank();
    }

    // ---- probes ----------------------------------------------------------

    /// Excess over the reserves blocks a swap until anyone skims it. That is
    /// the accepted DEX-02 state and has a permissionless cure, so the probes
    /// apply the cure first: what remains is what skim cannot fix.
    function probeSwapBody(bool sellW, uint256 amountIn) external {
        pair.skim(address(0xDEAD));
        rawSwap(USER, sellW, amountIn);
        revert("PROBE_OK");
    }

    function probeDepositBody(uint256 aw, uint256 aq) external {
        pair.skim(address(0xDEAD));
        rawMint(SEEDER, aw, aq);
        revert("PROBE_OK");
    }

    function _ok(bytes memory data) internal pure returns (bool) {
        if (data.length < 68) return false;
        bytes memory body;
        assembly {
            body := add(data, 4)
        }
        return keccak256(bytes(abi.decode(body, (string)))) == OK;
    }

    function canSwap(bool sellW, uint256 amountIn) internal returns (bool) {
        try this.probeSwapBody(sellW, amountIn) {
            return false;
        } catch (bytes memory data) {
            return _ok(data);
        }
    }

    /// A deposit of `fracBps` of the caps at the pool's current price: the
    /// tighter side takes the fraction, the other side follows the ratio.
    function canDepositFrac(uint256 fracBps) internal returns (bool) {
        (uint256 rw, uint256 rq) = reservesWQ();
        uint256 aw = CAP_W * fracBps / 10_000;
        uint256 aq = CAP_Q * fracBps / 10_000;
        if (rw > 0 && rq > 0) {
            // Keep the ratio. Round the other side up, or the min() share
            // formula would give a dust deposit no shares.
            if (rw * CAP_Q >= rq * CAP_W) aq = aw * rq / rw + 1;
            else aw = aq * rw / rq + 1;
        }
        try this.probeDepositBody(aw, aq) {
            return false;
        } catch (bytes memory data) {
            return _ok(data);
        }
    }

    function swapLive() internal returns (bool) {
        return canSwap(true, CAP_W / 1000) || canSwap(false, CAP_Q / 1000);
    }

    function seedLive() internal returns (bool) {
        return canDepositFrac(100);
    }

    /// Largest fill the pair accepts, found by bisection on a fraction of the
    /// room left below the caps. Adapts to any mint ceiling on any rule.
    function maxMintFill(address from) internal returns (uint256 shares, uint256 paidW, uint256 paidQ) {
        (uint256 rw, uint256 rq) = reservesWQ();
        if (rw >= CAP_W || rq >= CAP_Q) return (0, 0, 0);
        uint256 lo;
        uint256 hi = 1e18;
        if (_fillAccepted(CAP_W - rw, CAP_Q - rq, from)) {
            lo = hi;
        } else {
            for (uint256 i; i < 96 && hi - lo > 1; ++i) {
                uint256 mid = (lo + hi) / 2;
                if (_fillAccepted((CAP_W - rw) * mid / 1e18, (CAP_Q - rq) * mid / 1e18, from)) lo = mid;
                else hi = mid;
            }
        }
        if (lo == 0) return (0, 0, 0);
        paidW = (CAP_W - rw) * lo / 1e18;
        paidQ = (CAP_Q - rq) * lo / 1e18;
        shares = rawMint(from, paidW, paidQ);
    }

    function probeFillBody(uint256 aw, uint256 aq, address from) external {
        rawMint(from, aw, aq);
        revert("PROBE_OK");
    }

    function _fillAccepted(uint256 aw, uint256 aq, address from) internal returns (bool) {
        try this.probeFillBody(aw, aq, from) {
            return false;
        } catch (bytes memory data) {
            return _ok(data);
        }
    }

    function logState(string memory tag) internal {
        (uint256 rw, uint256 rq) = reservesWQ();
        emit log_string(tag);
        emit log_named_uint("  reserve W wei", rw);
        emit log_named_uint("  reserve Q units", rq);
        emit log_named_uint("  totalSupply", pair.totalSupply());
    }

    function logAttackerPnL(string memory tag, address who, uint256 startW, uint256 startQ) internal {
        emit log_string(tag);
        uint256 nowW = w.balanceOf(who);
        uint256 nowQ = q.balanceOf(who);
        emit log_named_uint("  W spent net wei", startW > nowW ? startW - nowW : 0);
        emit log_named_uint("  W gained net wei", nowW > startW ? nowW - startW : 0);
        emit log_named_uint("  Q spent net units", startQ > nowQ ? startQ - nowQ : 0);
        emit log_named_uint("  Q gained net units", nowQ > startQ ? nowQ - startQ : 0);
    }
}

/// Stateful attacker: every entrypoint, three actors, sizes biased to the caps.
contract F1Handler is F1Base {
    uint256 public calls;
    string public lastAction;

    constructor() {
        setUpMarket();
        // setUpMarket warps, harmless in the handler's constructor.
    }

    /// The first deposit the first-depositor rule allows. Without it every
    /// handler mint is refused and the invariants hold on an empty pair.
    function open(uint256 aw, uint256 aq) external {
        rawMint(SEEDER, aw, aq);
    }

    /// A burst of swaps that fill the side with more room.
    function washBurst(uint256 who, uint8 n) external {
        address a = _actor(who);
        for (uint256 i; i < uint256(n) % 32; ++i) {
            (uint256 rw, uint256 rq) = reservesWQ();
            uint256 roomW = CAP_W > w.balanceOf(address(pair)) ? CAP_W - w.balanceOf(address(pair)) : 0;
            uint256 roomQ = CAP_Q > q.balanceOf(address(pair)) ? CAP_Q - q.balanceOf(address(pair)) : 0;
            if (rw == 0 || rq == 0) return;
            bool sellW = roomW * CAP_Q >= roomQ * CAP_W;
            uint256 amt = sellW ? roomW : roomQ;
            if (amt == 0) return;
            try this.swapBody(a, sellW, amt) {}
            catch {
                return;
            }
        }
        calls++;
    }

    function bounds() external view returns (uint256 rw, uint256 rq, uint256 balW, uint256 balQ) {
        (rw, rq) = reservesWQ();
        (balW, balQ) = (w.balanceOf(address(pair)), q.balanceOf(address(pair)));
    }

    function pairAddr() external view returns (address) {
        return address(pair);
    }

    function _actor(uint256 s) internal pure returns (address) {
        return s % 3 == 0 ? ATTACKER : s % 3 == 1 ? ATTACKER2 : USER;
    }

    function _sized(uint256 seed, uint256 cap, uint256 reserve) internal pure returns (uint256) {
        uint256 room = cap > reserve ? cap - reserve : 0;
        uint256 mode = seed % 6;
        uint256 r = seed >> 8;
        if (mode == 0) return room; // exactly to the cap
        if (mode == 1) return room > 0 ? room - 1 : 0; // one unit below
        if (mode == 2) return room + 1; // one unit above
        if (mode == 3) return room * (r % 100) / 100;
        if (mode == 4) return (cap / 1000) + r % (cap / 100);
        return (r % 1000) + 1; // dust
    }

    function mintAny(uint256 who, uint256 sw, uint256 sq) external {
        (uint256 rw, uint256 rq) = reservesWQ();
        address a = _actor(who);
        uint256 aw = _sized(sw, CAP_W, rw);
        uint256 aq = _sized(sq, CAP_Q, rq);
        try this.mintBody(a, aw, aq) {} catch {}
        calls++;
    }

    function mintBody(address a, uint256 aw, uint256 aq) external {
        rawMint(a, aw, aq);
    }

    function mintMax(uint256 who) external {
        maxMintFill(_actor(who));
        calls++;
    }

    function donateAny(uint256 who, uint256 sw, uint256 sq) external {
        (uint256 rw, uint256 rq) = reservesWQ();
        donate(_actor(who), _sized(sw, CAP_W, rw), _sized(sq, CAP_Q, rq));
        calls++;
    }

    function doSync() external {
        try pair.sync() {} catch {}
        calls++;
    }

    function doSkim() external {
        try pair.skim(address(0xDEAD)) {} catch {}
        calls++;
    }

    function burnAny(uint256 who, uint256 frac) external {
        address a = _actor(who);
        uint256 s = pair.balanceOf(a);
        if (s == 0) return;
        uint256 mode = frac % 3;
        uint256 shares = mode == 0 ? s : mode == 1 ? 1 + (frac >> 8) % s : (s > 1000 ? s / 1000 : 1);
        try this.burnBody(a, shares) {} catch {}
        calls++;
    }

    function burnBody(address a, uint256 shares) external {
        burnShares(a, shares);
    }

    function swapAny(uint256 who, bool sellW, uint256 s) external {
        (uint256 rw, uint256 rq) = reservesWQ();
        if (rw == 0 || rq == 0) return;
        uint256 amt = sellW ? _sized(s, CAP_W, rw) : _sized(s, CAP_Q, rq);
        if (amt == 0) return;
        try this.swapBody(_actor(who), sellW, amt) {} catch {}
        calls++;
    }

    function swapBody(address a, bool sellW, uint256 amt) external {
        rawSwap(a, sellW, amt);
    }

    /// A swap as a sync: whatever has been donated gets recorded with 1 wei out.
    function swapAsSync(uint256 who) external {
        address a = _actor(who);
        vm.startPrank(a);
        bool wIs0 = pair.token0() == address(w);
        try pair.swap(wIs0 ? 1 : 0, wIs0 ? 0 : 1, a, "") {} catch {}
        vm.stopPrank();
        calls++;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + dt % 3600);
    }

    // Views the invariant needs. A probe needs state-changing calls, so these
    // are not `view`.
    function checkSwapLive() external returns (bool live, uint256 rw, uint256 rq, uint256 supply) {
        (rw, rq) = reservesWQ();
        supply = pair.totalSupply();
        live = rw == 0 || rq == 0 || swapLive();
    }

    function checkSeedLive() external returns (bool live, uint256 rw, uint256 rq) {
        (rw, rq) = reservesWQ();
        live = seedLive();
    }

    function checkExitLive() external returns (bool live) {
        live = true;
        address[3] memory actors = [ATTACKER, ATTACKER2, USER];
        for (uint256 i; i < 3; ++i) {
            uint256 s = pair.balanceOf(actors[i]);
            if (s == 0) continue;
            try this.exitProbe(actors[i], s) {
                live = false;
            } catch (bytes memory d) {
                bool ok = _ok(d);
                // Dust shares can round to a zero payout; that is not a lock-in.
                if (
                    !ok
                        && keccak256(d)
                            != keccak256(
                                abi.encodeWithSignature("Error(string)", "BDEX: INSUFFICIENT_LIQUIDITY_BURNED")
                            )
                ) {
                    live =
                        false;
                }
            }
        }
    }

    function exitProbe(address a, uint256 s) external {
        burnShares(a, s);
        revert("PROBE_OK");
    }
}

abstract contract F1CInvariantBase is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    F1Handler internal handler;

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = F1Handler.mintAny.selector;
        sel[1] = F1Handler.mintMax.selector;
        sel[2] = F1Handler.donateAny.selector;
        sel[3] = F1Handler.doSync.selector;
        sel[4] = F1Handler.doSkim.selector;
        sel[5] = F1Handler.burnAny.selector;
        sel[6] = F1Handler.swapAny.selector;
        sel[7] = F1Handler.swapAsSync.selector;
        sel[8] = F1Handler.warp.selector;
        sel[9] = F1Handler.washBurst.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    function invariant_swapAfterSkim() public {
        (bool live,,,) = handler.checkSwapLive();
        require(live, "SWAP broken after skim");
    }

    function invariant_exit() public {
        require(handler.checkExitLive(), "EXIT broken");
    }

    function invariant_bounds() public view {
        (uint256 rw, uint256 rq,,) = handler.bounds();
        require(rw <= 10 ether && rq <= 1_000e6, "reserve above cap");
        require(rw * rq * 10_000 <= uint256(10 ether) * 1_000e6 * 6400, "k above the ceiling");
    }
}

contract F1CInvariantDustOpening is F1CInvariantBase {
    function setUp() public {
        handler = new F1Handler();
        handler.open(1e15, 1e5);
    }
}

contract F1CInvariantSeedOpening is F1CInvariantBase {
    function setUp() public {
        handler = new F1Handler();
        handler.open(5 ether, 500e6);
    }
}

contract F1CInvariantCeilingOpening is F1CInvariantBase {
    function setUp() public {
        handler = new F1Handler();
        handler.open(8 ether, 800e6);
    }
}

