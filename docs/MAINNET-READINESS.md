# Postern DEX: Bloch L2 mainnet readiness

Status on 2026-10-14, branch `feat/dex-mainnet-readiness-20261014` (from `a050da9`).

Update 2026-10-16: the §6 procedure ran live on devnet4 (chain 700771,
rehearsal mode) against the real bridged bUSDC, with a test 2-of-3 multisig
as Bloch Inc: plan, refusals, dry run, broadcast, record, gate refused before
finality and returned `liquidity-enabled` after it, then a pilot seed, swaps
and the multisig's fee redemption. Evidence and numbers:
[DEVNET4-MAINNET-PROCEDURE.md](DEVNET4-MAINNET-PROCEDURE.md); rows D4, D5,
D13, D16, D17 and F3 below reflect it.
A second run the same day deployed both pilot pairs exactly as the mainnet
config (WBLCH/wGSMH with the real devnet4 wGSMH, WBLCH/bUSDC), passed the
gate and executed multi-hop swaps across both pools.
A third run deployed the official Safe v1.4.1 (3 of 5) as Bloch Inc per step 0,
a DEX with that Safe as the fixed fee recipient, and redeemed the protocol fee
with `execTransaction` and 3 packed owner signatures; the new Safe checks of
the preflight and the gate passed live (step 0 below).

Update 2026-10-30 (branch `codex/dex-mainnet-700770-20261030`): the chain 700770
deployment package is in [MAINNET-700770-PACKAGE.md](MAINNET-700770-PACKAGE.md).
The L2 genesis is pinned (`0x632e45ae…f468`). The Bloch Inc Safe is deployed by
a bootstrap key, because 700770 has no singleton factory. Every transaction is
signed offline with `cast mktx` and published with `cast publish`. The package
adds post-deployment verification and a mainnet gate pinned to the chain
and the Safe. The pilot is now **bUSDC/WBLCH only**: wGSMH is deprioritized
and removed from the launch config and caps. Unfilled values are written
`TBD-owner`, and they are refused like `null`. Sections 0 and 3 below
predate this change for wGSMH.

: the L1 activation gate
(`L2_SETTLEMENT_ACTIVATION_EPOCH`) is inert and `activation_policy()` returns
`None` because the L2 genesis, proof keys and attestor set are not final.
"Mainnet DEX ready" therefore means: when the L2 goes live, the DEX is deployed
by one reviewed, deterministic procedure, and liquidity is enabled only by the
finality gate. Nothing here deploys anything.

Ground rules kept from the devnet4 work: no recurring checkpoint signatures;
limits fixed once in constructors; Ethereum-style finality (the L2
`finalized` block is a settlement inside an FFG-finalized L1 block, obtained by
replaying from the pinned genesis). The DEX has **no admin, setter or upgrade
path**: the fee recipient and the reserve caps are constructor arguments.

Naming: the coin and chain are **GnB-SMH**; its ticker is **GSMH**, and its bridged token on the L2 is **wGSMH** (token name "Wrapped GnB-SMH"). Earlier documents wrote it wGnB; code identifiers and contract names are unchanged, and the 2026-10-14 devnet4 token keeps its on-chain name (wGnB, "Wrapped GnB").

Legend: **Done** = handled in this branch; **Open** = needs a decision or
another workstream; **M9** = depends on the L2 mainnet going live;
**Pending input** = decided, waiting for a value from the user or another
workstream (the config field is `null` and the tooling refuses it).

## 0. Decisions (2026-10-14) and what is still missing

| # | Decision | Implemented as | Still missing |
|---|---|---|---|
| 1 | L2 mainnet chain ID **700770** (devnet stays 700771) | `deployments/networks.json` is the single source; `dex-deploy-config.mjs` and the frontend read it; `DeployMainnet.s.sol` mirrors it (a Node test keeps them equal). A non-rehearsal deployment is refused on any other chain | L2 mainnet **genesis hash** (M9): `network.genesisHash` |
| 2 | Protocol fee **on**, as revenue, to **Bloch Inc** | `UniswapV2Factory(feeTo, firstDepositor, capTokens, caps)`: `feeTo` is immutable; `setFeeTo`, `setFeeToSetter`, `acceptFeeToSetter`, `cancelFeeToSetterTransfer`, `feeToSetter`, `pendingFeeToSetter` deleted. Config `fees.feeTo` must be `"blochInc"`. Pair init code hash `0x16bd5cad…6683` (changed from `0x2249ef38…b820` by the 2026-10-30 burn cap fix, see AUDIT-SCOPE-DEX.md; pinned by `test/Core.t.sol` and checked on chain by the rehearsal) | **Bloch Inc address and Safe proxy code hash**: `blochInc` |
| 2b | Bloch Inc is a **multisig**: Safe v1.4.1 (official contracts), 3-of-5 owners on hardware wallets | `blochInc.codeHash` must not be the empty-code hash; `DeployMainnet.s.sol`, `deploy-dex.mjs run` and the gate (at the finalized block) check the contract code | Owners, then the Safe deployment (runbook step 0) |
| 3 | Treasury = Bloch Inc; deployer = a fresh Bloch Inc key with no role after deployment | Roles reduced to `deployer` and `blochInc`, which must differ; the deployer is never fee recipient, cap token or planned contract | **Deployer address** (fresh key, nonce 0): `deployer.address` |
| 4 | Initial caps: guarded launch | §3 below; values committed in the config | wGSMH bridge bucket capacity (from the wGSMH bridge deployment) |
| 5 | Pilot pairs **wGSMH/WBLCH** and **bUSDC/WBLCH** | `initialPairs` references tokens by symbol; the plan, deploy script and gate create and check both pairs | **wGSMH and bUSDC addresses and runtime code hashes** (bridge deployments) |
| 6 | External audit: later | F5 below | Commission before caps are raised |
| 7 | Legacy devnet tooling: remove or make config-driven | §5 below | None |

Also still needed before the deploy: `source.revision` (the commit that will
be built), the L2 RPC items in D4/D13/D15 and the timestamp decision (F3).

## 1. Devnet-only assumptions

| # | Assumption | Status | Notes |
|---|---|---|---|
| D1 | Chain ID 700771 | Done | Mainnet 700770 from `deployments/networks.json`. 700771 and 31337 are accepted only with `network.rehearsal: true` **and** `--rehearsal`; any other non-mainnet ID and 8400/84001 are refused. The frontend reads the same file and stays in preview on devnet4 until a reviewed mainnet integration |
| D2 | Genesis hash `0xaec98443…fefa` (devnet4) | Pending input (M9) | `network.genesisHash: null`; the driver and the gate compare it with `eth_getBlockByNumber(0)` |
| D3 | Devnet4 addresses | Done | Never reused; mainnet addresses come from the plan (CREATE from the pinned deployer/nonce, CREATE2 for pairs) |
| D4 | `scripts/devnet4/rpc_compat_proxy.py` fills `sha3Uncles`/`nonce` | Resolved; not in the mainnet path | The settled RPC returns `sha3Uncles`, `nonce` and `pending`; forge and cast use it directly. The shim is a historical devnet4 tool, and no mainnet script or document uses it. The public gateway allows CORS from any origin, so the site reads the RPC directly |
| D5 | L2 block timestamp = +1 per block | Resolved on devnet4; M9 for mainnet | Devnet4 blocks carry wall-clock timestamps from block 228 on (blocks ≤ 227 kept `timestamp = number`). See F3 |
| D6 | One dev key was deployer, fee authority and treasury | Done | Two roles left: the fresh deployer (no power after deployment) and the Bloch Inc multisig (fee recipient, fixed) |
| D7 | Test asset D4TEST | Done | `DeployMainnet` deploys only WBLCH (optional) and the core/periphery; no test assets, liquidity or approvals |
| D8 | Cap values | Done (values), Pending input (wGSMH bucket) | §3 |
| D9 | forge batch broadcast file mislabels hashes | Done | `--slow`; `record` re-verifies every transaction from `receipts[]` |
| D10 | Deployer nonce and addresses not pinned | Done | `DeployMainnet` pins deployer, start nonce, every address and runtime code hash |
| D11 | WBLCH mode | Done | `wrappedNative: {deploy: true}` (recommended) or a reviewed predeploy |
| D12 | Gate schema 1 pins little | Done | Schema 2 (below); schema 1 unchanged for the devnet4 record |
| D13 | `finalized` tag and `bloch_finality` | Served on devnet4; M9 for mainnet | The devnet4 settled RPC serves both (native FFG replay from the pinned genesis); the schema-2 gate refused before finality and returned `liquidity-enabled` after it ([DEVNET4-MAINNET-PROCEDURE.md](DEVNET4-MAINNET-PROCEDURE.md)). Run it against an own node replaying from genesis |
| D14 | Legacy staging tooling hard-codes 700771 | Done | Removed (§5) |
| D15 | EVM rules (`paris`, `BLOCKHASH` over 256 blocks, router creation ~3.9M gas) | Open, M9 | Mainnet L2 must provide them |
| D16 | Gas estimation against `pending` fails on the L2 RPC ("pending Bloch derivation is unavailable") | Worked around in tooling | `forge script` uses its own simulation's gas (no RPC estimate), so `deploy-dex.mjs run` needs no change; every `cast send` in `scripts/devnet4/rehearse-mainnet-procedure.sh` passes an explicit `--gas-limit`. `eth_estimateGas` without a block tag (latest) works. One L2 block per settlement proof (10–20 min observed): forge needs `--timeout 1800` and the `--slow` broadcast of 5 transactions took ~1 h |
| D17 | Bridged tokens must expose `bucketCapacity()` | Required | The real devnet4 bUSDC (v3) does; the 2026-10-14 devnet4 token named wGnB on chain (`0xC756…6812`, superseded by wGSMH) does not (the call reverts) and was left out of the rehearsal. The devnet4 wGSMH (`0xB2B4…8AD4`, bucket 10 wGSMH, cap 1 wGSMH) does and was deployed against in the second run. The mainnet wGSMH token must expose `bucketCapacity()`, otherwise the `run` preflight and the gate refuse it |

## 2. Admin surfaces

| # | Surface | Status |
|---|---|---|
| A1 | Protocol fee recipient | **Done: fixed.** `feeTo` is an immutable constructor argument set to the Bloch Inc multisig. No function can change it; a different recipient needs a new factory (new pair addresses) |
| A2 | Fee authority handover (`setFeeToSetter`/`acceptFeeToSetter`/`cancelFeeToSetterTransfer`) | **Done: removed** together with A1. `test/Core.t.sol::testFeeRecipientHasNoAdminSurface` calls every removed selector as the deployer and as the recipient and expects a revert |
| A3 | Reserve caps | Done: constructor-fixed, copied into each pair, no setter |
| A4 | Router, lens, WBLCH, pair | Done: immutable bindings, factory-only one-time pair `initialize`, no owner, pause, upgrade or rescue |
| A5 | `TreasuryFeeCollector` | **Not deployed on mainnet** (see below). The contract and its tests stay in the tree |
| A6 | Deployer key | Done: holds nothing after deployment |
| A7 | Bloch Inc Safe | Outside the DEX: 3-of-5 owners; it can only redeem or transfer the LP shares it receives |

**Why the fee goes directly to Bloch Inc and not through `TreasuryFeeCollector`.**
The collector existed to make the fee *destination* immutable while the
factory's `feeTo` was switchable by an operator key. With `feeTo` immutable in
the factory, that guarantee is already in the factory and the collector adds:
one more contract to deploy and audit; a circular address dependency (the
factory would need the collector's address before the collector, which needs
the factory's code, exists: a precomputed CREATE address, so a partial
broadcast could leave the fee pointing at an address the deployer key could
later fill with other code); and a TWAP conversion path whose 30 min–6 h
windows depend on the open timestamp decision (F3). Its remaining benefit,
letting anyone crank redemption so the treasury never signs, is minor for a
Safe that signs anyway. Directly to Bloch Inc: the Safe receives LP shares of
each pair (they keep earning swap fees until redeemed) and redeems them with an
ordinary 3-of-5 `approve` followed by `router.removeLiquidity`
([OPS-FEE-REDEMPTION.md](OPS-FEE-REDEMPTION.md)). Never use `transfer` + `burn` as
two Safe transactions: anyone can burn the shares to themselves in between (the
same pair-level accounting is what `test/FeeRecipient.t.sol` exercises; it is not
the procedure). Proven through the real Safe by the package and ops rehearsals.

## 3. Reserve caps: guarded launch

A reserve cap bounds how large one side of a pair may grow; the swap or
deposit that would exceed it reverts (`BDEX: RESERVE_CAP`). Withdrawals and
outflows are never blocked. Values (committed in
`deployments/mainnet/dex-mainnet.config.json`):

| Token | Cap | Base units | Rule |
|---|---|---|---|
| WBLCH | 10 BLCH | `10000000000000000000` (18 dp) | The existing code ceiling (`MAX_WRAPPED_CAP`, gate `maxWrappedReserveCap`) |
| bUSDC | 1,000 bUSDC | `1000000000` (6 dp) | 1/10 of the 10,000 bUSDC bucket (refill 24 h, supply cap 100,000) |

The launch factory has only the WBLCH/bUSDC pair (owner, 2026-10-30). wGSMH is
out of it; a capped wGSMH listing needs a new factory once its bridge exists.

Rationale:

- **Loss ceiling while unaudited.** Everything a pair can ever hold is at most
  its two caps. Worst case for both pilot pairs together: 20 BLCH + 1 wGSMH
  + 1,000 bUSDC. WBLCH is capped per pair, so each extra WBLCH pair anyone
  creates is also limited to 10 WBLCH (F4).
- **Both caps at once are unreachable.** `reserve0 * reserve1` stays at or below 64% of `cap0 * cap1`, and a first deposit needs the constructor-fixed `firstDepositor` (F1, `AUDIT-SCOPE-DEX.md`). The limits, including no LP or protocol fees at the ceiling, are in `OPS-OPENING-KIT.md`.
- **Relation to the bridges' token buckets.** A DEX cap on a bridged token is
  at most 1/10 of that bridge's bucket capacity, which is also the bridges'
  large-transfer delay threshold (> 10% of capacity is delayed 12 h). So a
  whole pool side can be withdrawn and bridged out in one undelayed transfer,
  and the pool never holds more than a tenth of what the bridge can move in a
  full bucket. The rule is enforced three times: config validation
  (`cap × 10 ≤ bridgeBucketCapacity`), the pre-broadcast check (reads the
  token's immutable `bucketCapacity()`), and the gate (reads it again at the
  finalized block). A smaller wGSMH bucket than planned forces a smaller cap.
- **Bridge failure.** If a bridge is compromised and mints unbacked tokens up
  to its bucket, the cap stops the dump at `cap − reserve`. The WBLCH side falls
  from `R` to `R * Rq / cap`, so "at most half" holds only when the bUSDC cap is
  near `10 × opening price`. With a 1,000 bUSDC cap it held at a price of 100 or
  more (50%), but measured at a price of about 25.5 a dump took 5.05 → 0.65 WBLCH,
  **87% lost** in one transaction (97.5% at a price of 5). With a 255 bUSDC cap at that price it measured 5.05 → 2.54 WBLCH, 49.6%. The loss stays bounded
  by the seed. `openingPrice` in the deploy config makes this a pre-deployment
  check: `validate` and `plan` refuse a bUSDC cap above 125% of `WBLCH cap × price`
  (or below 75%, unless the bridge bucket rule is what holds it down).
- **A bUSDC pause stops mints only.** Swaps, transfers, bridge burns, `skim` and LP
  exits all continue during a pause, so a pause does not freeze the pool
  ([OPS-DEX-INCIDENTS.md](OPS-DEX-INCIDENTS.md)).
- **Price band and impact.** Seed each pool at **no more than 50% of the
  tighter cap at the market price** (e.g. bUSDC/WBLCH: `x` BLCH and `x·p`
  bUSDC with `x ≤ 5` and `x·p ≤ 500`). Then the price can move by up to 4×
  in either direction before one side reaches its cap, and no single swap can
  move it further. Price impact of a swap of size Δ into reserve R is
  ≈ 1 − (R/(R+Δ))², e.g. ~2% for Δ = 1% of R: the pilot pools are deliberately
  shallow; they prove the system, they are not a liquid market.

**Staged raise: only by new deployments.** There is no setter.

| Stage | Condition | Change |
|---|---|---|
| 0 (launch) | Gate `liquidity-enabled` | The caps above |
| 1 | External DEX audit (F5) + bridge audits + ≥ 30 days without incident + bridge guardians live | New factory/router/lens deployment with about 10× caps. WBLCH above 10 BLCH needs a reviewed change of `MAX_WRAPPED_CAP` (script, config validator, gate). Bridged caps stay ≤ bucket/10 of the then-current buckets. LPs migrate by `removeLiquidity` + `addLiquidity`; the old pairs keep working (immutable) |
| 2 | Bug bounty proportional to TVL; second audit | Uncapped or much larger caps, again a reviewed code change and a new deployment |

Each stage is a new config + plan + gate; the frontend switches to the new
deployment record in a separate reviewed change.

## 4. Security findings

| # | Finding | Status |
|---|---|---|
| F1 | `BDexLens` quotes ignored the per-pair reserve caps | **Fixed** (`test/ReserveCap.t.sol::testLensQuoteRespectsReserveCaps`) |
| F2 | Gate schema 1 did not pin runtime code, sender, fee state or bindings | **Fixed** for mainnet by schema 2 |
| F3 | L2 timestamps +1 per block: deadlines, permits, TWAPs in block units | **Resolved on devnet4** (wall-clock timestamps since block 228, observed 2026-10-16); **M9:** the mainnet L2 must use the same rule. (The fee path no longer depends on TWAP windows: the collector is not deployed.) |
| F4 | Caps bind each pair, not aggregate exposure; anyone can fill a capped side up to its cap, pausing inflows on it | Residual by design. Every token of a planned pair must be capped |
| F5 | No external audit | **Open (decision 6: later).** Required before stage 1 |
| F6 | The fee recipient is permanent | By design (decision 2). If Bloch Inc's Safe must change, deploy a new factory; the Safe can rotate its own owners without touching the DEX |
| F7 | A donation above a cap could make `burn` revert with `RESERVE_CAP`, blocking LP exits (DEX-01 in [AUDIT-SCOPE-DEX.md](AUDIT-SCOPE-DEX.md)) | **Fixed** 2026-10-30: burn records at most `max(cap, previous reserve)` and leaves the excess skimmable. Pair init code hash changed |
| F9 | Donations synced exactly to both caps of an empty pair blocked mint and swap forever (DEX-09) | **Fixed** 2026-10-31: `sync` reverts while `totalSupply == 0`, which also closes the synced form of DEX-04. Pair init code hash changed |
| F8 | A standing donation above a cap blocks swaps and deposits on that side until someone calls `skim` (DEX-02) | **Accepted residual risk** (owner, 2026-10-30): the griefer forfeits the donation to whoever skims. `BDexLens.pendingExcess` and the mainnet route show it with a skim action |

## 5. Tooling

Kept (the mainnet path):

- `deployments/networks.json`: chain IDs (single source).
- `deployments/mainnet/dex-mainnet.config.json`: the one reviewed input
  (domain `postern.dex.mainnet-deploy.v1`); pending fields are `null` and refused.
- `scripts/staging/dex-deploy-config.mjs`: strict validation, canonical config
  SHA-256, deterministic plan (addresses, init code hashes, runtime code hashes
  with immutables linked, pair init code hash), forge environment, schema-2
  gate generation.
- `scripts/staging/deploy-dex.mjs`: `validate`, `plan`, `run` (dry run by
  default; `--broadcast --confirm <configSha256>`), `record`.
- `script/DeployMainnet.s.sol`: the only broadcasting code; re-checks chain,
  rehearsal flag, deployer nonce, Bloch Inc contract code, every address and
  code hash, fee recipient, caps and bindings by itself.
- `scripts/staging/finality-gate.mjs`: the gate engine, schema 1 (devnet4 record) and schema 2.
  `check-finality-gate-mainnet.mjs` is the mainnet gate (pinned chain and genesis, Safe build, bridge record,
  launch policy). The generic command `check-finality-gate.mjs` is for rehearsal chains only: it refuses the
  pinned mainnet genesis, and any other chain-700770 gate file unless `--rehearsal-chain` is given.
- `scripts/staging/rehearse-deploy-anvil.sh`: full local rehearsal on anvil
  (chain 700770 by default).
  - **Bloch Inc.** On the mainnet path it is the official Safe v1.4.1, 3 of 5,
    deployed from
    `SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts>`; the
    path refuses to run without it. On the `--rehearsal` path it is a test
    2-of-3 multisig.
  - **Tokens.** Test tokens exposing `bucketCapacity()` stand in for wGSMH and
    bUSDC.
  - **Coverage:**
    - plan, refusals, dry run, broadcast and record;
    - on-chain hash check;
    - gate before and after finality;
    - an over-cap deposit reverts;
    - the fee accrues to Bloch Inc, which redeems it: on the Safe path with
      `execTransaction` and 3 packed signatures, after 2 signatures are refused.
- Frontend: `frontend/src/network-identity.ts` reads `deployments/networks.json`.

Removed on 2026-10-14 (git history keeps them, last at `84b3f03`): the
closed-staging pipeline around manifest v5 (preflight, build, signed pilot
cap approvals, launch gate v3, semantic launch package, disposable-cycle
package, pilot readiness, pool inspection/capture/replay, RPC verifier,
deployment evidence, their templates and tests), `docs/PILOT-POOL-READINESS.md`,
`script/Deploy.s.sol`, `script/Devnet4Rehearsal.s.sol` and
`script/InitialLiquidityPreflight.s.sol` with their tests. They hard-coded
700771 and a fee authority, or replaced constructor caps with signed
approvals. Kept and made config-driven: `scripts/staging/manifest.mjs`
(+ test, `deployments/staging.template.json`), because the frontend's
read-only live staging path (`scripts/live-auth/envelope.mjs`, the
publication-quorum tooling, `frontend/src/live-read.ts`) still validates the
devnet4 staging registry with it; its chain ID now comes from
`deployments/networks.json`. A mainnet frontend integration is a separate
reviewed change.

## 6. Runbook: deploy on the L2 mainnet once it is live

### Preconditions (all M9 unless noted)

1. The L2 mainnet (chain 700770) is activated and accepts user transactions;
   its genesis hash is published, and the operator's **own** L2 node, replaying
   from that genesis, reports the same genesis hash. When the L2 release in
   production accepts user transactions, set `userTransactions: "enabled"` in
   `deployments/mainnet/l2-phase.json` in a reviewed change: the Bloch DEX
   site states that field while its Bloch L2 route is not live, and its release
   gate (`frontend/scripts/check-production-bundle.mjs --multichain`) refuses
   a build whose Bloch L2 route would be live while the file says
   `not-enabled`.
2. That node's RPC returns Ethereum-shaped blocks (no shim), receipts with
   `from`, the `finalized` block tag and `bloch_finality`.
3. The timestamp decision (F3) is made and, if not wall-clock seconds, the
   reviewed follow-up change is merged.
4. The wGSMH and bUSDC bridges are deployed on the L2 (other workstream); their
   token addresses, runtime code hashes and `bucketCapacity()` are reviewed.

### Step 0: deploy the Bloch Inc Safe (before the DEX)

Bloch Inc is a Safe v1.4.1 (official contracts), 3-of-5 owners on hardware
wallets. It must exist before the DEX because its address is a factory
constructor argument. Deploy it deterministically:

- **Preferred:** the official v1.4.1 deployment on chain 700770 through the
  Safe singleton factory (needs the chain to accept the factory's pre-signed
  deployment, or Safe to issue one for 700770), then `SafeProxyFactory.
  createProxyWithNonce(singleton, setup(owners, 3, …), saltNonce)`: the proxy
  address is predictable from the factory, the initializer and the salt.
  Take the singleton, proxy factory and fallback handler addresses from
  `safe-global/safe-deployments` (v1.4.1) and verify their runtime code hashes
  on the own node.
- **Fallback (no deterministic deployer on the chain):** a fresh bootstrap key
  with nonce 0 deploys the same v1.4.1 bytecode (singleton, proxy factory,
  fallback handler) by CREATE, then the proxy; every address follows from
  the bootstrap key and its nonces, and the runtime code hashes equal the
  official ones. The bootstrap key holds nothing afterwards.

Before recording it in the config, verify on the own node: proxy runtime code
hash; storage slot 0 (the singleton) = the reviewed v1.4.1 singleton;
`getThreshold() == 3`; `getOwners()` = the five reviewed hardware-wallet
addresses; no modules (`getModulesPaginated`), no guard; the reviewed fallback
handler. Then set `blochInc = {address, codeHash, safe}`. Here `codeHash` is
the proxy's runtime code hash, and `safe` is:

```
{version: "1.4.1", singleton: {address, codeHash}, fallbackHandler: {address, codeHash}, threshold, owners}
```

These checks are pinned (since 2026-10-16), so none of them is manual any more.

Config validation, on the mainnet:
- requires the `safe` pin;
- requires the official v1.4.1 runtimes (`SAFE_V141` in
  `scripts/staging/dex-deploy-config.mjs`):
  - the proxy is `0xd7d408eb…fb4c`;
  - the singleton is `Safe` `0x1fe2df85…e1c4` or `SafeL2` `0xb1f92697…81ff`;
  - the fallback handler is `0x7c6007a5…42f9`;
- requires a threshold of at least 2;
- forbids the deployer and the Safe itself as owners.

On chain, the `run` preflight (at `latest`) and the schema-2 gate (at the
finalized block) check:
- slot 0 is the singleton;
- the fallback-handler slot is the pinned handler;
- the guard slot is empty;
- no module is enabled;
- `getThreshold()` and `getOwners()` (as a set) match the pin;
- `VERSION()` is `1.4.1`;
- the singleton and handler runtime code hashes match the pin.

**Proven live on devnet4.** See
[DEVNET4-MAINNET-PROCEDURE.md](DEVNET4-MAINNET-PROCEDURE.md), third run.

**Sources:** the official bytecode is the build in the npm package
`@safe-global/safe-contracts@1.4.1`. Its runtime hashes equal
safe-deployments' canonical `codeHash`.

### Steps

1. **Record decisions.** Fill the remaining `null` fields of
   `deployments/mainnet/dex-mainnet.config.json`: `network.genesisHash`,
   `source.revision`, `deployer.address` (fresh Bloch Inc key; `startNonce`
   = its current nonce, normally 0), `blochInc`, and for wGSMH/bUSDC `token`,
   `codeHash`, `bridgeBucketCapacity` (wGSMH). Review it as a pull request.
2. **Build reproducibly.** Check out `source.revision`, Foundry 1.7.1,
   `forge build`, `forge test`, `npm ci --ignore-scripts` in `frontend/`,
   `node --test scripts/staging/*.test.mjs`.
3. **Plan.**
   `node scripts/staging/deploy-dex.mjs plan --config deployments/mainnet/dex-mainnet.config.json --write deployments/mainnet/dex-mainnet.plan.json`.
   A second reviewer regenerates it on another machine; the files must be
   byte-identical. Commit the plan (every address, nonce, init and runtime
   code hash, the fee recipient and the pair init code hash).
4. **Rehearse locally.**
   `SAFE_ARTIFACTS=… scripts/staging/rehearse-deploy-anvil.sh <revision>`
   must end with `REHEARSAL OK`.
5. **Fund the deployer** with gas only; send nothing else from it.
6. **Dry run** against the own node:
   `node scripts/staging/deploy-dex.mjs run --config <config> --plan <plan> --rpc <own-node-url>`.
   It refuses unless chain ID and genesis match, the deployer's latest and
   pending nonces equal `startNonce`, every planned address is empty, Bloch Inc
   has the reviewed contract code, each bridged token has the reviewed code
   and `bucketCapacity()` with `cap × 10 ≤ bucketCapacity`; then forge
   simulates the deployment.
7. **Broadcast:** the same command with
   `--broadcast --confirm <configSha256> -- <forge signer args, e.g. --ledger>`
   (one transaction at a time, `--slow`). Order: WBLCH, factory (fee recipient
   = Bloch Inc, caps), router, lens, `createPair` wGSMH/WBLCH, `createPair`
   bUSDC/WBLCH.
8. **Record:**
   `node scripts/staging/deploy-dex.mjs record --config <config> --plan <plan> --rpc <own-node-url> --broadcast-file broadcast/DeployMainnet.s.sol/700770/run-latest.json --write deployments/mainnet/finality-gate.mainnet.json`.
9. **Wait for finality, then run the gate:**
   `node scripts/staging/check-finality-gate-mainnet.mjs --config deployments/mainnet/finality-gate.mainnet.json --safe-plan deployments/mainnet/700770/safe.plan.json --bridge-plan deployments/mainnet/busdc.plan.json --bridge-record deployments/mainnet/busdc.record.json --rpc <own-node-url>`
   (the mainnet gate: pinned chain and genesis, the official Safe build, the bridge token against its own
   deployment record and the launch policy; the generic `check-finality-gate.mjs` refuses this file).
   Only `"decision": "liquidity-enabled"` allows the separate initial
   liquidity ceremony (≤ 50% of the tighter cap per pool, §3) and a separate,
   reviewed frontend change. Commit the plan, gate config and gate report.

If anything refuses, stop. If a broadcast lands only partly, do not finish it
by hand: the stray contracts hold nothing; write a new config with the
deployer's current nonce, re-plan and re-review.

### What the schema-2 gate verifies at the finalized block

- chain ID and genesis hash equal the pinned values; `bloch_finality` is not
  behind the `finalized` tag;
- both finality views identify the same hash at the same height and resolve to
  canonical blocks with the requested numbers. The gate repeats these checks,
  chain ID and genesis after its state reads, refuses regressions or rewritten
  checkpoints, and retains the opening checkpoints when finality advances;
- every deployment transaction: status 1, sent by the deployer, finalized and
  canonical;
- runtime code hash of WBLCH, factory, router, lens, both pairs, both bridged
  tokens and the **Bloch Inc Safe proxy** equals the plan (the Safe must be a
  contract);
- the **Bloch Inc Safe pin** holds (required on chain 700770):
  - the singleton (slot 0) and fallback handler are the pinned contracts, with
    the pinned runtime code;
  - no guard and no module is set;
  - `getThreshold()` and `getOwners()` equal the pin;
  - `VERSION()` is 1.4.1;
- `factory.INIT_CODE_PAIR_HASH()` equals the plan (`0x16bd5cad…6683` at this
  revision);
- `factory.feeTo()` is Bloch Inc (the fee is on and goes nowhere else; the
  factory code hash proves there is no setter);
- `factory.reserveCap(token)` equals the plan for WBLCH, wGSMH and bUSDC; the
  WBLCH cap is within `maxWrappedReserveCap` (≤ 10 BLCH);
- each bridged token's `bucketCapacity()` equals the reviewed value and is at
  least 10× its DEX cap;
- `router.factory()`, `router.WBLCH()`, `lens.factory()` point at the planned
  contracts;
- each planned pair belongs to the factory, has the planned sorted tokens, is
  registered by `getPair`, and its `reserveCaps()` equal the factory's.

The deploy script additionally asserts every pair is empty and
`allPairsLength` equals the planned count.

### What the gate does not prove

It trusts the RPC it is given: run it against a node you operate. It does not
verify the L2 proof system, the bridges' security, that the pinned owner keys
are really hardware wallets held by the right people, token economics or the
frontend.
