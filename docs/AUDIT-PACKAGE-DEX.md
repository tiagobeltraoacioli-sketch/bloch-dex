# Postern DEX: external audit package (DEX-8)

Prepared 2026-11-02 for an external security audit firm, restructured 2026-11-09 so
that it is correct for any commit. This is the single entry document for the
engagement. The narrative (design, trust model, invariants, areas of attention) is
here; every figure that depends on the commit (file digests, sizes, code hashes, test
counts) is generated for one named commit into `docs/audit/package/` and is not
repeated here. `AUDIT-SCOPE-DEX.md` is the internal pre-audit review of 2026-10-30.

Status of the code: **unaudited, not deployed**. Nothing has been deployed to the
target chain (Bloch L2 mainnet, chain ID 700770).

## 1. Revision to audit

The audit commit is chosen by the owner when the engagement is signed. The package
in `docs/audit/package/` names the commit it was generated for in `PACKAGE.json`
(`commit`); the commit that contains those generated files differs from it only by
files under `docs/audit/package/` (`git diff <commit> HEAD --stat` shows nothing else).
For any other commit, regenerate with one command (about 15 minutes with the rehearsals):

```
node scripts/audit/make-package.mjs --commit <commit> --bridge-repo <built bridge checkout> --safe-artifacts <safe-contracts 1.4.1 build/artifacts>
```

| Item | Value |
|---|---|
| Repository | `postern-dex` (private; the owner delivers a git bundle of the audit commit) |
| Audit commit | `PACKAGE.json` `commit` |
| Contracts commit | `d18ab04f1db68350427362128829f88dba8bac9b` (`PACKAGE.json` `contractsCommit`: the last commit that touched `contracts/` or `foundry.toml`). It is the `source.revision` in `deployments/mainnet/dex-mainnet.config.json`. Every release candidate since (`86c6f2c6`, `4d726ac`, `3f427a4`, `c5f799c` and later) has the same contracts and the same code hashes |
| Compiler | solc 0.8.24, `evm_version = paris`, optimizer on, 200 runs, `bytecode_hash = none` (`foundry.toml`) |
| Toolchain used for the figures | `PACKAGE.json` `toolchain` (forge 1.7.1, node 24) |
| Target EVM | Bloch L2: unmodified revm at `SpecId::CANCUN` (L2 repo `src/chainspec.rs:121`). Prague and EIP-7702 are not active (`integrations/reth-execution/tests/node_provider.rs:57`), so an EOA cannot carry delegated code |

| Generated file | Content |
|---|---|
| `docs/audit/package/PACKAGE.json` | The commit, the contracts commit, toolchain, pair init code hash, code hashes, the result of every command run, digests of the files below |
| `docs/audit/package/SCOPE.md` | Scope by tier with sizes, the out-of-scope list, creation and runtime code hashes |
| `docs/audit/package/MANIFEST.tsv` | Every in-scope file: tier, SHA-256, git blob, bytes, lines, code lines, SLOC, nSLOC |
| `docs/audit/package/TEST-EVIDENCE.md` | Each command run on an export of the commit, with exit status, counts and log digest |
| `docs/audit/package/KNOWN-ISSUES.md` | Copy of `docs/audit/KNOWN-ISSUES.md` at the commit (section 7) |

The pair init code hash (`INIT_CODE_PAIR_HASH`) has been
`0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683` since `d18ab04`;
`SCOPE.md` recomputes it and the other code hashes from a build of the commit. Runtime
hashes of the factory, router and lens are before immutables are filled in, so a deployed
instance differs; `scripts/staging/verify-deployment.mjs` checks deployed code against the plan.

## 2. Scope and size

The scope is defined once, in `scripts/audit/scope.json`, by tier:

| Tier | What | Engagement |
|---|---|---|
| A | On-chain code: the pair, factory, LP token, router, library, lens, WBLCH and their interfaces | Required |
| B | Deployment path and finality gate: `DeployMainnet.s.sol`, the config validator, plan and record tools, offline signing and recorded publication, the gate with the bridge-token identity check, the first-deposit planner, the committed mainnet configuration and pins | Required |
| C | Operations: skim keeper, monitor, fee redemption, opening form, systemd units | Optional, recommended (it moves the Safe's revenue and holds a funded key) |
| D | Frontend transaction path: the mainnet page, wallet request building, submission tracking and recovery, new-slot fee pricing | Optional |

The generator refuses a scope that is not closed: a relative import of a tier B, C or D
file must be in a tier or on the out-of-scope list. File list, sizes and totals are in
`docs/audit/package/SCOPE.md`; on-chain logic without interfaces has been 993 nSLOC
(1,114 with interfaces) since `d18ab04`. nSLOC is counted as in `docs/audit/nsloc.py`:
comments and blank lines removed, and a construct wrapped over several lines (open `(`
or `[`) counted once. `docs/audit/nsloc-86c6f2c6.tsv` is the count at the first RC, kept
for reference.

Novelty of the on-chain files against their upstream base:

| File | Upstream base | Novelty |
|---|---|---|
| `contracts/UniswapV2Pair.sol` | v2-core `UniswapV2Pair` | **High**: caps, k ceiling, exit bound, first depositor, empty-pool sync |
| `contracts/UniswapV2Factory.sol` | v2-core `UniswapV2Factory` | Medium: immutable `feeTo` and `firstDepositor`, constructor caps, no setters |
| `contracts/UniswapV2ERC20.sol` | v2-core `UniswapV2ERC20` | Low: live-chainid domain, low-s permit |
| `contracts/libraries/Math.sol`, `UQ112x112.sol` | v2-core | None (verbatim) |
| `contracts/periphery/BDexRouter.sol` | v2-periphery `UniswapV2Router02` | Medium: recipient guards, anchored swaps, fresh-pool rule, fee-on-transfer deltas |
| `contracts/periphery/BDexLibrary.sol` | v2-periphery `UniswapV2Library` | Medium: registry `pairFor`, `validatePath`, uint112 bounds |
| `contracts/periphery/BDexLens.sol` | none | **New**, view-only: discovery, quotes with cap checks, `pendingExcess` |
| `contracts/assets/WBLCH.sol` | WETH9 | Low: recipient and spender guards, withdraw latch |

Out of scope (reasons in `SCOPE.md`): `TreasuryFeeCollector.sol` and `BlochAsset.sol`
(not deployed), the non-mainnet scripts, the deployments of reviewed third-party code
(Safe v1.4.1, Multicall3, CREATE2 deployer; verified by code hash), rehearsal drivers
and fixtures, legacy tooling, the rest of the frontend, the bridged quote token and its
bridge (a separate engagement, section 11; its interaction with the pool is in scope as
described in section 5), and the L2 node, settled RPC, prover and guest.

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

**Bridge token identity (agent 227, release line `codex/dex-rc-r11-20261103`, closes
agent 180 L-3).** `scripts/staging/bridge-token-identity.mjs` takes the bUSDC identity
from the bridge's own `deploy_pontes.py` plan and record. Before any RPC call it
checks that they agree with each other and with the gate file, that the plan's
compiler and contract are the reviewed build and that T is 0. At `finalized` it
checks the deployment block, the recorded runtime code, the reviewed build (runtime
code with the 51 immutable slots zeroed hashes to `0x405c2834…9ca7`, pinned in
`deployments/mainnet/bridge-token.pin.json` for bridge RC `eb5c981`), and
`signers()`, `guardians()`, `threshold()`, `switchThreshold()`, `unpauseThreshold()`,
`cancelQuorum()`, the six limits (`largeMintThreshold()` = 0), `instantCapacity()` = 0,
`MAX_PENDING()` = 2,048, `sourceVault()`, `sourceRoute()`, `sourceChainId()` and the
pause policy against the plan. The mainnet wrapper requires one record per bridged
token and the launch shape (5 of 7, 6 for switch and unpause, 3 guardians, no
rehearsal plan). Auditors: the trust in the pin file is the same as in the
repository's other pins; review its offsets against the bridge's forge artifact.

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

The list is `docs/audit/KNOWN-ISSUES.md` (copied into the generated package). The
auditor should treat every item in it as known and not report it again unless the fix
or the reasoning is wrong. Its first entry is the behaviour the owner accepted for
launch and sends to this audit explicitly: swap fees at the k ceiling (section 8, item 8).

## 8. Areas where we most want the auditor's attention

1. `_applyCeiling` (`UniswapV2Pair.sol:203-220`): every branch, rounding direction, and the claim that a recorded reserve on a side that grew is never below its previous reserve (so excess is never LP principal).
2. Interaction of the ceiling with `_mintFee`, `kLast` and burn's `_exitBound`.
3. The first-depositor rule with `tx.origin`, including contracts calling the pair directly, and the router path.
4. Whether any sequence reaches a state where no material swap passes in either direction after a `skim`.
5. Router recipient guards, fee-on-transfer variants with standing pair or router balances, native refunds.
6. Lens parity with execution (it is what the UI uses for availability).
7. Tier B: whether a tampered or stale config, plan or raw-tx file can deploy something other than the reviewed code, or seed at another price or recipient, without a refusal.
8. **Swap fees at the k ceiling (owner decision DEX-4, accepted for launch, explicit audit item).** At the ceiling `_applyCeiling` records the side that grew as `C / other`, so the 0.3% fee stays outside the reserves: LPs and the protocol fee get nothing, and any caller takes it with `skim`, with a `swap` that sends nothing (inputs are inferred from balance growth, `UniswapV2Pair.sol:376-377`), or with `mint` as shares. Arbitrage becomes fee-free (swap plus skim). Agent 177 measured it (`test/Cap*.t.sol` on `codex/dex-cap-math-r10-20261102`): below the ceiling LPs get 5/6 and the Safe 1/6 of the fee, exactly; at the ceiling both get 0, a skimmer takes about 99% and never LP principal (fuzz, 512 runs); restricting `skim` does not help because of the `swap` path. We ask the auditor to assess the candidate fix "at the ceiling, transfer the clamped amount to `feeTo` inside `swap`" (not written or tested; it changes the init code hash) and to propose a better one if it exists. Until then the off-chain mitigations are a 7,000 bps seed limit and a keeper that skims ceiling excess to the Safe from 0.00104 BLCH; against a bot that skims every block the Safe still collects only about a quarter, and nobody can collect arbitrage fees.

## 9. Static analysis already run

Slither 0.11.6 and Aderyn 0.6.8 at the pre-F1 review; raw output in
`docs/audit/slither-20261030.txt` and `docs/audit/aderyn-20261030.md`; triage in
`AUDIT-SCOPE-DEX.md` section 7. Not rerun at `d18ab04`.

## 10. Build and test

Requirements: forge 1.7.1, Node 24 with the committed `frontend/package-lock.json`
(the staging and operations tools import `viem` from `frontend/node_modules`).

```
git checkout <audit commit>
```

```
npm --prefix frontend ci --ignore-scripts
```

```
FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=$(mktemp -d) forge test --offline
```

```
node --test scripts/staging/*.test.mjs
```

```
node --test scripts/ops/*.test.mjs
```

```
cd frontend && npx vitest run && npx tsc --noEmit && npx vite build && node scripts/check-production-bundle.mjs dist
```

The expected counts for the audited commit, the exact commands and environment of the
V3 suites on the real bridge token bytecode (`V3_INITCODE`, `--evm-version shanghai`)
and of the four rehearsals are in `docs/audit/package/TEST-EVIDENCE.md`, written by the
generator from runs on an export of that commit.

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

`V3TokenInvariant` and the other `test/V3*.t.sol` suites run against a stand-in unless
`V3_INITCODE` holds the bridge's `BridgedStablecoinV3` creation code (keccak
`0xe560441f…1de7` at the bridge freeze); the generator sets it from `--bridge-repo`.

`node --test scripts/*.test.mjs` (legacy publication tooling, out of scope) needs
Linux: on macOS 26 tests fail with "requires Linux no-clobber rename support".

Rehearsals of the deployment, the opening and operations run on loopback anvil chains
(`scripts/staging/rehearse-mainnet-package.sh`, `scripts/ops/rehearse-opening.sh`,
`scripts/ops/rehearse-ops.sh`); their `private-l2` modes and
`scripts/staging/e2e-settled/drive.sh` need the Bloch L2 binaries and are not required
for the audit.

## 11. Related engagement: bUSDC bridge V3

The quote token's bridge has its own request for proposal: `bloch-l2-bridge`
`docs/AUDIT-RFP-BRIDGE-V3.md` (`codex/bridge-rfp-r10-20261102` @ `a44b9b0`), with a
proposed freeze commit `125227b` (bridge V3 `5fb9cf0` plus
`RecoverableReleaseVerifier`). Its size, by the same counting method:

| Track | Size |
|---|---|
| A1 Solidity | 1,435 nSLOC (`BridgedStablecoinV3` 136, `BridgedStablecoinV2` 286, `SignerMintedToken` 303, `ProvenanceSourceVault` 484, `RecoverableReleaseVerifier` 193, `SP1ReleaseVerifier` 33) |
| A2 Python daemons that hold keys or decide | 4,710 logical lines |
| B SP1 guests and the light-client code they run | about 3,690 nSLOC (Rust) |
| C frontend (optional) | 2,909 SLOC |

The DEX and the bridge share one launch: the only planned pair is WBLCH/bUSDC.
We welcome one proposal that covers both, with separate line items and separate
reports:

1. **DEX phase** (this package, tiers A and B; tier C optional). The code is frozen.
2. **Bridge phase**, tracks A1 and A2, and B if the firm has zkVM experience.
3. **The DEX and bUSDC integration** (section 5), reviewed once.
4. One fix review per phase.
