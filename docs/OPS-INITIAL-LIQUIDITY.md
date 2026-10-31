# Initial liquidity runbook

Covers the opening ratio, DEX-04 (a donation sets the opening ratio) and DEX-09 (a donation can make the pair unusable). Pair: WBLCH/bUSDC only.

## Before you start

1. The gate must pass. The monitor must exit 0 without `--expect-seeded`.
2. Decide the opening price `P` in bUSDC per BLCH (`TBD-owner`) from an external market or a stated decision. No on-chain source exists at launch.
3. Decide who receives the LP shares (`TBD-owner`). Use an address separate from the Safe, so principal and protocol fee are not mixed and a withdrawal does not need 3 of 5.
4. Fund a seeder with the deposit plus gas. bUSDC must already be bridged.

## The caps limit the protection at some prices

Caps are constructor values: `10 WBLCH` and `1,000 bUSDC`. They balance at P = 100. The documented "at most half of the WBLCH" for a counterfeit bUSDC dump holds only when the bUSDC reserve is half its cap.

A dump takes the WBLCH side from `R` to `R * Rq / cap`, where `Rq` is the bUSDC reserve. Measured at P ≈ 25.5, seed 5 WBLCH + 127.5 bUSDC: **87% of the WBLCH side is lost** (`rehearse-ops.sh`, scene 9).

| P (bUSDC/BLCH) | Seed at 50% of the tighter cap | Share of WBLCH lost to a dump to the cap |
|---|---|---|
| 5 | 5 WBLCH + 25 bUSDC | 97.5% |
| 25 | 5 WBLCH + 125 bUSDC | 87.5% |
| 100 | 5 WBLCH + 500 bUSDC | 50% |
| 400 | 1.25 WBLCH + 500 bUSDC | 50% |

The WBLCH at risk stays bounded by the seed. To get the 50% property at a low price, set the bUSDC cap near `10 * P` before deployment, since it cannot change after.

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

On a pair with no LP shares, the router takes the desired amounts as given. The minimums do not protect the ratio there, so `verify` is the protection. If someone donates and syncs first, the pool opens at `(donation + deposit)`. The first LP owns the donation except for the 1,000 locked shares, so it costs the attacker money: the arbitrage it enables never exceeds the donation.

- **Seen before the seed.** The monitor shows `preseed` CRIT. Plan again: the planner subtracts the donation so that the pool opens at `P`, and it reports the gift under `donated`. Tested on anvil: the pool opened at the target and the first LP held all but 1,000 of the shares.
- **Landed between the plan and the seed.** `verify` exits 2. The seeder holds nearly all the shares, so it can correct the price with a swap of the size that restores `P`. It pays 0.3% on that swap and gets most of it back as the LP. Alternatively, remove the position; the 1,000 locked shares stay behind, so a later deposit must follow the pool's ratio, and a small swap has to correct the price first. The swap is the simpler choice.

## DEX-09: a donation can make the pair unusable

**Severity: Low; found while writing this runbook, not yet in `AUDIT-SCOPE-DEX.md`.** No user funds are at risk, since no one has deposited yet.

If both reserves are synced exactly to their caps while no LP shares exist, the pair can never be used:

- `mint` needs a positive amount of both tokens. That lifts a balance above both the cap and the reserve, so it reverts `RESERVE_CAP`. Zero amounts underflow on `sqrt(0) - 1000`.
- `swap` needs a positive input on one side, and any input there lifts that balance above the cap. Taking output from both sides fails the k check.
- `burn` has no shares; `skim` and `sync` cannot lower a reserve.
- `createPair` then refuses `PAIR_EXISTS`, so this factory can never have this pair.

Cost to the griefer: 10 WBLCH + 1,000 bUSDC, permanently lost. Cost to the project: a new factory, router and lens, a new plan and a new gate. Reproduced on anvil with the real token: every path reverted, including after a further sync.

The gate requires the deployment to be finalized before the seed, so the pair is exposed for at least about 100 minutes.

A donation at the cap on only one side is **not** a brick. With the other reserve at zero, no swap passes until someone transfers one base unit there and syncs. After that, anyone can take the donated side by swap: 1.000001 bUSDC took 9.99 WBLCH on anvil. The planner works again after that.

**Recommended fix before mainnet: refuse `sync` while `totalSupply == 0`.** Nothing is deployed, so the cost is one line and a new pair init code hash. A donation then stays outside the reserves, where `skim` removes it, which closes both DEX-09 and the synced form of DEX-04. In a scratch copy, 157 of 159 tests pass with that line. The 2 failures are expected: the pinned init code hash, and `testFirstDepositSurvivesOneSidedDonationAndSync`, which asserts the behaviour being removed. It would need the external audit's scope updated. This branch does not change it; it is an owner decision.

If the pair is bricked without that fix: stop, do not seed, deploy a new factory.

## After the seed

- Run the monitor with `--expect-seeded`.
- Start the keeper.
- Add liquidity only pro rata through the router. Keep the sum of reserves under the caps, or the deposit reverts.
