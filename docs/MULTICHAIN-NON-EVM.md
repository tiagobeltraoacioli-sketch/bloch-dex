# The DEX outside the EVM: Tron, Bitcoin, Solana, Stellar

Status: assessment only (2026-11-16). No code exists for any of these, and nothing here was run on those networks.
The six EVM chains are covered by `docs/MULTICHAIN-DEPLOY.md`.

The statements about the four networks below are from their public documentation as known to the author, not from
a test. Each one that a decision would rest on is marked **to verify**.

## Summary

| Network | Can it run these exact contracts? | What it would take |
|---|---|---|
| Tron | No, not byte for byte. A port is feasible | A separate build with Tron's compiler, changed address derivation, a token-transfer rule that accepts Tron USDT, new deployment tooling, a second wallet path in the page, its own tests and review. About 6 to 8 weeks of engineering before a review |
| Bitcoin | No | Nothing to port: no contract can hold a pool. BTC can be traded on the EVM chains as a wrapped token |
| Solana | No | A new program in Rust for another execution model: a new product, not a port |
| Stellar | No | A new Soroban contract in Rust, or use of Stellar's built-in pools, which have no protocol fee for a third party |

## Tron

Owner's address: `TCQ2d5gxTczSeN2oeni16JwMW7HWLzXEKc` (base58check; the same account in hex starts with `41`).

Tron's virtual machine (TVM) executes EVM-style bytecode and Solidity compiles for it, and a constant-product
exchange of this family already runs there (SunSwap V2), so the design is feasible. These exact contracts are not
deployable as they are, for the reasons below.

| Difference | Effect on this code | Change needed |
|---|---|---|
| Compiler: Tron uses its own Solidity build | The bytecode is not the release candidate's; the pair init code hash `0x16bd5cad…6683` and every pinned code hash change | A separate build, separate pins, and a separate review: the existing audit covers the bytes it was given |
| CREATE2 address: TVM derives it with the prefix byte `0x41` where the EVM uses `0xff` (**to verify**) | `BDexLibrary.pairFor`, the script's `predict` and the planner compute wrong pair addresses; a router that trusts `pairFor` would send tokens to an empty address | Change the prefix in the library and in the tooling; this is a contract edit |
| No deterministic CREATE2 deployer at `0x4e59…956C` | The same-address-everywhere scheme does not apply | Ordinary deployment from the owner's account; addresses are Tron's own |
| USDT on Tron (the chain's main stablecoin) does not return `true` from `transfer` (**to verify** on the deployed token) | `_safeTransfer` in the pair and the router's helpers require `true` when data is returned: every USDT transfer out of a pool would revert | Change the transfer helpers for this token, a contract edit in the most sensitive path |
| Resource model: energy and bandwidth, a `fee_limit` per transaction, and a deployer-paid share of users' energy | Gas limits in the page and the cost figures do not carry over | New limits and cost measurements on Tron |
| Native coin TRX has 6 decimals; the wrapped coin is WTRX | The router's native paths work with any wrapper that has `deposit`/`withdraw`; the page assumes 18 decimals for the native coin | Page change; verify WTRX's interface and payout to a contract |
| `chainid`, `blockhash`, `timestamp` | The LP token's permit domain uses `chainid`; anchored swaps use `blockhash`; deadlines use `timestamp` in seconds | Verify each on TVM; anchored swaps may have to stay unused, as on Arbitrum One |
| Tooling and wallets: no `eth_*` JSON-RPC parity, transactions are a different format, wallets are TronLink-style, not EIP-1193 | Forge scripts, the gate, the fork rehearsals and the page's whole transaction path (viem, the same-nonce hold logic, which relies on account nonces) do not apply. Tron transactions have no account nonce | New deployment scripts, a new gate, and a second transaction path in the page with its own protection against double sends |
| Address format | Configuration, explorer links and input checks assume `0x` addresses | Base58 handling throughout |

Work, in order: the port and its tests on a local Tron node (2 to 3 weeks); deployment tooling and a gate (1 week);
the page's Tron path and a browser rehearsal (3 to 4 weeks); then an independent review of the changed contracts
before any value is put in. The protocol fee would go to the Tron address above, fixed in the factory as on the
EVM chains.

## Bitcoin

Bitcoin has no accounts with code: its script language cannot hold a pool's reserves, compute a price, or mint
shares. There is nothing to port. What exists instead:

- BTC as a token on the chains where the DEX runs: a wrapped Bitcoin token in a pool. The owner's listing choice;
  each wrapped token brings its custodian's or bridge's risk.
- The Bloch ecosystem's own BTC bridge work, which is a separate product line.

## Solana

Solana programs are compiled to its own bytecode from Rust and keep state in separate accounts passed into each
call. EVM bytecode does not run there, and Solidity sources do not translate line by line: the pair's storage,
`msg.sender` checks, the LP token and the router's call sequence all have to be redesigned for that model. That is
a new program with new tests and a new audit. An EVM running on top of Solana exists as a separate network with
its own state and liquidity; deploying there would be one more EVM chain, not "being on Solana". Alternative: none
that keeps this code; the owner would be commissioning a second product.

## Stellar

Stellar has two things: built-in liquidity pools at protocol level (constant product, a fixed 0.30% fee that goes
to the pool's depositors, no place for a protocol fee to a third party, **to verify**), and Soroban smart contracts
written in Rust. These contracts cannot run on either. A Soroban exchange with a protocol fee would be a new
contract set with a new audit, as on Solana. Using the built-in pools needs no code but earns the owner nothing
beyond what any depositor earns.
