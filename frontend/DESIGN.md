# Postern DEX design: masonry and lamp

Version 3, November 2026 (second pass: the swap is the page, the primary action carries the lamp). Supersedes the look described in `VISUAL-STANDARD.md` (graphite and lime); the lime
survives as the lamp of the Bloch L2. Tokens live in `src/styles/tokens.css`; `node scripts/check-contrast.mjs`
checks them against WCAG AA.

## The idea

A postern is the small guarded gate in a fortification wall. The DEX is that gate: a finality gate decides what the
page shows, reserve caps are fixed in the constructor, and every transaction is one explicit step. So the interface is
a **wall**: quiet, monochrome stone, squared blocks separated by hairline mortar, nothing glowing. The single chromatic
colour that is not a status is the **lamp over the gate**: the accent of the network the user is on. The wall is the
same on every chain; only the lamp changes. Character: restraint, precision, trust. No colour gradients, no glass,
no neon, no invented numbers. The wall is drawn: faint stone courses behind the top of the page, fading to plain
ground; the swap card stands in an arch with the lamp at its crown.

Three rules follow. (1) Colour means something or it is absent: lamp = which network, green/amber/red/blue = state.
(2) There is one primary action on a screen; it is filled with the lamp colour (ink label on the bright lamps of the
dark theme, white on the deep lamps of the light theme, 4.5:1 or better on every network), and the line under it
always says what happens next. (3) Waiting, refusal and fail-closed states are first-class panels with the same care as the happy path, and a
safety message is never collapsed, truncated or dimmed.

## Hierarchy of a live route

The swap card is the page: one centred card (480 px, full width on phones) with large numerals, the token chips, the
gate between the two legs and the action directly under them. Before a quote the only action is Get quote; with a
quote the card shows rate and minimum received, the revert conditions and then Approve or Swap. Slippage and deadline
sit behind a Settings control that shows their values. Everything that is verification or reference (pools and caps,
network, deployment record, bridged assets) is one layer: summarised in the trust strip above the card and opened
from it as a side panel (a sheet on phones). The layer is docked on the page instead whenever a pool carries a notice
(excess above reserves, a side at its cap, the k ceiling, held bUSDC exits) or the route is not live, so a message
the user must see is never behind a click. The page's own description follows the card.

## Type

| Role      | Face                                                                                            | Use                                                    |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Display   | Fraunces Variable (optical size axis), weight 400 to 500                                        | page titles, dialog titles, empty states, the wordmark |
| Interface | Inter Variable, weight 400 to 600                                                               | everything else                                        |
| Data      | Inter with `tabular-nums` and slashed zero off; system monospace for addresses, hashes and code | amounts, tables, identifiers                           |

Scale (rem): 0.75 micro, 0.8125 small, 0.875 interface, 1 body, 1.125 lead, 1.375 title, 1.75 figure (a headline number inside a card), 1.75 to 2.5 display (fluid),
1.75 to 2.375 amount numerals (fluid). Labels are sentence case; small-caps labels use `font-variant-caps`, never
`text-transform`, so copied and machine-read text stays as written. Both faces are self-hosted (SIL OFL 1.1, licence
texts in `public/licenses/`), Latin subsets only.

## Colour

Dark is the default; light is finished, not derived. Text pairs are 4.5:1 or better on every surface, control borders,
focus rings and lamps 3:1 or better (158 pairs checked by the script).

| Token                                                | Dark                                    | Light                                   | Meaning                                                             |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `--bg` / `--surface` / `--surface-2` / `--surface-3` | `#0b0e0f` `#111516` `#171c1e` `#1f2629` | `#f2f0e9` `#fbfaf6` `#f0ede4` `#e6e2d6` | night wall to raised block / limestone                              |
| `--line` / `--line-strong` / `--control-border`      | `#252d30` `#364145` `#667579`           | `#ddd9cc` `#c4bfb0` `#858a81`           | mortar; the last is the border of anything you can operate          |
| `--text` / `--text-2` / `--text-3`                   | `#eceae3` `#a8b0ae` `#8a9492`           | `#14191a` `#485250` `#5d6765`           | primary, secondary, tertiary                                        |
| `--primary-bg` / `--primary-fg`                      | `#eceae3` / `#0b0e0f`                   | `#14191a` / `#f6f4ee`                   | the one primary action                                              |
| `--ok` `--warn` `--danger` `--info`                  | `#7fd6a0` `#e9b44c` `#f59585` `#9dbbea` | `#1a6640` `#7d5000` `#ad281f` `#245c9f` | finalized or safe; caution; refused or would revert; neutral notice |
| `--net`                                              | per network                             | per network                             | the lamp                                                            |

Lamps (dark / light): Bloch L2 `#c8fa72` / `#486f00`, Ethereum `#8fa3ff` / `#4257c9`, Linea `#61dfff` / `#006b85`,
Arbitrum One `#4db5ff` / `#0b67b2`, BNB Smart Chain `#f3ba2f` / `#7a5b00`, Base `#6e9bff` / `#0052ff`, OP Mainnet
`#ff6470` / `#d4001a`, devnet4 `#b9a6ff` / `#5b3fc4`, the sample-data preview uses the Bloch L2 lamp. The lamp appears in the lintel (a 2 px
line under the header), the network tile, the primary action, the focus ring, the gate and the crown of the arch, and
chart strokes. It is never body text and never the only carrier of a state. A status notice keeps body text in `--text`; its colour is in the rail, the icon
and the title.

## Space, radius, elevation

Space is a 4-point scale: 4, 8, 12, 16, 24, 32, 48, 64. Radii are squared stone: 4 (chips, inputs inside blocks),
8 (controls), 12 (blocks), 18 (the swap card and dialogs), and one arch (`999px` on top corners only) reserved for the
gate glyph and the brand mark. Surfaces are separated by 1 px mortar lines and carry a one-pixel top highlight; the swap card alone
casts a soft ground shadow. Things that float (popover, sheet, panel, dialog, toast) cast the overlay shadow, over a
scrim where modal.

## Motion

Purposeful and short: 120 ms for hover, press and focus, 200 ms for overlays entering (fade plus 8 px rise), one easing
(`cubic-bezier(.2,.7,.2,1)`). Motion explains state: the receive amount pulses while a quote is read and the numerals rise in when it arrives; the
quote block rises in; a tracked swap shows a bar filling toward its saved deadline; the mark of a mined transaction
pops once. The only loops are the spinner and the pulse, both tied to real waiting.
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
mobile tab bar. Controls: primary / secondary / quiet button, icon button, text input, amount input, token chip and token sheet,
disclosure (settings), expander (quote details),
segmented control, checkbox line, copy button, explorer link. Containers: block (card), swap card with legs and gate,
definition list, pool card with cap meter, table, dialog, bottom sheet (dialogs dock to the bottom below 640 px),
popover, disclosure. Feedback: trust strip, reference panel, deadline clock, notice (info / ok / warn / danger with rail and icon), status line, next-step line,
transaction timeline with state marks, skeleton, spinner, toast, empty state, badge and chip.

## Public networks: waiting and refusal states

The multichain site draws the same route with the lamp of the selected network. Four pieces are specific to it;
all of them use the existing blocks (rail notice, bordered status line, bar), none adds a colour.

- **Confirmation rule.** A course above the gate with the lamp on its rail ("How this network settles here"): the
  network's note in full, its first sentence (the rule) in the reading colour. Always on the page, in every state,
  never inside a disclosure. Where the rule is a depth the route says "confirmed", not "finalized".
- **Confirmation count.** Inside the tracked transaction, above the deadline: "In block N: 12 of 32 confirmations",
  a bar in the lamp colour (green when the depth is reached, marching while the transaction is in no block yet), what
  is left in blocks and time, and one line that the count is for orientation and the hold ends on the verified
  receipt. When the endpoint stops answering or limits requests the count says it is behind, on a warn rail.
- **Deadline countdown.** The saved deadline of a hold counts down second by second in tabular figures (m:ss, h:mm:ss),
  with its wall-clock time; the last five minutes take the warn colour; once passed it counts up and says what
  releases the hold. The same clock on the Bloch L2.
- **Read failure.** One block where the card would be: a serif title naming the kind (the endpoints disagree, a second
  endpoint has not confirmed, one endpoint is behind the other, the endpoint is limiting requests, the endpoint did
  not answer), the route's own
  sentence in full, what the page does about it, and one button. Disagreement is danger-toned and waits for the user
  ("Read again"); the other three are warn-toned, and the page reads again by itself after 15, 30, 60, then 120
  seconds, counting the wait down next to "Read now". A quote refused for the same reasons carries the same title
  inside the card's alert, says what helps there (nothing reads again by itself inside the card) and, where a newer
  block can help, offers Refresh.
- **Renewed snapshot block.** On public networks the page takes a new snapshot block every 30 seconds. The swap card
  is rebuilt for it, and must not look rebuilt: the user's inputs, the cursor, the open settings and quote details
  stay, and a quote that was on screen is read again at the new block. The renewal waits while the wallet is being
  asked and while a swap is held.

## Routes (all restyled)

| Route                               | What it is                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/mainnet`                         | the live route: network block, finality status, bridge-exit notices, swap card with every transaction state, pools with reserve caps, deployment record, bridged assets                                        |
| `#/trade`, `#/pools`, `#/portfolio` | the sample-data preview (labelled as such; its stylesheet `styles/preview.css` takes type, space, radius and colour from the tokens only, checked by `scripts/check-css.mjs`): swap with route comparison and chart, pool list and details, positions and activity, with their dialogs (token sheet, settings, wallet, network, liquidity, guide) |
| `#/live-pools`                      | read-only pool snapshot behind the host gate, and its unavailable state                                                                                                                                        |
| `#/devnet4`                         | zero-value devnet route (development builds only)                                                                                                                                                              |
| error boundary, local-render banner | full-page states                                                                                                                                                                                               |

## Screens of a live public route (round 20)

On the multichain site a live network has three screens, in the layout the sample-data preview established and
under a tab row at the top of the page (`#/<network>`, `#/<network>/pools`, `#/<network>/portfolio`): **Trade** is
the gate itself, unchanged, followed by a Market block (each pool's ratio, reserves and fee at the pinned block);
**Pools** is the preview's pool list (three figures, the table, the guide block, here the risks of providing
liquidity, always open); **Portfolio** is the preview's position page (pool share, the two amounts, details,
activity). Add and remove liquidity open the preview's dialog (a sheet on phones). The rule above holds on all of
them: where the preview drew a figure this page has no source for (price chart, 24-hour volume and fees, a value
in a currency, value history), the place says "Not available" with the reason, or is left out; nothing of the
preview's sample data is in the multichain bundle. Their styles are `src/styles/live-screens.css`.

## The Bloch L2 on the multichain site (round 20)

The Bloch L2 is the seventh name of the multichain site's header list and switcher, with its own lamp and glyph
(the gate's opening). Its route is the Bloch L2 route itself, as on the Bloch L2 site: one page, the gate with the
trust strip and the reference layer (pools with reserve caps, network, deployment record, bridged assets); it has
no tab row and none of the three screens above, no confirmation-rule course and no token note. While it is live
two lines stand above it in the page column, in the muted reading style of a token note: that the site offers
swaps only on this network, and which wallet connection works there; when the page's wallet is a mobile session,
the second line is a rail notice instead. The footer carries the Bloch L2's own line. On a narrow window the
header list scrolls sideways and the selected network's name is brought into its view; the list never moves the
page.

## What the design may not do

It may not change what is sent to a wallet or an RPC, weaken or hide a safety message, or show a number the page did
not read from the chain or from the reviewed files. Where there is no data source (volume, TVL, APR on live routes)
there is an empty state or nothing, never a placeholder figure.

## Art direction: the gate (version 4, agents 346 and 362, November 2026)

The owner's brief: "the most beautiful DEX frontend that has ever existed", keeping Postern's identity. Version 4
keeps every rule above and draws the idea literally.

- **The swap card is the gate.** `src/gate/GateArch.tsx` draws a segmental arch of dressed voussoirs (keystone,
  springers on two jambs) over the card in design units of a 480-wide gate; the jambs are the card's own
  `::before` / `::after`. The arch is decorative (`aria-hidden`); everything it shows is also written on the card.
- **The lamp on the keystone is the page's light source and its state.** `src/gate/lamp.ts` names the state from
  facts the card already holds (it decides nothing; nothing reads it back): `idle` (dim), `kindling` (a quote is
  being read; flickers), `lit` (a live quote), `pending` (a wallet request or a held swap; breathes, and a dashed
  ring stands round the lamp so the state is visible without motion), `settled` (the last tracked swap is final; a
  solid ring), `warn` (amber: attention, an unknown outcome under a hold) and `danger` (red: a refusal or a failure).
  The wall around the gate (`.wall-light`, placed at the lamp by `--lamp-x/--lamp-y`) and the stones of the arch
  (`.gate-fall`) are lit from it; the level and colour are typed custom properties so light eases between states.
- **Dark is the wall at night (the flagship); light is the same wall by day** (multiply instead of screen blending,
  lower reach). Each network keeps its lamp colour (`[data-network]` in `tokens.css`).
- **Marks.** In-house SVG coins for BLCH and every bridged asset (one base mark per asset plus a network badge) and a
  gate-shaped glyph per network (`src/marks/`); no third-party logos. Letters are drawn as paths so they never enter
  the page text.
- **Figures.** Amounts are the UI face with tabular, unambiguous digits (Fraunces made "0.01" read "0.0l"); a received
  amount wraps rather than truncate; digits roll in when a quote arrives (off under reduced motion).
- **The quote is a receipt**: scalloped edges, dotted leaders, the optional pool-depth curve computed from reserves
  already read (`src/gate/pool-depth.ts`), then the revert conditions, typeset as three lines with their contract
  reasons.
- **The passage**: a tracked swap shows Wallet, Sent and the chain's settled word as a track through the gate
  (`src/gate/Passage.tsx`).
- **Desktop: a verification rail beside the gate** (headline, a hold's recovery controls beside the tracked swap,
  the confirmation rule, and the trust strip, which stays in view under the header while the gate scrolls).
  **Phone: the gate first**: the first screen holds the arch, both legs and Get quote. Once quoted, Swap comes after
  the receipt and the revert conditions, in reading order. A sticky action bar was tried (iteration 5) and removed:
  it covered "Minimum received" on the first screen.
- **Finish**: footer link "Licences" to `/THIRD-PARTY-NOTICES.txt` on both sites; 404 page; print stylesheet (no
  arch, no light); `check-contrast.mjs` covers the new pairs.

The iterations, each with screenshots and a written critique, are in the coordination folder
(`agents/346-evidence/iter-N/CRITIQUE.md`).
