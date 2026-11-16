// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";

interface MultichainVm {
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes32(string calldata) external returns (bytes32);
    function envOr(string calldata, string calldata, address[] calldata) external returns (address[] memory);
    function envOr(string calldata, string calldata, uint256[] calldata) external returns (uint256[] memory);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice The DEX on a public EVM chain other than the Bloch L2: factory, router and lens through the
///         deterministic CREATE2 deployer with one fixed salt. The contracts are the Bloch L2 release candidate,
///         byte for byte; everything chain-specific is a constructor argument.
/// @dev Never run directly: `scripts/multichain/deploy.sh <chain>` derives every MC_* variable from the reviewed
///      files `deployments/multichain.json` and `deployments/<chain>/chain.json`, after reading the chain. Without
///      `--broadcast` forge only simulates. The addresses do not depend on who sends the transactions: anyone
///      who publishes the same init code through the same deployer with the same salt creates the same contract
///      with the same immutable arguments, so a step that already has code is skipped and then checked like the
///      others. Nothing here adds liquidity, approves or moves a token.
///      Order: factory, router, lens, then one permissionless `createPair` per MC_PAIR_TOKENS entry (optional).
contract DeployMultichain {
    MultichainVm constant vm = MultichainVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev "Deterministic deployment proxy" (Arachnid): calldata = salt ++ init code, returns the address.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 public constant CREATE2_DEPLOYER_CODE_HASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;
    /// @dev keccak256("postern-dex.multichain.v1"); scripts/multichain/lib.mjs derives the same value.
    bytes32 public constant SALT = 0xe5077402c0b97c1add3f60378312fa299385d66cf04b5d4576eb6db377d3c57a;
    /// @dev The release candidate's pair init code hash; a build with other compiler settings is refused.
    bytes32 public constant PAIR_INIT_CODE_HASH = 0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683;
    /// @dev The Bloch L2 chains have their own procedure (script/DeployMainnet.s.sol) and are refused here.
    uint256 public constant BLOCH_L2_MAINNET = 700770;
    uint256 public constant BLOCH_L2_DEVNET4 = 700771;

    struct Result {
        address factory;
        address router;
        address lens;
        address[] pairs;
        bool factoryExisted;
        bool routerExisted;
        bool lensExisted;
    }

    event MultichainAddresses(uint256 chainId, Result result);

    function factoryInitCode(address feeTo, address firstDepositor, address[] memory capTokens, uint256[] memory caps)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(type(UniswapV2Factory).creationCode, abi.encode(feeTo, firstDepositor, capTokens, caps));
    }

    function routerInitCode(address factory, address wrapped) public pure returns (bytes memory) {
        return abi.encodePacked(type(BDexRouter).creationCode, abi.encode(factory, wrapped));
    }

    function lensInitCode(address factory) public pure returns (bytes memory) {
        return abi.encodePacked(type(BDexLens).creationCode, abi.encode(factory));
    }

    function predict(bytes memory initCode) public pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, keccak256(initCode)))))
        );
    }

    /// @dev One CREATE2 through the deployer, or nothing when the address already has code.
    function _deploy(bytes memory initCode) private returns (address at, bool existed) {
        at = predict(initCode);
        if (at.code.length != 0) return (at, true);
        (bool ok, bytes memory out) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        require(ok && out.length == 20, "MC: CREATE2_FAILED");
        require(address(bytes20(out)) == at, "MC: CREATE2_ADDRESS");
        require(at.code.length != 0, "MC: NO_CODE");
    }

    function run() external returns (Result memory r) {
        uint256 chainId = vm.envUint("MC_CHAIN_ID");
        require(block.chainid == chainId, "MC: CHAIN_ID");
        require(chainId != BLOCH_L2_MAINNET && chainId != BLOCH_L2_DEVNET4, "MC: NOT_FOR_BLOCH_L2");
        require(CREATE2_DEPLOYER.codehash == CREATE2_DEPLOYER_CODE_HASH, "MC: CREATE2_DEPLOYER");
        address feeTo = vm.envAddress("MC_FEE_TO");
        address firstDepositor = vm.envAddress("MC_FIRST_DEPOSITOR");
        address wrapped = vm.envAddress("MC_WRAPPED");
        require(feeTo != address(0), "MC: FEE_TO");
        require(wrapped.codehash == vm.envBytes32("MC_WRAPPED_CODE_HASH"), "MC: WRAPPED_CODE");
        address[] memory capTokens = vm.envOr("MC_CAP_TOKENS", ",", new address[](0));
        uint256[] memory caps = vm.envOr("MC_CAPS", ",", new uint256[](0));
        address[] memory pairTokens = vm.envOr("MC_PAIR_TOKENS", ",", new address[](0));

        bytes memory factoryCode = factoryInitCode(feeTo, firstDepositor, capTokens, caps);
        address factory = predict(factoryCode);
        require(factory == vm.envAddress("MC_EXPECT_FACTORY"), "MC: PLAN_FACTORY");
        bytes memory routerCode = routerInitCode(factory, wrapped);
        require(predict(routerCode) == vm.envAddress("MC_EXPECT_ROUTER"), "MC: PLAN_ROUTER");
        bytes memory lensCode = lensInitCode(factory);
        require(predict(lensCode) == vm.envAddress("MC_EXPECT_LENS"), "MC: PLAN_LENS");

        vm.startBroadcast();
        (r.factory, r.factoryExisted) = _deploy(factoryCode);
        (r.router, r.routerExisted) = _deploy(routerCode);
        (r.lens, r.lensExisted) = _deploy(lensCode);
        r.pairs = new address[](pairTokens.length);
        for (uint256 i; i < pairTokens.length; ++i) {
            address pair = UniswapV2Factory(r.factory).getPair(wrapped, pairTokens[i]);
            if (pair == address(0)) pair = UniswapV2Factory(r.factory).createPair(wrapped, pairTokens[i]);
            r.pairs[i] = pair;
        }
        vm.stopBroadcast();

        UniswapV2Factory f = UniswapV2Factory(r.factory);
        require(f.feeTo() == feeTo && f.firstDepositor() == firstDepositor, "MC: FACTORY_ARGS");
        require(f.INIT_CODE_PAIR_HASH() == PAIR_INIT_CODE_HASH, "MC: PAIR_INIT_CODE_HASH");
        for (uint256 i; i < capTokens.length; ++i) {
            require(f.reserveCap(capTokens[i]) == caps[i], "MC: CAP");
        }
        require(BDexRouter(payable(r.router)).factory() == r.factory, "MC: ROUTER_FACTORY");
        require(BDexRouter(payable(r.router)).WBLCH() == wrapped, "MC: ROUTER_WRAPPED");
        require(address(BDexLens(r.lens).factory()) == r.factory, "MC: LENS_FACTORY");
        emit MultichainAddresses(block.chainid, r);
    }
}
