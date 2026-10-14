// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TEST ONLY. A k-of-n stand-in for the Bloch Inc Safe in local
///         rehearsals: proves the protocol fee is paid to a contract that can
///         later redeem it. Never deploy it to a real network; Bloch Inc is a
///         Safe v1.4.1 (official contracts) with hardware-wallet owners.
contract RehearsalMultisig {
    uint256 public immutable threshold;
    mapping(address => bool) public isOwner;
    uint256 public nonce;

    constructor(address[] memory owners, uint256 threshold_) {
        require(threshold_ > 0 && threshold_ <= owners.length, "MS: THRESHOLD");
        for (uint256 i; i < owners.length; ++i) {
            require(owners[i] != address(0) && !isOwner[owners[i]], "MS: OWNER");
            isOwner[owners[i]] = true;
        }
        threshold = threshold_;
    }

    /// @notice Execute `data` on `target` once `threshold` distinct owners
    ///         have called with the same (target, data, nonce): the last
    ///         confirmation executes.
    mapping(bytes32 => mapping(address => bool)) public confirmed;
    mapping(bytes32 => uint256) public confirmations;

    function confirm(address target, bytes calldata data) external returns (bool executed, bytes memory result) {
        require(isOwner[msg.sender], "MS: NOT_OWNER");
        bytes32 id = keccak256(abi.encode(target, data, nonce));
        require(!confirmed[id][msg.sender], "MS: CONFIRMED");
        confirmed[id][msg.sender] = true;
        if (++confirmations[id] < threshold) return (false, "");
        ++nonce;
        bool ok;
        (ok, result) = target.call(data);
        require(ok, "MS: CALL_FAILED");
        executed = true;
    }
}
