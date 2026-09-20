// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {InitialLiquidityPreflight} from "../script/InitialLiquidityPreflight.s.sol";

contract InitialLiquidityPreflightTest is TestBase {
    UniswapV2Factory factory;
    BDexRouter router;
    BDexLens lens;
    TestWrappedNative wrapped;
    TestToken tokenA;
    TestToken tokenB;
    UniswapV2Pair pair;
    InitialLiquidityPreflight preflight;
    InitialLiquidityPreflight.Config config;

    function setUp() public {
        factory = new UniswapV2Factory(address(this));
        wrapped = new TestWrappedNative();
        router = new BDexRouter(address(factory), address(wrapped));
        lens = new BDexLens(address(factory));
        tokenA = TestToken(address(wrapped));
        tokenB = new TestToken();
        pair = UniswapV2Pair(factory.createPair(address(tokenA), address(tokenB)));
        preflight = new InitialLiquidityPreflight();
        config = InitialLiquidityPreflight.Config({
            chainId: block.chainid,
            factory: address(factory),
            factoryCodeHash: address(factory).codehash,
            router: address(router),
            routerCodeHash: address(router).codehash,
            lens: address(lens),
            lensCodeHash: address(lens).codehash,
            wrapped: address(wrapped),
            wrappedCodeHash: address(wrapped).codehash,
            feeToSetter: address(this),
            pairInitCodeHash: factory.INIT_CODE_PAIR_HASH(),
            tokenA: address(tokenA),
            tokenACodeHash: address(tokenA).codehash,
            tokenB: address(tokenB),
            tokenBCodeHash: address(tokenB).codehash,
            pairCodeHash: address(pair).codehash,
            plannedBaseAmount: 1 ether,
            plannedQuoteAmount: 1_000_000,
            approvedMaxBaseAmount: 10 ether,
            approvedMaxQuoteAmount: 10_000_000,
            capApprovalHash: sha256("reviewed pilot cap")
        });
    }

    function testAcceptsOneConsistentEmptyDeployment() public {
        assertEq(preflight.verify(config), address(pair));
    }

    function testRejectsRouterAndLensFromAnotherDeployment() public {
        UniswapV2Factory other = new UniswapV2Factory(address(this));
        BDexRouter otherRouter = new BDexRouter(address(other), address(wrapped));
        config.router = address(otherRouter);
        config.routerCodeHash = address(otherRouter).codehash;
        vm.expectRevert(bytes("PREFLIGHT: ROUTER_BINDING"));
        preflight.verify(config);

        config.router = address(router);
        config.routerCodeHash = address(router).codehash;
        BDexLens otherLens = new BDexLens(address(other));
        config.lens = address(otherLens);
        config.lensCodeHash = address(otherLens).codehash;
        vm.expectRevert(bytes("PREFLIGHT: LENS_BINDING"));
        preflight.verify(config);
    }

    function testRejectsPendingAuthorityTransferAndEnabledFees() public {
        factory.setFeeToSetter(address(0xA11CE));
        vm.expectRevert(bytes("PREFLIGHT: FEE_AUTHORITY"));
        preflight.verify(config);
        factory.cancelFeeToSetterTransfer();

        factory.setFeeTo(address(0xBEEF));
        vm.expectRevert(bytes("PREFLIGHT: FEE_AUTHORITY"));
        preflight.verify(config);
    }

    function testRejectsDonatedOrSyncedPair() public {
        tokenA.mint(address(this), 1);
        tokenA.transfer(address(pair), 1);
        vm.expectRevert(bytes("PREFLIGHT: PAIR_NOT_EMPTY"));
        preflight.verify(config);

        tokenB.mint(address(this), 1);
        tokenB.transfer(address(pair), 1);
        pair.sync();
        vm.expectRevert(bytes("PREFLIGHT: PAIR_NOT_EMPTY"));
        preflight.verify(config);
    }

    function testRejectsAlreadyFundedPair() public {
        tokenA.mint(address(this), 10_000);
        tokenB.mint(address(this), 10_000);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        router.addLiquidity(
            address(tokenA), address(tokenB), 10_000, 10_000, 10_000, 10_000, address(this), block.timestamp
        );
        vm.expectRevert(bytes("PREFLIGHT: PAIR_NOT_EMPTY"));
        preflight.verify(config);
    }

    function testRejectsWrongChainCodeAndPairCreationHash() public {
        config.chainId = block.chainid + 1;
        vm.expectRevert(bytes("PREFLIGHT: CHAIN_ID"));
        preflight.verify(config);
        config.chainId = block.chainid;

        config.routerCodeHash = bytes32(uint256(1));
        vm.expectRevert(bytes("PREFLIGHT: CODE_HASH"));
        preflight.verify(config);
        config.routerCodeHash = address(router).codehash;

        config.pairInitCodeHash = bytes32(uint256(1));
        vm.expectRevert(bytes("PREFLIGHT: INIT_CODE_HASH"));
        preflight.verify(config);
    }

    function testRejectsWrongPilotAssetsOrUnboundCap() public {
        config.tokenA = address(new TestToken());
        config.tokenACodeHash = config.tokenA.codehash;
        vm.expectRevert(bytes("PREFLIGHT: PILOT_ASSETS"));
        preflight.verify(config);
        config.tokenA = address(wrapped);
        config.tokenACodeHash = address(wrapped).codehash;

        config.capApprovalHash = bytes32(0);
        vm.expectRevert(bytes("PREFLIGHT: PILOT_CAP"));
        preflight.verify(config);
    }

    function testRejectsZeroOverApprovedAndOverHardCapAmounts() public {
        config.plannedBaseAmount = 0;
        vm.expectRevert(bytes("PREFLIGHT: PILOT_CAP"));
        preflight.verify(config);
        config.plannedBaseAmount = 1 ether;

        config.plannedQuoteAmount = config.approvedMaxQuoteAmount + 1;
        vm.expectRevert(bytes("PREFLIGHT: PILOT_CAP"));
        preflight.verify(config);
        config.plannedQuoteAmount = 1_000_000;

        config.approvedMaxBaseAmount = 10 ether + 1;
        vm.expectRevert(bytes("PREFLIGHT: PILOT_CAP"));
        preflight.verify(config);
        config.approvedMaxBaseAmount = 10 ether;

        config.approvedMaxQuoteAmount = 10_000_001;
        vm.expectRevert(bytes("PREFLIGHT: PILOT_CAP"));
        preflight.verify(config);
    }
}
