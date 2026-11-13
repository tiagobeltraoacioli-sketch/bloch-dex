# Manual real-wallet test of the swap, approval and recovery flows

Run this before the DEX page is opened to the public. It is the only test of the page with a real wallet: the unit
tests use jsdom, and the browser harness (`frontend/integration/browser/`, see `frontend/integration/README.md`) uses a
real browser engine with a **simulated** wallet. The last column of each test says what the harness already showed and
what only this script can show.

The answers this script must produce, because no automated test can:

1. Does the wallet use the `nonce` the page sends in `eth_sendTransaction`, or its own? (tests 2 and 9)
2. Does the wallet return a transaction hash only after it published the transaction? (test 2)
3. What does the page receive when the wallet's node refuses a fee: the structured `error.data`, or text only? (test 8)
4. Do the wallet's own "Speed up" and "Cancel" produce transactions the page can recover? (tests 4 and 5)

## Scope

| Wallet | How it reaches the page | Tested here |
|---|---|---|
| MetaMask extension, desktop Chrome | injected, EIP-6963 | all tests |
| MetaMask Mobile, in-app browser | injected | tests 1 to 5, 7 and 10 |
| One WalletConnect wallet through the QR entry | WalletConnect | test 11 only |

The QR entry of this frontend is identity-only (`frontend/src/qr-wallet.ts`): its provider answers account and chain
and refuses everything else with "This DEX preview requests account access only. Transactions require a verified
deployment." A WalletConnect wallet therefore cannot approve or swap on this page. Test 11 confirms that.

## Before you start

| Item | Value to record |
|---|---|
| Page URL under test and its build revision (shown in "Verified deployment record") | |
| L2 RPC URL shown in the "Network" card | |
| Wallet name and version | |
| Browser and version, or phone model and OS | |
| Test account address (a fresh account with no history on this chain) | |
| Date and time (UTC) | |

Requirements:

- The DEX is deployed and the page shows "Pools at finalized block N" (not "Not yet live").
- The test account holds about 1 BLCH and 30 bUSDC. Use small amounts: every test below moves at most 0.01 BLCH or 10 bUSDC.
- In MetaMask, turn on Settings, Advanced, "Customize transaction nonce". It makes the nonce visible in every prompt.
- A block explorer or `cast` to read transactions. With `cast`, set the RPC once:

```
export ETH_RPC_URL=<the L2 RPC URL of the Network card>
```

- Time. An L2 block takes 12 to 15 minutes and finality about 100 minutes. A test that says "wait for finality" takes
  that long. Run tests 1, 6 and 7 first; the others can run on separate fresh accounts in parallel.

After every test, record the account's mined transactions:

```
cast nonce <account> --block latest
```

```
cast nonce <account> --block pending
```

A test passes only when the page text matches **and** the number of router calls mined for the account is the number
the test states. Count router calls in the explorer (transactions from the account to the Router address of the
"Verified deployment record" card with status success).

## Test 1: one swap

1. Open the page URL and go to "Mainnet".
2. Click "Connect MetaMask" and approve the connection in the wallet.
3. If the Network card shows "Add or switch to Bloch L2", click it and approve in the wallet. It must then show "Wallet is on chain 700770".
4. In the Swap card choose "You pay" BLCH and "You receive" bUSDC.
5. Type `0.01` in "Amount".
6. Click "Get quote".
7. Click "Swap".
8. In the wallet prompt, write down the nonce and the fees shown. Do not change them.
9. Confirm in the wallet.
10. Read the "Transactions" list on the page.
11. Wait for finality.

Expected: at step 7 the list shows "Swap 0.01 BLCH for bUSDC: waiting Confirm in your wallet." After step 9 it shows
"Swap 0.01 BLCH for bUSDC: pending" with the hash and "Waiting for the next L2 block and canonical finality. Do not
resend with a new nonce; Swap stays disabled until the outcome is known." The "Swap" button is disabled. After
finality: "Swap 0.01 BLCH for bUSDC: mined" and "Mined in block N; verified canonical and finalized."

Router calls mined: 1. Harness: `normal-send`. Real wallet only: the prompt content, the fees the wallet chose.

## Test 2: does the wallet use the page's nonce, and when does it return the hash

1. Repeat test 1, steps 4 to 7, with amount `0.01`.
2. In the wallet prompt, read the nonce.
3. Run `cast nonce <account> --block latest` and compare.
4. Confirm in the wallet.
5. At the moment the page shows the hash, run:

```
cast tx <hash>
```

Expected and what to record:

| Observation | Record |
|---|---|
| Nonce in the prompt equals `cast nonce … latest` | yes / no |
| `cast tx <hash>` finds the transaction as soon as the page shows the hash (the wallet published before answering) | yes / no |
| `nonce` field of `cast tx <hash>` | |

Router calls mined after finality: 1. Harness: `wallet-ignores-site-fields`. Real wallet only: all three rows.

If the wallet's nonce differs from the canonical one because the wallet remembers older transactions, clear it first
(MetaMask: Settings, Advanced, "Clear activity tab data") and repeat.

## Test 3: a second swap while the first is queued

1. Start a swap as in test 1 and confirm it in the wallet.
2. Before the next L2 block, change "Amount" to `0.02`.
3. Click "Get quote".
4. Try to click "Swap".
5. Reload the page (browser reload).
6. Click "Connect MetaMask".
7. Get a quote for `0.01` again and try to click "Swap".
8. Open a second tab with the same URL, connect, get a quote, try to click "Swap".
9. Wait for finality.

Expected: "Swap" is disabled at steps 4, 7 and 8. The hold text of test 1 is shown after the reload and in the second
tab. No section "Review the original request in your wallet" is offered, because the wallet returned a hash. The
wallet shows exactly one transaction.

Router calls mined: 1. Harness: `queued-at-sequencer`, `two-tabs`. Real wallet only: that the wallet prompt does not
reappear after a reload.

## Test 4: speed up in the wallet

1. Start a swap as in test 1 and confirm it.
2. In the wallet's activity list, open the pending transaction.
3. Click "Speed up" and confirm.
4. Copy the hash of the sped-up transaction from the wallet activity.
5. Wait until that transaction is mined (wallet shows it confirmed).
6. On the page, paste the hash into "Transaction hash from wallet activity".
7. Click "Check transaction hash".
8. Wait for finality.

Expected: before step 6 the page still shows the first hash as pending and "Swap" disabled; it must not show "mined"
or "failed" for the first hash. After step 7: "The transaction matches the saved intent. Waiting for its canonical
finalized receipt." After finality: "Swap 0.01 BLCH for bUSDC: mined" with the sped-up hash.

Router calls mined: 1. The first hash has no receipt. Harness: `speed-up`. Real wallet only: that MetaMask's speed-up
keeps the call, the value and the nonce (if it did not, step 7 answers "This hash does not match the saved sender,
destination, call, value and chain at the saved nonce or a later one. The submission hold remains."; record that).

## Test 5: cancel in the wallet

1. Start a swap as in test 1 and confirm it.
2. In the wallet's activity list, open the pending transaction.
3. Click "Cancel" and confirm.
4. Copy the hash of the cancellation from the wallet activity.
5. Paste it into "Transaction hash from wallet activity".
6. Click "Check cancellation or replacement".
7. Wait for finality of the cancellation.
8. Click "Check cancellation or replacement" again.
9. Click "Close local hold as replaced".
10. Get a new quote for `0.01` and click "Swap". Confirm in the wallet.
11. Wait for finality.

Expected: at step 6, before finality: "No canonical finalized replacement is available for that hash yet. The original
hold remains." At step 8: "Replacement verified. The original hold remains until you explicitly close it below." and
a "Verified replacement" box with the cancellation's hash; "Swap" is still disabled. After step 9: "Original swap
request: replaced" and "A different transaction consumed nonce N in canonical finalized block B. The original request
did not execute. Its local hold was explicitly closed; nothing new was sent." After step 11: the new swap is mined.

Router calls mined: 0 after step 9, 1 after step 11. Harness: `cancel`. Real wallet only: that the cancel wins the
race against the original; if the original swap is mined instead, the page shows it mined and step 8 answers that no
replacement exists. Record which one happened.

## Test 6: reject in the wallet

1. Get a quote for `0.01` and click "Swap".
2. Click "Reject" in the wallet prompt.
3. Get a quote again and click "Swap". Confirm in the wallet.
4. Wait for finality.

Expected: after step 2: "Swap 0.01 BLCH for bUSDC: failed The wallet request was rejected by you. Nothing was sent."
and "Swap" is available again after a new quote. After step 4: mined.

Router calls mined: 1. Harness: `rejected`. Real wallet only: that the wallet reports the rejection with code 4001;
if it does not, the page shows "Wallet submission outcome unknown: no transaction hash was returned." and keeps the
hold. Record which.

## Test 7: approve, then swap

1. Choose "You pay" bUSDC and "You receive" BLCH, amount `10`, click "Get quote".
2. Click "Approve 10 bUSDC".
3. In the wallet prompt, read the spending cap. Do not change it. Confirm.
4. While the approval is pending, try to click "Swap".
5. Wait for finality.
6. Click "Get quote" again.
7. Click "Swap" and confirm in the wallet.
8. Wait for finality.

Expected: the wallet shows a spending cap of exactly 10 bUSDC for the Router. "Swap" is disabled at step 4. After step
5: "Approve 10 bUSDC: mined". At step 6 no "Approve" button appears. After step 8: "Swap 10 bUSDC for BLCH: mined".

Transactions mined: 1 approval then 1 router call, consecutive nonces. Harness: `approve-then-swap`. Real wallet
only: the spending-cap prompt (a wallet lets the user edit it; a lower cap makes the swap revert, a higher one is the
user's choice), and the first-approval fee (test 8).

## Test 8: the first approval and the new-slot fee

This applies when the L2 RPC runs with its admission policy (`--required-tip-file`). A first `approve` writes a new
storage slot and needs a higher priority fee than the wallet's default. The page prices it before opening the wallet
(`frontend/src/mainnet/newslotfee.ts`) and suggests the fee to the wallet.

1. On a fresh account, do test 7 steps 1 to 3.
2. Before confirming, read the page under the step: it must say "This transaction creates 1 new storage slot on the L2, which the network charges through the priority fee. The page suggests N gwei to your wallet; keep the suggested fee, a lower one is refused by the network."
3. In the wallet prompt, open the fee details. Write down the priority fee and max fee shown, and whether the wallet labels them as suggested by the site.
4. Do not change the fee. Confirm.
5. Read the page.

Record which of these happened:

| Outcome | Page text | Verdict |
|---|---|---|
| Accepted at once, wallet fee equals the page's N gwei | "Approve 10 bUSDC: pending …" | Pass |
| Accepted, but the wallet showed its own lower fee | the same | Record it: the RPC ran without the admission price |
| Refused, data passed on by the wallet | "Wallet submission outcome unknown: no transaction hash was returned. …" followed by "RPC fee diagnostic (not bound to your wallet's signed transaction): at head N, required priority fee X wei/gas and max fee Y wei/gas. Submission outcome remains unknown; no retry or fee increase was performed." | The wallet ignored the suggested fee: continue at step 6 |
| Refused, data lost by the wallet | the same first sentence, with no "RPC fee diagnostic" | The same |

6. Only after a refusal: in the wallet settings, allow site-suggested fees if there is such a setting. On the page open "Review the original request in your wallet", click "Review same nonce in wallet".
7. In the wallet prompt check the nonce equals the "Nonce" shown on the page and the priority fee is the page's N gwei. If the wallet still shows its own fee, set priority fee and max fee by hand to the values of the diagnostic (Edit, Advanced), and record that this wallet needs a manual fee.
8. Confirm, wait for finality. Expected: "Approve 10 bUSDC: mined", exactly one approval mined.

Transactions mined: 1 approval. Harness: `first-approve-priced`, `first-swap-priced` (accepted at once by a node that
applies the RPC's rule from a state trace), `first-approve-wallet-ignores-fees` (refused once, then the review goes
through with the page's fee), `fee-refusal-with-data`, `fee-refusal-data-lost`. Real wallet only: whether the wallet
honours `maxPriorityFeePerGas` and `maxFeePerGas` from the site, what it shows, and what it passes on from a refusal.

**Only when the L2 serves the per-sender credit rule** (the user-transaction candidate; the launch RPC has no such
rule). A wallet that has not paid for an L2 transaction yet gets calls up to a gas limit of 1,500,000; the page asks
100,000 for an approval and 250,000 per hop, so its calls are taken. With such a wallet, while the wallet prompt of
step 1 is open, the page may add: "This wallet has not paid for an L2 transaction yet. If L2 blocks are full, its first
call can wait whatever fee it offers; one plain transfer first (to your own address is enough) with a priority fee of
at least N gwei avoids that." Record whether it appears. If a transaction is ever refused with "The L2 does not take
this transaction from a wallet that has not paid for an L2 transaction yet …", nothing was sent; the page must say
"A higher fee does not help" and must not suggest raising the fee. Harness (a model of the rule):
`credit-fresh-wallet-approve-then-swap`, `credit-fresh-wallet-first-swap`,
`credit-needs-credit-refused-then-transfer`, `credit-refusal-through-wallet`.

## Test 9: a swap whose wallet reply was lost: no second request, the hold ends at the deadline

Since round 15 (review R309-A1) the page never asks the wallet for a swap a second time: nothing it can read shows
whether the first request is still open or signed in the wallet, and many wallets ignore a requested nonce. The
same-nonce review exists for approvals and skims only (test 9b).

1. Set "Deadline (minutes)" to `5`. Get a quote for `0.01` and click "Swap".
2. Leave the wallet prompt open and reload the page.
3. Click "Connect MetaMask". The page shows "Wallet submission outcome unknown: no transaction hash was returned."
   and "The hold ends by itself once the swap deadline has passed in a finalized block."
4. Confirm that there is **no** "Review the original request in your wallet" section and that "Swap" is disabled.
5. Reject the open prompt in the wallet.
6. Wait until a finalized L2 block is past the deadline (the page needs no action).

Expected after step 6: "The swap deadline passed in canonical finalized block N, and no transaction of this account
used nonce M before it: sent from an ordinary wallet account this swap did not execute, and it can no longer execute.
If your wallet still shows the request, reject it there; signed now it would only revert. Nothing was sent." and
"Swap" is offered again. Before step 6, "Check cancellation or replacement" with the hash of any other transaction
of the account answers "This swap has no transaction hash from your wallet … The hold remains." (a swap without a
hash is never released by another transaction at its nonce).

Variant: at step 5 confirm in the wallet instead. The swap is mined; paste its hash from the wallet activity into
"Transaction hash from wallet activity" and click "Check transaction hash": mined, one router call.

Router calls mined: 0 (1 in the variant). Harness: `reply-lost-never-published-expires`,
`reply-lost-wallet-ignores-nonce-no-review`, `queued-reply-lost`.

Known limit, not a test (review R309-3P-5): the hold lives in this browser's storage only. Do not clear site data,
and do not use another browser or device for the same account, while a swap request is open in the wallet: the page
would accept a second swap, and the old request, confirmed later inside its deadline, would execute too.

On a quiet L2 (no block for more than 30 minutes) the page says "The L2 has made no block for N minutes: it is idle …
the swap is included in the block after it, in about 60 minutes", raises a shorter deadline to 75 minutes, and sends
the swap; a hold then ends at the first finalized block after the
deadline, which on a quiet chain can be up to 24 hours away (the heartbeat) unless anyone transacts.

## Test 9b: the same-nonce review of an approval

1. With an account that has no allowance, get a quote that needs an approval and click "Approve".
2. Leave the wallet prompt open, reload the page, connect again, and reject the open prompt in the wallet.
3. Open "Review the original request in your wallet" and compare the listed nonce with `cast nonce <account> --block latest`.
4. Click "Review same nonce in wallet". In the wallet prompt, read the nonce and record whether it is the listed one.
5. Confirm in the wallet and wait for finality.

Expected: "Wallet returned 0x…. All known candidates remain tracked until one is canonically finalized.", then mined.
If the wallet signed another nonce the page says so, at once or on a later poll ("Your wallet signed this request at
another nonce than the reviewed nonce N … Cancel it in your wallet if it has not been included."). A second copy of
an approval sets the same allowance again and costs only gas. Harness: `first-approve-wallet-ignores-fees`.

## Test 10: account, network and lock changes mid-flow

1. Start a swap as in test 1 and confirm it.
2. In the wallet, switch to another account.
3. Read the page: it must show the other account and no hold for it. Do not swap.
4. Switch back to the first account.
5. Read the page: the hold of test 1 is shown again and "Swap" is disabled.
6. In the wallet, switch to another network (for example Ethereum).
7. Read the page: "Wallet … on chain 1 (it will be asked to switch to chain 700770)".
8. Switch the wallet back to Bloch L2.
9. Lock the wallet.
10. Reload the page and click "Connect MetaMask"; unlock when asked.
11. Wait for finality.

Expected: the hold follows the account and survives every change; at no point does a wallet prompt appear that the
user did not click for. After finality: mined.

Router calls mined: 1. Harness: none of the account, network or lock changes (the simulated wallet has one account).
Real wallet only: this whole test.

## Test 11: WalletConnect is identity-only

1. Open the page on a desktop browser without an injected wallet.
2. Use the QR wallet button and pair a WalletConnect wallet.
3. Go to "Mainnet", get a quote for `0.01` and click "Swap".

Expected: no prompt reaches the wallet and nothing is signed. Record the exact page text. If the page keeps a hold
("Wallet submission outcome unknown: no transaction hash was returned."), record that too: it is a defect to report,
because nothing can have been sent.

Router calls mined: 0. Harness: not covered.

## Results

| Test | Wallet | Pass / fail | Router calls mined (expected) | Notes, hashes |
|---|---|---|---|---|
| 1 one swap | | | (1) | |
| 2 nonce and hash timing | | | (1) | |
| 3 second swap refused | | | (1) | |
| 4 speed up | | | (1) | |
| 5 cancel | | | (0, then 1) | |
| 6 reject | | | (1) | |
| 7 approve then swap | | | (1) | |
| 8 first approval fee | | | (0 or 1) | |
| 9 lost reply: no second request, expiry | | | (0; variant 1) | |
| 9b same-nonce review of an approval | | | (0) | |
| 10 account, network, lock | | | (1) | |
| 11 WalletConnect | | | (0) | |

Do not open the page while any of tests 1 to 7, 9 or 10 fails. Test 9b only records how the wallet treats a
requested nonce; it does not block the opening.
