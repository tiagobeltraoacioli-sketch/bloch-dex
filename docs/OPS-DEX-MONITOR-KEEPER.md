# DEX monitor and skim keeper

Tools: `scripts/ops/dex-monitor.mjs`, `scripts/ops/dex-skim-keeper.mjs`, example units in `scripts/ops/systemd/`.
Both read the schema-2 gate file written by `deploy-dex.mjs record`, so they have no second list of addresses. Node 24 and `frontend/node_modules` (for viem) are required.

## Monitor

Read-only: it holds no key and its RPC client refuses any method outside a read list. Run it against your own settled RPC.

```
node scripts/ops/dex-monitor.mjs --config deployments/mainnet/finality-gate.mainnet.json --safe-plan deployments/mainnet/700770/safe.plan.json --rpc http://127.0.0.1:18955 --expect-seeded --lp-recipient TBD-owner
```

Exit status is the L2 monitor's: 0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN. UNKNOWN means the node did not answer; it says nothing about the chain. `--json` prints the same checks for a pipeline. The monitor does not send alerts: use `OnFailure=` on the unit (WARN is a success status in the example unit, CRIT and UNKNOWN fail it) or feed `--json` to your alerting.

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
| `price_drift` | both | 10% between finalized and latest | 50% |
| `fee_accrued` | finalized | | facts only: minted LP, pending LP, reserve share |
| `fee_tracking` | finalized | | `kLast` is zero on a seeded pair |
| `safe_allowance` | finalized | the Safe still has an LP allowance to the router | |
| `lp_in_pair` | latest | | LP shares sit in the pair; anyone can burn them to themselves |
| `bridge_token` | latest | mints paused | |
| `reference_price` | latest | 5% from `--ref-price` | 15% |

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
| Budget, rolling 24 h, worst case reserved before signing | `--budget-wei` | 0.01 BLCH |
| Transactions per 24 h | `--max-tx` | 8 |
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
| Repeated material donations | Each one is sent to the Safe. At most 8 keeper transactions a day, and the budget holds | The floor or more per transaction, forfeited |
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

Unrecorded balance can stop ordinary swaps both ways until someone calls `skim`. It takes about 2 WBLCH + 200 bUSDC from a pool at the ceiling, which go to whoever skims.

- The monitor reports `closed_by_excess` as CRIT at latest and at finalized. It means a swap of 0.1% of a cap reverts both ways. A much larger swap can still pass if its output pays the excess down. One side above its cap can be enough, and a small donation can do it when that side's reserve is already at its cap, so this check does not use the dust floor.
- The keeper treats this pair first, and skips its backoff and cooldown. It keeps the budget, the transaction count, the fee ceiling and the simulation.
- **A griefer can race the keeper.** If its own skim lands first, it gets the donation back and the pair reopens, and the keeper pays for one wasted skim. Repeating this spends the griefer's gas and the keeper's budget, at most `--max-tx` transactions per 24 h. When the budget is gone the keeper stops (`budget-exhausted`, exit 1), and the pair stays closed until anyone skims. Rehearsed on anvil only, with one race; ordering on the L2 is not tested.
