// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A local stand-in for Tether's USDT contract on Ethereum (0xdAC17F958D2ee523a2206206994597C13D831ec7), written
// for these tests from the behaviour of the deployed contract, not copied from its source. Every deviation from a
// plain ERC-20 below was observed on a loopback fork of Ethereum (round 20, agent 409; the fork rehearsal
// scripts/multichain/rehearse-second-pair.mjs repeats the observations against the real contract and compares
// them with this file's):
//   - transfer, transferFrom and approve return NO value (0 bytes of return data);
//   - approve reverts when it would change a non-zero allowance into a non-zero value, the same value included;
//     approve to zero, and from zero, succeed;
//   - a fee on every transfer and transferFrom, off by default: fee = value * basisPointsRate / 10000, at most
//     maximumFee, credited to the owner; the owner sets it with setParams(basisPoints, maxFee), which the contract
//     accepts below 20 basis points and below 50 whole tokens (observed: (19, 49) accepted, (20, 49) and (19, 50)
//     refused; maximumFee is stored in base units);
//   - transferFrom does not reduce an allowance of 2^256 - 1;
//   - the owner can pause transfer and transferFrom (approve stays open), blacklist an address (it can no longer
//     send; it can still receive), destroy a blacklisted balance, issue and redeem;
//   - deprecate(newContract): from then on transfer, transferFrom, approve, balanceOf and allowance are forwarded
//     to newContract (transferByLegacy and so on), so this contract's own balances no longer move.
// A local test fixture: it is deployed nowhere.
interface IUpgradedTetherLike {
    function transferByLegacy(address from, address to, uint256 value) external;
    function transferFromByLegacy(address sender, address from, address spender, uint256 value) external;
    function approveByLegacy(address from, address spender, uint256 value) external;
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract TetherLegacyToken {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint256 public constant decimals = 6;
    uint256 private constant MAX_UINT = type(uint256).max;

    address public owner;
    uint256 public _totalSupply;
    uint256 public basisPointsRate;
    uint256 public maximumFee;
    bool public paused;
    bool public deprecated;
    address public upgradedAddress;
    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowed;
    mapping(address => bool) public isBlackListed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Params(uint256 feeBasisPoints, uint256 maxFee);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    modifier whenNotPaused() {
        require(!paused);
        _;
    }

    modifier onlyPayloadSize(uint256 size) {
        require(!(msg.data.length < size + 4));
        _;
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address who) public view returns (uint256) {
        if (deprecated) return IUpgradedTetherLike(upgradedAddress).balanceOf(who);
        return balances[who];
    }

    function allowance(address holder, address spender) public view returns (uint256) {
        if (deprecated) return IUpgradedTetherLike(upgradedAddress).allowance(holder, spender);
        return allowed[holder][spender];
    }

    // No return value.
    function transfer(address to, uint256 value) public whenNotPaused onlyPayloadSize(2 * 32) {
        require(!isBlackListed[msg.sender]);
        if (deprecated) return IUpgradedTetherLike(upgradedAddress).transferByLegacy(msg.sender, to, value);
        _move(msg.sender, to, value);
    }

    // No return value.
    function transferFrom(address from, address to, uint256 value) public whenNotPaused onlyPayloadSize(3 * 32) {
        require(!isBlackListed[from]);
        if (deprecated) {
            return IUpgradedTetherLike(upgradedAddress).transferFromByLegacy(msg.sender, from, to, value);
        }
        uint256 current = allowed[from][msg.sender];
        if (current < MAX_UINT) allowed[from][msg.sender] = current - value;
        _move(from, to, value);
    }

    // No return value; a non-zero allowance cannot be changed to another non-zero value.
    function approve(address spender, uint256 value) public onlyPayloadSize(2 * 32) {
        if (deprecated) return IUpgradedTetherLike(upgradedAddress).approveByLegacy(msg.sender, spender, value);
        require(!((value != 0) && (allowed[msg.sender][spender] != 0)));
        allowed[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        uint256 fee = (value * basisPointsRate) / 10000;
        if (fee > maximumFee) fee = maximumFee;
        uint256 sent = value - fee;
        balances[from] -= value;
        balances[to] += sent;
        if (fee > 0) {
            balances[owner] += fee;
            emit Transfer(from, owner, fee);
        }
        emit Transfer(from, to, sent);
    }

    function setParams(uint256 newBasisPoints, uint256 newMaxFee) public onlyOwner {
        require(newBasisPoints < 20);
        require(newMaxFee < 50);
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFee * 10 ** decimals;
        emit Params(basisPointsRate, maximumFee);
    }

    function pause() public onlyOwner {
        paused = true;
    }

    function unpause() public onlyOwner {
        paused = false;
    }

    function addBlackList(address evil) public onlyOwner {
        isBlackListed[evil] = true;
    }

    function removeBlackList(address cleared) public onlyOwner {
        isBlackListed[cleared] = false;
    }

    function destroyBlackFunds(address blackListed) public onlyOwner {
        require(isBlackListed[blackListed]);
        uint256 dirty = balances[blackListed];
        balances[blackListed] = 0;
        _totalSupply -= dirty;
    }

    function issue(uint256 amount) public onlyOwner {
        balances[owner] += amount;
        _totalSupply += amount;
    }

    function redeem(uint256 amount) public onlyOwner {
        balances[owner] -= amount;
        _totalSupply -= amount;
    }

    function deprecate(address newContract) public onlyOwner {
        deprecated = true;
        upgradedAddress = newContract;
    }
}

/// What a deprecated Tether contract forwards to. It keeps balances of its own and starts empty, which is enough
/// to show what deprecation means for a pool that holds the legacy contract's balance.
contract UpgradedTetherStandIn is IUpgradedTetherLike {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public forwarded;

    function transferByLegacy(address from, address to, uint256 value) external override {
        forwarded++;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transferFromByLegacy(address sender, address from, address to, uint256 value) external override {
        forwarded++;
        allowance[from][sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function approveByLegacy(address from, address spender, uint256 value) external override {
        forwarded++;
        allowance[from][spender] = value;
    }
}

/// Binance-Peg BSC-USD on BNB Smart Chain (0x55d398326f99059fF775485246999027B3197955) as observed: a plain token
/// with 18 decimals that returns true, lets an allowance be changed freely, and whose owner can mint. Also stands
/// for the bridged USDT of OP Mainnet and for USD₮0 of Arbitrum One in what the pair and the router see (they
/// return true and take no fee; six decimals there: `decimals` is a constructor argument).
contract PlainUsdtLikeToken {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public immutable decimals;
    address public owner;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlocked;

    constructor(uint8 decimals_) {
        decimals = decimals_;
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner);
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    /// A blocklist of the kind USD₮0 has (`isBlocked`). Here a blocked address cannot send; what USD₮0 itself does
    /// to a blocked address beyond that was not examined.
    function addToBlockedList(address user) external {
        require(msg.sender == owner);
        isBlocked[user] = true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(!isBlocked[from], "blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
