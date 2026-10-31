# DEX-05 decision: anchored swaps are off by default

**Decision.** The UI sends plain exact-in swaps at launch, as it does today. The router's `...Anchored` functions stay in the deployed code for anyone who calls them directly. The UI gets no anchored path. Revisit only on the triggers below.

## What was measured

Real router and real v2 `bloch-l2-settled-rpc` on a private L2 (synthetic finality, no L1), and anvil, by `scripts/ops/rehearse-ops.sh`.

| Question | Private L2 | Anvil |
|---|---|---|
| Is `BLOCKHASH` real? | Yes: committed 256-block ring (`src/state.rs`, `src/executor.rs`) | Yes |
| Anchor = head when signed, included in the next block | Succeeds | Succeeds |
| Wrong hash, future block | Reverts | Reverts |
| Outside the 256-block window | Reverts at head 261, anchor 2; succeeded at head 36 | Reverts |
| `eth_call` at `latest`, anchor = head | **Reverts `BDEX: ANCHOR`** | **Reverts** |
| `eth_estimateGas`, anchor = head | **Reverts** | Succeeds |
| `eth_call` at `pending`, anchor = head | Succeeds | Succeeds |
| `eth_call` and `eth_estimateGas` at `latest`, anchor = head − 1 | Succeeds | Succeeds |

## Reasoning

**Cadence is not the problem.** At 12–15 minutes per block, the window is 51–64 hours. The longest UI deadline, 180 minutes, is about 15 blocks. The window would matter only if blocks came faster than about every 42 seconds.

**The benefit is small on this chain.** Anchoring guards an order against replay on a fork the user never saw. Here there is one producer, block N+1 is built only after N is accepted at the L1 head, and `safe` and `finalized` do not regress. Only an L1 reorg or a producer rollback could replace the head. On such a fork, `amountOutMin` and `deadline` already bound what the user can lose, and the nonce already prevents double execution. What remains is a trade inside the user's slippage on a chain they did not see. That has little value.

**It covers only part of the surface.** Only exact-in swaps have variants. Exact-out swaps and liquidity operations do not, so the UI could not describe the protection simply.

**The costs are concrete.**
- A wallet estimating gas on the settled RPC fails with anchor = head, which is the anchor a UI would naturally pick. It looks to the user like a broken swap. The workaround, head − 1, relies on behaviour that differs between nodes (anvil and the settled RPC disagree above).
- With two RPC backends, a client can read the head from one and estimate on the other, which is behind. That gives the same false revert, even with the head − 1 workaround, whenever backends differ by more than a block.
- A reorg turns a fine trade into a revert that costs gas and needs a new signature, with a 12–15 minute wait each try.
- It would add untested paths to wallets and to the external audit's review, for little gain.

## If it is ever turned on

Anchor to `safe`, not `latest` or `finalized`. An anchor at `finalized` can never fail, so it protects nothing. An anchor at `latest` fails simulations as shown. `safe` is accepted at the L1 head and reverts only on the L1 reorg that the anchor exists to catch. Simulate at the `pending` tag, and keep the deadline well under the window.

## Triggers to revisit

- Blocks faster than about one a minute, or preconfirmations ahead of L1 acceptance.
- More than one block producer.
- An observed L2 reorg of a block that users traded on.
