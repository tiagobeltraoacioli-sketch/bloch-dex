# Mobile wallet production hotfix

The Cloudflare Pages project `blochdex` was directly uploaded from an uncommitted
build. Its production deployment `0438e8a9-12b1-4180-885e-a68abf3f82bf` differs
from the repository's preview frontend and includes Pages Functions. Rebuilding
the preview must not replace that application.

This temporary Worker wraps the existing Pages origin on `blochdex.com` and
`www.blochdex.com`. It forwards existing requests with their original URL,
method, headers and body. It injects one same-origin script into GET `/` and
`/index.html` only when the shell matches its pinned SHA-256. Everything else,
including API calls and immutable assets, retains the original response.
Unknown future shells pass through unchanged. No signing, transaction, RPC,
liquidity, network or contract behavior is added.

The script adds a MetaMask Mobile link inside the existing connection dialog,
announces asynchronously injected providers to the existing discovery handler,
and opens only the connection dialog for the controlled `connect=metamask`
marker. Account access still requires selecting the wallet in the existing app.
All source lives in this repository; generated build files remain ignored.

## Build and validate

Use Node 24 and the locked frontend dependencies. From `frontend/`:

```sh
npm test
npm run build
npm run build:mobile-hotfix
npm run test:mobile-edge
```

Set `POSTERN_RELEASE_SHELL` to a captured original production HTML file when
running the edge tests to also check the exact release injection and headers.
The original shell hash is
`9c0774cff12d1546d7e851bec85efb11f7a7bcb3b61c9328441e93181704f7a2`.
The original `assets/index-DGP4G7Mx.js` SHA-256 is
`ce833898fd57cf2c1ed688a6c2b1da078df1afbc432f13c309979766ada3efc9`.

`scripts/check-mobile-hotfix.mjs` runs the captured production app through the
adapter in Playwright WebKit with an iPhone 13 viewport. Set
`POSTERN_RELEASE_DIR` to the capture directory, including `capture-sha256.json`,
and `POSTERN_PLAYWRIGHT_MODULE` to an installed Playwright module. The tested
tooling version is Playwright 1.58.2 with WebKit 26.0. Set `POSTERN_LIVE=1` to
repeat against the published domain. The test intercepts app navigation and
uses a mock provider; all RPC/backend requests are blocked, not broadcast.

## Publication and rollback

Deploy the generated Worker with `wrangler deploy --config edge/wrangler.jsonc`.
Authenticate through Wrangler locally; never commit or pass tokens in URLs.
Verify the root HTML has `X-Postern-Mobile-Hotfix: 1`, the injected script is
available, and the original JavaScript still matches the recorded hash.
Verify the native wallet dialog in a mobile WebKit browser and delayed provider
injection with a mock before asking for real-device MetaMask confirmation.
Browser emulation does not prove iOS app handoff or real-wallet authorization.

The original zone had no Worker routes before this hotfix. To roll back, remove
only the routes attached to `blochdex-mobile-wallet`; the unchanged Pages site
then serves requests directly again. Do not delete or roll back unrelated Pages
deployments. Remove this compatibility layer after the production source has
been reconciled and a complete reviewed frontend release includes the fix.
