// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";

/// The pair against the real launch token, BridgedStablecoinV3 (bridge `codex/bridge-v3-r7-20261102` 9f91a56), in the
/// mainnet shape: T = 0, slots by deposit nonce, 2-of-3 committee with a 3-signature unpause, 3 guardians.
/// The token is compiled in the bridge repo (shanghai, optimizer runs 1), so its creation code comes from the
/// environment: `V3_INITCODE=$(jq -r .bytecode.object BridgedStablecoinV3.json) forge test --match-contract V3Token`.
/// Without it every test here returns at once and says so in the log.
/// The handler mixes pair operations (swaps, deposits, exits, donations, skims, syncs) with every token event the
/// DEX could meet (queued mints to the pair and to users, cancels, remints, executions, drains, pauses, unpauses,
/// burns, time). The invariants are the DEX's own plus the token's provenance chain.
struct Limits {
    uint256 supplyCap;
    uint256 bucketCapacity;
    uint256 refillPerSecond;
    uint256 largeMintThreshold;
    uint256 largeMintDelay;
    uint256 minBurn;
}

struct Guard {
    address[] guardians;
    uint256 pauseDuration;
    uint256 pauseCooldown;
}

struct MintSwitch {
    uint256 threshold;
    uint64 delay;
}

interface IV3 {
    function mintDigest(bytes32, uint64, uint64, address) external view returns (bytes32);
    function remintDigest(bytes32, uint64, uint64, address, bool) external view returns (bytes32);
    function unpauseDigest() external view returns (bytes32);
    function mint(bytes32, uint64, uint64, address, bytes calldata) external;
    function remint(bytes32, uint64, uint64, address, bool, bytes calldata) external;
    function executeMint(bytes32) external;
    function drain() external;
    function voteCancelMint(bytes32, address, uint64, uint64) external;
    function pause() external;
    function unpause(bytes calldata) external;
    function burn(uint64, address) external returns (bytes32);
    function pendingMints(bytes32) external view returns (address, uint64, uint64);
    function mintCancels(bytes32) external view returns (uint64);
    function nextSlot() external view returns (uint64);
    function mintCount() external view returns (uint64);
    function mintedTotal() external view returns (uint64);
    function mintHead() external view returns (bytes32);
    function paused() external view returns (bool);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

struct VmLog {
    bytes32[] topics;
    bytes data;
    address emitter;
}

interface VmX {
    function envOr(string calldata name, bytes calldata defaultValue) external view returns (bytes memory);
    function recordLogs() external;
    function getRecordedLogs() external returns (VmLog[] memory);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function addr(uint256 privateKey) external returns (address);
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}

VmX constant VMX = VmX(address(uint160(uint256(keccak256("hevm cheat code")))));

uint256 constant CAP_W = 10 ether;
uint256 constant CAP_Q = 255e6;
uint64 constant DELAY = 43_200;
address constant SAFE = address(0x5AFE);
address constant SEEDER = address(0x5EED);
address constant LP = address(0x1111);
address constant USER = address(0x2222);
address constant VAULT = address(0xaa);
bytes32 constant ROUTE = bytes32(uint256(0xbb));
bytes32 constant MINT_EXECUTED = keccak256("MintExecuted(bytes32,address,uint64)");
bytes32 constant PROBE_OK = keccak256("PROBE_OK");

struct FuzzSelector {
    address addr;
    bytes4[] selectors;
}

contract Noop {
    function noop() external {}
}

contract V3Handler {
    IV3 public immutable q;
    TestToken public immutable w;
    UniswapV2Pair public immutable pair;
    uint256[3] internal signerKeys;
    address[3] internal guardians;

    bytes32 public ghostHead;
    uint64 public ghostCount;
    uint256 public ghostBurned;
    bytes32[] public ids;
    mapping(bytes32 => uint64) public nonceOf;
    mapping(bytes32 => address) public recipientOf;
    mapping(bytes32 => uint64) public amountOf;
    mapping(string => uint256) public calls;
    bytes public lastRefusal;

    constructor(
        IV3 q_,
        TestToken w_,
        UniswapV2Pair pair_,
        uint256[3] memory keys,
        address[3] memory guardians_,
        bytes32 head
    ) {
        (q, w, pair, signerKeys, guardians, ghostHead) = (q_, w_, pair_, keys, guardians_, head);
    }

    // ---- committee signatures, ascending signer order --------------------
    function sigs(bytes32 digest, uint256 k) public returns (bytes memory out) {
        address[3] memory a;
        uint256[3] memory key = signerKeys;
        for (uint256 i; i < 3; ++i) {
            a[i] = VMX.addr(key[i]);
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (a[j] < a[i]) {
                    (a[i], a[j]) = (a[j], a[i]);
                    (key[i], key[j]) = (key[j], key[i]);
                }
            }
        }
        for (uint256 i; i < k; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = VMX.sign(key[i], digest);
            out = abi.encodePacked(out, r, s, v);
        }
    }

    function _who(uint256 i) internal pure returns (address) {
        return [SEEDER, LP, USER][i % 3];
    }

    function _reserves() internal view returns (uint256 rw, uint256 rq) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rw, rq) = pair.token0() == address(w) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    // ---- credits: every MintExecuted extends the ghost chain --------------
    function _credited() internal {
        VmLog[] memory logs = VMX.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(q) || logs[i].topics.length != 3 || logs[i].topics[0] != MINT_EXECUTED) {
                continue;
            }
            bytes32 key = logs[i].topics[1];
            address recipient = address(uint160(uint256(logs[i].topics[2])));
            uint64 amount = abi.decode(logs[i].data, (uint64));
            ghostHead = keccak256(abi.encode(ghostHead, key, uint256(amount), recipient));
            ++ghostCount;
        }
    }

    // ---- token actions ----------------------------------------------------
    function queueMint(uint256 who, uint256 amount) public {
        address recipient = who % 4 == 3 ? address(pair) : _who(who);
        uint64 amt = uint64(1e6 + amount % 50e6);
        uint64 nonce = q.nextSlot();
        bytes32 id = bytes32((uint256(nonce) << 192) | (uint256(keccak256(abi.encode(nonce, who))) >> 64));
        bytes memory s = sigs(q.mintDigest(id, nonce, amt, recipient), 2);
        try q.mint(id, nonce, amt, recipient, s) {
            ids.push(id);
            (nonceOf[id], recipientOf[id], amountOf[id]) = (nonce, recipient, amt);
            ++calls["queueMint"];
        } catch {}
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    /// Half the picks go to the four newest ids, which are the ones still queued or cancelled.
    function _pick(uint256 i) internal view returns (bytes32) {
        uint256 n = ids.length;
        if (n == 0) return bytes32(0);
        if (i >> 255 == 1) return ids[(i ^ (1 << 255)) % n]; // exact index, for the deterministic scene
        if (i % 2 == 0 && n > 4) return ids[n - 1 - (i / 2) % 4];
        return ids[i % n];
    }

    function cancel(uint256 i, uint256 g) public {
        bytes32 id = _pick(i);
        if (id == 0) return;
        (address r, uint64 a, uint64 t) = q.pendingMints(id);
        if (a == 0) return;
        for (uint256 k; k < 2; ++k) {
            VMX.prank(guardians[(g + k) % 3]);
            try q.voteCancelMint(id, r, a, t) {} catch {}
        }
        (, a,) = q.pendingMints(id);
        if (a == 0) ++calls["cancelled"];
    }

    function remint(uint256 i) public {
        bytes32 id = _pick(i);
        if (id == 0) return;
        bytes memory s = sigs(q.remintDigest(id, nonceOf[id], amountOf[id], recipientOf[id], false), 2);
        try q.remint(id, nonceOf[id], amountOf[id], recipientOf[id], false, s) {
            ++calls["remint"];
        } catch {}
    }

    function execute(uint256 i) public {
        bytes32 id = _pick(i);
        if (id == 0) return;
        VMX.recordLogs();
        try q.executeMint(id) {
            ++calls["execute"];
        } catch {}
        _credited();
    }

    function drain() public {
        VMX.recordLogs();
        try q.drain() {} catch {}
        _credited();
    }

    function pause(uint256 g) public {
        VMX.prank(guardians[g % 3]);
        try q.pause() {
            ++calls["pause"];
        } catch {}
    }

    function unpause() public {
        bytes memory s = sigs(q.unpauseDigest(), 3);
        try q.unpause(s) {
            ++calls["unpause"];
        } catch {}
    }

    function warp(uint256 dt) public {
        VMX.warp(block.timestamp + 1 + dt % 2 days);
    }

    function burnQ(uint256 who, uint256 amount) public {
        address from = _who(who);
        uint256 bal = q.balanceOf(from);
        if (bal < 1e6) return;
        uint64 amt = uint64(1e6 + amount % (bal - 1e6 + 1));
        VMX.prank(from);
        try q.burn(amt, address(0xE7)) {
            ghostBurned += amt;
            ++calls["burn"];
        } catch {}
    }

    // ---- pair actions -----------------------------------------------------
    function doSwap(address from, bool sellW, uint256 amountIn) external {
        require(msg.sender == address(this));
        (uint256 rw, uint256 rq) = _reserves();
        (uint256 rIn, uint256 rOut) = sellW ? (rw, rq) : (rq, rw);
        uint256 out = amountIn * 997 * rOut / (rIn * 1000 + amountIn * 997);
        VMX.prank(from);
        sellW ? w.transfer(address(pair), amountIn) : q.transfer(address(pair), amountIn);
        bool outIs0 = pair.token0() == address(sellW ? address(q) : address(w));
        pair.swap(outIs0 ? out : 0, outIs0 ? 0 : out, from, "");
    }

    function swap(uint256 who, bool sellW, uint256 amount) public {
        address from = _who(who);
        uint256 amountIn = sellW ? 1e12 + amount % (CAP_W / 20) : 1e3 + amount % (CAP_Q / 20);
        if ((sellW ? w.balanceOf(from) : q.balanceOf(from)) < amountIn) return;
        try this.doSwap(from, sellW, amountIn) {
            ++calls["swap"];
        } catch (bytes memory why) {
            ++calls["swapRefused"];
            lastRefusal = why;
        }
    }

    function doDeposit(address from, uint256 aw, uint256 aq) external {
        require(msg.sender == address(this));
        VMX.startPrank(from);
        w.transfer(address(pair), aw);
        q.transfer(address(pair), aq);
        pair.mint(from);
        VMX.stopPrank();
    }

    function deposit(uint256 frac) public {
        (uint256 rw, uint256 rq) = _reserves();
        if (rw == 0) return;
        uint256 aw = CAP_W * (1 + frac % 1000) / 10_000;
        uint256 aq = aw * rq / rw + 1;
        if (w.balanceOf(LP) < aw || q.balanceOf(LP) < aq) return;
        try this.doDeposit(LP, aw, aq) {
            ++calls["deposit"];
        } catch {}
    }

    function doExit(address from, uint256 shares) external {
        require(msg.sender == address(this));
        VMX.startPrank(from);
        pair.transfer(address(pair), shares);
        pair.burn(from);
        VMX.stopPrank();
    }

    function exit(uint256 who, uint256 frac) public {
        address from = who % 2 == 0 ? LP : SEEDER;
        uint256 shares = pair.balanceOf(from) * (1 + frac % 10_000) / 10_000;
        if (shares == 0) return;
        try this.doExit(from, shares) {
            ++calls["exit"];
        } catch {}
    }

    function donate(bool sideW, uint256 amount) public {
        if (sideW) {
            w.mint(address(pair), amount % (CAP_W / 10));
        } else {
            uint256 bal = q.balanceOf(USER);
            if (bal == 0) return;
            VMX.prank(USER);
            q.transfer(address(pair), amount % bal);
        }
        ++calls["donate"];
    }

    function skim() public {
        try pair.skim(SAFE) {
            ++calls["skim"];
        } catch {}
    }

    function sync() public {
        try pair.sync() {
            ++calls["sync"];
        } catch {}
    }
}

contract V3TokenInvariantTest is TestBase {
    event log_string(string);
    event log_named_uint(string, uint256);
    event log_bytes(bytes);

    IV3 internal q;
    TestToken internal w;
    UniswapV2Factory internal factory;
    UniswapV2Pair internal pair;
    V3Handler internal handler;
    bool internal skip;
    address internal noop;

    function _deployV3(uint256[3] memory keys, address[3] memory g) internal returns (IV3 token) {
        bytes memory init = VMX.envOr("V3_INITCODE", bytes(""));
        if (init.length == 0) return IV3(address(0));
        address[] memory signers = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signers[i] = VMX.addr(keys[i]);
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (signers[j] < signers[i]) (signers[i], signers[j]) = (signers[j], signers[i]);
            }
        }
        address[] memory gs = new address[](3);
        (gs[0], gs[1], gs[2]) = (g[0], g[1], g[2]);
        if (gs[1] < gs[0]) (gs[0], gs[1]) = (gs[1], gs[0]);
        if (gs[2] < gs[1]) (gs[1], gs[2]) = (gs[2], gs[1]);
        if (gs[1] < gs[0]) (gs[0], gs[1]) = (gs[1], gs[0]);
        bytes memory code = abi.encodePacked(
            init,
            abi.encode(
                "Bridged USDC",
                "bUSDC",
                uint256(1),
                VAULT,
                ROUTE,
                signers,
                uint256(2),
                Limits(100_000e6, 10_000e6, 115_740, 0, DELAY, 1e6),
                Guard(gs, 259_200, 259_200),
                MintSwitch(3, 1_209_600)
            )
        );
        address a;
        assembly {
            a := create(0, add(code, 32), mload(code))
        }
        require(a != address(0), "V3 creation failed");
        token = IV3(a);
    }

    function setUp() public {
        vm.warp(1_000_000);
        uint256[3] memory keys = [uint256(0xA11CE1), uint256(0xA11CE2), uint256(0xA11CE3)];
        address[3] memory g = [address(0x6001), address(0x6002), address(0x6003)];
        q = _deployV3(keys, g);
        if (address(q) == address(0)) {
            skip = true;
            noop = address(new Noop());
            return;
        }
        w = new TestToken();
        address[] memory tokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (tokens[0], caps[0]) = (address(w), CAP_W);
        (tokens[1], caps[1]) = (address(q), CAP_Q);
        factory = new UniswapV2Factory(SAFE, SEEDER, tokens, caps);
        pair = UniswapV2Pair(factory.createPair(address(w), address(q)));
        bytes32 genesis = keccak256(abi.encode(bytes32("BLOCH-USDT-MINT-CHAIN-v1"), uint256(1), VAULT, ROUTE));
        assertEq(q.mintHead(), genesis);
        handler = new V3Handler(q, w, pair, keys, g, genesis);

        // Fund through the token's own path: three committee mints, the delay, then executions in slot order.
        for (uint256 i; i < 18; ++i) {
            handler.queueMint(i % 3, 49e6);
        }
        vm.warp(block.timestamp + DELAY + 1);
        handler.execute(0);
        for (uint256 i; i < 3; ++i) {
            handler.drain();
        }
        require(q.mintCount() == 18, "funding mints did not credit");
        address[3] memory who = [SEEDER, LP, USER];
        for (uint256 i; i < 3; ++i) {
            w.mint(who[i], 100 ether);
        }
        // Seed at 25.5 bUSDC per BLCH, half of each cap.
        vm.startPrank(SEEDER);
        w.transfer(address(pair), 5 ether);
        q.transfer(address(pair), 127_500_000);
        pair.mint(SEEDER);
        vm.stopPrank();
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = skip ? noop : address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory f) {
        f = new FuzzSelector[](1);
        if (skip) {
            bytes4[] memory one = new bytes4[](1);
            one[0] = Noop.noop.selector;
            f[0] = FuzzSelector(noop, one);
            return f;
        }
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = V3Handler.queueMint.selector;
        sel[1] = V3Handler.cancel.selector;
        sel[2] = V3Handler.remint.selector;
        sel[3] = V3Handler.execute.selector;
        sel[4] = V3Handler.drain.selector;
        sel[5] = V3Handler.pause.selector;
        sel[6] = V3Handler.unpause.selector;
        sel[7] = V3Handler.warp.selector;
        sel[8] = V3Handler.burnQ.selector;
        sel[9] = V3Handler.swap.selector;
        sel[10] = V3Handler.deposit.selector;
        sel[11] = V3Handler.exit.selector;
        sel[12] = V3Handler.donate.selector;
        sel[13] = V3Handler.skim.selector;
        sel[14] = V3Handler.sync.selector;
        f[0] = FuzzSelector(address(handler), sel);
    }

    function _reserves() internal view returns (uint256 rw, uint256 rq) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rw, rq) = pair.token0() == address(w) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _ok(bytes memory data) internal pure returns (bool) {
        if (data.length < 68) return false;
        bytes memory body;
        assembly {
            body := add(data, 4)
        }
        return keccak256(bytes(abi.decode(body, (string)))) == PROBE_OK;
    }

    /// Reserves within the caps, k within 64% of the caps' product, reserves backed by balances.
    function invariant_capsCeilingBacking() public view {
        if (skip) return;
        (uint256 rw, uint256 rq) = _reserves();
        require(rw <= CAP_W && rq <= CAP_Q, "reserve above cap");
        require(rw * rq <= CAP_W * CAP_Q * 64 / 100, "k above ceiling");
        require(w.balanceOf(address(pair)) >= rw && q.balanceOf(address(pair)) >= rq, "reserves not backed");
    }

    /// No pair operation moves the mint chain: the token's head is the chain of its MintExecuted events alone.
    function invariant_mintChainOnlyFromCredits() public view {
        if (skip) return;
        require(q.mintHead() == handler.ghostHead(), "mint chain moved outside a credit");
        require(q.mintCount() == handler.ghostCount(), "mint count moved outside a credit");
        require(
            q.totalSupply() == uint256(q.mintedTotal()) - handler.ghostBurned(), "supply is not credits minus burns"
        );
    }

    function probeExit(address from) external {
        uint256 shares = pair.balanceOf(from);
        vm.startPrank(from);
        pair.transfer(address(pair), shares);
        pair.burn(from);
        vm.stopPrank();
        revert("PROBE_OK");
    }

    function probeSwap(bool sellW) external {
        pair.skim(address(0xDEAD));
        (uint256 rw, uint256 rq) = _reserves();
        uint256 amountIn = sellW ? CAP_W / 1000 : CAP_Q / 1000;
        (uint256 rIn, uint256 rOut) = sellW ? (rw, rq) : (rq, rw);
        uint256 out = amountIn * 997 * rOut / (rIn * 1000 + amountIn * 997);
        if (sellW) {
            w.mint(address(pair), amountIn);
        } else {
            vm.prank(SEEDER);
            q.transfer(address(pair), amountIn);
        }
        bool outIs0 = pair.token0() == address(sellW ? address(q) : address(w));
        pair.swap(outIs0 ? out : 0, outIs0 ? 0 : out, address(0xBEEF), "");
        revert("PROBE_OK");
    }

    /// Whatever the token's state (paused, queued, cancelled, contested slots), every LP can leave in full.
    function invariant_lpCanAlwaysExit() public {
        if (skip) return;
        address[2] memory lps = [SEEDER, LP];
        for (uint256 i; i < 2; ++i) {
            uint256 shares = pair.balanceOf(lps[i]);
            if (shares == 0) continue;
            uint256 ts = pair.totalSupply();
            // Dust that redeems zero of a side reverts INSUFFICIENT_LIQUIDITY_BURNED on any token; not a V3 effect.
            if (shares * w.balanceOf(address(pair)) / ts == 0 || shares * q.balanceOf(address(pair)) / ts == 0) {
                continue;
            }
            try this.probeExit(lps[i]) {
                revert("probe returned");
            } catch (bytes memory data) {
                require(_ok(data), "an LP cannot exit");
            }
        }
    }

    /// After a skim, a swap of 0.1% of a cap passes in at least one direction (the k ceiling leaves room on one side).
    function invariant_swapLiveAfterSkim() public {
        if (skip) return;
        if (pair.totalSupply() == 0 || q.balanceOf(SEEDER) < CAP_Q / 1000) return;
        bool live;
        for (uint256 d; d < 2 && !live; ++d) {
            try this.probeSwap(d == 0) {
                revert("probe returned");
            } catch (bytes memory data) {
                live = _ok(data);
            }
        }
        require(live, "no swap direction is live after a skim");
    }

    function afterInvariant() public {
        if (skip) {
            emit log_string("SKIPPED: V3_INITCODE is not set");
            return;
        }
        string[14] memory names = [
            "queueMint",
            "cancelled",
            "remint",
            "execute",
            "pause",
            "unpause",
            "burn",
            "swap",
            "deposit",
            "exit",
            "donate",
            "skim",
            "sync",
            "x"
        ];
        for (uint256 i; i < 13; ++i) {
            emit log_named_uint(names[i], handler.calls(names[i]));
        }
        emit log_named_uint("mintCount", q.mintCount());
        emit log_named_uint("swapRefused", handler.calls("swapRefused"));
        emit log_bytes(handler.lastRefusal());
    }

    /// The scenes of `rehearse-ops.sh` section 10 as one deterministic path, so a failing invariant has a plain repro.
    function testV3ScenesKeepThePoolWhole() public {
        if (skip) {
            emit log_string("SKIPPED: V3_INITCODE is not set");
            return;
        }
        uint256 toPair = handler.idCount();
        uint256 EXACT = 1 << 255;
        handler.queueMint(3, 3e6); // to the pair
        handler.queueMint(0, 1e6); // to the seeder, behind it
        uint256 n = q.mintCount();
        handler.cancel(EXACT | toPair, 0);
        require(handler.calls("cancelled") == 1, "the guardians did not cancel");
        handler.swap(1, true, 1e17);
        require(handler.calls("swap") == 1, string(handler.lastRefusal()));
        handler.exit(1, 500);
        vm.warp(block.timestamp + DELAY + 1);
        handler.execute(EXACT | (toPair + 1)); // waits behind the cancelled slot
        require(q.mintCount() == n, "a mint credited past a cancelled slot");
        handler.pause(1);
        handler.remint(EXACT | toPair);
        require(handler.calls("remint") == 0, "remint during a pause");
        handler.swap(2, false, 2e6);
        handler.exit(1, 100);
        handler.burnQ(0, 1e6);
        invariant_lpCanAlwaysExit();
        handler.unpause();
        handler.remint(EXACT | toPair);
        vm.warp(block.timestamp + DELAY + 1);
        handler.execute(EXACT | toPair);
        require(q.mintCount() == n + 2, "remint and the mint behind it did not credit");
        handler.skim();
        invariant_capsCeilingBacking();
        invariant_mintChainOnlyFromCredits();
        invariant_lpCanAlwaysExit();
        invariant_swapLiveAfterSkim();
    }
}
