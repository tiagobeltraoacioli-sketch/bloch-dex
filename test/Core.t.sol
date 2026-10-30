// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {UniswapV2ERC20} from "../contracts/UniswapV2ERC20.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

contract FlashBorrower {
    UniswapV2Pair internal pair;
    bool public reentryBlocked;
    bool public repay;

    constructor(UniswapV2Pair pair_) {
        pair = pair_;
    }

    function borrow(uint256 amount, bool repay_) external {
        repay = repay_;
        pair.swap(amount, 0, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256 amount0, uint256, bytes calldata) external {
        require(msg.sender == address(pair));
        (bool ok,) = address(pair).call(abi.encodeWithSelector(pair.sync.selector));
        reentryBlocked = !ok;
        if (repay) require(TestToken(pair.token0()).transfer(address(pair), (amount0 * 1000 + 996) / 997));
    }
}

contract CoreTest is TestBase {
    uint256 private constant SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    UniswapV2Factory internal factory;
    TestToken internal a;
    TestToken internal b;
    UniswapV2Pair internal pair;

    function setUp() public {
        vm.warp(1_000);
        factory = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        a = new TestToken();
        b = new TestToken();
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        a.mint(address(pair), 1_000 ether);
        b.mint(address(pair), 1_000 ether);
        pair.mint(address(this));
    }

    function testCreate2AddressAndPermanentMinimumLiquidity() public view {
        bytes32 salt = keccak256(abi.encodePacked(pair.token0(), pair.token1()));
        address predicted = address(
            uint160(
                uint256(keccak256(abi.encodePacked(hex"ff", address(factory), salt, factory.INIT_CODE_PAIR_HASH())))
            )
        );
        assertEq(predicted, address(pair));
        assertEq(pair.balanceOf(address(0)), 1000);
        assertEq(factory.getPair(address(b), address(a)), address(pair));
        assertEq(factory.feeTo(), address(0));
    }

    /// Pair code (and so every CREATE2 pair address) must not depend on the
    /// factory's fee recipient: the fixed-recipient factory reads it through
    /// the same `feeTo()` selector as the canonical storage getter.
    function testPairInitCodeHashIsPinnedAndIndependentOfFeeRecipient() public {
        bytes32 pinned = 0xe41e81db2882b882be444d9f5936fae630b6f22664d20a762ab86dc17afeb248;
        assertEq(factory.INIT_CODE_PAIR_HASH(), pinned);
        UniswapV2Factory feeOn = new UniswapV2Factory(address(0xFEE), new address[](0), new uint256[](0));
        assertEq(feeOn.INIT_CODE_PAIR_HASH(), pinned);
        assertEq(feeOn.feeTo(), address(0xFEE));
    }

    /// The fee recipient is fixed once: no setter or authority surface exists,
    /// for anyone, including the deployer and the recipient itself.
    function testFeeRecipientHasNoAdminSurface() public {
        UniswapV2Factory feeOn = new UniswapV2Factory(address(0xFEE), new address[](0), new uint256[](0));
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeWithSignature("setFeeTo(address)", address(this));
        calls[1] = abi.encodeWithSignature("setFeeToSetter(address)", address(this));
        calls[2] = abi.encodeWithSignature("acceptFeeToSetter()");
        calls[3] = abi.encodeWithSignature("cancelFeeToSetterTransfer()");
        calls[4] = abi.encodeWithSignature("feeToSetter()");
        calls[5] = abi.encodeWithSignature("pendingFeeToSetter()");
        address[2] memory callers = [address(this), address(0xFEE)];
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                (bool ok,) = address(feeOn).call(calls[i]);
                assertTrue(!ok);
            }
        }
        assertEq(feeOn.feeTo(), address(0xFEE));
    }

    function testFactoryRejectsNonContractAndDuplicateTokens() public {
        vm.expectRevert(bytes("BDEX: NOT_A_TOKEN"));
        factory.createPair(address(a), address(0xBEEF));
        vm.expectRevert(bytes("BDEX: PAIR_EXISTS"));
        factory.createPair(address(b), address(a));
        vm.expectRevert(bytes("BDEX: IDENTICAL_ADDRESSES"));
        factory.createPair(address(a), address(a));
    }

    function testPairCannotBeReinitializedEvenByFactory() public {
        address t0 = pair.token0();
        address t1 = pair.token1();
        vm.prank(address(factory));
        vm.expectRevert(bytes("BDEX: ALREADY_INITIALIZED"));
        pair.initialize(t0, t1);
    }

    function testFlashSwapRepaymentAndReentrancyLock() public {
        FlashBorrower borrower = new FlashBorrower(pair);
        TestToken(pair.token0()).mint(address(borrower), 1 ether);
        borrower.borrow(10 ether, true);
        assertTrue(borrower.reentryBlocked());
        vm.expectRevert(bytes("BDEX: INSUFFICIENT_INPUT_AMOUNT"));
        borrower.borrow(10 ether, false);
    }

    function testFuzzSwapMaintainsAdjustedInvariant(uint96 inputSeed) public {
        uint256 input = uint256(inputSeed) % 100 ether + 1_000;
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 output = BDexLibrary.getAmountOut(input, r0, r1);
        TestToken(pair.token0()).mint(address(pair), input);
        pair.swap(0, output, address(this), "");
        (uint112 n0, uint112 n1,) = pair.getReserves();
        assertTrue((uint256(n0) * 1000 - input * 3) * uint256(n1) * 1000 >= uint256(r0) * r1 * 1_000_000);
        assertEq(TestToken(pair.token0()).balanceOf(address(pair)), n0);
        assertEq(TestToken(pair.token1()).balanceOf(address(pair)), n1);
    }

    function testFuzzExactOutputRoundsUp(uint96 outSeed) public pure {
        uint256 output = uint256(outSeed) % 999 ether + 1;
        uint256 input = BDexLibrary.getAmountIn(output, 1_000 ether, 1_000 ether);
        assertTrue(BDexLibrary.getAmountOut(input, 1_000 ether, 1_000 ether) >= output);
        // Canonical getAmountIn deliberately adds one even when division is exact.
        if (input > 1) assertTrue(BDexLibrary.getAmountOut(input - 1, 1_000 ether, 1_000 ether) <= output);
    }

    function testSkimRecoversBalanceAfterSyncOverflow() public {
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        TestToken token0 = TestToken(pair.token0());
        uint256 surplus = uint256(type(uint112).max) - reserve0 + 1;
        token0.mint(address(pair), surplus);

        vm.expectRevert(bytes("BDEX: OVERFLOW"));
        pair.sync();
        uint256 recipientBefore = token0.balanceOf(address(this));
        pair.skim(address(this));

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(reserve0After, reserve0);
        assertEq(reserve1After, reserve1);
        assertEq(token0.balanceOf(address(pair)), reserve0);
        assertEq(token0.balanceOf(address(this)) - recipientBefore, surplus);
    }

    function testPermitCannotReplayAcrossNonceOrChain() public {
        UniswapV2ERC20 lp = new UniswapV2ERC20();
        address owner = vm.addr(0x1234);
        uint256 deadline = block.timestamp + 100;
        bytes32 message = keccak256(abi.encode(lp.PERMIT_TYPEHASH(), owner, address(this), 123, 0, deadline));
        bytes32 domain = lp.DOMAIN_SEPARATOR();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x1234, keccak256(abi.encodePacked(hex"1901", domain, message)));
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(bytes("BDEX: INVALID_SIGNATURE"));
        lp.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(lp.nonces(owner), 0);
        vm.chainId(originalChain);
        lp.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(lp.allowance(owner, address(this)), 123);
        vm.expectRevert(bytes("BDEX: INVALID_SIGNATURE"));
        lp.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(lp.nonces(owner), 1);
    }

    function testPermitRejectsMalleatedHighSSignature() public {
        UniswapV2ERC20 lp = new UniswapV2ERC20();
        address owner = vm.addr(0x1234);
        uint256 deadline = block.timestamp + 100;
        bytes32 message = keccak256(abi.encode(lp.PERMIT_TYPEHASH(), owner, address(this), 123, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(0x1234, keccak256(abi.encodePacked(hex"1901", lp.DOMAIN_SEPARATOR(), message)));
        uint8 malleatedV = v == 27 ? 28 : 27;
        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));

        vm.expectRevert(bytes("BDEX: INVALID_SIGNATURE"));
        lp.permit(owner, address(this), 123, deadline, malleatedV, r, highS);
        assertEq(lp.nonces(owner), 0);

        lp.permit(owner, address(this), 123, deadline, v, r, s);
        assertEq(lp.allowance(owner, address(this)), 123);
    }
}
