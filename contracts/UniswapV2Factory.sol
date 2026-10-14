// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {UniswapV2Pair} from "./UniswapV2Pair.sol";

/// @title UniswapV2Factory
/// @notice Permissionless V2 pair deployment with explicit fee governance.
/// @dev Protocol fees start disabled. When enabled, the canonical lazy fee
///      mints 1/6 of sqrt(k) growth as LP shares; it does not debit LP deposits.
///      feeTo is operator-controlled and should point to an operations treasury.
///      Authority transfer is proposed with setFeeToSetter and completed by
///      acceptFeeToSetter. Read README.md for compatibility and deployment status.
///      Per-token reserve caps are fixed once in the constructor and have no
///      setter: a pilot limit is part of the deployed code, not a signed,
///      renewable approval.

contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;
    address public pendingFeeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    /// @notice Highest reserve a pair may grow to in `token` (0 = uncapped).
    /// @dev Written only by the constructor; pairs copy it at creation.
    mapping(address => uint256) public reserveCap;

    constructor(address _feeToSetter, address[] memory capTokens, uint256[] memory caps) {
        require(_feeToSetter != address(0), "BDEX: ZERO_ADDRESS");
        require(capTokens.length == caps.length, "BDEX: CAP_LENGTH");
        feeToSetter = _feeToSetter;
        for (uint256 i; i < capTokens.length; ++i) {
            address token = capTokens[i];
            uint256 cap = caps[i];
            require(token != address(0), "BDEX: ZERO_ADDRESS");
            require(cap != 0 && cap <= type(uint112).max, "BDEX: CAP_RANGE");
            require(reserveCap[token] == 0, "BDEX: CAP_DUPLICATE");
            reserveCap[token] = cap;
            emit ReserveCapSet(token, cap);
        }
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice keccak256 of the Pair CREATION CODE — the third CREATE2 input.
    /// @dev This port compiles with the pinned Solidity/EVM settings, so this hash is NOT
    ///      the canonical 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee
    ///      326c3e7da348845f, and it changes whenever UniswapV2Pair (or the
    ///      compiler settings in foundry.toml) change. Off-chain
    ///      pairFor computations MUST source it from here; hardcoding the
    ///      canonical constant addresses pairs that DO NOT EXIST (classic
    ///      fork bug — funds sent to empty addresses). Equality of predicted
    ///      vs. created addresses is pinned in test/Core.t.sol.
    function INIT_CODE_PAIR_HASH() external pure returns (bytes32) {
        return keccak256(type(UniswapV2Pair).creationCode);
    }

    /// @notice Deploy the (tokenA, tokenB) pair at a CREATE2 address derived
    ///         ONLY from the sorted token addresses — one canonical pool per
    ///         pair, address computable off-chain without touching state.
    /// @dev 0.8 port note: canonical used inline assembly
    ///      (`create2(0, add(bytecode, 32), mload(bytecode), salt)`); solc
    ///      >=0.6.2 expresses the same opcode as `new Pair{salt: ...}()`,
    ///      which additionally reverts (instead of returning address(0)) if
    ///      the deployment fails. Semantics otherwise identical:
    ///      address = keccak256(0xff, factory, salt, INIT_CODE_PAIR_HASH).
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "BDEX: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "BDEX: ZERO_ADDRESS");
        require(token0.code.length > 0 && token1.code.length > 0, "BDEX: NOT_A_TOKEN");
        require(getPair[token0][token1] == address(0), "BDEX: PAIR_EXISTS"); // single check is sufficient
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new UniswapV2Pair{salt: salt}());
        UniswapV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    /// @notice Point the protocol cut at a collector (or address(0) = off).
    /// @dev Operator-keyed today; see the header's honest-label requirement.
    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "BDEX: FORBIDDEN");
        emit FeeToUpdated(feeTo, _feeTo);
        feeTo = _feeTo;
    }

    /// @notice Propose a new fee authority. The current authority retains
    ///         control until the nominated address explicitly accepts.
    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "BDEX: FORBIDDEN");
        require(_feeToSetter != address(0), "BDEX: ZERO_ADDRESS");
        pendingFeeToSetter = _feeToSetter;
        emit FeeToSetterTransferStarted(feeToSetter, _feeToSetter);
    }

    function acceptFeeToSetter() external {
        require(msg.sender == pendingFeeToSetter, "BDEX: FORBIDDEN");
        emit FeeToSetterTransferred(feeToSetter, msg.sender);
        feeToSetter = msg.sender;
        pendingFeeToSetter = address(0);
    }

    function cancelFeeToSetterTransfer() external {
        require(msg.sender == feeToSetter, "BDEX: FORBIDDEN");
        emit FeeToSetterTransferStarted(feeToSetter, address(0));
        pendingFeeToSetter = address(0);
    }
}
