// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";

contract FirstDepositorTest is TestBase {
    address internal constant SEEDER = address(0x5EED);
    address internal constant ATTACKER = address(0xBAD);
    TestToken internal a;
    TestToken internal b;
    UniswapV2Pair internal pair;

    function setUp() public {
        a = new TestToken();
        b = new TestToken();
        address[] memory t = new address[](0);
        uint256[] memory c = new uint256[](0);
        UniswapV2Factory f = new UniswapV2Factory(address(0), SEEDER, t, c);
        pair = UniswapV2Pair(f.createPair(address(a), address(b)));
    }

    function fund() internal {
        a.mint(address(pair), 1 ether);
        b.mint(address(pair), 1 ether);
    }

    function testThirdPartyFirstMintIsRefusedEvenToTheDepositor() public {
        fund();
        vm.prank(ATTACKER);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(ATTACKER);
        vm.prank(ATTACKER);
        vm.expectRevert(bytes("BDEX: FIRST_DEPOSITOR"));
        pair.mint(SEEDER);
    }

    function testDepositorThenAnyone() public {
        fund();
        vm.prank(SEEDER);
        assertTrue(pair.mint(SEEDER) > 0);
        fund();
        vm.prank(ATTACKER);
        assertTrue(pair.mint(ATTACKER) > 0);
    }
}
