# Liquidity on the multichain page

Round 20 (2026-11-18). What the page does when a user adds or removes liquidity on a public chain, and where
each rule comes from. The contracts are unchanged (`docs/MULTICHAIN-DEPLOY.md` section 1); this document is about
`frontend/` only.

## What is offered, and what never is

- The Pools and Portfolio screens and the liquidity dialog exist on a route that is live: a bundled record that
  says "deployed", verified against the chain at the page's pinned block. On any other route there are no
  screens and no request is made.
- A pool is offered when the record lists its pair. The record lists a pair only when the post gate proved its
  opening (`scripts/multichain/frontend-files.mjs`).
- **The page never builds a first deposit.** Only the factory's `firstDepositor` can open a pool
  (`UniswapV2Pair.mint`, `BDEX: FIRST_DEPOSITOR`). A planned pair without a pool in the record is shown as one
  line ("Not open yet. Only the first depositor fixed in the factory can open a pool, so this page builds no first
  deposit for anyone.") with no button; a recorded pair found without shares on the chain is treated the same way;
  the arithmetic refuses a pool without shares (`NOT_OPEN`); and the transaction builder refuses a pair the record
  does not list.

## Where the figures come from

Every figure is computed in integer base units by `frontend/src/mainnet/liquidity.ts` from state read at the
page's pinned block (the snapshot's block hash; on these chains two endpoints must give the same bytes,
section 9 of the deployment document):

| Figure | Source |
|---|---|
| The second amount of a deposit | `BDexLibrary.quote`: the typed amount times the pool's own ratio, rounded down |
| What the router takes | `BDexRouter._addLiquidity` in its own order: the token it names first ("A"; in the native entry point the token that is not the wrapped native one) keeps its desired amount when the other side's optimal amount fits. A deposit typed in the native coin therefore takes a few base units less of it than was typed; the router returns the rest in the same transaction |
| Minimums | each desired amount less the slippage tolerance, as `scripts/multichain/first-deposit.mjs add` sets them; a minimum that would round to zero is refused |
| Pool shares received | `UniswapV2Pair.mint`: the smaller of the two ratios against the supply AFTER the pending protocol-fee shares (`_mintFee`), counting every token at the pair above its reserves |
| What a removal pays | `UniswapV2Pair.burn`: pro rata of the pair's balances (reserves and anything above them) against the same supply |
| A position | the shares the account holds, their part of that supply, and what a removal of all of them would pay at that block |
| Deadline | the network file's `swap.deadlineMinutes` (the user can set 10 to 180), from the later of the device clock and the latest block, as for a swap |

Before the wallet is asked for the deposit or the removal, the same call is evaluated on the latest block (a read
the RPC layer pins to a block two endpoints agree on). A refusal there stops the request and nothing is sent. When
that read fails the request goes on with a note: the signed minimums still apply on chain. A figure on a snapshot
older than the page's age bound (four minutes) is never signed: the page reads a newer block and asks the user to
press again.

## The wallet steps

One explicit step at a time, each through the route's one tracker (`mainnet/pendingswap.ts`), in the order of
checks of the swap card (`mainnet/submit.ts`):

1. approve, for the router, of exactly the token amount of the deposit, or of exactly the pool shares of the
   removal (`mainnet/approval.ts` decides the sequence per token; the pair's `permit` is not used);
2. the deposit (`addLiquidity`, or the router's native entry point with the native amount as value) or the removal
   (`removeLiquidity`, or the native one), with the minimums, the user's own address as recipient, the deadline
   and an explicit gas limit of 400,000 (measured in the fork rehearsal: 221,643 and 227,997 for a deposit,
   205,058 to 209,237 for a removal).

A deposit or removal is held like a swap: it is never asked of the wallet a second time, its hold ends on its own
verified receipt or once its deadline has passed at the chain's strict block, and after a REVERTED receipt the
account is free only by the chain's rule for reverted requests (section 9 of the deployment document).

## Refusals

| Contract refusal | Said before anything is sent | Said after a revert |
|---|---|---|
| `BDEX: FIRST_DEPOSITOR` (a pool nobody opened) | never reachable: no first deposit is built | not applicable |
| `BDEX: INSUFFICIENT_AMOUNT` (the ratio asks zero of the other token) | yes | yes |
| `BDEX: INSUFFICIENT_A_AMOUNT`, `INSUFFICIENT_B_AMOUNT` (the ratio moved beyond the tolerance) | at the latest block, right before the wallet | yes, from the reserves at the start and at the end of the transaction's block |
| `BDEX: INSUFFICIENT_LIQUIDITY_MINTED`, `INSUFFICIENT_LIQUIDITY_BURNED` | yes | yes |
| `BDEX: RESERVE_CAP`, `BDEX: K_CEILING` (a factory with caps; none of the six public chains has any) | yes | yes |
| `BDEX: OVERFLOW` (a balance above uint112) | yes | yes |
| `BDEX: EXPIRED` | not predictable | yes, from the block's timestamp |
| `BDEX: TRANSFER_FROM_FAILED`, or a token's own refusal | a balance below the amount: yes. An issuer's pause or block: no | a short balance or approval: yes. An issuer's refusal: the page says it could not tell and that a token may have refused the transfer |
| The pool-share transfer of a removal (shares or their approval short) | yes (more than the account holds cannot be chosen) | yes |
| `BDEX: LOCKED`, `BDEX: INVALID_TO` | not reachable from the page's calls (no re-entry, the recipient is the user's address) | not explained |

The reason of a revert is read once the tracker has verified the reverted receipt under the chain's rule, from
endpoints that may no longer serve that block's state; the page then says it could not tell.

## What a liquidity provider is told

On the Pools screen and in the dialog, next to the action and not behind a click: the position follows the pool's
price (divergence loss); a removal pays both tokens at the ratio of that moment; tokens sent straight to a pool's
address are a gift to the pool; the 0.30% fee, the protocol's sixth of its growth and the recipient's address from
the record; an issuer's powers, with the token list's own statement per token (the network file's `kind`).

## What the screens do not show

No price history, no 24-hour volume or fees, no value in a currency and no value history: the page reads one block
and has no reviewed price source. Activity lists only what this page sent from this account on this device.

## Not done / not proven

- No real wallet and no public chain: the proof is a simulated wallet over anvil forks
  (`frontend/integration/browser/liquidity.mjs`).
- Reserve caps and the k ceiling are covered by unit tests of the arithmetic only: no public chain of this package
  has caps.
- A token whose approve or transfer deviates (agent 409's USDT work) is not handled here beyond the seam in
  `mainnet/approval.ts`; a token with a transfer fee would make the predicted amounts wrong.
- The 400,000 gas limit was not measured on Arbitrum One (its L1 data charge is inside the limit; known issue of
  the swap path as well).
