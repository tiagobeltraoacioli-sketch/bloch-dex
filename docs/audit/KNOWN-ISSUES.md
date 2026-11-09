# Postern DEX: known issues

Every finding known to the team, with its status at the commit that contains this file.
Severity is as the finder rated it. "Fixed" means a code, test or tooling change is in
this commit; the commit named is where it landed. An auditor should treat every item
here as known and not report it again unless the fix or the reasoning is wrong.

Identifiers: `DEX-01` to `DEX-09` (two digits) are findings of the internal pre-audit
review. `DEX-4`, `DEX-5`, `DEX-7` and `DEX-8` (one digit) are owner decisions of round 10:
DEX-4 keeps the contracts unchanged for launch and accepts the behaviour of item 1
below, and DEX-8 sends that behaviour to the external audit as an explicit item.

## 1. Accepted for launch and sent to the audit: swap fees at the k ceiling (DEX-4, DEX-8)

| | |
|---|---|
| Behaviour | When `reserve0 x reserve1` reaches the ceiling fixed by the constructor caps, `_applyCeiling` records the side that grew as `C / other`, so the 0.3% swap fee stays outside the reserves as excess. LPs and the protocol fee (`feeTo`, the Bloch Inc Safe) earn nothing from those swaps. Any caller takes the excess with `skim`, with a `swap` that sends nothing in, or with `mint` as shares. Arbitrage at the ceiling is fee-free (swap plus skim) |
| Findings | L2, L2a (agent 61), A98-3, A98-7 (agent 98), measured by agent 177 |
| Severity | Medium (revenue and LP yield at the ceiling; no principal is at risk: a recorded reserve on a side that grew is never below its previous reserve) |
| Status | **Accepted by the owner for launch with no contract change (DEX-4), and an explicit item of the external audit (DEX-8).** No design fix exists inside the current pair; routing the excess to `feeTo` is the candidate for the next DEX version |
| Mitigations off chain | The first-deposit planner refuses a seed above 7,000 bps of the tighter cap (8,000 sits on the ceiling at some prices). The keeper skims excess at the ceiling to the Safe from a floor of budget / max-tx (0.00104 BLCH), so the protocol, not bots, collects most of those fees within 48 transactions and 0.05 BLCH a day. The monitor reports `k_ceiling` |
| Where | `contracts/UniswapV2Pair.sol` `_applyCeiling`; `docs/AUDIT-PACKAGE-DEX.md` section 8 item 8; `docs/OPS-DEX-MONITOR-KEEPER.md`; tests `test/KCeiling.t.sol`, `test/Economics.t.sol` |

## 2. Internal pre-audit review (agent 17, `AUDIT-SCOPE-DEX.md` section 6)

| ID | Sev. | Summary | Status |
|---|---|---|---|
| DEX-01 | Medium | A donation could block LP exits on a capped pair | Fixed (`_exitBound`); I7 |
| DEX-02 | Low | A standing donation above a cap blocks inflow on that side until `skim` | Accepted residual risk; Lens `pendingExcess`, keeper, monitor |
| DEX-03 | Low | Caps are per pair, not aggregate; `createPair` is permissionless | Accepted; mitigated by the first-depositor rule (no third party can open a pair) |
| DEX-04 | Info | An unsynced donation counts toward the first mint's ratio | Synced form closed by DEX-09; the seed planner skims first and verifies the price |
| DEX-05 | Info | Anchored swaps depend on L2 `BLOCKHASH` for 256 blocks | By design; fails closed |
| DEX-06 | Info | Lens quotes ignored pending excess | Fixed in the Lens; I17 |
| DEX-07 | Info | Donations also pay the protocol fee | Canonical behaviour |
| DEX-08 | Info | `feeTo` has no zero check | By design; tooling requires the Safe |
| DEX-09 | Low | Donations synced to both caps could brick an empty pair | Fixed (`EMPTY_POOL`); I14 |

## 3. Independent review at `258fdd2` (agent 51)

| ID | Sev. | Summary | Status |
|---|---|---|---|
| F1 | High (liveness) | A mint to both caps closes the pair to swaps and mints | Fixed by the k ceiling and the first depositor (`e339148`, `d18ab04`), with accepted limits (7.3) |
| F2 | Medium-High (launch) | A front-run `createPair` strands the deployment tooling | Fixed in tooling (`deploy-dex.mjs check-pair`, `sign-and-publish.sh --plan`) |
| F3, F4, F5 | Medium / Low-Medium | Frontend quote and receipt handling | Fixed in the frontend (out of scope) |

## 4. Attack review of the F1 fix at `d18ab04` (agent 61, "DEX-F1")

Verdict: "holds with listed limits". No attacker can stop swaps for longer than it
takes anyone to call `skim`, and LPs could always exit.

| ID | Sev. | Limit | Status |
|---|---|---|---|
| L1 | High if the key is not single-purpose | `tx.origin`: one call by the depositor EOA to hostile code spends the first-deposit rule | Accepted; fresh EOA, nonce-0 and no-code checks in planner, gate, `preflight` and `DeployMainnet.s.sol`; a Safe owner as depositor is refused, a Safe depositor is unsupported. Not closable by a read check for a pre-signed or stolen key |
| L2, L2a | Medium | At the ceiling LPs and the Safe earn no fee; anyone can force the ceiling and collect fees by skimming; the fee is optional (swap + skim) | **Accepted by the owner for launch, with no contract change, and an explicit audit item (DEX-4, round 10; section 8 item 8).** Launch mitigations off chain: seed limit 7,000 bps, keeper ceiling floor (`codex/dex-r10-decisions-20261102`). Measured by agent 177. No design fix exists |
| L2b | Low-Medium | Standing excess fills the next trade with reserves unmoved; the skimmer keeps the input | Accepted; user still gets the quote |
| L3 | Medium | Excess past both rooms closes both directions until `skim` | Accepted (DEX-02 form); keeper and monitor `closed_by_excess` |
| L4 | Low | A pre-seed donation over half a cap reverts the seed until the seeder skims | Accepted; planner skims first |
| L5, L6 | Low | A fill closes top-ups; narrows the one-swap price range | Accepted, documented |
| L7 | Blocking (tooling) | Tooling did not pass the new constructor argument | Fixed (`0201d54`); `address(0)` refused on every mainnet path |
| L8 | Product | `firstDepositor` covers every pair; key loss blocks new pairs | Accepted |
| N1 | Medium-High (launch) | A griefed seed stranded the tools and forced a new deployment | Fixed in tooling (`note-tx`, `b08fce4`); griefing itself costs a retry |
| N2 | Low-Medium | `verify` passed on an attacker's pool | Fixed (`verify --to`, `monitor --lp-recipient`) |

## 5. Independent audit at `d18ab04` (agent 98)

No fund-loss finding.

| ID | Sev. | Summary | Status |
|---|---|---|---|
| A98-1 | Info | k falls by less than one unit of the kept side at the ceiling; LPs lose at most about 1 bUSDC base unit, not cumulative | Accepted as dust; documented (`OPS-OPENING-KIT.md`); pinned in supplementary tests |
| A98-2 | Low (test) | RC invariant tolerance was one-sided | Fixed: anchored `invariantSwapsNeverReduceK` in the RC |
| A98-3 | Low | Spot price moves almost free at the ceiling; any `getReserves` oracle loses the fee as protection | Documented. No in-scope contract reads the pair as an oracle |
| A98-4 | Info | In a flash callback `balanceOf(pair) < getReserves` (read-only window) | Canonical V2; no consumer. Not in RC docs; listed here |
| A98-5 | Low | The first-deposit rule never returns after the seeder fully exits | Documented in `OPS-INITIAL-LIQUIDITY.md`; owner decision on keeping a floor position is open |
| A98-6 | Info | `tx.origin` bait fills every pair of the factory | Documented (L1) |
| A98-7 | Low | At the ceiling fees go to any skimmer; `mint` with no deposit turns standing excess into shares | Documented (L2); the keeper sends excess to the Safe |
| A98-8 | Info | WBLCH withdraw latch is global, not per caller | Fails closed; not in RC docs; listed here |
| A98-9 | Info | `WBLCH.transferFrom(self, …)` needs an allowance, unlike WETH9 | Fails closed; not in RC docs; listed here |
| A98-OPS-1 | Medium (ops) | Depositor approve and seed were not built or checked by the kit | Fixed (`plan --write-txs` + `sign-and-publish.sh`, `811a29e`) |
| A98-OPS-2 | Low | `--fraction-bps` above 8,000 reverted at the ceiling | Fixed (refused above 8,000); lowered to 7,000 by owner decision DEX-4 (round 10): 8,000 sits exactly on the ceiling at P = 50, 80, 100 |
| A98-OPS-3, -4, -5 | Info | Pending-nonce blindness; rehearsals sign with chain 700770 on anvil; history check is shape-only | Documented; keys are throwaway and unfunded |

## 6. Other known items (agents 96, 113, 139, 180)

| Item | Status |
|---|---|
| A griefer who outbids the keeper wins every skim race (real L2 ordering) | Keeper tiers and varying tip; griefer pays gas and risks its donation |
| A third party knowing size and direction can bracket a swap by tip (L2 ordering) | Sequencer ordering; slippage defaults; out of contract scope |
| `approve` storage inflation against the pair or tokens | An L2 prover-cost issue, resolved by the sparse guest (agent 113); out of contract scope |
| bUSDC V3 effects (section 5) | Documented and monitored |
| Agent 180 (independent V3 review, tests `test/V3Interaction*.t.sol`): L-1 a bridge deposit whose L2 recipient is the pair, router, WBLCH or token is lost to the depositor and can be captured by any skimmer or flash borrower; L-2 after a token migration a pair of the new token in the launch factory is uncapped with no k ceiling; L-3 the gate's code-hash pin does not pin signer or guardian sets | L-1: bridge page tooling (separate frontend line) and incident doc; L-2: policy, a migration means a new DEX factory; L-3: addresses and code hashes only from the bridge deployment record; since agent 227 the gate also compares signers, guardians, thresholds, T and the reviewed build with that record (section 3.6). No contract change |

## 7. Review of the round 13 tooling and submission path (round 14, 2026-11-09)

Round 13 (26 commits, `29758f5..a95ef47`) hardened the keeper, the gate's RPC transport and the frontend's
submission path without a review. Round 14 had it reviewed independently. Contracts were not touched.

| Finding | Status |
|---|---|
| H1 (frontend): "Review same nonce in wallet" was offered while the original could still be queued; a wallet that ignores the page's nonce would execute the same call twice | Fixed `2ad78cf`: no wallet request unless the pending nonce equals the canonical nonce. Driven in headless Chrome with a simulated wallet (`frontend/integration/browser`); real wallets: `docs/WALLET-MANUAL-TEST.md`, not yet run |
| M1 (keeper): the skim recipient came from the gate file's `feeTo` unchecked | Fixed `e6fddb8`: `feeTo` must be the pinned Safe and the factory's `feeTo()` at the acting block |
| M2 (keeper): whatever the external signer returned was published if the sender matched | Fixed `e6fddb8`: only the planned skim (chain, nonce, recipient, data, zero value, gas, both fees) is published |
| M3 (keeper): one lost transaction keeps the keeper waiting until an operator edits the state file | Fixed `61448db`: the stored signed bytes are published again unchanged, then replaced at the same nonce with higher fees inside the same ceilings; a nonce used by an unrecorded transaction is settled from the finalized chain. One nonce at a time, recipient always `feeTo` (`OPS-DEX-MONITOR-KEEPER.md`, "Crash behaviour and automatic recovery") |
| M4 (frontend): a hold without any wallet transaction had no stated exit | Fixed `2ad78cf` (guidance in the recovery panel; the rule itself is unchanged) |
| L1, L4, L6 | Fixed `e6fddb8` |
| L2 (keeper leaves `.lock` after SIGTERM) | Fixed `61448db`: a stopped pass releases its lock, and a lock whose owner is provably gone (reboot, missing process, reused process ID) is taken over |
| L5 (pre-round-13 pending records) | Handled `61448db`: such records hold no signed bytes, so they are never re-published or replaced; they settle by a receipt or by the finalized transaction that used their nonce. None exists on 700770 |
| L3 (the systemd unit uses the built-in 48 tx / 0.05 BLCH defaults, not the form's values) | Fixed `e365ef1`: the units pass `--budget-wei` and `--max-tx` from the opening form's `DEX_KEEPER_BUDGET_WEI` and `DEX_KEEPER_MAX_TX`, and the monitor takes `--keeper-max-tx` |

No finding above Low in `finality-gate.mjs`, `rpc-transport.mjs`, `publish-recorded.mjs`, `sign-and-publish.sh`,
`sequencer-fee-error.mjs`, `keeper-accounting.mjs`, `keeper-state-store.mjs` or the opening-form quoting.
Not reviewed: `dex-monitor.mjs` and `dex-seed-plan.mjs` beyond their diffs, `rehearse-reth-dex.mjs`, the tests.

## 8. Round 14, second pass (2026-11-09): browser harness and two independent reviews

Found by driving the production bundle in headless Chrome with a simulated wallet, and by two independent
adversarial reviews of the round 14 changes (keeper recovery, new-slot fee, gate).

| Finding | Status |
|---|---|
| B1 (frontend, High): a wallet that ignores the nonce the page asks for signed a "same nonce" review at its next nonce while still holding the original; both were mined (two router calls in the harness) | Fixed `7362524`: no wallet review once the wallet returned a hash; a later nonce carrying the saved call settles the hold; the page warns when the wallet signed another nonce. **Residual, accepted and asserted as such in the harness:** when the wallet's reply was lost (no hash known), the wallet ignores the nonce and the user ignores the page's warning, two transactions can execute. Whether MetaMask honours a site's nonce is test 9 of `docs/WALLET-MANUAL-TEST.md`; if it does not, remove the review button before opening |
| K-M1, K-M2 (keeper): a fee quote above the ceilings, or four refused replacements, left an open entry waiting for ever | Fixed `e365ef1` |
| K-M3 (keeper): a new nonce signed behind another queued transaction of the keeper account could leave a permanent gap | Fixed `e365ef1`: no signature unless the pending count equals the account nonce |
| K-M4, K-M5 (keeper): a node reporting an old block timestamp, or a host clock a day ahead, emptied the 24 h budget window | Fixed `e365ef1`. Against a node that lies about gas used the hard bound is `--max-tx` x `--max-gas` x `--max-fee-wei`, documented |
| K-L1 (keeper): a first publication the node refuses with its admission price is released without finalized data; a node that queues it anyway and lies gets a second nonce signed | Open, Low, accepted: the keeper talks to the operator's own settled RPC, which answers this only before its spool write. Both transactions are still `skim(feeTo)` |
| K-L2, K-L3 (lock): no host or PID-namespace identity; a leftover `.lock.break` | Fixed `e365ef1` (no takeover across hosts or namespaces; the message names the file). A leftover `.lock.break` still needs an operator |
| K-L4, K-L5, K-L7, K-L8 (keeper): signer arguments in an error message; unchecked fee options; upper-case signed bytes; a pair not bound to the pinned factory | Fixed `e365ef1` |
| K-L6 (keeper): an entry left open by a pre-round-14 keeper holds no signed bytes and is not re-published or replaced | Open, Low: it settles by a receipt or by the finalized transaction that used its nonce; none exists on 700770 |
| F-M1 (tools): a tool started through a symlink or from a path with a space did nothing and exited 0, the mainnet gate included | Fixed `e365ef1` (`scripts/staging/is-main.mjs`, test) |
| F-M2, F-L1 (frontend): an RPC could make the page suggest a priority fee hundreds of times the honest one, and an unbounded max fee | Fixed `e365ef1`: at most 13.75 gwei of suggested tip with the committed policy (0.0069 BLCH on a 500,000-gas swap), base fee refused above 1,000 gwei |
| F-M3 (frontend): the pending-nonce check of a same-nonce review was not the last read before the wallet | Fixed `e365ef1` (pricing first). The signed-nonce warning is still a single read right after the wallet returns |
| F-L2 (gate consumers): `frontend-record.mjs` and the page accept any schema-2 report with `liquidity-enabled` for chain 700770 and the plan's genesis, including one from the generic gate without the Safe and bridge checks | Open, Low: the opening procedure runs the mainnet wrapper, and the monitor re-runs it every pass. Candidate fix: require the wrapper's `pinned` block for chain 700770 |
| F-L3 (gate policy): the pinned launch policy fixes the signers, thresholds and guardians of the bridge token but not `largeMintDelay`, `cancelQuorum`, `switchDelay` or `supplyCap`, which are compared with the operator-supplied bridge plan only | Open, Low: needs the bridge line's minimums in `deployments/mainnet/bridge-token.pin.json` |
| F-L4 (frontend): with the new-slot policy on, every wallet request first needs `eth_createAccessList`; when the RPC cannot answer, or the call would revert, nothing is sent | By design: nothing is saved either, and the user can try again. Turn the policy off in the network file to restore the old behaviour |
| New-slot fee: the count is an upper bound | Exact for the launch contracts in the harness (first approve, first swap, repeat swaps). A token that reads zero-valued slots it does not write would be over-counted by 0.00022 BLCH per slot; the real bridge token was not measured in a browser. An exact figure needs a quote method on the L2 RPC |

