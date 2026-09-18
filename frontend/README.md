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

| Screen    | Behavior                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trade     | Token search/selection, pair reversal, amount validation, bounded route discovery and comparison, slippage settings, review dialog, chart period selection            |
| Pools     | Name/symbol search, liquidity/volume/fee sorting, local watchlist, empty results, pool details, deposit preview                                                        |
| Portfolio | Sample composition/history/activity, period selection, proportional withdrawal and deposit previews                                                                    |
| Shared    | Hash navigation, keyboard skip link, native modal dialogs, wallet discovery/connection/disconnect, network explanation and liquidity guide                             |

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

The adapter is intentionally not imported by `App.tsx`: sample data remains the
only UI data source, and no registry is bundled because none has been approved.
It does not fetch an RPC URL, request accounts, approve tokens, sign, submit a
transaction or enable liquidity. A future live UI must additionally implement
an approved registry/provider, explicit read-only UI state, live history, and
the remaining transaction confirmation/receipt controls listed above.
