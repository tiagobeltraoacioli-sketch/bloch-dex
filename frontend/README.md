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
npm run build
npm run preview
```

`npm run build` checks TypeScript and creates the static bundle in `dist/`.
Hash routes (`#/trade`, `#/pools`, `#/portfolio`) and relative asset URLs allow
hosting under a subdirectory without server-side route rewriting. Serve the
bundle over HTTP(S); opening `index.html` directly from disk is not supported.
No site or contract deployment is performed by these commands or by CI.

## Implemented interactions

| Screen    | Behavior                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trade     | Token search/selection, pair reversal, amount validation, direct and one-intermediate-token route comparison, slippage settings, review dialog, chart period selection |
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
outputs are unavailable. Routes are bounded, cycle-free and ranked by output.
This preview compares direct paths and paths through one intermediate token;
it does not claim to implement all route candidates accepted by `BDexLens`.

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
is bounded and provider-supplied icons are not loaded. UUIDs and names do not
prove a wallet's identity. MetaMask and other compatible **browser extensions**
can be selected; WalletConnect, mobile deep links and hardware-wallet-specific
flows are not included.

After an explicit click, the client uses only `eth_requestAccounts` and
`eth_chainId` from [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). It observes
account changes, network changes and disconnects, validates responses, ignores
cancelled requests and removes event listeners. Disconnect clears this app's
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
