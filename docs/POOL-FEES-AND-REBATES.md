# Pool fees and address rebates

## Contract policy

New factories/pairs support a pool-specific swap fee in basis points:

- default: **30 bps (0.30%)**;
- permitted range: 0..1,000 bps (0..10%);
- address rebate range: 0..10,000 bps (0..100% of that swap fee).

Only the current `feeToSetter` may call `setPoolFee(pair, feeBps)`,
`setAddressRebate(pair, trader, rebateBps)` and `setFeeRouter(router, approved)`.
Pools must be canonical pairs from this factory. Existing two-step authority
transfer remains in effect. Setting a rebate to zero revokes that discount.

The rebate is a **discount at execution**, not a later cashback claim:

```
effectiveFeeBps = poolFeeBps - floor(poolFeeBps * rebateBps / 10000)
```

For example, a 100 bps pool and 5,000 bps rebate give an effective 50 bps fee.
Integer rounding retains the fractional basis point in the pool's favor. The
rebate reduces swap fees earned by liquidity providers and never withdraws their
reserves. Protocol LP-share fees (`feeTo`) remain disabled by default and are a
separate policy.

## Authenticated address

A direct pair swap uses its caller. The reviewed router passes its own
`msg.sender` through `swapFor`; only a factory-approved router may do so. The
output recipient cannot borrow another payer's rebate. Router approval is an
explicit governance trust decision: the approved bytecode must authenticate the
trader, have the matching factory and expose no arbitrary identity forwarding.
The governance check for `factory()` alone is not a security audit of that code.

Without router approval, swaps use the router itself as the pair caller. Any
rebate deliberately assigned to that router address benefits every user of that
router. Router and lens quotes match this fallback; per-wallet benefits require
a reviewed, approved router. Revoking approval removes its ability to forward
wallet identities.

`getAmountsOut` and `getAmountsIn` use the eth_call sender as the trader for an
approved router, so quote with the same `from` address as execution. For read-only
integrations, use `BDexLens.quoteExactInputFor(amount, path, slippage, trader,
executor)`; the old `quoteExactInput` gives base-fee quotes without address rebates.
Fees apply per hop. Exact output, taxed-token exact input and multi-hop paths use
the same policy as the pair invariant. A pair captures its fee before token
callbacks. Deadlines and signed minimum-output/maximum-input bounds still apply
if governance changes fees before the transaction executes.

## Prepare an exact change for review

Complete `checkpoints/fee-policy.pending.json` with the actual chain/genesis,
factory, authority, approved routers, canonical pool addresses and beneficiary
rates. The empty template intentionally fails validation. Example entry shapes:

```
routers: [{address: reviewedRouterAddress, approved: true}]
pools: [{pair: canonicalPairAddress, fee_bps: 30,
         rebates: [{address: authenticatedTraderAddress, rebate_bps: 5000}]}]
```

These are examples, not configured production rates or addresses.

```sh
python3 scripts/prepare-pool-fees.py reviewed-fee-policy.json > fee-transactions.json
```

The tool validates ranges, identities and duplicate entries, then emits exact
ABI calldata with zero native value. It performs no RPC, signing or broadcasting.
The three selectors are pinned against the Solidity methods and exercised by the
configuration tests. Every pool in the file receives the explicit base rate;
unlisted pools/rebates stay unchanged. Include explicit zero rebates and false
router approvals to revoke prior grants. Apply related changes as one reviewed
batch through the fee authority when its account supports batching; separate
transactions expose intermediate fee states.

Before signing, verify the selected chain ID and genesis, factory/runtime pins,
current fee authority, canonical pairs and router code. Include both the reviewed
policy and generated transaction draft in the [DEX checkpoint ceremony](../checkpoints/README.md).
The hybrid checkpoint is a review certificate; the EVM fee authority still
performs its separately authorized governance transactions.

## Deployment and frontend boundary

Pair bytecode and `INIT_CODE_PAIR_HASH` changed. Existing immutable factories,
pairs and routers do not acquire these features through a frontend update. A new
reviewed deployment and explicit liquidity migration are required. Never replace
old deployment/runtime pins with guessed hashes or repoint existing users.
No contracts or fee changes were deployed by this implementation.

The sample UI can quote/display each pool's effective `swapFeeBps`, preserving
30 bps for legacy preview data. It does not infer eligibility from connecting a
wallet. Existing verified live profiles require a new reviewed contract and
wallet-aware quote integration before they can expose these new discounts.

Validation covers payer/recipient separation, unauthorized forwarding/governance,
rate bounds, revocation, taxed transfers, multi-hop exact output, fee changes and
512 randomized quote/execution/invariant cases. The signed checkpoint must also
include the deployment pins and any accepted fee-policy updates.
