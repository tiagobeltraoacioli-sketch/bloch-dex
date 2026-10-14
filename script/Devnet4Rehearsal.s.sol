// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {IUniswapV2Pair} from "../contracts/interfaces/IUniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";
import {BDexLens} from "../contracts/periphery/BDexLens.sol";
import {TreasuryFeeCollector} from "../contracts/TreasuryFeeCollector.sol";
import {WBLCH} from "../contracts/assets/WBLCH.sol";
import {BlochAsset} from "../contracts/assets/BlochAsset.sol";

interface RehearsalVm {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Bloch L2 devnet4 (chain 700771) end-to-end DEX rehearsal: deploy the
///         wrapper, a test asset and the V2 core/periphery, seed one WBLCH/asset
///         pool and swap both ways. Zero-value development network only.
/// @dev The L2 block timestamp advances by one per block (about one block per
///      proof), so deadlines are expressed in L2 timestamp units.
contract Devnet4Rehearsal {
    RehearsalVm constant vm = RehearsalVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant DEVNET4_CHAIN_ID = 700771;

    struct Result {
        address wrapped;
        address asset;
        address factory;
        address router;
        address lens;
        address collector;
        address pair;
        bytes32 pairInitCodeHash;
        uint256 liquidity;
        uint256 assetOut;
        uint256 blchOut;
    }

    event Rehearsal(Result result);

    struct Config {
        address operator;
        uint256 seedBlch;
        uint256 seedAsset;
        uint256 swapBlch;
        uint256 deadline;
    }

    function run() external returns (Result memory r) {
        require(block.chainid == DEVNET4_CHAIN_ID, "REHEARSAL: CHAIN_ID");
        Config memory c = Config(
            vm.envAddress("REHEARSAL_OPERATOR"),
            vm.envUint("SEED_BLCH_WEI"),
            vm.envUint("SEED_ASSET_UNITS"),
            vm.envUint("SWAP_BLCH_WEI"),
            block.timestamp + vm.envUint("DEADLINE_L2_BLOCKS")
        );
        vm.startBroadcast();
        _deploy(c, r);
        _seed(c, r);
        _swap(c, r);
        vm.stopBroadcast();

        UniswapV2Factory factory = UniswapV2Factory(r.factory);
        r.pair = factory.getPair(r.wrapped, r.asset);
        r.pairInitCodeHash = factory.INIT_CODE_PAIR_HASH();
        require(r.pair != address(0) && factory.feeTo() == address(0), "REHEARSAL: FACTORY");
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(r.pair).getReserves();
        require(reserve0 > 0 && reserve1 > 0, "REHEARSAL: RESERVES");
        emit Rehearsal(r);
    }

    function _deploy(Config memory c, Result memory r) private {
        r.wrapped = address(new WBLCH());
        r.asset = address(new BlochAsset("Devnet4 Test Asset", "D4TEST", 18, c.seedAsset * 10, c.operator));
        r.factory = address(new UniswapV2Factory(c.operator));
        r.router = address(new BDexRouter(r.factory, r.wrapped));
        r.lens = address(new BDexLens(r.factory));
        r.collector = address(new TreasuryFeeCollector(r.factory, c.operator, r.wrapped));
    }

    function _seed(Config memory c, Result memory r) private {
        BlochAsset(r.asset).approve(r.router, type(uint256).max);
        (,, r.liquidity) = BDexRouter(payable(r.router)).addLiquidityBLCH{value: c.seedBlch}(
            r.asset, c.seedAsset, c.seedAsset, c.seedBlch, c.operator, c.deadline
        );
    }

    function _swap(Config memory c, Result memory r) private {
        BDexRouter router = BDexRouter(payable(r.router));
        address[] memory path = new address[](2);
        (path[0], path[1]) = (r.wrapped, r.asset);
        uint256 quoted = router.getAmountsOut(c.swapBlch, path)[1];
        r.assetOut = router.swapExactBLCHForTokens{value: c.swapBlch}(quoted, path, c.operator, c.deadline)[1];

        (path[0], path[1]) = (r.asset, r.wrapped);
        uint256 sellAsset = r.assetOut / 2;
        quoted = router.getAmountsOut(sellAsset, path)[1];
        r.blchOut = router.swapExactTokensForBLCH(sellAsset, quoted, path, c.operator, c.deadline)[1];
    }
}
