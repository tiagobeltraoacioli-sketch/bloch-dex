// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {IUniswapV2Pair} from "../contracts/interfaces/IUniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";

interface MainnetVm {
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes32(string calldata) external returns (bytes32);
    function envBool(string calldata) external returns (bool);
    function envOr(string calldata, bool) external returns (bool);
    function envOr(string calldata, string calldata, address[] calldata) external returns (address[] memory);
    function envOr(string calldata, string calldata, uint256[] calldata) external returns (uint256[] memory);
    function getNonce(address) external view returns (uint64);
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

/// @notice Deterministic Bloch L2 mainnet DEX deployment.
/// @dev Never run directly: `scripts/staging/deploy-dex.mjs run` derives every
///      DEX_* variable from one reviewed JSON configuration and its committed
///      plan (expected CREATE/CREATE2 addresses, init and runtime code hashes),
///      after checking the RPC's chain ID, pinned genesis hash, deployer nonce
///      and external code hashes. Without `--broadcast` forge only simulates
///      (dry run). This script re-checks the chain ID, the devnet/rehearsal
///      guard, the deployer nonce and every planned address and code hash on
///      its own, so a hand-assembled environment cannot skip them.
///      Order (one deployer, consecutive nonces): [WBLCH], factory, router,
///      lens, collector, then one createPair call per planned pair. Protocol
///      fees stay off; there is no liquidity, approval or fee action here.
contract DeployMainnet {
    MainnetVm constant vm = MainnetVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Development chains: devnet4 L2 and a local anvil. Running against
    ///      them is a rehearsal and must be declared (DEX_REHEARSAL=true).
    uint256 public constant DEVNET4_CHAIN_ID = 700771;
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    /// @dev Retired scaffolds: never a target, not even for a rehearsal.
    uint256 public constant RETIRED_CHAIN_ID_A = 8400;
    uint256 public constant RETIRED_CHAIN_ID_B = 84001;
    /// @dev Same technical ceiling as Deploy.s.sol and the deploy config validator.
    uint256 public constant MAX_WRAPPED_CAP = 10 ether;
    bytes32 public constant EMPTY_CODE_HASH = keccak256("");

    struct Planned {
        address wrapped;
        bytes32 wrappedCodeHash;
        address factory;
        bytes32 factoryCodeHash;
        address router;
        bytes32 routerCodeHash;
        address lens;
        bytes32 lensCodeHash;
        address collector;
        bytes32 collectorCodeHash;
        bytes32 pairInitCodeHash;
        bytes32 pairCodeHash;
    }

    struct Settings {
        bytes32 configSha256;
        address deployer;
        uint256 startNonce;
        bool deployWrapped;
        address feeToSetter;
        bytes32 feeToSetterCodeHash;
        address treasury;
        bytes32 treasuryCodeHash;
        address[] capTokens;
        uint256[] caps;
        address[] pairTokensA;
        address[] pairTokensB;
        address[] pairs;
    }

    event MainnetDeployment(
        bytes32 configSha256,
        uint256 chainId,
        address deployer,
        address wrapped,
        address factory,
        address router,
        address lens,
        address collector,
        bytes32 pairInitCodeHash,
        address[] pairs
    );

    function run() external {
        execute(vm.envUint("DEX_CHAIN_ID"), vm.envOr("DEX_REHEARSAL", false), _settings(), _planned());
    }

    /// @notice Deploy from typed inputs. `run` feeds it from the DEX_*
    ///         environment; tests call it directly.
    function execute(uint256 chainId, bool rehearsal, Settings memory s, Planned memory p) public {
        checkChain(block.chainid, chainId, rehearsal);
        _checkSettings(s);
        require(vm.getNonce(s.deployer) == s.startNonce, "MAINNET: DEPLOYER_NONCE");
        _checkPreconditions(s, p);

        vm.startBroadcast(s.deployer);
        if (s.deployWrapped) require(address(new WBLCH()) == p.wrapped, "MAINNET: WRAPPED_ADDRESS");
        UniswapV2Factory factory = new UniswapV2Factory(s.feeToSetter, s.capTokens, s.caps);
        BDexRouter router = new BDexRouter(address(factory), p.wrapped);
        BDexLens lens = new BDexLens(address(factory));
        TreasuryFeeCollector collector = new TreasuryFeeCollector(address(factory), s.treasury, p.wrapped);
        for (uint256 i; i < s.pairs.length; ++i) {
            require(factory.createPair(s.pairTokensA[i], s.pairTokensB[i]) == s.pairs[i], "MAINNET: PAIR_ADDRESS");
        }
        vm.stopBroadcast();

        require(address(factory) == p.factory, "MAINNET: FACTORY_ADDRESS");
        require(address(router) == p.router, "MAINNET: ROUTER_ADDRESS");
        require(address(lens) == p.lens, "MAINNET: LENS_ADDRESS");
        require(address(collector) == p.collector, "MAINNET: COLLECTOR_ADDRESS");
        _checkDeployment(s, p, factory, router, lens, collector);
        emit MainnetDeployment(
            s.configSha256,
            block.chainid,
            s.deployer,
            p.wrapped,
            address(factory),
            address(router),
            address(lens),
            address(collector),
            p.pairInitCodeHash,
            s.pairs
        );
    }

    /// @notice The chain guard, public so tests pin it.
    function checkChain(uint256 actual, uint256 expected, bool rehearsal) public pure {
        require(expected != 0 && actual == expected, "MAINNET: CHAIN_ID");
        require(actual != RETIRED_CHAIN_ID_A && actual != RETIRED_CHAIN_ID_B, "MAINNET: RETIRED_CHAIN");
        bool development = actual == DEVNET4_CHAIN_ID || actual == LOCAL_CHAIN_ID;
        require(development == rehearsal, development ? "MAINNET: DEVNET_NEEDS_REHEARSAL" : "MAINNET: NOT_A_REHEARSAL");
    }

    function _settings() private returns (Settings memory s) {
        s.configSha256 = vm.envBytes32("DEX_CONFIG_SHA256");
        s.deployer = vm.envAddress("DEX_DEPLOYER");
        s.startNonce = vm.envUint("DEX_START_NONCE");
        s.deployWrapped = vm.envBool("DEX_DEPLOY_WRAPPED");
        s.feeToSetter = vm.envAddress("DEX_FEE_TO_SETTER");
        s.feeToSetterCodeHash = vm.envBytes32("DEX_FEE_TO_SETTER_CODEHASH");
        s.treasury = vm.envAddress("DEX_TREASURY");
        s.treasuryCodeHash = vm.envBytes32("DEX_TREASURY_CODEHASH");
        s.capTokens = vm.envOr("DEX_CAP_TOKENS", ",", new address[](0));
        s.caps = vm.envOr("DEX_CAP_AMOUNTS", ",", new uint256[](0));
        s.pairTokensA = vm.envOr("DEX_PAIR_TOKENS_A", ",", new address[](0));
        s.pairTokensB = vm.envOr("DEX_PAIR_TOKENS_B", ",", new address[](0));
        s.pairs = vm.envOr("DEX_PAIRS", ",", new address[](0));
    }

    function _checkSettings(Settings memory s) private pure {
        require(s.configSha256 != bytes32(0) && s.deployer != address(0), "MAINNET: SETTINGS");
        require(
            s.feeToSetter != address(0) && s.treasury != address(0) && s.feeToSetter != s.treasury
                && s.feeToSetter != s.deployer && s.treasury != s.deployer,
            "MAINNET: ROLES"
        );
        require(s.capTokens.length == s.caps.length && s.capTokens.length > 0, "MAINNET: CAPS");
        require(
            s.pairTokensA.length == s.pairs.length && s.pairTokensB.length == s.pairs.length, "MAINNET: PAIR_LENGTH"
        );
    }

    function _planned() private returns (Planned memory p) {
        p.wrapped = vm.envAddress("DEX_WRAPPED");
        p.wrappedCodeHash = vm.envBytes32("DEX_WRAPPED_CODEHASH");
        p.factory = vm.envAddress("DEX_FACTORY");
        p.factoryCodeHash = vm.envBytes32("DEX_FACTORY_CODEHASH");
        p.router = vm.envAddress("DEX_ROUTER");
        p.routerCodeHash = vm.envBytes32("DEX_ROUTER_CODEHASH");
        p.lens = vm.envAddress("DEX_LENS");
        p.lensCodeHash = vm.envBytes32("DEX_LENS_CODEHASH");
        p.collector = vm.envAddress("DEX_COLLECTOR");
        p.collectorCodeHash = vm.envBytes32("DEX_COLLECTOR_CODEHASH");
        p.pairInitCodeHash = vm.envBytes32("DEX_PAIR_INIT_CODE_HASH");
        p.pairCodeHash = vm.envBytes32("DEX_PAIR_CODEHASH");
    }

    /// @dev Nothing may already live at a planned address, the pinned role
    ///      and token code must be what was reviewed, and the wrapper cap
    ///      must be present and inside the technical ceiling.
    function _checkPreconditions(Settings memory s, Planned memory p) private view {
        _checkRole(s.feeToSetter, s.feeToSetterCodeHash, "MAINNET: FEE_TO_SETTER_CODE");
        _checkRole(s.treasury, s.treasuryCodeHash, "MAINNET: TREASURY_CODE");
        if (s.deployWrapped) {
            require(p.wrapped.code.length == 0, "MAINNET: WRAPPED_OCCUPIED");
        } else {
            require(p.wrapped.code.length > 0 && p.wrapped.codehash == p.wrappedCodeHash, "MAINNET: WRAPPED_CODE");
        }
        require(
            p.factory.code.length == 0 && p.router.code.length == 0 && p.lens.code.length == 0
                && p.collector.code.length == 0,
            "MAINNET: ADDRESS_OCCUPIED"
        );
        for (uint256 i; i < s.pairs.length; ++i) {
            require(s.pairs[i].code.length == 0, "MAINNET: PAIR_OCCUPIED");
        }
        uint256 wrappedCap;
        for (uint256 i; i < s.capTokens.length; ++i) {
            if (s.capTokens[i] == p.wrapped) wrappedCap = s.caps[i];
        }
        require(wrappedCap != 0 && wrappedCap <= MAX_WRAPPED_CAP, "MAINNET: WRAPPED_CAP");
    }

    /// @dev A reviewed EOA is pinned by the empty-code hash; an account that
    ///      was never touched reports codehash 0, so code length decides.
    function _checkRole(address role, bytes32 codeHash, string memory reason) private view {
        if (codeHash == EMPTY_CODE_HASH) require(role.code.length == 0, reason);
        else require(role.code.length > 0 && role.codehash == codeHash, reason);
    }

    function _checkDeployment(
        Settings memory s,
        Planned memory p,
        UniswapV2Factory factory,
        BDexRouter router,
        BDexLens lens,
        TreasuryFeeCollector collector
    ) private view {
        require(p.wrapped.codehash == p.wrappedCodeHash, "MAINNET: WRAPPED_CODEHASH");
        require(address(factory).codehash == p.factoryCodeHash, "MAINNET: FACTORY_CODEHASH");
        require(address(router).codehash == p.routerCodeHash, "MAINNET: ROUTER_CODEHASH");
        require(address(lens).codehash == p.lensCodeHash, "MAINNET: LENS_CODEHASH");
        require(address(collector).codehash == p.collectorCodeHash, "MAINNET: COLLECTOR_CODEHASH");
        require(factory.INIT_CODE_PAIR_HASH() == p.pairInitCodeHash, "MAINNET: INIT_CODE_HASH");
        require(
            factory.feeTo() == address(0) && factory.feeToSetter() == s.feeToSetter
                && factory.pendingFeeToSetter() == address(0),
            "MAINNET: FEE_STATE"
        );
        for (uint256 i; i < s.capTokens.length; ++i) {
            require(factory.reserveCap(s.capTokens[i]) == s.caps[i], "MAINNET: CAP_MISMATCH");
        }
        require(router.factory() == address(factory) && router.WBLCH() == p.wrapped, "MAINNET: ROUTER");
        require(address(lens.factory()) == address(factory), "MAINNET: LENS");
        require(
            address(collector.factory()) == address(factory) && collector.treasury() == s.treasury
                && collector.wblch() == p.wrapped,
            "MAINNET: COLLECTOR"
        );
        require(factory.allPairsLength() == s.pairs.length, "MAINNET: PAIR_COUNT");
        for (uint256 i; i < s.pairs.length; ++i) {
            IUniswapV2Pair pair = IUniswapV2Pair(s.pairs[i]);
            require(s.pairs[i].codehash == p.pairCodeHash, "MAINNET: PAIR_CODEHASH");
            require(pair.totalSupply() == 0, "MAINNET: PAIR_NOT_EMPTY");
            require(
                factory.getPair(s.pairTokensA[i], s.pairTokensB[i]) == s.pairs[i] && pair.factory() == address(factory),
                "MAINNET: PAIR_REGISTRY"
            );
        }
    }
}
