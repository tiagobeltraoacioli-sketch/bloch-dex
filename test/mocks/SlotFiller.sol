// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test helper for the storage-footprint measurements: adds one fresh allowance or holder
/// slot per call on a target token. It needs no balance for `fillApprove`. Not deployed.
contract SlotFiller {
    uint256 public next;

    receive() external payable {}

    function _who(uint256 i) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(i)))));
    }

    function fillApprove(address t, uint256 n) external {
        uint256 i = next;
        for (uint256 k; k < n; ++k) {
            ++i;
            (bool ok,) = t.call(abi.encodeWithSelector(0x095ea7b3, _who(i), uint256(1)));
            require(ok, "approve");
        }
        next = i;
    }

    function fillTransfer(address t, uint256 n) external {
        uint256 i = next;
        for (uint256 k; k < n; ++k) {
            ++i;
            (bool ok,) = t.call(abi.encodeWithSelector(0xa9059cbb, _who(i), uint256(1)));
            require(ok, "transfer");
        }
        next = i;
    }
}
