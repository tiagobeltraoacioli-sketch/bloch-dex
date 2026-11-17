# PosternDEX on six public EVM chains: deployment package

Status: **prepared and rehearsed, not deployed** (2026-11-17; revised after reviews R309-MC-1 to MC-9 and
R328-1 to R328-8, and with the decisions of 2026-11-17 on the owner's open choices: section 2). Nothing in
this repository has sent a transaction to any public chain or testnet. The owner runs the commands of section 8
with the owner's own signer. **One step of the owner's is missing before the first chain: the signed proof of
control of the fee address (section 2.2); every pre gate refuses until it is recorded.**

This is an additional product line. The Bloch L2 deployment (protocol fee to the Bloch Inc Safe, mainnet gate,
bUSDC, audit commit `b6cd1a6`) is separate, is not changed by anything here, and keeps its own procedure
(`docs/MAINNET-700770-PACKAGE.md`). The tools of this package refuse the Bloch L2 chain ids.

Chains: OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain, Ethereum. Non-EVM networks (Tron, Bitcoin, Solana,
Stellar): `docs/MULTICHAIN-NON-EVM.md`.

## Contents

1. What is deployed, and what the factory allows
2. The choices: what was decided, and what only the owner can still do
3. Addresses
4. Chain facts verified on-chain
5. EVM compatibility: what was proven and how
6. Protocol fee: how it reaches the owner's address
7. Cost
8. Deployment, chain by chain (owner)
9. After deployment: the page
10. If something goes wrong
11. Rehearsals and how to repeat them
12. Risks the owner should know
13. Known issues

## 1. What is deployed, and what the factory allows

The contracts are the Bloch L2 release candidate, byte for byte: `UniswapV2Factory`, `BDexRouter`, `BDexLens`, and
`UniswapV2Pair` created by the factory. Compiler settings are the pinned ones (solc 0.8.24, EVM target `paris`,
optimizer 200 runs, no metadata hash); the pair init code hash is
`0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683` on every chain, and the tools refuse a build
that gives another. No contract was edited. Everything chain-specific is a constructor argument or configuration:

| Constructor argument | Value |
|---|---|
| Factory `feeTo` | `0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` on every chain (the owner's address, EIP-55 checked) |
| Factory `firstDepositor` | `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3`, the owner's depositing account, a key used for nothing else (section 2.1) |
| Factory reserve caps | none, on every chain (section 2.4) |
| Router wrapped native token | the chain's canonical wrapper (section 4) |

Not deployed: `WBLCH` (each chain has its own wrapped native token), `TreasuryFeeCollector`, a Safe.

**What the factory allows after deployment: nothing.** It has no owner, no fee setter and no cap setter.
`feeTo`, `firstDepositor` and the caps are fixed in the constructor.

- `feeTo` cannot be changed, ever. If the owner loses the key of `0x775a…0544`, the protocol fee of every pool of
  that factory keeps accruing to an address nobody controls. Moving the fee to another address means a new
  factory, new pair addresses, and moving all liquidity.
- `createPair` is open to anyone, for any two token contracts. A created pair is empty and worthless until its
  first deposit.
- `firstDepositor` is the only account that can make the first deposit of **any** pair of that factory, now and
  later (section 8, "Later pairs"). The pair checks it on the first mint only: once a pool is open, anyone can
  add liquidity to it and trade in it. The pair accepts the account as the sender of the mint **or as the origin
  of the transaction** (that is how the account opens a pool through the router). The second form is why the
  account must be a key used for nothing else: section 2.
- A cap applies to every pair that contains the capped token.

## 2. The choices: what was decided, and what only the owner can still do

The configuration held four open choices (`TBD-owner`). On 2026-11-17 the owner delegated them to the
coordinator as technical decisions and created the depositing key. They are now committed; `deploy.sh` still
refuses to broadcast if one is ever set back to `TBD-owner`.

| Choice | Decided | Where |
|---|---|---|
| `firstDepositor` | **`0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3`**, a key the owner created for this and nothing else. Written by `check-depositor.mjs --record`, never by hand (2.1) | `deployments/multichain.json` |
| Fee address, proof of control | One signed message, verified offline; **the owner's step, still to do** (2.2) | `deployments/fee-address-proof.json` |
| Fee address, the EIP-7702 delegation on Base | Accepted: the delegate is MetaMask's published, verified delegator (2.3) | `deployments/multichain.json` `feeTo.delegation` |
| `reserveCaps` | **`[]` on all six chains**: no caps (2.4) | `deployments/<chain>/chain.json` |
| Opening price | **The chain's market price**, read on the chain by the tool; the owner gives one amount (2.5) | `deployments/<chain>/chain.json` `openingPrice` |
| First liquidity | The owner's money and the owner's amount, above a stated minimum per chain (2.5) | not in a file |
| BNB Smart Chain's "USDC" | Listed, as **"USDC (Binance-Peg)"** with a note that Circle does not issue it (2.6) | `deployments/bnb-smart-chain/chain.json` |

What only the owner can still do: sign the fee-address message (2.2), fund the depositing account and send
the transactions of section 8, and write the copyright holder's name into the licence files
(`docs/LICENSING.md` section 5).

**Why first deposits are never open here (review R309-MC-1).** On a public chain a factory whose first deposits
are open lets anyone open the owner's pool first, with dust, at a false price; the owner's deposit then pairs its
native coin with almost no tokens and the attacker buys it. The reviewer's test took more than 9.6 of 10 native
that way, without any mempool race. With `firstDepositor` set, that first mint reverts, directly and through the
router, for every transaction that the depositing account did not send: shown by the forge tests
(`test/MultichainFirstDeposit.t.sol`), by every fork rehearsal and on each chain's own node (section 11).

### 2.1 The depositing key

**The rule and its reason (review R328-1).** The pair's rule is "the sender of the first mint is the first
depositor, **or the origin of the transaction is**". The contracts are frozen, so the second half cannot be
removed. It means: if the depositing account ever sends a transaction to another contract (a claim page, a token
with a transfer hook, another exchange's router), that contract can, inside that transaction, open any pair of
the factory that is not open yet, at any price, in the account's name. So the depositing account is a key that
has done nothing and will do nothing but the deposits this package prints.

**What the key can and cannot do.**

- It can do one thing: make the **first deposit of each pair** of this factory. Nobody else can.
- It holds funds only between the moment the owner funds it and that deposit. The LP shares can go to another
  account of the owner (`--to`), so it need not hold anything afterwards.
- After every pool the owner wants is open, it has **no power at all**: an open pool takes deposits and trades
  from anyone, and the key has no other right in any contract.
- **If it is lost before the pools are open**, those pairs can never be opened on this factory: no other
  account can make a first deposit, and the factory cannot be changed. The remedy is a new key, which is a new
  factory at new addresses, deployed again (section 10). Keep the keystore file and its password until the last
  pool is open, in two places.
- **If it is stolen before the pools are open**, the thief can open pools at a false price. That costs the owner
  the pair, not money: `prepare` says STOP on a pool it did not open, the gate refuses to record an opening it
  cannot prove, and the page never lists it (sections 8 and 10). A thief also takes whatever the account holds
  at that moment, so fund it right before each deposit and with that deposit's amounts only.
- It is **not** the fee address and has no claim on the protocol fee.

**How it was made (the owner did this on 2026-11-17; kept here as the procedure).** On a machine that can be
offline while the key is created, with Foundry installed. The directory is an example (it is where the owner
keeps this one); any private directory will do.

```
cast wallet new ~/Desktop/DEX-CHAVE-DEPOSITANTE depositante
```

`cast` asks for a password twice (nothing is shown while typing), writes one file, the encrypted keystore
(scrypt and AES, the standard Ethereum keystore format), and prints two lines: the file's path and
`Address: 0x…`. The private key is never shown and is never typed anywhere. To read the address again later:

```
cast wallet address --keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante
```

Then, online, check the address (an address, never the key or the file) and record it:

```
node scripts/multichain/check-depositor.mjs 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --record
```

The tool reads the six chains on every reviewed endpoint (at least two per chain must answer), read-only, and
says FIT only when the address has **no code, nonce 0, no pending transaction and no EIP-7702 delegation
everywhere**, is written exactly as EIP-55 writes it, and is none of: the fee address, the zero address, the
CREATE2 deployer, the rehearsal address, a delegate contract, an address the plan would deploy to, or **any
address written anywhere under `deployments/`** (a token, a pool, a feed, an earlier deployment). `--record`
then writes it into `deployments/multichain.json` (`firstDepositor`, with `firstDepositorCheck`: what was read,
on which endpoint, at which block). **That file is the one place the address lives**: the plan, the deploy
script's inputs, the gate and `first-deposit.mjs` all take it from there, and each refuses a mismatch:

| Reader | What it refuses |
|---|---|
| `lib.mjs` (every tool loads the file through it) | a `firstDepositor` that is not the recorded address, or has no record: a hand edit |
| `deploy.sh` and the forge script | planned addresses that are not the ones this depositor gives (`MC_EXPECT_*`), the zero address, the fee address |
| pre gate | code or a delegation at the account; any transaction from it while the factory is not deployed |
| post gate | a factory whose `firstDepositor()` is another address |
| `first-deposit.mjs` | the same, read again at the block of the deposit; code at the account |

Recorded on 2026-11-17 at 03:51:30 UTC (`firstDepositorCheck`): nonce 0, no pending transaction, no code, balance 0
on all 17 endpoints of the six chains (the first record, at 02:01:57 UTC, covered the 15 endpoints listed then).

**Using it.** It signs only the two transactions `first-deposit.mjs prepare` prints, with
`--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante` added (cast asks for the password). Nothing else,
ever: no other site, no claim, no other token, no transfer to a contract. It is not the deploying account
(section 8): deploying from it would break "nonce 0 before the factory exists", and the pre gate would say so.

**Retiring it.** When the last pool the owner wants is open and its post gate has passed: move anything left in
the account to another account of the owner (one plain transfer of the native coin per chain; LP shares only if
`--to` was not used), then delete the keystore file and forget the password. From then on the address can do
nothing, for anyone. Keep it instead only if the owner means to open **further pairs** on this factory later
(section 8, "Later pairs"): then the rule above holds for as long as it is kept.

What the tools do when the rule was broken anyway, or the key was used by someone else: a pool that is open when
`prepare` runs was not opened by the tool, and `prepare` says STOP; the post gate does not pass an open pool until
its opening is **proven** from its transaction (the pair's first mint, sent by the first depositor straight to the
router, with minimums equal to its amounts; `scripts/multichain/opening.mjs`); the page's record is written only
from such a report; and `add` deposits only into a proven pool, at the price the owner states. Every one of these
refusals is run in each fork rehearsal against a hostile contract (section 11). They prevent the loss; they do
not give the pool back: a pair opened by someone else stays open, at that factory, for ever (section 10).

### 2.2 The fee address: proof that the owner controls it

`feeTo` is `0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` on every chain and can never be changed. It has never
sent a transaction on OP Mainnet or Linea, so nothing on those chains shows that anyone holds its key. No
transaction is needed to show it: an address without code is controlled by the same key on every EVM chain, so
**one signed message proves control on all six**. The message is fixed (one line; it names the address, the six
chain ids and the purpose, under its own domain, so it is not valid for anything else):

```
node scripts/multichain/fee-proof.mjs message
```

prints

> PosternDEX fee address proof (postern.dex.multichain.fee-address-proof.v1). I control the address 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 and name it as the protocol fee recipient (feeTo) of the PosternDEX factory on the chains with ids 10, 8453, 42161, 59144, 56, 1. This message is not a transaction and authorizes no transfer and no approval.

The owner signs exactly that text **as a message** (`personal_sign`, EIP-191) with the fee address, once, in the
owner's own wallet. It costs nothing and sends nothing. Any "sign message" function does it; compare the text
the wallet shows with the text above before confirming. With a hardware wallet through Foundry:

```
cast wallet sign --ledger "$(node scripts/multichain/fee-proof.mjs message)"
```

With a browser wallet that has no "sign message" of its own (the delegate of 2.3 is MetaMask's, so the fee
address is presumably a MetaMask account): the tool writes a small page that asks the wallet for exactly this
signature. The page loads nothing, sends nothing and asks for no transaction; serve it on this machine only.

```
node scripts/multichain/fee-proof.mjs page --out /tmp/fee-proof-page
```

```
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/fee-proof-page
```

Open `http://127.0.0.1:8765/` in the browser that has the wallet, select the fee account, press the button,
confirm in the wallet, copy the signature (`0x` and 130 hex digits), and stop the server with Ctrl-C. (The page
was not exercised with a real wallet here; whatever it returns is checked by the next command, so a wrong
result cannot be recorded.) Then record the signature:

```
node scripts/multichain/fee-proof.mjs record --signature 0xSIGNATURE
```

The tool verifies the signature offline, in its own process, and writes `deployments/fee-address-proof.json`
only when it is valid. It is strict: exactly 65 bytes, `s` in the lower half of the curve order, `v` 27 or 28,
and the recovered address equal to the fee address; a smart-account signature (ERC-1271, ERC-6492) is refused,
because the proof is of the key. It starts no other program and takes no decision from an exit code. Commit
the file. **The pre gate of every chain refuses without a valid proof**; today all six pre gates fail on this
one check and pass every other (section 11). To check the recorded proof at any time:

```
node scripts/multichain/fee-proof.mjs verify
```

### 2.3 The fee address: the EIP-7702 delegation on Base

On Base the fee address carries the designator `0xef0100` + `63c0c19a282a1B52b07dD5a65b58948A07DAE32B`: the
account delegates its code to that contract. On the other five chains it has no code.

**What the delegate is** (established on 2026-11-17 from its publisher and from verified source, not from
memory):

- MetaMask's **`EIP7702StatelessDeleGator`, version 1.3.0**, of the MetaMask Delegation Framework: the code the
  MetaMask wallet puts behind an account when the user switches it to a "smart account". The publisher's
  deployment page lists it under v1.3.0 as `EIP7702StatelessDeleGatorImpl: 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`
  and names Ethereum, Binance Smart Chain, Optimism, Arbitrum One, Linea and Base among its chains
  (`https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md`).
- Sourcify holds an **exact match** of its creation and runtime code on all six chains
  (`src/EIP7702/EIP7702StatelessDeleGator.sol`, solc 0.8.23); `NAME()` and `VERSION()` read through the fee
  address on Base answer `EIP7702StatelessDeleGator` and `1.3.0`.
- Its runtime code is 11,185 bytes on all six chains and differs per chain only in immutables, so its hash does
  too: Base `0x6af675ac…97ba`, Ethereum `0x0b77e469…09ab`, OP Mainnet `0x076ce337…b246`, Arbitrum One
  `0xa6603bc6…17de`, Linea `0xeef4fc75…6082`, BNB Smart Chain `0x2f40923f…d55f` (each read from two endpoints;
  all in `deployments/multichain.json`, with the sources and the dates).

**Does anything that pays the fee run the delegate's code?** No. The frozen contracts pay `feeTo` in exactly
one place: `UniswapV2Pair._mintFee` calls `_mint(feeTo, liquidity)`, and `_mint` (`UniswapV2ERC20.sol`) adds to
`totalSupply` and `balanceOf[feeTo]` and emits `Transfer`. It makes no call to the recipient. The factory only
stores the address; the lens only reads its balance; no other contract of the package names it. LP shares are
plain ERC-20 balances without a receive hook, and so is USDC. So the fee **accrues** whatever code sits at the
address, on every chain. The delegate's code runs in one case only, and at the owner's own request: when the
owner **redeems** shares to the fee address in the native coin, the router sends the coin with a call, which
runs the delegate's `receive()`; that function is empty and accepts it. Every fork rehearsal of Base does this
redemption with the delegation in place (section 6), and the fee address receives exactly what its shares are
worth.

**What the delegation adds as risk.** Without it, only a transaction signed by the key moves the shares. With
it, the account also acts when its code is called by one of two contracts fixed in the delegate, MetaMask's
`DelegationManager` (`0xdb9B1e94…7dB3`) and the ERC-4337 EntryPoint (`0x00000000…a032`), and both of those
paths need a signature of the **same key**: a signed user operation, or a signed "delegation" (a typed message
that lets a named party act for the account within stated limits). The delegate has no owner, no other signer
and no storage of its own. So the key is still the only authority, but there are now two more **kinds of
thing the key can sign that move funds without a transaction of its own**: a delegation or a user operation
shown by a site as a "permission". And the account now depends on the correctness of the delegate's code (its
audits were not read here). An ordinary account has a small version of the first risk already (an LP share can
be approved by a signed EIP-2612 permit).

**Decision.** The delegation is **accepted**: the delegate is a published wallet delegator with verified
source. The gate enforces exactly that, per chain:

- a delegation to this delegate, holding the code hash recorded for the chain: accepted;
- **any other delegate, or this address with other code: the gate fails** ("not an identified delegate").
  Nothing is deployed on that chain until the owner clears the delegation or the new delegate is identified from
  its publisher and recorded in `feeTo.delegation.accepted`;
- the gate **records the designator it saw** in its report (`feeTo.designator`) and prints a **WARNING**, not a
  failure, when it is not the one recorded for that chain in `feeTo.delegation.recorded` (Base: the designator
  above; the other five: none). So a delegation that appears on another chain, or disappears from Base, is
  seen at the next gate run.

For the owner: treat the fee wallet as a vault. Sign no "permission", "delegation" or "smart account" request
with it on any site. Clearing the delegation on Base (the wallet's own setting that turns the smart account
off; how the wallet names it was not checked here) removes this risk and is the simpler state; it is not
required.

### 2.4 Reserve caps: none

`reserveCaps` is `[]` on all six chains: an ordinary constant-product exchange. The caps exist on the Bloch L2
to bound what a fault of the bridge could drain through the pool of a **bridged** asset. The assets listed here
are each chain's own native coin and a token issued on that chain, so that risk does not exist here. Two
further reasons:

- **Addresses.** A cap names a token address, which differs per chain. Without caps the factory and the lens
  have the same address on all six.
- **A pool capped on both sides leaks fees to strangers on a public chain.** The pair keeps
  `reserve0 x reserve1` under a ceiling; a swap's fee above the ceiling stays outside the reserves, where `skim`
  removes it. `skim` is open to anyone and pays the address the caller names. On the Bloch L2 a keeper skims to
  the Safe. On a public chain searchers will skim first, and the keeper cannot be given priority: the contracts
  have no place for it.

The reason is also written next to the value in each `chain.json` (`reserveCapsReason`).

### 2.5 Opening price and first liquidity

**The price is the market's, not a number typed by hand.** A pool that opens away from the market is traded
back to it within blocks, at the depositor's cost. `first-deposit.mjs prepare` therefore takes the opening price
from the chain itself, at the block of the deposit's preparation:

- **Two independent on-chain references**, configured per chain in `chain.json` `openingPrice.references`:
  a **Chainlink** feed pair (the native coin in USD divided by USDC in USD: prices aggregated from exchanges by
  an oracle network, independent of this chain's pools), and the **5-minute time-weighted price of an
  established pool** of the wrapped native coin and the listed token (a price one transaction, or one block,
  cannot set).
- **One pinned block, two endpoints.** Every read is pinned to one block hash and asked of the first two
  reviewed endpoints; an answer counts only when both give the same bytes.
- **The two references must agree within 1%** (`referencesAgreeBps`). If they do not (a feed that lags a fast
  move, a pool being pushed, a token off its peg), or a feed's answer is older than its heartbeat plus ten
  minutes, or the pool is not the one its publisher's factory names, or holds less than its stated depth, there
  is no market price and **nothing is printed**. Try again later.
- **The market price is the mean of the two.** The owner gives **one amount** (`--native 10`, or
  `--token 18000`) and the tool computes the other. If both amounts are given, they are refused when their
  price is **more than 0.5%** from the market (`maxDeviationBps`).

The references, each address taken from its publisher's own page on 2026-11-17 (URL, date and what was found
are recorded next to each address in `chain.json`); feeds from Chainlink's feed directory
(`https://docs.chain.link/data-feeds/price-feeds/addresses`), pools as the address the publisher's factory
returns from `getPool()`:

| Chain | Chainlink feeds (native / USD; USDC / USD) | Pool, 5-minute mean | Its depth when measured |
|---|---|---|---|
| OP Mainnet | `0x13e3Ee69…08c5`; `0x16a9FA2F…E0f3` | Uniswap v3 WETH/USDC 0.30% `0xc1738D90…bcA4` (factory `0x1F98431c…F984`) | 1,029 WETH (the 0.05% pool held 105) |
| Base | `0x71041ddd…Bb70`; `0x7e860098…bc6B` | Uniswap v3 WETH/USDC 0.05% `0xd0b53D92…F224` (factory `0x33128a8f…FDfD`) | 7,549 WETH |
| Arbitrum One | `0x639Fe6ab…b612`; `0x50834F31…4aD3` | Uniswap v3 WETH/USDC 0.05% `0xC6962004…E8D0` (factory `0x1F98431c…F984`) | 12,703 WETH |
| Linea | `0x3c6Cd9Cc…54dA`; `0xAADAa473…dCb5` | PancakeSwap v3 WETH/USDC 0.05% `0xd5539D03…2845` (factory `0x0BFbCF9f…1865`) | **18.8 WETH: thin** |
| BNB Smart Chain | BNB / USD `0x0567F232…2aeE`; `0x51597f40…A163` | PancakeSwap v3 WBNB/USDC 0.01% `0xf2688Fb5…12C4` (factory `0x0BFbCF9f…1865`) | 2,250 WBNB |
| Ethereum | `0x5f4eC3Df…8419`; `0x8fFfFfd4…18f6` | Uniswap v3 WETH/USDC 0.05% `0x88e6A0c2…5640` (factory `0x1F98431c…F984`) | 31,690 WETH |

Notes on the choices. The pool is the deepest of the publisher's pools for the pair, preferring a low fee tier
(its price stays within the fee of the market) where that tier is deep. Base's standard ETH / USD feed is
listed in Chainlink's directory as the secondary proxy of another entry; it describes itself as "ETH / USD"
on chain. Uniswap publishes no v3 deployment page for Linea, so Linea uses PancakeSwap's; **its pool is thin**
(about 34,000 USD a side), which is why the pool is never used alone: a pushed pool leaves the 1% band around
the feed and the tool refuses. On Linea the ETH / USD feed is updated on a 0.5% move or once a day, so it can
itself be up to 0.5% from the market: on a fast day the tool will say "no market price" more often there. On
BNB Smart Chain the feed prices Circle's USDC and the pool prices the Binance-Peg token itself; if the peg
slipped, the two would part and the tool would refuse. To see the market without preparing anything:

```
node scripts/multichain/market.mjs op-mainnet --native 10
```

What this does not do: it does not hold the price still. The printed deposit is valid for 20 minutes; send it
within a few, and run `prepare` again if you waited. A market that moves 0.5% in those minutes costs the
depositor about what a 0.5% opening error costs: a few thousandths of a percent of the deposit, taken by the
first arbitrage trade.

**The size is the owner's.** Nothing here funds a pool. The tool enforces a floor per chain
(`openingPrice.minimumNative`), with the reason next to it:

| Chain | Minimum first deposit | Reason |
|---|---|---|
| Ethereum | 1 ETH and its USDC | The first deposit costs about 2.54 million gas: 0.013 ETH at 5 gwei, which is 0.64% of a deposit worth 2 ETH. Below that the gas of opening, and of every later change, dominates |
| OP Mainnet, Base, Arbitrum One, Linea | 0.1 ETH and its USDC | Gas is negligible (under 0.001 ETH in every measurement). The floor keeps the pool above a few hundred dollars a side; below that a 100-dollar swap moves the price by tens of percent and the page's quotes are of no use |
| BNB Smart Chain | 0.5 BNB and its USDC (Binance-Peg) | as above (0.5 BNB was about 296 USD when measured) |

**The first share cannot be inflated, at any size.** The classic attack needs the attacker to be the first
minter; here only the depositing account can be, and the pair locks 1,000 share units for ever. The tool also
refuses a deposit that would create fewer than 10^12 share units, so that the locked units are at most a
billionth of the pool (0.1 ETH with its USDC creates about 4 x 10^12). A floor is not a recommendation: a pool
that is to be traded against needs far more, and the owner carries the price risk of whatever is put in
(section 12.1).

### 2.6 The token list, and BNB Smart Chain's "USDC"

Each chain starts with the wrapped native token and the chain's USDC. BNB Smart Chain has no USDC issued by
Circle: the token whose contract says `symbol() = "USDC"` there is Binance-Peg USD Coin, issued by Binance, with
18 decimals (section 4). **It is listed, under a truthful label.** Pairs are permissionless on this factory, so
anyone can make a pool with that token whether the page lists it or not: hiding it protects nobody, and a user
who meets it elsewhere under the bare name "USDC" is the one who is misled. So the token list and the page
show **"USDC (Binance-Peg)"**, 18 decimals, with one line: "USDC (Binance-Peg) is issued by Binance on BNB
Smart Chain, not by Circle, and has 18 decimals." The contract's own symbol stays in the configuration
(`symbol`, used by the pins and by `--pair WBNB/USDC`); what is shown is `label`, and the page never shows the
bare symbol for a token that has a label.

### 2.7 The plan

With these choices the plan is no longer a rehearsal ("reference") plan: `node scripts/multichain/plan.mjs all`
prints the addresses of section 3, and every rehearsal of section 11 was run with them, the depositing account
impersonated on loopback forks (no key of the owner's was used or needed). The former reference depositor
`0xb04cc27201710ee425739Cb5B97Ce4D4F21AAAD9` (an address nobody holds a key for) is still what the tools use
when the choice is set back to `TBD-owner`, and they refuse it as a real choice.

## 3. Addresses

Factory, router and lens are created by the deterministic CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`
(verified on all six chains: same runtime code, hash `0x2fa86add…4989`) with the salt
`keccak256("postern-dex.multichain.v1")` = `0xe5077402…c57a`. An address depends only on the deployer, the salt
and the init code (contract code plus constructor arguments), not on who sends the transaction.

With the committed choices (`node scripts/multichain/plan.mjs all`): the addresses the owner's deployment will
have.

| Contract | Address | Same on |
|---|---|---|
| Factory | `0x47D4ae3D6d8e2d8261Ee7beEF510a217Bf4a4C50` | all six |
| Lens | `0x5709FF514a909aD0D994eC73D6128F38bF4F1Ca6` | all six |
| Router | `0xc1D01eF14c0Cfe961f548398f9b12CfDC71172C9` | OP Mainnet and Base (both use the WETH predeploy `0x4200…0006`) |
| Router | `0xFf5f74c4Ca90Ae6024a29175c6d9d92CbD51C5E1` | Arbitrum One |
| Router | `0xf6046184F7267f0872BaB182C661f1C85695cAE2` | Linea |
| Router | `0x605E6b76402FF050BddC903Ea2326451272f7e32` | BNB Smart Chain |
| Router | `0x8A1DdC0BAE18A038D4E5Bb088eeDcdE10b61db53` | Ethereum |

The first pair of each chain (created by the first deposit): OP Mainnet `0xf948448d0d253B26EAFDf33Ffe45b5C85577E99E`,
Base `0x1807A84b90C535F8AF4d76634C6bD792A80B496F`, Arbitrum One `0x5D1885394A404b3e4f32432b68dacf3c19EDedE2`,
Linea `0xe99683328159b896F596cCF742b446e32b1E8205`, BNB Smart Chain `0x7CC3289655f5aA3147Dd8538b089Ee760c2c8851`,
Ethereum `0x03DCe4f378e64B4620ba8b9791b1d45245505Cd8`.

Why the router differs: the wrapped native token is a constructor argument, and it has another address on each
chain except the two OP Stack chains. Pair addresses differ everywhere, because token addresses differ. (These
addresses are not those of earlier editions of this document, whose plans had the zero address, the fee address
and then a keyless rehearsal address as `firstDepositor`.)

**These addresses follow from the choices.** Another `firstDepositor` or any cap is another factory init
code, so another factory address, and with it another router and lens. The gate and the page take the addresses
from the plan, never from this table.

Because the addresses do not depend on the sender, anyone can create the same contracts first by sending the same
bytes. The result is the identical contract with the identical `feeTo`: harmless. `deploy.sh` skips a step whose
address already holds code, and the gate then checks that code like any other.

## 4. Chain facts verified on-chain

Read from two public endpoints per chain on 2026-11-16 (`node scripts/multichain/gate.mjs <chain> pre --reference`:
PASS on all six). Each token is pinned by address, runtime code hash, `name()`, `symbol()` and `decimals()`.

| Chain | Id | Wrapped native | Listed token | Source page fetched and compared (2026-11-16) |
|---|---|---|---|---|
| OP Mainnet | 10 | WETH `0x4200000000000000000000000000000000000006` (predeploy) | USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, 6 decimals | WETH: `https://specs.optimism.io/protocol/predeploys.html` (predeploy table, WETH9). USDC: `https://developers.circle.com/stablecoins/usdc-contract-addresses` (row "OP Mainnet") |
| Base | 8453 | WETH `0x4200000000000000000000000000000000000006` (predeploy) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals | WETH: `https://docs.base.org/base-chain/network-information/base-contracts` (Base Mainnet table, WETH9). USDC: Circle's page (row "Base") |
| Arbitrum One | 42161 | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` (upgradeable proxy) | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, 6 decimals (native, not USDC.e) | WETH: `https://docs.arbitrum.io/build-decentralized-apps/reference/contract-addresses` ("L2 Weth"). USDC: Circle's page (row "Arbitrum") |
| Linea | 59144 | WETH `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` | USDC `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`, 6 decimals | WETH: Linea's own token list, `https://raw.githubusercontent.com/Consensys/linea-token-list/main/json/linea-mainnet-token-shortlist.json` (Wrapped Ether, type native); the `docs.linea.build` pages reached did not show the address. USDC: Circle's page (row "Linea") |
| BNB Smart Chain | 56 | WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | "USDC" `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, **18 decimals, Binance-Peg, not issued by Circle** | Both: Binance's public network list, `https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll` (coins WBNB and USDC, network BSC); the `docs.bnbchain.org` pages reached did not show the WBNB address. Circle's page has no BNB Smart Chain row |
| Ethereum | 1 | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals | WETH: `https://ethereum.org/en/wrapped-eth/` ("canonical implementation of WETH"); the same address is "L1 Weth" on Arbitrum's page. USDC: Circle's page (row "Ethereum") |

Each address in the table was found on the page named, fetched read-only on 2026-11-16; the URL, the date and what
was found are recorded next to each address in `deployments/<chain>/chain.json` (`sourceChecked`). Two sources are
not the issuer's documentation in the strict sense: Linea's WETH comes from Linea's token list on GitHub, and
WBNB and Binance-Peg USDC from Binance's own network list (Binance issues that token and runs the chain). WETH on
Ethereum has no issuer; ethereum.org is the reference used. The on-chain identification of the first edition still
holds: name and symbol as listed, 18 decimals, and the native coin held at the time of reading (2,071,341 ETH on
Ethereum, 3,592 ETH on Linea, 1,567,925 BNB). The router's wrapped token cannot be changed after deployment.

Other facts:

- **Fee address.** An externally owned account on every chain. Transactions seen from it: Ethereum 223, BNB Smart
  Chain 242, Arbitrum One 11, Base 1, Linea 0, OP Mainnet 0. **On Base it carries an EIP-7702 delegation** to
  `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`: the key still controls the account, and code runs at the address
  when it is called. The fork rehearsal and the simulation on Base's own node show that it receives the native
  coin and redeems its fee shares in that state. The delegate is MetaMask's published `EIP7702StatelessDeleGator`
  1.3.0, verified; what it is, what it changes and what the gate does about it are in section 2.3. The fee
  address is not the depositing account, so this delegation has no part in the opening of a pool. That the
  owner holds the key is shown by a signed message, not by these counts (section 2.2).
- **BNB Smart Chain has no Circle-issued USDC.** The token with the symbol USDC is Binance-Peg USD Coin, issued by
  Binance, with 18 decimals. It is listed under the label "USDC (Binance-Peg)", never as plain USDC (section 2.6).
- **USDC is an upgradeable proxy whose issuer can pause it and blacklist addresses.** The pinned hash is the
  proxy's. A blacklisted pair address could not pay out USDC. This is USDC's own risk on every exchange.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` exists on all six; on Linea its code hash is another
  build's (`0x8ec8aa5d…99ad`), pinned per chain and checked by a `getChainId()` call.
- **Block 0.** Not every public node serves it any more (history pruning). The gate needs it from at least one of
  the two endpoints; the page asks the next endpoint when one does not serve it.

## 5. EVM compatibility: what was proven and how

| Question | How it was answered | Result |
|---|---|---|
| Does the bytecode need an opcode some chain lacks? | Opcode walk of the runtime and init code of factory, router, lens and pair (`scripts/multichain/multichain.test.mjs`) | No opcode newer than the Paris target: no PUSH0, no transient storage, no MCOPY, no blob opcodes. The pair's lock is a storage slot |
| Does the chain's own node software execute the deployment and the whole flow? | `scripts/multichain/simulate-chain.mjs`: one read-only `eth_simulateV1` request to a public endpoint of each chain. Nothing is signed or sent | PASS on all six: op-reth (OP Mainnet), Base's reth, Nitro (Arbitrum One), Linea, BNB Smart Chain's geth, reth (Ethereum). CREATE2 returns the planned addresses; deposit, swaps both ways with the native coin and with the wrapped token, protocol fee, redemption by the fee address, skim and exit all succeed |
| Does the opening of a pool hold against someone else's transaction (review R309-MC-1)? | The same simulation and every fork rehearsal: a stranger creates the pair and tries the first mint and a first deposit through the router; then the first depositor opens the pool with minimums equal to the amounts | Both hostile calls revert `BDEX: FIRST_DEPOSITOR` on all six chains' own nodes and on all six forks; the pool opens at exactly the intended amounts |
| What if the depositing account itself is led to call a hostile contract (review R328-1)? | Every fork rehearsal, on a snapshot: the account calls a contract that opens the planned pool at 1 native = 2 tokens inside that transaction | The pair accepts it (frozen contracts). Then `prepare` says STOP, the post gate fails without and with that transaction named as the opening, `verify` fails, `add` prints nothing, no record can be written: on all six forks. Nothing of the owner's is deposited |
| What if someone sends tokens to the pair's address before the deposit (reviews R328-2, R328-3)? | Every fork rehearsal, on a snapshot: one base unit; then 1% of a side; then the 1% sent after `prepare` and before the deposit | One unit does not block `prepare`; 1% does, with the `skim` command; sent in front of the deposit it joins the pool as a gift owned by the depositor's shares, and `verify` and the gate prove the opening and report the gift and the 1% price move |
| Does the owner's command work against the chain's real state? | `scripts/multichain/rehearse-fork.mjs`: an anvil fork per chain, `deploy.sh broadcast` with a throwaway key, the post gate, then the flow with signed transactions | PASS on all six (section 11) |
| Do chain-dependent opcodes behave as the contracts expect? | The code uses TIMESTAMP (deadlines, price accumulators), CHAINID (LP permit domain), ORIGIN (first-deposit rule), NUMBER and BLOCKHASH (anchored swaps, lens) | Deadlines, permits' chain id and the flow work on all six nodes. **Anchored swaps (`swap…Anchored`) revert `BDEX: ANCHOR` on Arbitrum One** when given the block number and hash its RPC reports, because there `block.number` and `blockhash` do not refer to Arbitrum's own blocks. They work on the other five. The page does not use anchored swaps; a direct caller on Arbitrum One cannot |
| Does the unchanged test suite hold under later EVM rules? | `forge test` compiled for `shanghai`, `cancun` and `prague` | 243 of 245 pass on each; the 2 that fail are the tests that pin the Paris bytecode's pair init code hash, which is their purpose. The deployed bytecode stays the Paris build |
| Rollup fees | Read from each rollup's own oracle (section 7) | Included in the cost table |

Not proven, and why:

- Transactions really signed, included and charged on the public chains: nothing was sent, by rule.
- Linea's prover limits for a real transaction: the simulation ran on a Linea node, and Linea's own gas estimate
  (`linea_estimateGas`) accepted the factory deployment, but a real inclusion was not seen.
- A real wallet. The page rehearsal uses a simulated wallet.

Found on the way: a wallet's gas estimate made in the same second as the pair's last update can be about 44,000
gas short, because the transaction, one block later, writes the two price accumulators for the first time. The
page states its own gas limits (250,000 per hop, 100,000 for an approval) and does not use an estimate. Someone
who trades through another tool right after the first deposit should add gas.

## 6. Protocol fee: how it reaches the owner's address

The fee is the canonical one: one sixth of the growth of `sqrt(reserve0 x reserve1)`, that is 0.05% of the volume
out of the 0.30% swap fee. It is not paid per swap. At the next liquidity event of the pool (a deposit or a
withdrawal by anyone), the pair mints LP shares to `feeTo`. So:

- the fee accrues **as LP shares of each pool, held by `0x775a…0544`**, with no transaction of the owner;
- it stays invested in the pool and earns swap fees itself until redeemed;
- to turn it into tokens the owner redeems the shares, like any liquidity provider.

**No keeper is run, and none is needed.** Nothing has to be collected for the fee to be the owner's. A keeper that
skims excess to the fee address, as on the Bloch L2, makes sense only for capped pools (section 2) and would lose
the race to searchers on a public chain. The Bloch L2's monitor is not used either; `gate.mjs <chain> post` can be
run again at any time as a read-only check that the deployment is still the planned code.

Measured in each fork rehearsal, with the rehearsal's own figures (a pool of 10 native and 30,000 token units,
six swaps: 600 token units (the second half of the reviewer's attack, section 11), 1 native, 3,000 token units, 1 wrapped, 2,000 token units and 0.1 native; then one more deposit). The fee address's shares after that deposit
were worth:

| Chain | Fee shares worth | Redeemed by the fee address |
|---|---|---|
| OP Mainnet | 0.000961 ETH + 2.809224 USDC | 0.000961 ETH + 2.809224 USDC, in two transactions of 255,764 gas |
| Base | 0.000961 ETH + 2.809224 USDC | 0.000961 ETH + 2.809224 USDC, in two transactions of 257,912 gas |
| Arbitrum One | 0.000961 ETH + 2.809224 USDC | 0.000961 ETH + 2.809224 USDC, in two transactions of 268,538 gas |
| Linea | 0.000961 ETH + 2.809224 USDC | 0.000961 ETH + 2.809224 USDC, in two transactions of 268,673 gas |
| BNB Smart Chain | 0.000961 BNB + 2.809224 USDC | 0.000961 BNB + 2.809224 USDC, in two transactions of 260,587 gas |
| Ethereum | 0.000961 ETH + 2.809224 USDC | 0.000961 ETH + 2.809224 USDC, in two transactions of 265,212 gas |

The fee address received exactly what its shares were worth; on Base it did so with its EIP-7702 delegation in place.

On each chain's own node (simulation, read-only; five swaps, without the 600 token units), fee shares worth: OP Mainnet 0.000897 ETH + 2.554720 USDC; Base 0.000897 ETH + 2.554720 USDC; Arbitrum One 0.000889 ETH + 2.577511 USDC; Linea 0.000897 ETH + 2.554720 USDC; BNB Smart Chain 0.000897 BNB + 2.554720 USDC; Ethereum 0.000897 ETH + 2.554720 USDC. Arbitrum One differs because its anchored swap reverted there (section 5), so that pool saw one swap less.

To see what has accrued (read-only), per pool:

```
cast call PAIR_ADDRESS "balanceOf(address)(uint256)" 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 --rpc-url RPC_URL
```

To redeem (the owner's wallet, two transactions: approve the router for the pair's shares, then remove liquidity;
`SHARES` is the balance above, `MIN_TOKEN` and `MIN_NATIVE` the owner's minimums, `DEADLINE` a Unix time):

```
cast send PAIR_ADDRESS "approve(address,uint256)" ROUTER_ADDRESS SHARES --rpc-url RPC_URL --ledger
```

```
cast send ROUTER_ADDRESS "removeLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" TOKEN_ADDRESS SHARES MIN_TOKEN MIN_NATIVE 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 DEADLINE --rpc-url RPC_URL --ledger
```

The function names say `BLCH` on every chain: it is the release candidate's name for "the native coin". Shares
minted by the fee are only ever minted at a liquidity event, so a pool nobody deposits into or withdraws from
shows no new shares until someone does; the owner's own redemption is such an event and settles what is pending.

`skim` is open to anyone on every chain. A token sent to a pair by mistake goes to whoever calls `skim` first, to
the address they name. This was shown in every rehearsal and is the canonical behaviour.

## 7. Cost

Execution gas is the fork rehearsals' receipts: the same bytes the owner sends. Three transactions: factory, router
and lens through the CREATE2 deployer. No pair is created at deployment (section 8); the first deposit creates it.

| Step | Gas |
|---|---|
| Factory | 2,617,692 |
| Router | 4,082,527 to 4,082,743 |
| Lens | 2,261,269 |
| **Total** | **8,961,488 to 8,961,704** |

In native coin, at the gas price each chain's node reported at the time of the run, with the rollup's data fee read
from its own oracle (`scripts/multichain/cost.mjs`, 2026-11-17, 00:50 to 00:56 UTC):

| Chain | Gas price used | Data fee | Total |
|---|---|---|---|
| OP Mainnet | 0.001030 gwei | 0.000000385 ETH | **0.000010 ETH** |
| Base | 0.006000 gwei | 0.000000252 ETH | **0.000054 ETH** |
| Arbitrum One | 0.020068 gwei | 57,218 gas added | **0.000181 ETH** |
| Linea | 0.039607 gwei | in the gas price | **0.000355 ETH** |
| BNB Smart Chain | 0.050000 gwei | none | **0.000448 BNB** |
| Ethereum | 0.115943 gwei | none | **0.001039 ETH** |

Gas prices were low at that hour. A real deployment pays the price of its own hour; plan with the figures that
follow, not with the table. For Ethereum, execution gas only: 0.0090 ETH at 1 gwei, 0.0448 ETH at 5 gwei, 0.1792 ETH at 20 gwei, 0.4481 ETH at 50 gwei. The deploying account needs that much
native coin on each chain, plus a margin. It can be any account; it does not have to be the fee address or the
first depositor.

After deployment: the first deposit, which also creates the pair, costs 2,524,000 to 2,540,000 gas (measured on the
forks; the pair's creation is most of it; 270,000 to 287,000 when someone had already created the pair), its
approval 53,000 to 60,000, a later deposit 179,000 to 197,000, a swap 104,000 to 192,000.

## 8. Deployment, chain by chain (owner)

Order: cheapest first, so that a mistake is found where it costs least: **OP Mainnet, Base, Arbitrum One, Linea,
BNB Smart Chain, Ethereum.** Finish one chain, including its opened pool and its second post gate, before starting
the next.

Needs: this repository at the reviewed commit, Foundry (forge, cast), Node 24, `frontend/node_modules` installed
(`npm ci --ignore-scripts` in `frontend/`), and a signer forge supports (`--ledger`, `--trezor`, or
`--account NAME` for an encrypted keystore). Never put a private key on a command line.

Once, before the first chain. The choices of section 2 are made and committed. What is left is the owner's
signature for the fee address (section 2.2: `fee-proof.mjs message`, sign it with the fee address,
`fee-proof.mjs record --signature …`, commit the file), and a look at the plan: its addresses must be those of
section 3.

Two accounts sign in this procedure, and they are different accounts: the **deploying account** (any funded
account of the owner; steps 1 and 2) and the **depositing account** (`firstDepositor`; step 4 only).

```
node scripts/multichain/plan.mjs all
```

For each chain, with its key in place of `op-mainnet` (`op-mainnet`, `base`, `arbitrum-one`, `linea`,
`bnb-smart-chain`, `ethereum`):

Step 1. Dry run, with the deploying account. It builds, plans, runs the pre gate (read-only) and simulates the
deployment. Nothing is sent. Every state answer the gate decides on (code hashes, token facts, the fee address,
the depositing account, and after deployment the factory, router, lens and pairs) is read at the finalized
block's hash from every reviewed endpoint and used only when two answered and all that answered agree (review
R369-1); an opening transaction counts only when a second endpoint serves the same transaction and receipt
(R369-2). The pre gate also looks at the depositing account (no code, no EIP-7702
delegation, no transaction on this chain yet) and at the fee address: its signed proof of control must be
recorded and valid, and a delegation at it must be to the identified delegate (a `WARNING:` line says when the
delegation on this chain is not the recorded one: read it, it does not stop the run; section 2.3).
The simulation runs from the signer's account, which must already hold the gas: with an unfunded account it prints
"Script ran successfully" with the planned addresses and then stops with "lack of funds" (seen in a dry run
against OP Mainnet with no signer). Fund the account and repeat until it ends without an error.

```
scripts/multichain/deploy.sh op-mainnet dry-run -- --ledger
```

Step 2. Deploy. Three transactions to confirm on the signer: factory, router, lens. **No pair is created**, so no
empty pool of the owner's ever waits on the chain.

```
scripts/multichain/deploy.sh op-mainnet broadcast -- --ledger
```

Step 3. Wait until the chain has finalized them, then run the post gate. It must say PASS, and it reports the
planned pair as `absent`.

```
node scripts/multichain/gate.mjs op-mainnet post --out deployments/op-mainnet/gate-report.json
```

How long to wait (the lag of each chain's `finalized` block behind its head, measured on the two reviewed
endpoints on 2026-11-16, and by the reviewer on 2026-11-17):

| Chain | Wait before the post gate |
|---|---|
| OP Mainnet, Base | 16 to 23 minutes |
| Arbitrum One | about 20 minutes |
| Ethereum | about 15 minutes |
| BNB Smart Chain | seconds |
| Linea | **1 h 40 min to more than 5 hours** on the first endpoint, which the gate reads (its `finalized` is the block proven on Ethereum) |

If the gate is run too early it prints `WAIT: … the planned code at the latest block but not at the finalized
block yet`. That is not a failure of the deployment: run the gate again later. Any other failing check means stop
(section 10).

Step 4. Open the pool: the first deposit, from the depositing account, with the owner's own funds. **Use only
this tool for it, and send nothing else from that account.** First fund the depositing account on this chain
with the native coin of the deposit plus gas and with the token amount (`market.mjs <chain> --native AMOUNT`
shows how much token that is now; fund a little more than it says, the price moves). Then give the tool **one
amount**, the native coin, in whole units (1 in this example; the minimum per chain is in section 2.5); it
reads the chain's market price and computes the token amount. `--to` names the account that receives the LP
shares when it is not the depositor. On BNB Smart Chain the pair is `WBNB/USDC`.

```
node scripts/multichain/first-deposit.mjs op-mainnet prepare --pair WETH/USDC --native 1 --gate-report deployments/op-mainnet/gate-report.json
```

The tool reads the chain (every reviewed endpoint must show the same block; every state answer it decides on is
read at that block's hash and must be the same on two endpoints: review R369-1), checks that the contracts are the ones the
gate verified, that the depositing account has no code, that the pool is not open and what sits at the pair's
address, establishes the market price from the chain's two references (section 2.5; it prints both and the
mean), and prints two `cast send` commands. If it says there is no market price, or that the deposit is below
the minimum, nothing is printed: nothing is wrong on the chain; try again later, or with a larger amount.
Send the two printed commands as they are, adding only your signer option
(`--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante` for the keystore of section 2.1) and `--rpc-url`;
they carry `--chain`, so each is signed for this chain's id only (EIP-155) and any other chain's node rejects it
(`cast` itself does not compare the id with the URL's chain: review R369-8). **Send them with `cast send`, one at
a time, exactly as printed** (review R369-3): never import the depositing key into a browser wallet, never accept
"switch to smart account", never send the two as one batched transaction. A batching wallet sends the deposit to
the account itself instead of to the router; the pair accepts it (by transaction origin) and opens, but no tool
can then prove who opened it, so the page never lists that pair and it is lost for this factory (section 10).
Send them within a few minutes. The first approves
exactly the token amount to the router. The second is the router's `addLiquidityBLCH` with **minimums equal to the
amounts**; the tool has no option for other minimums. In that one transaction the router creates the pair and
deposits. What this does and does not guarantee:

- Nobody else can open the pool with a transaction of their own, before, between or after the owner's
  transactions: the pair refuses it.
- If the pool were already open, at any price, the deposit would revert instead of going in at that price.
- **It does not guarantee the exact opening price.** Tokens that someone sends to the pair's address before the
  deposit is mined (the printed deposit is valid for 20 minutes, in a public mempool) join the pool with it: the
  router takes the two amounts and the pair counts whatever else sits at its address. Such tokens are a gift to
  the pool, so to the depositor's shares; whoever sent them has lost them (tested at 1%, and in the reviewer's
  tests at 10% and 100% of a side). They move the opening price by their size, and the market then trades the
  pool back to its price, leaving the gift in the pool.

If `prepare` says tokens sit at the pair's address: up to 0.1% of either side of the deposit it prints the deposit
anyway and states the gift and the price the pool would open at. Above that it prints the `skim` command that
takes them out (anyone may send it; it pays the address named, so the owner may name an account of the owner).
Then run `prepare` again.

**If `prepare` says STOP: the pool is already open.** You did not open it. Deposit nothing, do not use `add`, and
go to section 10.

Then prove the opening, with the hash of the deposit transaction. `prepare` prints this command with the two
amounts it used (`TOKEN_AMOUNT` here):

```
node scripts/multichain/first-deposit.mjs op-mainnet verify --pair WETH/USDC --native 1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

It must say PASS. It reads the opening from the transaction itself, not from the pool's reserves (they change
with the first swap, seconds later on a public chain): the transaction is the pair's first mint, was sent by the
depositing account straight to the router, carried minimums equal to its amounts and deposited the amounts given.
It prints what joined the pool, the opening price, and a gift if there was one. A gift above 0.1% is said
plainly, with what to do: nothing is lost, **do not withdraw**; compare the pool's price with the market before
publishing the page. `verify` prints the next command.

Step 5. Wait as in step 3, then run the post gate again, naming the opening transaction. It must say PASS, report
the pair as `open`, and print who opened it and with what. Without `--opening` an open pool fails the gate: the
gate does not take "open" for "opened by the owner".

```
node scripts/multichain/gate.mjs op-mainnet post --opening WETH/USDC=DEPOSIT_HASH --out deployments/op-mainnet/gate-report.json
```

A later run with the same `--out` file takes the hash from the report it replaces and proves it again; the
option is needed once.

Step 6. Write the page's record of this chain from that report. The tool refuses a report whose pairs are not all
open, one that does not prove who opened each pool, or one whose factory has open first deposits.

```
node scripts/multichain/frontend-files.mjs op-mainnet --gate-report deployments/op-mainnet/gate-report.json
```

**Later deposits into an open pool.** State both amounts, at the market price (`market.mjs <chain> --native 1`
prints the token amount for it). The tool compares them with the
pool's own price and prints nothing when the two differ by more than the tolerance (0.5% by default, at most 1%):
a pool whose price someone moved takes nothing from the owner. It deposits only into a pool whose opening the
gate proved (the report of step 5). The deposit's minimums are that tolerance below its amounts, so a price
pushed away in the same block makes it revert:

```
node scripts/multichain/first-deposit.mjs op-mainnet add --pair WETH/USDC --native 1 --token TOKEN_AMOUNT --gate-report deployments/op-mainnet/gate-report.json
```

A later deposit may come from any account. The command above prints it for the depositing account; if that is
used, the rule of section 2 still holds (the printed transactions and nothing else).

**Later pairs.** What protects them is the same rule, and it is permanent:

- *What the factory allows.* Anyone can call `createPair` for any two tokens, at any time. Nobody but
  `firstDepositor` can make the first deposit of any pair of this factory (as the sender, or as the origin of the
  transaction: section 2). A pair someone else created is an empty contract: it holds no shares, `sync` refuses
  to turn tokens sent to it into reserves, and `skim` hands such tokens to whoever asks. It becomes a pool only
  when a transaction of the depositing account opens it.
- *What the page lists.* Only the pairs of the bundled record, which is written from a passed post gate with
  every opening proven, and only tokens of the reviewed list with their pinned code. A pair of another token
  never appears on the page.
- *How the owner adds one.* Add the token and the pair to `deployments/<chain>/chain.json` (`tokens`,
  `initialPairs`), run the pre gate (it pins the token's code), then step 4 for the new pair, step 5 and step 6.
  The owner's liquidity only ever enters through `first-deposit.mjs`: `prepare` for a pool's first deposit,
  `add` afterwards. Tokens with a transfer fee or a rebasing balance are not supported by the strict minimums
  (the deposit reverts) and should not be listed.
- *The depositing key stays what it is.* As long as the owner may open another pair, the key keeps the rule of
  section 2.1; once it is retired (section 2.1, "Retiring it") no further pair can ever be opened on this
  factory. A key that has been used elsewhere in the meantime can still open pools, but anyone it called may
  have opened one first; the gate's proof of the opening is what tells.

If the sender through the reviewed public endpoint is a problem (rate limits), set `MC_RPC_URL` to the owner's own
provider for `deploy.sh`; the gate and the deposit tool still read the two reviewed endpoints.

A second run of step 2 is safe: steps that already have code are skipped.

## 9. After deployment: the page

The multichain site is its own build with its own entry (`frontend/multichain.html`) and output
(`frontend/dist-multichain`); the Bloch L2 site does not contain it. It shows a network selector over the six
chains. A chain whose record says "not-deployed" shows "Not yet live" and makes no request. After step 6 for a
chain, build and publish:

```
npm --prefix frontend run build:multichain
```

The build writes `dist-multichain/_headers` with a Content-Security-Policy that names the seventeen reviewed
endpoints (two on OP Mainnet, Base and Ethereum, three on Linea, four on Arbitrum One and BNB Smart Chain). Hosting is the owner's step and follows `docs/FRONTEND-HOSTING-CHECKLIST.md`.

What the page does on these chains, by configuration and not by deleted code:

| Bloch L2 rule | On these chains |
|---|---|
| New-slot priority fee, credit rule | off: the wallet sets the fee |
| Idle-chain rule (deadline raised, heartbeat wait) | off: a latest block older than 10 minutes is reported as a lagging endpoint, the deadline is not changed |
| Bridge token pin, bridge hold notice, Safe pin | off: no bridge is listed and the fee address is an account |
| Reads and settlement at `finalized` | **replaced by each chain's confirmation rule** (below); on the Bloch L2 nothing changed |
| Default swap deadline of 60 minutes | 20 minutes (`swap.deadlineMinutes` in the network file; the user can set 10 to 180) |
| Code-hash check of every contract and token, same-nonce hold, no second swap request, explicit gas limits, slippage bounds | unchanged |

### Confirmation rule per chain (review R309-MC-2)

The Bloch L2 route reads everything at the `finalized` block and holds an account until its transaction is final
there. That rule exists for the L2's own reasons. On these chains `finalized` is 15 to 23 minutes behind the head
on four of them and hours behind on Linea, so the first edition allowed one swap per quarter of an hour, or per
five hours. Each chain's network file now states two rules (`confirmation`, written from
`deployments/<chain>/chain.json`, which also records what was measured and the residual risk):

- **settle**: the block the page reads prices, balances and allowances at, and at which a transaction that is
  included releases its hold and shows its outcome. A swap is bound by its signed minimum and its deadline, as on
  every public exchange; the page also compares its quote with the latest block before asking the wallet.
- **strict**: the block that ends a hold after which the user may send the swap again, so that a mistake could
  execute it twice: the swap's deadline passed with no transaction seen, or another transaction used the same
  nonce. These keep the chain's own `finalized` block wherever the chain has a usable one.
- **reverted** (review R328-7, then R328-3P-3): the block at which a swap whose receipt says **reverted** releases
  its hold (the page then offers a retry). It lies between the two rules above; `chain.json` says per chain
  (`confirmation.revertedWhy`) why a replacement of the block deeper than it is not credible. A reverted approval
  or skim is settled like a success. The note above the form says that a reverted swap holds the account, until
  when, and why. The cost: after a reverted swap the account is held on that chain for this rule's time (column
  "reverted" below) before the page lets the user try again.

| Chain | settle | Time at the measured block time | strict | reverted | Residual risk of the choice |
|---|---|---|---|---|---|
| OP Mainnet | 5 blocks on top | about 10 s (2 s blocks) | chain's `finalized` (15 to 23 min) | chain's `safe` (its batch is on Ethereum; about half a minute behind the head when measured) | A sequencer reorganisation deeper than 5 blocks after the page showed an outcome: the page then shows a result the chain replaced; the transaction stays valid and is normally included again; the page creates no second transaction |
| Base | 50 blocks | about 10 s (0.2 s blocks) | chain's `finalized` | chain's `safe` (about a minute and a half behind the head when measured) | as OP Mainnet, deeper than 50 blocks |
| Arbitrum One | 32 blocks | about 10 s (0.31 s blocks) | chain's `finalized` (about 20 min) | chain's `safe` (12 to 15 min when measured) | as OP Mainnet, deeper than 32 blocks |
| Linea | 1 block | about 11 s on average; Linea makes a block only when there is work (3 to 82 s apart when measured), so longer when the chain is quiet | **300 blocks** (about an hour) | 30 blocks (about 6 to 9 min) | The two reviewed endpoints disagree on `finalized` (the first answers the block proven on Ethereum, 1 h 40 min to 5 h behind; the second answers the head), so the tag is used for neither rule. The strict rule is **not the chain's finality**: a sequencer reorganisation deeper than 300 blocks could let a swap execute after the page ended its hold |
| BNB Smart Chain | chain's `finalized` | about 1 s (the chain's fast finality is one or two blocks behind) | chain's `finalized` | chain's `finalized` (seconds) | Fast finality stalling: the page says so and waits, as on the Bloch L2 |
| Ethereum | 2 blocks | about 24 s (12 s blocks) | chain's `finalized` (about 15 min) | chain's `safe` (12 to 15 min when measured; finality 19 to 22) | A reorganisation deeper than 2 blocks: rare since the merge, not impossible; as OP Mainnet |

Where `finalized` still protects the user, on every chain: the deployment record is written from a post gate read
at the chain's `finalized` block; the page refuses a settled block older than that record; and the two strict
decisions above. What moved to the settle rule: displayed pools and balances, the binding quote, and the release
of a hold by the saved transaction's own **successful** receipt (if that block is later replaced, the same signed
transaction is the only thing that can execute, once).

The page shows the rule in words above the swap form of each network, for example: "On Ethereum this page treats a
block as settled once 2 blocks are on top of it (about 24 seconds), not at the chain's own finality. Where this
page says "finalized" on this network, it means that. …". Shown by the page rehearsal (section 11): on each fork,
blocks are mined at the chain's measured block time and only as many as the rule asks; the swap's outcome appears
within seconds while the fork's `finalized` block is still behind the swap.

### Two endpoints must agree (reviews R309-MC-3, R328-4 to R328-6, R328-3P-1, R328-3P-4, R328-3P-5)

Every endpoint is a third party here. **Nothing the page shows or signs comes from one endpoint, by construction**
(review R328-3P-4). The page's RPC layer (`frontend/src/multichain/rpc.ts`, `agreeingRpc`) never sends a state
read (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, the account nonce) by tag, by number or
without a block: it first resolves the block to one that two endpoints report with the same hash and the same
timestamp, then reads at that HASH from two endpoints and uses the answer only when both give the same bytes; when
they differ the page shows `DISAGREEMENT` and sends nothing. This covers the reserves, the binding quote, balances,
allowances, code hashes and the comparison quote at the latest block that becomes the signed quote after
"reconfirm" (before the third revision that one was a read at the tag `latest` answered by the first endpoint
alone). The rest:

- **heads** (`latest`): two endpoints are asked; the head used is the **older** of the two, so it is a block both
  have. Two heads count as apart only when they are more than 2 blocks (`HEAD_GAP_BLOCKS`) AND more than 90
  seconds of chain time (`HEAD_GAP_SECONDS`) apart, so a quiet Linea is not "behind"; apart, the page stops with
  `BEHIND` instead of holding the user on a true but old state. A third endpoint is asked when one of the first
  two fails or lags; a refused request is asked again after a growing pause. The confirmation depth is counted
  from that head, and the binding quote is compared with it before the wallet is asked.
- **`finalized` and `safe`** are the **older** of two answers, and both endpoints must answer (`UNCONFIRMED`
  otherwise): one endpoint alone cannot make the page treat a newer block as final.
- **a block by number or hash** needs two endpoints (block 0: one); one that does not have it yet, or has pruned
  it, is not a disagreement: a further listed endpoint stands in.
- **a transaction and its receipt** count only when two endpoints report the same inclusion (block hash and
  number) and the same status; until then the page treats the transaction as not seen yet, which never ends a
  hold. One endpoint's false "reverted" cannot free the account for a second swap (review R328-6).
- **the pending nonce** is the higher of two answers.
- **left to one endpoint**: the chain id (compared with the pinned one) and fee data (the wallet sets the fee).
- **the submission boundary** (review R328-3P-1) saved with a sent swap is the block settled by the chain's rule,
  not the head, so a one-block reorganisation of the head can no longer leave a hold that never ends.

`frontend/src/test/multichain-provenance.test.ts` fails when a JSON-RPC method the route names is not classified
in one of the lines above, when a lying endpoint's answer comes through in any position, or when any endpoint
receives a state read by tag.

**Public endpoints do not keep a block's state for long (reviews R328-4, R328-5).** Measured on 2026-11-17, for
reads pinned to a block hash: some endpoints answer for a block a day old, others only for about a minute
(`bsc-dataseed.bnbchain.org`, publicnode on Arbitrum One), 10 minutes (publicnode on Linea), 20 minutes (Arbitrum's
own endpoint) or an hour (publicnode on BNB Smart Chain). The second edition, which asked two endpoints for a
block the page kept as long as it stayed open, therefore stopped answering quotes after about a minute on
Arbitrum One and BNB Smart Chain, and could never end a hold by its deadline on Arbitrum One and Linea. What the
page does now:

- **snapshot renewal** (R328-5, then R328-3P-2): the page takes a new snapshot block every four minutes while it
  is visible (`SNAPSHOT_MAX_AGE_MS` = 240,000 in `frontend/src/MultichainApp.tsx`; the second revision renewed
  every 30 seconds, which emptied the swap form under the user). With the endpoint lists below a snapshot 300 to
  600 seconds old was still answered on all six chains. The route must also renew ON DEMAND, before a quote when
  the snapshot is older than that bound and once when a pinned read fails with `UNCONFIRMED`, and never under a
  user mid-entry. On this branch's plain route a renewal still resets the form; the redesigned route (agent
  327's line, continued by 361) is the one that keeps the inputs and owns this behaviour;
- **endpoint lists**, ordered so that the first two keep state longest: OP Mainnet, Base and Ethereum two each;
  Linea three (its own endpoint, dRPC, publicnode); Arbitrum One four (its own endpoint,
  `arbitrum.gateway.tenderly.co`, blastapi, publicnode); BNB Smart Chain four (publicnode,
  `api.zan.top/bsc-mainnet`, blastapi, the chain's dataseed). The two added in the third revision (Tenderly, ZAN)
  were each measured to serve pinned state 45 minutes old and a browser's preflight, and are placed second so
  that strict reads no longer depend on blastapi's shared anonymous quota. Operator independence is judged from
  the hostnames and response headers only (reviewer 364 checks it against the operators' own documentation);
- the strict decisions and a reverted receipt read through two endpoints at the strict (or reverted) block, which
  those lists serve: about 20 minutes old on four chains, about 80 minutes (300 blocks) on Linea.

No fork can show any of this (a fork keeps every state), so the package has a read-only check that runs the
page's own RPC code against the real endpoints of all six chains, with no wallet and no transaction
(section 11, "Live check"). Run it before the page is published and whenever an endpoint list changes. The
weakest place it showed: Arbitrum One's strict block is 16 to 20 minutes old and its own endpoint answers for
about 20 to 30; if it stops answering, a hold on Arbitrum One that must end by its deadline waits (nothing is
sent). The owner's own endpoint in the list removes that.

Measured on 2026-11-17 on the endpoints of the second edition (16 rounds per chain, seconds apart): the two heads
were the same block in 69 of 96 rounds and at most 5 blocks apart in the others, and a read pinned to a head and
to the settle block got equal answers from both endpoints in all 96.

Revisions of these rules, for a reader of older reports: first edition (`4f2427b`): reads at `finalized` from the
first endpoint. Second (`0566af3`, `711e3ad`, `ab1bd1c`; R309-MC-3, R328-4 to R328-7): hash-pinned reads from two
endpoints, heads and tags from two, receipts from two, a 30-second snapshot renewal, three endpoints on three
chains. Third (`9e4b5d1`; R328-3P-1 to 3P-5): no state read by tag at all, the reverted rule, the settled
submission boundary, heads apart only by blocks AND seconds, four endpoints on two chains, the 240-second renewal.

Selecting a network asks nothing of the wallet; "Add or switch to …" and every transaction ask the wallet to
switch (`wallet_switchEthereumChain`, then `wallet_addEthereumChain` if the wallet does not know the chain). A
pending swap on one chain does not hold another chain.

Limits of the page on these chains: it lists only the pairs of the record; it has no liquidity form (deposits are
made as in section 8, withdrawals as in section 6); see also section 13.

## 10. If something goes wrong

- **Nothing can be undone.** A deployed contract stays. There is no upgrade, no pause and no owner.
- A wrong deployment (wrong choice of `firstDepositor` or caps, wrong wrapped token) costs the gas of that chain's
  deployment and leaves unused contracts behind. The fix is to correct the configuration and deploy again: the new
  factory has another address. Nothing is lost as long as no liquidity was put in.
- If liquidity is already in a wrong deployment, its provider withdraws it through that deployment's router; the
  locked minimum (1,000 base units of LP shares, worth a dust amount) stays.
- If the post gate fails, do not write the page's record and do not add liquidity. Read which check failed; the
  gate changes nothing. The one exception is the line that starts with `WAIT`: the chain has not finalized the
  deployment yet (section 8, step 3).
- If `first-deposit.mjs prepare` fails, nothing is to be sent; it says which check failed. If the deposit
  transaction reverts, nothing was deposited (the approval can stay or be set to zero); run `prepare` again and
  read what it reports about the pair. Never work around it with a hand-written deposit or other minimums.
- **If `prepare` says STOP (the pool is already open), or `verify` or the post gate cannot prove the opening:**
  someone else opened that pool, through a transaction of the depositing account that did not go straight to the
  router (section 2), or with the depositing key itself. Deposit nothing there and do not use `add`. That pair
  of that factory stays open at the other party's price for ever; no tool here can reopen it, and its locked
  minimum cannot be removed. The loss so far is nothing but the pair. Treat the depositing key as exposed.
  **What a new depositing account costs (review R369-4):** `firstDepositor` is ONE value for all six chains and is
  part of the factory's init code, so a new account moves the planned factory, router, lens and pairs on EVERY
  chain, not only on the failed one. The chains already deployed and opened keep working on chain and on the page
  (the page reads each chain's committed `frontend.record.json`, which names its own addresses), but after the
  change the committed tools plan the new addresses, so their post gate, `first-deposit.mjs add` and
  `frontend-files.mjs` no longer describe them. The recovery is therefore: keep the finished chains' committed
  `gate-report.json` and `frontend.record.json` as they are; record the new account with `check-depositor.mjs`
  (setting `firstDepositor` back to `TBD-owner` first, as the tool says); deploy and open, with the new plan, only
  the chains not yet opened; and run later deposits on the finished chains from the commit that holds their old
  plan (its hash is in their records' history). This package has no per-chain depositor; that would be a tool
  change, not done. **Prevention, which is cheaper:** the depositing account only ever RECEIVES funds (plain
  transfers from another account of the owner) and sends only the lines `first-deposit.mjs` prints; on a chain
  not yet deployed it sends nothing at all, because the pre gate refuses a depositing account with any
  transaction on that chain while the factory is absent (that chain could then never be deployed with the
  committed plan). Running the pre gate and the deployment on all six chains before the account is first funded
  removes that dead end. The page lists only pools whose record was written from a proven opening.
- If `verify` proves the opening but reports a gift (tokens someone sent to the pair's address before the
  deposit): nothing is wrong and nothing is lost. The gift is in the pool and belongs to the depositor's shares;
  the pool opened at a price that differs from the intended one by the gift's size, and the market trades it
  back. **Do not withdraw to "repair" it**: a withdrawal leaves the pair open with only its locked minimum, at
  that price, and `prepare` then refuses it. If the price must be right before the page is published, wait for
  the market or make one swap in the correcting direction.
- A pool from which all liquidity was withdrawn is not empty again: it stays open with its locked minimum, a dust
  amount at whatever ratio the dust has, and anyone can move that ratio with a dust-size swap. `prepare` refuses
  it (it is open) and `add` refuses it while its price is not the price of the owner's amounts. To fund it
  again: bring its price to the market with a small swap through the router, then use `add`. Better: do not
  withdraw the last liquidity of a listed pool.
- If a transaction of step 2 fails or the signer is interrupted, run step 2 again.
- The fee address cannot be changed (section 1). Check the key before the first chain, not after the sixth.

## 11. Rehearsals and how to repeat them

Everything below is loopback or read-only, with throwaway keys. Run of record: commit `77b5d61` for the suites, the
six fork rehearsals, the costs and the pre gates; `d57cfab` and `5707bd8` (which change only how the tools ask a
failing public endpoint again and which endpoint the simulation uses) for the page rehearsal and the six
simulations; 2026-11-17. Commits after those change documents only.

| Rehearsal | Command | What it shows | Result |
|---|---|---|---|
| Kit tests | `node --test scripts/multichain/*.test.mjs` | configuration, plan, gate and pair states, the proof of an opening and its refusals, the depositing account's rules, the deposit tool's minimums and price check, confirmation rules, opcode set, refusals, start through a symbolic link | 21 pass |
| Deploy script | `forge test --match-contract MultichainScriptTest` | planned addresses on the deployer's real runtime, a second run deploys nothing, refusals (the zero address and the fee address as first depositor among them) | pass |
| Opening of a pool | `forge test --match-contract MultichainFirstDepositTest` | review R309-MC-1 against the package's plan (hostile first mint refused directly, through the router and from a contract; strict minimums alone; later pairs); review R328-1 as a fact of the frozen pair (a contract called by the depositing account opens the pool; the printed deposit then reverts); the lock and the Mint log the proof relies on; reviews R328-2 and R328-3 (a donation joins the pool as a gift to the depositor; one unit does not stop the deposit) | 9 pass |
| Pre gate on the public chains | `node scripts/multichain/gate.mjs <chain> pre --reference` | pins against the real chains, the depositing account, read-only | PASS, six of six |
| Simulation on the real nodes | `node scripts/multichain/simulate-chain.mjs <chain> --out FILE` (BNB Smart Chain: add `--endpoint https://bsc-dataseed.bnbchain.org`) | deployment, the hostile first mint and deposit (must revert), the guarded opening by the depositing account and the flow on the chain's own node software, read-only | PASS, six of six |
| Fork rehearsal | `node scripts/multichain/rehearse-fork.mjs <chain> --port PORT --out DIR` | the owner's command and the post gate; **review R328-1 on the fork** (the depositing account calls a hostile contract, which opens the planned pool: `prepare` says STOP, the gate fails without and with that transaction as the opening, `verify` fails, `add` prints nothing, no record can be written); **reviews R328-2 and R328-3** (one unit at the pair does not block `prepare`, 1% does, the same 1% in front of the deposit joins as a gift that `verify` and the gate report); **review R309-MC-1** (a stranger's first mint and first deposit revert); the first deposit as printed; `verify` after a swap has moved the reserves; the post gate without, with and again without `--opening`; the flow with signed transactions; a later deposit as `add` prints it, after its refusal at a price 5% away; gas, fee amounts | PASS, six of six, 41 checks each |
| Page rehearsal | `node scripts/multichain/rehearse-page.mjs --port PORT --out DIR` | the multichain site in a real browser engine against six forks whose pools were opened by a first deposit that also created the pair and whose records come from gates with the opening proven: network switch, one swap per chain settled by the chain's confirmation rule at the chain's block time, holds per chain | PASS: 6 chains, 59 assertions, 0 failed |
| Live check | `cd frontend && npx vite-node integration/live/multichain-live.ts` (`-- --hold 600` to keep a snapshot ten minutes) | the page's own RPC code against the real endpoints of the six chains, read-only, no wallet: a snapshot with reads agreed by two endpoints and the pinned code hashes, the head, the strict block with the nonce read that ends a hold, a snapshot kept open, a renewed snapshot | PASS, six of six, twice; with the snapshot kept ten minutes every read was still answered on all six (38 to 40 reads each). Strict blocks read: 14 to 24 minutes old on four chains, 79 and 80 minutes on Linea |
| Page unit tests | `npm --prefix frontend test` | the above plus confirmation rules, agreeing endpoints for reads, heads, tags and receipts, the strict reader for deadlines, replacements and reverts | 533 pass (513 in the first edition, 526 in the second), 1 skipped |

Per chain:

| Chain | Pre gate (real chain) | Simulation (real node) | Fork rehearsal | Deployment gas | Page: switch and swap |
|---|---|---|---|---|---|
| OP Mainnet | PASS | PASS (op-reth; anchored swap works) | PASS, 41 checks | 8,961,488 | PASS, swap 142,816 gas |
| Base | PASS | PASS (reth; anchored swap works) | PASS, 41 checks | 8,961,488 | PASS, swap 142,746 gas |
| Arbitrum One | PASS | PASS (nitro; anchored swap reverts) | PASS, 41 checks | 8,961,704 | PASS, swap 158,109 gas |
| Linea | PASS | PASS (Geth; anchored swap works) | PASS, 41 checks | 8,961,704 | PASS, swap 146,883 gas |
| BNB Smart Chain | PASS | PASS (Geth; anchored swap works). On the chain's other client (reth-bsc, publicnode) the three deployments simulate alone, but the whole flow in one simulation does not: that node shares out a gas cap per simulation and the router's deployment reverts inside the block of forty calls | PASS, 41 checks | 8,961,704 | PASS, swap 140,324 gas |
| Ethereum | PASS | PASS (reth; anchored swap works) | PASS, 41 checks | 8,961,704 | PASS, swap 143,720 gas |

The reviewer's first attack in each fork rehearsal: the attacker's `mint` and `addLiquidityBLCH` reverted
`BDEX: FIRST_DEPOSITOR`; the pool then opened at exactly 10 native and 30,000 token units; the attacker's 600
token units bought 0.1955 native (their worth at that price, less the fee and the price impact), where the
reviewer's test against open first deposits took more than 9.6 of the 10. The second attack (a contract called by
the depositing account) opened the pool at 1 native = 2 tokens on every fork, and nothing of the owner's followed
it in: every tool refused.

Swap flow in the page rehearsal, from the wallet request to the page showing the outcome, with blocks mined at
the chain's measured block time and only as many as the rule asks (the page looks every 4 seconds):

| Chain | Rule | Blocks mined | Chain time | Measured | Fork's `finalized` behind the swap |
|---|---|---|---|---|---|
| OP Mainnet | 5 blocks | 6 | 12 s | 15.5 s (this chain's swap is the one held while another chain trades; time from its block) | yes |
| Base | 50 blocks | 51 | 10.2 s | 12.4 s | yes |
| Arbitrum One | 32 blocks | 33 | 10.2 s | 12.3 s | yes |
| Linea | 1 block | 2 | 23 s | 24.9 s | yes |
| BNB Smart Chain | chain's `finalized` | 67 at once (anvil's `finalized` is 64 blocks behind; the chain's is one or two) | 0.9 s | 6.1 s | not applicable |
| Ethereum | 2 blocks | 3 | 36 s | 37.1 s | yes |

In the first edition each of these waited for `finalized`: 15 to 23 minutes on four chains, hours on Linea. The
Bloch L2 route is unchanged where the L2 uses it (its RPC carries no strict reader and its site sets no snapshot
renewal); its unit tests pass, and the Bloch L2 clean export (all its suites and rehearsals) is run on the final
commit and recorded in the round's report.

A rehearsal no longer waits on the public fork source while it mines: under the Prague rules anvil read one
storage slot of the EIP-2935 history contract from it for every block, which ended runs with HTTP 429 and made
the page's timings depend on the endpoint (at `0566af3` the page rehearsal failed its timing assertion on Base and
BNB Smart Chain under load). The slots of the blocks a rehearsal mines are now written locally first.

Fork sources: the reviewed first endpoint, except BNB Smart Chain (blastapi, which keeps state) and Ethereum (its first endpoint
answered the fork's block 0 request from a history-pruned backend; the second is used). OP Mainnet's first
endpoint answered one trial with a rate limit (HTTP 429); the run of record passed.

## 12. Risks the owner should know

1. **Liquidity is the owner's to provide, on each chain separately.** A deployment without liquidity is an empty
   exchange. Six chains means six pools to fund and watch, and each pool's depositor carries price risk
   (impermanent loss).
2. **Deploying costs real gas, most of all on Ethereum** (section 7), and cannot be undone (section 10).
3. **These deployments bring no volume to the Bloch L2.** They are separate pools on other networks; nothing
   links them to the L2's pools or bridge.
4. **The audit covers the contracts, not six new configurations.** The audit commit is the Bloch L2 package. The
   contracts here are the same bytes, but the wrapped tokens, USDC's behaviour, an account as fee recipient, the
   CREATE2 route, uncapped pools, and public-chain conditions (searchers, front-running, permissionless pair
   creation with any token) were not what the audit looked at. The reviewer of this round reviews the package,
   which is not an audit.
5. **Licence.** Established and corrected on 2026-11-17 (`docs/LICENSING.md`). The pair, factory, LP token, the
   two libraries and the router are ports of Uniswap V2, which its publisher licenses under **GPL-3.0-or-later**
   (read from the publisher's own `package.json` and `LICENSE`). That licence therefore governs `contracts/`,
   `script/` and `test/`; the frontend, the tools and the documents stay MIT. The repository's `LICENSE`,
   `NOTICE` and `LICENSES/` now say so; the header lines inside the frozen contract files still say MIT and are
   stated as superseded (they are corrected at the next contract revision). Consequences for the owner: the
   contracts' source must be available under the GPL to whoever uses them (publish the repository; verify the
   contracts on each explorer as "GNU GPLv3"); the copyright holder's name is still to be filled in
   (`docs/LICENSING.md` section 5); and the wallet-connection packages of the Bloch L2 site (Reown AppKit,
   WalletConnect) are under a commercial-threshold licence, not an open-source one (section 4 of that file). A
   lawyer should confirm the points listed in its section 6.
6. **The fee address is one key.** Losing it loses the fee for ever; a thief of it takes the accrued shares. On
   Base it delegates to MetaMask's smart-account code, which adds two kinds of signature that can move its funds
   (section 2.3): sign no "permission" or "delegation" with it.
7. **Permissionless pairs.** Anyone can create a pair with any token, including worthless or hostile ones, but
   only the owner's depositing account can open one (section 8, "Later pairs"). The page lists only the reviewed
   pairs.
8. **BNB Smart Chain's "USDC" is not Circle's**, and has 18 decimals; it is shown as "USDC (Binance-Peg)"
   (section 2.6). Its value rests on Binance holding the USDC behind it.
9. **Public endpoints.** The page depends on public RPC endpoints the owner does not run; they rate-limit, prune
   history and change. Two or three are listed per chain; the owner may prefer own endpoints.
10. **The opening of a pool** (reviews R309-MC-1, R328-1 to R328-3). On a public chain the moment a pool opens is
    the moment it can be robbed. This package closes it four ways: only a transaction of the owner's depositing
    account can open any pool of the factory; no pair exists before the first deposit, which creates it in the
    same transaction; the first deposit's minimums equal its amounts; and "open" counts for nothing until the
    opening is proven from its transaction. **What the contracts leave open, and no tool can close:** the pair
    accepts the depositing account as the *origin* of a transaction, so a contract that account is led to call
    can open a pool in its name (section 2). Against that there is one protection that prevents it, the owner's
    discipline (a new key, used only for the printed deposits), and several that stop the loss afterwards (STOP,
    the proof of the opening, the price check of `add`); the pair itself is then lost for that factory (section
    10). Also with the owner: the depositing key (whoever holds it can open pools at any price), choosing the
    opening price near the market (a pool opened away from it is arbitraged at the owner's cost, on any
    exchange), using only `first-deposit.mjs`, and knowing that tokens sent to the pair's address in front of the
    deposit move the opening price by their size (a gift to the pool; section 8, step 4).
11. **The page's confirmation rule** (review R309-MC-2, section 9). On five chains the page settles on a
    confirmation depth of seconds, not on the chain's finality; the table in section 9 states the residual risk
    of each choice. On Linea even the strict rule is a depth, because its public endpoints do not agree on
    `finalized`.
12. **Trust in the endpoints** (reviews R309-MC-3, R328-4 to R328-6, section 9). The page uses a hash-pinned
    read, a transaction and a receipt only when two endpoints agree, sends no state read by tag (every read is
    resolved to a block two endpoints agree on, then read at its hash from two), takes the head and a finality
    tag from the older of two answers, and stops when the two heads are more than 2 blocks and more than 90
    seconds apart. One lying or lagging
    endpoint can therefore neither show a false price or outcome nor hold the page on an old state; it can stop
    the page. Two endpoints that lie alike can deceive it, and so can a party that controls two of a chain's
    listed endpoints. Availability needs two working endpoints that keep the state the page asks for; public
    endpoints change what they serve without notice, which is what the live check is for. The owner's own
    endpoint in each list would reduce both risks.

## 13. Known issues

Recorded, not fixed in this package:

| Issue | Where it matters | What to do |
|---|---|---|
| **The route's texts say "finalized"** on this branch's plain route on chains where the page settles on a depth ("Pools at finalized block", "verified canonical and finalized", "Finalized balances"). The page states above the form what the word means on that network | Users of the five depth chains, on this branch's route only | Closed in the redesigned route (agent 327's `adc8702`, merged into `main` at `7ae5006`): it says "confirmed" on depth chains; the route published is that one |
| **Arbitrum One: fixed gas limit under an L1 fee spike** (review R309-MC-8). The page asks 250,000 gas per hop; on Arbitrum the limit must also cover the L1 data charge. Measured: execution 158,109, which leaves 91,891; the L1 component was about 1.5 gas per calldata byte at the hour of the cost run (a swap is a few hundred bytes: some hundreds of gas), so the limit holds until that component is on the order of 150 times that hour's. Not measured under a spike | A swap on Arbitrum One during an Ethereum fee spike could run out of gas (the user loses the fee of a failed transaction, not the swap) | A per-chain gas limit, or an estimate on Arbitrum, in a later change to the route |
| **Anchored swaps revert on Arbitrum One** (section 5) | Direct callers only; the page does not use them | None in this package |
| **Fee address** (review R309-MC-7): closed by the decisions of 2026-11-17. Control is proven by one signed message (section 2.2; **the owner's signature is still missing**); the delegate on Base is identified and the gate refuses any other (section 2.3). The delegate's own code was identified, not audited, here | The fee shares on Base move by the key's transaction, or by a user operation or delegation the key signed | The owner signs the proof; signs no "permission" with the fee wallet |
| **The opening price depends on two outside references** (section 2.5) | Chainlink's feeds and one pool per chain; on Linea the pool is thin and the ETH / USD feed moves only on 0.5%, so `prepare` may answer "no market price" there on a volatile day | Try again later; the tool never falls back to one reference or to a typed price |
| **The first-depositor rule accepts the transaction origin** (review R328-1; frozen contracts) | A contract the depositing account calls can open a pool in its name | A dedicated key and the tools' refusals (sections 2, 8 and 10); a new pair contract would be the only real fix and is not part of this package |
| **A gift in front of the first deposit moves the opening price** (review R328-2; the frozen router does not look at tokens already at the pair) | The pool can open at a price that differs from the intended one by the size of what someone chose to give away | `prepare` refuses above 0.1% that is already there; `verify` and the gate report it; section 10 |
| **After a reverted swap the account is held for the reverted rule's time** (reviews R328-7, R328-3P-3; section 9). The third rule was added in `9e4b5d1`: `safe` on OP Mainnet, Base, Arbitrum One and Ethereum, 30 blocks on Linea, `finalized` on BNB Smart Chain | A user whose swap reverted waits about half a minute (OP Mainnet), a minute and a half (Base), 12 to 15 minutes (Arbitrum One, Ethereum), 6 to 9 minutes (Linea) or seconds (BNB Smart Chain) before the page lets them retry. Whether `safe` from a sequencer-run endpoint is decisive at that depth is reviewer 364's open question | The page says so in the note above the form; the redesigned route renders "reverted; this account can send again at HH:MM" (agent 361) |
| **The page was never run in a browser against the real endpoints with a wallet** | The live check runs the page's RPC code in Node; the browser rehearsals use forks. Reviewer 328 loaded the page read-only in headless Chrome against the then fifteen endpoints (no CSP or CORS refusal); the two added in `9e4b5d1` answered a browser's preflight when measured. A wallet flow against them was not rehearsed | A real page load and a small swap by the owner on the first chain before publishing |
| **A hold that cannot be decided says nothing new** (review R328-4): when the strict reads are refused the page keeps its hold text and tries again | The user sees a hold without a reason | The route's texts belong to the UI line (agent 327); the endpoint lists and the live check keep the case from being permanent |
| **Linea's `finalized`** differs between the two reviewed endpoints | The gate reads the first (the proven block); the page uses the tag for nothing on Linea | Stated in sections 8 and 9 |
| **No real wallet and no real transaction** were used anywhere (section 5) | The rehearsals show the code paths, not a wallet's behaviour or a chain's inclusion | A small real swap by the owner on the first chain before publishing the page |
