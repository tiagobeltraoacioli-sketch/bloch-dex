# Branch index: the lines pushed on 2026-11-17

Which branch is what, which is audited or reviewed, which is work in progress, and how to verify it.
Tips are those of `origin` at 2026-11-17 04:32 UTC; branches keep moving during the day, so read the current tip with
`git ls-remote origin <branch>`. "Audit candidate" and "fit for external audit" are the verdicts of this
project's own reviewers; no external audit has been done. Nothing on any branch is deployed by being here.

| Branch | Tip | What it is | Status |
|---|---|---|---|
| `main` | `7ae50069b` | Integration line (integrator: agent 366). Release candidate 41a0af4 plus the unfinished round-17 branches of the multi-chain package, the visual design and the bridge page merged as work in progress | WIP on top of a reviewed release candidate; contracts unchanged (Pair init hash 0x16bd5cad…6683) |
| `codex/dex-bridge-page-r17-20261117` | `ebb0d6bc6` | Bridge page in the Bloch L2 site (agent 363) | WIP |
| `codex/dex-deploykit-r18-20261117` | `b88f01869` | Owner-run deployment of the DEX on the six public EVM chains, with fork dry runs (agent 367) | WIP; nothing is deployed by it |
| `codex/dex-design-r17-20261117` | `2d031e0e7` | Flagship visual design (agent 362): presentation only, the transaction path unchanged | WIP |
| `codex/dex-main-merge-20261117` | `7ae50069b` | The merge that became main | same tree as main when pushed |
| `codex/dex-multichain-r16-20261116` | `4f2427b0a` | Multi-chain package, round 16 (six EVM chains) | superseded by codex/dex-multichain-r17-20261117 |
| `codex/dex-multichain-r16b-20261117` | `0566af30e` | Multi-chain package, fixes of review R309-MC-1..9 | superseded by codex/dex-multichain-r17-20261117 |
| `codex/dex-multichain-r17-20261117` | `9e4b5d1ba` | Multi-chain package, round 17 (no signed value from one endpoint; reverted rule per chain; settled boundary) | reviewed (review 328, third pass); review 364 continues |
| `codex/dex-multichain-r17b-20261117` | `6e0e3cece` | Owner decisions of the multi-chain package: dedicated first depositor, fee-address proof, Base delegate, reserve caps, opening price guard, BNB label, licensing (agent 360) | WIP |
| `codex/dex-owner-tools-review-r18-20261117` | `a0f5ef844` | Reviewer demonstrations (owner-run tools, review 369) | review material, not for merge |
| `codex/dex-rc-r17-20261117` | `7ae50069b` | DEX integrator's line (agent 366) | integration; one verification table per tip in the integrator's report |
| `codex/dex-review-mc-r16-20261116` | `ba6633581` | Reviewer demonstrations (tests and scripts that prove findings) | review material, not for merge |
| `codex/dex-review-r17-20261117` | `a0f060964` | Reviewer demonstrations (tests and scripts that prove findings) | review material, not for merge |
| `codex/dex-ui-multichain-r16-20261117` | `ec717036d` | Frontend redesign on the multi-chain line, round 16 | superseded by codex/dex-ui-r17-20261117 |
| `codex/dex-ui-r16-20261116` | `e52d5b7db` | Frontend redesign, round 16 | superseded by codex/dex-ui-r17-20261117 |
| `codex/dex-ui-r17-20261117` | `adc8702a4` | Frontend route of the redesign (agent 361): snapshot renewal, reverted-swap hold text | WIP; reviewed in part (review 344 / 365) |
| `codex/dex-ui-review-r17-20261117` | `a89166e38` | Reviewer demonstrations (frontend) | review material, not for merge |

Status words: **audit candidate / fit for external audit**: the internal reviewers found no open Critical,
High or Medium finding on that tip; **reviewed**: an internal review pass covered that tip; **WIP**: work in
progress, tests not necessarily green; **superseded**: kept for history, do not build on it; **review
material**: tests and scripts that demonstrate review findings, never merged.

## How to verify a line

```
git fetch origin
git checkout --detach origin/<branch>
forge fmt --check && forge build && forge test -vv
cd frontend && npm ci --ignore-scripts && npm test && npm run build && npm run build:multichain
```

A tip's own documents (the route or package document under `docs/`) give its full test table and rehearsals.
