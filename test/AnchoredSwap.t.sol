// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DexFixture} from "./SecurityRegression.t.sol";

interface AnchorVm {
    function roll(uint256 blockNumber) external;
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
    function expectRevert(bytes calldata reason) external;
}

/// The `...Anchored` swaps execute only on a chain containing the block the
/// user named, inside the blockhash window.
contract AnchoredSwapTest is DexFixture {
    AnchorVm internal constant chain = AnchorVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant ANCHOR = 49;
    bytes32 internal constant SEEN = keccak256("the L2 block the user saw");

    function path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
    }

    function anchorAt(uint256 head) internal {
        chain.roll(head);
        chain.setBlockhash(ANCHOR, SEEN);
    }

    function testAnchoredSwapsExecuteOnTheChainTheUserSaw() public {
        seed();
        anchorAt(ANCHOR + 1);
        uint256 before = token.balanceOf(RECIPIENT);
        uint256[] memory a = router.swapExactBLCHForTokensAnchored{value: 1 ether}(
            0, path(address(wrapped), address(token)), RECIPIENT, block.timestamp, ANCHOR, SEEN
        );
        assertEq(token.balanceOf(RECIPIENT), before + a[1]);
        uint256[] memory b = router.swapExactTokensForBLCHAnchored(
            1 ether, 0, path(address(token), address(wrapped)), RECIPIENT, block.timestamp, ANCHOR, SEEN
        );
        assertTrue(b[1] > 0);
        TestTokenLike other = TestTokenLike(address(wrapped));
        other.deposit{value: 1 ether}();
        other.approve(address(router), type(uint256).max);
        uint256[] memory c = router.swapExactTokensForTokensAnchored(
            0.5 ether, 0, path(address(wrapped), address(token)), RECIPIENT, block.timestamp, ANCHOR, SEEN
        );
        assertTrue(c[1] > 0);
    }

    function testAnchoredSwapsRefuseAnotherForkACurrentAndAStaleAnchor() public {
        seed();
        anchorAt(ANCHOR + 1);
        address[] memory p = path(address(wrapped), address(token));
        chain.expectRevert(bytes("BDEX: ANCHOR"));
        router.swapExactBLCHForTokensAnchored{value: 1 ether}(
            0, p, RECIPIENT, block.timestamp, ANCHOR, keccak256("fork")
        );
        chain.expectRevert(bytes("BDEX: ANCHOR"));
        router.swapExactBLCHForTokensAnchored{value: 1 ether}(0, p, RECIPIENT, block.timestamp, ANCHOR + 1, SEEN);
        chain.expectRevert(bytes("BDEX: ANCHOR"));
        router.swapExactBLCHForTokensAnchored{value: 1 ether}(0, p, RECIPIENT, block.timestamp, ANCHOR, bytes32(0));
        // 257 blocks later the anchor has left the blockhash window.
        chain.roll(ANCHOR + 257);
        chain.expectRevert(bytes("BDEX: ANCHOR"));
        router.swapExactBLCHForTokensAnchored{value: 1 ether}(0, p, RECIPIENT, block.timestamp, ANCHOR, SEEN);
    }
}

interface TestTokenLike {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}
