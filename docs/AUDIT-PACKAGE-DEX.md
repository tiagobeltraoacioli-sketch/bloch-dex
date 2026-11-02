# Postern DEX: external audit package (DEX-8)

Prepared 2026-11-02 for an external security audit firm. This is the single entry
document for the engagement. It points to `AUDIT-SCOPE-DEX.md` (internal
pre-audit review, 2026-10-30, updated through the RC) for detail, but every fact
an auditor needs to quote, scope or start the work is here.

Status of the code: **unaudited, not deployed**. Nothing has been deployed to the
target chain (Bloch L2 mainnet, chain ID 700770).

## 1. Revision to audit

| Item | Value |
|---|---|
| Repository | `postern-dex` (private; the owner delivers a git bundle of the audit commit) |
| Audit commit (RC) | `86c6f2c64140b3d6aa59e800efc78faad517fa6d` on `codex/dex-mainnet-rc-20261030` |
| Contracts commit | `d18ab04f1db68350427362128829f88dba8bac9b`. `git diff d18ab04 86c6f2c6 -- contracts foundry.toml` is empty. It is the `source.revision` in `deployments/mainnet/dex-mainnet.config.json` |
| Deploy script commit | `script/DeployMainnet.s.sol` changed after `d18ab04` (`0201d54`: passes `firstDepositor`, refuses `address(0)`, a shared role or a used depositor key); audit it at `86c6f2c6` |
| This package | `codex/dex-audit-pack-r10-20261102`, docs only on top of `86c6f2c6` |
| Compiler | solc 0.8.24, `evm_version = paris`, optimizer on, 200 runs, `bytecode_hash = none` (`foundry.toml`) |
| Toolchain used for the figures here | forge 1.7.1 (`4072e48`), node v24.21.0 |
| Target EVM | Bloch L2: unmodified revm at `SpecId::CANCUN` (L2 repo `src/chainspec.rs:121`). Prague and EIP-7702 are not active (`integrations/reth-execution/tests/node_provider.rs:57`), so an EOA cannot carry delegated code |

### Code hashes at the audit commit (recomputed for this package)

Creation code includes constructor code but not constructor arguments. Runtime
hashes of the factory, router and lens are before immutables are filled in, so a
deployed instance differs; `scripts/staging/verify-deployment.mjs` checks deployed
code against the plan.

| Contract | Creation keccak (bytes) | Runtime keccak (bytes) |
|---|---|---|
| `UniswapV2Pair` (= `INIT_CODE_PAIR_HASH`) | `0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683` (10,247) | `0x7430d38c0cae8577ce0caa0dd73c08ff668a6f0a849f3418a76f2993e0588d16` (10,192) |
| `UniswapV2Factory` | `0x6dc63b494cdfc7b3962e651b80e66dac4042871f9f84b2b7940aac5c1cffeb03` (12,967) | `0xf6eb95c7…b695` (11,747, immutables unset) |
| `BDexRouter` | `0x9d2ccb89a9a88716369c124492aa17042ae12d70d2fcc36f1c32c4303612c33f` (19,345) | `0x578d9744…249e` (18,636, immutables unset) |
| `BDexLens` | `0x52e232637401ad53411c73358cb41dd2813cefead7884c6fcc2c17430dac70c9` (10,472) | `0x6f0e7f81…6f1b` (10,180, immutables unset) |
| `WBLCH` | `0x9946e0055b0872f93404a801850f387f3b741ef35f90d0bc71b8c165fcd9b007` (2,620) | `0x09b5b121f866f2c565e1ffead9867bb0a5a08e07369b239ccd38e8d1a73a928c` (2,588) |

### SHA-256 of the in-scope source files

```
2f6e311d9bb96f56909004372c8e9cb187b6f3c5b2fc22dbb49afc3393f33f47  contracts/UniswapV2Pair.sol
6178f39100c9c70280cd6c96ab16867eb6f5d3095d0d0e44cc162f334a2015b7  contracts/UniswapV2ERC20.sol
0dda88680584e5a85946ff73ec09dc0960fe886d3f09c2aaebb4129b1d67c82c  contracts/UniswapV2Factory.sol
fcc03c40e3baa968690acf2272cea9bd79af9f2a354ebb2182c127f0c6f3c990  contracts/libraries/Math.sol
32a6cc6b9b901afbf91aa8aa885f070a31473de30f43ca19c69f34542b92af73  contracts/libraries/UQ112x112.sol
351714808b45489e213d585d48150702d4f017553150726ffd6485c7f0e27d1d  contracts/periphery/BDexRouter.sol
a539239a631a2af00bc346ac37b56b2ebb0feb31e0419c8b58275440b4655cd4  contracts/periphery/BDexLibrary.sol
8ed56f5589833d7dfdc45c5cb9c6cd02b3fad01a7a6dbf41ec1500b440a443b8  contracts/periphery/BDexLens.sol
c7b9e0ffaac5a21fd4498336d6c99f9af500eaa3a4f00b33dc9be2891fdeda33  contracts/assets/WBLCH.sol
edf2cdf9b81213d3c91d3bdacf6eb4691b6a6c358f4ac1a9c0839339e5bdec8c  script/DeployMainnet.s.sol
12bc8b2abf48755ab2743fdd41ddd0155232c82c733a0546816f501875f47c44  scripts/staging/deploy-dex.mjs
4e640e200d5109695c8286e5a7be209307f2797eeb430d3382b06b1261f80e93  scripts/staging/dex-deploy-config.mjs
1c3aaeea43b4872a8fc7a53bc76c83fe1270941a1c21c9fce8a5d84a79d5bea8  scripts/staging/finality-gate.mjs
7c872712cd72b6e68a8edb1b8c445ecf17dc9f3ba47511b4650e80e84f1409e2  scripts/staging/check-finality-gate-mainnet.mjs
c71aa27f54351daaecae288d7008982f8c3e38ea32173b1a432f14f91cbdd719  scripts/staging/sign-and-publish.sh
8652484f1eea1706b020a743b1647686272f4f7275512286f31ee0b3393a3322  scripts/staging/verify-deployment.mjs
eb49d51981e82f67f699e60c7f36ba58ceb86ba57968f8415956fffc33e3ab61  scripts/ops/dex-seed-plan.mjs
435330511582858ef99f4801321a4a45a4fad49b25e6009f3b3f83026842f6ff  scripts/ops/dex-ops-lib.mjs
36bd48c92344d67a58c286f28d6768efb0dc695ebcf5a042d05934344a05e218  deployments/mainnet/dex-mainnet.config.json
```

## 2. Scope and size

nSLOC is counted by `docs/audit/nsloc.py`: comments and blank lines removed, and a
construct wrapped over several lines (open `(` or `[`) counted once. The raw table
is `docs/audit/nsloc-86c6f2c6.tsv`.

### 2.1 Tier A: on-chain code (required)

| File | SLOC | nSLOC | Upstream base | Novelty |
|---|---:|---:|---|---|
| `contracts/UniswapV2Pair.sol` | 213 | 198 | v2-core `UniswapV2Pair` | **High**: caps, k ceiling, exit bound, first depositor, empty-pool sync |
| `contracts/UniswapV2Factory.sol` | 45 | 45 | v2-core `UniswapV2Factory` | Medium: immutable `feeTo` and `firstDepositor`, constructor caps, no setters |
| `contracts/UniswapV2ERC20.sol` | 75 | 61 | v2-core `UniswapV2ERC20` | Low: live-chainid domain, low-s permit |
| `contracts/libraries/Math.sol` | 18 | 18 | v2-core | None (verbatim) |
| `contracts/libraries/UQ112x112.sol` | 10 | 10 | v2-core | None (verbatim) |
| `contracts/periphery/BDexRouter.sol` | 467 | 302 | v2-periphery `UniswapV2Router02` | Medium: recipient guards, anchored swaps, fresh-pool rule, fee-on-transfer deltas |
| `contracts/periphery/BDexLibrary.sol` | 101 | 97 | v2-periphery `UniswapV2Library` | Medium: registry `pairFor`, `validatePath`, uint112 bounds |
| `contracts/periphery/BDexLens.sol` | 202 | 199 | none | **New**, view-only: discovery, quotes with cap checks, `pendingExcess` |
| `contracts/assets/WBLCH.sol` | 63 | 63 | WETH9 | Low: recipient and spender guards, withdraw latch |
| `contracts/interfaces/*.sol` (5 files) | 81 | 74 | v2 | Interfaces |
| `contracts/periphery/interfaces/*.sol` (2 files) | 160 | 47 | v2 | Interfaces |
| **Total on-chain** | **1,435** | **1,114** | | Logic without interfaces: **993 nSLOC** |

### 2.2 Tier B: deployment path (required)

| File | SLOC / nSLOC or code lines | Role |
|---|---:|---|
| `script/DeployMainnet.s.sol` | 202 / 157 nSLOC | Deterministic deployment: chain guard, nonce, planned addresses and code hashes, `firstDepositor != 0`, Safe checks |
| `scripts/staging/dex-deploy-config.mjs` | 510 code lines | Config validator (refuses `address(0)` depositor, uncapped tokens, caps above `bucketCapacity / 10`, shared roles) |
| `scripts/staging/deploy-dex.mjs` | 237 | Plan, preflight, raw transactions, record and verify the broadcast; `check-pair` against a front-run `createPair` (F2) |
| `scripts/staging/sign-and-publish.sh` | 73 | Offline `cast mktx` signing; refuses wrong chain ID, genesis, signer, nonce or occupied address |
| `scripts/staging/verify-deployment.mjs` | 223 | Post-deployment code, immutables and pair checks |
| `scripts/staging/finality-gate.mjs`, `check-finality-gate-mainnet.mjs` | 507 + 45 | The finality gate (section 3.6) |
| `scripts/ops/dex-seed-plan.mjs`, `dex-ops-lib.mjs` | 273 + 240 | First-deposit planner: opening ratio, fraction cap 8,000 bps, `--write-txs` raw-tx file, `note-tx`, `verify --to` |
| **Total tier B** | **157 nSLOC + about 2,100 JS/shell code lines** | |

"Code lines" for JavaScript and shell are non-blank lines that are not comment lines.

### 2.3 Tier C: operations (optional, recommended)

| File | Code lines | Role |
|---|---:|---|
| `scripts/ops/dex-skim-keeper.mjs` | 243 | Permissionless `skim` keeper, recipient fixed to the Bloch Inc Safe, budgeted |
| `scripts/ops/dex-monitor.mjs` | 263 | Monitor: caps, excess, closed-by-excess, LP recipient, bridge token state |
| `scripts/ops/dex-fee-redeem.mjs` | 176 | Builds the Safe's LP fee redemption |

### 2.4 Out of scope

- `contracts/TreasuryFeeCollector.sol` (136 nSLOC): in the tree, **not deployed**; the protocol fee goes directly to the Safe.
- `contracts/assets/BlochAsset.sol`, `script/CreatePair.s.sol`, `script/LocalDeployment.s.sol`, `script/DeployAsset.s.sol`: not on the mainnet path.
- Safe v1.4.1, Multicall3 and the CREATE2 deployer (`deploy-infra.mjs`, `deploy-safe.mjs`): ordinary deployments of reviewed third-party code, verified by code hash.
- The bridged quote token (bUSDC, `BridgedStablecoinV3`) and its bridge: a separate engagement (section 11). Its interaction with the pool is in scope only as described in section 5.
- The L2 node, settled RPC, prover and guest; the frontend; `scripts/publication-quorum*` and `scripts/devnet4/*` (legacy).

## 3. Differences from Uniswap V2

Upstream reference: Uniswap `v2-core` (Solidity 0.5.16) and `v2-periphery`
`UniswapV2Router02`. The port is 0.8.24 with checked arithmetic except the TWAP
block, which keeps upstream's intended wrapping (`UniswapV2Pair.sol:175-186`).

### 3.1 Constructor-fixed reserve caps

- `UniswapV2Factory.sol:38-52`: `reserveCap[token]` is written only in the constructor (`0 < cap <= uint112.max`, no duplicate, no zero token). No setter exists.
- `UniswapV2Pair.sol:116-127`: the pair copies both caps at `initialize`.
- `UniswapV2Pair.sol:166-173`: `_update` refuses a balance above `max(cap, previous reserve)` on a capped side. Mint, swap input, flash repayment and `sync` all pass through it. Outflows are not restricted.
- `UniswapV2Pair.sol:222-230, 328-334`: burn records each reserve as `min(balance, max(cap, previous reserve))` (fix DEX-01), so a donation cannot block an exit.
- `UniswapV2Pair.sol:80-86, 196-220`: **k ceiling (fix F1)**. On a pair capped on both sides, `reserve0 * reserve1 <= 0.64 * cap0 * cap1`. Mint and `sync` revert with `BDEX: K_CEILING` (`strict`). Swap and burn record less on the side that grew and leave the rest outside the reserves, where `skim` removes it. Purpose: both reserves can never sit at their caps, the one state where no swap passes in either direction.
- `UniswapV2Pair.sol:416-421`: `sync` requires `totalSupply != 0` (fix DEX-09), so reserves of a pair with no LP shares stay zero.
- Launch caps: WBLCH 10e18, bUSDC 1e9 (1,000 bUSDC at 6 decimals), and a bUSDC cap at most one tenth of the token's `bucketCapacity()` (`dex-mainnet.config.json`, enforced by `dex-deploy-config.mjs` and the gate).

### 3.2 Constructor-fixed first depositor

- `UniswapV2Factory.sol:26-29`: immutable `firstDepositor`. `address(0)` turns the rule off in the factory; every mainnet tool refuses `address(0)`.
- `UniswapV2Pair.sol:286-295`: the first mint of every pair requires `msg.sender == firstDepositor || tx.origin == firstDepositor`, or reverts `BDEX: FIRST_DEPOSITOR`. `tx.origin` is deliberate: it lets the depositor EOA seed atomically through the router. The rule is one-shot per pair: once `totalSupply > 0` it never returns, because 1,000 shares are locked at `address(0)`.

### 3.3 Protocol fee to the Bloch Inc Safe

- `UniswapV2Factory.sol:23-24, 40`: `feeTo` is `immutable`, set in the constructor to the Bloch Inc Safe (Safe v1.4.1). `feeToSetter`, `setFeeTo` and `setFeeToSetter` are removed. Pairs read it through the same `feeTo()` selector, so the pair init code does not depend on it.
- `UniswapV2Pair.sol:247-265`: `_mintFee` is upstream's closed form (1/6 of sqrt(k) growth, minted as LP shares at the next liquidity event). Because `feeTo` cannot change, upstream's toggle-off/on `kLast` case cannot arise.
- `DeployMainnet.s.sol` and the gate check the Safe's singleton, owners, threshold, modules, guard and fallback handler before the factory is accepted.

### 3.4 Skim and the keeper

- `skim` is upstream code (`UniswapV2Pair.sol:401-406`). What changed is its role: at the k ceiling, swap fees and donations stay **outside** the reserves, and a standing excess above a cap blocks inflow on that side (DEX-02). `skim` is the permissionless recovery, and it pays the caller.
- `BDexLens.pendingExcess(pair)` (`BDexLens.sol:124`) reports the excess per side and whether it blocks inflow.
- Off-chain, `scripts/ops/dex-skim-keeper.mjs` calls `skim(BlochIncSafe)` only on pinned pairs whose code hashes match, with a 24 h budget (0.05 BLCH, 48 transactions by default), a varying tip and backoff. A stolen keeper key can spend only the gas budget.

### 3.5 Periphery

- `BDexLibrary.pairFor` (`BDexLibrary.sol:47`) resolves through `factory.getPair` and reverts on a missing pair; there is no init-code-hash constant in the periphery.
- `validatePath` (`BDexLibrary.sol:21`): length 2 to 5, no zero or repeated adjacent token, no pool used twice.
- Router: deadline on every state-changing path; recipient guards (not zero, not the router, not the pair being swapped, not WBLCH for native); `_addLiquidity` treats `totalSupply == 0` as a fresh pool (`BDexRouter.sol:134`; upstream uses reserves); native refunds by `call`, reverting on failure; fee-on-transfer variants measure deltas.
- **Anchored exact-in swaps** (`BDexRouter.sol:44-50`, `...Anchored` at 448-482): require `anchorNumber < block.number`, a nonzero hash and `blockhash(anchorNumber) == anchorHash`, binding an order to the chain the user saw. They fail closed outside the 256-block window. They are **not enabled in the mainnet UI** (owner decision); they are in scope as deployed code.
- `BDexLens`: view-only, holds no funds, takes no approvals; quotes mark a hop unavailable if it would fail the pair's cap check, standing excess included (DEX-06).

### 3.6 The finality gate (off-chain)

The L2's `finalized` block comes from native FFG finality replayed from the pinned
L1 genesis. `scripts/staging/finality-gate.mjs` reads everything at `finalized`:
chain ID and genesis hash (pinned once in the config), factory immutables
(`feeTo`, `firstDepositor`), caps, pair identity, init code hash, the depositor's
nonce and history, token `bucketCapacity()`, and the Safe's configuration. The
seed, the monitor and the keeper refuse to act unless the gate passes. There are
no signed checkpoints, cap approvals or reviewer quorums: trust roots are set
once. The frontend reads balances and caps at `finalized` and compares with
`latest` (out of scope).

### 3.7 LP token and WBLCH

- `UniswapV2ERC20.sol:38-44`: `DOMAIN_SEPARATOR()` is computed from the live `block.chainid`. `:110`: `permit` requires `v ∈ {27, 28}` and low-s; the recovered signer must be nonzero.
- `WBLCH.sol`: WETH9-style; refuses transfer to `address(0)` or itself, approval of zero or itself; `withdraw` debits before the native send and holds one global latch (`:32-43`).

## 4. Roles and trust model

| Role | Power | Fixed where |
|---|---|---|
| Deployer EOA | Sends the planned deployment transactions at consecutive nonces. No power afterwards | `deployer` in config, checked by `DeployMainnet.s.sol` |
| First depositor EOA | Makes the first mint of each pair, once. Fresh key, only an approve and the seed | Factory immutable |
| Bloch Inc Safe (v1.4.1) | Receives protocol fee LP shares and keeper skims | Factory immutable `feeTo` |
| Keeper EOA | Can call `skim(Safe)`; gas budget only | Off-chain |
| Anyone | `createPair` (permissionless; both tokens must have code), swap, LP, `skim`, `sync` | |

There is no owner, pause, upgrade or proxy anywhere in tier A.

## 5. Interaction with the bridged quote token (bUSDC)

The pair and router only call `transfer`, `transferFrom` and `balanceOf`. For
`BridgedStablecoinV3` (bridge `9f91a56`) these have no pause, hook, block list or
fee (agent 139). Known effects outside the pool, documented in `OPS-DEX-INCIDENTS.md`:

- a bridge pause stops inflow from Ethereum, not the pool;
- after a forged mint is credited, bUSDC taken out of the pool may be held at the bridge exit (`ProvenanceMismatch`); a forger can dump at most to the bUSDC cap (about 49.9% of the WBLCH side at a half-cap seed);
- a mint queued with the pair as recipient credits later as excess (DEX-02, delayed).

## 6. Invariants and their tests

Test files are in `test/`. "Fuzz" is 512 runs; "invariant" is 128 runs × depth 64
with `fail_on_revert = true` (defaults in `foundry.toml`).

| # | Property | Tests (file:function) |
|---|---|---|
| I1 | k never decreases on swap or flash swap below the ceiling; the canonical quote plus 1 fails `K` | `Audit.t.sol:testFuzzSwapPreservesKAndOverquoteFails`, `Core.t.sol:testFuzzSwapMaintainsAdjustedInvariant` |
| I1b | At the k ceiling, k may fall only by less than one unit of the kept side and must end within that unit of the ceiling (A98-1/A98-2) | `AuditInvariant.t.sol:invariantSwapsNeverReduceK` (anchored form, line 96 comment) |
| I2 | Reserves never exceed caps, under any interleaving | `AuditInvariant.t.sol:invariantReservesNeverExceedCaps`, `F1SeededInvariant.t.sol:invariant_bounds` (3 openings) |
| I3 | `reserve0 * reserve1 <= 0.64 * cap0 * cap1` on a two-side-capped pair | `AuditInvariant.t.sol:invariantKNeverExceedsCeiling`, `KCeiling.t.sol` (19 tests) |
| I4 | Reserves are backed by balances | `invariantReservesAreBackedByBalances`, `Invariant.t.sol:invariantReservesAndSharesRemainBacked` |
| I5 | LP accounting is closed: supply = holders + fee recipient + 1,000 locked; the pair holds none of its own shares | `invariantShareAccountingIsClosed` |
| I6 | Fee recipient mint equals the v2 closed form; `kLast = r0*r1` after each liquidity event; fee ≤ 1/6 of sqrt(k) growth | `invariantProtocolFeeMatchesMintFee`, `Audit.t.sol:testFuzzMintFeeMatchesClosedFormAndOneSixthBound`, `testDonationSyncAccruesProtocolFee`, `testFeeOffFactoryNeverTracksKLast` |
| I7 | Exits are never blocked (DEX-01); donations remain skimmable | `invariantExitsAreNeverBlocked`, `F1SeededInvariant.t.sol:invariant_exit`, `Audit.t.sol:testFuzzBurnNeverBlockedByDonation`, `testDonationAboveCapCannotBlockSmallBurn`, `KCeiling.t.sol:testFullExitAtCeiling` |
| I8 | After any reachable state, a swap passes once excess is skimmed (F1) | `F1SeededInvariant.t.sol:invariant_swapAfterSkim`, `KCeiling.t.sol:testWashTradeCannotReachBothCaps` |
| I9 | Only documented reverts occur (`RESERVE_CAP`, `LOCKED`, `K_CEILING` on mint and sync only) | `invariantOnlyDocumentedReverts` |
| I10 | Caps, fee recipient and depositor are constant; no admin selector; `initialize` once | `invariantCapsAndFeeRecipientAreConstant`, `Audit.t.sol:testNoAdminSelectorsOnFactoryOrPair`, `Core.t.sol:testFeeRecipientHasNoAdminSurface`, `testPairCannotBeReinitializedEvenByFactory`, `ReserveCap.t.sol:testCapsHaveNoSetter` |
| I11 | Reentry from a flash callback or token hook into any entrypoint hits `LOCKED` | `Audit.t.sol:testFlashCallbackReentryHitsLockOnEveryEntrypoint`, `testTokenHookReentryHitsLockOnEveryEntrypoint`, `Core.t.sol:testFlashSwapRepaymentAndReentrancyLock` |
| I12 | Rounding favours the pool | `Audit.t.sol:testFuzzMintBurnRoundingFavoursPool`, `testFuzzGetAmountInCoversRequestedOutput`, `Core.t.sol:testFuzzExactOutputRoundsUp` |
| I13 | No cap bypass through transfer + sync, mint, or flash repayment | `Audit.t.sol:testFuzzTransferThenSyncCannotExceedCap`, `testFuzzMintCannotExceedCap`, `testFlashSwapRepaidInCappedTokenCannotExceedCap` |
| I14 | Share inflation by the first depositor never profits; an empty pair's reserves stay zero (DEX-09) | `Audit.t.sol:testFuzzFirstDepositorInflationIsUnprofitable`, `testFuzzEmptyPairReservesStayZero`, `testDonationsAtBothCapsCannotBrickTheEmptyPair` |
| I15 | Only the first depositor can make the first mint | `FirstDepositor.t.sol` (2), `Review51.t.sol` (7) |
| I16 | Skim returns exactly the excess and touches no reserve, share or `kLast` | `Audit.t.sol:testFuzzSkimReturnsExactExcessOnly` |
| I17 | Lens quote availability equals execution under standing donations | `Lens.t.sol:testFuzzQuoteAvailabilityMatchesExecution`, `LensPendingExcessTest` (6) |
| I18 | Anchored swaps refuse current, future, zero, expired and wrong anchors | `AnchoredSwap.t.sol` (2), `Audit.t.sol:testAnchorRejectsFutureCurrentZeroAndExpiredBlocks` |
| I19 | Permits: no replay across nonce or chain; high-s refused | `Core.t.sol:testPermitCannotReplayAcrossNonceOrChain`, `testPermitRejectsMalleatedHighSSignature` |
| I20 | WBLCH fully backed; failed sends roll back | `WrappedNative.t.sol` (8) |
| I21 | Deployment: exact planned addresses and code; refuses wrong chain, nonce drift, occupied address, zero depositor, shared roles, wrong Safe | `DeployMainnet.t.sol` (13) |

**Supplementary tests (not in the RC, tests only, contracts unchanged):**
`codex/dex-invariants-r7-20261102` @ `55c401e` adds agent 98's findings as pinned
tests (`testPinned_*`), agent 96's griefing scenes, a `TreasuryFeeCollector` suite
and a system invariant with the real WBLCH, router and lens: 38 suites, 269 tests,
and 43 deep invariant seeds (up to 256 × 500) all passing. Offer it to the auditor
as extra harnesses.

## 7. Known findings and their status

Severity is as the finder rated it. "Fixed" means a code, test or tooling change
is in the RC `86c6f2c6`. The auditor should treat every item below as known and
not report it again unless the fix or the reasoning is wrong.

### 7.1 Internal pre-audit review (agent 17, `AUDIT-SCOPE-DEX.md` section 6)

| ID | Sev. | Summary | Status |
|---|---|---|---|
| DEX-01 | Medium | A donation could block LP exits on a capped pair | Fixed (`_exitBound`); I7 |
| DEX-02 | Low | A standing donation above a cap blocks inflow on that side until `skim` | Accepted residual risk; Lens `pendingExcess`, keeper, monitor |
| DEX-03 | Low | Caps are per pair, not aggregate; `createPair` is permissionless | Accepted; mitigated by the first-depositor rule (no third party can open a pair) |
| DEX-04 | Info | An unsynced donation counts toward the first mint's ratio | Synced form closed by DEX-09; the seed planner skims first and verifies the price |
| DEX-05 | Info | Anchored swaps depend on L2 `BLOCKHASH` for 256 blocks | By design; fails closed |
| DEX-06 | Info | Lens quotes ignored pending excess | Fixed in the Lens; I17 |
| DEX-07 | Info | Donations also pay the protocol fee | Canonical behaviour |
| DEX-08 | Info | `feeTo` has no zero check | By design; tooling requires the Safe |
| DEX-09 | Low | Donations synced to both caps could brick an empty pair | Fixed (`EMPTY_POOL`); I14 |

### 7.2 Independent review at `258fdd2` (agent 51)

| ID | Sev. | Summary | Status |
|---|---|---|---|
| F1 | High (liveness) | A mint to both caps closes the pair to swaps and mints | Fixed by the k ceiling and the first depositor (`e339148`, `d18ab04`), with accepted limits (7.3) |
| F2 | Medium-High (launch) | A front-run `createPair` strands the deployment tooling | Fixed in tooling (`deploy-dex.mjs check-pair`, `sign-and-publish.sh --plan`) |
| F3, F4, F5 | Medium / Low-Medium | Frontend quote and receipt handling | Fixed in the frontend (out of scope) |

### 7.3 Attack review of the F1 fix at `d18ab04` (agent 61, "DEX-F1")

Verdict: "holds with listed limits". No attacker can stop swaps for longer than it
takes anyone to call `skim`, and LPs could always exit.

| ID | Sev. | Limit | Status |
|---|---|---|---|
| L1 | High if the key is not single-purpose | `tx.origin`: one call by the depositor EOA to hostile code spends the first-deposit rule | Accepted; fresh EOA, nonce-0 and no-code checks in planner, gate, `preflight` and `DeployMainnet.s.sol`; a Safe owner as depositor is refused, a Safe depositor is unsupported. Not closable by a read check for a pre-signed or stolen key |
| L2, L2a | Medium | At the ceiling LPs and the Safe earn no fee; anyone can force the ceiling and collect fees by skimming; the fee is optional (swap + skim) | **Accepted by the owner** for the guarded launch; documented in `OPS-OPENING-KIT.md`. No design fix exists |
| L2b | Low-Medium | Standing excess fills the next trade with reserves unmoved; the skimmer keeps the input | Accepted; user still gets the quote |
| L3 | Medium | Excess past both rooms closes both directions until `skim` | Accepted (DEX-02 form); keeper and monitor `closed_by_excess` |
| L4 | Low | A pre-seed donation over half a cap reverts the seed until the seeder skims | Accepted; planner skims first |
| L5, L6 | Low | A fill closes top-ups; narrows the one-swap price range | Accepted, documented |
| L7 | Blocking (tooling) | Tooling did not pass the new constructor argument | Fixed (`0201d54`); `address(0)` refused on every mainnet path |
| L8 | Product | `firstDepositor` covers every pair; key loss blocks new pairs | Accepted |
| N1 | Medium-High (launch) | A griefed seed stranded the tools and forced a new deployment | Fixed in tooling (`note-tx`, `b08fce4`); griefing itself costs a retry |
| N2 | Low-Medium | `verify` passed on an attacker's pool | Fixed (`verify --to`, `monitor --lp-recipient`) |

### 7.4 Independent audit at `d18ab04` (agent 98)

No fund-loss finding.

| ID | Sev. | Summary | Status |
|---|---|---|---|
| A98-1 | Info | k falls by less than one unit of the kept side at the ceiling; LPs lose at most about 1 bUSDC base unit, not cumulative | Accepted as dust; documented (`OPS-OPENING-KIT.md`); pinned in supplementary tests |
| A98-2 | Low (test) | RC invariant tolerance was one-sided | Fixed: anchored `invariantSwapsNeverReduceK` in the RC |
| A98-3 | Low | Spot price moves almost free at the ceiling; any `getReserves` oracle loses the fee as protection | Documented. No in-scope contract reads the pair as an oracle |
| A98-4 | Info | In a flash callback `balanceOf(pair) < getReserves` (read-only window) | Canonical V2; no consumer. Not in RC docs; listed here |
| A98-5 | Low | The first-deposit rule never returns after the seeder fully exits | Documented in `OPS-INITIAL-LIQUIDITY.md`; owner decision on keeping a floor position is open |
| A98-6 | Info | `tx.origin` bait fills every pair of the factory | Documented (L1) |
| A98-7 | Low | At the ceiling fees go to any skimmer; `mint` with no deposit turns standing excess into shares | Documented (L2); the keeper sends excess to the Safe |
| A98-8 | Info | WBLCH withdraw latch is global, not per caller | Fails closed; not in RC docs; listed here |
| A98-9 | Info | `WBLCH.transferFrom(self, …)` needs an allowance, unlike WETH9 | Fails closed; not in RC docs; listed here |
| A98-OPS-1 | Medium (ops) | Depositor approve and seed were not built or checked by the kit | Fixed (`plan --write-txs` + `sign-and-publish.sh`, `811a29e`) |
| A98-OPS-2 | Low | `--fraction-bps` above 8,000 reverted at the ceiling | Fixed (refused above 8,000) |
| A98-OPS-3, -4, -5 | Info | Pending-nonce blindness; rehearsals sign with chain 700770 on anvil; history check is shape-only | Documented; keys are throwaway and unfunded |

### 7.5 Other known items (agents 96, 113, 139)

| Item | Status |
|---|---|
| A griefer who outbids the keeper wins every skim race (real L2 ordering) | Keeper tiers and varying tip; griefer pays gas and risks its donation |
| A third party knowing size and direction can bracket a swap by tip (L2 ordering) | Sequencer ordering; slippage defaults; out of contract scope |
| `approve` storage inflation against the pair or tokens | An L2 prover-cost issue, resolved by the sparse guest (agent 113); out of contract scope |
| bUSDC V3 effects (section 5) | Documented and monitored |

## 8. Areas where we most want the auditor's attention

1. `_applyCeiling` (`UniswapV2Pair.sol:203-220`): every branch, rounding direction, and the claim that a recorded reserve on a side that grew is never below its previous reserve (so excess is never LP principal).
2. Interaction of the ceiling with `_mintFee`, `kLast` and burn's `_exitBound`.
3. The first-depositor rule with `tx.origin`, including contracts calling the pair directly, and the router path.
4. Whether any sequence reaches a state where no material swap passes in either direction after a `skim`.
5. Router recipient guards, fee-on-transfer variants with standing pair or router balances, native refunds.
6. Lens parity with execution (it is what the UI uses for availability).
7. Tier B: whether a tampered or stale config, plan or raw-tx file can deploy something other than the reviewed code, or seed at another price or recipient, without a refusal.

## 9. Static analysis already run

Slither 0.11.6 and Aderyn 0.6.8 at the pre-F1 review; raw output in
`docs/audit/slither-20261030.txt` and `docs/audit/aderyn-20261030.md`; triage in
`AUDIT-SCOPE-DEX.md` section 7. Not rerun at `d18ab04`.

## 10. Build and test

Requirements: forge 1.7.1, Node 24 with the committed `frontend/package-lock.json`
(the staging tools import `viem` from `frontend/node_modules`).

```
git checkout 86c6f2c64140b3d6aa59e800efc78faad517fa6d
```

```
forge build
```

```
FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=$(mktemp -d) forge test --offline
```

Expected: **27 suites, 206 tests passed, 0 failed** (reproduced for this package
on macOS with `--fuzz-seed 0x179`, 52 s wall).

Use a fresh `FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR` per run: forge otherwise replays
a cached invariant counterexample from `cache/invariant/` on every later run,
whatever `--fuzz-seed` says.

Deep invariant run, as a release gate:

```
FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=500 FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=$(mktemp -d) forge test --offline --match-test '^invariant' --fuzz-seed 1
```

Pair init code hash (must print the value in section 1):

```
cast keccak $(forge inspect UniswapV2Pair bytecode)
```

Tier B tooling tests:

```
npm --prefix frontend ci --ignore-scripts
```

```
node --test scripts/staging/*.test.mjs
```

Expected: 63 tests, 62 passed, 1 skipped, 0 failed.

```
node --test scripts/ops/dex-ops.test.mjs
```

Expected: 50 passed, 0 failed.

`node --test scripts/*.test.mjs` (legacy publication tooling, out of scope) needs
Linux: on macOS 25 tests fail with "requires Linux no-clobber rename support".

Rehearsals of the deployment and seed on anvil and a private L2 exist
(`scripts/staging/rehearse-mainnet-package.sh`, `scripts/ops/rehearse-ops.sh`); they
need the Bloch L2 binaries and are not required for the audit.

## 11. Related engagement: bUSDC bridge V3

The quote token's bridge is scoped separately in `bloch-l2-bridge`
`docs/AUDIT-SCOPE-BRIDGE-V3.md` (`codex/bridge-audit-scope-v3-r8-20261102` @ `323eddd`,
target `9f91a56`; contracts unchanged at `5fb9cf0`). Its contract scope is about
1,600 nSLOC (`BridgedStablecoinV3` 136, `BridgedStablecoinV2` 286,
`SignerMintedToken` 303, `ProvenanceSourceVault` 484, `ContextBoundSourceVault`
360, `SP1ReleaseVerifier` 33), plus about 5,700 lines of Python daemons and an
SP1 light-client release guest in Rust. We welcome a quote for both, with the DEX
and bridge contracts as one engagement and the daemons and the guest as options.
