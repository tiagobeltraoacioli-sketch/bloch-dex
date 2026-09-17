// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "../contracts/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../contracts/interfaces/IUniswapV2Pair.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";

interface PairVm {
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes32(string calldata) external returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Rehearse canonical pair creation against an explicitly reviewed deployment.
/// @dev No deposits, approvals, fees, asset issuance or native wrapping. A chain ID
///      and code hashes are configuration guards, not a network or token audit.
contract CreatePair {
    PairVm constant vm = PairVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Config {
        uint256 chainId;
        address factory;
        bytes32 factoryCodeHash;
        bytes32 pairInitCodeHash;
        address tokenA;
        bytes32 tokenACodeHash;
        address tokenB;
        bytes32 tokenBCodeHash;
    }

    event PairPrepared(uint256 chainId, address factory, address pair, address token0, address token1, bool created);

    function run() external returns (address pair, bool created) {
        Config memory config;
        config.chainId = vm.envUint("EXPECTED_CHAIN_ID");
        config.factory = vm.envAddress("PAIR_FACTORY");
        config.factoryCodeHash = vm.envBytes32("PAIR_FACTORY_CODEHASH");
        config.pairInitCodeHash = vm.envBytes32("PAIR_INIT_CODE_HASH");
        config.tokenA = vm.envAddress("PAIR_TOKEN_A");
        config.tokenACodeHash = vm.envBytes32("PAIR_TOKEN_A_CODEHASH");
        config.tokenB = vm.envAddress("PAIR_TOKEN_B");
        config.tokenBCodeHash = vm.envBytes32("PAIR_TOKEN_B_CODEHASH");
        return prepare(config);
    }

    /// @dev Public for local rehearsals with typed configuration; not an on-chain service.
    function prepare(Config memory config) public returns (address pair, bool created) {
        require(config.chainId != 0 && block.chainid == config.chainId, "PAIR: CHAIN_ID");
        _checkCode(config.factory, config.factoryCodeHash);
        _checkCode(config.tokenA, config.tokenACodeHash);
        _checkCode(config.tokenB, config.tokenBCodeHash);
        (address token0, address token1) = BDexLibrary.sortTokens(config.tokenA, config.tokenB);
        IUniswapV2Factory factory = IUniswapV2Factory(config.factory);
        require(
            config.pairInitCodeHash != bytes32(0) && factory.INIT_CODE_PAIR_HASH() == config.pairInitCodeHash,
            "PAIR: INIT_CODE_HASH"
        );
        pair = factory.getPair(token0, token1);
        if (pair == address(0)) {
            vm.startBroadcast();
            pair = factory.createPair(token0, token1);
            vm.stopBroadcast();
            created = true;
        }
        bytes32 predicted = keccak256(
            abi.encodePacked(
                hex"ff", config.factory, keccak256(abi.encodePacked(token0, token1)), config.pairInitCodeHash
            )
        );
        require(pair == address(uint160(uint256(predicted))) && pair.code.length > 0, "PAIR: IDENTITY");
        require(
            factory.getPair(token0, token1) == pair && factory.getPair(token1, token0) == pair
                && IUniswapV2Pair(pair).factory() == config.factory && IUniswapV2Pair(pair).token0() == token0
                && IUniswapV2Pair(pair).token1() == token1,
            "PAIR: REGISTRY"
        );
        emit PairPrepared(config.chainId, config.factory, pair, token0, token1, created);
    }

    function _checkCode(address target, bytes32 expected) private view {
        require(target.code.length > 0 && expected != bytes32(0) && target.codehash == expected, "PAIR: CODE_HASH");
    }
}
