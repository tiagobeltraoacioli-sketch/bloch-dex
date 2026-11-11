// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {V3Fixture} from "./V3Interaction.t.sol";

/// @notice Agent 180: bridge V3 actions (queue, execute, guardian cancel, remint, pause, burn, misdirected
///         deposits to the pair) interleaved with every DEX action on the mainnet caps.
contract V3DexHandler is V3Fixture {
    bytes32[] public keys;
    mapping(bytes32 => uint64) public nonceOf;
    mapping(bytes32 => uint64) public amountOf;
    mapping(bytes32 => address) public recipientOf;
    bool public exitFailed;
    bool public liveFailed;
    uint256 public cancels;
    uint256 public reminted;
    uint256 public credited;
    uint256 public swaps;

    constructor() payable {
        setUp();
        _seed(500e6, 5 ether);
        busdc.approve(address(router), type(uint256).max);
    }

    function queue(bool toPair, uint64 seed) external {
        uint64 amount = 10e6 + seed % 290e6;
        if (amount > busdc.availableToMint()) return;
        if (busdc.totalSupply() + busdc.pendingSupply() + amount > busdc.supplyCap() || busdc.paused()) return;
        address to = toPair ? address(pair) : address(this);
        bytes32 key = _queue(busdc, amount, to);
        keys.push(key);
        nonceOf[key] = nextNonce - 1;
        amountOf[key] = amount;
        recipientOf[key] = to;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + secs % 2 days);
    }

    function execute(uint256 i) external {
        if (keys.length == 0) return;
        bytes32 key = keys[i % keys.length];
        (, uint64 amount, uint64 readyAt) = busdc.pendingMints(key);
        if (amount == 0 || busdc.paused() || block.timestamp < readyAt || !busdc.isCreditHead(key)) return;
        uint256 before = busdc.mintCount();
        busdc.executeMint(key);
        credited += busdc.mintCount() - before;
    }

    function drain() external {
        uint256 before = busdc.mintCount();
        busdc.drain();
        credited += busdc.mintCount() - before;
    }

    function cancel(uint256 i) external {
        if (keys.length == 0) return;
        bytes32 key = keys[i % keys.length];
        (address r, uint64 amount, uint64 readyAt) = busdc.pendingMints(key);
        if (amount == 0 || busdc.uncancellable(key)) return;
        vm.prank(guardianSet[0]);
        busdc.voteCancelMint(key, r, amount, readyAt);
        vm.prank(guardianSet[1]);
        busdc.voteCancelMint(key, r, amount, readyAt);
        ++cancels;
    }

    function remint(uint256 i) external {
        if (keys.length == 0 || busdc.paused()) return;
        bytes32 key = keys[i % keys.length];
        if (busdc.mintCancels(key) == busdc.lastRemint(key)) return;
        uint64 amount = amountOf[key];
        if (amount > busdc.availableToMint()) return;
        if (busdc.totalSupply() + busdc.pendingSupply() + amount > busdc.supplyCap()) return;
        _remint(key, amount);
        ++reminted;
    }

    function _remint(bytes32 key, uint64 amount) private {
        uint64 nonce = nonceOf[key];
        address to = recipientOf[key];
        bytes memory sigs = _sign(busdc.remintDigest(key, nonce, amount, to, false), 5);
        busdc.remint(key, nonce, amount, to, false, sigs);
    }

    function pause(uint8 g) external {
        address guardian = guardianSet[g % 3];
        if (!busdc.guardianCanPause(guardian)) return;
        vm.prank(guardian);
        busdc.pause();
    }

    function sellUsdc(uint64 seed) external {
        uint256 amount = 1e6 + seed % 200e6;
        if (busdc.balanceOf(address(this)) < amount) return;
        try router.swapExactTokensForBLCH(amount, 0, _path(address(busdc), address(wblch)), address(this), block.timestamp) {
            ++swaps;
        } catch Error(string memory reason) {
            _expectCapRefusal(reason);
        }
    }

    function buyUsdc(uint64 seed) external {
        uint256 value = 0.001 ether + seed % 2 ether;
        if (address(this).balance < value) return;
        try router.swapExactBLCHForTokens{value: value}(0, _path(address(wblch), address(busdc)), address(this), block.timestamp) {
            ++swaps;
        } catch Error(string memory reason) {
            _expectCapRefusal(reason);
        }
    }

    function addLiquidity(uint64 seed) external {
        uint256 amount = 1e6 + seed % 100e6;
        if (busdc.balanceOf(address(this)) < amount || address(this).balance < 2 ether) return;
        try router.addLiquidityBLCH{value: 1 ether}(address(busdc), amount, 0, 0, address(this), block.timestamp) {}
        catch Error(string memory reason) {
            _expectCapRefusal(reason);
        }
    }

    function removeLiquidity(uint16 bps) external {
        uint256 lp = pair.balanceOf(address(this));
        uint256 part = lp * (100 + bps % 9_900) / 10_000;
        if (part < 1e6) return;
        // A share worth less than one base unit of a token cannot be burned (INSUFFICIENT_LIQUIDITY_BURNED, as in
        // Uniswap v2): after a pool is drained to dust that is a rounding refusal, not a blocked exit, and the
        // holder's whole position still exits (test_dustShareIsRefusedByRoundingAndTheWholePositionExits). The
        // margin of 2 covers the protocol-fee shares minted inside burn. Found by the deep run, round 15.
        if (_dust(part)) return;
        try router.removeLiquidityBLCH(address(busdc), part, 0, 0, address(this), block.timestamp) {}
        catch {
            exitFailed = true;
        }
    }

    function skim() external {
        pair.skim(SAFE);
    }

    function _dust(uint256 part) private view returns (bool) {
        uint256 supply = pair.totalSupply();
        return part * busdc.balanceOf(address(pair)) / supply < 2 || part * wblch.balanceOf(address(pair)) / supply < 2;
    }

    /// Not a fuzz target. Burns `part` LP shares directly: (true, "") or (false, reason).
    function burnShares(uint256 part) external returns (bool ok, string memory reason) {
        try router.removeLiquidityBLCH(address(busdc), part, 0, 0, address(this), block.timestamp) {
            return (true, "");
        } catch Error(string memory why) {
            return (false, why);
        }
    }

    function position() external view returns (uint256 lp, uint256 supply, bool dustAtOnePercent) {
        lp = pair.balanceOf(address(this));
        return (lp, pair.totalSupply(), _dust(lp * 127 / 10_000));
    }

    function bridgeExit(uint64 seed) external {
        uint256 bal = busdc.balanceOf(address(this));
        uint64 amount = uint64(10e6 + seed % 100e6);
        if (bal < amount) return;
        busdc.burn(amount, ETH_RECIPIENT);
    }

    function _expectCapRefusal(string memory reason) private {
        bytes32 h = keccak256(bytes(reason));
        if (
            h != keccak256("BDEX: RESERVE_CAP") && h != keccak256("BDEX: K_CEILING")
                && h != keccak256("BDEX: INSUFFICIENT_LIQUIDITY_MINTED") && h != keccak256("BDEX: INSUFFICIENT_A_AMOUNT")
                && h != keccak256("BDEX: INSUFFICIENT_B_AMOUNT") && h != keccak256("BDEX: INSUFFICIENT_OUTPUT_AMOUNT")
        ) liveFailed = true;
    }

    function reserves() external view returns (uint256 rW, uint256 rU) {
        return _reserves();
    }

    function balances() external view returns (uint256 bW, uint256 bU) {
        return (wblch.balanceOf(address(pair)), busdc.balanceOf(address(pair)));
    }
}

contract V3DexInvariantTest is TestBase {
    V3DexHandler internal handler;
    address[] private targets;

    function setUp() public {
        vm.deal(address(this), 1_000 ether);
        handler = new V3DexHandler{value: 500 ether}();
        targets.push(address(handler));
    }

    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    function targetSelectors() external view returns (FuzzSelector[] memory out) {
        bytes4[] memory s = new bytes4[](13);
        s[0] = V3DexHandler.queue.selector;
        s[1] = V3DexHandler.warp.selector;
        s[2] = V3DexHandler.execute.selector;
        s[3] = V3DexHandler.drain.selector;
        s[4] = V3DexHandler.cancel.selector;
        s[5] = V3DexHandler.remint.selector;
        s[6] = V3DexHandler.pause.selector;
        s[7] = V3DexHandler.sellUsdc.selector;
        s[8] = V3DexHandler.buyUsdc.selector;
        s[9] = V3DexHandler.addLiquidity.selector;
        s[10] = V3DexHandler.removeLiquidity.selector;
        s[11] = V3DexHandler.skim.selector;
        s[12] = V3DexHandler.bridgeExit.selector;
        out = new FuzzSelector[](1);
        out[0] = FuzzSelector(address(handler), s);
    }

    /// Bridge actions never take tokens out of the pair: balances stay at or above reserves, so skim and the
    /// pro-rata exit never underflow, and reserves stay under the caps.
    function invariantBridgeActionsNeverUnderfundThePair() public view {
        (uint256 rW, uint256 rU) = handler.reserves();
        (uint256 bW, uint256 bU) = handler.balances();
        assertTrue(bW >= rW && bU >= rU);
        assertTrue(rW <= 10 ether && rU <= 1_000e6);
    }

    /// Whatever the bridge does (pause, cancel, credit order stall), LPs always exit and swaps fail only on caps.
    function invariantExitsAndSwapsStayLive() public view {
        assertTrue(!handler.exitFailed());
        assertTrue(!handler.liveFailed());
    }

    /// The counterexample of the deep run (256 x 500, seeds 1 and 2), pinned: seven partial exits and one buy leave
    /// 54 base units of bUSDC in the pair. A 1.27% share is then worth less than one unit and its burn is refused
    /// by rounding; that is not recorded as a blocked exit, and the whole position exits.
    function test_dustShareIsRefusedByRoundingAndTheWholePositionExits() public {
        uint16[7] memory exits = [uint16(3805), 27764, 9666, 3022, 14772, 7453, 4917];
        for (uint256 i; i < exits.length; ++i) handler.removeLiquidity(exits[i]);
        handler.buyUsdc(636781901530053600);
        (, uint256 rU) = handler.reserves();
        require(rU == 54, "fixture: bUSDC reserve");
        (uint256 lp,, bool dust) = handler.position();
        require(dust, "fixture: dust share");
        handler.removeLiquidity(27);
        invariantExitsAndSwapsStayLive();
        (bool ok, string memory reason) = handler.burnShares(lp * 127 / 10_000);
        require(!ok && keccak256(bytes(reason)) == keccak256("BDEX: INSUFFICIENT_LIQUIDITY_BURNED"), "dust burn");
        (ok,) = handler.burnShares(lp);
        require(ok, "the whole position must exit");
        (lp,,) = handler.position();
        require(lp == 0, "position left");
    }

    /// Coverage control: a fixed pseudo-random walk of 600 handler calls reaches credits, cancels, remints and
    /// swaps, and both invariants hold after every step.
    function test_walkExercisesBridgeAndDexActions() public {
        uint256 r = 0xA180;
        for (uint256 i; i < 600; ++i) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 op = r % 13;
            uint64 a = uint64(r >> 64);
            if (op == 0 || op == 12) handler.queue(r & 1 == 0 && (r >> 8) % 5 == 0, a);
            else if (op == 1) handler.warp(uint32(r >> 32));
            else if (op == 2) handler.execute(r >> 16);
            else if (op == 3) handler.drain();
            else if (op == 4 && (r >> 9) % 3 == 0) handler.cancel(r >> 16);
            else if (op == 5) handler.remint(r >> 16);
            else if (op == 6 && (r >> 9) % 4 == 0) handler.pause(uint8(r >> 24));
            else if (op == 7) handler.sellUsdc(a);
            else if (op == 8) handler.buyUsdc(a);
            else if (op == 9) handler.addLiquidity(a);
            else if (op == 10) handler.removeLiquidity(uint16(r >> 40));
            else if (op == 11) handler.skim();
            else handler.bridgeExit(a);
            invariantBridgeActionsNeverUnderfundThePair();
            invariantExitsAndSwapsStayLive();
        }
        require(handler.credited() > 3 && handler.cancels() > 0 && handler.reminted() > 0 && handler.swaps() > 10, "coverage");
    }
}
