// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The multichain package's opening of a pool on a public chain (docs/MULTICHAIN-DEPLOY.md, "Opening a pool").
// Review R309-MC-1 (agent 309, test/review/McFirstDeposit.t.sol on its branch) showed that with open first deposits
// anyone opens the pool with dust at a false price and then takes the native side of the owner's deposit. The
// package's plan now always has a first depositor, creates no pair at deployment, and deposits with minimums equal
// to the amounts. These tests are the reviewer's attack against that configuration: every form of it must fail.
// Review R328-1 to R328-3 (agent 328, test/review/R328FirstDeposit.t.sol on its branch) then attacked that
// configuration: the frozen pair accepts a first mint by transaction ORIGIN, so a contract the depositing account
// calls can open the pool; and tokens sent to the pair's address in front of the deposit join the opening pool.
// The contracts cannot change. The last tests state those facts and what the package's tools rely on to refuse
// their consequences (scripts/multichain/opening.mjs, first-deposit.mjs, gate.mjs; the kit tests and the fork
// rehearsal exercise the tools themselves).
// The token here has 18 decimals; prices: 1 native = 3,000.
import {TestBase, TestToken} from "./TestBase.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {OriginOpener} from "./mocks/OriginOpener.sol";

interface OriginVm {
    function startPrank(address sender, address origin) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
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

    // ------------------------------------------------------------------ review R328-1: the origin rule

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);

    /// R328-1, the fact: one transaction of the depositing account to a contract of the attacker opens the planned
    /// pool at the attacker's price (1 native = 2). The contracts are frozen, so this cannot be prevented on-chain.
    /// What the package relies on afterwards, shown here at the contract level:
    ///   - a first deposit as `prepare` prints it (minimums = amounts) reverts on that pool;
    ///   - the hostile opening is a transaction whose target is NOT the router (the gate and `verify` prove an
    ///     opening only from a transaction of the depositor sent straight to the router: opening.mjs);
    ///   - `add` refuses a pool whose price is not the owner's stated amounts (here 10 native would be paired with
    ///     20 tokens instead of 30,000: first-deposit.mjs addTransactions).
    function test_R328_1_aContractCalledByTheDepositorOpensThePool_andTheStrictDepositReverts() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        OriginOpener hostile = new OriginOpener(address(factory), address(wrapped), address(usdc));
        payable(address(hostile)).transfer(1e12);
        usdc.transfer(address(hostile), 2e12);
        vm.stopPrank();

        // Not by the attacker's own transaction, even through that contract: the origin is the attacker.
        ovm.startPrank(ATTACKER, ATTACKER);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        hostile.claim();
        vm.stopPrank();

        // By the depositing account's transaction: accepted. The sender of the mint is the hostile contract.
        ovm.startPrank(OWNER, OWNER);
        hostile.claim();
        vm.stopPrank();
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(wrapped), address(usdc)));
        assertTrue(pair.totalSupply() > 0);
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, 1e12);
        assertEq(rToken, 2e12);
        assertTrue(pair.balanceOf(ATTACKER) > 0);

        // The owner's first deposit as printed cannot go in at that price: it reverts.
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();

        // What `add` would have paired with 10 native at this pool's price: 20 tokens, 1,500 times away from the
        // owner's 30,000. The tool refuses anything more than 1% away.
        assertEq(NATIVE * rToken / rNative, 20 ether);
    }

    /// The proof the gate and `verify` ask for: the owner's opening emits, from the pair, the lock of the minimum
    /// liquidity (Transfer from the zero address to the zero address of 1,000 units: only a pair's first mint
    /// does) and one Mint whose sender is the router. A later deposit emits no such lock.
    function test_theOwnersOpeningLocksTheMinimumLiquidityOnce_withTheRouterAsTheMintSender() public {
        address pair = factory.createPair(address(wrapped), address(usdc));
        (uint256 a0, uint256 a1) = UniswapV2Pair(pair).token0() == address(wrapped) ? (NATIVE, TOKEN) : (TOKEN, NATIVE);
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        ovm.expectEmit(true, true, false, true, pair);
        emit Transfer(address(0), address(0), 1000);
        ovm.expectEmit(true, false, false, true, pair);
        emit Mint(address(router), a0, a1);
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
        assertEq(UniswapV2Pair(pair).balanceOf(address(0)), 1000);

        // A second deposit: nothing more is locked.
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), 3_000 ether);
        router.addLiquidityBLCH{value: 1 ether}(address(usdc), 3_000 ether, 0, 0, OWNER, block.timestamp);
        vm.stopPrank();
        assertEq(UniswapV2Pair(pair).balanceOf(address(0)), 1000);
    }

    // ------------------------------------------------------------------ review R328-2, R328-3: a donation

    /// R328-2, the fact: tokens sent to the pair's address in front of the owner's deposit join the opening pool;
    /// minimums equal to the amounts do not see them. The pool opens with the deposit PLUS the donation, the Mint
    /// log says so, the owner's shares own all of it, and the donor has lost it: after the market trades the pool
    /// back to 3,000 the owner's position is worth more than what the owner put in.
    function test_R328_2_aDonationInFrontOfTheDepositJoinsThePool_asAGiftToTheOwner() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        usdc.transfer(address(pair), 300 ether); // 1% of one side
        vm.stopPrank();
        _ownerOpens(); // does not revert
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE);
        assertEq(rToken, TOKEN + 300 ether);
        // The owner holds every share but the locked minimum: the donation is the owner's.
        assertEq(pair.balanceOf(OWNER), pair.totalSupply() - 1000);

        // Arbitrage back to 1 native = 3,000: someone sells native for the cheap tokens until the price is right.
        address[] memory path = new address[](2);
        path[0] = address(wrapped);
        path[1] = address(usdc);
        ovm.startPrank(ATTACKER, ATTACKER);
        router.swapExactBLCHForTokens{value: 0.0498 ether}(0, path, ATTACKER, block.timestamp);
        vm.stopPrank();
        (rNative, rToken) = _reserves(pair);
        // Worth of the pool at the market price, in tokens, against the owner's deposit worth 60,000.
        uint256 worth = rNative * 3_000 + rToken;
        assertTrue(worth > 60_299 ether);
        assertTrue(rToken * 1000 / rNative > 2_999_000 && rToken * 1000 / rNative < 3_001_000);
    }

    /// R328-3, the fact: one base unit at the pair's address does not stop the owner's deposit (the tool must not
    /// stop on it either: `prepare` accepts up to 0.1% of a side).
    function test_R328_3_oneUnitAtThePairAddressDoesNotStopTheDeposit() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        usdc.transfer(address(pair), 1);
        vm.stopPrank();
        _ownerOpens();
        (uint256 rNative, uint256 rToken) = _reserves(pair);
        assertEq(rNative, NATIVE);
        assertEq(rToken, TOKEN + 1);
    }
}
