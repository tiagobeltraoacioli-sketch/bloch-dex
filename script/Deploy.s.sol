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
    function envAddress(string calldata, string calldata) external returns (address[] memory);
    function envUint(string calldata, string calldata) external returns (uint256[] memory);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Dry run by default. Broadcast requires a separate operator action.
/// @dev No wrapper is deployed and protocol fees are never enabled here.
///      Reserve caps (RESERVE_CAP_TOKENS / RESERVE_CAP_AMOUNTS, comma separated)
///      are fixed in the factory constructor; there is no signed cap approval
///      to renew. The wrapper must be capped at no more than the pilot ceiling.
contract Deploy {
    DeployVm constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant MAX_PILOT_WRAPPED_CAP = 10 ether;
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
        (address[] memory capTokens, uint256[] memory caps) = _reserveCaps(wrapped);
        vm.startBroadcast();
        UniswapV2Factory factory = new UniswapV2Factory(authority, capTokens, caps);
        BDexRouter router = new BDexRouter(address(factory), wrapped);
        BDexLens lens = new BDexLens(address(factory));
        TreasuryFeeCollector collector = new TreasuryFeeCollector(address(factory), treasury, wrapped);
        vm.stopBroadcast();
        require(factory.feeTo() == address(0), "DEPLOY: FEES_ENABLED");
        require(factory.feeToSetter() == authority, "DEPLOY: AUTHORITY");
        _checkReserveCaps(factory, capTokens, caps);
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

    function _reserveCaps(address wrapped) private returns (address[] memory capTokens, uint256[] memory caps) {
        capTokens = vm.envAddress("RESERVE_CAP_TOKENS", ",");
        caps = vm.envUint("RESERVE_CAP_AMOUNTS", ",");
        require(capTokens.length == caps.length && capTokens.length > 0, "DEPLOY: CAPS");
        uint256 wrappedCap;
        for (uint256 i; i < capTokens.length; ++i) {
            if (capTokens[i] == wrapped) wrappedCap = caps[i];
        }
        require(wrappedCap != 0 && wrappedCap <= MAX_PILOT_WRAPPED_CAP, "DEPLOY: WRAPPED_CAP");
    }

    function _checkReserveCaps(UniswapV2Factory factory, address[] memory capTokens, uint256[] memory caps)
        private
        view
    {
        for (uint256 i; i < capTokens.length; ++i) {
            require(factory.reserveCap(capTokens[i]) == caps[i], "DEPLOY: CAP_MISMATCH");
        }
    }
}
