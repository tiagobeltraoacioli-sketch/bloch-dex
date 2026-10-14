// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {TestBase} from "./TestBase.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {LocalDeployment} from "../script/LocalDeployment.s.sol";

interface WrapperVm {
    function setEnv(string calldata, string calldata) external;
}

contract NativeCallback {
    WBLCH public immutable wrapped;
    bool public reject;
    bool public attemptReentry;
    bool public reentered;
    bool public observedBurn;

    constructor(WBLCH token) {
        wrapped = token;
    }

    function configure(bool reject_, bool attempt_) external {
        reject = reject_;
        attemptReentry = attempt_;
    }

    function deposit() external payable {
        wrapped.deposit{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        wrapped.withdraw(amount);
    }

    receive() external payable {
        observedBurn = wrapped.balanceOf(address(this)) == 0 && wrapped.totalSupply() == 0;
        if (attemptReentry) (reentered,) = address(wrapped).call(abi.encodeCall(WBLCH.withdraw, (0)));
        require(!reject, "recipient rejects");
    }
}

contract WrappedNativeTest is TestBase {
    WBLCH wrapped;
    receive() external payable {}

    function setUp() public {
        wrapped = new WBLCH();
        vm.deal(address(this), 100 ether);
    }

    function testFuzzDepositTransferWithdrawRemainsBacked(uint96 raw) public {
        uint256 amount = uint256(raw) % 50 ether;
        wrapped.deposit{value: amount}();
        assertEq(wrapped.totalSupply(), amount);
        assertEq(address(wrapped).balance, amount);
        wrapped.transfer(address(123), amount);
        vm.prank(address(123));
        wrapped.withdraw(amount);
        assertEq(wrapped.totalSupply(), 0);
        assertEq(address(wrapped).balance, 0);
        assertEq(address(123).balance, amount);
    }

    function testReceiveAllowanceSelfTransferAndInfiniteApproval() public {
        (bool ok,) = address(wrapped).call{value: 3 ether}("");
        assertTrue(ok);
        wrapped.transfer(address(this), 1 ether);
        assertEq(wrapped.balanceOf(address(this)), 3 ether);
        wrapped.approve(address(123), 1 ether);
        vm.prank(address(123));
        wrapped.transferFrom(address(this), address(456), 1 ether);
        assertEq(wrapped.allowance(address(this), address(123)), 0);
        wrapped.approve(address(123), type(uint256).max);
        vm.prank(address(123));
        wrapped.transferFrom(address(this), address(456), 1 ether);
        assertEq(wrapped.allowance(address(this), address(123)), type(uint256).max);
        assertEq(wrapped.totalSupply(), 3 ether);
    }

    function testInvalidRecipientsAndFailedTransferRestoreAllowance() public {
        wrapped.deposit{value: 1 ether}();
        wrapped.approve(address(123), 2 ether);
        vm.expectRevert(bytes("WBLCH: RECIPIENT"));
        wrapped.transfer(address(wrapped), 1);
        vm.expectRevert(bytes("WBLCH: RECIPIENT"));
        wrapped.transfer(address(0), 1);
        vm.expectRevert(bytes("WBLCH: SPENDER"));
        wrapped.approve(address(0), 1);
        vm.expectRevert(bytes("WBLCH: SPENDER"));
        wrapped.approve(address(wrapped), 1);
        vm.prank(address(123));
        vm.expectRevert(bytes("WBLCH: BALANCE"));
        wrapped.transferFrom(address(this), address(456), 2 ether);
        assertEq(wrapped.allowance(address(this), address(123)), 2 ether);
        assertEq(wrapped.balanceOf(address(this)), 1 ether);
        vm.prank(address(999));
        vm.expectRevert(bytes("WBLCH: ALLOWANCE"));
        wrapped.transferFrom(address(this), address(999), 1);
        vm.expectRevert(bytes("WBLCH: BALANCE"));
        wrapped.withdraw(2 ether);
    }

    function testRejectingNativeRecipientRollsBackBurnAndLock() public {
        NativeCallback receiver = new NativeCallback(wrapped);
        receiver.deposit{value: 1 ether}();
        receiver.configure(true, true);
        vm.expectRevert(bytes("WBLCH: NATIVE_SEND"));
        receiver.withdraw(1 ether);
        assertEq(wrapped.balanceOf(address(receiver)), 1 ether);
        assertEq(wrapped.totalSupply(), 1 ether);
        assertEq(address(wrapped).balance, 1 ether);
        assertEq(address(receiver).balance, 0);
        receiver.configure(false, true);
        receiver.withdraw(1 ether);
        assertTrue(receiver.observedBurn());
        assertTrue(!receiver.reentered());
        assertEq(address(receiver).balance, 1 ether);
        assertEq(wrapped.totalSupply(), 0);
    }

    function testForcedSurplusDoesNotMintOrEnableOverwithdrawal() public {
        wrapped.deposit{value: 1 ether}();
        // Models native currency forced into the address without executing receive.
        vm.deal(address(wrapped), 2 ether);
        assertEq(wrapped.totalSupply(), 1 ether);
        vm.expectRevert(bytes("WBLCH: BALANCE"));
        wrapped.withdraw(2 ether);
        wrapped.withdraw(1 ether);
        assertEq(address(wrapped).balance, 1 ether);
        assertEq(wrapped.totalSupply(), 0);
        (bool mintAvailable,) =
            address(wrapped).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        assertTrue(!mintAvailable);
    }

    function testNativeRouterLiquiditySwapAndRemoval() public {
        UniswapV2Factory factory = new UniswapV2Factory(address(this), new address[](0), new uint256[](0));
        BDexRouter router = new BDexRouter(address(factory), address(wrapped));
        BDexLens lens = new BDexLens(address(factory));
        BlochAsset token = new BlochAsset("Asset", "A", 6, 1_000_000 * 1e6, address(this));
        token.approve(address(router), 100_000 * 1e6);
        (,, uint256 lp) = router.addLiquidityBLCH{value: 10 ether}(
            address(token), 100_000 * 1e6, 100_000 * 1e6, 10 ether, address(this), block.timestamp
        );
        address[] memory path = new address[](2);
        path[0] = address(wrapped);
        path[1] = address(token);
        BDexLens.RouteQuote memory quote = lens.quoteExactInput(1 ether, path, 50);
        uint256 before = token.balanceOf(address(this));
        router.swapExactBLCHForTokens{value: 1 ether}(quote.minimumOut, path, address(this), block.timestamp);
        assertEq(token.balanceOf(address(this)) - before, quote.amountOut);
        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(token), address(wrapped)));
        pair.approve(address(router), lp);
        uint256 nativeBefore = address(this).balance;
        before = token.balanceOf(address(this));
        (uint256 tokens, uint256 nativeAmount) =
            router.removeLiquidityBLCH(address(token), lp, 1, 1, address(this), block.timestamp);
        assertEq(address(this).balance - nativeBefore, nativeAmount);
        assertEq(token.balanceOf(address(this)) - before, tokens);
        assertEq(pair.balanceOf(address(this)), 0);
        assertEq(wrapped.totalSupply(), address(wrapped).balance);
        assertEq(wrapped.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
        assertEq(factory.feeTo(), address(0));
    }

    function testNativeRouterRejectsWrappedRecipientWithoutResidue() public {
        UniswapV2Factory factory = new UniswapV2Factory(address(this), new address[](0), new uint256[](0));
        BDexRouter router = new BDexRouter(address(factory), address(wrapped));
        BlochAsset token = new BlochAsset("Asset", "A", 6, 1_000_000 * 1e6, address(this));
        token.approve(address(router), type(uint256).max);
        (,, uint256 liquidity) = router.addLiquidityBLCH{value: 10 ether}(
            address(token), 100_000 * 1e6, 100_000 * 1e6, 10 ether, address(this), block.timestamp
        );
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(wrapped);
        uint256[] memory exactInputQuote = router.getAmountsOut(1_000 * 1e6, path);
        uint256[] memory exactOutputQuote = router.getAmountsIn(0.01 ether, path);

        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.swapExactTokensForBLCH(1_000 * 1e6, exactInputQuote[1], path, address(wrapped), block.timestamp);
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.swapTokensForExactBLCH(0.01 ether, exactOutputQuote[0], path, address(wrapped), block.timestamp);
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.swapExactTokensForBLCHSupportingFeeOnTransferTokens(
            1_000 * 1e6, exactInputQuote[1], path, address(wrapped), block.timestamp
        );
        uint256 zeroBalanceBefore = address(0).balance;
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.swapExactTokensForBLCH(1_000 * 1e6, exactInputQuote[1], path, address(0), block.timestamp);

        UniswapV2Pair pair = UniswapV2Pair(factory.getPair(address(token), address(wrapped)));
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.removeLiquidityBLCH(address(token), liquidity, 1, 1, address(wrapped), block.timestamp);
        vm.expectRevert(bytes("BDEX: INVALID_TO"));
        router.removeLiquidityBLCHSupportingFeeOnTransferTokens(
            address(token), liquidity, 1, 1, address(wrapped), block.timestamp
        );

        assertEq(wrapped.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
        assertEq(address(0).balance, zeroBalanceBefore);
        assertEq(pair.balanceOf(address(this)), liquidity);
    }

    function testLocalDeploymentIsEmptyAndRefusesOtherChains() public {
        LocalDeployment script = new LocalDeployment();
        vm.chainId(1);
        vm.expectRevert(bytes("LOCAL: CHAIN_ID"));
        script.run();
        vm.chainId(31337);
        WrapperVm(address(vm)).setEnv("LOCAL_RECIPIENT", "0x0000000000000000000000000000000000000123");
        LocalDeployment.Deployment memory deployment = script.run();
        UniswapV2Factory factory = UniswapV2Factory(deployment.factory);
        assertEq(factory.allPairsLength(), 0);
        assertEq(factory.feeTo(), address(0));
        assertEq(WBLCH(payable(deployment.wrapped)).totalSupply(), 0);
        assertEq(BlochAsset(deployment.sampleUsd).balanceOf(address(0x123)), 1_000_000 * 1e6);
        assertEq(BlochAsset(deployment.sampleAsset).balanceOf(address(0x123)), 1_000_000 ether);
        assertEq(BDexRouter(payable(deployment.router)).WBLCH(), deployment.wrapped);
        assertEq(address(BDexLens(deployment.lens).factory()), deployment.factory);
    }
}
