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

# Browser-engine wallet harness (`browser/`)

A second, separate harness. It drives the built production bundle (`#/mainnet`)
in the installed Google Chrome, headless, over the DevTools protocol, against
the loopback anvil chain of `scripts/staging/rehearse-mainnet-package.sh`, with
a simulated wallet. It uses only Node 24 built-ins and the locked frontend
dependencies (viem); it adds no dependency and is not part of `npx vitest run`.

From the repository root, with `anvil`, `cast` and `forge` on `PATH`:

```sh
SAFE_ARTIFACTS=/absolute/path/to/safe-contracts-1.4.1/build/artifacts node frontend/integration/browser/run.mjs
```

Optional environment: `CHROME_EXE` (browser binary), `WALLET_PORT` (first of 13
loopback ports, default 28900), `WALLET_OUT` (evidence directory),
`WALLET_ONLY` (comma-separated scenario names). Exit status 0 means the package
rehearsal passed and every assertion of every scenario held. `WALLET_OUT`
receives `result.json` (schema `postern.frontend.browser-wallet.v1`: per
scenario the assertions, the mined transactions of the account, nonces, what
the wallet signed and the page text) and `rehearsal.log`.

| File | Role |
|---|---|
| `run.mjs` | the one command: prerequisites, the rehearsal with the hook, the verdict |
| `wallet-hook.sh` | browser phase of the rehearsal (`RENDER_HOOK`): record and network files of the chain, production build, static server, scenarios |
| `cdp.mjs` | DevTools protocol client: launches the browser with a temporary profile, one isolated context per scenario |
| `wallet.mjs` | the simulated wallet: an EIP-1193 provider announced through EIP-6963; requests cross a DevTools binding and a throwaway key signs in Node |
| `scenarios.mjs` | the scenarios and their assertions |

The wallet reproduces, on demand: broadcast; held in the wallet's own queue
(a hash is returned, nothing is published); published or held with the reply
lost; speed-up (same call and nonce, higher fees, another hash); cancel (zero
value to itself at the same nonce); dropped (`anvil_dropTransaction`); user
rejection (4001); a prompt left open; a wallet that ignores the nonce and fees
the site asks for; and the L2's `sequencer-fee-underpriced` refusal with its
`error.data` passed on or lost. Inclusion is controlled with anvil (`automine`
off, `anvil_mine`).

Scenarios (17): `normal-send`, `queued-at-sequencer`, `queued-reply-lost`,
`held-in-wallet-review-refused`, `reply-lost-review-honoured-nonce`,
`reply-lost-review-wallet-ignores-nonce`, `speed-up`, `cancel`, `dropped`,
`rejected`, `fee-refusal-with-data`, `fee-refusal-data-lost`,
`reload-while-wallet-open`, `two-tabs`, `approve-then-swap`,
`wallet-ignores-site-fields`, `wallet-own-queue-ignores-nonce`. Each uses a new
throwaway account and asserts chain facts (router calls of the account that
were mined, nonces, balances, allowance) next to what the page shows, and that
the page itself never publishes a transaction through its RPC.

What it is not:

- Not a wallet. MetaMask's nonce tracker, rebroadcast, prompts, "speed up" and
  "cancel" are imitated, not run. Whether a real wallet honours the `nonce` and
  fee fields of `eth_sendTransaction` is established only by
  [the manual script](../../docs/WALLET-MANUAL-TEST.md).
- Not the settled RPC. Finality is anvil's `finalized` tag (`latest - 64`),
  moved by mining; anvil's transaction pool stands in for the sequencer spool
  (it replaces at a 10% bump like the spool, but has no admission preflight, no
  eviction after three hours and no per-sender limits). The fee refusal is
  produced by the simulated wallet from the documented shape, not by a node.
- One documented residual is asserted as such:
  `reply-lost-review-wallet-ignores-nonce` ends with two router calls mined.
  When the wallet's reply was lost and the wallet ignores the requested nonce,
  the page cannot prevent a second copy; it warns after the wallet answers.
- No WalletConnect: the QR entry of this frontend is identity-only and refuses
  every transaction, so there is nothing to drive.
- Headless Chrome on macOS only was run. No Firefox, Safari or mobile browser.
