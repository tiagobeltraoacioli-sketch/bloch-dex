# DEX monitor and skim keeper

Tools: `scripts/ops/dex-monitor.mjs`, `scripts/ops/dex-skim-keeper.mjs`, example units in `scripts/ops/systemd/`.
Both read the schema-2 gate file written by `deploy-dex.mjs record`, so they have no second list of addresses. Node 24 and `frontend/node_modules` (for viem) are required.

## Monitor

Read-only: it holds no key and its RPC client refuses any method outside a read list. Run it against your own settled RPC.

```
node scripts/ops/dex-monitor.mjs --config deployments/mainnet/finality-gate.mainnet.json --safe-plan deployments/mainnet/700770/safe.plan.json --rpc http://127.0.0.1:18955 --expect-seeded --lp-recipient TBD-owner --keeper-state /var/lib/bloch-dex-keeper/state.json
```

Exit status is the L2 monitor's: 0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN. UNKNOWN means the node did not answer; it says nothing about the chain. `--json` prints the same checks for a pipeline. The monitor does not send alerts. The example unit writes its `--json` report to `/var/lib/bloch-dex-monitor/report.json`, and the L2 monitor (bloch-l2-evm `deployment/mainnet/l2_monitor.py --report dex=/var/lib/bloch-dex-monitor/report.json:900`) alerts on every WARN and CRIT check in it through its own `alert.json` (webhook, Telegram, `alert_command`, dead-man `heartbeat_url`) with one deduplication. A report older than 15 minutes is WARN there and 45 minutes CRIT: that is how a dead DEX monitor, a stopped timer or a node that stopped answering (UNKNOWN leaves an empty file) is noticed. Before agent 105's change the unit had no `OnFailure=` and no `--keeper-state`, so a CRIT only failed a unit nobody watched and `keeper_budget` was never checked.

| Check | Reads at | WARN | CRIT |
|---|---|---|---|
| `rpc_identity` | | | wrong chain ID or genesis |
| `l2_head_age` | latest | 25 min | 45 min |
| `l2_finalized_age` | finalized | 150 min | 240 min, or no finalized block |
| `finality_gate` | finalized | | the gate refuses. On mainnet this is `evaluateMainnetGate`, the code that opened the gate |
| `safe_pinned[latest\|finalized]` | both | | proxy code, singleton, handler, guard, modules, owners, threshold or version differ |
| `contract_code` | latest | | any runtime hash or the pair init code hash differs |
| `pair_count` | latest | more pairs than planned (DEX-03) | |
| `preseed` | latest | unsynced donation; empty with `--expect-seeded` | synced donation (DEX-04); bricked (DEX-09) |
| `reserve_cap` | latest | at 80% of the cap, or at the cap | above the cap, or no cap |
| `pending_excess[latest]` | latest | blocking | balance below reserve |
| `pending_excess[finalized]` | finalized | material | blocking: it has stood about 100 minutes, so the keeper did not clear it |
| `closed_by_excess` | latest, finalized | soft: only swaps below the floor stop | hard: an excess at or above the floor closes the pair |
| `k_ceiling` | latest | at the ceiling: swap fees reach neither LPs nor the Safe | |
| `keeper_budget` | keeper state file, with `--keeper-state` | 3 or more skims that moved nothing in 24 h, or half the count used | count used up, or the state file is unreadable |
| `price_drift` | both | 10% between finalized and latest | 50% |
| `fee_accrued` | finalized | | facts only: minted LP, pending LP, reserve share |
| `fee_tracking` | finalized | | `kLast` is zero on a seeded pair |
| `safe_allowance` | finalized | the Safe still has an LP allowance to the router | |
| `lp_in_pair` | latest | | LP shares sit in the pair; anyone can burn them to themselves |
| `lp_floor` | latest, with `--expect-seeded --lp-recipient` and `--lp-min-shares N` above 0 (opening form, `DEX_LP_MIN_SHARES`) | | the LP recipient holds fewer than the owner's floor: a full exit reopens the pair to anyone at any price (A98-5, `OPS-INITIAL-LIQUIDITY.md`) |
| `bridge_token` | latest | mints paused | |
| `bridge_exit[bUSDC]` | token at L2 finalized and latest; vault at Ethereum finalized and latest, with `--eth-rpc` and `--bridge-vault` (agent 144) | vault guardian pause or releases disabled: exits wait for the term | **held**: the token's mint chain differs from the vault's deposit chain, or it credited more mints than the vault has deposits even at latest. The vault refuses every burn from then on, including bUSDC taken out of the pool. A read failure is UNKNOWN, never OK |
| `reference_price` | latest | 5% from `--ref-price` | 15% |

`bridge_exit` reads the bridge the way its `reservas` monitor (status `held`) and the bridge page do: BridgedStablecoinV3 `mintHead()`/`mintCount()` against ProvenanceSourceVault `chainHeadAt(mintCount)`. The example units pass `--eth-rpc ${DEX_ETH_RPC} --bridge-vault ${DEX_BUSDC_VAULT}` (TBD-owner in the env file; an Ethereum RPC that serves `finalized`); `--bridge-vault-code-hash` optionally pins the vault code. Without them the check is not run. The keeper takes the same two options and reports `bridgeExit` (`normal`, `paused`, `held`, `unknown: …`) in its output; it never changes what the keeper does, and held or paused raise its exit to WARN. The DEX page shows the same state (see frontend README, `bridges[].status`).

`--ref-price` is an operator input in bUSDC per BLCH. The kit trusts no oracle.

After a skim clears a donation, `pending_excess[finalized]` stays CRIT until the skim is finalized, about 100 minutes. Check the `latest` line before acting.

## Why donations are classified by a floor

The excess of a side (`balance - reserve`) is one of:

| Kind | Meaning | Keeper | Monitor |
|---|---|---|---|
| dust | below the floor, 1% of the cap by default (10 bUSDC, 0.1 WBLCH) | ignores it | OK |
| material | at or above the floor, `balance < cap` | skims | WARN when finalized |
| blocking | at or above the floor, `balance >= cap` | skims | WARN at latest, CRIT finalized |

A swap on that side absorbs dust as input. One wei above a full reserve blocks nothing that the cap did not already block, except swaps out smaller than that wei.

## Skim keeper (DEX-02)

`skim` is permissionless. This keeper is a convenience, and anyone, including a user, can do the same:

```
cast send <pair> "skim(address)" <Bloch Inc Safe> --rpc-url <rpc> --keystore <keystore>
```

Dry run (the default):

```
node scripts/ops/dex-skim-keeper.mjs --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --keeper TBD-owner --state /var/lib/bloch-dex-keeper/state.json
```

To send, add `--execute` and the signer after `--`:

```
node scripts/ops/dex-skim-keeper.mjs --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --keeper TBD-owner --state /var/lib/bloch-dex-keeper/state.json --execute -- --keystore TBD-owner --password-file TBD-owner
```

Signing goes through `cast mktx`; the keeper never sees the key. Use a fresh address funded with gas only. Avoid `--private-key` outside rehearsals, because it shows in the process list.

| Limit | Option | Default |
|---|---|---|
| Budget, rolling 24 h, worst case reserved before signing | `--budget-wei` | 0.05 BLCH |
| Transactions per 24 h | `--max-tx` | 48 |
| Share of the count a soft closure may use | `--soft-share-bps` | 2,500 |
| Share of the count kept for a hard closure | `--hard-reserve-bps` | 2,500 |
| Lowest tip, and the top of the climbing range | `--tip-wei`, `--max-tip-wei` | 1 gwei, 8 gwei |
| Fee ceiling | `--max-fee-wei` | 20 gwei |
| Gas limit ceiling (1.2 x the estimate must fit) | `--max-gas` | 150,000 (measured use 77,000) |
| Floor | `--floor-bps` | 100 |
| Time between transactions | `--cooldown-s` | 1,800 s |
| Unconfirmed transaction expiry | `--pending-timeout-s` | 7,200 s |

Exit status: 0 nothing needed, sent, waiting or cooling down; 1 needs attention (budget, count, fee, gas, funding, backoff); 2 refused (identity, code hash, simulation, publication); 3 the node did not answer.

### Griefing analysis

| Attack | What happens | Cost to the attacker |
|---|---|---|
| Dust donations to drain gas | No transaction | Gas |
| Repeated material donations | Each one is sent to the Safe. At most `--max-tx` keeper transactions a day, and the budget holds | The floor or more per transaction, forfeited |
| About 1 USD on a side already at its cap (soft closure) | Stops only swaps smaller than the donation. The keeper keeps its cooldown and backoff, and spends at most a quarter of its count | About 95k gas a round; the donation only if it loses |
| Donate, then front-run the keeper's skim to get the money back | The skim moves nothing, is recorded as wasted, and the keeper backs off exponentially (2x, 4x… the cooldown, capped at 6 h). Measured on anvil | Gas only, but the capital is exposed: if the keeper lands first it goes to the Safe |
| Donate just before a user's swap, skim right after | The user's swap reverts inside that block. No keeper can prevent this; ordering decides it | Gas. This is the accepted residual of DEX-02 |
| Steal the keeper key | Only the gas balance is at risk; recipient and pair are not options | |
| Change a token or pair | Code hashes are checked first; the keeper refuses | |

The recipient is always the fee recipient in the gate file. Keeping it fixed means running a keeper pays nobody, so there is no profit in colluding with one. A user who sends tokens to the pair by mistake can ask Bloch Inc for a refund from the Safe, if the keeper took them first.

When the keeper stops at a limit the pool is not at risk; swaps on that side stay blocked and the monitor stays loud. Raising limits is an operator decision, as is a manual skim.

The state file is the budget. If it is damaged the keeper refuses to run; it does not reset. Inspect it and move it away only when you have decided to.

### Crash behaviour

State is written before publishing. A crash after that leaves a `pending` entry; the next run reconciles it by receipt, then by nonce, then by timeout. A transaction whose fate is unknown keeps its reservation until it leaves the 24 h window. The keeper also waits for `latest` to reach a receipt's block, since the settled RPC can serve a receipt first.

## Both directions closed by excess

Unrecorded balance can stop swaps both ways until someone calls `skim`. A swap into a full side reverts at any size. A swap out of an overfull side passes if it takes out at least that side's balance above its cap, so a closure is only as wide as the donation.

| Closure | What it takes | What stops | Monitor | Keeper |
|---|---|---|---|---|
| Soft | About 1 USD when a side's reserve already sits at its cap: 0.0397 WBLCH at a pool price of 25 | Swaps smaller than the excess, and the full side's inflow, which its cap already stopped | WARN, names the size that passes | Cooldown and backoff apply, a quarter of the count |
| Hard | An excess of at least the floor, 1% of a cap, on a side at its cap. From a pool with room on both sides, about 2 WBLCH + 200 bUSDC. It goes to whoever skims | Ordinary swaps | CRIT at latest and at finalized | First, skips backoff and cooldown. If it stops at a limit its exit is CRIT |

The closed test is a swap of 0.1% of a cap reverting both ways; the floor sets soft or hard.

**A griefer can race the keeper, and it wins whenever it pays more.** On the private L2 (real selector, synthetic finality), seeing only the keeper's pending nonce, it won 8 of 8 rounds at a 3 gwei tip against the fixed 1 gwei of the old defaults. The old 8-transaction limit was gone for about 0.0028 BLCH of gas and no lost capital. Now:

- The tip varies between `--tip-wei` and a top that doubles with each wasted skim, up to `--max-tip-wei`. A griefer below the top risks its donation.
- A griefer that skims above the keeper can only re-donate below the keeper's tip in the same block, or the keeper takes the donation. A user whose tip is above that re-donation trades in between. See the agent report for the run.
- Nothing stops a griefer who always pays above the top. It then pays more than the keeper per round, and the limit runs out at a known cost. When it does, the keeper stops with exit 2 on a hard closure.

When `keeper_budget` warns or the keeper stops:

1. Check `closed_by_excess[latest]`. A soft closure can wait.
2. A hard closure holds at least 1% of a cap, free to anyone. Skim it by hand with the command above, from any funded key.
3. Raise `--max-tx` and `--budget-wei` for a day if the race goes on. Each round costs the griefer more than it costs you.

## The k ceiling

At the ceiling a swap's fee stays outside the reserves. LPs and the Safe earn nothing from it, and anyone can take it with `skim`. The monitor warns with `k_ceiling`. Measured on the private L2 at exactly 64% of the caps, 150 alternating swaps of 4% of the input reserve:

| | At 50% of the caps | Exactly at the ceiling |
|---|---|---:|
| k growth | 1.7% on $2,955 of volume | 0 on $4,708 |
| Protocol fee pending | 15.95 bps of supply | 0 |
| Unrecorded at the end | 0 | $136, 2.9% of volume |
| Keeper's first action, floor 1% | none | swap 43, $1,350 of volume |

The excess is about ten times the 0.3% fee, because a standing excess fills later trades with the reserves unmoved: those traders still get their quote, and the excess keeps their price impact. It costs LPs nothing beyond the missing fee.

The keeper sends what it skims to the Safe, so at the ceiling the fee that used to be the LPs' goes to the Safe or to a faster skimmer. A lower floor at the ceiling would collect more for the Safe. That is an owner decision and is not implemented.

## Storage footprint

The settlement guest loads the complete storage of every account a block touches, about 12.5k instructions per slot. A swap touches the pair, WBLCH and bUSDC, so their slots add up. `scripts/ops/dex-storage-footprint.mjs` counts them from logs and calls, and compares the sum with what the proven class allows at the current L2 height. It holds no key.

```
node scripts/ops/dex-storage-footprint.mjs --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --state /var/lib/bloch-dex-keeper/footprint.json
```

Exit status as the monitor. WARN at 37.5% and CRIT at 62.5% of the capacity at that height. It matched anvil's state dump exactly at 1,545 slots. Before the first swap in a later second the two price accumulators are still zero, so it can read up to 2 high on a new pair.

| Action | Pair | WBLCH | bUSDC |
|---|---:|---:|---:|
| Swap, a holder that already has a balance | 0 | 0 | 0 |
| Swap BLCH to bUSDC, new holder | 0 | 0 | +1 |
| Sell bUSDC, exact approve (the mainnet page) | 0 | 0 | 0, or -1 when selling all |
| Sell bUSDC, unlimited approve (other wallets) | 0 | 0 | +1, once |
| Bridge deposit | 0 | 0 | +2 first, then +1 each, forever |
| Bridge burn of all | 0 | 0 | 0 |
| New LP | +2 | 0 | 0 |
| Any `approve` to a fresh spender, no balance needed | +1 | +1 | +1 |

The router and Lens hold no storage. A griefer can add about 580 slots per 15M-gas block to any one of the three, for about 26 microBLCH each. This tool sees that; it cannot stop it. Only the guest or the sequencer can.
