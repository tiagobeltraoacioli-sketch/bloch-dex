# Opening kit: price, bUSDC cap and owner inputs

Status: nothing is deployed. Every value here is a proposal for the owner. **Finding F1 below is open and can change the pair init code hash.** Read it before choosing.

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
- **Capital to close the pair (F1):** the other side of both caps, valued at `P`. Arithmetic from the seed, not run at each row. Agent 51 ran it at `P = 100`.

| P | Cap C | Validator | Seed | Seed value (bUSDC) | Dump loss | Price range | Capital to close the pair (bUSDC) |
|---|---|---|---|---|---|---|---|
| 10 | 100 | accept | 5 WBLCH + 50 | 100 | 49.9% | 2.50 to 39.9 | 100 |
| 25 | 250 | accept | 5 WBLCH + 125 | 250 | 49.9% | 6.26 to 99.8 | 250 |
| 25.5 | 255 | accept | 5 WBLCH + 127.5 | 255 | 49.9% | 6.38 to 101.8 | 255 |
| 50 | 500 | accept | 5 WBLCH + 250 | 500 | 49.9% | 12.5 to 199.7 | 500 |
| 64 | 500 | accept | 3.91 WBLCH + 250 | 500 | 49.9% | 9.78 to 255.6 | 640 |
| 64 | 800 | accept | 5 WBLCH + 320 | 640 | 59.9% | 16.0 to 399.3 | 800 |
| 80 | 800 | accept | 5 WBLCH + 400 | 800 | 49.9% | 20.0 to 319.5 | 800 |
| 80 | 1,000 | accept, lowest price for this cap | 5 WBLCH + 400 | 800 | 59.9% | 20.0 to 499.1 | 1,000 |
| 100 | 800 | accept | 4 WBLCH + 400 | 800 | 49.9% | 16.0 to 399.4 | 1,000 |
| 100 | 1,000 | accept, both caps balance | 5 WBLCH + 500 | 1,000 | 49.9% | 25.0 to 399.4 | 1,000 |
| 133 | 1,000 | accept | 3.76 WBLCH + 500 | 1,000 | 49.9% | 18.8 to 531.2 | 1,330 |
| 200 | 1,000 | accept, bucket rule | 2.5 WBLCH + 500 | 1,000 | 49.9% | 12.5 to 798.8 | 2,000 |
| 400 | 1,000 | accept, bucket rule | 1.25 WBLCH + 500 | 1,000 | 49.9% | 6.27 to 1,597.6 | 4,000 |
| 1,000 | 1,000 | accept, bucket rule | 0.5 WBLCH + 500 | 1,000 | 49.9% | 2.51 to 3,994 | 10,000 |

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
- **`P < 80`: the cap must be lowered, to about `10 * P`,** and the committed config changed before deployment. The pool is then smaller, and so is the capital needed to close it.
- A lower cap changes no contract code. `scripts/staging/dex-deploy-config.test.mjs` pins the committed cap, so update that assertion with the value.

Recommendation: `C = min(1000, 10 * P)`. The price is the owner's decision.

## 3. Findings that affect the opening

From `agents/51-dex-review.md`, at `258fdd2`, all open:

- **F1:** a mint to both caps closes the pair to swaps and mints, while the capital can be recovered. It works before the seed and after it. The proposed contract fix changes the pair init code hash, so it needs a new plan, new rehearsals and a new audit scope.
- **F2:** a front-run `createPair` strands the deployment tooling.

## 4. What the owner must provide

Provide public addresses only. Keys stay with the owner and are never put in a repo, a config or a chat.

| # | Input | Where it goes | Key rule |
|---|---|---|---|
| 1-5 | 5 Safe owner addresses, in order | `safe.config.json` `safe.owners[0..4]` | Hardware wallets. Threshold 3 of 5 |
| 6 | Safe bootstrap address | `safe.config.json` `bootstrap.address` | Gas only. No role afterwards. `startNonce` 0 |
| 7 | Infra deployer address | `infra.config.json` `deployer.address` | New key, gas only. `startNonce` 0 |
| 8 | DEX deployer address | `dex-mainnet.config.json` `deployer.address` | Gas only. `startNonce` 0 |
| 9 | LP recipient address | `dex-seed-plan.mjs --to` | Recommended: not the Safe |
| 10 | Seeder address | Signs the plan's `steps` | Holds the seed plus gas |
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
| 20 | Keeper budget | Keeper flags | Default 0.01 BLCH per 24 h. Depends on the L2 base fee |
| 21 | Fees at signing | `sign-and-publish.sh --max-fee-wei --priority-fee-wei` | Chosen at signing time |

Website, in `frontend.network.json` and `_headers`:

| # | Input | Note |
|---|---|---|
| 22 | `genesisHash` | Null until reviewed. The pinned value is in `pins.json` |
| 23 | `rpc.url` and `rpc.status` | Placeholder until the public RPC is live. The CSP `connect-src` must name the same origin |
| 24 | `explorer.url` | |
| 25 | bUSDC `depositUrl`, `withdrawUrl`, `docsUrl` | |

Derived by the tools, not chosen: `blochInc` (from `deploy-safe.mjs blochinc`) and the finality gate file.

Order: Safe, then the bUSDC bridge, then items 16 to 18, then the DEX plan. Infra comes first of all.

Funds: BLCH on the L2 for gas on keys 6, 7, 8, 10 and 11; the seed in BLCH and bridged bUSDC on key 10.
