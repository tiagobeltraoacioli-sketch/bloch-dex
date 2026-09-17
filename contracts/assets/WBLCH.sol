// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One base unit represents one native-currency unit deposited on this EVM chain.
/// @dev No bridge, L1 claim, issuer, upgrade, fee or administrative withdrawal.
///      The symbol does not authenticate which chain's native currency is held.
contract WBLCH {
    string public constant name = "Wrapped BLCH";
    string public constant symbol = "WBLCH";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool private withdrawing;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed owner, uint256 value);
    event Withdrawal(address indexed owner, uint256 value);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        require(!withdrawing, "WBLCH: REENTRANCY");
        require(balanceOf[msg.sender] >= value, "WBLCH: BALANCE");
        withdrawing = true;
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
        emit Withdrawal(msg.sender, value);
        (bool sent,) = msg.sender.call{value: value}("");
        require(sent, "WBLCH: NATIVE_SEND");
        withdrawing = false;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        require(spender != address(0) && spender != address(this), "WBLCH: SPENDER");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            require(approved >= value, "WBLCH: ALLOWANCE");
            allowance[from][msg.sender] = approved - value;
            emit Approval(from, msg.sender, approved - value);
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(from != address(0), "WBLCH: SENDER");
        require(to != address(0) && to != address(this), "WBLCH: RECIPIENT");
        require(balanceOf[from] >= value, "WBLCH: BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
