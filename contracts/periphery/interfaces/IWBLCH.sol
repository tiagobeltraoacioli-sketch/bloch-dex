// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IWBLCH
/// @notice Interface required of the deployment's wrapped-native token.
/// @dev No production wrapper is included here. Verify the external deployment
///      independently. withdraw unwraps escrowed native value; it is not a
///      protocol-level BLCH supply burn or a Bloch L1 authorization mechanism.
interface IWBLCH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function transfer(address to, uint256 wad) external returns (bool);
    function transferFrom(address from, address to, uint256 wad) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}
