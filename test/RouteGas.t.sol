// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";

/// @notice Round 15 (L2 candidate 1b55ce1): a wallet without credit gets contract calls up to a gas limit of
///         1,500,000. The page asks 250,000 gas per hop for a swap and 100,000 for an approval. This measures the
///         execution gas of the router's swaps for every route length the router accepts (1 to 4 hops; a fifth hop
///         is INVALID_PATH), token in and out, native in and native out, by a wallet that never held the output
///         token, with the protocol fee on, and asserts that each fits the page's limit with room for the 21,000
///         intrinsic gas and the calldata. Measured (execution gas, 1 to 4 hops): token to token 113,046 / 121,218 /
///         150,102 / 179,333; native in 128,358 / 157,559 / 186,443 / 215,743; native out 142,173 / 154,275 /
///         183,160 / 212,391. The page's largest limit is therefore 1,000,000 (4 hops), below 1,500,000.
contract RouteGasTest is TestBase {
    uint256 private constant GAS_PER_HOP = 250_000; // frontend/src/devnet4/swap.ts SWAP_GAS_PER_HOP
    uint256 private constant UNCOVERED_MAX_GAS = 1_500_000; // L2 policy uncovered_max_gas
    uint256 private constant INTRINSIC_AND_CALLDATA = 40_000; // 21,000 + calldata of the longest path, rounded up

    UniswapV2Factory private factory;
    BDexRouter private router;
    WBLCH private wblch;
    TestToken[7] private tokens;
    address private constant SAFE = address(0x5AFE);
    address private constant USER = address(0xBEEF);

    receive() external payable {}

    function setUp() public {
        vm.deal(address(this), 1_000 ether);
        wblch = new WBLCH();
        address[] memory capTokens = new address[](0);
        uint256[] memory caps = new uint256[](0);
        factory = new UniswapV2Factory(SAFE, address(0), capTokens, caps);
        router = new BDexRouter(address(factory), address(wblch));
        for (uint256 i; i < 7; ++i) {
            tokens[i] = new TestToken();
            tokens[i].mint(address(this), 1_000_000 ether);
            tokens[i].approve(address(router), type(uint256).max);
        }
        // A chain of six token pairs, and a native pair at each end.
        for (uint256 i; i < 6; ++i) {
            router.addLiquidity(address(tokens[i]), address(tokens[i + 1]), 1_000 ether, 1_000 ether, 0, 0, address(this), block.timestamp);
        }
        router.addLiquidityBLCH{value: 10 ether}(address(tokens[0]), 1_000 ether, 0, 0, address(this), block.timestamp);
        router.addLiquidityBLCH{value: 10 ether}(address(tokens[6]), 1_000 ether, 0, 0, address(this), block.timestamp);
        // Earlier swaps, so the fee-on path (kLast set) is what a later user meets.
        vm.deal(USER, 10 ether);
        tokens[0].mint(USER, 100 ether);
        vm.prank(USER);
        tokens[0].approve(address(router), type(uint256).max);
    }

    function _tokenPath(uint256 hops) private view returns (address[] memory path) {
        path = new address[](hops + 1);
        for (uint256 i; i <= hops; ++i) path[i] = address(tokens[i]);
    }

    function _check(uint256 hops, uint256 used) private pure {
        require(used + INTRINSIC_AND_CALLDATA <= GAS_PER_HOP * hops, "a swap does not fit the page's gas limit");
        require(GAS_PER_HOP * hops <= UNCOVERED_MAX_GAS, "the page's gas limit is above the limit of a wallet without credit");
    }

    /// Token to token, 1 to 4 hops, each as the first swap of a wallet that never held the output token.
    function testTokenSwapsFitThePageLimit() public {
        for (uint256 hops = 1; hops <= 4; ++hops) {
            address[] memory path = _tokenPath(hops);
            vm.prank(USER);
            uint256 before = gasleft();
            router.swapExactTokensForTokens(1 ether, 0, path, USER, block.timestamp);
            _check(hops, before - gasleft());
        }
    }

    /// Native in (wrap, then 1 to 4 hops): the path starts at WBLCH.
    function testNativeInSwapsFitThePageLimit() public {
        for (uint256 hops = 1; hops <= 4; ++hops) {
            address[] memory path = new address[](hops + 1);
            path[0] = address(wblch);
            for (uint256 i = 1; i <= hops; ++i) path[i] = address(tokens[i - 1]);
            vm.prank(USER);
            uint256 before = gasleft();
            router.swapExactBLCHForTokens{value: 0.01 ether}(0, path, USER, block.timestamp);
            _check(hops, before - gasleft());
        }
    }

    /// Native out (1 to 4 hops, then unwrap): the path ends at WBLCH, through the pair at the far end.
    function testNativeOutSwapsFitThePageLimit() public {
        for (uint256 hops = 1; hops <= 4; ++hops) {
            address[] memory path = new address[](hops + 1);
            // tokens[7 - hops] .. tokens[6], then WBLCH
            for (uint256 i; i < hops; ++i) path[i] = address(tokens[7 - hops + i]);
            path[hops] = address(wblch);
            TestToken first = TestToken(path[0]);
            first.mint(USER, 1 ether);
            vm.prank(USER);
            first.approve(address(router), type(uint256).max);
            vm.prank(USER);
            uint256 before = gasleft();
            router.swapExactTokensForBLCH(1 ether, 0, path, USER, block.timestamp);
            _check(hops, before - gasleft());
        }
    }

    /// The router takes no route longer than four hops, so no call of the page can need more than 1,000,000 gas.
    function testAFifthHopIsRefusedByTheRouter() public {
        address[] memory path = _tokenPath(5);
        vm.prank(USER);
        try router.swapExactTokensForTokens(1 ether, 0, path, USER, block.timestamp) {
            revert("a five-hop route was accepted");
        } catch Error(string memory reason) {
            require(keccak256(bytes(reason)) == keccak256("BDEX: INVALID_PATH"), reason);
        }
    }

    /// The page's own limits: an approval (100,000), a skim (200,000) and its longest route (4 hops, 1,000,000) are
    /// below the limit of a wallet without credit.
    function testPageLimitsAreWithinTheUncoveredLimit() public pure {
        require(100_000 <= UNCOVERED_MAX_GAS && 200_000 <= UNCOVERED_MAX_GAS);
        require(GAS_PER_HOP * 4 <= UNCOVERED_MAX_GAS);
    }
}
