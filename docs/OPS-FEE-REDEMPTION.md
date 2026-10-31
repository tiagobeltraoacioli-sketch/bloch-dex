# Protocol fee redemption through the Bloch Inc Safe

The fee is 1/6 of the growth of `sqrt(k)`, minted as LP shares to the Safe at the next `mint` or `burn` by anyone. It keeps earning swap fees until redeemed, so there is no need to hurry. Redeem when the amount justifies the signing effort, and not during an incident (see `OPS-DEX-INCIDENTS.md`).

## Do not use `transfer` + `burn`

`MAINNET-READINESS.md` and the package rehearsal describe a Safe `transfer` to the pair followed by a Safe `burn`. **As two Safe transactions this loses the money.** Between them, anyone can call `burn(<their address>)` and receive the value of the shares. With blocks 12–15 minutes apart the window is wide, and it takes one transaction. Reproduced on anvil: a third party received the value of the Safe's whole fee position, and the monitor's `lp_in_pair` went CRIT in the window.

Batching with MultiSend would be safe, but it is not deployed. The router needs no new contract, because `removeLiquidity` moves the shares and burns them in one call. Only an allowance remains between the two Safe transactions, and only the Safe itself can use that allowance through the router.

## Procedure

1. Check first: monitor exits 0, `finalized` is fresh, no bUSDC incident.
2. Plan. It reads at `latest` and sends nothing:

   ```
   node scripts/ops/dex-fee-redeem.mjs plan --config deployments/mainnet/finality-gate.mainnet.json --rpc http://127.0.0.1:18955 --out fee-redemption
   ```

   - `nothing-minted` means there is nothing to sign. The fee is pending until a liquidity event by anyone.
   - The plan writes one `safe-tx-N.typed.json` and one `safe-tx-N.json` per Safe transaction: `approve` for exactly the amount, then `removeLiquidity` to the Safe, with minimums (1% slippage by default) and a deadline (24 h by default).
   - It refuses to write anything if its hash differs from the Safe's own `getTransactionHash`.

3. Each owner checks the description, the target and the `safeTxHash` on a separate machine, then signs each typed-data file with their own device:

   ```
   cast wallet sign --data --from-file fee-redemption/safe-tx-N.typed.json --ledger
   ```

   Hardware wallets display the EIP-712 domain and message hashes. Compare them to the plan.

4. Assemble, once per transaction. It checks each signature against the pinned owners and rejects duplicates, too few signatures, and personal-message signatures:

   ```
   node scripts/ops/dex-fee-redeem.mjs assemble --config deployments/mainnet/finality-gate.mainnet.json --tx fee-redemption/safe-tx-N.json --sig TBD-owner --sig TBD-owner --sig TBD-owner
   ```

5. Execute, in nonce order. Any funded address can send it; use a gas limit of 500,000:

   ```
   cast send TBD-owner-safe TBD-assembled-calldata --gas-limit 500000 --rpc-url http://127.0.0.1:18955 --ledger
   ```

6. Run the monitor. `safe_allowance` and `lp_in_pair` must be OK at latest. Book the result only when finalized.

## What to expect

- **Remainder.** The burn mints the pending fee first, and those new shares stay in the Safe for the next redemption. So a "full" redemption can leave LP shares in the Safe.
- **Both tokens.** The Safe receives WBLCH and bUSDC; it does not unwrap. bUSDC below the bridge's `minBurn` cannot go back to Ethereum until more accumulates.
- **Skimmed donations.** The keeper also sends donations to the Safe. Keep them apart from fees in the books. The `fee_accrued` line counts LP shares only.

## When it fails

`execTransaction` with zero `safeTxGas` and `gasPrice` reverts as a whole if the inner call fails, so the nonce is not used.

| Failure | Fix |
|---|---|
| Minimums not met, the pool moved | Plan again and sign again. An `approve` that already ran is kept, and the plan skips it when the allowance is enough |
| Deadline passed | Same |
| Nonce used by another Safe transaction | Same |
| Allowance left and redemption abandoned | Sign `approve(router, 0)`. The monitor shows WARN until then. It cannot be used by anyone but the Safe, so this is tidiness |

## Tested

`rehearse-ops.sh`: 2 of 5 refused by `assemble`; 3 of 5 EIP-712 signatures from `cast wallet sign --data --from-file` with throwaway keys executed through the real Safe v1.4.1; allowance back to 0, no shares in the pair. A hardware wallet was **not** tested.
