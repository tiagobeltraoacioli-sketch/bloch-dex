// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlochAsset} from "../contracts/assets/BlochAsset.sol";

interface AssetDeployVm {
    function envUint(string calldata) external returns (uint256);
    function envString(string calldata) external returns (string memory);
    function envAddress(string calldata) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Separate asset issuance rehearsal; does not create pools or enable fees.
/// @dev Chain ID is an error guard, not proof of genesis identity or network security.
contract DeployAsset {
    AssetDeployVm constant vm = AssetDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event AssetDeployment(uint256 chainId, address asset, address recipient, uint256 supply, uint8 decimals);

    function run() external returns (BlochAsset asset) {
        uint256 expectedChain = vm.envUint("EXPECTED_CHAIN_ID");
        require(expectedChain != 0 && block.chainid == expectedChain, "DEPLOY: CHAIN_ID");
        string memory name = vm.envString("ASSET_NAME");
        string memory symbol = vm.envString("ASSET_SYMBOL");
        uint256 decimals = vm.envUint("ASSET_DECIMALS");
        require(decimals <= 18, "ASSET: DECIMALS");
        uint256 supply = vm.envUint("ASSET_SUPPLY_BASE_UNITS");
        address recipient = vm.envAddress("ASSET_RECIPIENT");
        vm.startBroadcast();
        // forge-lint: disable-next-line(unsafe-typecast)
        asset = new BlochAsset(name, symbol, uint8(decimals), supply, recipient);
        vm.stopBroadcast();
        assert(asset.totalSupply() == supply && asset.balanceOf(recipient) == supply);
        emit AssetDeployment(block.chainid, address(asset), recipient, supply, asset.decimals());
    }
}
