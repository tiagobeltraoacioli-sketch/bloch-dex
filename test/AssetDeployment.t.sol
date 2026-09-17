// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {DeployAsset} from "../script/DeployAsset.s.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";

interface AssetEnvironmentVm {
    function setEnv(string calldata key, string calldata value) external;
}

contract AssetDeploymentTest is TestBase {
    AssetEnvironmentVm constant env = AssetEnvironmentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DeployAsset deployment;

    function setUp() public {
        deployment = new DeployAsset();
        vm.chainId(31337);
        env.setEnv("EXPECTED_CHAIN_ID", "31337");
        env.setEnv("ASSET_NAME", "Local example");
        env.setEnv("ASSET_SYMBOL", "LOCAL");
        env.setEnv("ASSET_SUPPLY_BASE_UNITS", "1000000000000");
        env.setEnv("ASSET_RECIPIENT", "0x00000000000000000000000000000000000A11cE");
    }

    function testRehearsalAndRejectDecimalsBeforeNarrowing() public {
        env.setEnv("ASSET_DECIMALS", "6");
        BlochAsset asset = deployment.run();
        assertEq(asset.balanceOf(address(0xA11CE)), 1_000_000 * 1e6);
        assertEq(asset.totalSupply(), 1_000_000 * 1e6);
        assertEq(asset.decimals(), 6);
        // Environment variables are process-wide; exercise both values in one
        // test so parallel tests never race over ASSET_DECIMALS.
        env.setEnv("ASSET_DECIMALS", "256");
        vm.expectRevert(bytes("ASSET: DECIMALS"));
        deployment.run();
    }

    function testRejectWrongChain() public {
        vm.chainId(31338);
        vm.expectRevert(bytes("DEPLOY: CHAIN_ID"));
        deployment.run();
    }

    function testRejectZeroChain() public {
        vm.chainId(0);
        vm.expectRevert(bytes("DEPLOY: CHAIN_ID"));
        deployment.run();
    }
}
