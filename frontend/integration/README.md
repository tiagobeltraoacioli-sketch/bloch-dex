# Optional local Reth submission checks

This supplementary harness is separate from the standard frontend suite. Its
`.integration.ts` filename is selected only by the configuration in this folder.
It requires Node 24, the locked frontend dependencies and a trusted locally built
`bloch-evm-dev` executable. It accepts no RPC endpoint, private key or existing
database directory.

From `frontend/`:

```sh
POSTERN_RETH_SUBMISSION_TEST=1 \
BLOCH_EVM_DEV_BINARY=/absolute/path/to/bloch-evm-dev \
node node_modules/vitest/vitest.mjs run --config integration/vitest.config.ts
```

The harness starts its own synthetic node on an ephemeral loopback port, creates
a new temporary database and uses the public `07` test key funded by that node.
It makes one publication attempt for a synthetic EOA fixture and records the
intent and hash before publication. This fixture bypasses the application flow
deliberately; it is not evidence that the app would approve the request.

The four checks cover rejection of initial preparation and same-nonce review
without actual finality, verification of an explicit fixture's real transaction
body, rejection of a different saved nonce, and retention of the hold after
inclusion without finality. No RPC response or finality header is fabricated.
There is no resend, fee increase, contract deployment or real-network access.

The node receives `SIGINT` at teardown, with a bounded shutdown fallback. The
new temporary directory retains `result.json`, `server.log` and the synthetic
database for inspection; its path is printed at teardown.

Validation status: this supplementary harness has been reviewed statically and
its imports collected with execution disabled, but has not completed a live run.
Standalone TypeScript checking is unavailable with the current locked install
because `@types/node` is absent; collection is not a substitute for type checking.
Its four cases are not counted in the standard frontend test results. It does
not validate browser Web Locks, wallet extensions,
L1 settlement proofs, mainnet readiness or the DEX contract lifecycle. The latter
has its own [Reth rehearsal](../../docs/RETH-DEX-REHEARSAL.md).
