// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";

interface DeployTestVm {
    function setEnv(string calldata, string calldata) external;
    function toString(address) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function computeCreateAddress(address, uint256) external pure returns (address);
    function computeCreate2Address(bytes32, bytes32, address) external pure returns (address);
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
    function chainId(uint256) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function getNonce(address) external view returns (uint64);
    function etch(address, bytes calldata) external;
}

/// The mainnet deployment script: chain guard, deterministic addresses and
/// the self-checks that make a hand-assembled environment fail closed.
contract DeployMainnetTest is TestBase {
    DeployTestVm internal constant hevm = DeployTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant MAINNET_LIKE_CHAIN = 7_007_700;
    address internal constant DEPLOYER = address(0xD0D0);
    address internal constant FEE_TO_SETTER = address(0xFEE5);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant ISSUER = address(0x1551);
    bytes32 internal constant EMPTY = keccak256("");

    DeployMainnet internal script;
    address internal asset;

    struct Expected {
        address wrapped;
        address factory;
        address router;
        address lens;
        address collector;
        address pair;
        bytes32 wrappedHash;
        bytes32 factoryHash;
        bytes32 routerHash;
        bytes32 lensHash;
        bytes32 collectorHash;
        bytes32 pairInitHash;
        bytes32 pairHash;
    }

    function setUp() public {
        script = new DeployMainnet();
        hevm.prank(ISSUER);
        asset = address(new BlochAsset("Pilot Asset", "PILOT", 6, 1e12, ISSUER));
    }

    function testChainGuard() public {
        script.checkChain(MAINNET_LIKE_CHAIN, MAINNET_LIKE_CHAIN, false);
        script.checkChain(700771, 700771, true);
        script.checkChain(31337, 31337, true);
        hevm.expectRevert(bytes("MAINNET: DEVNET_NEEDS_REHEARSAL"));
        script.checkChain(700771, 700771, false);
        hevm.expectRevert(bytes("MAINNET: DEVNET_NEEDS_REHEARSAL"));
        script.checkChain(31337, 31337, false);
        hevm.expectRevert(bytes("MAINNET: NOT_A_REHEARSAL"));
        script.checkChain(MAINNET_LIKE_CHAIN, MAINNET_LIKE_CHAIN, true);
        hevm.expectRevert(bytes("MAINNET: CHAIN_ID"));
        script.checkChain(700771, MAINNET_LIKE_CHAIN, false);
        hevm.expectRevert(bytes("MAINNET: CHAIN_ID"));
        script.checkChain(1, 0, false);
        hevm.expectRevert(bytes("MAINNET: RETIRED_CHAIN"));
        script.checkChain(8400, 8400, false);
        hevm.expectRevert(bytes("MAINNET: RETIRED_CHAIN"));
        script.checkChain(84001, 84001, true);
    }

    /// Learn the runtime hashes by deploying once, then roll back so the
    /// script deploys from the same nonces.
    function _expected() internal returns (Expected memory e) {
        uint256 nonce = hevm.getNonce(DEPLOYER);
        e.wrapped = hevm.computeCreateAddress(DEPLOYER, nonce);
        e.factory = hevm.computeCreateAddress(DEPLOYER, nonce + 1);
        e.router = hevm.computeCreateAddress(DEPLOYER, nonce + 2);
        e.lens = hevm.computeCreateAddress(DEPLOYER, nonce + 3);
        e.collector = hevm.computeCreateAddress(DEPLOYER, nonce + 4);
        uint256 snapshot = hevm.snapshotState();
        (address[] memory capTokens, uint256[] memory caps) = _caps(e.wrapped);
        hevm.prank(DEPLOYER);
        WBLCH w = new WBLCH();
        hevm.prank(DEPLOYER);
        UniswapV2Factory f = new UniswapV2Factory(FEE_TO_SETTER, capTokens, caps);
        hevm.prank(DEPLOYER);
        BDexRouter r = new BDexRouter(address(f), address(w));
        hevm.prank(DEPLOYER);
        BDexLens l = new BDexLens(address(f));
        hevm.prank(DEPLOYER);
        TreasuryFeeCollector c = new TreasuryFeeCollector(address(f), TREASURY, address(w));
        address p = f.createPair(address(w), asset);
        require(address(f) == e.factory && address(c) == e.collector, "fixture nonce drift");
        (e.wrappedHash, e.factoryHash, e.routerHash) = (address(w).codehash, address(f).codehash, address(r).codehash);
        (e.lensHash, e.collectorHash, e.pairHash) = (address(l).codehash, address(c).codehash, p.codehash);
        e.pairInitHash = f.INIT_CODE_PAIR_HASH();
        e.pair = p;
        hevm.revertToState(snapshot);
    }

    function _caps(address wrapped) internal view returns (address[] memory capTokens, uint256[] memory caps) {
        capTokens = new address[](2);
        caps = new uint256[](2);
        (capTokens[0], caps[0]) = (wrapped, 1 ether);
        (capTokens[1], caps[1]) = (asset, 10e6);
    }

    function _inputs(Expected memory e)
        internal
        view
        returns (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p)
    {
        s.configSha256 = keccak256("reviewed config");
        s.deployer = DEPLOYER;
        s.startNonce = hevm.getNonce(DEPLOYER);
        s.deployWrapped = true;
        (s.feeToSetter, s.feeToSetterCodeHash) = (FEE_TO_SETTER, EMPTY);
        (s.treasury, s.treasuryCodeHash) = (TREASURY, EMPTY);
        (s.capTokens, s.caps) = _caps(e.wrapped);
        s.pairTokensA = new address[](1);
        s.pairTokensB = new address[](1);
        s.pairs = new address[](1);
        (s.pairTokensA[0], s.pairTokensB[0], s.pairs[0]) = (e.wrapped, asset, e.pair);
        (p.wrapped, p.wrappedCodeHash) = (e.wrapped, e.wrappedHash);
        (p.factory, p.factoryCodeHash) = (e.factory, e.factoryHash);
        (p.router, p.routerCodeHash) = (e.router, e.routerHash);
        (p.lens, p.lensCodeHash) = (e.lens, e.lensHash);
        (p.collector, p.collectorCodeHash) = (e.collector, e.collectorHash);
        (p.pairInitCodeHash, p.pairCodeHash) = (e.pairInitHash, e.pairHash);
    }

    function _assertDeployed(Expected memory e) internal view {
        UniswapV2Factory factory = UniswapV2Factory(e.factory);
        assertEq(factory.feeTo(), address(0));
        assertEq(factory.feeToSetter(), FEE_TO_SETTER);
        assertEq(factory.reserveCap(e.wrapped), 1 ether);
        assertEq(factory.reserveCap(asset), 10e6);
        assertEq(factory.getPair(asset, e.wrapped), e.pair);
        assertEq(BDexRouter(payable(e.router)).WBLCH(), e.wrapped);
        assertEq(TreasuryFeeCollector(e.collector).treasury(), TREASURY);
    }

    function testDeploysExactlyThePlannedAddresses() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        Expected memory e = _expected();
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(e);
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
        _assertDeployed(e);
    }

    /// The only test that touches the process environment (shared by
    /// concurrently running tests): the DEX_* variables feed the same path.
    function testRunReadsTheDerivedEnvironment() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        Expected memory e = _expected();
        hevm.setEnv("DEX_CHAIN_ID", hevm.toString(MAINNET_LIKE_CHAIN));
        hevm.setEnv("DEX_REHEARSAL", "false");
        hevm.setEnv("DEX_CONFIG_SHA256", hevm.toString(keccak256("reviewed config")));
        hevm.setEnv("DEX_DEPLOYER", hevm.toString(DEPLOYER));
        hevm.setEnv("DEX_START_NONCE", hevm.toString(uint256(hevm.getNonce(DEPLOYER))));
        hevm.setEnv("DEX_DEPLOY_WRAPPED", "true");
        hevm.setEnv("DEX_FEE_TO_SETTER", hevm.toString(FEE_TO_SETTER));
        hevm.setEnv("DEX_FEE_TO_SETTER_CODEHASH", hevm.toString(EMPTY));
        hevm.setEnv("DEX_TREASURY", hevm.toString(TREASURY));
        hevm.setEnv("DEX_TREASURY_CODEHASH", hevm.toString(EMPTY));
        hevm.setEnv("DEX_CAP_TOKENS", string.concat(hevm.toString(e.wrapped), ",", hevm.toString(asset)));
        hevm.setEnv("DEX_CAP_AMOUNTS", "1000000000000000000,10000000");
        hevm.setEnv("DEX_PAIR_TOKENS_A", hevm.toString(e.wrapped));
        hevm.setEnv("DEX_PAIR_TOKENS_B", hevm.toString(asset));
        hevm.setEnv("DEX_PAIRS", hevm.toString(e.pair));
        hevm.setEnv("DEX_WRAPPED", hevm.toString(e.wrapped));
        hevm.setEnv("DEX_WRAPPED_CODEHASH", hevm.toString(e.wrappedHash));
        hevm.setEnv("DEX_FACTORY", hevm.toString(e.factory));
        hevm.setEnv("DEX_FACTORY_CODEHASH", hevm.toString(e.factoryHash));
        hevm.setEnv("DEX_ROUTER", hevm.toString(e.router));
        hevm.setEnv("DEX_ROUTER_CODEHASH", hevm.toString(e.routerHash));
        hevm.setEnv("DEX_LENS", hevm.toString(e.lens));
        hevm.setEnv("DEX_LENS_CODEHASH", hevm.toString(e.lensHash));
        hevm.setEnv("DEX_COLLECTOR", hevm.toString(e.collector));
        hevm.setEnv("DEX_COLLECTOR_CODEHASH", hevm.toString(e.collectorHash));
        hevm.setEnv("DEX_PAIR_INIT_CODE_HASH", hevm.toString(e.pairInitHash));
        hevm.setEnv("DEX_PAIR_CODEHASH", hevm.toString(e.pairHash));
        script.run();
        _assertDeployed(e);
    }

    function testRehearsalOnDevnetNeedsTheFlag() public {
        hevm.chainId(700771);
        Expected memory e = _expected();
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(e);
        hevm.expectRevert(bytes("MAINNET: DEVNET_NEEDS_REHEARSAL"));
        script.execute(700771, false, s, p);
        script.execute(700771, true, s, p);
        _assertDeployed(e);
    }

    function testRefusesWrongChain() public {
        hevm.chainId(700771);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        hevm.expectRevert(bytes("MAINNET: CHAIN_ID"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesNonceDrift() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        s.startNonce = 7;
        hevm.expectRevert(bytes("MAINNET: DEPLOYER_NONCE"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesOccupiedAddress() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        Expected memory e = _expected();
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(e);
        hevm.etch(e.router, hex"00");
        hevm.expectRevert(bytes("MAINNET: ADDRESS_OCCUPIED"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesRuntimeCodeOtherThanPlanned() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        p.routerCodeHash = keccak256("another router");
        hevm.expectRevert(bytes("MAINNET: ROUTER_CODEHASH"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesAddressOtherThanPlanned() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        s.pairs[0] = address(0xBEEF);
        hevm.expectRevert(bytes("MAINNET: PAIR_ADDRESS"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesUncappedOrOversizedWrapper() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        s.caps[0] = 10 ether + 1;
        hevm.expectRevert(bytes("MAINNET: WRAPPED_CAP"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
        s.caps[0] = 1 ether;
        s.capTokens[0] = address(0xCAFE);
        hevm.expectRevert(bytes("MAINNET: WRAPPED_CAP"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }

    function testRefusesAliasedOrMiscodedRoles() public {
        hevm.chainId(MAINNET_LIKE_CHAIN);
        (DeployMainnet.Settings memory s, DeployMainnet.Planned memory p) = _inputs(_expected());
        s.treasury = FEE_TO_SETTER;
        hevm.expectRevert(bytes("MAINNET: ROLES"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
        s.treasury = DEPLOYER;
        hevm.expectRevert(bytes("MAINNET: ROLES"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
        s.treasury = TREASURY;
        hevm.etch(FEE_TO_SETTER, hex"00");
        hevm.expectRevert(bytes("MAINNET: FEE_TO_SETTER_CODE"));
        script.execute(MAINNET_LIKE_CHAIN, false, s, p);
    }
}
