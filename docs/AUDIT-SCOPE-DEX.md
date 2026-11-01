# Postern DEX: audit scope and internal pre-audit review (2026-10-30)

This file is the hand-off for an external audit of the Postern DEX contracts.
It records the scope, the differences from upstream Uniswap V2, the invariants
the test suite enforces, the internal review findings and the known issues.
It is an internal review, not an audit.

## 1. Revision

| Item | Value |
|---|---|
| Branch | `codex/dex-mainnet-rc-20261030` |
| Contracts commit | `d18ab04f1db68350427362128829f88dba8bac9b`, the `source.revision` of `deployments/mainnet/dex-mainnet.config.json`. Contains fixes DEX-09 and F1. **The scope moved from `f1ad6f2`: see "Change of scope" below** |
| Audit commit | The tip of `codex/dex-mainnet-rc-20261030` that contains this file. `git diff d18ab04 <tip> -- contracts foundry.toml` must be empty |
| Internal review base | The review below began on `codex/dex-audit-20261030` (from `feat/dex-safe-frontend-20261016` @ `4dfb32d`). The pair and the Lens changed after it, so an external audit uses the commits above |
| Compiler | solc 0.8.24, `evmVersion = paris`, optimizer 200 runs, `bytecode_hash = none` (`foundry.toml`) |
| Pair init code hash | `0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683` (`0x1a88e06e…490f` before fix F1, `0xe41e81db…b248` before fix DEX-09, `0x2249ef38…b820` before fix DEX-01) |
| Target chain | Bloch L2 mainnet, chain ID 700770. Nothing is deployed there yet |

### Change of scope: fix F1

**The audit scope moved.** An external audit must cover these additions, which no earlier review in this file saw except the attack review noted below.

| File | Change |
|---|---|
| `contracts/UniswapV2Pair.sol` | `K_CEILING_BPS` and `_applyCeiling`: `reserve0 * reserve1` stays at or below 64% of `cap0 * cap1` on a pair capped on both sides. Mint and sync revert with `BDEX: K_CEILING`. Swap and burn record less and leave the rest outside the reserves. The first mint requires `msg.sender` or `tx.origin` to be `factory.firstDepositor()`, or reverts with `BDEX: FIRST_DEPOSITOR` |
| `contracts/UniswapV2Factory.sol` | New immutable `firstDepositor`, a new constructor argument |
| `contracts/interfaces/IUniswapV2Factory.sol` | `firstDepositor()` |

Invariant to audit: **both reserves can never sit at their caps, by any path, including fee growth and donations.** Each side alone can still reach its cap through a swap, so the dump bound does not change (agent 61 measured identical dump figures before and after).

Accepted limits, by owner decision for the guarded launch, are in `OPS-OPENING-KIT.md` section 3. `tx.origin` is used on purpose: see that section. `address(0)` turns the rule off in the factory, and every mainnet tool refuses it.

### Review findings at this revision

An independent review at `258fdd2` reported these.

| ID | Severity | Summary | State on this branch |
|---|---|---|---|
| F1 | High (liveness) | A mint to both caps closes the pair to swaps and mints, before or after the seed, and the capital can be recovered. Same end state as DEX-09, by a route that fix leaves open | Fixed in the contracts, with accepted limits. Attacked by an independent review at `d18ab04`: "holds with listed limits" |
| F2 | Medium-High (launch) | A front-run `createPair` strands the deployment tooling | Fixed in the tooling |
| F3 | Medium (user funds) | After a favourable move, the signed minimum stays tied to the older finalized quote | Fixed in the frontend |
| F4 | Medium (user funds) | One failed receipt poll shows a pending swap as failed and re-enables Swap | Fixed in the frontend |
| F5 | Low-Medium (user funds) | A quote that arrives after an edit sends the old amount | Fixed in the frontend |

A mint ceiling at 80% of the caps was tried and reverted (`e9b18cc`, `b404458`): wash trading and recorded donations still reach both caps.

## 2. Scope

In scope (deployed by `script/DeployMainnet.s.sol`):

| File | Layer | Role |
|---|---|---|
| `contracts/UniswapV2Pair.sol` | core | Constant-product pair, reserve caps, lazy protocol fee |
| `contracts/UniswapV2ERC20.sol` | core | LP share token with EIP-2612 permits |
| `contracts/UniswapV2Factory.sol` | core | Permissionless pair creation; fee recipient and caps fixed in the constructor |
| `contracts/libraries/Math.sol`, `UQ112x112.sol` | core | Verbatim upstream libraries |
| `contracts/periphery/BDexRouter.sol` | periphery | Router with deadlines, recipient guards, anchored exact-in swaps |
| `contracts/periphery/BDexLibrary.sol` | periphery | Quote math, registry-based `pairFor`, path validation |
| `contracts/periphery/BDexLens.sol` | periphery | Read-only discovery and quotes (holds no funds, takes no approvals) |
| `contracts/assets/WBLCH.sol` | asset | Wrapped native token |
| `contracts/interfaces/*`, `contracts/periphery/interfaces/*` | interfaces | |

Out of scope:

- `contracts/TreasuryFeeCollector.sol`: kept in the tree, **not deployed** on
  mainnet (MAINNET-READINESS.md A5). The fee goes directly to the Bloch Inc Safe.
- `contracts/assets/BlochAsset.sol`: fixed-supply issuance helper, not part of
  the mainnet DEX deployment.
- The Safe v1.4.1 itself, bridged tokens (wGSMH, bUSDC), the L2 node and RPC,
  the deployment scripts and the finality gate (`scripts/staging/`), and the
  frontend.

## 3. Differences from upstream Uniswap V2 and their review

Upstream reference: Uniswap `v2-core` (0.5.16) and `v2-periphery` Router02.

### 3.1 Pair (`UniswapV2Pair.sol`)

| Change | Review |
|---|---|
| Solidity 0.8.24 port; TWAP timestamp, elapsed time and cumulative prices are in an `unchecked` block | Correct: upstream relies on wrapping in exactly these places. Everything else is checked arithmetic, which is equivalent to SafeMath |
| `initialize` also requires `token0 == token1 == 0`, a nonzero `token0` and `token0 < token1` | Stricter than upstream; only the factory can call it, once |
| **Reserve caps**: `reserveCap0/1` are copied from the factory at `initialize`; `_update` refuses a balance above `max(cap, previous reserve)` on a capped side | Caps bind only reserve growth. Mint, swap input, flash-swap repayment and `sync` all go through `_update`, so no path grows a reserve past its cap (fuzzed and invariant-tested). Outflows reduce the reserve and stay open |
| **Burn exit bound (fix DEX-01, this branch)**: burn records each reserve as `min(balance, max(cap, previous reserve))` on a capped side | Before the fix, a donation could make burn revert with `RESERVE_CAP`. The excess stays outside the reserves and anyone can skim it. Recording up to the cap equals what `donate + sync` already allows, so this gives no new capability |
| `_mintFee` reads `feeTo()` from the factory, where it is now `immutable` | Same selector and same closed form as upstream. Because `feeTo` cannot change, upstream's toggle-off/on `kLast` subtlety cannot arise |
| `swap`, `skim`, `sync`, `mint` and `burn` math | Identical to upstream (the `lock` latch, the optimistic transfer, the 0.3% adjusted k check, `MINIMUM_LIQUIDITY = 1000` sent to `address(0)`) |
| Error strings use the `BDEX:` prefix | Cosmetic |

### 3.2 LP token (`UniswapV2ERC20.sol`)

| Change | Review |
|---|---|
| `DOMAIN_SEPARATOR()` is computed from the live `block.chainid` | Permits signed before a chain-ID change die with it. It cannot tell apart forks that keep the same chain ID (documented) |
| `permit` requires `v ∈ {27, 28}` and a low-s signature, and checks the recovered signer is nonzero | Removes ECDSA malleability. Aderyn L-1 is a false positive |
| Name `Bloch DEX V2`, symbol `BDX-V2` | Cosmetic |

### 3.3 Factory (`UniswapV2Factory.sol`)

| Change | Review |
|---|---|
| `feeTo` is `immutable` and set by the constructor. `feeToSetter`, `setFeeTo`, `setFeeToSetter`, `acceptFeeToSetter` and `cancelFeeToSetterTransfer` are removed | No setter path (tested: `Core.t.sol::testFeeRecipientHasNoAdminSurface`, `Audit.t.sol::testNoAdminSelectorsOnFactoryOrPair`, `invariantCapsAndFeeRecipientAreConstant`). `address(0)` means fee off. There is no zero check by design; mainnet requires Bloch Inc, enforced by the config validator and by `DeployMainnet.s.sol` |
| `reserveCap` mapping is written only in the constructor (`0 < cap <= uint112.max`, no duplicates, no zero token) | No setter |
| `createPair` requires both tokens to have code. It uses `new Pair{salt}` and exposes `INIT_CODE_PAIR_HASH()` | Address derivation is the same as upstream; the hash differs from upstream's and is pinned in `Core.t.sol` |

### 3.4 Periphery

| Change | Review |
|---|---|
| `BDexLibrary.pairFor` resolves pairs through `factory.getPair` and reverts on a missing pair | No init-code-hash constant in periphery; a missing pool cannot silently receive tokens |
| `validatePath`: length 2–5, no zero or repeated adjacent tokens, no pool used twice | Prevents stale multi-hop quotes |
| `getAmountOut/In` bound reserves and inputs to `uint112` | Fails with a named error instead of the pair's `OVERFLOW` |
| Router: deadline on every state-changing path; recipient guards (not zero, not the router, not the pair being swapped, not WBLCH for native) | Removes known foot-guns |
| Router `_addLiquidity` treats `totalSupply == 0` as a fresh pool (upstream: `reserves == 0`) and enforces both minimums | A donation plus `sync` cannot block the first mint. It can set an arbitrary opening ratio; see DEX-04 |
| `...Anchored` exact-in swaps (`anchorNumber < block.number`, nonzero hash, `blockhash(anchorNumber) == anchorHash`) | Context binding against replay onto a fork the user never saw. Fails closed if the anchor is outside the 256-block window or the chain lacks `BLOCKHASH` (DEX-05) |
| Fee-on-transfer variants measure deltas; the native fee-on-transfer remove forwards only this call's delta | Same as upstream plus protection against pre-existing router balances |
| Native refunds use `call` and revert on failure | |
| `BDexLens`: view-only; reports hops that would exceed a cap as unavailable | Holds no funds and takes no approvals |

### 3.5 WBLCH

A WETH9-style contract that refuses transfers to `address(0)` or to itself and
approvals to zero or itself, and guards `withdraw` with a latch. It follows
checks-effects-interactions; the Slither `reentrancy-eth` and Aderyn H-1/H-2
reports on it are false positives.

## 4. Invariants and properties under test

| # | Property | Where |
|---|---|---|
| I1 | k never decreases across a swap or flash swap; the canonical quote plus 1 fails with `K` | `invariantSwapsNeverReduceK`, `testFuzzSwapPreservesKAndOverquoteFails`, `Invariant.t.sol` |
| I2 | Reserves never exceed the caps on a capped pair, under any interleaving of swap, flash, add, remove, donate, sync and skim | `invariantReservesNeverExceedCaps` |
| I3 | Reserves never exceed balances | `invariantReservesAreBackedByBalances` |
| I4 | LP accounting is closed: supply = LPs + fee recipient + 1000 locked; the pair holds none of its own shares between calls | `invariantShareAccountingIsClosed` |
| I5 | The fee recipient's mint at every liquidity event equals the v2 closed form, and `kLast = r0·r1` afterwards | `invariantProtocolFeeMatchesMintFee`, `testFuzzMintFeeMatchesClosedFormAndOneSixthBound` |
| I6 | The fee is never more than 1/6 of the sqrt(k) growth: `fee·6·√k <= (supply + fee)·(√k − √kLast)` | `testFuzzMintFeeMatchesClosedFormAndOneSixthBound` |
| I7 | Burn is never blocked (DEX-01); any donation remains skimmable | `invariantExitsAreNeverBlocked`, `testFuzzBurnNeverBlockedByDonation`, `testDonationAboveCapCannotBlockSmallBurn` |
| I8 | Only documented revert reasons occur (`RESERVE_CAP` for growth past a cap, `LOCKED` for reentry) | `invariantOnlyDocumentedReverts` |
| I9 | Caps and fee recipient are constant; no admin selector exists on the factory or the pair; `initialize` cannot run twice | `invariantCapsAndFeeRecipientAreConstant`, `testNoAdminSelectorsOnFactoryOrPair`, `ReserveCap.t.sol::testCapsHaveNoSetter` |
| I10 | Reentry into swap, mint, burn, skim or sync from a flash callback or a token transfer hook hits `LOCKED` | `testFlashCallbackReentryHitsLockOnEveryEntrypoint`, `testTokenHookReentryHitsLockOnEveryEntrypoint` |
| I11 | Rounding favours the pool: mint never issues more than pro rata, burn never pays more than pro rata, `getAmountOut(getAmountIn(x)) >= x` | `testFuzzMintBurnRoundingFavoursPool`, `testFuzzGetAmountInCoversRequestedOutput` |
| I12 | Cap bypass is refused through transfer + sync, mint and flash repayment in the capped token | `testFuzzTransferThenSyncCannotExceedCap`, `testFuzzMintCannotExceedCap`, `testFlashSwapRepaidInCappedTokenCannotExceedCap` |
| I13 | First-depositor inflation (mint 1 share, donate, sync) never profits the attacker | `testFuzzFirstDepositorInflationIsUnprofitable`, `Core.t.sol` |
| I14 | Skim returns exactly the excess and touches no reserves, shares or `kLast` | `testFuzzSkimReturnsExactExcessOnly` |
| I15 | An anchored swap refuses the current block, future blocks, a zero hash, an expired anchor and a wrong hash | `testAnchorRejectsFutureCurrentZeroAndExpiredBlocks`, `AnchoredSwap.t.sol` |

The invariant handler (`test/AuditInvariant.t.sol`) drives a pair with both
sides capped and the protocol fee on. It leaves standing donations above the
caps between calls. When the burn fix is reverted, it reports I4 and I7 as
violated.

## 5. Test counts

| Suite | Count |
|---|---|
| `forge test` (20 suites, release candidate) | **167 passed**, 0 failed (159 at the end of this review, then 6 for the Lens pending excess and 2 for DEX-09) |
| Default profile | fuzz 512 runs; invariant 128 runs × depth 64, `fail_on_revert = true` |
| Deep run of the audit suites | `FOUNDRY_FUZZ_RUNS=10000 FOUNDRY_INVARIANT_RUNS=1024 FOUNDRY_INVARIANT_DEPTH=128`: 27/27 passed, 131,072 handler calls per invariant |
| `node --test scripts/staging/*.test.mjs` | 31 passed (plan and gate tooling, with the new pair artifacts) |

## 6. Findings

Severity follows the usual scale: impact on funds or availability, weighed by
likelihood.

### DEX-01 (Medium, fixed): a donation could block LP exits on a capped pair

`_update` refuses a balance above `max(cap, previous reserve)`. `burn` pays
pro rata from balances, so with a donation in place the post-burn balance
could stay above both. Example: reserve0 = cap = 1000, donation 500, burn of
10% of the shares leaves 1350 > 1000, and the burn reverts with
`BDEX: RESERVE_CAP`. The existing regression test burned 50%, which happened
to fall below the old reserve. This contradicted the documented property that
"withdrawals and outflows are never blocked". A donor who could order
transactions (or win the race) could block exits for the cost of a donation
that anyone may then skim. The fix bounds the reserve that burn records (see
3.1). It is covered by I7 and fails without the fix. It changes the pair init
code hash (section 1).

### DEX-02 (Low, accepted residual risk): a standing donation above the cap blocks inflows on that side

While a capped side's balance exceeds `max(cap, reserve)`, every swap or mint
that touches that side reverts with `RESERVE_CAP`, including swaps that take
that token out, if the donation exceeds the output. Anyone can clear the
excess with `skim` and keep it, so the griefer loses the donation each time.
Burn is unaffected after DEX-01.

**Accepted by the owner on 2026-10-30, with no pair change.** The griefer pays
the full donation each time and anyone can take it back with one call, so the
attack has a cost and no profit; the worst outcome is a pause on one pool until
the next `skim`, with exits open throughout. `BDexLens.pendingExcess(pair)`
reports the excess per side and whether it blocks inflows, and the mainnet
route shows it with a skim button (the caller receives the excess). Covered by
`LensPendingExcessTest` in `test/Lens.t.sol` and by the mainnet rehearsal.

### DEX-03 (Low, known F4): caps are per pair, not aggregate

`createPair` is permissionless, so the total exposure to a capped token is
(number of pairs) × cap. Documented in MAINNET-READINESS.md F4. Every token
of a planned pair must be capped.

### DEX-04 (Informational; synced form closed by the DEX-09 fix): a donation sets the opening ratio of a fresh pool

The router treats `totalSupply == 0` as fresh and deposits the desired
amounts as given. If someone has donated and synced first, the opening price
is (donation + deposit), not the LP's ratio. The first LP owns that donation
(minus 1000 locked shares). For a constant-product pool the arbitrage profit
from the mispricing never exceeds the donation, so the attack does not pay;
`testFuzzFirstDepositorInflationIsUnprofitable` covers the related share
inflation case. Recommendation: the frontend shows the resulting price for a
first deposit when reserves are nonzero.

Since the DEX-09 fix a donation cannot be synced into an empty pair, so reserves
stay zero until the first mint. The unsynced form remains: a donation already in
the pair counts toward the first mint. `skim` removes it, the ops seed planner
asks for that first, and its `verify` checks the opening price afterwards.

### DEX-09 (Low, fixed): donations could permanently block an empty pair

Found by the DEX operations review. With no LP shares, syncing donations equal to
both caps made `mint` and `swap` revert forever, and `createPair` refuses a second
pair, so recovery needed a new factory, router and lens. The griefer lost both
donations and no user funds were at risk. `sync` now requires `totalSupply != 0`
(`BDEX: EMPTY_POOL`). Reserves of a pair with no LP shares therefore stay zero, and
shares never return to zero after the first mint (1,000 are locked). Covered by
`testDonationsAtBothCapsCannotBrickTheEmptyPair` and
`testFuzzEmptyPairReservesStayZero`. It changes the pair init code hash.

### DEX-05 (Informational): anchored swaps depend on L2 `BLOCKHASH`

`anchored` uses `blockhash`, so the L2 must serve canonical hashes for the
last 256 blocks (MAINNET-READINESS D15). At 10–20 minutes per L2 block that
window is several days. If the hashes are missing, anchored swaps fail
closed. Only exact-in swaps have anchored variants, and liquidity operations
are not anchored; that is by design. Anchoring does not replace
`amountOutMin`.

### DEX-06 (Informational, fixed in the Lens): pending donations in quotes

`BDexLens._quote` checked `reserveIn + amountIn <= cap` but not
`balance − reserve`, so with a standing donation (DEX-02) a quote could be
reported as available and still revert. View-only; no funds were at risk. It
now applies the check `UniswapV2Pair._update` applies, to the balance a swap
leaves on each side. `testFuzzQuoteAvailabilityMatchesExecution` requires quote
availability to equal execution under any two standing donations. The Lens
runtime hash changed; the pair init code hash did not.

### DEX-07 (Informational): donations also pay the protocol fee

Canonical behaviour: any sqrt(k) growth, including `donate + sync`, pays the
fee recipient 1/6 at the next liquidity event
(`testDonationSyncAccruesProtocolFee`).

### DEX-08 (Informational): `feeTo` has no zero-address check

By design, `address(0)` means the fee is off. The mainnet config requires
`fees.feeTo = "blochInc"`, and `DeployMainnet.s.sol` checks the Safe's code
and owners.

## 7. Static analysis triage

Tools ran in a scratch environment on the build host: Slither 0.11.6
(102 detectors, 96 results) and Aderyn 0.6.8 (3 high, 13 low). The raw outputs
are in `docs/audit/slither-20261030.txt` and `docs/audit/aderyn-20261030.md`.

| Tool / detector | Location | Triage |
|---|---|---|
| Slither `weak-prng`, Aderyn H-3 | `Pair._update` timestamp truncation | False positive: TWAP timestamp, not randomness |
| Slither `reentrancy-balance` (6) | `TreasuryFeeCollector._redeemExact`; router `swapExactTokensForBLCHSupportingFeeOnTransferTokens` | Collector out of scope (not deployed). Router: only the caller's own minimum is affected, the router holds no funds between calls, and the pair calls are behind `lock` |
| Slither `reentrancy-eth`, Aderyn H-1/H-2 | `WBLCH.withdraw` | False positive: balance is debited before the call, and there is a latch |
| Slither `reentrancy-no-eth` / `-benign` / `-events`, Aderyn H-2 | Pair `swap`/`burn`, `Factory.createPair` | Canonical pattern behind `lock` (I10). `createPair` calls only the freshly deployed pair |
| Slither `incorrect-equality` | `_totalSupply == 0`, `_safeTransfer`, Lens zero checks | False positive |
| Slither `unused-return` | Ignored `blockTimestampLast` and `sortTokens` second value | False positive |
| Slither `uninitialized-local` | `BDexLens.bestExactInput.bestOut` | False positive: zero is the intended start value |
| Slither `events-maths` | Caps copied in `initialize` | Informational: the factory emits `ReserveCapSet`, and the pair exposes `reserveCaps()` |
| Slither `missing-zero-check` | Factory `feeTo` | DEX-08 |
| Slither `calls-loop`, `timestamp`, `low-level-calls`, `naming-convention`, `too-many-digits`, `immutable-states` | Various | Informational / style; `immutable-states` is `UniswapV2Pair.factory` (upstream layout, kept so the pair code stays canonical) |
| Aderyn L-1 | `ecrecover` malleability | False positive: low-s and `v` are enforced |
| Aderyn L-2..L-13 | Style | Informational |

## 8. Known limitations (carried over)

- Taxed and rebasing tokens are not made safe by the invariant; use the
  fee-on-transfer router paths, and do not list such tokens.
- TWAP accumulators wrap by design; consumers must use modular differences.
- Permits use EVM ECDSA and are not post-quantum. Bloch L1 authorization is a
  separate boundary.
- There is no external audit yet (MAINNET-READINESS F5). Caps stay at the
  pilot values until stage 1.
