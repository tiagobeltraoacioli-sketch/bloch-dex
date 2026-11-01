// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {CreatePair} from "../script/CreatePair.s.sol";

interface PairSupportVm {
    function mockCall(address target, bytes calldata data, bytes calldata returnData) external;
    function clearMockedCalls() external;
}

contract PairSupportTest is TestBase {
    UniswapV2Factory factory;
    BDexLens lens;
    CreatePair script;
    BlochAsset a;
    BlochAsset b;
    CreatePair.Config config;

    function setUp() public {
        factory = new UniswapV2Factory(address(0), address(0), new address[](0), new uint256[](0));
        lens = new BDexLens(address(factory));
        script = new CreatePair();
        a = new BlochAsset("Asset A", "A", 6, 1_000_000 * 1e6, address(this));
        b = new BlochAsset("Asset B", "B", 18, 1_000_000 ether, address(this));
        config = CreatePair.Config({
            chainId: block.chainid,
            factory: address(factory),
            factoryCodeHash: address(factory).codehash,
            pairInitCodeHash: factory.INIT_CODE_PAIR_HASH(),
            tokenA: address(a),
            tokenACodeHash: address(a).codehash,
            tokenB: address(b),
            tokenBCodeHash: address(b).codehash
        });
    }

    function testCreationIsCanonicalAndIdempotentInBothOrders() public {
        (address pair, bool created) = script.prepare(config);
        assertTrue(created);
        (config.tokenA, config.tokenB) = (config.tokenB, config.tokenA);
        (config.tokenACodeHash, config.tokenBCodeHash) = (config.tokenBCodeHash, config.tokenACodeHash);
        (address again, bool createdAgain) = script.prepare(config);
        assertEq(again, pair);
        assertTrue(!createdAgain);
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.feeTo(), address(0));
        assertEq(a.balanceOf(address(this)), a.totalSupply());
        assertEq(b.balanceOf(address(this)), b.totalSupply());
    }

    function testCreate2RegistryKeepsEveryTokenPairUnique() public {
        TestToken c = new TestToken();
        TestToken d = new TestToken();
        address[] memory tokens = new address[](4);
        tokens[0] = address(a);
        tokens[1] = address(b);
        tokens[2] = address(c);
        tokens[3] = address(d);
        address[] memory created = new address[](6);
        uint256 count;

        for (uint256 i; i < tokens.length; ++i) {
            for (uint256 j = i + 1; j < tokens.length; ++j) {
                (address token0, address token1) =
                    tokens[i] < tokens[j] ? (tokens[i], tokens[j]) : (tokens[j], tokens[i]);
                bytes32 salt = keccak256(abi.encodePacked(token0, token1));
                address predicted = address(
                    uint160(
                        uint256(
                            keccak256(abi.encodePacked(hex"ff", address(factory), salt, factory.INIT_CODE_PAIR_HASH()))
                        )
                    )
                );
                address pair = factory.createPair(tokens[j], tokens[i]);
                assertEq(pair, predicted);
                assertEq(factory.getPair(tokens[i], tokens[j]), pair);
                assertEq(factory.getPair(tokens[j], tokens[i]), pair);
                assertEq(factory.allPairs(count), pair);
                for (uint256 previous; previous < count; ++previous) {
                    assertTrue(created[previous] != pair);
                }
                created[count++] = pair;
            }
        }

        assertEq(factory.allPairsLength(), 6);
        assertEq(factory.INIT_CODE_PAIR_HASH(), keccak256(type(UniswapV2Pair).creationCode));
    }

    function testMissingEmptyAndFundedPairsAreDistinct() public {
        (bool exists, BDexLens.PoolSnapshot memory snapshot) = lens.poolFor(address(a), address(b));
        assertTrue(!exists);
        assertEq(snapshot.pair, address(0));
        (address pair,) = script.prepare(config);
        (exists, snapshot) = lens.poolFor(address(b), address(a));
        assertTrue(exists);
        assertEq(snapshot.pair, pair);
        assertEq(snapshot.reserve0, 0);
        assertEq(snapshot.reserve1, 0);
        assertTrue(!lens.quoteExactInput(1e6, _path(), 50).available);
        BDexRouter router = _fund();
        (exists, snapshot) = lens.poolFor(address(a), address(b));
        assertTrue(exists && snapshot.totalSupply > 0);
        assertEq(snapshot.token0, UniswapV2Pair(pair).token0());
        assertEq(snapshot.reserve0, snapshot.token0 == address(a) ? 100_000 * 1e6 : 200_000 ether);
        BDexLens.RouteQuote memory quote = lens.quoteExactInput(10 * 1e6, _path(), 50);
        assertTrue(quote.available);
        uint256 before = b.balanceOf(address(this));
        router.swapExactTokensForTokens(10 * 1e6, quote.minimumOut, _path(), address(this), block.timestamp);
        assertEq(b.balanceOf(address(this)) - before, quote.amountOut);
    }

    function testRejectWrongAndZeroChain() public {
        config.chainId = block.chainid + 1;
        vm.expectRevert(bytes("PAIR: CHAIN_ID"));
        script.prepare(config);
        config.chainId = 0;
        vm.expectRevert(bytes("PAIR: CHAIN_ID"));
        script.prepare(config);
        assertEq(factory.allPairsLength(), 0);
    }

    function testRejectWrongFactoryAndTokenHashes() public {
        CreatePair.Config memory bad = config;
        bad.factoryCodeHash = bytes32(uint256(1));
        _rejectHash(bad);
        bad = config;
        bad.tokenACodeHash = bytes32(0);
        _rejectHash(bad);
        bad = config;
        bad.tokenBCodeHash = bytes32(uint256(1));
        _rejectHash(bad);
        bad = config;
        bad.tokenB = address(0x1234);
        bad.tokenBCodeHash = address(0x1234).codehash;
        _rejectHash(bad);
        assertEq(factory.allPairsLength(), 0);
    }

    function testRejectWrongPairBytecodeAndIdenticalTokens() public {
        config.pairInitCodeHash = bytes32(uint256(1));
        vm.expectRevert(bytes("PAIR: INIT_CODE_HASH"));
        script.prepare(config);
        config.pairInitCodeHash = factory.INIT_CODE_PAIR_HASH();
        config.tokenB = config.tokenA;
        config.tokenBCodeHash = config.tokenACodeHash;
        vm.expectRevert(bytes("BDEX: IDENTICAL_ADDRESSES"));
        script.prepare(config);
        assertEq(factory.allPairsLength(), 0);
    }

    function testLookupRejectsInvalidTokenPairs() public {
        vm.expectRevert(bytes("BDEX: IDENTICAL_ADDRESSES"));
        lens.poolFor(address(a), address(a));
        vm.expectRevert(bytes("BDEX: ZERO_ADDRESS"));
        lens.poolFor(address(0), address(a));
    }

    function testExistingFundedPairPreservesReservesAndSupply() public {
        _fund();
        address existing = factory.getPair(address(a), address(b));
        (uint112 r0, uint112 r1,) = UniswapV2Pair(existing).getReserves();
        uint256 supply = UniswapV2Pair(existing).totalSupply();
        (address pair, bool created) = script.prepare(config);
        assertEq(pair, existing);
        assertTrue(!created);
        (uint112 after0, uint112 after1,) = UniswapV2Pair(pair).getReserves();
        assertEq(after0, r0);
        assertEq(after1, r1);
        assertEq(UniswapV2Pair(pair).totalSupply(), supply);
        assertEq(factory.allPairsLength(), 1);
    }

    function testRejectExistingPairAtNoncanonicalAddress() public {
        PairSupportVm(address(vm))
            .mockCall(
                address(factory),
                abi.encodeWithSignature("getPair(address,address)", address(a), address(b)),
                abi.encode(address(a))
            );
        PairSupportVm(address(vm))
            .mockCall(
                address(factory),
                abi.encodeWithSignature("getPair(address,address)", address(b), address(a)),
                abi.encode(address(a))
            );
        vm.expectRevert(bytes("PAIR: IDENTITY"));
        script.prepare(config);
        assertEq(factory.allPairsLength(), 0);
    }

    function testRejectExistingPairWithWrongFactoryOrTokens() public {
        (address pair,) = script.prepare(config);
        bytes4[3] memory selectors =
            [bytes4(keccak256("factory()")), bytes4(keccak256("token0()")), bytes4(keccak256("token1()"))];
        for (uint256 i; i < selectors.length; ++i) {
            PairSupportVm(address(vm)).mockCall(pair, abi.encodeWithSelector(selectors[i]), abi.encode(address(0x1234)));
            vm.expectRevert(bytes("PAIR: REGISTRY"));
            script.prepare(config);
            PairSupportVm(address(vm)).clearMockedCalls();
        }
    }

    function testRejectAsymmetricExistingRegistry() public {
        (address pair,) = script.prepare(config);
        address token0 = UniswapV2Pair(pair).token0();
        address token1 = UniswapV2Pair(pair).token1();
        PairSupportVm(address(vm))
            .mockCall(
                address(factory),
                abi.encodeWithSignature("getPair(address,address)", token1, token0),
                abi.encode(address(0))
            );
        vm.expectRevert(bytes("PAIR: REGISTRY"));
        script.prepare(config);
        assertEq(factory.allPairsLength(), 1);
    }

    function _rejectHash(CreatePair.Config memory bad) private {
        vm.expectRevert(bytes("PAIR: CODE_HASH"));
        script.prepare(bad);
    }

    function _fund() private returns (BDexRouter router) {
        router = new BDexRouter(address(factory), address(new TestWrappedNative()));
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        router.addLiquidity(
            address(a),
            address(b),
            100_000 * 1e6,
            200_000 ether,
            100_000 * 1e6,
            200_000 ether,
            address(this),
            block.timestamp
        );
    }

    function _path() private view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(a);
        path[1] = address(b);
    }
}
