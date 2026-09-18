// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "../contracts/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../contracts/interfaces/IUniswapV2Pair.sol";
import {IBDexRouter} from "../contracts/periphery/interfaces/IBDexRouter.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

interface InitialLiquidityVm {
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes32(string calldata) external returns (bytes32);
}

interface LensBinding {
    function factory() external view returns (address);
}

interface TokenBalance {
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Read-only deployment and empty-pair checks before an initial liquidity approval.
/// @dev This is a configuration guard, not a token audit or an atomic guarantee. Re-run it
///      immediately before simulating the separately reviewed add-liquidity transaction.
contract InitialLiquidityPreflight {
    InitialLiquidityVm constant vm = InitialLiquidityVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Config {
        uint256 chainId;
        address factory;
        bytes32 factoryCodeHash;
        address router;
        bytes32 routerCodeHash;
        address lens;
        bytes32 lensCodeHash;
        address wrapped;
        bytes32 wrappedCodeHash;
        address feeToSetter;
        bytes32 pairInitCodeHash;
        address tokenA;
        bytes32 tokenACodeHash;
        address tokenB;
        bytes32 tokenBCodeHash;
        bytes32 pairCodeHash;
    }

    event InitialLiquidityReady(
        uint256 chainId,
        address factory,
        address router,
        address lens,
        address wrapped,
        address pair,
        address token0,
        address token1
    );

    function run() external returns (address pair) {
        Config memory config = Config({
            chainId: vm.envUint("EXPECTED_CHAIN_ID"),
            factory: vm.envAddress("PAIR_FACTORY"),
            factoryCodeHash: vm.envBytes32("PAIR_FACTORY_CODEHASH"),
            router: vm.envAddress("BDEX_ROUTER"),
            routerCodeHash: vm.envBytes32("BDEX_ROUTER_CODEHASH"),
            lens: vm.envAddress("BDEX_LENS"),
            lensCodeHash: vm.envBytes32("BDEX_LENS_CODEHASH"),
            wrapped: vm.envAddress("WBLCH_ADDRESS"),
            wrappedCodeHash: vm.envBytes32("WBLCH_CODEHASH"),
            feeToSetter: vm.envAddress("FEE_TO_SETTER"),
            pairInitCodeHash: vm.envBytes32("PAIR_INIT_CODE_HASH"),
            tokenA: vm.envAddress("PAIR_TOKEN_A"),
            tokenACodeHash: vm.envBytes32("PAIR_TOKEN_A_CODEHASH"),
            tokenB: vm.envAddress("PAIR_TOKEN_B"),
            tokenBCodeHash: vm.envBytes32("PAIR_TOKEN_B_CODEHASH"),
            pairCodeHash: vm.envBytes32("PAIR_CODEHASH")
        });
        pair = verify(config);
    }

    function verify(Config memory config) public returns (address pair) {
        require(config.chainId != 0 && block.chainid == config.chainId, "PREFLIGHT: CHAIN_ID");
        _checkCode(config.factory, config.factoryCodeHash);
        _checkCode(config.router, config.routerCodeHash);
        _checkCode(config.lens, config.lensCodeHash);
        _checkCode(config.wrapped, config.wrappedCodeHash);
        _checkCode(config.tokenA, config.tokenACodeHash);
        _checkCode(config.tokenB, config.tokenBCodeHash);

        IUniswapV2Factory factory = IUniswapV2Factory(config.factory);
        require(
            config.pairInitCodeHash != bytes32(0) && factory.INIT_CODE_PAIR_HASH() == config.pairInitCodeHash,
            "PREFLIGHT: INIT_CODE_HASH"
        );
        require(
            config.feeToSetter != address(0) && factory.feeToSetter() == config.feeToSetter
                && factory.pendingFeeToSetter() == address(0) && factory.feeTo() == address(0),
            "PREFLIGHT: FEE_AUTHORITY"
        );
        require(
            IBDexRouter(config.router).factory() == config.factory
                && IBDexRouter(config.router).WBLCH() == config.wrapped,
            "PREFLIGHT: ROUTER_BINDING"
        );
        require(LensBinding(config.lens).factory() == config.factory, "PREFLIGHT: LENS_BINDING");

        (address token0, address token1) = BDexLibrary.sortTokens(config.tokenA, config.tokenB);
        pair = factory.getPair(token0, token1);
        require(pair != address(0), "PREFLIGHT: PAIR_MISSING");
        _checkCode(pair, config.pairCodeHash);
        address predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            config.factory,
                            keccak256(abi.encodePacked(token0, token1)),
                            config.pairInitCodeHash
                        )
                    )
                )
            )
        );
        require(
            pair == predicted && factory.getPair(token1, token0) == pair
                && IUniswapV2Pair(pair).factory() == config.factory && IUniswapV2Pair(pair).token0() == token0
                && IUniswapV2Pair(pair).token1() == token1,
            "PREFLIGHT: PAIR_IDENTITY"
        );
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        require(
            IUniswapV2Pair(pair).totalSupply() == 0 && reserve0 == 0 && reserve1 == 0
                && TokenBalance(token0).balanceOf(pair) == 0 && TokenBalance(token1).balanceOf(pair) == 0,
            "PREFLIGHT: PAIR_NOT_EMPTY"
        );

        emit InitialLiquidityReady(
            config.chainId, config.factory, config.router, config.lens, config.wrapped, pair, token0, token1
        );
    }

    function _checkCode(address target, bytes32 expected) private view {
        require(target.code.length > 0 && expected != bytes32(0) && target.codehash == expected, "PREFLIGHT: CODE_HASH");
    }
}
