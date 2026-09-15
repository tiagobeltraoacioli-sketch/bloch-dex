# Native wallet account access

The frontend's `#/native` page connects to the native Postern extension through
`window.bloch`. It keeps native account state separate from the EVM wallet flow.
This implements account access only, not DEX signing, a deposit address, token
approval, pool creation or broadcasting. Existing sample markets remain previews.

The implementation follows the provider and gateway in `postern-wallet`:
`extension/provider.js` and `extension/lib/gateway.js`. The provider uses
`request(method, params)`, not EIP-1193's `request({ method, params })`.
After explicit selection, the page calls `bloch_connect`, checks its permission
result, and obtains the selected identity with `bloch_getAccount`. Refresh calls
only `bloch_getAccount`; explicit disconnect calls `bloch_disconnect` and clears
local state. Discovery does not request permission or accounts.

Provider metadata is an untrusted compatibility hint. An address is displayed
as wallet-reported data after a bounded syntax check; its checksum, ownership,
genesis and DEX deployment are not independently verified. The page supplies no
copy-deposit/QR flow and never treats this address as a USDT deposit destination.
Before future funds operations, the wallet must review and sign a native intent
and the host must authenticate the deployment and chain context.

Connection attempts have a 30-second local timeout. Dismissal, unmount and tab
hiding invalidate pending results; a late provider response cannot reconnect the
UI or start an additional account request. This does not cancel a permission
prompt already open in the extension. The interface tells the user to check it.
The current provider has no account-change subscription, so hiding the tab clears
the displayed identity and a visible account offers an explicit refresh.

MetaMask continues to use the separate EVM provider and mobile handoff. The
native page does not forward a native request to MetaMask. Native account access
on iPhone Safari still needs a compatible native mobile provider or transport.

Validation: run `npm test` and `npm run build` from `frontend/` with Node 24.
Tests cover protocol separation, explicit permission, refresh, disconnect,
malformed/absent identities, incompatible providers, timeout, dismissal, unmount
and tab hiding. Local WebKit checks exercise desktop connection with a simulated
native provider and an iPhone viewport without a provider, including horizontal
fit. These checks do not establish physical-device or real-extension acceptance.

The dedicated `/l1/` entry is packaged into the existing Cloudflare Worker,
without replacing the independently published EVM Pages build or its API handlers.
The Worker adds a menu marker only to the SHA-pinned original HTML shell; the
browser adapter changes its existing native navigation link to `/l1/`. Unknown
shells are returned unchanged. Native static routes accept only GET/HEAD, serve
only packaged assets, and use a CSP that disables network connections, framing
and form submission. The account provider communicates through the extension.

Build the release with Node 24, in this order (the main build clears `dist`):

```sh
npm test
npm run build
npm run build:native-page
POSTERN_NATIVE_PAGE=1 POSTERN_RECOVERY_ARTIFACT=edge/recovery-2026-09-14.json npm run build:mobile-hotfix
```

The explicit recovery artifact preserves the reviewed EVM testnet genesis
transition. Omitting it from a replacement Worker would revert that transition.
`dist/mobile-hotfix/release.json` records the script and native asset hashes.
Do not deploy the preview `dist/index.html` over the EVM Pages deployment.

Before publication, run `npm run test:mobile-edge` with `POSTERN_RELEASE_DIR`
and `POSTERN_RELEASE_SHELL` pointing to the verified original release capture.
Run `node scripts/check-native-page.mjs` and `node scripts/check-mobile-hotfix.mjs`
with that directory and `POSTERN_PLAYWRIGHT_MODULE` pointing to Playwright.
The native browser check runs the generated Worker against captured upstream
assets and tests navigation, desktop mock permission and iPhone without a
provider. Neither browser check opens a real wallet or sends transactions.

Publication on 2026-09-15: Cloudflare Worker version
`dcc662fa-3061-4f62-9ff4-1567944e538f` serves `/l1/` on both production hostnames.
The mobile adapter is `/__postern/mobile-wallet-fc9d46471d7f19cb.js`.
HTTPS checks matched every native asset and the mobile script to the local SHA-256
manifest, confirmed both menu markers, and compared the EVM bundle and deployment
configuration with the original capture plus only the reviewed genesis change.
Validation passed: 56 frontend tests, 9 edge tests (no skipped capture checks),
TypeScript and both page builds, Worker dry-run, and offline WebKit desktop/iPhone
checks. Real-extension and physical-iPhone acceptance remain outstanding.
No native DEX execution, deposits, bridge payouts or liquidity launch was enabled.
