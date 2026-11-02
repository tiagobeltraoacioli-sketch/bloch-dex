# Frontend hosting checklist (DEX-7, L2-17)

Scope: the PosternDEX site (full build, blochdex.com), the bridge site
(`VITE_BRIDGE_ONLY=1`, blochbridge.com), and the two RPC endpoints the pages
read (`l2rpc.blochl1.com`, and the Ethereum RPC named in
`deployments/mainnet/frontend.bridge.json`). Written by the round 10 frontend
security review (agent 176). Nothing here has been applied to any live zone.

Every step is a check the owner runs or confirms. A "no" anywhere blocks
publication of that site.

## 1. Build and release gate

1. Build from a clean checkout of the reviewed commit, with no `.env*` file in
   `frontend/` and none of `VITE_MAINNET_RPC_URL`, `VITE_BRIDGE_ETH_RPC_URL`,
   `VITE_DEVNET4_ROUTE`, `POSTERN_MAINNET_*` in the environment. Any of the
   override variables makes a local render build, which shows a "not for
   publication" banner and fails the gate.
2. Full site: `npm ci`, `npm test`, `npm run build`, then
   `npm run check:bundle -- dist`. Expect `0 hit(s)`.
3. Bridge site: `VITE_BRIDGE_ONLY=1 npm run build`, then
   `npm run check:bundle -- dist bridge-only`. Expect `0 hit(s)`, and
   `dist/_headers` starting with `# Bridge-only build`.
4. Record `sha256sum` of every file in `dist/` for each site. After
   publication, fetch each published file and compare (section 7). This is the
   substitute for SRI: scripts are same-origin (`script-src 'self'`), so the
   integrity question is whether the edge serves the reviewed bytes.

## 2. Security headers

Generated from `frontend/src/mainnet/headers.ts`; `src/test/hosting.test.ts`
keeps `public/_headers` (full site) and `hosting/_headers.bridge-only` (bridge
site) equal to the generator.

| Header | Full site | Bridge site |
|---|---|---|
| Content-Security-Policy | `default-src 'none'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'` + L2 RPC + Ethereum RPC + WalletConnect/Reown, `frame-src` WalletConnect verify, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, `object-src 'none'`, `upgrade-insecure-requests` | Same, without any WalletConnect/Reown origin, `frame-src 'none'` |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains` | same |
| X-Content-Type-Options | `nosniff` | same |
| X-Frame-Options | `DENY` | same |
| Referrer-Policy | `no-referrer` | same |
| Permissions-Policy | camera, microphone, geolocation, payment, usb, serial, hid, browsing-topics all `()` | same |
| Cross-Origin-Opener-Policy | `same-origin-allow-popups` (WalletConnect) | `same-origin` |
| Cross-Origin-Resource-Policy | `same-origin` | same |
| Cache-Control | `/` and `/index.html` `no-cache`; `/assets/*` `public, max-age=31536000, immutable` | same |

- `_headers` is applied only by Cloudflare Pages (and Netlify). If a site is
  served by a Worker, nginx or any other host, that host must send the same
  values for every path, including error pages.
- When the Ethereum RPC URL or the L2 RPC URL changes, regenerate the files
  (`npm test` shows the expected text) before building. The gate refuses a
  bundle whose published RPC is missing from `connect-src`.
- `style-src 'unsafe-inline'` stays: React style attributes and the Reown
  modal need it. It does not allow script execution.
- Open option (not applied): `require-trusted-types-for 'script'` on the
  bridge site only. It holds no third-party SDK, but it was not tested in a
  real browser session with a wallet.

## 3. Cloudflare zone settings (each site zone)

Account and DNS:

- Hardware-key 2FA for every Cloudflare account member; API tokens scoped to
  one zone and one permission; no Global API Key in use.
- Registrar lock on, DNSSEC on, CAA records naming only the CAs Cloudflare
  uses for the zone (`cloudflare.com` delegated CAs) plus the origin CA if any.
- No wildcard DNS records. Only the apex (and `www` as a redirect) for each site.

SSL/TLS:

- Encryption mode Full (strict). Always Use HTTPS on. Minimum TLS 1.2, TLS 1.3 on.
- HSTS: sent by `_headers`. Do not also enable the dashboard HSTS with other
  values. HSTS preload submission is an owner decision (it is hard to undo);
  if chosen, add `; preload` in `headers.ts` and submit only after a week of
  clean operation.

Features that inject or rewrite scripts (all must be off, or the CSP blocks
them, or worse, they run as third-party code on a wallet page):

- Rocket Loader: off.
- Email Address Obfuscation (Scrape Shield): off.
- Server-side Excludes: off.
- Automatic Signed Exchanges, Mirage, Auto Minify (if still listed): off.
- Web Analytics / Browser Insights automatic injection (RUM beacon): off.
- Zaraz: off. Cloudflare Apps: none installed.
- Transform Rules and Snippets: none that change HTML or response headers,
  except an explicit rule to add the section 2 headers if `_headers` is not used.
- Bot Fight Mode and challenge pages: allowed on the static sites; never on
  the RPC hostname (a challenge breaks browser JSON-RPC calls and CORS).
- Page Shield (script monitor): may be on; it only observes.

Caching: one Cache Rule per site, honouring origin cache headers; no "Cache
Everything" on `/` or `/index.html`; purge the whole zone after each publish.

## 4. Workers on blochdex.com (must be resolved before DEX-7)

The repository holds two Worker packages that run on `blochdex.com/*` and
`www.blochdex.com/*` (`frontend/edge/wrangler.jsonc`, the
`blochdex-mobile-wallet` Worker, and the `qr-release/` wrapper published as
version `18194346-…`). The wrapper imports a `previous-worker.mjs` that is not
in this repository, so its code is not reviewed. While those routes exist:

- every request to the mainnet DEX origin passes through unreviewed code that
  can change any response, including the CSP;
- `/` gets an injected banner linking to `/preview/`, an AppKit page for the
  staging chain 700771, served on the same origin as the mainnet DEX, so it
  shares localStorage (pending swaps, transaction history) and the origin a
  wallet trusts;
- the hotfix injects a script into a shell whose hash it pins; a new build
  does not match, but the Worker stays in the path.

Action: delete both Worker routes (or the Workers) from the blochdex.com zone
before the mainnet DEX build is published, or publish the mainnet DEX on a
hostname with no Worker route. Check with
`curl -sI https://blochdex.com/ | grep -i x-postern` (expect no output) and
`curl -s -o /dev/null -w '%{http_code}' https://blochdex.com/preview/`
(expect 404 or the DEX shell, never the QR preview).

blochbridge.com must have no Worker route at all.

## 5. RPC endpoints the pages read (L2-17)

- `l2rpc.blochl1.com`: nginx gateway as decided for L2-17, with
  `Access-Control-Allow-Origin` for any origin (round 2 decision), only
  `POST` and `OPTIONS`, a body size limit, per-IP rate limits, and read
  methods only (the gateway's allowlist). Same TLS rules as section 3. No Worker.
- Ethereum RPC for the bridge page: a provider URL without a secret in it (the
  URL is in the public bundle and in `connect-src`). Restrict it by `Origin`
  to the two site hostnames at the provider, with a per-IP limit. The page
  verifies chain ID 1, the Ethereum genesis hash, code hashes and signer sets
  on every snapshot, so a wrong endpoint fails closed, but it cannot detect an
  endpoint that lies consistently about state: choose a provider the owner
  trusts and do not use a public free endpoint.
- The DEX page's bUSDC hold status (`bridges[].status` in
  `frontend.network.json`) needs the Ethereum RPC and, after round 10, a
  `vaultCodeHash`; without it the network file is refused at build time.

## 6. WalletConnect / Reown

- The project ID `e263eead…00bb` is public. In Reown Cloud, set the allowed
  domains to `blochdex.com` (and `www`) only, so another site cannot use the
  project's name and verification status.
- The QR wallet requests `eth_accounts` and `eth_chainId` on the staging chain
  only and cannot send transactions; it is not part of the bridge site.

## 7. After each publish

Run from any machine (not a validator host):

- `curl -sI https://blochbridge.com/` and `curl -sI https://blochdex.com/`:
  every section 2 header present, exactly once, with the expected values.
- `curl -sI https://blochbridge.com/assets/<file>`: the immutable cache header
  and the same security headers.
- Fetch every file listed in the release's `sha256sum` record and compare.
- Open each site in a clean browser profile with the developer console open:
  no CSP violation, no request to an origin outside `connect-src`.
- `#/devnet4` on the full site shows the trade page (the devnet4 route is not
  in production bundles).

## 8. Anti-phishing

- The bridge page goes live only when `bridges[0].docsUrl` (the bridge status
  and help page) is published in `frontend.network.json`; held, cancelled and
  slow transfers point users there and state that nobody from the bridge asks
  them to sign, send, approve or share anything.
- Publish the official site and RPC hostnames on that status page and in the
  repository README; consider registering obvious look-alike domains.
- Never send users a link with a pre-filled recipient or amount: the pages
  read neither from the URL, and that must stay so.
