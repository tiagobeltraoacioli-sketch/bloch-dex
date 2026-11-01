// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexLibrary} from "../contracts/periphery/BDexLibrary.sol";
import {RehearsalMultisig} from "./mocks/RehearsalMultisig.sol";

/// The mainnet fee model: the protocol fee is paid, forever, to the Bloch Inc
/// multisig contract fixed in the factory constructor, which realizes it with
/// an ordinary k-of-n redemption. No one else can redirect or redeem it.
contract FeeRecipientTest is TestBase {
    address internal constant OWNER_A = address(0xA1);
    address internal constant OWNER_B = address(0xB2);
    address internal constant OWNER_C = address(0xC3);

    RehearsalMultisig internal blochInc;
    UniswapV2Factory internal factory;
    UniswapV2Pair internal pair;
    TestToken internal token0;
    TestToken internal token1;

    function setUp() public {
        address[] memory owners = new address[](3);
        (owners[0], owners[1], owners[2]) = (OWNER_A, OWNER_B, OWNER_C);
        blochInc = new RehearsalMultisig(owners, 2);
        factory = new UniswapV2Factory(address(blochInc), address(0), new address[](0), new uint256[](0));
        TestToken a = new TestToken();
        TestToken b = new TestToken();
        pair = UniswapV2Pair(factory.createPair(address(a), address(b)));
        token0 = TestToken(pair.token0());
        token1 = TestToken(pair.token1());
        token0.mint(address(pair), 1_000 ether);
        token1.mint(address(pair), 1_000 ether);
        pair.mint(address(this));
    }

    function _tradeAndSettle() internal returns (uint256 fee) {
        for (uint256 i; i < 4; ++i) {
            (uint112 r0, uint112 r1,) = pair.getReserves();
            token0.mint(address(pair), 50 ether);
            pair.swap(0, BDexLibrary.getAmountOut(50 ether, r0, r1), address(this), "");
            (r0, r1,) = pair.getReserves();
            token1.mint(address(pair), 50 ether);
            pair.swap(BDexLibrary.getAmountOut(50 ether, r1, r0), 0, address(this), "");
        }
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        token0.mint(address(pair), 1 ether);
        token1.mint(address(pair), uint256(reserve1) * 1 ether / reserve0);
        pair.mint(address(this));
        fee = pair.balanceOf(address(blochInc));
    }

    function testProtocolFeeAccruesToTheMultisigContract() public {
        assertEq(factory.feeTo(), address(blochInc));
        assertTrue(_tradeAndSettle() > 0);
    }

    function testMultisigRedeemsWithThresholdOnly() public {
        uint256 fee = _tradeAndSettle();
        bytes memory transfer = abi.encodeWithSelector(pair.transfer.selector, address(pair), fee);
        bytes memory burn = abi.encodeWithSelector(pair.burn.selector, address(blochInc));

        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("MS: NOT_OWNER"));
        blochInc.confirm(address(pair), transfer);

        vm.prank(OWNER_A);
        (bool executed,) = blochInc.confirm(address(pair), transfer);
        assertTrue(!executed);
        assertEq(pair.balanceOf(address(blochInc)), fee);
        vm.prank(OWNER_A);
        vm.expectRevert(bytes("MS: CONFIRMED"));
        blochInc.confirm(address(pair), transfer);
        vm.prank(OWNER_C);
        (executed,) = blochInc.confirm(address(pair), transfer);
        assertTrue(executed);

        vm.prank(OWNER_B);
        blochInc.confirm(address(pair), burn);
        vm.prank(OWNER_A);
        blochInc.confirm(address(pair), burn);
        assertEq(pair.balanceOf(address(blochInc)), 0);
        assertTrue(token0.balanceOf(address(blochInc)) > 0 && token1.balanceOf(address(blochInc)) > 0);
    }
}
