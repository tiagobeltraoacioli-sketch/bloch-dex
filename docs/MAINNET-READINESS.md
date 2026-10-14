# Postern DEX: Bloch L2 mainnet readiness

Status on 2026-10-14, branch `feat/dex-mainnet-readiness-20261014` (from `a050da9`).

The Bloch L2 mainnet is **not live**: the L1 activation gate
(`L2_SETTLEMENT_ACTIVATION_EPOCH`) is inert and `activation_policy()` returns
`None` because the mainnet chain ID, L2 genesis, proof keys and attestor set
are not decided. "Mainnet DEX ready" therefore means: when the L2 goes live,
the DEX is deployed by one reviewed, deterministic procedure, and liquidity is
enabled only by the finality gate. Nothing here deploys anything.

Ground rules kept from the devnet4 work: no recurring checkpoint signatures;
limits fixed once in constructors; Ethereum-style finality (the L2
`finalized` block is a settlement inside an FFG-finalized L1 block, obtained by
replaying from the pinned genesis). No admin, setter or upgrade path was added.

Legend: **Done** = handled in this branch; **Open** = needs a decision or
another workstream; **M9** = depends on the L2 mainnet going live.

## 1. Devnet-only assumptions

| # | Assumption | Where | Status | Fix in this branch | Decision needed |
|---|---|---|---|---|---|
| D1 | Chain ID 700771 (devnet4 / selected testnet) | `script/Devnet4Rehearsal.s.sol`, `frontend/src/network-identity.ts`, staging manifest, preflight, disposable-cycle package | Done for the deploy path; Open for the frontend | `DeployMainnet.s.sol` and `deploy-dex.mjs` refuse 700771 and 31337 unless the config says `network.rehearsal: true` **and** the operator passes `--rehearsal`; 8400/84001 are always refused | Mainnet L2 chain ID (M9). The frontend stays pinned to 700771 and in preview until a separate reviewed change |
| D2 | Genesis hash `0xaec98443…fefa` | devnet4 gate config (host only) | Done | Mainnet config has `genesisHash: null`; validation refuses until it is set; the driver and the gate compare it with `eth_getBlockByNumber(0)` | Mainnet L2 genesis hash (M9) |
| D3 | Devnet4 addresses (factory `0x23cf…6ea4`, WBLCH `0xaf92…ff7f`, pair `0xadcb…9e63`, …) | `docs/DEVNET4-REHEARSAL.md` | Done | Never reused. Mainnet addresses come from the plan: CREATE from the pinned deployer and start nonce, CREATE2 for pairs | None |
| D4 | `scripts/devnet4/rpc_compat_proxy.py` fills `sha3Uncles`/`nonce` so forge accepts blocks | devnet4 broadcast | Open | The mainnet runbook does not use the shim (it rewrites RPC responses, a trust boundary) | The L2 RPC must return Ethereum-shaped blocks before the mainnet deploy (other terminal: L2 eth-compat work) |
| D5 | **L2 block timestamp = +1 per block** (deadlines in L2-block units) | devnet4 L2; `Devnet4Rehearsal.s.sol` `DEADLINE_L2_BLOCKS` | Open, M9 | Documented here; anchored swaps already bound execution to a 256-block window | See F3. Strongly recommended: mainnet L2 timestamps in wall-clock seconds |
| D6 | Operator dev key was deployer, `feeToSetter` and treasury at once | devnet4 rehearsal | Done | Config requires three distinct accounts and pins each role's code hash (empty-code hash for an EOA); the script, driver and gate check them; the deployer holds no role after deployment | Who holds `feeToSetter` and the treasury (see A1) |
| D7 | Test asset D4TEST (`BlochAsset`) | devnet4 rehearsal | Done | `DeployMainnet` deploys only WBLCH (optional) and the core/periphery; no test assets, no liquidity, no approvals | Pilot counter-asset (bUSDC needs the bridge: other terminal). Until then `initialPairs: []` and the gate cannot be generated (it refuses, by design) |
| D8 | Cap values: WBLCH 1.2 BLCH on devnet4; 10 BLCH technical ceiling | `Devnet4Rehearsal.s.sol`, `Deploy.s.sol` | Done (mechanism); Open (values) | Mainnet config `cap: null` until decided; ceiling 10 BLCH enforced in `DeployMainnet.s.sol`, `dex-deploy-config.mjs` and the gate's `maxWrappedReserveCap`; every pilot pair token must be capped | Cap per token. Raising the 10 BLCH ceiling is a code change |
| D9 | forge batch broadcast file mislabels hashes | devnet4 pitfall | Done | `run --broadcast` uses `--slow`; `record` takes only `receipts[]` and re-verifies every transaction on chain (sender, nonce, init code hash, created address, status) | None |
| D10 | Deployer nonce and addresses not pinned (`Deploy.s.sol`) | legacy staging script | Done | `DeployMainnet` pins deployer, start nonce, every address and every runtime code hash | Use a fresh deployer (nonce 0) |
| D11 | WBLCH freshly deployed on devnet4; scaffold `0x4200…0006` had no code | devnet4, ADR-001 | Done (both modes) | Config `wrappedNative: {deploy: true}` or `{deploy: false, address, codeHash}` | Deploy our WBLCH (recommended: no admin, no bridge) or adopt a canonical predeploy if the L2 ships one (M9) |
| D12 | Gate schema 1 pins chain, genesis, factory, pair and tx hashes only | `finality-gate.mjs` | Done | Schema 2 also checks sender, runtime code hashes, init code hash, fee state, bindings, every cap and every planned pair; schema 1 unchanged | None |
| D13 | `finalized` tag and `bloch_finality` exist on the RPC | devnet4 RPC | Open, M9 | Gate fails closed when either is missing; receipts without `from` also fail closed | Mainnet L2 RPC must serve both, from a node the operator runs and that replays from the pinned genesis |
| D14 | Legacy staging tooling (manifest v5, signed cap approvals, launch gate, semantic package, disposable cycle) hardcodes 700771 and signed approvals | `scripts/staging/*` | Open | Not used by the mainnet path; left untouched | Keep as legacy evidence or delete in a cleanup |
| D15 | EVM rules: compiled for `paris`; anchored swaps need `BLOCKHASH` | `foundry.toml` | Open, M9 | None needed | Mainnet L2 must run at least Paris semantics with `BLOCKHASH` over the last 256 blocks; block gas limit must fit the router creation (~3.9M gas) |

## 2. Admin surfaces

| # | Surface | Holder | Power | Status | Decision needed |
|---|---|---|---|---|---|
| A1 | `UniswapV2Factory.setFeeTo(address)` | `feeToSetter` | Turn the 1/6 protocol fee on, to any address, at any time; off again. No delay | Open | **Design choice, proposed, not done:** fix the fee recipient in the factory constructor (protocol fee permanently off, or permanently on to the immutable `TreasuryFeeCollector`) and delete the setter. This matches "limits fixed once at deploy". Pairs only call `factory.feeTo()`, so the pair init code hash would not change. Alternative: keep the switch with a multisig `feeToSetter` |
| A2 | `setFeeToSetter` / `acceptFeeToSetter` / `cancelFeeToSetterTransfer` | `feeToSetter` | Two-step handover of A1 | Open | Disappears with A1's proposal; otherwise choose the holder (multisig recommended) |
| A3 | Reserve caps | none | Fixed in the factory constructor, copied into each pair | Done | Values only (D8) |
| A4 | Router, lens, collector, WBLCH, pair | none | Immutable bindings; pair `initialize` is factory-only and one-time; no owner, pause, upgrade or rescue | Done | None |
| A5 | `TreasuryFeeCollector.sweep` / `checkpoint` / `convertViaTwap` | anyone | Crank only; destination is the immutable treasury | Done | Treasury address (D6) |
| A6 | Deployer key | deployer | Nothing after deployment (config forbids it from holding a role) | Done | Fresh, single-use key |

## 3. Security findings

| # | Finding | Status |
|---|---|---|
| F1 | `BDexLens` quotes ignored the per-pair reserve caps: a swap the pair will refuse with `BDEX: RESERVE_CAP` was reported as `available`, and `bestExactInput` could rank it first. | **Fixed**: a hop whose input would lift the pair's reserve above its cap is unavailable; exactly reaching the cap stays available. Regression: `test/ReserveCap.t.sol::testLensQuoteRespectsReserveCaps` (fails on the old lens). |
| F2 | Gate schema 1 did not pin runtime code, sender, fee state or periphery bindings, so a wrong address in a hand-written gate config could pass. | **Fixed** for mainnet by schema 2 (generated by `deploy-dex.mjs record`, never by hand). |
| F3 | If L2 timestamps advance one per block, wallet deadlines in Unix seconds never expire, EIP-2612 permit deadlines likewise, pair TWAP accumulators integrate per block, and the collector's 30 min–6 h TWAP window becomes 1,800–21,600 blocks (≈11–135 days at ~9 min/block). | **Open, M9.** Contracts are correct for wall-clock seconds. Decision: wall-clock L2 timestamps (recommended), or a reviewed change of the collector windows and frontend deadline units. Anchored swaps bound replay to 256 blocks either way. |
| F4 | Caps bind each pair, not aggregate exposure: anyone can create more WBLCH pairs, each with its own WBLCH cap; a pair of two uncapped tokens is uncapped. Anyone can fill a capped side up to its cap (by swapping in or donating then `sync`), pausing inflows on that side until outflows. | Residual by design; documented. Decide whether every launch-listed asset gets a cap (the config requires it for planned pairs). |
| F5 | No external audit (SECURITY-REVIEW-2026-09-08 item 2). | Open: commission before real funds. |

## 4. Deployment tooling (this branch)

- `deployments/mainnet/dex-mainnet.config.json`: the one reviewed input
  (domain `postern.dex.mainnet-deploy.v1`). Pending fields are `null`, so it
  is refused until every decision above is recorded in it.
- `scripts/staging/dex-deploy-config.mjs`: strict validation, canonical
  config SHA-256, deterministic plan (addresses, init code hashes, runtime code
  hashes with immutables linked, pair init code hash), forge environment and
  schema-2 gate generation.
- `scripts/staging/deploy-dex.mjs`: `validate`, `plan`, `run` (dry run by
  default; `--broadcast --confirm <configSha256>`), `record`.
- `script/DeployMainnet.s.sol`: the only broadcasting code; re-checks chain,
  rehearsal flag, deployer nonce, every address and code hash, fee state, caps
  and bindings by itself.
- `scripts/staging/rehearse-deploy-anvil.sh`: full local rehearsal on anvil.
