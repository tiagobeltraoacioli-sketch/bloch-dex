// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UniswapV2ERC20
/// @notice LP-share ERC-20 with EIP-2612 permits and a live chain-id domain.
/// @dev Solidity 0.8 checked arithmetic replaces the original SafeMath calls.
///      Permits use EVM ECDSA; they do not authorize Bloch L1 funds. The domain
///      changes when chainid changes, but cannot distinguish forks that retain
///      the same chainid. Nonces prevent reuse on the same contract and chain.
///      LP minting to zero intentionally locks the first MINIMUM_LIQUIDITY.

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
    bytes32 public constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;

    mapping(address => uint256) public nonces;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    /// @notice EIP-712 domain separator, recomputed from the LIVE chain id.
    /// @dev A changed chain ID invalidates signatures for the previous domain.
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
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
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
