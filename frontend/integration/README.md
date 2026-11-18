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

Scenarios (27), in the order they run (the ones that move the chain clock last):
`normal-send`, `queued-at-sequencer`, `queued-reply-lost`, `held-in-wallet-review-refused`, `reply-lost-wallet-ignores-nonce-no-review`, `reply-lost-replacement-refused`, `speed-up`, `cancel`, `dropped`, `rejected`, `fee-refusal-with-data`, `fee-refusal-data-lost`, `reload-while-wallet-open`, `two-tabs`, `approve-then-swap`, `wallet-ignores-site-fields`, `wallet-own-queue-ignores-nonce`, `first-approve-priced`, `first-swap-priced`, `first-approve-wallet-ignores-fees`, `credit-fresh-wallet-approve-then-swap`, `credit-fresh-wallet-first-swap`, `credit-needs-credit-refused-then-transfer`, `credit-refusal-through-wallet`, `clock-beyond-heartbeat-refused`, `reply-lost-never-published-expires`, `idle-chain-swap-lands-in-the-second-block`.
The four `credit-…` scenarios run against a MODEL of the L2 candidate's per-sender
credit rule (in the simulated wallet's node and as `bloch_admissionQuote` of the page's
RPC); the real candidate RPC is exercised by `scripts/staging/newslot-rpc-check.mjs`.
Each uses a new
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
- Since round 15 a swap is never requested from the wallet a second time
  (`reply-lost-wallet-ignores-nonce-no-review`), so the double swap that round
  14 recorded as a residual can no longer be produced by the page; a swap hold
  ends at its deadline in a finalized block (`reply-lost-never-published-expires`).
- No WalletConnect here: the QR entry of the Bloch L2 page is identity-only and refuses
  every transaction, so there is nothing to drive. The multichain site's mobile-wallet
  session has its own rehearsal (next section).
- Headless Chrome on macOS only was run. No Firefox, Safari or mobile browser.

# Mobile-wallet (WalletConnect) rehearsal of the multichain site (`browser/walletconnect-rehearsal.mjs`)

From the repository root, with `anvil`, `cast` and `forge` on `PATH` and `forge build` done:

```sh
node frontend/integration/browser/walletconnect-rehearsal.mjs --port 48000 --out /absolute/evidence/dir
```

Options: `--chains key,key` (default `base,op-mainnet`; at least two), `--shots DIR` (screenshots), `--stage 1`
(bring the stage up and hold it; run `browser/multichain-walletconnect.mjs <DIR>/harness.json` by hand).
It uses the tools of the page rehearsal (`scripts/multichain/rehearse-fork.mjs --hold`, `endpoint-proxy.mjs`,
`frontend-files.mjs`), builds the site twice (a rehearsal bundle of the forked chains, and the committed records,
where no chain is live) and serves both on loopback with their own headers. The page runs in headless Chrome
with no injected wallet. The wallet is SCRIPTED: a WalletConnect sign-client in node with a throwaway key,
paired with the page through the real relay (`relay.walletconnect.org`). The pairing code is taken from the
pixels of the QR image on screen (desktop) or from the wallet-app link (phone emulation).

What it asserts (`walletconnect-result.json`, schema `postern.frontend.multichain-walletconnect.v1`):

- not live: the header "Connect wallet" shows its note; no socket, no request off the origin, no WalletConnect
  code loaded;
- live, before the press: the same three; after it: the proposal the wallet received (nothing required, the live
  chains, one method, two events, the site's name and origin), the origins the page contacted against the
  Content-Security-Policy;
- on two forked chains: a swap, an approval and a swap of the approved token, each signed by the scripted wallet,
  each checked on the fork, the second chain reached without any switch request to the wallet;
- refusals: a rejection in the wallet; an account change followed; a chain outside the session; sessions with an
  added method, an added chain, two accounts, or without the page's network; a declined connection; an update
  that adds a method; a disconnection by the wallet and by the page; a transaction hash that is on no chain;
- phone emulation: the links of the dialog and a connection through the `wc:` link.

A chain on which the DEX is already deployed is forked from a loopback copy from which the three planned
addresses were emptied (the fork rehearsal deploys). What leaves the machine: the forks' reads of the public
endpoints and the relay traffic of the page and of the scripted wallet.

What it is not: a wallet app, a phone, Safari, or the production domain. The relay accepted the loopback origin;
whether the project accepts the production domain is set in the Reown dashboard. Real devices:
[test 12 of the manual script](../../docs/WALLET-MANUAL-TEST.md).
