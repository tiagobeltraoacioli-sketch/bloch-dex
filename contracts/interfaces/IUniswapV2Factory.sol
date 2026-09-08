// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV2Factory — canonical factory surface + INIT_CODE_PAIR_HASH.
/// @notice `INIT_CODE_PAIR_HASH` is an ADDITION over the canonical interface:
///         because this core is an authorial 0.8.24 port (not the canonical
///         0.5.16 bytecode), the CREATE2 init-code hash DIFFERS from the
///         canonical 0x96e8ac42...  Every future integrator (Router.pairFor,
///         front-ends, indexers) MUST read this getter instead of copy-pasting
///         the canonical constant, or they will compute addresses of pairs
///         that do not exist and send funds into the void. The equality of
///         predicted vs. actually-created addresses is pinned by
///         test/UniswapV2Factory.t.sol.
interface IUniswapV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint256) external view returns (address pair);
    function allPairsLength() external view returns (uint256);

    function INIT_CODE_PAIR_HASH() external pure returns (bytes32);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
}
