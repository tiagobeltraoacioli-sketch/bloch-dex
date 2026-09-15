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

This source change does not replace the currently published EVM testnet deployment
or activate the native market. Deploying the complete preview bundle over that
deployment would remove its separate testnet integration; release integration
must preserve the deployed functionality before updating blochdex.com.
