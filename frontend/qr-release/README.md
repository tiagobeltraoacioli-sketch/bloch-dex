# QR connection release — 16 September 2026

The React preview integrates Reown AppKit Core and WalletConnect Sign Client.
The official `npx @reown/appkit-cli` React/Ethers template was generated separately
and reviewed; the existing application was preserved. Dependencies are pinned.
The user-supplied project ID is public configuration, not a wallet credential.

Connection requests only address/network access on selected testnet chain 700771.
No signed login, swaps, allowances or liquidity operations are enabled. The wallet
independently displays origin verification and requires explicit account approval.
Closing or cancelling AppKit rejects the pending flow and late sessions are
closed. Disconnecting revokes the session, including wallet-initiated deletion.
The previous native dialog is suspended while AppKit is open so the QR is visible
and usable rather than hidden behind the browser's modal layer.

49 frontend tests and the TypeScript/Vite build pass. The real Reown relay paired
the preview and a mobile-size Postern wallet with a disposable account; wallet lock
disconnected the preview. No real asset movement was performed. Physical-phone
camera testing remains outstanding.

`package.mjs` requires the pinned existing Worker artifact from version
`4c73a2c4-c003-4bb7-9f2f-cd9cd9306945`, preserving its RPC recovery and L1 page.
The new wrapper replaces only `/preview/` assets and adds a clear QR-preview link
to the original root. A static asset binding keeps large AppKit bundles out of
Worker script literals. The existing Worker's active version was inspected before
packaging. Deployment remains to the existing `blochdex-mobile-wallet` Worker.

Published Worker version: `18194346-c93b-4665-81a4-86897cb83a4e`.
Public URL: https://blochdex.com/preview/?connect=qr
The public site passed actual AppKit/WalletKit pairing and lock/disconnect with a
disposable account. Wallet mobile pages on both domains passed public UI checks.
Rollback to Worker version `4c73a2c4-c003-4bb7-9f2f-cd9cd9306945` restores the prior
preview and removes the new root QR link without changing the Pages deployment.
