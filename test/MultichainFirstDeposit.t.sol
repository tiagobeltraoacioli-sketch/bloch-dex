// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The multichain package's opening of a pool on a public chain (docs/MULTICHAIN-DEPLOY.md, "Opening a pool").
// Review R309-MC-1 (agent 309, test/review/McFirstDeposit.t.sol on its branch) showed that with open first deposits
// anyone opens the pool with dust at a false price and then takes the native side of the owner's deposit. The
// package's plan now always has a first depositor, creates no pair at deployment, and deposits with minimums equal
// to the amounts. These tests are the reviewer's attack against that configuration: every form of it must fail.
// The token here has 18 decimals; prices: 1 native = 3,000.
import {TestBase, TestToken} from "./TestBase.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

interface OriginVm {
    function startPrank(address sender, address origin) external;
}

contract MultichainFirstDepositTest is TestBase {
    OriginVm constant ovm = OriginVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant FEE_TO = 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544;
    address constant OWNER = address(0xA11CE);
    address constant ATTACKER = address(0xBAD);
    uint256 constant NATIVE = 10 ether;
    uint256 constant TOKEN = 30_000 ether;

    WBLCH wrapped;
    TestToken usdc;
    UniswapV2Factory factory;
    BDexRouter router;

    function setUp() public {
        wrapped = new WBLCH();
        usdc = new TestToken();
        vm.deal(OWNER, 100 ether);
        vm.deal(ATTACKER, 100 ether);
        usdc.mint(OWNER, 100_000 ether);
        usdc.mint(ATTACKER, 10_000 ether);
        // The package's plan: the owner's depositing account is the first depositor, no caps, NO pair created.
        factory = new UniswapV2Factory(FEE_TO, OWNER, new address[](0), new uint256[](0));
        router = new BDexRouter(address(factory), address(wrapped));
    }

    /// The owner's first deposit exactly as scripts/multichain/first-deposit.mjs prints it: minimums = amounts.
    function _ownerOpens() private {
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
    }

    function _reserves(UniswapV2Pair pair) private view returns (uint256 rNative, uint256 rToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rNative, rToken) = pair.token0() == address(wrapped) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// No pair exists after the deployment; the owner's one transaction creates it and opens it at the owner's price.
    function test_theFirstDepositCreatesThePairAndOpensItInOneTransaction() public {
        assertEq(factory.getPair(address(wrapped), address(usdc)), address(0));
        _ownerOpens();
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(wrapped), address(usdc)));
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE);
        assertEq(rToken, TOKEN);
    }

    /// R309-MC-1, the reviewer's attack: the attacker creates the pair (anyone may) and tries to open it with dust
    /// at 1 native = 2 "USDC", directly and through the router. Both revert; the owner then opens at 3,000.
    function test_R309_MC_1_theHostileFirstMintIsRefusedDirectlyAndThroughTheRouter() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        usdc.approve(address(router), 2e12);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        router.addLiquidityBLCH{value: 1e12}(address(usdc), 2e12, 0, 0, ATTACKER, block.timestamp);
        // Naming the owner as the receiver of the shares does not help either: the sender and the origin count.
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(OWNER);
        vm.stopPrank();
        assertEq(pair.totalSupply(), 0);

        // The dust stayed at the pair: it joins the opening pool as a gift (first-deposit.mjs would have the owner
        // skim it first; this is the case where the owner did not).
        _ownerOpens();
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE + 1e12);
        assertEq(rToken, TOKEN + 2e12);

        // The second half of the reviewer's attack: 600 USDC no longer buys the native side of the pool. At the
        // owner's price 600 USDC is worth 0.2 native; the swap pays less than that (fee and price impact).
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(wrapped);
        uint256 before = ATTACKER.balance;
        ovm.startPrank(ATTACKER, ATTACKER);
        usdc.approve(address(router), 600 ether);
        router.swapExactTokensForBLCH(600 ether, 0, path, ATTACKER, block.timestamp);
        vm.stopPrank();
        uint256 taken = ATTACKER.balance - before;
        assertTrue(taken < 0.2 ether);
        assertTrue(taken > 0.19 ether);
    }

    /// A contract the attacker controls cannot stand in for the owner: the origin of the attacker's transaction is
    /// the attacker, and the sender is the contract.
    function test_aMintWhoseOriginIsNotTheOwnerIsRefusedWhoeverTheSenderIs() public {
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        ovm.startPrank(ATTACKER, ATTACKER);
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12);
        vm.stopPrank();
        ovm.startPrank(address(router), ATTACKER);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        vm.stopPrank();
    }

    /// Minimums equal to the amounts are the second, independent protection: on a factory whose first deposits ARE
    /// open (not a plan this package makes) the same deposit reverts instead of pairing 10 native with 20 USDC.
    function test_strictMinimumsAloneTurnTheAttackIntoARevert() public {
        UniswapV2Factory open = new UniswapV2Factory(FEE_TO, address(0), new address[](0), new uint256[](0));
        BDexRouter openRouter = new BDexRouter(address(open), address(wrapped));
        UniswapV2Pair pair = UniswapV2Pair(open.createPair(address(wrapped), address(usdc)));
        ovm.startPrank(ATTACKER, ATTACKER);
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12);
        pair.mint(ATTACKER);
        vm.stopPrank();
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(openRouter), TOKEN);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        openRouter.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
    }

    /// Later pairs: anyone can create a pair for any two tokens on this factory, and nobody but the first depositor
    /// can ever open one. A pair somebody else created stays empty and worthless until the owner deposits.
    function test_laterPairsCanBeCreatedByAnyoneAndOpenedOnlyByTheFirstDepositor() public {
        TestToken other = new TestToken();
        other.mint(ATTACKER, 1_000 ether);
        other.mint(OWNER, 1_000 ether);
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(other), address(usdc)));
        other.transfer(address(pair), 1 ether);
        usdc.transfer(address(pair), 1 ether);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        other.approve(address(router), 1 ether);
        usdc.approve(address(router), 1 ether);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        router.addLiquidity(address(other), address(usdc), 1 ether, 1 ether, 0, 0, ATTACKER, block.timestamp);
        vm.stopPrank();
        // sync cannot turn the donation into reserves of an empty pair, and skim returns it to whoever asks.
        vm.expectRevert(bytes("BDEX: EMPTY_POOL"));
        pair.sync();
        pair.skim(OWNER);
        assertEq(other.balanceOf(address(pair)), 0);
        assertEq(usdc.balanceOf(address(pair)), 0);
        ovm.startPrank(OWNER, OWNER);
        other.approve(address(router), 100 ether);
        usdc.approve(address(router), 300 ether);
        router.addLiquidity(
            address(other), address(usdc), 100 ether, 300 ether, 100 ether, 300 ether, OWNER, block.timestamp
        );
        vm.stopPrank();
        assertTrue(pair.totalSupply() > 0);
    }
}
