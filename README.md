# PosternDEX

V2 constant-product AMM contracts, an execution router, an immutable treasury
collector and a read-only integration lens, with a responsive React/TypeScript
frontend. Protocol fees start **disabled**. The frontend is an interactive
**sample-data preview**; this repository asserts no live deployment.

## Frontend

[`frontend/`](frontend/) implements the approved graphite, ivory and lime design
for **Trade**, **Pools** and **Portfolio**, with all UI copy in English.

- Trade: token selection, exact-integer V2 demo quotes, route comparison,
  slippage limits and a calculation review.
- Pools: search, sorting, a device-local watchlist and pool details.
- Portfolio: sample composition and history, with deposit and withdrawal previews.
- Optional browser wallet discovery and account identification; connecting never
  replaces sample positions with real balances and never requests a signature.

With Node 24 installed:

```sh
cd frontend
npm ci --ignore-scripts
npm run dev
```

Run `npm test` and `npm run build` for interaction/arithmetic checks and the
production static bundle. See [the frontend guide](frontend/README.md) for the
current boundary, validation limits and live-integration requirements.

## Execution and security boundary

These contracts require an explicitly selected **EVM environment**, including
the intended Bloch L2 integration. They do not add EVM execution to Bloch L1.
EVM accounts and LP-token EIP-2612 permits use ECDSA; that compatibility must
not be advertised as post-quantum authorization. Bloch L1 fund movement remains
a separate PQ boundary. A bridge or wrapped representation has its own trust
and settlement assumptions, outside these contracts.

No production network, factory, router or wrapped-native address is asserted
here. Chain ID 8400 is a retired scaffold, not a deployment target. The wrapped
native token is supplied externally; `test/TestBase.sol` contains only a local
fixture. There has been no independent audit or production qualification.

## Build and validate

Use Foundry **v1.7.1**. `foundry.toml` pins Solidity **0.8.24**, optimizer 200
runs, the **Paris** EVM target and metadata settings. No runtime contract or
test-library dependency is downloaded from a floating branch.

```sh
forge fmt --check
forge build
forge build --sizes --skip test --skip script
forge test -vv
```

CI runs these commands. Size limits apply to on-chain contracts; local deployment
scripts embed creation code and are compiled separately. Tests cover actual swaps and redemptions, flash-swap
repayment/reentrancy, permit replay across nonces and chain IDs, treasury TWAP
windows, taxed-token withdrawal bounds, CREATE2 identity, route execution
parity, protocol-fee dilution and stateful liquidity invariants. Fuzz tests run
512 cases each; the invariant campaign runs 128 sequences of 64 operations
with unexpected reverts treated as failures.

## Contracts

Fixed-supply EVM asset issuance is available through
[`BlochAsset`](contracts/assets/BlochAsset.sol), with a separate deployment
rehearsal script. See [asset issuance](docs/ASSET-ISSUANCE.md) for configuration,
security boundaries and pool integration. No production asset has been issued.

Canonical pair creation has an idempotent, chain/hash-pinned rehearsal script.
See [pair support](docs/PAIR-SUPPORT.md) for its configuration, existing-pair
checks and the distinction between native L1 assets and wrapped EVM tokens.

| Contract | Purpose |
|---|---|
| `UniswapV2Factory` | Canonical pair registry, CREATE2 deployment and two-step fee-authority transfer |
| `UniswapV2Pair` | 0.30% swaps, LP mint/burn, flash swaps and cumulative prices |
| `UniswapV2ERC20` | LP shares with a dynamic-chain-ID EIP-2612 domain |
| `BDexRouter` | Atomic swaps, liquidity operations and wrapped-native paths |
| `TreasuryFeeCollector` | Direct LP redemption to a fixed treasury; optional TWAP-guarded conversion |
| `BDexLens` | Paginated pool snapshots, LP position estimates and bounded route comparison |

Router quotes and swaps reject paths that reuse the same canonical pool. A
later hop through an already-mutated pool cannot be represented by the static
reserve quote computed before execution. Cycles that use a different pool on
every hop remain valid; ordinary direct and multi-hop routes are unchanged.

### Integrate the lens

`poolFor(tokenA, tokenB)` looks up one pair in either token order and distinguishes
missing pairs from existing empty pools. Reserves follow sorted token order.

`pools(cursor, limit)` returns up to 64 pools, the next cursor and total count.
It reads canonical pool state without invoking arbitrary token metadata.

`position(pair, owner)` estimates the owner's reserve shares after accounting
for pending protocol-fee dilution. Donations, rebases and transfer taxes can
make actual redemption differ from reserve-based estimates.

`quoteExactInput(amountIn, path, slippageBps)` returns amounts, per-hop execution
loss versus the marginal reserve ratio, an explicit availability flag, the
quote's block/time and a rounded-down minimum output. `bestExactInput` compares
up to eight caller-supplied routes of at most four hops, with matching endpoints
and no repeated pools. Tokens may reappear when every hop uses a distinct pool.
Missing or empty pools are marked unavailable; if no candidate is usable,
`bestIndex` is `uint256.max`.

This is comparison of supplied candidates, not global route discovery or
split-route optimization. Read `available` before interpreting a quote. Spot
reserves are manipulable; the lens is **not a price oracle**. Taxed/rebasing
tokens are not modeled. Re-quote near submission, select a deadline and submit
the minimum to the router. Only approve the executing router, never the lens.

### Treasury policy

`sweep(pair)` is the default: LP shares redeem directly to the immutable
treasury, without a swap. `convertViaTwap` is an optional wrapped-native
conversion requiring a caller-owned observation aged 30 minutes to 6 hours.
Empty pools cannot initialize observations. Conversion refuses zero/dust
floors and nonstandard redemption deltas; it does not use unrelated donated
balances to subsidize a taxed redemption.

The 1% TWAP discount bound includes the conversion's own price impact. A
large conversion can therefore revert. A TWAP is not immune to sustained
manipulation, and shallow markets must not be treated as reliable collateral
oracles. There is no rescue key. Unrelated tokens sent to the collector or
router may remain unrecoverable.

## Compatibility changes in this revision

- `setFeeToSetter(next)` **proposes** a transfer. `next` must call
  `acceptFeeToSetter`; the current authority may cancel before acceptance.
  Update administrative integrations that assumed immediate transfer.
- Factories reject non-contract token addresses, and pair initialization is
  explicitly one-time. Create the token contracts before creating their pair.
- Liquidity additions enforce both user minimums, including the first deposit.
  Taxed-token native removals enforce the final recipient's net token minimum
  and forward only that withdrawal's balance delta.
- Native-output swaps and liquidity removals reject the wrapped-native contract
  as recipient. Sending unwrapped currency there would invoke its deposit path
  and strand newly minted wrapped tokens under the router's address.
- Pair creation bytecode changed. Read `INIT_CODE_PAIR_HASH()` from the actual
  factory; never hardcode canonical Uniswap or an earlier Postern hash. Existing
  deployments cannot be upgraded by changing these source files.
- LP-token permits require canonical low-s ECDSA signatures with `v` equal to
  27 or 28. Standard wallet signatures already satisfy this rule; malleated
  high-s alternatives are rejected and do not consume the permit nonce.
- Fee arithmetic remains V2's lazy 1/6 share of `sqrt(k)` growth. A liquidity
  event while `feeTo` is off resets `kLast`; toggling off and on between
  liquidity events does not clear that baseline.

See [the focused review](docs/SECURITY-REVIEW-2026-09-08.md) for reproduced
defects, validation evidence and work still required before production.
