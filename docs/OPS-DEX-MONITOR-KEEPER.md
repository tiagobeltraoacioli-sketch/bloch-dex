# DEX monitor and skim keeper

Tools: `scripts/ops/dex-monitor.mjs`, `scripts/ops/dex-skim-keeper.mjs`, example units in `scripts/ops/systemd/`.
Both read the schema-2 gate file written by `deploy-dex.mjs record`, so they have no second list of addresses. Node 24 and `frontend/node_modules` (for viem) are required.

The gate and operations clients require a JSON-RPC 2.0 response with the exact
request ID and either a result or a valid error, following the
[response specification](https://www.jsonrpc.org/specification#response_object).
They refuse redirects and non-JSON responses, cap streamed bodies at 4 MiB,
and bound the complete request (including body reads) to 30 seconds for the
gate or 20 seconds for operations. Protocol/transport failures remain UNKNOWN
in the monitor; explicit execution-revert errors remain CRIT. For a storage
log scan exceeding the response bound, reduce `--log-range` and retry.

## Monitor

Read-only: it holds no key and its RPC client refuses any method outside a read list. Run it against your own settled RPC.

```
node scripts/ops/dex-monitor.mjs --config deployments/mainnet/finality-gate.mainnet.json --safe-plan deployments/mainnet/700770/safe.plan.json --bridge-plan deployments/mainnet/busdc.plan.json --bridge-record deployments/mainnet/busdc.record.json --rpc http://127.0.0.1:18955 --expect-seeded --lp-recipient TBD-owner --keeper-state /var/lib/bloch-dex-keeper/state.json
```

Exit status is the L2 monitor's: 0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN. UNKNOWN means the node did not answer; it says nothing about the chain. `--json` prints the same checks for a pipeline. The monitor does not send alerts. The example unit writes its `--json` report to `/var/lib/bloch-dex-monitor/report.json`, and the L2 monitor (bloch-l2-evm `deployment/mainnet/l2_monitor.py --report dex=/var/lib/bloch-dex-monitor/report.json:900`) alerts on every WARN and CRIT check in it through its own `alert.json` (webhook, Telegram, `alert_command`, dead-man `heartbeat_url`) with one deduplication. A report older than 15 minutes is WARN there and 45 minutes CRIT: that is how a dead DEX monitor, a stopped timer or a node that stopped answering (UNKNOWN leaves an empty file) is noticed. Before agent 105's change the unit had no `OnFailure=` and no `--keeper-state`, so a CRIT only failed a unit nobody watched and `keeper_budget` was never checked.

| Check | Reads at | WARN | CRIT |
|---|---|---|---|
| `rpc_identity` | | | wrong chain ID or genesis |
| `l2_head_age` | latest | 25 min | 45 min |
| `l2_finalized_age` | finalized | 150 min | 240 min, or no finalized block |
| `finality_gate` | finalized | | the gate refuses. On mainnet this is `evaluateMainnetGate`, the code that opened the gate, with the bUSDC bridge plan and record (`--bridge-plan`, `--bridge-record`): a change of the token's signers, guardians, thresholds or T is CRIT |
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
| Floor at the k ceiling, in wei of the wrapped token at the pool price | `--ceiling-floor-wei` | `--budget-wei` / `--max-tx` = 0.00104 BLCH |
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

State is written before publishing. A crash after that leaves a `pending` entry; the next run reconciles it by receipt, then by nonce, then by timeout. A transaction whose fate is unknown keeps its reservation until it leaves the 24 h window. A receipt stays pending until both `latest` and `finalized` reach its block. Before reducing the reservation to actual gas spent, the keeper verifies the receipt's transaction hash, sender, pair, status, gas accounting and canonical inclusion, then rechecks the finalized checkpoint. Missing finality retains the reservation; inconsistent receipt data reports `rpc-failed` without releasing it.

A publication timeout, HTTP failure, malformed response, different result hash,
or generic JSON-RPC error reports `publish-unconfirmed` and keeps that same
reservation. Errors such as `nonce too low` or `already known` do not establish
that the transaction was rejected before publication. The keeper waits for
reconciliation instead of treating those errors as zero spend.

An optional L2 admission preflight can return error code `-32000` with
`data.kind = "sequencer-fee-underpriced"` before writing the transaction to its
spool. The keeper accepts that as `publish-refused` only when the correlated
response identifies its exact signed transaction and contains consistent fee,
gas, storage-slot and head fields. It reports `feeRequirement` using decimal
integer strings; fee fields are wei per gas, and `freshSlotPriceWei` is wei per
new storage slot. Review `requiredPriorityFeePerGas` and `requiredMaxFeePerGas`
against the existing fee ceiling and budget before signing again. The keeper
does not raise its limits or retry publication in response to the quote. The
quote applies to `latest-state-next-block` at the reported head; changed state
or policy can change it, and inclusion is not guaranteed. Future nonces are not
simulated by this preflight and can remain pending.

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

The keeper sends what it skims to the Safe, so at the ceiling the fee that used to be the LPs' goes to the Safe or to a faster skimmer.

**Ceiling-fee behaviour is accepted for launch** (owner decision DEX-4, round 10): no contract change before deploy, and the behaviour is an explicit item for the external audit (DEX-8), with the candidate fix "send the clamped amount to `feeTo` inside `swap`". Restricting `skim` would not help: a `swap` that sends nothing claims the excess as its own input (agent 177, section 3).

### The ceiling floor (round 10)

At the ceiling the keeper uses a second, lower floor so that the Safe, not a bot, collects ordinary swap fees. It applies only while `isAtKCeiling` holds for the pair (k within one reserve unit of 64% of `cap0 * cap1`), and only to pairs with the wrapped token, because the excess of both sides is valued in wrapped wei at the pool's own reserves. Everywhere else the 100 bps floor, and the soft and hard closure rules built on it, are unchanged.

**The value: `--budget-wei / --max-tx`, 0.05 BLCH / 48 = 0.00104 BLCH (about $0.10 at P = 100).** It is the lowest floor at which every skim returns at least its share of the daily budget, so the Safe never pays more gas than it collects even if the keeper skims at every chance:

| | Per skim | Per day, at the 36 skims a ceiling may use |
|---|---:|---:|
| Value collected, at least | 0.00104 BLCH | 0.0375 BLCH |
| Gas paid, typical: 77,000 gas x (1 gwei base + 1-2 gwei tip) | 0.00015-0.00023 BLCH | 0.006-0.008 BLCH |
| Gas paid, worst the limits allow: 95,000 gas x (1 gwei + 8 gwei top tip) | 0.00086 BLCH | 0.031 BLCH |
| Reserved before signing: 1.2 x the estimate x `maxFee` (at most `2 x base + tip`, 20 gwei ceiling) | up to 0.0011 BLCH | stays under the 0.05 BLCH budget, which the keeper enforces |

- In bps of the caps: about 1 bps of the 10 WBLCH cap, and of the bUSDC cap for P from 50 to 100 (`min(1000, 10P)` bUSDC); about 2 bps of it at P = 200. The ordinary floor is 100 bps.
- Ceiling skims are kind `ceiling` in the state file. They keep the cooldown and the backoff, and they cannot use the quarter of the count kept for a hard closure, so at most 36 a day.
- A griefer who donates 0.00104 BLCH at the ceiling to make the keeper spend gas gives that donation to the Safe, or wins a race and sends the keeper into backoff. Either way the count and budget hold, as before.

**Who collects the fees at the ceiling.** A deterministic model (`scripts/ops/dex-ceiling-capture-model.mjs`, agent 196): P = 100, one L2 block every 10 minutes, ordinary router swaps of $8.73 on average (177's flow), 30 days. Arbitrage is left out: at the ceiling an arbitrageur does swap plus skim in one transaction and refunds its own fee (177, section 4), so **no keeper or bot collects arbitrage fees**, at any floor.

| Daily volume at the ceiling | Competitor | Safe, floor 1% (before) | Safe, ceiling floor (now) | Keeper gas, now, per 30 days |
|---|---|---:|---:|---:|
| $1,000 | none | 89% | 100% | $14.56 |
| $1,000 | a bot that skims from $1 at a 1 gwei tip | 0% | 100% | $14.56 |
| $5,000 | none | 98% | 99% | $20.86 |
| $5,000 | a bot that skims from $1 at a 1 gwei tip | 0% | 78% | $20.76 |
| $5,000 | a bot that skims from its own gas cost ($0.015) at 1 gwei | 0% | 27% | $19.92 |
| $5,000 | the same bot at a 3 gwei tip | 0% | 4% | $13.87 |
| $5,000 | a bot that always tips above 8 gwei | 0% | 0% | $5.31 |
| $20,000 | a bot that skims from $1 at a 1 gwei tip | 0% | 75% | $20.86 |
| $20,000 | a bot that skims from its own gas cost at 1 gwei | 0% | 25% | $20.86 |

- With no bot the old floor also reached the Safe, only later. The gain is against bots whose threshold lies between the two floors: from 0% to 75-100%.
- A bot that skims every block from its own gas cost still takes about three quarters, because the keeper may act only every 30 minutes (one block in three). A bot that outbids the keeper's tip takes everything. Lowering the floor further cannot change either: below 0.00104 BLCH a skim at the worst-case cost no longer pays for itself, and the cooldown and count are the RC budget.
- Collecting more would need the keeper to act every block or outbid bots (more budget), or the contract fix above.

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
