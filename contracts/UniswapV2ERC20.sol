// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UniswapV2ERC20 — the LP-share token (ERC-20 + EIP-2612 permit),
///        authorial 0.8.24 port of the canonical UniswapV2ERC20 (v2-core,
///        solc 0.5.16).
///
/// STATUS: UNAUDITED REFERENCE, NOT DEPLOYED. There is no live Bloch EVM L2
///         (l2/bloch-l2-prover/src/lib.rs declares itself "SCAFFOLD,
///         UNAUDITED, not a working L2, NOT a zk prover"); this source exists
///         so the DEX core is pinned, tested and reviewable before anything
///         real launches. Nothing here is inert-gated because nothing here
///         can run anywhere yet.
///
/// PORT NOTES (each deviation from canonical is deliberate and listed):
///   1. SafeMath is gone: solc 0.8 checked arithmetic reverts on
///      overflow/underflow exactly where SafeMath did (panic 0x11 instead of
///      a revert string — a semantic-equivalent, observable-difference-only
///      change).
///   2. DOMAIN_SEPARATOR is computed per-call from block.chainid instead of
///      being frozen in the constructor. Two reasons:
///        a. The canonical freeze is a known replay hazard: after any chain
///           split, permits signed for one fork replay on the other because
///           the frozen separator still names the pre-fork chain id.
///           Computing dynamically makes a signature valid ONLY on the chain
///           id it names.
///        b. This L2's chain id is literally a placeholder today (700771,
///           "placeholder pending" — l2/bloch-l2-evm/src/chainspec.rs:5,
///           and 8400 is the id reserved for the EVM listing). Freezing a
///           placeholder into deployed bytecode would bake in a wrong id.
///      The extra cost is ~200 gas per permit. Tested (incl. the fork-replay
///      negative + control) in test/UniswapV2ERC20.t.sol.
///   3. name/symbol renamed ("Bloch DEX V2" / "BDX-V2"): this is NOT Uniswap
///      and must not present itself as Uniswap to wallets. Mechanics are
///      unchanged; the name feeds only metadata and the EIP-712 domain.
contract UniswapV2ERC20 {
    string public constant name = "Bloch DEX V2";
    string public constant symbol = "BDX-V2";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @dev keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    ///      — byte-identical to canonical/EIP-2612, so existing wallet
    ///      tooling signs permits for this token unmodified.
    bytes32 public constant PERMIT_TYPEHASH =
        0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;

    mapping(address => uint256) public nonces;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice EIP-712 domain separator, recomputed from the LIVE chain id.
    /// @dev See PORT NOTE 2 in the header for why this is not frozen at
    ///      construction like the canonical contract does.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Mint to `to`. Canonical semantics preserved: minting to
    ///      address(0) is ALLOWED — UniswapV2Pair.mint deliberately mints
    ///      MINIMUM_LIQUIDITY to address(0) on first deposit to permanently
    ///      lock it (the first-depositor share-inflation mitigation). An
    ///      OZ-style zero-address guard here would break the Pair.
    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value; // checked: reverts if from holds < value
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) private {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        balanceOf[from] -= value; // checked: replaces SafeMath.sub
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /// @dev Canonical "infinite allowance" gas optimisation kept: an
    ///      allowance of exactly type(uint256).max is never decremented, so
    ///      routers approved once never pay the SSTORE again.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value; // checked: reverts if insufficient
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice EIP-2612 gasless approval. Signature domain includes the LIVE
    ///         chain id (see DOMAIN_SEPARATOR) — a permit signed for chain A
    ///         is dead on chain B, and dead on A-after-a-fork-renumber too.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // block.timestamp comparison is the EIP-2612 deadline check itself —
        // sequencer skew within the deadline window is the accepted model
        // (canonical behaviour; the signer chooses the deadline).
        // forge-lint: disable-next-line(block-timestamp)
        require(deadline >= block.timestamp, "BDEX: EXPIRED");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        // ecrecover returning address(0) (garbage signature) is rejected by
        // the owner-match below because permit(owner=address(0),...) would
        // require recovered == address(0) — canonical guards this the same
        // way, by requiring recoveredAddress != 0 first.
        address recoveredAddress = ecrecover(digest, v, r, s);
        require(recoveredAddress != address(0) && recoveredAddress == owner, "BDEX: INVALID_SIGNATURE");
        _approve(owner, spender, value);
    }
}
