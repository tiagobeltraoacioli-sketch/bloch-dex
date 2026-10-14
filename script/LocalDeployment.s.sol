// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";

interface LocalDeploymentVm {
    function envAddress(string calldata) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Local chain 31337 only. No liquidity, approvals, deposits or protocol fees.
/// @dev Sample token quantities are examples, not a backed or redeemable stablecoin.
contract LocalDeployment {
    LocalDeploymentVm constant vm = LocalDeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Deployment {
        address factory;
        address router;
        address lens;
        address wrapped;
        address sampleUsd;
        address sampleAsset;
    }
    event LocalAddresses(uint256 chainId, address recipient, Deployment deployment, bytes32 pairInitCodeHash);

    function run() external returns (Deployment memory result) {
        require(block.chainid == 31337, "LOCAL: CHAIN_ID");
        address recipient = vm.envAddress("LOCAL_RECIPIENT");
        require(recipient != address(0), "LOCAL: RECIPIENT");
        vm.startBroadcast();
        WBLCH wrapped = new WBLCH();
        // Local example: uncapped factory (production caps are set by Deploy.s.sol).
        UniswapV2Factory factory = new UniswapV2Factory(address(0), new address[](0), new uint256[](0));
        BDexRouter router = new BDexRouter(address(factory), address(wrapped));
        BDexLens lens = new BDexLens(address(factory));
        BlochAsset usd = new BlochAsset("Local USD Example", "USD-DEMO", 6, 1_000_000 * 1e6, recipient);
        BlochAsset asset = new BlochAsset("Local Asset Example", "ASSET-DEMO", 18, 1_000_000 ether, recipient);
        vm.stopBroadcast();
        require(factory.feeTo() == address(0) && factory.allPairsLength() == 0, "LOCAL: EMPTY_FACTORY");
        require(wrapped.totalSupply() == 0, "LOCAL: EMPTY_WRAPPER");
        result = Deployment(
            address(factory), address(router), address(lens), address(wrapped), address(usd), address(asset)
        );
        emit LocalAddresses(block.chainid, recipient, result, factory.INIT_CODE_PAIR_HASH());
    }
}
