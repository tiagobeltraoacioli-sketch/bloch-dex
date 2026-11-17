// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {DeployMultichain} from "../script/DeployMultichain.s.sol";

interface MultichainTestVm {
    function setEnv(string calldata, string calldata) external;
    function etch(address, bytes calldata) external;
    function toString(address) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
}

/// @notice script/DeployMultichain.s.sol on a local chain that carries the deterministic CREATE2 deployer's real
///         runtime (read from the public chains, where it is the same code): planned addresses, idempotence, and
///         the refusals.
contract MultichainScriptTest is TestBase {
    MultichainTestVm constant cheats = MultichainTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant FEE_TO = 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544;
    /// @dev The owner's depositing account of the plan under test.
    address constant DEPOSITOR = address(0xA11CE);
    address constant OTHER_DEPOSITOR = address(0xB0B);
    bytes constant DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    DeployMultichain script;
    WBLCH wrapped;
    TestToken token;

    function setUp() public {
        script = new DeployMultichain();
        cheats.etch(script.CREATE2_DEPLOYER(), DEPLOYER_RUNTIME);
        wrapped = new WBLCH();
        token = new TestToken();
        vm.chainId(8453);
    }

    function _env(address firstDepositor) private returns (address factory, address router, address lens) {
        factory = script.predict(script.factoryInitCode(FEE_TO, firstDepositor, new address[](0), new uint256[](0)));
        router = script.predict(script.routerInitCode(factory, address(wrapped)));
        lens = script.predict(script.lensInitCode(factory));
        cheats.setEnv("MC_CHAIN_ID", "8453");
        cheats.setEnv("MC_FEE_TO", cheats.toString(FEE_TO));
        cheats.setEnv("MC_FIRST_DEPOSITOR", cheats.toString(firstDepositor));
        cheats.setEnv("MC_WRAPPED", cheats.toString(address(wrapped)));
        cheats.setEnv("MC_WRAPPED_CODE_HASH", cheats.toString(address(wrapped).codehash));
        cheats.setEnv("MC_EXPECT_FACTORY", cheats.toString(factory));
        cheats.setEnv("MC_EXPECT_ROUTER", cheats.toString(router));
        cheats.setEnv("MC_EXPECT_LENS", cheats.toString(lens));
        cheats.setEnv("MC_PAIR_TOKENS", cheats.toString(address(token)));
        cheats.setEnv("MC_CAP_TOKENS", "");
        cheats.setEnv("MC_CAPS", "");
    }

    /// @dev One test, in sequence: the script reads the process environment, which parallel tests would share.
    function testScriptRefusalsDeploymentIdempotenceAndFirstDepositor() public {
        // 1. Refusals, before anything exists.
        (address factory, address router, address lens) = _env(DEPOSITOR);
        vm.chainId(1);
        vm.expectRevert(bytes("MC: CHAIN_ID"));
        script.run();
        vm.chainId(700770);
        cheats.setEnv("MC_CHAIN_ID", "700770");
        vm.expectRevert(bytes("MC: NOT_FOR_BLOCH_L2"));
        script.run();
        vm.chainId(8453);
        cheats.setEnv("MC_CHAIN_ID", "8453");
        cheats.setEnv("MC_EXPECT_ROUTER", cheats.toString(address(0xdead)));
        vm.expectRevert(bytes("MC: PLAN_ROUTER"));
        script.run();
        _env(DEPOSITOR);
        cheats.setEnv("MC_WRAPPED_CODE_HASH", cheats.toString(bytes32(uint256(1))));
        vm.expectRevert(bytes("MC: WRAPPED_CODE"));
        script.run();
        cheats.etch(script.CREATE2_DEPLOYER(), hex"00");
        vm.expectRevert(bytes("MC: CREATE2_DEPLOYER"));
        script.run();
        cheats.etch(script.CREATE2_DEPLOYER(), DEPLOYER_RUNTIME);
        // Open first deposits are refused before anything is sent (review R309-MC-1).
        _env(address(0));
        vm.expectRevert(bytes("MC: FIRST_DEPOSITOR"));
        script.run();
        // The fee address as the depositing account is refused too (review R328-1: a dedicated key).
        _env(FEE_TO);
        vm.expectRevert(bytes("MC: FIRST_DEPOSITOR_IS_FEE_TO"));
        script.run();

        // 2. The deployment: planned addresses, the owner's fee address, the release candidate's pair code.
        _env(DEPOSITOR);
        assertEq(script.CREATE2_DEPLOYER().codehash, script.CREATE2_DEPLOYER_CODE_HASH());
        assertEq(script.SALT(), keccak256("postern-dex.multichain.v1"));
        DeployMultichain.Result memory r = script.run();
        assertEq(r.factory, factory);
        assertEq(r.router, router);
        assertEq(r.lens, lens);
        assertTrue(!r.factoryExisted && !r.routerExisted && !r.lensExisted);
        assertEq(UniswapV2Factory(factory).feeTo(), FEE_TO);
        assertEq(UniswapV2Factory(factory).firstDepositor(), DEPOSITOR);
        assertEq(UniswapV2Factory(factory).INIT_CODE_PAIR_HASH(), script.PAIR_INIT_CODE_HASH());
        assertEq(BDexRouter(payable(router)).WBLCH(), address(wrapped));
        assertEq(address(BDexLens(lens).factory()), factory);
        assertEq(r.pairs.length, 1);
        assertEq(UniswapV2Factory(factory).getPair(address(wrapped), address(token)), r.pairs[0]);

        // 3. A second run finds everything and deploys nothing.
        DeployMultichain.Result memory again = script.run();
        assertTrue(again.factoryExisted && again.routerExisted && again.lensExisted);
        assertEq(again.factory, r.factory);
        assertEq(again.pairs[0], r.pairs[0]);
        assertEq(UniswapV2Factory(r.factory).allPairsLength(), 1);

        // 4. Another first depositor is another factory address (and so another router and lens).
        (address closed,,) = _env(OTHER_DEPOSITOR);
        assertTrue(closed != factory);
        DeployMultichain.Result memory other = script.run();
        assertEq(other.factory, closed);
        assertTrue(!other.factoryExisted);
        assertEq(UniswapV2Factory(closed).firstDepositor(), OTHER_DEPOSITOR);
    }
}
