# PosternDEX: security and integration review

Reviewed base: `980ee8ebb25c5109a8170f8f83d53f648999a36b`.
Method: source inspection, before/after executable regressions, deployed-contract
tests in Foundry, fuzzing and a stateful invariant campaign. This is a focused
implementation review, not independent certification or formal verification.

## Findings repaired

| ID | Severity | Original behavior | Repair and evidence |
|---|---|---|---|
| DEX-01 | High | The treasury accepted a checkpoint while reserves were zero. An empty interval could dilute the computed average after first liquidity, including a zero TWAP floor. | Require liquidity at checkpoint and consultation, reject zero TWAP and dust floors. The empty-pool regression failed before the fix and passes after it. Mature-window, manipulation, expiry and uint32 rollover tests also pass. |
| DEX-02 | Medium | Fee-on-transfer native liquidity removal compared `amountTokenMin` with the gross pair burn amount. Two transfer taxes could leave the recipient materially below the promised minimum. | Measure the final recipient delta and enforce the bound there. A 20% tax on each leg reproduces the original failure. Positive net-output and donation-isolation controls pass. |
| DEX-03 | Low | First liquidity ignored both minima; an existing pool checked only the side scaled by the reserve ratio. | Enforce both bounds after amount selection. The fresh-pool regression failed on the original source. |

The three original regression tests were run against the unmodified contract
bodies and all failed because the expected refusal did not occur. They passed
after the corresponding repairs. This is evidence of the specific defects,
not a measurement of all possible MEV losses or a proof of full DEX security.

## Additional improvements

- Fee authority now transfers by nomination and acceptance, with cancellation
  and observable events. A mistyped nomination no longer immediately loses
  the current authority. The fee switch still ships off; no fee was activated.
- Pair initialization rejects a second call and invalid token order. Factory
  creation rejects addresses without code; the router constructor checks that
  its factory and wrapped-native configuration point to contracts. These checks
  do not certify arbitrary token code or a maliciously selected factory.
- Treasury conversion checks exact burn-receipt deltas before selling. A taxed
  redemption cannot consume unrelated collector balances to make up its deficit.
  Direct treasury sweep remains available for nonstandard tokens.
- Taxed native removals forward only their own token delta. The final recipient
  cannot be the router itself. Unrelated donations do not subsidize the minimum.
- `BDexLens` adds bounded discovery and quote comparisons without execution,
  approval or custody. Repeated-token paths are rejected because naive static
  reserve quotes would be wrong if a route revisited its own modified pool.
- LP estimates include pending protocol-fee dilution. A test compares those
  estimates with actual burn proceeds and the protocol shares minted by the pair.
- Compiler/EVM settings, Foundry version, CI actions and test parameters are
  pinned. The test harness has no external Solidity library dependency.
- LP permits reject malleated high-s ECDSA alternatives before consuming the
  nonce. Canonical wallet signatures and the front-run-tolerant router removal
  flow remain covered by regression tests.
- Removed inherited references to absent legacy tests and placeholder chain
  configurations. The README now states the EVM/ECDSA and PQ L1 boundary.

## Validation

```sh
forge fmt --check
forge build --sizes --skip test
forge test -vv
```

The suite includes three fuzz properties at 512 cases each: swap invariant,
exact-output rounding, and lens/router quote parity with slippage rounding.
The stateful handler exercises add, swap and remove over 128 sequences of
64 calls, with **8,192 calls and zero unexpected reverts** in the recorded run.
It checks reserve backing, LP share conservation, permanently locked minimum
liquidity and the fee-adjusted swap invariant. These inputs model ordinary
ERC-20 tokens, not arbitrary malicious token behavior.

Other tests cover CREATE2 address parity; one-time initialization; two-step
authority control; valid and invalid flash repayment; reentrant sync refusal;
EIP-2612 nonce and chain-ID replay; treasury windows and manipulated spot prices;
taxed withdrawal net amounts; missing/empty/cyclic routes; bounded pagination;
actual execution of the selected multi-hop route; and pending fee dilution.

## Remaining limitations and release work

1. **No production deployment or chain qualification.** Select and verify the
   EVM chain, wrapper, factory administration and treasury independently. A
   wrapped asset's bridge and proof system are separate audit scopes. This
   change does not enable EVM execution or ECDSA spending on Bloch L1.
2. **No independent audit or exhaustive token model.** Commission an external
   review before user funds. Add fork tests against the intended wrapped asset,
   missing-return tokens, callback tokens, rebases and production RPC behavior.
3. **TWAP remains economically manipulable.** Endpoint liquidity checks close
   the empty-start defect; they do not prove deep liquidity throughout the
   window. Sustained displacement, malicious token accounting and an adversarial
   sequencer remain outside a blanket safety claim. Direct sweep is the default.
4. **Fee-on-transfer support is selective.** The router's named supporting
   variants handle actual received amounts. Standard quotes and exact-output
   methods do not model arbitrary taxes. Treasury conversion requires ordinary
   redemption semantics. A token that lies about balances defeats these models.
5. **Lens output is informational.** It compares supplied routes, not every
   market, and does not split orders or guarantee execution. Spot quotes must
   not price collateral. The caller must check availability and bind a minimum
   plus deadline into the eventual router transaction.
6. **Administrative policy remains centralized.** Two-step handover reduces
   operator mistakes; it does not create decentralized governance, a timelock
   or a multisig. `feeToSetter` still controls the protocol destination.
7. **Deployment compatibility changes.** CREATE2 hashes depend on the new pair
   and compiler settings; update integrations. Authority transfer now requires
   acceptance. No upgrade of an existing immutable deployment is implied.
8. **Existing canonical accounting limits remain.** uint112 reserves bound
   pool balances. Extremely large treasury fixed-point products can revert
   safely. Fee-off baseline reset occurs at a liquidity event. No claim is made
   that these V2 economics are concentrated liquidity or MEV-free execution.

## Primary technical references

- [Uniswap: building cumulative-price oracles](https://developers.uniswap.org/docs/protocols/v2/guides/building-an-oracle)
  explains observation windows, counterfactual accumulation and modular overflow.
- [Uniswap: oracle manipulation assumptions](https://developers.uniswap.org/docs/protocols/v2/concepts/oracles)
  explains why liquidity and the averaging interval affect manipulation cost.
- [Foundry: invariant testing](https://www.getfoundry.sh/guides/invariant-testing)
  describes stateful sequence testing and handler-based campaigns.
