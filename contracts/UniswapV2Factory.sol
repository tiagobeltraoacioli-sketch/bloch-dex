// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {UniswapV2Pair} from "./UniswapV2Pair.sol";

/// @title UniswapV2Factory — permissionless pair deployer, authorial 0.8.24
///        port of the canonical UniswapV2Factory (v2-core, solc 0.5.16).
///
/// STATUS: UNAUDITED REFERENCE, NOT DEPLOYED. No live Bloch EVM L2 exists
///         (prover self-declares SCAFFOLD — l2/bloch-l2-prover/src/lib.rs:3);
///         this is the reviewable, tested core awaiting a real chain.
///
/// FEE GOVERNANCE (read before wiring anything to feeTo):
///   * feeTo/feeToSetter are EXACTLY canonical: feeToSetter (an operator key
///     today — there is no on-chain governance) may enable the protocol cut
///     by pointing feeTo at a collector, or disable it with address(0). The
///     cut itself is 1/6 of swap-fee growth, settled lazily in
///     UniswapV2Pair._mintFee. LP PRINCIPAL is untouched; the cut dilutes
///     only fee-driven growth. Said that way on purpose: "LP economics are
///     untouched" is what this line read before, and it is a sentence that
///     survives being quoted on its own while being false — with the cut on,
///     LPs take 5/6 of fee growth rather than 6/6. The precise claim is the
///     one _mintFee's own comment makes, and the one the tests measure.
///   * DEFAULT OFF IS THE PRODUCT CONTRACT, not an implementation accident.
///     The governing docs (docs/specs/POSTERNDEX-AMM-DESIGN.md:56-60,
///     docs/specs/POSTERNDEX-BRIDGE-DESIGN.md:219-223) require the switch to
///     ship with feeTo == address(0) — all fees to LPs — and this
///     constructor honors that by setting ONLY feeToSetter. Turning the fee
///     on is a deliberate later act of the founder
///     (setFeeTo(TreasuryFeeCollector)), and only then are the docs amended.
///   * IF EVER ON, the destination is Postern's OPERATIONS treasury and the
///     framing is fiat-equivalent utility revenue for running the
///     frontend/L2 — never a value-return mechanism for the BLCH token, and
///     no user-facing copy may pitch it as one. That treasury is distinct
///     from the mined L1 treasury balance and from the consensus-locked
///     premine; comments and copy must not conflate the three.
///   * Note the L2's EIP-1559 basefee separately routes to BASE_FEE_VAULT
///     and is deliberately preserved (l2/bloch-l2-evm/src/chainspec.rs:16-21
///     — bridged BLCH always stays claimable so the L1 escrow balances).
///     The DEX protocol fee keeps that symmetry: nothing here removes BLCH
///     from circulation.
contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice keccak256 of the Pair CREATION CODE — the third CREATE2 input.
    /// @dev This port compiles with solc 0.8.24/cancun, so this hash is NOT
    ///      the canonical 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee
    ///      326c3e7da348845f, and it changes whenever UniswapV2Pair (or the
    ///      compiler settings in contracts/foundry.toml) change. Off-chain
    ///      pairFor computations MUST source it from here; hardcoding the
    ///      canonical constant addresses pairs that DO NOT EXIST (classic
    ///      fork bug — funds sent to empty addresses). Equality of predicted
    ///      vs. created addresses is pinned in test/UniswapV2Factory.t.sol.
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
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "BDEX: FORBIDDEN");
        feeToSetter = _feeToSetter;
    }
}
