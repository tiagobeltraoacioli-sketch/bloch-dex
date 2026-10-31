# Initial liquidity runbook

The price and cap options and the owner's inputs are in `OPS-OPENING-KIT.md`.

Covers the opening ratio, DEX-04 (a donation sets the opening ratio) and DEX-09 (a donation can make the pair unusable). Pair: WBLCH/bUSDC only.

## Before you start

1. The gate must pass. The monitor must exit 0 without `--expect-seeded`.
2. Decide the opening price `P` in bUSDC per BLCH (`TBD-owner`) from an external market or a stated decision. No on-chain source exists at launch.
3. Decide who receives the LP shares (`TBD-owner`). Use an address separate from the Safe, so principal and protocol fee are not mixed and a withdrawal does not need 3 of 5.
4. Fund a seeder with the deposit plus gas. bUSDC must already be bridged.

## The caps limit the protection at some prices

Caps are constructor values: `10 WBLCH` and, as committed, `1,000 bUSDC`. They balance at P = 100. The documented "at most half of the WBLCH" for a counterfeit bUSDC dump holds only when the bUSDC reserve is half its cap.

A dump takes the WBLCH side from `R` to `R * Rq / cap`, where `Rq` is the bUSDC reserve. Measured at P ≈ 25.5, seed 5 WBLCH + 127.5 bUSDC: **87% of the WBLCH side is lost** (`rehearse-ops.sh`, scene 9).

| P (bUSDC/BLCH) | Seed at 50% of the tighter cap | Share of WBLCH lost to a dump to the cap |
|---|---|---|
| 5 | 5 WBLCH + 25 bUSDC | 97.5% |
| 25 | 5 WBLCH + 125 bUSDC | 87.5% |
| 100 | 5 WBLCH + 500 bUSDC | 50% |
| 400 | 1.25 WBLCH + 500 bUSDC | 50% |

The WBLCH at risk stays bounded by the seed. **The bUSDC cap must be near `10 * P`**, since it cannot change after deployment. `openingPrice.quotePerWrapped` in `dex-mainnet.config.json` enforces it: `deploy-dex.mjs validate` and `plan` refuse a cap outside 75–125% of `10 * P`, unless the 1/10 bucket rule is what holds the cap below it. The table shows a 1,000 bUSDC cap. Use the same `P` for the plan here. The ops rehearsal uses a 255 bUSDC cap at P = 25.5 and measured a dump to the cap at 5.05 → 2.54 WBLCH, 49.6% lost, against 87% with the 1,000 bUSDC cap.

## Opening

Plan. It is read-only and uses 50% of the tighter cap by default:

```
node scripts/ops/dex-seed-plan.mjs plan --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --price TBD-owner --to TBD-owner
```

| Result | Exit | Meaning |
|---|---|---|
| `proceed` | 0 | Send `steps[0]` (approve) and `steps[1]` (seed), in that order |
| `skim-first` | 1 | An unsynced donation is in the pair. Skim, then plan again |
| `refuse` | 2 | Seeded already, or a donation too large for this price within the caps |
| `bricked` | 2 | See DEX-09 |

Send the plan's `to`, `value` and `data` with your signer, without changing them. Send them as soon as you have the plan: the plan is good only for the state it read.

Verify, right after inclusion:

```
node scripts/ops/dex-seed-plan.mjs verify --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --price TBD-owner
```

Exit 0 is `seed-verified`, within 1% by default. Announce the pool only after this and after the seed is finalized.

## DEX-04: a donation sets the opening ratio

On a pair with no LP shares, the router takes the desired amounts as given. The minimums do not protect the ratio there, so `verify` is the protection. A donation cannot be synced any more (see DEX-09), but one already in the pair counts toward the first mint, and the first LP owns it except for the 1,000 locked shares. So it costs the attacker money.

- **Seen before the seed.** The monitor shows `preseed` WARN and the planner returns `skim-first`. Run `skim`, then plan again.
- **Landed between the plan and the seed.** `verify` exits 2. The seeder holds nearly all the shares, so it can correct the price with a swap of the size that restores `P`. It pays 0.3% on that swap and gets most of it back as the LP. Alternatively, remove the position; the 1,000 locked shares stay behind, so a later deposit must follow the pool's ratio, and a small swap has to correct the price first. The swap is the simpler choice.

## DEX-09: fixed

Donations synced exactly to both caps of an empty pair used to block `mint` and `swap` forever. `sync` now reverts with `BDEX: EMPTY_POOL` while no LP shares exist, so a donation stays outside the reserves until `skim` removes it. A donation above a cap blocks the seed only until that skim. The griefer forfeits it to whoever skims. The monitor's and planner's `bricked` and synced-donation branches stay as defensive checks. Their exact condition (no LP shares) is unreachable on this pair code, but **the same closed state is reachable with LP shares through a mint to both caps (review finding F1, open), and neither branch reports it**. See `AUDIT-SCOPE-DEX.md`.

## After the seed

- Run the monitor with `--expect-seeded`.
- Start the keeper.
- Add liquidity only pro rata through the router. Keep the sum of reserves under the caps, or the deposit reverts.
