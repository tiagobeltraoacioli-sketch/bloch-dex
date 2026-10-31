// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";
import {Math} from "../contracts/libraries/Math.sol";

/// Stateful handler for a capped pair with the protocol fee on. Every action
/// that may legitimately fail is wrapped; only the documented revert reasons
/// are accepted, and anything else is recorded as a violation.
contract CappedFeeHandler {
    uint256 public constant CAP0 = 1_000 ether;
    uint256 public constant CAP1 = 5_000 ether;
    address public constant FEE_TO = address(0xFEE5AFE);

    UniswapV2Pair public immutable pair;
    TestToken public immutable token0;
    TestToken public immutable token1;

    bool public kHeld = true;
    bool public feeHeld = true;
    bool public kLastHeld = true;
    bool public exitsOpen = true;
    bool public onlyExpectedReverts = true;
    string public lastUnexpected;

    uint256 public swaps;
    uint256 public adds;
    uint256 public removes;
    uint256 public donations;
    uint256 public syncs;
    uint256 public skims;
    uint256 public flashes;
    uint256 public capRefusals;

    constructor() {
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        (TestToken lo, TestToken hi) = address(a) < address(b) ? (a, b) : (b, a);
        address[] memory capTokens = new address[](2);
        uint256[] memory caps = new uint256[](2);
        (capTokens[0], caps[0], capTokens[1], caps[1]) = (address(lo), CAP0, address(hi), CAP1);
        UniswapV2Factory factory = new UniswapV2Factory(FEE_TO, capTokens, caps);
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        token0 = TestToken(pair.token0());
        token1 = TestToken(pair.token1());
        token0.mint(address(pair), 400 ether);
        token1.mint(address(pair), 1_600 ether);
        pair.mint(address(this));
    }

    function _reason(bytes memory data) internal pure returns (string memory) {
        if (data.length < 68) return "";
        assembly {
            data := add(data, 4)
        }
        return abi.decode(data, (string));
    }

    function _expect(bytes memory data, string memory allowed) internal returns (bool) {
        string memory reason = _reason(data);
        if (keccak256(bytes(reason)) == keccak256(bytes(allowed))) {
            if (keccak256(bytes(allowed)) == keccak256("BDEX: RESERVE_CAP")) ++capRefusals;
            return true;
        }
        onlyExpectedReverts = false;
        lastUnexpected = reason;
        return false;
    }

    /// Mint and sync may also refuse at the k ceiling (F1). Swaps may not.
    function _expectCeiling(bytes memory data) internal {
        if (keccak256(bytes(_reason(data))) == keccak256("BDEX: K_CEILING")) ++capRefusals;
        else _expect(data, "BDEX: RESERVE_CAP");
    }

    function _expectedFee() internal view returns (uint256) {
        uint256 kl = pair.kLast();
        if (kl == 0) return 0;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rootK = Math.sqrt(uint256(r0) * r1);
        uint256 rootKLast = Math.sqrt(kl);
        if (rootK <= rootKLast) return 0;
        return pair.totalSupply() * (rootK - rootKLast) / (rootK * 5 + rootKLast);
    }

    function _afterLiquidityEvent(uint256 feeBefore, uint256 expected) internal {
        if (pair.balanceOf(FEE_TO) - feeBefore != expected) feeHeld = false;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (pair.kLast() != uint256(r0) * r1) kLastHeld = false;
    }

    function swap(bool zeroForOne, uint96 seed) external {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amount = uint256(seed) % 50 ether + 1e6;
        uint256 out = BDexLibrary.getAmountOut(amount, zeroForOne ? r0 : r1, zeroForOne ? r1 : r0);
        if (out == 0) return;
        (zeroForOne ? token0 : token1).mint(address(pair), amount);
        try pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(0xD0), "") {
            (uint112 n0, uint112 n1,) = pair.getReserves();
            if (uint256(n0) * (uint256(n1) + 1) * 2 < uint256(r0) * r1 * 2 - uint256(n0)) kHeld = false; // floor at the ceiling
            ++swaps;
        } catch (bytes memory data) {
            _expect(data, "BDEX: RESERVE_CAP");
            pair.skim(address(0xD0));
        }
    }

    function flash(bool borrow0, uint96 seed) external {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 out = uint256(seed) % ((borrow0 ? r0 : r1) / 10) + 1;
        uint256 repay = BDexLibrary.getAmountIn(out, borrow0 ? r1 : r0, borrow0 ? r0 : r1);
        (borrow0 ? token1 : token0).mint(address(this), repay);
        pendingRepayToken = borrow0 ? token1 : token0;
        pendingRepay = repay;
        try pair.swap(borrow0 ? out : 0, borrow0 ? 0 : out, address(this), hex"01") {
            (uint112 n0, uint112 n1,) = pair.getReserves();
            if (uint256(n0) * (uint256(n1) + 1) * 2 < uint256(r0) * r1 * 2 - uint256(n0)) kHeld = false; // floor at the ceiling
            ++flashes;
        } catch (bytes memory data) {
            _expect(data, "BDEX: RESERVE_CAP");
        }
        pendingRepay = 0;
    }

    TestToken private pendingRepayToken;
    uint256 private pendingRepay;

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        require(msg.sender == address(pair));
        // Reentry from the callback must hit the latch.
        try pair.sync() {
            onlyExpectedReverts = false;
            lastUnexpected = "callback reentry succeeded";
        } catch (bytes memory data) {
            _expect(data, "BDEX: LOCKED");
        }
        pendingRepayToken.transfer(address(pair), pendingRepay);
    }

    function add(uint96 seed) external {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 amount0 = uint256(seed) % 200 ether + 1e6;
        uint256 amount1 = amount0 * r1 / r0 + 1;
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        uint256 feeBefore = pair.balanceOf(FEE_TO);
        uint256 expected = _expectedFee();
        try pair.mint(address(this)) {
            _afterLiquidityEvent(feeBefore, expected);
            ++adds;
        } catch (bytes memory data) {
            _expectCeiling(data);
            pair.skim(address(0xD0));
        }
    }

    function remove(uint96 seed) external {
        uint256 held = pair.balanceOf(address(this));
        if (held < 2) return;
        uint256 shares = uint256(seed) % (held / 2) + 1;
        uint256 supply = pair.totalSupply() + _expectedFee();
        if (shares * token0.balanceOf(address(pair)) < supply || shares * token1.balanceOf(address(pair)) < supply) {
            return;
        }
        uint256 feeBefore = pair.balanceOf(FEE_TO);
        uint256 expected = _expectedFee();
        require(pair.transfer(address(pair), shares));
        try pair.burn(address(this)) {
            _afterLiquidityEvent(feeBefore, expected);
            ++removes;
        } catch (bytes memory data) {
            exitsOpen = false;
            lastUnexpected = _reason(data);
        }
    }

    /// A standing donation, possibly above the cap, left in place for later
    /// actions to run against.
    function donate(bool side0, uint96 seed) external {
        uint256 amount = uint256(seed) % 600 ether + 1;
        (side0 ? token0 : token1).mint(address(pair), amount);
        ++donations;
    }

    function sync() external {
        try pair.sync() {
            ++syncs;
        } catch (bytes memory data) {
            _expectCeiling(data);
        }
    }

    function skim() external {
        pair.skim(address(0xD0));
        ++skims;
    }
}

contract DexAuditInvariantTest is TestBase {
    CappedFeeHandler internal handler;
    address[] private targets;

    function setUp() public {
        handler = new CappedFeeHandler();
        targets.push(address(handler));
    }

    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    /// Only the actions; the flash callback is reached through flash().
    function targetSelectors() external view returns (FuzzSelector[] memory out) {
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = CappedFeeHandler.swap.selector;
        selectors[1] = CappedFeeHandler.flash.selector;
        selectors[2] = CappedFeeHandler.add.selector;
        selectors[3] = CappedFeeHandler.remove.selector;
        selectors[4] = CappedFeeHandler.donate.selector;
        selectors[5] = CappedFeeHandler.sync.selector;
        selectors[6] = CappedFeeHandler.skim.selector;
        out = new FuzzSelector[](1);
        out[0] = FuzzSelector(address(handler), selectors);
    }

    /// F1: both reserves can never sit at their caps, by any path, including
    /// fee growth and donations.
    function invariantKNeverExceedsCeiling() public view {
        UniswapV2Pair p = handler.pair();
        (uint112 r0, uint112 r1,) = p.getReserves();
        (uint112 c0, uint112 c1) = p.reserveCaps();
        assertTrue(uint256(r0) * r1 <= uint256(c0) * c1 * 64 / 100);
    }

    function invariantReservesNeverExceedCaps() public view {
        (uint112 r0, uint112 r1,) = handler.pair().getReserves();
        assertTrue(r0 <= handler.CAP0() && r1 <= handler.CAP1());
    }

    function invariantReservesAreBackedByBalances() public view {
        UniswapV2Pair pair = handler.pair();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertTrue(r0 <= handler.token0().balanceOf(address(pair)));
        assertTrue(r1 <= handler.token1().balanceOf(address(pair)));
    }

    function invariantShareAccountingIsClosed() public view {
        UniswapV2Pair pair = handler.pair();
        assertEq(
            pair.totalSupply(),
            pair.balanceOf(address(handler)) + pair.balanceOf(handler.FEE_TO()) + pair.balanceOf(address(0))
                + pair.balanceOf(address(pair))
        );
        assertEq(pair.balanceOf(address(0)), 1000);
        assertEq(pair.balanceOf(address(pair)), 0);
    }

    function invariantSwapsNeverReduceK() public view {
        assertTrue(handler.kHeld());
    }

    function invariantProtocolFeeMatchesMintFee() public view {
        assertTrue(handler.feeHeld());
        assertTrue(handler.kLastHeld());
    }

    function invariantExitsAreNeverBlocked() public view {
        assertTrue(handler.exitsOpen());
    }

    function invariantOnlyDocumentedReverts() public view {
        assertTrue(handler.onlyExpectedReverts());
    }

    function invariantCapsAndFeeRecipientAreConstant() public view {
        (uint112 c0, uint112 c1) = handler.pair().reserveCaps();
        assertEq(c0, handler.CAP0());
        assertEq(c1, handler.CAP1());
        assertEq(UniswapV2Factory(handler.pair().factory()).feeTo(), handler.FEE_TO());
    }
}
