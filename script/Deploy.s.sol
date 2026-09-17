// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";

interface DeployVm {
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes32(string calldata) external returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Dry run by default. Broadcast requires a separate operator action.
/// @dev No wrapper is deployed and protocol fees are never enabled here.
contract Deploy {
    DeployVm constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event Deployment(
        uint256 chainId,
        address factory,
        address router,
        address lens,
        address collector,
        address wrapped,
        bytes32 pairInitCodeHash
    );

    function run() external {
        uint256 expectedChain = vm.envUint("EXPECTED_CHAIN_ID");
        require(expectedChain != 0 && block.chainid == expectedChain, "DEPLOY: CHAIN_ID");
        address wrapped = vm.envAddress("WBLCH_ADDRESS");
        bytes32 wrapperHash = vm.envBytes32("WBLCH_CODEHASH");
        require(
            wrapped.code.length > 0 && wrapperHash != bytes32(0) && wrapped.codehash == wrapperHash, "DEPLOY: WRAPPER"
        );
        address authority = vm.envAddress("FEE_TO_SETTER");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        require(authority != address(0) && treasury != address(0), "DEPLOY: CUSTODY");
        vm.startBroadcast();
        UniswapV2Factory factory = new UniswapV2Factory(authority);
        BDexRouter router = new BDexRouter(address(factory), wrapped);
        BDexLens lens = new BDexLens(address(factory));
        TreasuryFeeCollector collector = new TreasuryFeeCollector(address(factory), treasury, wrapped);
        vm.stopBroadcast();
        require(factory.feeTo() == address(0), "DEPLOY: FEES_ENABLED");
        require(factory.feeToSetter() == authority, "DEPLOY: AUTHORITY");
        require(router.factory() == address(factory) && router.WBLCH() == wrapped, "DEPLOY: ROUTER");
        require(address(lens.factory()) == address(factory), "DEPLOY: LENS");
        require(
            address(collector.factory()) == address(factory) && collector.treasury() == treasury
                && collector.wblch() == wrapped,
            "DEPLOY: COLLECTOR"
        );
        emit Deployment(
            block.chainid,
            address(factory),
            address(router),
            address(lens),
            address(collector),
            wrapped,
            factory.INIT_CODE_PAIR_HASH()
        );
    }
}
