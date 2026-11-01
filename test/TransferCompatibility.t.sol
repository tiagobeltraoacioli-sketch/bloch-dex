// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, TestToken, TestWrappedNative} from "./TestBase.sol";
import {UniswapV2Factory} from "../contracts/UniswapV2Factory.sol";
import {UniswapV2Pair} from "../contracts/UniswapV2Pair.sol";
import {BDexRouter} from "../contracts/periphery/BDexRouter.sol";

contract AnomalousReturnToken {
    string public name = "Anomalous token";
    string public symbol = "ODD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint8 public returnMode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setReturnMode(uint8 mode) external {
        require(mode <= 3);
        returnMode = mode;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return _respond();
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return _respond();
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function _respond() private view returns (bool) {
        uint8 mode = returnMode;
        if (mode == 1) {
            assembly {
                return(0, 0)
            }
        }
        if (mode == 2) return false;
        if (mode == 3) {
            assembly {
                mstore(0, 1)
                return(31, 1)
            }
        }
        return true;
    }
}

contract TransferCompatibilityTest is TestBase {
    UniswapV2Factory internal factory;
    BDexRouter internal router;
    AnomalousReturnToken internal odd;
    TestToken internal ordinary;

    function setUp() public {
        factory = new UniswapV2Factory(address(0), address(0), new address[](0), new uint256[](0));
        router = new BDexRouter(address(factory), address(new TestWrappedNative()));
        odd = new AnomalousReturnToken();
        ordinary = new TestToken();
        odd.mint(address(this), 10_000 ether);
        ordinary.mint(address(this), 10_000 ether);
        odd.approve(address(router), type(uint256).max);
        ordinary.approve(address(router), type(uint256).max);
    }

    function testMissingReturnTokenWorksAsInputAndPairOutput() public {
        odd.setReturnMode(1);
        router.addLiquidity(
            address(odd),
            address(ordinary),
            1_000 ether,
            1_000 ether,
            1_000 ether,
            1_000 ether,
            address(this),
            block.timestamp
        );

        address[] memory path = _path(address(odd), address(ordinary));
        uint256[] memory quote = router.getAmountsOut(10 ether, path);
        uint256 ordinaryBefore = ordinary.balanceOf(address(this));
        router.swapExactTokensForTokens(10 ether, quote[1], path, address(this), block.timestamp);
        assertEq(ordinary.balanceOf(address(this)) - ordinaryBefore, quote[1]);

        path = _path(address(ordinary), address(odd));
        quote = router.getAmountsOut(10 ether, path);
        uint256 oddBefore = odd.balanceOf(address(this));
        router.swapExactTokensForTokens(10 ether, quote[1], path, address(this), block.timestamp);
        assertEq(odd.balanceOf(address(this)) - oddBefore, quote[1]);
    }

    function testFalseReturnInputRollsBackTransferAndReserves() public {
        UniswapV2Pair pair = _seedDirect();
        odd.setReturnMode(2);
        address[] memory path = _path(address(odd), address(ordinary));
        uint256[] memory quote = router.getAmountsOut(10 ether, path);
        uint256 balanceBefore = odd.balanceOf(address(this));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();

        vm.expectRevert(bytes("BDEX: TRANSFER_FROM_FAILED"));
        router.swapExactTokensForTokens(10 ether, quote[1], path, address(this), block.timestamp);

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(odd.balanceOf(address(this)), balanceBefore);
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
    }

    function testFalseReturnPairOutputRollsBackInputAndReserves() public {
        UniswapV2Pair pair = _seedDirect();
        odd.setReturnMode(2);
        address[] memory path = _path(address(ordinary), address(odd));
        uint256[] memory quote = router.getAmountsOut(10 ether, path);
        uint256 balanceBefore = ordinary.balanceOf(address(this));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();

        vm.expectRevert(bytes("BDEX: TRANSFER_FAILED"));
        router.swapExactTokensForTokens(10 ether, quote[1], path, address(this), block.timestamp);

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(ordinary.balanceOf(address(this)), balanceBefore);
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
    }

    function testMalformedShortReturnFailsClosedAndRollsBack() public {
        UniswapV2Pair pair = _seedDirect();
        odd.setReturnMode(3);
        address[] memory path = _path(address(odd), address(ordinary));
        uint256 balanceBefore = odd.balanceOf(address(this));
        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();

        vm.expectRevert();
        router.swapExactTokensForTokens(10 ether, 0, path, address(this), block.timestamp);

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        assertEq(odd.balanceOf(address(this)), balanceBefore);
        assertEq(reserve0After, reserve0Before);
        assertEq(reserve1After, reserve1Before);
    }

    function testRouterRejectsUnsolicitedNativeCurrency() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(router).call{value: 1 ether}("");
        assertTrue(!success);
        assertEq(address(router).balance, 0);
    }

    function _seedDirect() private returns (UniswapV2Pair pair) {
        pair = UniswapV2Pair(factory.createPair(address(odd), address(ordinary)));
        odd.mint(address(pair), 1_000 ether);
        ordinary.mint(address(pair), 1_000 ether);
        pair.mint(address(this));
    }

    function _path(address from, address to) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = from;
        path[1] = to;
    }
}
