# PosternDEX on six public EVM chains: deployment package

Status: **prepared and rehearsed, not deployed** (2026-11-17; revised after reviews R309-MC-1 to MC-9 and
R328-1 to R328-3). Nothing in
this repository has sent a transaction to any public chain or testnet. The owner runs the commands of section 8
with the owner's own signer.

This is an additional product line. The Bloch L2 deployment (protocol fee to the Bloch Inc Safe, mainnet gate,
bUSDC, audit commit `b6cd1a6`) is separate, is not changed by anything here, and keeps its own procedure
(`docs/MAINNET-700770-PACKAGE.md`). The tools of this package refuse the Bloch L2 chain ids.

Chains: OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain, Ethereum. Non-EVM networks (Tron, Bitcoin, Solana,
Stellar): `docs/MULTICHAIN-NON-EVM.md`.

## Contents

1. What is deployed, and what the factory allows
2. Owner's choices still open
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
| Factory `firstDepositor` | the owner's depositing account, a key used for nothing else: required, never the zero address, never the fee address (section 2) |
| Factory reserve caps | owner's choice per chain (section 2) |
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

## 2. Owner's choices still open

They are marked `TBD-owner` in the configuration, and `scripts/multichain/deploy.sh` refuses to broadcast while one
is left. They are economic choices; nothing here invents them.

| Choice | File | What it means |
|---|---|---|
| `firstDepositor` | `deployments/multichain.json` | **The owner's depositing account: a new key made for this purpose and used for nothing else. Required. The zero address and the fee address are refused by every tool and by the deploy script, with no override.** Only that account can open a pool, on every pair of the factory, for ever; others can create pairs but not fund them. It must be a plain key account (no contract, no multisig, no smart account behind a bundler, no EIP-7702 delegation), new on each chain, and it sends only the transactions `first-deposit.mjs` prints. The rules and the reason follow below |
| `reserveCaps` | `deployments/<chain>/chain.json` | `[]`: no caps (an ordinary constant-product exchange). A list of `{ "token": symbol, "cap": base units }`: a pool cannot grow past the cap on that token |
| Opening price and first liquidity | not in a file | The first depositor's first deposit sets the price: the two amounts given to `first-deposit.mjs` (section 8, step 4). The owner provides liquidity on each chain separately; nothing here funds a pool |
| Token list | `deployments/<chain>/chain.json` | Starts with the wrapped native token and the chain's USDC. On BNB Smart Chain the only "USDC" is Binance-Peg (section 4): listing it is the owner's decision |

**Why first deposits are never open here (review R309-MC-1).** On a public chain a factory whose first deposits
are open lets anyone open the owner's pool first, with dust, at a false price; the owner's deposit then pairs its
native coin with almost no tokens and the attacker buys it. The reviewer's test took more than 9.6 of 10 native
that way, without any mempool race. With `firstDepositor` set, that first mint reverts, directly and through the
router, for every transaction that the depositing account did not send: shown by the forge tests
(`test/MultichainFirstDeposit.t.sol`), by every fork rehearsal and on each chain's own node (section 11).

**The depositing account is a dedicated key (review R328-1).** The pair's rule is "the sender of the first mint is
the first depositor, **or the origin of the transaction is**". The contracts are frozen, so the second half
cannot be removed. It means: if the depositing account ever sends a transaction to another contract (a claim
page, a token with a transfer hook, another exchange's router), that contract can, inside that transaction, open
any pair of the factory that is not open yet, at any price, in the account's name. The reviewer's test did it
with one call. The exposure lasts from the factory's deployment to each pair's first deposit, and for ever for
pairs opened later. So:

- **Use a new key** for `firstDepositor`: not the fee address, not a wallet that is used for anything else. A
  hardware wallet account that has never been used on these chains is the simplest form. Fund it with exactly
  what the deposits need.
- **It sends only what `first-deposit.mjs` prints**: an approval of the listed token and the router's deposit.
  Nothing else, ever: no other site, no claim, no transfer to a contract, no other token.
- **No code at the address.** A contract cannot be the first depositor through the router (the origin of a
  transaction is always a key account), and an EIP-7702 delegation puts code at the account that others may be
  able to drive. The pre gate and `prepare` refuse a depositing account with code or a delegation.
- **New on each chain.** The pre gate refuses a depositing account that has already sent a transaction on the
  chain while the factory is not deployed there.

What the tools do when the rule was broken anyway, or the key was used by someone else: a pool that is open when
`prepare` runs was not opened by the tool, and `prepare` says STOP; the post gate does not pass an open pool until
its opening is **proven** from its transaction (the pair's first mint, sent by the first depositor straight to the
router, with minimums equal to its amounts; `scripts/multichain/opening.mjs`); the page's record is written only
from such a report; and `add` deposits only into a proven pool, at the price the owner states. Every one of these
refusals is run in each fork rehearsal against a hostile contract (section 11). They prevent the loss; they do
not give the pool back: a pair opened by someone else stays open, at that factory, for ever (section 10).

Two consequences to weigh before choosing caps:

- **Addresses.** A cap names a token address, which differs per chain. With any cap the factory address differs
  from chain to chain. Without caps it is the same on all six.
- **A pool capped on both sides leaks fees to strangers on a public chain.** The pair keeps `reserve0 x reserve1`
  under a ceiling; a swap's fee above the ceiling stays outside the reserves, where `skim` removes it. `skim` is
  open to anyone and pays the address the caller names. On the Bloch L2 a keeper skims to the Safe. On a public
  chain searchers will skim first, and the keeper cannot be given priority: the contracts have no place for it.
  Uncapped pools have no ceiling and no such leak.

The reference plan used in every rehearsal is "the reference address is the first depositor, no caps". The
reference address `0xb04cc27201710ee425739Cb5B97Ce4D4F21AAAD9` is the last 20 bytes of
`keccak256("postern-dex.multichain.reference-first-depositor")`: nobody holds a key for it, so a factory deployed
from the reference plan could never have a pool opened, and the tools refuse it as a real choice. Rehearsals
impersonate it on a loopback fork. The owner names the real depositing account, and the addresses of section 3
then change.

## 3. Addresses

Factory, router and lens are created by the deterministic CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`
(verified on all six chains: same runtime code, hash `0x2fa86add…4989`) with the salt
`keccak256("postern-dex.multichain.v1")` = `0xe5077402…c57a`. An address depends only on the deployer, the salt
and the init code (contract code plus constructor arguments), not on who sends the transaction.

With the reference plan (`node scripts/multichain/plan.mjs all --reference`):

| Contract | Address | Same on |
|---|---|---|
| Factory | `0xFDb432E995EedB5a01931B161566EDceE2Cb3898` | all six |
| Lens | `0xB9c4Bc1ffC2E0167952e7adbeaB12ebaD2380144` | all six |
| Router | `0xA4C7Ac8758756a12894BC610bd1Ff9c218A90ddb` | OP Mainnet and Base (both use the WETH predeploy `0x4200…0006`) |
| Router | `0xED70Dbf01981AE6FF5B71222C040D37D80F8E07F` | Arbitrum One |
| Router | `0xF1bEe475eCFd326d8A3075633ffB9F7969aC7c2e` | Linea |
| Router | `0x212D14e096B70472dEc7557c06a9865eBAfcB5bE` | BNB Smart Chain |
| Router | `0x2bb381Ee8C58D277E74FF2d74DEd2DFD2f1a83a2` | Ethereum |

Why the router differs: the wrapped native token is a constructor argument, and it has another address on each
chain except the two OP Stack chains. Pair addresses differ everywhere, because token addresses differ. (These
addresses are not those of earlier editions of this document: the reference plan's `firstDepositor` was the zero
address in the first and the fee address in the second.)

**These addresses change with the owner's choices.** Another `firstDepositor` or any cap is another factory init
code, so another factory address, and with it another router and lens. Run the plan after the choices are made;
the gate and the page take the addresses from the plan, never from this table.

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
  coin and redeems its fee shares in that state. What that delegate contract is was not established here; the
  owner should know it (a wallet sets such a delegation). The fee address is not the depositing account
  (section 2), so this delegation has no part in the opening of a pool.
- **BNB Smart Chain has no Circle-issued USDC.** The token with the symbol USDC is Binance-Peg USD Coin, issued by
  Binance, with 18 decimals. The rehearsals use it, because a pool needs a second token; whether to list it is the
  owner's decision.
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

Once, before the first chain: make the choices of section 2 in `deployments/multichain.json` (`firstDepositor`:
the new key that will send the first deposits and nothing else) and in each `deployments/<chain>/chain.json`,
then print the plan and compare the addresses with what you expect. The plan fails while a choice is open or
`firstDepositor` is the zero address or the fee address.

Two accounts sign in this procedure, and they are different accounts: the **deploying account** (any funded
account of the owner; steps 1 and 2) and the **depositing account** (`firstDepositor`; step 4 only).

```
node scripts/multichain/plan.mjs all
```

For each chain, with its key in place of `op-mainnet` (`op-mainnet`, `base`, `arbitrum-one`, `linea`,
`bnb-smart-chain`, `ethereum`):

Step 1. Dry run, with the deploying account. It builds, plans, runs the pre gate (read-only) and simulates the
deployment. Nothing is sent. The pre gate also looks at the depositing account: it must have no code, no
EIP-7702 delegation and no transaction on this chain yet.
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

Step 4. Open the pool: the first deposit, from the depositing account, with the owner's own funds. It sets the
opening price. **Use only this tool for it, and send nothing else from that account.** The tool reads the chain
(both endpoints must show the same block), checks that the contracts are the ones the gate verified, that the
depositing account has no code, that the pool is not open and what sits at the pair's address, and prints two
`cast send` commands. Amounts are in whole units (10 native coin and 30,000 USDC in this example); `--to` names
the account that receives the LP shares when it is not the depositor.

```
node scripts/multichain/first-deposit.mjs op-mainnet prepare --pair WETH/USDC --native 10 --token 30000 --gate-report deployments/op-mainnet/gate-report.json
```

`prepare` also prints the opening price of the two amounts; compare it with the market on that chain (the example
amounts are not a price for any chain, least of all BNB Smart Chain). Send the two printed commands as they are,
adding only your signer option and `--rpc-url`; they carry `--chain`, so `cast` refuses another chain's URL. The first approves
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

Then prove the opening, with the hash of the deposit transaction:

```
node scripts/multichain/first-deposit.mjs op-mainnet verify --pair WETH/USDC --native 10 --token 30000 --tx DEPOSIT_HASH
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

**Later deposits into an open pool.** State both amounts, at the market price. The tool compares them with the
pool's own price and prints nothing when the two differ by more than the tolerance (0.5% by default, at most 1%):
a pool whose price someone moved takes nothing from the owner. It deposits only into a pool whose opening the
gate proved (the report of step 5). The deposit's minimums are that tolerance below its amounts, so a price
pushed away in the same block makes it revert:

```
node scripts/multichain/first-deposit.mjs op-mainnet add --pair WETH/USDC --native 1 --token 3000 --gate-report deployments/op-mainnet/gate-report.json
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
  section 2. A key that has been used elsewhere in the meantime can still open pools, but anyone it called may
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

The build writes `dist-multichain/_headers` with a Content-Security-Policy that names the fifteen reviewed
endpoints. Hosting is the owner's step and follows `docs/FRONTEND-HOSTING-CHECKLIST.md`.

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
  execute it twice: the swap's deadline passed with no transaction seen; another transaction used the same nonce;
  or the transaction's receipt says **reverted** (the page then offers a retry; review R328-7). These keep the
  chain's own `finalized` block wherever the chain has a usable one. The cost: after a reverted swap the account
  is held on that chain for the strict rule's time (15 to 23 minutes on four chains, about an hour on Linea,
  seconds on BNB Smart Chain) before the page lets the user try again.

| Chain | settle | Time at the measured block time | strict | Residual risk of the choice |
|---|---|---|---|---|
| OP Mainnet | 5 blocks on top | about 10 s (2 s blocks) | chain's `finalized` (15 to 23 min) | A sequencer reorganisation deeper than 5 blocks after the page showed an outcome: the page then shows a result the chain replaced; the transaction stays valid and is normally included again; the page creates no second transaction |
| Base | 50 blocks | about 10 s (0.2 s blocks) | chain's `finalized` | as OP Mainnet, deeper than 50 blocks |
| Arbitrum One | 32 blocks | about 10 s (0.31 s blocks) | chain's `finalized` (about 20 min) | as OP Mainnet, deeper than 32 blocks |
| Linea | 1 block | about 11 s on average; Linea makes a block only when there is work (3 to 82 s apart when measured), so longer when the chain is quiet | **300 blocks** (about an hour) | The two reviewed endpoints disagree on `finalized` (the first answers the block proven on Ethereum, 1 h 40 min to 5 h behind; the second answers the head), so the tag is used for neither rule. The strict rule is **not the chain's finality**: a sequencer reorganisation deeper than 300 blocks could let a swap execute after the page ended its hold |
| BNB Smart Chain | chain's `finalized` | about 1 s (the chain's fast finality is one or two blocks behind) | chain's `finalized` | Fast finality stalling: the page says so and waits, as on the Bloch L2 |
| Ethereum | 2 blocks | about 24 s (12 s blocks) | chain's `finalized` (about 15 min) | A reorganisation deeper than 2 blocks: rare since the merge, not impossible; as OP Mainnet |

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

### Third revision of the page's rules (review R328-3P-1 to 3P-5, 2026-11-17)

Where this section and the lines below it differ, this paragraph is the current state.

- **Nothing that is signed comes from one endpoint, by construction** (R328-3P-4). The comparison quote at the
  latest block, which becomes the signed quote after "reconfirm", was an `eth_call` at the tag `latest` answered by
  the first endpoint alone. The page's RPC layer now never sends a state read by tag, by number or without a
  block: it first resolves the block from two endpoints (hash and timestamp must be the same on both) and reads at
  that hash from two endpoints. The pending nonce is the higher of two answers; a block by number needs two
  endpoints. Left to one endpoint: the chain id (compared with the pinned one) and fee data (the wallet sets the
  fee). `frontend/src/test/multichain-provenance.test.ts` fails when a method the route names is not classified,
  when a lying endpoint's answer comes through in any position, or when any endpoint receives a state read by tag.
- **A reverted swap** (R328-3P-3) is settled by the chain's own rule for it (`confirmation.reverted`), between
  the settle and the strict rule; `chain.json` says per chain why a deeper replacement is not credible. OP Mainnet
  and Base: the chain's `safe` block (its batch is on Ethereum; about half a minute and a minute and a half
  behind the head when measured). Arbitrum One and Ethereum: `safe` (12 to 15 minutes when measured; finality was
  19 to 22). Linea: 30 blocks (about 6 to 9 minutes; the strict rule stays 300). BNB Smart Chain: its `finalized`
  (seconds). A reverted approval is settled like a success. The note above the form now says that a reverted swap
  holds the account, until when, and why.
- **The submission boundary** (R328-3P-1) is the block settled by the chain's rule, not the head: a one-block
  reorganisation of the head no longer leaves a hold that can never end.
- **Heads** (R328-3P-5): two heads count as apart only when they are more than 2 blocks and more than 90 seconds
  of chain time apart (a quiet Linea is not "behind"); a third endpoint is asked when one of the first two fails
  or lags; a refused request is asked again with a growing pause.
- **Endpoints**: Arbitrum One and BNB Smart Chain list four. Added, each measured to serve pinned state 45 minutes
  old and a browser's preflight: `arbitrum.gateway.tenderly.co` (Tenderly) and `api.zan.top/bsc-mainnet` (ZAN),
  placed second so that strict reads no longer depend on blastapi's shared anonymous quota. Operator independence
  is judged from the hostnames and response headers only. The CSP names seventeen origins.
- **Snapshot renewal** (R328-3P-2): every four minutes in the background, not every 30 seconds (a snapshot kept
  300 to 600 seconds was still answered on all six chains). The route must also renew on demand and never under a
  user who is typing; on this branch's plain route a renewal still resets the form, and the redesigned route
  (agent 327's line) is the one that keeps it.

### Two endpoints must agree (review R309-MC-3)

Every endpoint is a third party here. Everything the page shows and signs from (reserves, the binding quote,
balances, allowances, code hashes, the account nonce) is read at a block hash, and such a read is asked of both
reviewed endpoints and used only when both give the same answer; when they differ, or the second cannot answer
after three tries, the page shows an error and sends nothing.

Which block those reads are pinned to is taken from both endpoints too:

- the head (`latest`) is the **older** of the two endpoints' heads, so it is a block both have, and it is used
  only while the two heads are at most 90 seconds of chain time apart. An endpoint that lags further, or
  withholds new blocks, makes the page stop with a message instead of holding it on a true but old state. The
  confirmation depth is counted from that head, and the binding quote is compared with it before the wallet is
  asked. (In the second edition the head came from the first endpoint alone, and the page accepts a head up to
  10 minutes old without a notice.)
- `finalized` and `safe` are the **older** of the two answers, and both endpoints must answer: one endpoint alone
  cannot make the page treat a newer block as final (BNB Smart Chain's settle rule and the strict rule of four
  chains use the tag).
- **a transaction and its receipt** count only when two endpoints report the same inclusion and the same status;
  until then the page treats the transaction as not seen yet, which never ends a hold. One endpoint's false
  "reverted" cannot free the account for a second swap (review R328-6).

**Public endpoints do not keep a block's state for long (reviews R328-4, R328-5).** Measured on 2026-11-17, for
reads pinned to a block hash: some endpoints answer for a block a day old, others only for about a minute
(`bsc-dataseed.bnbchain.org`, publicnode on Arbitrum One), 10 minutes (publicnode on Linea), 20 minutes (Arbitrum's
own endpoint) or an hour (publicnode on BNB Smart Chain). The second edition, which asked two endpoints for a
block the page kept as long as it stayed open, therefore stopped answering quotes after about a minute on
Arbitrum One and BNB Smart Chain, and could never end a hold by its deadline on Arbitrum One and Linea. Three
things changed:

- the page takes a new snapshot block every 30 seconds while it is visible, so what it pins to is never older
  than the chain's confirmation rule plus half a minute;
- an endpoint that cannot answer for a block (not there yet, or pruned) is not a disagreement: a further listed
  endpoint stands in, and three chains now list three endpoints, ordered so that the first two keep state
  longest: Arbitrum One (its own endpoint, blastapi, publicnode), Linea (its own endpoint, dRPC, publicnode), BNB
  Smart Chain (publicnode, blastapi, the chain's dataseed);
- the strict decisions and a reverted receipt read through both endpoints at the strict block, which those lists
  serve: about 20 minutes old on four chains, about 80 minutes (300 blocks) on Linea.

No fork can show any of this (a fork keeps every state), so the package has a read-only check that runs the
page's own RPC code against the real endpoints of all six chains, with no wallet and no transaction
(section 11, "Live check"). Run it before the page is published and whenever an endpoint list changes. The
weakest place it showed: Arbitrum One's strict block is 16 to 20 minutes old and its own endpoint answers for
about 20 to 30; if it stops answering, a hold on Arbitrum One that must end by its deadline waits (nothing is
sent; the third endpoint does not keep state that long). The owner's own endpoint in the list removes that.

A block asked by number or hash that the first endpoint does not have yet is asked of the next. The pending nonce
and fee data come from the first endpoint that answers, as before; the route re-checks every block it uses by
number and hash. Measured on 2026-11-17 on the endpoints of the second edition (16 rounds per chain, seconds
apart): the two heads were the same block in 69 of 96 rounds and at most 5 blocks apart in the others, and a read
pinned to a head and to the settle block got equal answers from both endpoints in all 96.

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
  minimum cannot be removed. The loss so far is nothing but the pair. Treat the depositing key as exposed: choose
  a new depositing account, which is a new factory at a new address on that chain (section 3), deploy again, and
  open the pool there. Chains already finished are not affected; the page lists only pools whose record was
  written from a proven opening.
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
5. **Licence of the code's origin.** The pair, factory, LP token, the two libraries and the router are ports of
   Uniswap V2 (`docs/AUDIT-SCOPE-DEX.md` names v2-core and v2-periphery as the upstream; two libraries say "ported
   verbatim"). To the author's knowledge upstream publishes those under GPL-3.0, while the files here carry an MIT
   notice and the repository's `LICENSE` is an MIT text with unfilled placeholders. Before these contracts are
   published and operated under the DEX's name on public chains, a lawyer should confirm the licence the ports may
   carry and what source publication it requires. This was not checked beyond reading the files.
6. **The fee address is one key.** Losing it loses the fee for ever; a thief of it takes the accrued shares. On
   Base it currently delegates to a contract (section 4).
7. **Permissionless pairs.** Anyone can create a pair with any token, including worthless or hostile ones, but
   only the owner's depositing account can open one (section 8, "Later pairs"). The page lists only the reviewed
   pairs.
8. **BNB Smart Chain's "USDC" is not Circle's**, and has 18 decimals (section 4).
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
    read, a transaction and a receipt only when two endpoints agree, takes the head and a finality tag from the
    older of two answers, and stops when the two heads are more than 90 seconds apart. One lying or lagging
    endpoint can therefore neither show a false price or outcome nor hold the page on an old state; it can stop
    the page. Two endpoints that lie alike can deceive it, and so can a party that controls two of a chain's
    listed endpoints. Availability needs two working endpoints that keep the state the page asks for; public
    endpoints change what they serve without notice, which is what the live check is for. The owner's own
    endpoint in each list would reduce both risks.

## 13. Known issues

Recorded, not fixed in this package:

| Issue | Where it matters | What to do |
|---|---|---|
| **The route's texts say "finalized"** on chains where the page settles on a depth ("Pools at finalized block", "verified canonical and finalized", "Finalized balances"). The page states above the form what the word means on that network, but the texts themselves are the Bloch L2 route's | Users of the five depth chains | The UI redesign (agent 318's line) owns the route's texts; it should say "confirmed" there |
| **Arbitrum One: fixed gas limit under an L1 fee spike** (review R309-MC-8). The page asks 250,000 gas per hop; on Arbitrum the limit must also cover the L1 data charge. Measured: execution 158,109, which leaves 91,891; the L1 component was about 1.5 gas per calldata byte at the hour of the cost run (a swap is a few hundred bytes: some hundreds of gas), so the limit holds until that component is on the order of 150 times that hour's. Not measured under a spike | A swap on Arbitrum One during an Ethereum fee spike could run out of gas (the user loses the fee of a failed transaction, not the swap) | A per-chain gas limit, or an estimate on Arbitrum, in a later change to the route |
| **Anchored swaps revert on Arbitrum One** (section 5) | Direct callers only; the page does not use them | None in this package |
| **Fee address** (review R309-MC-7): it has never sent a transaction on OP Mainnet or Linea, and on Base it carries an EIP-7702 delegation to `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, whose code was not reviewed here | Whether anyone but the key can move the fee shares on Base depends on that delegate contract | Before Base: the owner confirms what the delegate is, or clears the delegation. Before OP Mainnet and Linea: the owner signs one transaction or message with the key on a chain where it has none. The fee address is never the depositing account (section 2) |
| **The first-depositor rule accepts the transaction origin** (review R328-1; frozen contracts) | A contract the depositing account calls can open a pool in its name | A dedicated key and the tools' refusals (sections 2, 8 and 10); a new pair contract would be the only real fix and is not part of this package |
| **A gift in front of the first deposit moves the opening price** (review R328-2; the frozen router does not look at tokens already at the pair) | The pool can open at a price that differs from the intended one by the size of what someone chose to give away | `prepare` refuses above 0.1% that is already there; `verify` and the gate report it; section 10 |
| **After a reverted swap the account is held for the strict rule's time** (review R328-7; section 9) | A user whose swap reverted on its minimum waits 15 to 23 minutes on four chains, about an hour on Linea, before the page lets them retry | A third rule for this case (the chain's `safe` tag where it is close: the reviewer measured under 30 s on OP Mainnet and about a minute on Base) in a later change |
| **The page was never run in a browser against the real endpoints** | The live check runs the page's RPC code in Node; the browser rehearsals use forks. All fifteen endpoints answered a browser's CORS preflight when measured, but a page load against them was not rehearsed | A real page load by the owner on the first chain before publishing |
| **A hold that cannot be decided says nothing new** (review R328-4): when the strict reads are refused the page keeps its hold text and tries again | The user sees a hold without a reason | The route's texts belong to the UI line (agent 327); the endpoint lists and the live check keep the case from being permanent |
| **Linea's `finalized`** differs between the two reviewed endpoints | The gate reads the first (the proven block); the page uses the tag for nothing on Linea | Stated in sections 8 and 9 |
| **No real wallet and no real transaction** were used anywhere (section 5) | The rehearsals show the code paths, not a wallet's behaviour or a chain's inclusion | A small real swap by the owner on the first chain before publishing the page |
