# Bloch EVM asset issuance

`contracts/assets/BlochAsset.sol` provides an ERC-20 asset with a fixed supply
assigned once to the constructor recipient. Name (1–64 bytes), symbol (1–12
bytes), decimals (0–18) and positive supply are selected at deployment. Supply
is in integer base units: one million tokens with six decimals is
`1000000000000`. Metadata is descriptive, not a unique identity or endorsement.
Identify every asset by the verified network identity and contract address.

There is no owner, upgrade mechanism, subsequent minting, burning, blacklist,
pause, transfer tax or token callback. Transfers to zero or the token itself
are rejected. Finite allowances decrease on spending; maximum uint256 allowances
remain unlimited until revoked. Use exact allowances for the executing router.
ERC-20 approval replacement has the usual ordering race: revoke and confirm
before replacing an existing allowance; revocation cannot undo prior spending.

This issues an independent asset in an EVM environment. It does not create
native BLCH, collateral, a stablecoin peg, a bridge receipt or L1 authorization.
No bridge minting is implemented. Native BLCH pools still require a separately
verified wrapped-native contract. Asset/asset pools can use two ERC-20 contracts;
the current router constructor still requires a wrapper contract configuration.

## Rehearse issuance

First resolve the network identity discrepancy in ADR 001 and verify the genesis,
RPC, execution release and recipient custody. Matching a chain ID alone does
not verify a network. Review the complete constructor arguments and source.

Set these environment variables without committing credentials:

```text
EXPECTED_CHAIN_ID=<reviewed chain ID>
ASSET_NAME=<chosen name>
ASSET_SYMBOL=<chosen symbol>
ASSET_DECIMALS=<0 through 18>
ASSET_SUPPLY_BASE_UNITS=<positive integer>
ASSET_RECIPIENT=<reviewed recipient address>
BLOCH_L2_RPC_URL=<reviewed RPC URL>
```

Run a simulation with Foundry v1.7.1:

```sh
forge script script/DeployAsset.s.sol:DeployAsset --rpc-url bloch_l2
```

This command omits `--broadcast`. The script rejects mismatched chain IDs and
validates decimals before narrowing to uint8. Actual issuance is a separate
release action after review. No production asset or deployment is asserted.

Record constructor arguments, asset address, deployment transaction and block,
runtime code hash, source revision and recipient in the verified deployment
manifest. Review source and token behavior before including any token in the
frontend list. Code hashes alone do not establish collateral or issuer identity.
The sample-data frontend does not automatically list newly issued assets.

For pool creation, amounts and minimums use each asset's own decimals. The
first deposit establishes the exchange ratio; the pair locks minimum liquidity.
Each reserve must fit uint112 even if the token's total supply is larger.
Initial pricing, liquidity amounts and recipient custody need explicit review.

## Validation boundary

`test/Asset.t.sol` covers constructor rejection, fixed issuance, unauthorized
spending, approval revocation, allowance accounting and rollback, forbidden
recipients, fuzzed balance conservation and self-transfers, and liquidity,
quoted swaps and LP redemption using a six-decimal asset and a local wrapper.
These are local EVM tests, not a live-network integration or independent audit.

`test/AssetDeployment.t.sol` exercises issuance through the deployment script,
wrong/zero chain rejection and rejection of decimals that would truncate on
conversion to uint8. Environment-dependent decimal cases run sequentially in
one test because Foundry environment variables are process-wide.

Local validation on 2026-09-14 with Foundry v1.7.1 / Solidity 0.8.24:

- `forge test -vv`: 42 passed, 0 failed; fuzz campaigns use 512 cases each.
- Stateful AMM invariant: 128 sequences, 8,192 calls, zero reverts.
- `forge fmt --check`, `forge build`, and
  `forge build --sizes --skip test --skip script`: passed. Build lint reports
  unchecked ERC-20 return values in test fixtures; it reports no build errors.
- `BlochAsset` runtime size: 1,903 bytes.

The existing launch regression test was reorganized to resolve a stack-depth
compilation error without changing its permit assertions. CI compiles all
sources, then applies deployment size limits to contracts rather than local
scripts, whose embedded creation code is not deployed as a runtime contract.
