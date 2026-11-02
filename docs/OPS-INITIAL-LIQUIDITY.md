# Initial liquidity runbook

The price and cap options and the owner's inputs are in `OPS-OPENING-KIT.md`.

Covers the opening ratio, DEX-04 (a donation sets the opening ratio) and DEX-09 (a donation can make the pair unusable). Pair: WBLCH/bUSDC only.

## Before you start

1. The gate must pass. The monitor must exit 0 without `--expect-seeded`.
2. Decide the opening price `P` in bUSDC per BLCH (`TBD-owner`) from an external market or a stated decision. No on-chain source exists at launch.
3. Decide who receives the LP shares (`TBD-owner`). Use an address separate from the Safe, so principal and protocol fee are not mixed and a withdrawal does not need 3 of 5.
4. Fund the first depositor with the deposit plus gas. bUSDC must already be bridged.

## The first depositor

Only `factory.firstDepositor()` can make a pair's first deposit. Use **a fresh EOA, made for this, that sends exactly two transactions: the approve and the seed.**

- **Why so strict.** The rule accepts `tx.origin`, so the seed can go through the router. So one call from this key to any hostile contract, even an `approve` on a hostile token, lets that contract make the first mint. The rule is then spent for good.
- **Checks.** `dex-seed-plan.mjs` and the finality gate refuse while the pair has no shares and the key has a nonzero nonce or has code. `preflight` and the deployment script refuse too.
- **Other uses.** Do not fund it from a contract you do not trust, connect it to a site, or sign anything else with it. Receiving funds does not change its nonce.
- **If the key is lost or used before the seed,** deploy a new factory with a new key. The rule covers every pair on the factory, so no other pair can open either.
- **If the seed fails, do not deploy again.** A griefer can make it revert for gas, by donating just over the room after the approve. The nonce is no longer 0, so the planner and gate refuse until you record what the key sent. Run `note-tx` with every depositor transaction not yet recorded, comma-separated in nonce order (below): recording one at a time is refused while another is missing. Then plan again. The tools continue only if every nonce is a planned approve of the router or a router seed, read from the chain. Any other transaction stays refused, and that does need a new deployment. A griefer can repeat this: each round costs a retry and gas, and its donation is at risk if someone else skims first. Do not approve again: the plan marks that step `skip`.
- **What the check cannot see:** a transaction signed but not mined, or a stolen key.
- **The Safe as depositor is not supported.** It cannot use the router (`GS013`). The direct path through `MultiSendCallOnly` (transfer, transfer, mint) worked in agent 61's test, but `MultiSendCallOnly` is not deployed here, the planner does not produce it, and no tool exists.

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
| `refuse` naming the nonce | 2 | The first depositor is not fresh. See "The first depositor" |
| `correct-price` | 1 | LP shares at another price, which needs the depositor's key to have been baited. Send the plan's swap steps, then plan again |
| `top-up` | 0 | LP shares at this price. Send `steps[0]` and `steps[1]`; the deposit follows the pool's ratio |
| `closed` | 2 | Both reserves at their caps. The contracts should make this unreachable, so treat it as an incident |
| `bricked` | 2 | See DEX-09 |

Send them with `sign-and-publish.sh`, not a wallet: it refuses another chain ID or genesis, another signer, and a nonce that is not the planned one. Add `--write-txs seed.txs.json` to the `plan` command, then:

```
scripts/staging/sign-and-publish.sh --txs seed.txs.json --rpc http://127.0.0.1:18955 --confirm TBD-confirm-from-plan --max-fee-wei TBD-owner --priority-fee-wei TBD-owner --hashes-out seed.hashes.txt -- --ledger
```

`--confirm` is the plan's `txFile.confirm`. The approve is for the exact deposit: never give this key a larger allowance, because the exact amount stops a second plan from depositing twice. `--fraction-bps` is refused above 8,000, where the opening would pass the k ceiling. Send them as soon as you have the plan: the plan is good only for the state it read.

Record a sent approve or seed if you need to plan again: after the approve, or after a failed seed. It writes `deployment.depositorTransactions` in the gate file, only if the whole history checks out:

```
node scripts/ops/dex-seed-plan.mjs note-tx --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --tx TBD-hash
```

Verify, right after inclusion:

```
node scripts/ops/dex-seed-plan.mjs verify --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --price TBD-owner --to TBD-owner
```

Exit 0 is `seed-verified`: the price is within 1% by default and the recipient holds at least 99% of the shares other than the locked ones. `seed-not-ours` means someone else's liquidity is at that price, so do not announce. Announce the pool only after this and after the seed is finalized.

## DEX-04: a donation sets the opening ratio

On a pair with no LP shares, the router takes the desired amounts as given. The minimums do not protect the ratio there, so `verify` is the protection. A donation cannot be synced any more (see DEX-09), but one already in the pair counts toward the first mint, and the first LP owns it except for the 1,000 locked shares. So it costs the attacker money.

- **Seen before the seed.** The monitor shows `preseed` WARN and the planner returns `skim-first`. Someone other than the depositor must run `skim`, so the depositor's nonce stays 0. Then plan again.
- **Landed between the plan and the seed.** `verify` exits 2. The seeder holds nearly all the shares, so it can correct the price with a swap of the size that restores `P`. It pays 0.3% on that swap and gets most of it back as the LP. Alternatively, remove the position; the 1,000 locked shares stay behind, so a later deposit must follow the pool's ratio, and a small swap has to correct the price first. The swap is the simpler choice.

## DEX-09: fixed

Donations synced exactly to both caps of an empty pair used to block `mint` and `swap` forever. `sync` now reverts with `BDEX: EMPTY_POOL` while no LP shares exist, so a donation stays outside the reserves until `skim` removes it. A donation above a cap blocks the seed only until that skim. The griefer forfeits it to whoever skims. The monitor's and planner's `bricked` and synced-donation branches stay as defensive checks and are unreachable on this pair code. See `AUDIT-SCOPE-DEX.md`.

## F1: the k ceiling

`reserve0 * reserve1` stays at or below 64% of `cap0 * cap1`, so the two reserves can never both sit at their caps. A third party cannot make the first deposit. The limits are in `OPS-OPENING-KIT.md` section 3.

Unrecorded balance can still fill the room on both sides, which closes both swap directions until anyone calls `skim`. The monitor reports `closed_by_excess`, and the keeper skims it without waiting for its backoff.

**If the depositor's key is baited and an attacker fills the pool to the ceiling:** swaps stay open and the attacker's capital is the market. The seed reverts. Wait for the attacker to burn, or deploy a new factory:

1. Announce it. Do not bridge further seed funds.
2. Use a new deployer key and a new first depositor. Run `deploy-dex.mjs plan --write`, and commit the new plan.
3. Run `txs`, `sign-and-publish.sh --plan`, `record`, `verify-deployment`.
4. Wait for the finality gate again, about 100 minutes.
5. Rebuild the frontend record, then seed.

The Safe and the Multicall3 and CREATE2 deployments are kept. This procedure has not been rehearsed.

## After the seed

**The first-deposit rule does not come back.** If every LP exits, 1,000 locked shares remain, so anyone can `sync` a new price over the dust reserves and deposit. Keep a position in the pool, or treat a full exit as reopening the pair to everyone (agent 98, A98-5).

- Run the monitor with `--expect-seeded --lp-recipient <LP recipient>`. Below half the shares it reports `lp_recipient` CRIT. If the recipient exits on purpose, lower `--lp-min-bps`.
- Start the keeper.
- Add liquidity only pro rata through the router. A deposit reverts if a reserve would pass its cap (`RESERVE_CAP`) or if `k` would pass the ceiling (`K_CEILING`). Both a filled pool and a side at its cap close deposits, and no swap reopens a filled one.
