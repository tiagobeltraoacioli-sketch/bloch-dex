// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";

struct RecordedLog {
    bytes32[] topics;
    bytes data;
    address emitter;
}

interface DeploymentEnvironmentVm {
    function setEnv(string calldata key, string calldata value) external;
    function toString(address value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function recordLogs() external;
    function getRecordedLogs() external returns (RecordedLog[] memory);
}

contract DeploymentTest is TestBase {
    DeploymentEnvironmentVm private constant env =
        DeploymentEnvironmentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant AUTHORITY = address(0xA11CE);
    address private constant TREASURY = address(0xBEEF);

    Deploy private deployment;
    WBLCH private wrapped;

    function setUp() public {
        vm.chainId(31337);
        deployment = new Deploy();
        wrapped = new WBLCH();
        env.setEnv("EXPECTED_CHAIN_ID", "31337");
        env.setEnv("WBLCH_ADDRESS", env.toString(address(wrapped)));
        env.setEnv("WBLCH_CODEHASH", env.toString(address(wrapped).codehash));
        env.setEnv("FEE_TO_SETTER", env.toString(AUTHORITY));
        env.setEnv("TREASURY_ADDRESS", env.toString(TREASURY));
    }

    // Environment variables are process-wide in Foundry, so positive and
    // negative cases stay in one test instead of racing across test workers.
    function testDeploysBoundPeripheryAndRejectsInvalidConfiguration() public {
        env.recordLogs();
        deployment.run();
        RecordedLog[] memory logs = env.getRecordedLogs();
        RecordedLog memory emitted = logs[logs.length - 1];
        assertEq(emitted.emitter, address(deployment));
        assertEq(emitted.topics[0], Deploy.Deployment.selector);
        (
            uint256 chainId,
            address factoryAddress,
            address routerAddress,
            address lensAddress,
            address collectorAddress,
            address wrappedAddress,
            bytes32 pairHash
        ) = abi.decode(emitted.data, (uint256, address, address, address, address, address, bytes32));

        UniswapV2Factory factory = UniswapV2Factory(factoryAddress);
        BDexRouter router = BDexRouter(payable(routerAddress));
        BDexLens lens = BDexLens(lensAddress);
        TreasuryFeeCollector collector = TreasuryFeeCollector(collectorAddress);
        assertEq(chainId, block.chainid);
        assertEq(wrappedAddress, address(wrapped));
        assertEq(factory.feeTo(), address(0));
        assertEq(factory.feeToSetter(), AUTHORITY);
        assertEq(factory.pendingFeeToSetter(), address(0));
        assertEq(factory.allPairsLength(), 0);
        assertEq(router.factory(), factoryAddress);
        assertEq(router.WBLCH(), address(wrapped));
        assertEq(address(lens.factory()), factoryAddress);
        assertEq(address(collector.factory()), factoryAddress);
        assertEq(collector.treasury(), TREASURY);
        assertEq(collector.wblch(), address(wrapped));
        assertEq(pairHash, factory.INIT_CODE_PAIR_HASH());
        vm.expectRevert(bytes("BDEX: FORBIDDEN"));
        factory.setFeeTo(TREASURY);

        vm.chainId(31338);
        vm.expectRevert(bytes("DEPLOY: CHAIN_ID"));
        deployment.run();
        vm.chainId(31337);

        env.setEnv("WBLCH_CODEHASH", env.toString(bytes32(uint256(1))));
        vm.expectRevert(bytes("DEPLOY: WRAPPER"));
        deployment.run();
        env.setEnv("WBLCH_CODEHASH", env.toString(address(wrapped).codehash));

        env.setEnv("FEE_TO_SETTER", env.toString(address(0)));
        vm.expectRevert(bytes("DEPLOY: CUSTODY"));
        deployment.run();
        env.setEnv("FEE_TO_SETTER", env.toString(AUTHORITY));
        env.setEnv("TREASURY_ADDRESS", env.toString(address(0)));
        vm.expectRevert(bytes("DEPLOY: CUSTODY"));
        deployment.run();
    }
}
