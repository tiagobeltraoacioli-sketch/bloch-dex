# DEX contracts on the Bloch Reth developer process

`scripts/staging/rehearse-reth-dex.mjs` executes the repository's compiled DEX
contracts through the real Bloch Reth HTTP handlers and canonical database.
It starts its own `bloch-evm-dev --synthetic-dev` process on a fresh loopback
port and funds a public test key with synthetic native currency. It accepts
neither an existing RPC endpoint nor a private key. Protocol fees stay off.

Prerequisites are Node 24, the frontend's locked dependencies, `forge build`
with this repository's pinned compiler settings, and a locally built
`bloch-evm-dev` executable from the L2 repository. Every artifact's source
hash and compiler settings are checked before the process starts.

```sh
node scripts/staging/rehearse-reth-dex.mjs \
  --binary /absolute/path/to/bloch-evm-dev \
  --out /absolute/path/to/new-evidence-directory
```

The output directory must not exist. The driver retains `result.json`,
`server.log` and the synthetic database, then stops the process. It never
retries a transaction whose reply was lost. On failure, use a new output
directory after reviewing the recorded hashes.

The rehearsal checks deployment of TestToken, WBLCH, Factory and Router;
approval and liquidity provision with native wrapping; a swap bound to the
real preceding block hash; rejection of an incorrect anchor without reserve
changes; the constant-product lower bound; donation and skim with exact token
balance changes at both the pair and recipient (and unchanged reserves); LP approval;
liquidity removal with native unwrapping; and database re-opening with the
same code, reserves and canonical receipts.

The 2026-11-04 run passed all stages with 13 signed transactions, including
the deliberately reverted anchor test. The report records the executable
SHA-256, contract creation hashes, deployed code hashes and all receipts.

This is synthetic execution and persistence evidence. It does not exercise
the native L1 bridge, settlement proofs, policy-v2 spool admission, real
finality, mainnet release binaries or wallet extensions. Those have separate
rehearsals and qualification requirements.
