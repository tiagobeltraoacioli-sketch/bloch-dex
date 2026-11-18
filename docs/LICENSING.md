# Licensing of this repository

Status: established on 2026-11-17 from the source headers, the repository's history and the publishers' own
files, fetched read-only that day. This is an engineering record, not legal advice; section 6 says what a lawyer
should still confirm. One value is the owner's to fill: the copyright holder's name (section 5).

## 1. What was found

- The top-level `LICENSE` was an MIT template that had never been filled: `Copyright (c) <year> <copyright holders>`.
- Every Solidity file (18 under `contracts/`, 38 under `script/` and `test/`) begins with
  `SPDX-License-Identifier: MIT`.
- `frontend/package.json` had no `license` field. There was no `NOTICE` and no list of third-party licences.
- History: 399 commits since 2026-09-08 by three author names of the same owner; no commit imports a third
  party's files as such. The origin of the contracts is stated in the files themselves and in
  `docs/AUDIT-SCOPE-DEX.md` section 3: "Upstream reference: Uniswap `v2-core` (0.5.16) and `v2-periphery`
  Router02"; `Math.sol` and `UQ112x112.sol` say "ported verbatim from the canonical Uniswap V2 core".

## 2. What the contracts derive from, and under which licence

| Upstream | Its licence, from the publisher | Fetched 2026-11-17 |
|---|---|---|
| Uniswap V2 Core, package `@uniswap/v2-core` 1.0.1 | `"license": "GPL-3.0-or-later"` in its `package.json`; its `LICENSE` file is the GNU General Public License, version 3, word for word (compared with `https://www.gnu.org/licenses/gpl-3.0.txt`: no difference) | `https://raw.githubusercontent.com/Uniswap/v2-core/master/package.json`, `…/LICENSE` |
| Uniswap V2 Periphery, package `@uniswap/v2-periphery` 1.1.0-beta.0 | the same two facts | `https://raw.githubusercontent.com/Uniswap/v2-periphery/master/package.json`, `…/LICENSE` |

The upstream Solidity files of 2020 carry no licence line of their own (`pragma solidity =0.5.16;` is their first
line); the package declaration and the `LICENSE` file are what license them.

| Files here | Derived from |
|---|---|
| `contracts/UniswapV2Pair.sol`, `UniswapV2ERC20.sol`, `UniswapV2Factory.sol`, `libraries/Math.sol`, `libraries/UQ112x112.sol`, `interfaces/IUniswapV2*.sol`, `interfaces/IERC20.sol` | v2-core (ports to Solidity 0.8.24 with the changes of `docs/AUDIT-SCOPE-DEX.md` 3.1 to 3.3; the two libraries verbatim) |
| `contracts/periphery/BDexRouter.sol`, `BDexLibrary.sol`, `periphery/interfaces/IBDexRouter.sol`, `IWBLCH.sol` | v2-periphery (`UniswapV2Router02`, `UniswapV2Library`, `IUniswapV2Router02`, `IWETH`) |
| `contracts/periphery/BDexLens.sol`, `TreasuryFeeCollector.sol`, `assets/BlochAsset.sol`, `assets/WBLCH.sol` | written for this project; no upstream is named in the files or the history. (`WBLCH` is a wrapped-native token of the usual shape; whether it was written with WETH9 open, itself GPL-3.0-or-later, could not be established from the repository. Under the conclusion below it makes no difference.) |

**Conclusion.** A work derived from GPL code may be distributed only under the GPL. The derived files are
therefore under **GPL-3.0-or-later**, whatever their header says, and so is everything distributed as one work
with them: the other contracts, which are compiled and deployed together with them, and the forge scripts and
tests, which import them. MIT is not available for these files; nobody but Uniswap's copyright holders can
grant that. On the six public chains (and on the Bloch L2) this has two practical consequences:

1. The source of the deployed contracts must be offered under the GPL to whoever receives the work. Publishing
   this repository, and verifying the contracts on each chain's explorer with licence "GNU GPLv3", does that.
2. The notices must be kept: `LICENSE`, `NOTICE`, `LICENSES/GPL-3.0-or-later.txt`.

**The header lines.** `SPDX-License-Identifier: MIT` in the files under `contracts/` is wrong for the derived
files. It was not corrected in this change: the contract sources are frozen byte for byte for the deployments
being prepared (pair init code hash `0x16bd5cad…6683`), and this change touches no byte of them. `LICENSE` states
that it governs where a header differs. The headers should be corrected to `GPL-3.0-or-later` at the next
revision of the contracts. (With `bytecode_hash = "none"` a comment is not part of the compiled code, so that
correction is expected to leave every code hash unchanged; this was not compiled and compared here.)

## 3. What the rest is under

| Path | Licence | Why |
|---|---|---|
| `frontend/` | MIT | The owner's own code; nothing in its files or history names an upstream it was copied from (it shares no file with Uniswap's interface, which is GPL). It uses contract ABIs, which are interfaces, not the contracts' code |
| `scripts/` | MIT | The owner's own tools. They read compiled artifacts (bytecode produced by the build) and embed no contract source |
| `deployments/`, `docs/`, top-level files | MIT | Configuration and documents of the owner |
| `test/vendor/bridge-v3/` | GPL-3.0-or-later here, as part of `test/` | Verbatim copies from the project's own bridge repository, for tests only (`SOURCE.txt`); the owner holds the copyright and may license them elsewhere as the owner wishes |

MIT was the owner's evident choice (the template). It is kept for everything the owner is free to license.

## 4. Third-party software in the page's bundle

`frontend/public/THIRD-PARTY-NOTICES.txt` lists every non-development package of `frontend/package-lock.json`
(254 packages: a superset of what a build contains) with its version and declared licence, and reproduces each
distinct licence text once (130 texts). It is written by `node frontend/scripts/third-party-notices.mjs`
(`--check` fails when it is out of date) and lies in `public/`, so both builds copy it into their output, where
it is served as `/THIRD-PARTY-NOTICES.txt`.

| Declared licence | Packages | Note |
|---|---|---|
| MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, Apache-2.0, "(Apache-2.0 AND MIT)", "(MIT OR Apache-2.0)" | 235 | permissive: keep the notices, which the file does |
| OFL-1.1 | 1 | the **Inter** typeface (`@fontsource-variable/inter` 5.3.0, Copyright (c) The Inter Project Authors). Bundling and serving the font files is allowed; the licence text must travel with them, which the file does; the font may not be sold by itself |
| "SEE LICENSE IN LICENSE.md" | 18 | **Reown AppKit** (9 packages, 1.8.23) and **WalletConnect** (5 packages, 4 of them in two versions: 9 entries): see below |

**Reown AppKit and WalletConnect are not open-source software.** Their licence files are the "Reown Community
License Agreement" (release date 25 August 2025) and the "WalletConnect Community License Agreement" (20 August
2025). The page uses them for the QR wallet connection (`frontend/src/qr-wallet.ts`). Read from the licence
text shipped in the packages:

- Distribution (section 2a): a product that uses them must show the notice "Portions © 2025 Reown, Inc. All
  Rights Reserved" in its notices or readme or the about section of the website, and provide a copy of the
  agreement. `THIRD-PARTY-NOTICES.txt` and `NOTICE` carry both. A visible mention on the page itself ("about")
  is the frontend line's to add.
- Network (section 2b): use must connect to Reown's own gateway unless Reown approves otherwise.
- **Limited commercial use (section 3): above 500 monthly active users or 2,500,000 RPC calls a month, "You must
  enter into and pay applicable fees and charges for a commercial license"; Reown may change the thresholds.**
- The grant is non-transferable and non-sublicensable: the repository's MIT licence does not, and cannot,
  extend to these packages. They are not copied into the repository; a build downloads them from npm.

Which build contains them, measured on this line's builds of 2026-11-17: the Bloch L2 site does (8 files of
`dist/assets` name Reown, 14 WalletConnect); **the multichain site does not** (no file of `dist-multichain/assets`
names Reown; it has no QR wallet connection). The redesigned frontend line must be measured again when it is
integrated.

Measured again on 2026-11-18 (agent 410, branch `codex/dex-reown-wallet-r20-20261118`): **the multichain site now
contains WalletConnect code.** Its mobile-wallet connection (`frontend/src/multichain/walletconnect.ts`) loads
`@walletconnect/sign-client` 2.25.0 and what that package depends on, in one lazily loaded file of
`dist-multichain/assets` (about 409 kB, 122 kB compressed; fetched only when a user presses "Connect a mobile
wallet"). It contains no Reown AppKit: no file of the multichain build names Reown or AppKit, and the site draws
its own QR code. So the WalletConnect Community License Agreement applies to the multichain site as well (the
notice, the gateway condition and the commercial threshold above); the Reown AppKit agreement still applies to the
Bloch L2 site only. The notice travels as before (`THIRD-PARTY-NOTICES.txt`, linked from the footer as
"Licences", and `NOTICE`). No dependency was added or upgraded: both packages were already in
`frontend/package.json` and `package-lock.json` is unchanged.

This is an owner matter (cost and terms), listed in the round's report.

## 5. The copyright holder (filled)

Owner decision of 2026-11-17: the copyright holder is **Bloch Inc.** Every file that names the holder carries the
exact line `Copyright (c) 2026 Bloch Inc.`: `LICENSE` (the GPL notice of the changes and the MIT text), `NOTICE`,
`LICENSES/MIT.txt`, `frontend/LICENSE`, `scripts/LICENSE`, `script/LICENSE`, `test/LICENSE` (the placeholder
`TBD-owner` is gone from all seven; the kit test "licensing: ..." in `scripts/multichain/multichain.test.mjs` checks
both). The licences themselves are unchanged. The year 2026 is the year of the first commit (2026-09-08) and of every
later one.

## 6. For a lawyer to confirm

- That GPL-3.0-or-later is acceptable to the owner for the contracts and tests (it is not a choice: section 2),
  and whether the owner wants to state "version 3 only" for the owner's own additions (allowed; "or later" was
  kept because upstream grants it).
- The Reown and WalletConnect agreements: the commercial thresholds, the gateway condition and the notice.
- Whether the product's name and logo need a trademark statement (none is made here).
