# PosternDEX frontend

A responsive implementation of the approved Trade, Pools and Portfolio concept.
The interface uses graphite surfaces, ivory type, lime actions and self-hosted
Inter. All UI text, source comments and documentation are in English.

**This is an interactive preview with sample data, not a live trading client.**
Connecting a wallet never turns sample amounts into real wallet balances.

## Run and validate

Use Node **24.x** and npm with the committed lockfile. Development and preview
servers bind to loopback by default.

```sh
npm ci --ignore-scripts
npm run dev
npm test
npm run test:mobile-edge
npm run test:qr-release
npm run build
npm run preview
```

`npm run build` checks TypeScript and creates the static bundle in `dist/`.
Hash routes (`#/trade`, `#/pools`, `#/portfolio`) and relative asset URLs allow
hosting under a subdirectory without server-side route rewriting. Serve the
bundle over HTTP(S); opening `index.html` directly from disk is not supported.
No site or contract deployment is performed by these commands or by CI.

## September 2026 release

The Develop route (`#/develop`) connects the DEX to the EVM/SVM developer kit,
Bloch Bridge and Bloch Builders. Its dated status describes the current preview
and the work needed before transactions can open. Bridge links use the active custom domain, `https://blochbridge.com/`.

## Implemented interactions

| Screen    | Behavior                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trade     | Token search/selection, pair reversal, amount validation, bounded route discovery and comparison, slippage settings, review dialog, chart period selection |
| Pools     | Name/symbol search, liquidity/volume/fee sorting, local watchlist, empty results, pool details, deposit preview                                            |
| Portfolio | Sample composition/history/activity, period selection, proportional withdrawal and deposit previews                                                        |
| Shared    | Hash navigation, keyboard skip link, native modal dialogs, wallet discovery/connection/disconnect, network explanation and liquidity guide                 |

Below 720px, the swap form precedes the market panel and pool rows become cards.
Other layouts adapt at 380px, 960px and 1180px. Controls have accessible names,
visible focus styles and reduced-motion support. Dialogs use the browser's
native top layer, focus containment and Escape behavior; focus returns to the
opening control. Text and charts remain DOM/SVG content, not screenshot assets.

Only the watchlist and slippage preference are stored in `localStorage`. Invalid
or unavailable storage is tolerated. There is no backend, analytics collection,
account persistence, external font request or private-key handling.

## Quote and liquidity calculations

`src/amm.ts` parses decimal input into `bigint` token base units, rejects excess
precision and exponent syntax, bounds uint256 inputs/intermediates, and applies
V2's `997/1000` exact-input formula. Slippage minima are rounded down and zero
outputs are unavailable. Routes are bounded, never reuse a pool and are ranked
by output.
This preview discovers paths through the fixture pool graph with at most four
hops and no repeated pool, then retains the best eight quotes to match
`BDexLens` bounds. A token may reappear when every hop uses a distinct pool. It
is not global market discovery or split-route optimization.

`src/data.ts` is the explicit fixture boundary. Its symbolic assets are not
addresses or a deployment registry. Numeric USD displays and deterministic
illustrative histories are presentation data, not oracles. Quote calculations
use integer reserves. Real taxed/rebasing tokens are not modeled.

Liquidity dialogs calculate amounts from sample reserve ratios or the sample
position. They do not mutate positions or send transactions. The sample
protocol-fee dilution adjustment is zero; a live adapter must use the lens's
actual diluted estimate. Sample activity is not wallet transaction history.

## Wallet boundary

Discovery follows [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), with a
legacy injected-provider fallback. Provider names are untrusted text, discovery
is bounded and provider-supplied icons are not loaded. Browser and WalletConnect
names are Unicode-normalized, length-bounded and stripped of control and
bidirectional-formatting characters before display. UUIDs and names do not
prove a wallet's identity. MetaMask and other compatible injected wallets can be
selected, including the provider inside MetaMask Mobile's browser. When MetaMask
is not detected, an explicit **Open MetaMask Mobile** link opens the canonical
`https://blochdex.com/?connect=metamask` in its app browser, where the user selects the wallet and
approves account access. The link follows MetaMask's
[documented dapp deep-link format](https://github.com/MetaMask/metamask-deeplinks/blob/master/js/index.js).
The controlled `connect=metamask` marker opens the destination connection dialog
without requesting accounts. It never forwards the current host, user-supplied
query parameters, hashes or wallet metadata;
preview builds also open that canonical production URL. No redirect happens on
page load. The handoff is disabled during a pending browser connection request.
If app opening fails, the UI provides the URL to open manually in MetaMask's
browser. The separate QR entry uses WalletConnect only for account and chain
identity on the experimental Bloch L2 preview; its provider rejects every
transaction or signing method. Account and chain events are accepted only from
the approved session topic and Bloch L2 namespace; unsupported changes terminate
the local session instead of leaving a stale identity. Namespace updates apply
the same topic, CAIP-2 and CAIP-10 checks, exact read-only permissions and bounded
account lists. Expired, excessively long-lived or mixed-chain approvals are
closed before a provider is exposed. Approved sessions also expire locally on
their bounded deadline even if a remote expiry event is missed. Hardware-wallet-specific flows are not included.

On iPhone Safari the application must first be opened in MetaMask's own browser;
the injected-provider connection here does not pair Safari directly with the app.
Discovery listens for MetaMask's asynchronous `ethereum#initialized` event,
performs bounded retries for five seconds and rescans on focus, pageshow and an
explicit wallet check. Opening the connection dialog also triggers rediscovery.
None of these scans request accounts or signatures. An already-authorized
account can reconnect without another wallet approval prompt.

Publication check on 2026-09-14: the public site referenced
`assets/index-DGP4G7Mx.js`, which included the empty-wallet message but no MetaMask
mobile deep link. That bundle also differs from this local preview's feature set.
Do not replace that deployment with this preview build without reconciling its
source and release process. The separately built [mobile delivery adapter](edge/README.md)
preserves the current Pages application while adding the mobile connection fix.
Its release verification is independent of this preview build.

Account access identifies the selected address to this browser session; it does
not authenticate a backend session or prove ownership through a signed message.
The app does not request a signature or permissions to move assets.

After an explicit click, the client uses only `eth_requestAccounts` and
`eth_chainId` from [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). It observes
account changes, network changes and disconnects, validates responses, ignores
cancelled requests and removes event listeners. Initial and changed account
lists are limited to 20 entries and every entry must be a syntactically valid
EVM address; pending event data is copied before provider code can mutate it.
Disconnect clears this app's
connection state; users manage the extension's permissions in the wallet.

There is no sign, approve, send, add-chain or switch-chain call in this frontend.
The connected wallet's network is displayed separately from the Bloch L2 preview
label. There is no assumed production chain ID, RPC, router, factory, lens or
wrapped-native token address. EVM account compatibility does not imply PQ
authorization on Bloch L1.

## Validation and remaining integration

Vitest covers exact amounts, the reserve product, route/rounding bounds, wallet
lifecycle/cancellation, preview interactions, filters, preferences and error
states. Tests use jsdom with a minimal native-dialog shim. They **do not validate
rendered geometry, contrast, native focus containment or a real wallet extension**.
Real-device iOS/Android MetaMask handoff and approval have not been executed.
Desktop/mobile browser and assistive-technology review remain release checks.

Before enabling real transactions, implement and review all of the following:

1. An explicit per-chain deployment registry, validated RPC chain ID and contract
   bytecode/identity, including canonical factory/router/lens/wrapped-native links.
2. A separate live data adapter: consistent block snapshots, lens pagination and
   quote availability, cancellation of stale requests, live account balances and
   indexer-backed history. Never fall back silently from live data to fixtures.
3. ERC-20 decimals and token policy, native wrapping paths, fresh quotes, gas and
   allowance checks, explicit bounded approvals, expiry/deadline, network/account
   revalidation at confirmation and transaction simulation.
4. Receipt/replacement/revert handling, chain reorganization behavior and updated
   balances after settlement. Quote amounts and reserve prices are not oracles.
5. Browser/extension integration tests and adversarial tests against a local
   deployment, followed by a separate deployment and operational review.

Do not implement live mode as a cosmetic toggle or by merely adding an RPC URL.
The current code deliberately has no transaction submission path.

### Read-only deployment binding

`src/live-read.ts` implements the first fail-closed integration layer without
activating it in the application. It accepts the staging artifact manifest's
`deploymentConfiguration`, which must still declare `frontendMode: "preview"`
and `liquidityEnabled: false`. Invalid or incomplete registry input is rejected
before any provider request. Schema version 2 also pins the approved token
addresses, code hashes, symbols, names and decimals, rejects taxed/rebasing
policies and requires the wrapped-native token to match the deployment.

`LiveReadAdapter.connect` binds a supplied read provider to the configured chain
ID, genesis hash and deployment block hash; verifies the runtime code hash of
the factory, router, lens, collector and wrapped-native contract; and reads the
immutable/canonical factory and wrapper links plus the pair init-code hash. All
code and contract calls use one explicit snapshot block. Its hash is confirmed
after binding and after each live read so a reorganization cannot silently mix
states. The adapter exposes bounded lens pool pagination, `poolFor`, exact-input
quotes and raw native/ERC-20 balances. Every response carries the bound block
number/hash; missing or empty pools, unavailable quotes, invalid requests and
provider failures are explicit unavailable states. `LatestReadGate` lets each
future UI query stream reject aborted or superseded results even when an older
provider request completes later. Pagination remains capped at 64 pools, paths
at four hops and balance batches at 32 unique tokens.

Quotes, direct pool lookup and balances accept only registered tokens. Factory
pagination still advances across permissionless unreviewed pools, but filters
them from the returned display list and reports the filtered count so one such
pool cannot block discovery of later reviewed pools. Token code hashes are
rechecked at the same bound snapshot during adapter connection.

These helpers make only `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`,
`eth_getBalance` and `eth_call` requests. Balance owners must be supplied
explicitly; the adapter never discovers or requests a wallet account. Token
balances are integer base units formatted only with registry-pinned metadata.

No registry or RPC origin is bundled because none has been approved. Without an
explicit host gate, sample data remains the only UI data source and no live
request is made. The read adapter never requests accounts, approves tokens,
signs, submits a transaction or enables liquidity. Transaction confirmation and
receipt controls remain deliberately unimplemented.

`src/LivePools.tsx` is the first isolated UI consumer. Given an already bound
reader, it requests one bounded page and renders only registry-approved token
symbols and integer reserve amounts. Loading, provider-unavailable, stale and
unsupported-pool states are distinct; failures explicitly state that preview
fixtures were not substituted. A per-component latest-read gate and abort signal
prevent an older reader from overwriting a newer snapshot. The surface has no
wallet, swap, approval, deposit or withdrawal control.

`LivePools` is mounted only on the separate `#/live-pools` route after every
read-only host gate passes. It never replaces the existing preview pool screen.

`src/live-runtime.ts` supplies that composition boundary without selecting a
deployment. It fetches a versioned staging artifact manifest only from a
credential-free same-origin URL, verifies its configuration SHA-256, preview
target and registry schema, and accepts the registry RPC only when its HTTPS
origin is in an explicit host-provided allowlist. Its provider permits only the
five read methods used by `LiveReadAdapter`, validates each method's exact
parameters, omits credentials and referrers, rejects redirects and non-JSON or
oversized responses, and bounds requests with abortable timeouts.

`LiveReaderFactory` reloads the manifest and creates a new provider and bound
adapter for every refresh. `src/LivePoolsRuntime.tsx` owns and closes each such
session, rejects late sessions after a refresh, and fails closed without fixture
substitution.

`src/live-gate.ts` requires the host to inject a non-executable
`script#postern-live-read-config[type="application/json"]`. The element must be a
signed envelope whose payload schema requires version 1, `enabled: true`,
`mode: "read-only"`, a same-origin manifest path and one to eight unique HTTPS
RPC origins. It also pins the domain-separated canonical SHA-256 of the exact
signed manifest payload and carries a signed issuance/expiry window of at most
seven days; the required timeout is bounded. Unknown capabilities,
insecure/cross-origin URLs, queries, fragments and malformed or oversized input
disable the gate. A valid gate adds a link to the isolated read-only route.
Missing, invalid or unauthenticated configuration leaves the preview unchanged,
while directly visiting that route produces an explicit unavailable state
rather than falling back to sample pools. The live route has no wallet, swap,
approval or liquidity controls.

`src/live-auth.ts` authenticates both the gate payload and artifact manifest with
Ed25519 WebCrypto signatures over bounded canonical JSON. Separate domain tags
prevent a signature for either object from being replayed as the other. The raw
public key must be supplied as unpadded base64url at reviewed frontend build time
through `VITE_POSTERN_LIVE_READ_PUBLIC_KEY`; its SHA-256 is the envelope key ID.
The same build must pin a canonical positive integer in
`VITE_POSTERN_LIVE_READ_KEY_GENERATION`. Envelope schema 2 binds that generation
into the signed bytes and requires an exact match, so an old envelope cannot be
relabelled for a new generation even if an operator accidentally reuses a key.
The key is an explicit trust pin embedded in that build, not another value read
from the host configuration. A missing/malformed pin, unsupported Ed25519,
missing/noncanonical generation, incorrect key ID or generation, altered payload,
unknown envelope field or bad signature fails closed before registry or RPC use.
A different validly signed manifest is also
rejected unless its digest matches the signed gate, preventing the host from
substituting another release authorized by the same key. Key rotation therefore
requires incrementing the generation, changing the key pin, rebuilding the
frontend, and signing both objects with the matching generation. There is no
multi-key fallback: a removed key and every prior-generation envelope are
rejected by the new build. Gate expiry is checked again before every
manifest fetch, limiting replay of an older signed gate and manifest pair.

Before the manifest is fetched, `src/live-witness.ts` also requires a fresh
Ed25519 statement from the exact cross-origin HTTPS URL pinned into the build by
`VITE_POSTERN_LIVE_WITNESS_URL`. A separate witness public key and signer
generation are pinned by `VITE_POSTERN_LIVE_WITNESS_PUBLIC_KEY` and
`VITE_POSTERN_LIVE_WITNESS_KEY_GENERATION`. The statement names the live-read
key ID, sets its minimum allowed generation, and expires within 15 minutes. The
request omits credentials and referrer, refuses redirects, bypasses caches, and
is bounded to 4 KiB and five seconds. A missing, stale, malformed, wrong-key or
higher-floor statement disables live read before any manifest or RPC request.

This witness adds an independently controlled rollback boundary only for builds
that contain the check. It does not stop rollback to a frontend predating the
witness, coordinated rollback/compromise of both origins and keys, DNS/TLS
control, or replay within the short signed window. Immutable deployment and an
external transparency/monotonic publication system remain production gates.

The repository contains no public-key pin, witness endpoint, private key, signed host element or
deployment values. The staging build currently emits the unsigned artifact
payload; an external controlled signing step must wrap it before this runtime
will accept it. The [offline envelope tooling](../scripts/live-auth/README.md)
provides deterministic signing, exact-bundle verification and an explicit
generation-bound single-key rotation procedure without generating or storing a key. Supplying an
operationally reviewed public-key pin and custody process, then signing the gate
and manifest, are the next deployment gate. Browser Ed25519 support, CORS and
real-RPC behavior also require operational validation. The private signing key
must remain outside the frontend, artifact and repository.

## Devnet4 live route (`#/devnet4`)

A separate route for the Bloch L2 **devnet4** (chain 700771, zero-value tokens),
clearly labelled as not mainnet. It does not touch the preview's sample data or
positions.

- **Deployment record.** The route only uses the committed, reviewed record in
  `deployments/devnet4/mainnet-procedure-2pairs-20261016/` (`plan.json`,
  `config.json`, `gate-report.json`). `src/devnet4/record.ts` refuses it unless:
  - the plan was derived from that configuration (SHA-256 of its canonical JSON);
  - it targets devnet4 in rehearsal mode;
  - the schema-2 finality gate report says `liquidity-enabled` for the same chain,
    fee recipient, pairs and transactions.
- **Live reads.** `src/devnet4/chain.ts` re-checks the chain ID, the genesis hash,
  and that the finalized block is not older than the gate's. It also checks the
  runtime code hash of every contract and token in the record at the RPC's
  `finalized` block. It then reads reserves, reserve caps, decimals and symbols at
  that block.
- **Quotes.** Quotes come from the deployed `BDexLens.bestExactInput` at `latest`.
  - The lens refuses a route whose input would exceed a reserve cap, and it
    computes the slippage minimum.
  - Routes are direct, or go through WBLCH.
  - Amounts are integer base units.
- **Swaps.** The swap flow is explicit, through an injected EIP-1193 wallet:
  1. The wallet is asked to switch to (or add) chain 700771.
  2. An approval of exactly the input amount is sent when the allowance is short.
  3. `swapExactTokensForTokens`, `swapExactBLCHForTokens` or
     `swapExactTokensForBLCH` is called with the lens minimum and a deadline 30
     minutes ahead in wall-clock seconds.
  4. Each transaction has an explicit gas limit (the L2 RPC cannot estimate
     against `pending`). Receipts are polled for up to an hour, because there is
     one L2 block per settlement proof (10–20 minutes).

The settled RPC sends no CORS headers, so the app reads it through the dev or
preview server proxy at `/devnet4-rpc`. From a workstation:

```sh
ssh -N -L 18945:127.0.0.1:18945 ubuntu@<devnet4 host>   # keep open
npm run dev                                             # or: npm run build && npm run preview
# open http://127.0.0.1:5173/#/devnet4 (preview: http://127.0.0.1:4173/#/devnet4)
```

Configuration:

| Variable                      | Purpose                                                    | Default                              |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `DEVNET4_RPC_TARGET`          | Proxy target                                               | `http://127.0.0.1:18945`             |
| `VITE_DEVNET4_RPC_URL`        | URL the app reads; skips the proxy                         | `/devnet4-rpc`                       |
| `VITE_DEVNET4_WALLET_RPC_URL` | RPC URL offered to the wallet in `wallet_addEthereumChain` | `http://127.0.0.1:18945`, the tunnel |

Wallets make their own RPC requests, so the tunnel must stay open while signing.

**Tests.**

- `src/test/devnet4.test.tsx` runs the flow in jsdom against a mocked RPC and a
  mocked EIP-1193 provider.
- `src/test/devnet4.live.test.ts` is an opt-in, read-only check against the real
  RPC:

  ```sh
  DEVNET4_LIVE_RPC=http://127.0.0.1:18945 npx vitest run src/test/devnet4.live.test.ts
  ```

Testing with a real browser wallet extension remains a separate step.
