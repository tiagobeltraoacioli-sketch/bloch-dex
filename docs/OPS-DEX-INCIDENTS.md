# DEX incident runbook

The DEX has no admin: nobody can pause it, move funds or change a cap. An incident response consists of informing users, moving our own positions, and running the keeper. For the L2 itself, use `MAINNET-OPS-RUNBOOK.md` in `bloch-l2-evm`; this document covers only the effects on the pool. For the bridge, use the bridge's guardian runbook.

First step, always:

```
node scripts/ops/dex-monitor.mjs --config deployments/mainnet/finality-gate.mainnet.json --safe-plan deployments/mainnet/700770/safe.plan.json --rpc http://127.0.0.1:18955 --expect-seeded --lp-recipient TBD-owner
```

If it exits 3, your node is the problem. Try the other backend before concluding anything about the chain.

## Choosing the incident

| Monitor shows | Incident |
|---|---|
| `l2_head_age` WARN/CRIT | L2 stall |
| `l2_finalized_age` WARN/CRIT, head fresh | Finality lag |
| `bridge_token` WARN | bUSDC pause |
| `reference_price` or `price_drift` CRIT, `reserve_cap` at the bUSDC cap | bUSDC depeg or counterfeit |
| `pending_excess` blocking | DEX-02, see `OPS-DEX-MONITOR-KEEPER.md` |
| `safe_pinned`, `contract_code` or `finality_gate` CRIT | Identity failure, below |
| `lp_in_pair` CRIT | Stranded LP shares, below |

## L2 stall

**What it means.** `latest` has stopped. Usual cause: the prover, settler or L1 acceptance.

**Effect on the pool.** Nothing moves and no funds are at risk. Signed transactions wait in the spool. A swap whose deadline passes during the stall reverts when included, costing gas but executing nothing; `amountOutMin` stays in force. The default UI deadline is 60 minutes.

**Do:**
- Fix the L2 through its runbook.
- Show a banner in the UI: transactions are waiting, and may fail by deadline.
- Let the keeper run. It waits on its transaction in flight and counts an expired one against the budget.

**Do not:** resend transactions with a higher fee as a remedy, sign Safe transactions, or seed.

**On recovery.**
- The first blocks carry the backlog against a stale price. Reserves will jump to a new market price through arbitrage, and LPs bear that as ordinary loss versus rebalancing. This is not a fault.
- Expect `price_drift` WARN until `finalized` catches up.
- Safe signatures past their deadline must be planned and signed again.
- Time-based logic uses wall-clock block timestamps, so block timestamps jump after a stall. Deadlines work correctly; nothing in the kit uses TWAP.

## Finality lag

**What it means.** `latest` advances; `finalized` does not. L1 FFG has stalled, or the follower is behind. Normal `l2_finalized_age` is 100–130 minutes. Check L1 first (`l1_finality_lag` in the L2 monitor): if L1 finalizes and only our follower lags, it is ours to fix. The other backend tells you which.

**Effect on the pool.**
- Trading continues on `safe`/`latest` blocks, and nothing stops it.
- The UI reads balances and caps at `finalized` and compares with `latest`, so its display grows stale while the "quote worsened, reconfirm" prompt grows more frequent. That is the designed behaviour.
- What finality protects is not yet protected: a deep L1 reorg could undo recent blocks. A trader's own signed transaction could be re-executed at a different state, bounded by `amountOutMin` and `deadline`.
- Bridge withdrawals and exchange credits wait for `finalized`, so inflow and outflow slow down. Pool price may separate from the market.
- `pending_excess[finalized]` and `fee_accrued` freeze with it. Read the `latest` lines. A CRIT at finalized may be old news.
- The gate keeps passing during a lag, because it asks only that the deployment be finalized. A passing gate is not evidence of fresh finality; `l2_finalized_age` is.

**Do:**
- Beyond the 240-minute CRIT, show a banner: recent trades are not final.
- Keep the keeper on. A skim at `latest` is harmless if undone.

**Do not:** seed, add our own liquidity, or redeem the fee until finality returns. Do not count anything as received.

**On recovery.** Confirm that `finalized` moved and that the block hash we saw at `latest` before the lag is the one finalized. If a reorg did happen, compare the Safe's nonce and the keeper's state with the chain, because the keeper's `pending` entries may have vanished. It resolves them by timeout.

## bUSDC pause

**What it means.** A guardian called `pause()` on the token. Duration is fixed at deployment (72 h planned); a new pause needs a cooldown after the last one. On the launch token, `BridgedStablecoinV3`, ending it early takes `switchThreshold` signatures (6 of 7), more than a mint (5 of 7); after the one-way verifier switch nobody can end it early, and each of the 3 guardians can renew it once per chain, so inflow can stop for up to 9 days. A guardian cannot move funds. The bridge guardian may have paused the Ethereum vault as well; check that separately, because it changes the analysis below.

**Effect on the pool, tested on anvil with the real `BridgedStablecoinV2` and `BridgedStablecoinV3`.** A pause stops only `mint`, `remint`, `mintWithProof`, `executeMint` and V3's `drain`; queued mints wait and credit after it:

| Operation while paused | Result |
|---|---|
| bUSDC `mint` | Reverts |
| `swap` both ways | Works |
| bUSDC `transfer` | Works |
| bUSDC `burn` (asking to exit to Ethereum) | Works |
| `removeLiquidity` | Works |
| `skim` | Works |

The pool is not frozen. What changes is arbitrage:
- No new bUSDC arrives, so nobody can bring outside dollars to buy BLCH cheap. Selling BLCH for bUSDC still works, using the existing supply.
- If the **vault** is also paused, a burn is only a claim released after the pause. bUSDC can then trade below a dollar, which shows up as a higher BLCH price in the pool.

**Do:**
- Find out why from the guardian's record. A pause with no finding behind it may be a misused guardian key: at worst it delays mints.
- Show a banner: deposits paused; the price may diverge from the market. Say whether withdrawals are paused too.
- Supply `--ref-price` to the monitor, so divergence is measured.

**Do not:** treat the pause itself as a reason to withdraw our liquidity. If it comes with a finding of unbacked mints, go to the depeg section.

## bUSDC V3: queued, cancelled and held mints, held exits, the switch

The launch token is `BridgedStablecoinV3` with T = 0: every mint queues for 12 h, mints credit in deposit-nonce order, and each credit extends a mint chain that every burn states and the Ethereum vault checks. None of this touches `transfer` or `transferFrom`, which have no pause, hook or block list, so **the pair and the router behave as with any ERC-20, and an LP can always leave the pool**. Measured on anvil and the private L2 by `rehearse-ops.sh` section 10 (`agents/139-dex-v3-token.md`):

| Token state | Pool, router, keeper, monitor |
|---|---|
| A mint queued with the pair as recipient | Nothing moves until it credits. Then it is excess: the monitor reports `pending_excess`, the keeper skims it to the Safe like any donation. A user who bridges to the pair address loses the deposit to the Safe |
| A queued mint cancelled by the guardians | The pair never sees it. Later deposits wait behind the freed slot (`executeMint` reverts `NotReady`) until a remint or the real deposit fills it, so new bUSDC stops arriving while swaps and exits go on |
| Paused with mints due | `executeMint` and `drain` hold; swaps, LP exits, transfers, burns and skims work |
| Mint chain | Swaps, donations, skims and LP exits do not change `mintHead`, `mintCount` or `mintedTotal`; only credits do. A burn of LP proceeds states the same chain as any other burn |
| A forged mint that credited (committee keys misused and no guardian cancel within 12 h) | Every burn made after it states a chain no real deposit matches, so the vault holds it: **all bUSDC exits are held, including bUSDC an LP takes out of the pool**. The forger can sell into the pool only up to the bUSDC cap; at a seed of half the cap this took half of the WBLCH side (5.08 to 2.55 WBLCH) |
| After the one-way switch | Committee `mint` and `unpause` revert `CommitteeRetired`. Mints queued before the switch and `mintWithProof` mints still credit (a proof mint cannot be cancelled). A pause runs its full term |

The monitor's `bridge_token` line on V3 shows the slots opened and not credited, the pending supply, the credited count, and whether the verifier is active. Since agent 144 the monitor's `bridge_exit[bUSDC]` line reads the vault too (held = CRIT, paused = WARN) and the DEX page shows a held or paused banner, an LP notice on the bUSDC pool and an acknowledgement before a swap into bUSDC. Without `--eth-rpc`/`--bridge-vault` it still cannot see the vault: **held exits are then visible only on Ethereum** (vault pause, `ProvenanceMismatch`, the bridge's `reservas` exit 2 "held"). Watch those with the bridge's guardian tools and treat a hold as the depeg section below: bUSDC is then a claim whose payout waits, and the pool will price it as a dollar until someone sells it in.

**Do:**
- On a hold or a forged credit: the depeg steps below. Moving our own liquidity out works, but the bUSDC we receive is held like everyone's.
- On a cancel: tell users that deposits after the cancelled one wait for its remint; nothing to do on the DEX.
- After the switch: nothing changes for the DEX; note in the incident text that a pause cannot be ended early.

**Do not:** execute a queued mint from the first depositor's key before the seed. Any transaction from that key spends it (`OPS-INITIAL-LIQUIDITY.md`, L1); leave execution to the relayer or another account.

## bUSDC depeg or counterfeit

**What it means.** bUSDC is worth less than a dollar: the vault is short, the signers were compromised, or USDC itself depegged. The pool has no price source and will quote bUSDC at par until it is sold into.

**Effect on the pool.** Arbitrage sells bUSDC into the pool for WBLCH until the bUSDC reserve hits its cap. Then inflow on that side reverts. This cap is the only limit.

The WBLCH side falls to `R * Rq / cap`. Measured from about 5.05 WBLCH + 128 bUSDC, a dump to 1,000 bUSDC left 0.65 WBLCH: **87% of the WBLCH side lost**, within one transaction. The limit is the seed, not 50%; see the table in `OPS-INITIAL-LIQUIDITY.md`. The monitor flags this at `latest` right away (`reference_price` and `price_drift` CRIT, `reserve_cap` WARN), but it cannot stop it. The first dump may land in the same block as the news.

LPs can still exit in full, tested: `removeLiquidity` works with the side at its cap. They receive whatever the pool holds by then.

A counterfeit mint is itself limited by the token bucket and the supply cap, and large mints are delayed. Those are separate brakes on the bridge's side.

**Do, in this order:**
1. If it can be ahead of the dump, remove our LP position now. Every block counts, and an LP burn takes pro rata whatever is left.
2. Ask guardians to pause mints if that has not happened.
3. Show a banner: stop buying WBLCH with or holding bUSDC. Disable the pair in the UI through a reviewed frontend change. The contracts cannot be stopped, and users can still call them directly.
4. Redeem the Safe's fee position only for the WBLCH side's sake. It comes out pro rata, and it takes 3 of 5 signatures, so it will not be ahead of a dump. Do not rush it at the cost of checking what is signed.
5. Keep the keeper on: a donation of worthless tokens to the Safe does no harm, and a stuck side is worse. Do not accept the skimmed bUSDC as value in the books.
6. Recovery is a decision outside this runbook. If the token is abandoned, a new bUSDC requires a new factory, because caps are fixed by token address.

**Do not:** add liquidity to defend the price.

If USDC itself depegged while the bridge is sound, bUSDC tracks USDC: the pool repricing is correct, and there is nothing to do but inform users.

## Identity failure

`safe_pinned`, `contract_code` or `finality_gate` CRIT with `rpc_identity` OK.

1. Compare with the other backend and a public RPC. If only one disagrees, that node is bad; take it out of the gateway.
2. If `safe_pinned` differs everywhere: owners, threshold, guard or module changed. That took 3 of 5 signatures. Treat it as a key compromise until every owner has confirmed. Do not sign anything. The fee recipient is immutable, so the fee follows the Safe.
3. Contract code cannot change on this chain. A difference on every node means a chain-level fault: stop the UI and escalate to the L2 runbook.

## Stranded LP shares

`lp_in_pair` CRIT: shares sit in the pair. Anyone can burn them to themselves, and the first caller wins. If they are ours, call `burn(<our address>)` at once. Usually the cause is a user's bad transfer, or a redemption done the unsafe way (`OPS-FEE-REDEMPTION.md`). The next `burn` by anyone, including the router's, also pays those shares out to that caller.

## What was tested and what was not

Tested on a private anvil chain by `scripts/ops/rehearse-ops.sh`: the pause table (V2 and V3), the V3 table above, the depeg dump, Safe threshold drift, pair code drift and a dead node. Stale head and finalized thresholds are unit tests with a fake node, because anvil cannot age a head against the wall clock. **No L1 stall, real finality lag or real L1 reorg was run.** The private L2 run uses synthetic finality.
