# Postern DEX design: masonry and lamp

Version 2, November 2026. Supersedes the look described in `VISUAL-STANDARD.md` (graphite and lime); the lime
survives as the lamp of the Bloch L2. Tokens live in `src/styles/tokens.css`; `node scripts/check-contrast.mjs`
checks them against WCAG AA.

## The idea

A postern is the small guarded gate in a fortification wall. The DEX is that gate: a finality gate decides what the
page shows, reserve caps are fixed in the constructor, and every transaction is one explicit step. So the interface is
a **wall**: quiet, monochrome stone, squared blocks separated by hairline mortar, nothing glowing. The single chromatic
colour that is not a status is the **lamp over the gate**: the accent of the network the user is on. The wall is the
same on every chain; only the lamp changes. Character: restraint, precision, trust. No gradients, no glass, no neon,
no invented numbers.

Three rules follow. (1) Colour means something or it is absent: lamp = which network, green/amber/red/blue = state.
(2) The primary action is monochrome (limestone on ink, ink on limestone) and its surroundings always say what happens
next. (3) Waiting, refusal and fail-closed states are first-class panels with the same care as the happy path, and a
safety message is never collapsed, truncated or dimmed.

## Type

| Role | Face | Use |
|---|---|---|
| Display | Fraunces Variable (optical size axis), weight 400 to 500 | page titles, dialog titles, empty states, the wordmark |
| Interface | Inter Variable, weight 400 to 600 | everything else |
| Data | Inter with `tabular-nums` and slashed zero off; system monospace for addresses, hashes and code | amounts, tables, identifiers |

Scale (rem): 0.75 micro, 0.8125 small, 0.875 interface, 1 body, 1.125 lead, 1.375 title, 1.75 to 2.5 display (fluid),
1.75 to 2.375 amount numerals (fluid). Labels are sentence case; small-caps labels use `font-variant-caps`, never
`text-transform`, so copied and machine-read text stays as written. Both faces are self-hosted (SIL OFL 1.1, licence
texts in `public/licenses/`), Latin subsets only.

## Colour

Dark is the default; light is finished, not derived. Text pairs are 4.5:1 or better on every surface, control borders,
focus rings and lamps 3:1 or better (130 pairs checked by the script).

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--bg` / `--surface` / `--surface-2` / `--surface-3` | `#0b0e0f` `#111516` `#171c1e` `#1f2629` | `#f2f0e9` `#fbfaf6` `#f0ede4` `#e6e2d6` | night wall to raised block / limestone |
| `--line` / `--line-strong` / `--control-border` | `#252d30` `#364145` `#667579` | `#ddd9cc` `#c4bfb0` `#858a81` | mortar; the last is the border of anything you can operate |
| `--text` / `--text-2` / `--text-3` | `#eceae3` `#a8b0ae` `#8a9492` | `#14191a` `#485250` `#5d6765` | primary, secondary, tertiary |
| `--primary-bg` / `--primary-fg` | `#eceae3` / `#0b0e0f` | `#14191a` / `#f6f4ee` | the one primary action |
| `--ok` `--warn` `--danger` `--info` | `#7fd6a0` `#e9b44c` `#f59585` `#9dbbea` | `#1a6640` `#7d5000` `#ad281f` `#245c9f` | finalized or safe; caution; refused or would revert; neutral notice |
| `--net` | per network | per network | the lamp |

Lamps (dark / light): Bloch L2 `#c8fa72` / `#486f00`, Ethereum `#8fa3ff` / `#4257c9`, Linea `#61dfff` / `#006b85`,
Arbitrum One `#4db5ff` / `#0b67b2`, BNB Smart Chain `#f3ba2f` / `#7a5b00`, Base `#6e9bff` / `#0052ff`, OP Mainnet
`#ff6470` / `#d4001a`, devnet4 `#b9a6ff` / `#5b3fc4`, sample-data preview: grey. The lamp appears in the lintel (a 2 px
line under the header), the network chip, the gate glyph of the swap card and chart strokes. It is never body text and
never the only carrier of a state. A status notice keeps body text in `--text`; its colour is in the rail, the icon
and the title.

## Space, radius, elevation

Space is a 4-point scale: 4, 8, 12, 16, 24, 32, 48, 64. Radii are squared stone: 4 (chips, inputs inside blocks),
8 (controls), 12 (blocks), 18 (the swap card and dialogs), and one arch (`999px` on top corners only) reserved for the
gate glyph and the brand mark. Surfaces are flat and separated by 1 px mortar lines; there are no shadows on the page.
Only things that float above it (popover, sheet, dialog, toast) cast a shadow, over a scrim where modal.

## Motion

Purposeful and short: 120 ms for hover, press and focus, 200 ms for overlays entering (fade plus 8 px rise), one easing
(`cubic-bezier(.2,.7,.2,1)`). The only loops are the spinner and the skeleton sweep, both tied to real waiting.
`prefers-reduced-motion: reduce` removes every transition and animation; skeletons become static blocks. Nothing moves
layout: loading placeholders reserve the height of what replaces them.

## Iconography

Lucide (already a dependency), 16 or 18 px, 1.75 stroke, always next to a text label or carrying an `aria-label`.
Original marks: the brand mark (an arch cut into a squared block, with a threshold line) and the gate glyph between
the two legs of a swap. Network glyphs are the first letters in a lamp-coloured tile; no third-party logos are bundled.
State is drawn by shape as well as colour: check in a circle (finalized), clock (pending), triangle (caution), octagon
(refused), question mark (unknown).

## Components

Shell: header (brand, route navigation, network switcher, wallet button, theme toggle), lintel, footer, skip link,
mobile tab bar. Controls: primary / secondary / quiet button, icon button, text input, amount input, token select,
segmented control, checkbox line, copy button, explorer link. Containers: block (card), swap card with legs and gate,
definition list, pool card with cap meter, table, dialog, bottom sheet (dialogs dock to the bottom below 640 px),
popover, disclosure. Feedback: notice (info / ok / warn / danger with rail, icon, title), status line, next-step line,
transaction timeline with state marks, skeleton, spinner, toast, empty state, badge and chip.

## Routes (all restyled)

| Route | What it is |
|---|---|
| `#/mainnet` | the live route: network block, finality status, bridge-exit notices, swap card with every transaction state, pools with reserve caps, deployment record, bridged assets |
| `#/trade`, `#/pools`, `#/portfolio` | the sample-data preview (labelled as such): swap with route comparison and chart, pool list and details, positions and activity, with their dialogs (token sheet, settings, wallet, network, liquidity, guide) |
| `#/live-pools` | read-only pool snapshot behind the host gate, and its unavailable state |
| `#/devnet4` | zero-value devnet route (development builds only) |
| error boundary, local-render banner | full-page states |

## What the design may not do

It may not change what is sent to a wallet or an RPC, weaken or hide a safety message, or show a number the page did
not read from the chain or from the reviewed files. Where there is no data source (volume, TVL, APR on live routes)
there is an empty state or nothing, never a placeholder figure.
