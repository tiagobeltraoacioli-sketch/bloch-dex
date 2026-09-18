// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {BDexLibrary} from "./BDexLibrary.sol";
import {Math} from "../libraries/Math.sol";

/// @title BDexLens
/// @notice Bounded, read-only pool discovery, LP positions and route comparison.
/// @dev Quotes use spot reserves in raw token units. They are not an oracle,
///      a promise of execution, or quotes for taxed/rebasing tokens. The lens
///      never requests approval, holds funds, or executes a trade.
contract BDexLens {
    IUniswapV2Factory public immutable factory;
    uint256 public constant MAX_PAGE_SIZE = 64;
    uint256 public constant MAX_ROUTES = 8;
    uint256 public constant MAX_PATH_LENGTH = 5;
    uint256 private constant BPS = 10_000;

    struct PoolSnapshot {
        address pair;
        address token0;
        address token1;
        uint112 reserve0;
        uint112 reserve1;
        uint32 reserveTimestamp;
        uint256 totalSupply;
    }

    struct Position {
        uint256 liquidity;
        uint256 pendingProtocolLiquidity;
        uint256 dilutedSupply;
        uint256 reserveShare0;
        uint256 reserveShare1;
    }

    struct RouteQuote {
        bool available;
        uint256 blockNumber;
        uint256 timestamp;
        uint256 amountOut;
        uint256 minimumOut;
        uint256[] amounts;
        // Per-hop loss versus the no-fee marginal reserve ratio, including
        // both the swap fee and this order's own price impact.
        uint256[] executionLossBps;
    }

    constructor(address factory_) {
        require(factory_.code.length > 0, "LENS: NOT_A_FACTORY");
        factory = IUniswapV2Factory(factory_);
    }

    /// @notice Look up one canonical pair without scanning the pool registry.
    /// @dev Snapshot reserves follow sorted token0/token1 order, regardless of
    ///      input order. Existence does not imply liquidity or quote availability.
    function poolFor(address tokenA, address tokenB) external view returns (bool exists, PoolSnapshot memory snapshot) {
        (address token0, address token1) = BDexLibrary.sortTokens(tokenA, tokenB);
        address pair = factory.getPair(token0, token1);
        if (pair == address(0)) return (false, snapshot);
        return (true, _pool(pair));
    }

    function pools(uint256 cursor, uint256 limit)
        external
        view
        returns (PoolSnapshot[] memory page, uint256 nextCursor, uint256 total)
    {
        require(limit > 0 && limit <= MAX_PAGE_SIZE, "LENS: PAGE_LIMIT");
        total = factory.allPairsLength();
        if (cursor >= total) return (new PoolSnapshot[](0), total, total);
        uint256 count = Math.min(limit, total - cursor);
        page = new PoolSnapshot[](count);
        for (uint256 i; i < count; ++i) {
            page[i] = _pool(factory.allPairs(cursor + i));
        }
        nextCursor = cursor + count;
    }

    function position(address pair, address owner) external view returns (Position memory value) {
        PoolSnapshot memory p = _pool(pair);
        require(factory.getPair(p.token0, p.token1) == pair, "LENS: NOT_A_PAIR");
        value.liquidity = IUniswapV2Pair(pair).balanceOf(owner);
        uint256 previousK = IUniswapV2Pair(pair).kLast();
        if (factory.feeTo() != address(0) && previousK != 0) {
            uint256 rootK = Math.sqrt(uint256(p.reserve0) * p.reserve1);
            uint256 previousRootK = Math.sqrt(previousK);
            if (rootK > previousRootK) {
                value.pendingProtocolLiquidity = p.totalSupply * (rootK - previousRootK) / (rootK * 5 + previousRootK);
            }
        }
        value.dilutedSupply = p.totalSupply + value.pendingProtocolLiquidity;
        if (value.dilutedSupply != 0) {
            value.reserveShare0 = value.liquidity * p.reserve0 / value.dilutedSupply;
            value.reserveShare1 = value.liquidity * p.reserve1 / value.dilutedSupply;
        }
        // These are reserve-based shares. burn() uses actual balances; token
        // donations, taxes and rebases can change the realized redemption.
    }

    function quoteExactInput(uint256 amountIn, address[] calldata path, uint256 slippageBps)
        external
        view
        returns (RouteQuote memory)
    {
        return _quote(amountIn, path, slippageBps);
    }

    /// @notice Compare caller-supplied candidate routes with matching endpoints.
    /// @return bestIndex First best route; uint256.max when all pools are unavailable.
    /// @return quotes One quote per candidate, all from this call's state.
    function bestExactInput(uint256 amountIn, address[][] calldata routes, uint256 slippageBps)
        external
        view
        returns (uint256 bestIndex, RouteQuote[] memory quotes)
    {
        require(routes.length > 0 && routes.length <= MAX_ROUTES, "LENS: ROUTE_LIMIT");
        _validatePath(routes[0]);
        address input = routes[0][0];
        address output = routes[0][routes[0].length - 1];
        quotes = new RouteQuote[](routes.length);
        bestIndex = type(uint256).max;
        uint256 bestOut;
        for (uint256 i; i < routes.length; ++i) {
            _validatePath(routes[i]);
            require(routes[i][0] == input && routes[i][routes[i].length - 1] == output, "LENS: ENDPOINTS");
            quotes[i] = _quote(amountIn, routes[i], slippageBps);
            if (quotes[i].available && quotes[i].amountOut > bestOut) {
                bestOut = quotes[i].amountOut;
                bestIndex = i;
            }
        }
    }

    function _pool(address pair) private view returns (PoolSnapshot memory p) {
        IUniswapV2Pair tokenPair = IUniswapV2Pair(pair);
        p.pair = pair;
        p.token0 = tokenPair.token0();
        p.token1 = tokenPair.token1();
        (p.reserve0, p.reserve1, p.reserveTimestamp) = tokenPair.getReserves();
        p.totalSupply = tokenPair.totalSupply();
    }

    function _validatePath(address[] calldata path) private pure {
        require(path.length >= 2 && path.length <= MAX_PATH_LENGTH, "LENS: PATH_LIMIT");
        for (uint256 i; i < path.length; ++i) {
            require(path[i] != address(0), "LENS: ZERO_TOKEN");
            if (i == path.length - 1) continue;
            require(path[i] != path[i + 1], "LENS: CYCLIC_PATH");
            // A token may reappear when every hop uses a distinct pool. Only
            // reusing an unordered edge would make a later quote depend on
            // reserves changed by an earlier hop.
            for (uint256 j; j < i; ++j) {
                bool sameDirection = path[i] == path[j] && path[i + 1] == path[j + 1];
                bool reverseDirection = path[i] == path[j + 1] && path[i + 1] == path[j];
                require(!sameDirection && !reverseDirection, "LENS: CYCLIC_PATH");
            }
        }
    }

    function _quote(uint256 amountIn, address[] calldata path, uint256 slippageBps)
        private
        view
        returns (RouteQuote memory q)
    {
        _validatePath(path);
        require(amountIn > 0 && amountIn <= type(uint112).max, "LENS: INPUT_RANGE");
        require(slippageBps <= BPS, "LENS: SLIPPAGE_RANGE");
        q.blockNumber = block.number;
        q.timestamp = block.timestamp;
        q.amounts = new uint256[](path.length);
        q.executionLossBps = new uint256[](path.length - 1);
        q.amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            address pair = factory.getPair(path[i], path[i + 1]);
            if (pair == address(0)) return q;
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
            (uint256 rIn, uint256 rOut) =
                path[i] < path[i + 1] ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            if (rIn == 0 || rOut == 0 || q.amounts[i] > type(uint112).max - rIn) return q;
            uint256 out = BDexLibrary.getAmountOut(q.amounts[i], rIn, rOut);
            if (out == 0) return q;
            uint256 marginal = BDexLibrary.quote(q.amounts[i], rIn, rOut);
            q.amounts[i + 1] = out;
            q.executionLossBps[i] = (marginal - out) * BPS / marginal;
        }
        q.available = true;
        q.amountOut = q.amounts[path.length - 1];
        q.minimumOut = q.amountOut * (BPS - slippageBps) / BPS;
    }
}
