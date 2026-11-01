// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {IUniswapV2Pair} from "../contracts/interfaces/IUniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
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
///      lens, then one createPair call per planned pair. The factory fixes the
///      protocol fee recipient to Bloch Inc (a reviewed multisig contract) in
///      its constructor; nothing can change it afterwards. There is no
///      liquidity, approval or other action here.
contract DeployMainnet {
    MainnetVm constant vm = MainnetVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Chain IDs mirror deployments/networks.json (a Node test keeps
    ///      them equal). The Bloch L2 mainnet is the only non-rehearsal target.
    uint256 public constant MAINNET_CHAIN_ID = 700770;
    /// @dev Development chains: devnet4 L2 and a local anvil. Running against
    ///      them is a rehearsal and must be declared (DEX_REHEARSAL=true).
    uint256 public constant DEVNET4_CHAIN_ID = 700771;
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    /// @dev Retired scaffolds: never a target, not even for a rehearsal.
    uint256 public constant RETIRED_CHAIN_ID_A = 8400;
    uint256 public constant RETIRED_CHAIN_ID_B = 84001;
    /// @dev Same technical ceiling as the deploy config validator and the gate.
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
        bytes32 pairInitCodeHash;
        bytes32 pairCodeHash;
    }

    struct Settings {
        bytes32 configSha256;
        address deployer;
        address firstDepositor;
        uint256 startNonce;
        bool deployWrapped;
        address blochInc;
        bytes32 blochIncCodeHash;
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
        address feeTo,
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
        UniswapV2Factory factory = new UniswapV2Factory(s.blochInc, s.firstDepositor, s.capTokens, s.caps);
        BDexRouter router = new BDexRouter(address(factory), p.wrapped);
        BDexLens lens = new BDexLens(address(factory));
        for (uint256 i; i < s.pairs.length; ++i) {
            require(factory.createPair(s.pairTokensA[i], s.pairTokensB[i]) == s.pairs[i], "MAINNET: PAIR_ADDRESS");
        }
        vm.stopBroadcast();

        require(address(factory) == p.factory, "MAINNET: FACTORY_ADDRESS");
        require(address(router) == p.router, "MAINNET: ROUTER_ADDRESS");
        require(address(lens) == p.lens, "MAINNET: LENS_ADDRESS");
        _checkDeployment(s, p, factory, router, lens);
        emit MainnetDeployment(
            s.configSha256,
            block.chainid,
            s.deployer,
            p.wrapped,
            address(factory),
            address(router),
            address(lens),
            s.blochInc,
            p.pairInitCodeHash,
            s.pairs
        );
    }

    /// @notice The chain guard, public so tests pin it.
    function checkChain(uint256 actual, uint256 expected, bool rehearsal) public pure {
        require(expected != 0 && actual == expected, "MAINNET: CHAIN_ID");
        require(actual != RETIRED_CHAIN_ID_A && actual != RETIRED_CHAIN_ID_B, "MAINNET: RETIRED_CHAIN");
        bool development = actual == DEVNET4_CHAIN_ID || actual == LOCAL_CHAIN_ID;
        require(development || actual == MAINNET_CHAIN_ID, "MAINNET: UNKNOWN_CHAIN");
        require(development == rehearsal, development ? "MAINNET: DEVNET_NEEDS_REHEARSAL" : "MAINNET: NOT_A_REHEARSAL");
    }

    function _settings() private returns (Settings memory s) {
        s.configSha256 = vm.envBytes32("DEX_CONFIG_SHA256");
        s.deployer = vm.envAddress("DEX_DEPLOYER");
        s.firstDepositor = vm.envAddress("DEX_FIRST_DEPOSITOR");
        s.startNonce = vm.envUint("DEX_START_NONCE");
        s.deployWrapped = vm.envBool("DEX_DEPLOY_WRAPPED");
        s.blochInc = vm.envAddress("DEX_BLOCH_INC");
        s.blochIncCodeHash = vm.envBytes32("DEX_BLOCH_INC_CODEHASH");
        s.capTokens = vm.envOr("DEX_CAP_TOKENS", ",", new address[](0));
        s.caps = vm.envOr("DEX_CAP_AMOUNTS", ",", new uint256[](0));
        s.pairTokensA = vm.envOr("DEX_PAIR_TOKENS_A", ",", new address[](0));
        s.pairTokensB = vm.envOr("DEX_PAIR_TOKENS_B", ",", new address[](0));
        s.pairs = vm.envOr("DEX_PAIRS", ",", new address[](0));
    }

    function _checkSettings(Settings memory s) private pure {
        require(s.configSha256 != bytes32(0) && s.deployer != address(0), "MAINNET: SETTINGS");
        require(s.blochInc != address(0) && s.blochInc != s.deployer, "MAINNET: ROLES");
        // address(0) would turn the first-deposit rule off with no error.
        require(
            s.firstDepositor != address(0) && s.firstDepositor != s.deployer && s.firstDepositor != s.blochInc,
            "MAINNET: FIRST_DEPOSITOR"
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
        p.pairInitCodeHash = vm.envBytes32("DEX_PAIR_INIT_CODE_HASH");
        p.pairCodeHash = vm.envBytes32("DEX_PAIR_CODEHASH");
    }

    /// @dev Nothing may already live at a planned address, Bloch Inc must be
    ///      the reviewed multisig contract (never an EOA: the fee recipient is
    ///      permanent, so it must not hinge on one key), and the wrapper cap
    ///      must be present and inside the technical ceiling.
    function _checkPreconditions(Settings memory s, Planned memory p) private view {
        require(
            s.firstDepositor.code.length == 0 && vm.getNonce(s.firstDepositor) == 0, "MAINNET: FIRST_DEPOSITOR_USED"
        );
        require(
            s.blochIncCodeHash != EMPTY_CODE_HASH && s.blochInc.code.length > 0
                && s.blochInc.codehash == s.blochIncCodeHash,
            "MAINNET: BLOCH_INC_CODE"
        );
        if (s.deployWrapped) {
            require(p.wrapped.code.length == 0, "MAINNET: WRAPPED_OCCUPIED");
        } else {
            require(p.wrapped.code.length > 0 && p.wrapped.codehash == p.wrappedCodeHash, "MAINNET: WRAPPED_CODE");
        }
        require(
            p.factory.code.length == 0 && p.router.code.length == 0 && p.lens.code.length == 0,
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

    function _checkDeployment(
        Settings memory s,
        Planned memory p,
        UniswapV2Factory factory,
        BDexRouter router,
        BDexLens lens
    ) private view {
        require(p.wrapped.codehash == p.wrappedCodeHash, "MAINNET: WRAPPED_CODEHASH");
        require(address(factory).codehash == p.factoryCodeHash, "MAINNET: FACTORY_CODEHASH");
        require(address(router).codehash == p.routerCodeHash, "MAINNET: ROUTER_CODEHASH");
        require(address(lens).codehash == p.lensCodeHash, "MAINNET: LENS_CODEHASH");
        require(factory.INIT_CODE_PAIR_HASH() == p.pairInitCodeHash, "MAINNET: INIT_CODE_HASH");
        require(factory.feeTo() == s.blochInc, "MAINNET: FEE_STATE");
        require(factory.firstDepositor() == s.firstDepositor, "MAINNET: FIRST_DEPOSITOR_STATE");
        for (uint256 i; i < s.capTokens.length; ++i) {
            require(factory.reserveCap(s.capTokens[i]) == s.caps[i], "MAINNET: CAP_MISMATCH");
        }
        require(router.factory() == address(factory) && router.WBLCH() == p.wrapped, "MAINNET: ROUTER");
        require(address(lens.factory()) == address(factory), "MAINNET: LENS");
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
