# Opening kit: price, bUSDC cap and owner inputs

Status: nothing is deployed. Every value here is a proposal for the owner, except the F1 design, which the owner chose.

## 1. How the choice works

- WBLCH cap: 10 WBLCH. bUSDC cap: a constructor value, committed as 1,000 bUSDC. Neither can change after deployment.
- `deploy-dex.mjs validate` and `plan` accept a cap `C` at price `P` (bUSDC per BLCH) only if all of these hold:
  - `C <= 12.5 * P` (125% of `10 * P`);
  - `C >= 7.5 * P` (75%), unless `C` is at the bucket limit;
  - `C <= 1,000`: 1/10 of the bridge bucket of 10,000 bUSDC.
- Result: **1,000 bUSDC needs `P >= 80`.** Above `P = 133.33`, 1,000 is the only cap accepted.
- A cap above 1,000 needs a larger bridge bucket. The vault's `windowLimit` must equal that bucket, so this is a bridge decision.

## 2. Options

Seed: 50% of the tighter cap, as `dex-seed-plan.mjs` plans it.

Measured with a scratch forge test on the real Pair and Factory at `f1ad6f2`, with `TestToken` for both sides and no protocol fee. Acceptance was read from `validateDeployConfig` at the committed tree. Neither ran on an L2.

- **Dump loss:** share of the WBLCH side taken by a dump of unbacked bUSDC up to the cap.
- **Price range:** pool price when each side reaches its cap, from one swap. Beyond it, swaps in that direction revert until the price returns.

| P | Cap C | Validator | Seed | Seed value (bUSDC) | Dump loss | Price range |
|---|---|---|---|---|---|---|
| 10 | 100 | accept | 5 WBLCH + 50 | 100 | 49.9% | 2.50 to 39.9 |
| 25 | 250 | accept | 5 WBLCH + 125 | 250 | 49.9% | 6.26 to 99.8 |
| 25.5 | 255 | accept | 5 WBLCH + 127.5 | 255 | 49.9% | 6.38 to 101.8 |
| 50 | 500 | accept | 5 WBLCH + 250 | 500 | 49.9% | 12.5 to 199.7 |
| 64 | 500 | accept | 3.91 WBLCH + 250 | 500 | 49.9% | 9.78 to 255.6 |
| 64 | 800 | accept | 5 WBLCH + 320 | 640 | 59.9% | 16.0 to 399.3 |
| 80 | 800 | accept | 5 WBLCH + 400 | 800 | 49.9% | 20.0 to 319.5 |
| 80 | 1,000 | accept, lowest price for this cap | 5 WBLCH + 400 | 800 | 59.9% | 20.0 to 499.1 |
| 100 | 800 | accept | 4 WBLCH + 400 | 800 | 49.9% | 16.0 to 399.4 |
| 100 | 1,000 | accept, both caps balance | 5 WBLCH + 500 | 1,000 | 49.9% | 25.0 to 399.4 |
| 133 | 1,000 | accept | 3.76 WBLCH + 500 | 1,000 | 49.9% | 18.8 to 531.2 |
| 200 | 1,000 | accept, bucket rule | 2.5 WBLCH + 500 | 1,000 | 49.9% | 12.5 to 798.8 |
| 400 | 1,000 | accept, bucket rule | 1.25 WBLCH + 500 | 1,000 | 49.9% | 6.27 to 1,597.6 |
| 1,000 | 1,000 | accept, bucket rule | 0.5 WBLCH + 500 | 1,000 | 49.9% | 2.51 to 3,994 |

Refused, with what the dump would have cost:

| P | Cap C | Why refused | Dump loss if it were allowed |
|---|---|---|---|
| 10 | 1,000 | above 125% | 95.0% |
| 25.5 | 1,000 | above 125% | 87.2% |
| 50 | 1,000 | above 125% | 74.9% |
| 64 | 1,000 | above 125% | 67.9% |
| 79 | 1,000 | above 125% | 60.4% |
| 100 | 500 | below 75% | not relevant: the pool is shallower, not less safe |
| 200 | 800 | below 75%, not at the bucket limit | not relevant, same reason |
| any | 1,250 | above 1/10 of the bucket | |

What the table implies:

- **`P >= 100`: keep 1,000.** The dump bound is about 50%. The seed's bUSDC stays at 500, so the WBLCH side and the pool's depth in BLCH shrink as `P` rises.
- **`80 <= P < 100`: 1,000 passes, but the bound is weaker,** down to 59.9% at 80. `C = 10 * P` restores about 50%.
- **`P < 80`: the cap must be lowered, to about `10 * P`,** and the committed config changed before deployment. The pool is then smaller.
- A lower cap changes no contract code. `scripts/staging/dex-deploy-config.test.mjs` pins the committed cap, so update that assertion with the value.

Recommendation: `C = min(1000, 10 * P)`. The price is the owner's decision.

## 3. F1 fix: what it costs

The owner chose the k ceiling with a first depositor, and accepted limit L2 for the guarded launch. Pair init hash `0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683`. Both caps stay, and the dump bounds above do not change.

Figures are agent 61's, at `P = 100` with the committed caps, from forge and anvil with `TestToken`, except where agent 96's private-L2 runs are named: `docs/OPS-DEX-MONITOR-KEEPER.md`.

### L2: at the ceiling, LPs and the Safe earn nothing

**This is the largest cost of the design.** At the ceiling, swap fees stay outside the reserves, and anyone can take them by calling `skim`.

- **LPs earn nothing, and the Bloch Inc Safe gets no protocol fee.** On $4,000 of volume at the ceiling, LP gain was 0, protocol shares were 0, and a skimmer took $79.60.
- **Anyone can force it after the seed.** Filling a 50% seed at the pool's ratio takes about 3 WBLCH + 300 bUSDC ($600). That capital is recoverable, at a net cost of 62,500 wei + 1 unit.
- **The fee is optional at the ceiling.** A swap and a `skim` in one transaction refund it. Arbitrageurs can trade against LPs with no fee.
- **Ordinary trading gets there too:** about $204,000 of volume on a $1,000 pool (4,079 round trips of 0.25 BLCH + 25 bUSDC).
- An LP burn lowers `k` and restores fees until someone refills.
- A standing excess fills the next trade with the reserves unmoved, so whoever skims keeps that trade's input. The trader still gets the quote. Unskimmed for 150 swaps at exactly the ceiling on a private L2, the excess reached $136 on $4,708 of volume, about ten times the fee.

- **The spot price moves almost for free at the ceiling.** A 1 WBLCH round trip with a skim cost about 0.00009%, against 0.48% below the ceiling. Nothing on this deployment reads `getReserves` as a price, but no contract should: at the ceiling the fee no longer protects it (agent 98, A98-3).
- **Fees at the ceiling go to whoever skims.** That is not the LPs and not the Safe, unless the keeper wins. Calling `mint` with no deposit also turns standing excess into LP shares, which is the same as skimming it. One 1 WBLCH swap left 0.003 WBLCH to a stranger (A98-7).
- **k can fall by less than one base unit of a reserve on a swap at the ceiling.** The LPs lose at most about one bUSDC unit, and it does not build up (A98-1).

No fix is designed. **The owner accepted this behaviour for launch (DEX-4, round 10), with no contract change, and it is an explicit item for the external audit** (`AUDIT-SCOPE-DEX.md`). Launch mitigations: the seed planner refuses more than 7,000 bps of the caps, and the keeper skims fee excess at the ceiling to the Safe from 0.00104 BLCH (`OPS-DEX-MONITOR-KEEPER.md`). Against a bot that skims every block from its own gas cost, the Safe still collects only about a quarter, and nobody collects arbitrage fees: an arbitrageur refunds its own fee with swap plus skim.

### L1: the depositor key

One call from the depositor's key to a hostile contract spends the first-deposit rule, through `tx.origin`. An attacker can then fill the pool and block the seed, though not swaps. The default is a fresh EOA that sends only the approve and the seed. The planner, the gate, `preflight` and the deployment script check its nonce. See `OPS-INITIAL-LIQUIDITY.md`. A Safe depositor is unsupported, because the tool for it does not exist.

### Other limits

| Limit | Effect |
|---|---|
| L3 | Unrecorded balance past both rooms closes both directions until anyone skims: about $400, paid to the skimmer unless the griefer wins its own skim. On a side already at its cap about $1 closes the pair to swaps smaller than that donation. Depends on `skim` being called. The keeper does it, and a griefer who pays more can win every race |
| L4 | A pre-seed donation above half a cap reverts the seed until a skim. About $500 a round, or $50 at `P = 10` (arithmetic). The skimmer keeps it |
| L5 | A filled pool takes no top-ups, and no swap reopens them |
| L6 | A fill narrows the one-swap price range from about 25-399 to about 64-156 |
| L8 | `firstDepositor` covers every pair on the factory. No third party can open another pair, and a lost key means no new pair opens |

## 4. What the owner must provide

The owner's decisions for the opening (price, cap, depositor, LP recipient, seeder exit, keeper, page bridge status) go in one file, `deployments/mainnet/opening-form.json`, checked and applied by `scripts/ops/opening-form.mjs`. See `OWNER-OPENING-FORM.md`. The tables below remain the reference.

Provide public addresses only. Keys stay with the owner and are never put in a repo, a config or a chat.

| # | Input | Where it goes | Key rule |
|---|---|---|---|
| 1-5 | 5 Safe owner addresses, in order | `safe.config.json` `safe.owners[0..4]` | Hardware wallets. Threshold 3 of 5 |
| 6 | Safe bootstrap address | `safe.config.json` `bootstrap.address` | Gas only. No role afterwards. `startNonce` 0 |
| 7 | Infra deployer address | `infra.config.json` `deployer.address` | New key, gas only. `startNonce` 0 |
| 8 | DEX deployer address | `dex-mainnet.config.json` `deployer.address` | Gas only. `startNonce` 0 |
| 8a | First depositor address | `dex-mainnet.config.json` `firstDepositor` | **New EOA for this only.** Sends the approve and the seed, nothing else. Nonce 0 before the seed. Never zero |
| 9 | LP recipient address | `dex-seed-plan.mjs --to` | Recommended: not the Safe |
| 10 | LP recipient, for the monitor | `DEX_LP_RECIPIENT` | Same as item 9 |
| 11 | Keeper address | `DEX_KEEPER` | Hot key, gas only |
| 12 | Keeper keystore path and password file path | `DEX_KEEPER_KEYSTORE`, `DEX_KEEPER_PASSWORD_FILE` | Paths on the keeper host only |

Decisions and values:

| # | Input | Where it goes | Note |
|---|---|---|---|
| 13 | Opening price | `openingPrice.quotePerWrapped` | Base units: 100 bUSDC per BLCH is `100000000` |
| 14 | Same price | `dex-seed-plan.mjs --price` | Whole units: `100`. Not tied to item 13 by any tool, so check both |
| 15 | bUSDC cap | `reserveCaps[1].cap` | Section 2 |
| 16 | bUSDC token address | `reserveCaps[1].token` | From the bridge deployment |
| 17 | bUSDC runtime code hash | `reserveCaps[1].codeHash` | From the bridge deployment |
| 18 | Bucket capacity check | `reserveCaps[1].bridgeBucketCapacity` | Must equal the token's `bucketCapacity()`. Committed: `10000000000` |
| 19 | Keeper host, monitor host, alert route | `scripts/ops/systemd/dex-monitor.env.example` | The monitor sends no alerts by itself |
| 20 | Keeper budget | Keeper flags | Default 0.05 BLCH and 48 transactions per 24 h. Depends on the L2 base fee |
| 21 | Fees at signing | `sign-and-publish.sh --max-fee-wei --priority-fee-wei` | Chosen at signing time. The max fee must be above the L2 base fee (`cast base-fee`), or the RPC refuses the first transaction with `max fee per gas less than block base fee`; nothing is sent then. The balance check uses gas limit x max fee, so a high max fee needs more gas funds |

Website, in `frontend.network.json` and `_headers` (items 22-25), and the bridge pins in `frontend.bridge.json` (item 26):

| # | Input | Note |
|---|---|---|
| 22 | `genesisHash` | Null until reviewed. The pinned value is in `pins.json` |
| 23 | `rpc.url` and `rpc.status` | Placeholder until the public RPC is live. The CSP `connect-src` must name the same origin |
| 24 | `explorer.url` | |
| 25 | bUSDC `depositUrl`, `withdrawUrl`, `docsUrl` | |
| 26 | `frontend.bridge.json`: `ethereum.rpc.url` and `rpc.status`, `ethereum.vault`, `route`, `vaultCodeHash`, `signers`, `guardians`, `l2.token`, `tokenCodeHash`, `signers`, `proposed.*`, then `status: "live"` last | From the bridge deployment (`vault_pontes.py verify`). The Ethereum RPC origin also goes in `_headers` `connect-src`; `npm test` prints the expected file |

What the site does not keep: the page's transaction list lives in memory. A reload keeps only a swap whose outcome is still unknown. A finished swap, an approve, a wrap or a skim is gone after a reload, so users and support must use the explorer (item 24) for history.

Derived by the tools, not chosen: `blochInc` (from `deploy-safe.mjs blochinc`) and the finality gate file.

Order: Safe, then the bUSDC bridge, then items 16 to 18, then the DEX plan. Infra comes first of all.

Funds: BLCH on the L2 for gas on keys 6, 7, 8, 8a and 11; the seed in BLCH and bridged bUSDC on key 8a.

The bUSDC for the seed comes through `BridgedStablecoinV3` at T = 0: it credits no earlier than 12 h after its mint queues, and only after every earlier deposit credits, so a cancelled deposit ahead of it holds it until that slot is reminted. Bridge it a day ahead. Anyone may call `executeMint`, but **not key 8a**: one transaction from it spends the depositor key. Let the relayer execute it, and check `balanceOf(8a)` and `cast nonce 8a` = 0 before the plan.

## 5. Before the first command

The commands are in `MAINNET-700770-PACKAGE.md`, "Mainnet sequence (owner)", then `OPS-INITIAL-LIQUIDITY.md`. On the signing machine:

- Node 24 and Foundry (`cast`, `forge`). Run `npm ci` in `frontend/` first: every deployment tool loads `viem` from there and fails with `Cannot find module 'viem'` otherwise.
- `SAFE_ARTIFACTS`: the `build/artifacts` folder of the npm tarball `@safe-global/safe-contracts@1.4.1`, checked against the integrity in `pins.json`. `deploy-safe.mjs plan`, `preflight` and `txs` need `--artifacts`.
- Signer arguments for `sign-and-publish.sh`: `--ledger`, or `--keystore <file> --password-file <file>`. Do not use `--private-key`: the key is then in the process list while it runs.
- Every `sign-and-publish.sh` run needs a new `--hashes-out` file. A second run of the same file is refused at its first nonce, which is the intended stop.
- The seed is signed the same way: `dex-seed-plan.mjs plan … --write-txs <new file>` writes the approve and the seed with chain, genesis, depositor and nonces. Pass that file to `sign-and-publish.sh` with `--confirm` set to the `configSha256` the plan prints. Keep `--fraction-bps` at the default 5,000; the planner refuses more than 7,000 (owner decision DEX-4, round 10). A seed of 8,000 bps is exactly the k ceiling at P = 50, 80 and 100, so LPs and the Safe would earn nothing from the first swap; 7,000 keeps k at 76.6% of the ceiling. On a slow L2, raise `--deadline-min` above the time two blocks take, or the seed expires after the approve and needs `note-tx`.
- A new deployment after a spent depositor key (`OPS-INITIAL-LIQUIDITY.md`, F1) keeps the Safe, Multicall3 and the CREATE2 deployer, but WBLCH, the factory, the router, the lens and the pair are all new addresses. Run `deploy-dex.mjs validate` again before `txs`: the config hash, and so `--confirm`, changes.
