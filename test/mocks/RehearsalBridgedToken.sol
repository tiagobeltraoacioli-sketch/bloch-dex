// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlochAsset} from "../../contracts/assets/BlochAsset.sol";

/// @notice TEST ONLY. A fixed-supply token exposing the bridge token's
///         immutable `bucketCapacity()` getter (SignerMintedToken), so local
///         rehearsals exercise the "DEX cap <= bucket / 10" check.
contract RehearsalBridgedToken is BlochAsset {
    uint256 public immutable bucketCapacity;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 supply,
        address recipient,
        uint256 bucketCapacity_
    ) BlochAsset(name_, symbol_, decimals_, supply, recipient) {
        bucketCapacity = bucketCapacity_;
    }
}
