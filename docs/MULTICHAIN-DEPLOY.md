# PosternDEX on six public EVM chains: deployment package

Status: **prepared and rehearsed, not deployed** (2026-11-16). Nothing in this repository has sent a transaction to
any public chain or testnet. The owner runs the commands of section 8 with the owner's own signer.

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

## 1. What is deployed, and what the factory allows

The contracts are the Bloch L2 release candidate, byte for byte: `UniswapV2Factory`, `BDexRouter`, `BDexLens`, and
`UniswapV2Pair` created by the factory. Compiler settings are the pinned ones (solc 0.8.24, EVM target `paris`,
optimizer 200 runs, no metadata hash); the pair init code hash is
`0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683` on every chain, and the tools refuse a build
that gives another. No contract was edited. Everything chain-specific is a constructor argument or configuration:

| Constructor argument | Value |
|---|---|
| Factory `feeTo` | `0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` on every chain (the owner's address, EIP-55 checked) |
| Factory `firstDepositor` | owner's choice (section 2) |
| Factory reserve caps | owner's choice per chain (section 2) |
| Router wrapped native token | the chain's canonical wrapper (section 4) |

Not deployed: `WBLCH` (each chain has its own wrapped native token), `TreasuryFeeCollector`, a Safe.

**What the factory allows after deployment: nothing.** It has no owner, no fee setter and no cap setter.
`feeTo`, `firstDepositor` and the caps are fixed in the constructor.

- `feeTo` cannot be changed, ever. If the owner loses the key of `0x775a…0544`, the protocol fee of every pool of
  that factory keeps accruing to an address nobody controls. Moving the fee to another address means a new
  factory, new pair addresses, and moving all liquidity.
- `createPair` is open to anyone, for any two token contracts.
- `firstDepositor`, when it is not the zero address, is the only account that can make the first deposit of
  **any** pair of that factory.
- A cap applies to every pair that contains the capped token.

## 2. Owner's choices still open

They are marked `TBD-owner` in the configuration, and `scripts/multichain/deploy.sh` refuses to broadcast while one
is left. They are economic choices; nothing here invents them.

| Choice | File | What it means |
|---|---|---|
| `firstDepositor` | `deployments/multichain.json` | The zero address: anyone can open any pool. An address: only that account opens pools, on every pair of the factory, for ever; others can create pairs but not fund them. The account must send the first deposit itself (the pair checks `msg.sender` or `tx.origin`), so it must be a key-controlled account, not a multisig or a smart account behind a bundler |
| `reserveCaps` | `deployments/<chain>/chain.json` | `[]`: no caps (an ordinary constant-product exchange). A list of `{ "token": symbol, "cap": base units }`: a pool cannot grow past the cap on that token |
| Opening price and first liquidity | not in a file | Whoever makes the first deposit sets the price. The owner provides liquidity on each chain separately; nothing here funds a pool |
| Token list | `deployments/<chain>/chain.json` | Starts with the wrapped native token and the chain's USDC. On BNB Smart Chain the only "USDC" is Binance-Peg (section 4): listing it is the owner's decision |

Two consequences to weigh before choosing caps:

- **Addresses.** A cap names a token address, which differs per chain. With any cap the factory address differs
  from chain to chain. Without caps it is the same on all six.
- **A pool capped on both sides leaks fees to strangers on a public chain.** The pair keeps `reserve0 x reserve1`
  under a ceiling; a swap's fee above the ceiling stays outside the reserves, where `skim` removes it. `skim` is
  open to anyone and pays the address the caller names. On the Bloch L2 a keeper skims to the Safe. On a public
  chain searchers will skim first, and the keeper cannot be given priority: the contracts have no place for it.
  Uncapped pools have no ceiling and no such leak.

The reference plan used in every rehearsal is "first deposits open, no caps". It is a rehearsal value, not a
recommendation the owner is bound to.

## 3. Addresses

Factory, router and lens are created by the deterministic CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`
(verified on all six chains: same runtime code, hash `0x2fa86add…4989`) with the salt
`keccak256("postern-dex.multichain.v1")` = `0xe5077402…c57a`. An address depends only on the deployer, the salt
and the init code (contract code plus constructor arguments), not on who sends the transaction.

With the reference plan (`node scripts/multichain/plan.mjs all --reference`):

| Contract | Address | Same on |
|---|---|---|
| Factory | `0xF627d92c62ca84a86890350806dBa615e42eE623` | all six |
| Lens | `0x820a7DCA04396E955A0AD5d235253D261a338fe9` | all six |
| Router | `0x8eBD5Bc637eC39B066549d34cf3bF6f6b2AC27fD` | OP Mainnet and Base (both use the WETH predeploy `0x4200…0006`) |
| Router | `0x47D08Aa3a5f13Bd6D0e41642B88D100dD16154a0` | Arbitrum One |
| Router | `0xCe3ab7eF556cba53CB9aB203bEacA60A904F7AE1` | Linea |
| Router | `0x6d978B0c639eE8e188BD3E71A01E064D51Db6907` | BNB Smart Chain |
| Router | `0x750C23337BFB34aF3A89C7B754F5C223BA64ACF2` | Ethereum |

Why the router differs: the wrapped native token is a constructor argument, and it has another address on each
chain except the two OP Stack chains. Pair addresses differ everywhere, because token addresses differ.

**These addresses change with the owner's choices.** Another `firstDepositor` or any cap is another factory init
code, so another factory address, and with it another router and lens. Run the plan after the choices are made;
the gate and the page take the addresses from the plan, never from this table.

Because the addresses do not depend on the sender, anyone can create the same contracts first by sending the same
bytes. The result is the identical contract with the identical `feeTo`: harmless. `deploy.sh` skips a step whose
address already holds code, and the gate then checks that code like any other.

## 4. Chain facts verified on-chain

Read from two public endpoints per chain on 2026-11-16 (`node scripts/multichain/gate.mjs <chain> pre --reference`:
PASS on all six). Each token is pinned by address, runtime code hash, `name()`, `symbol()` and `decimals()`.

| Chain | Id | Wrapped native | Listed token | Documentation checked |
|---|---|---|---|---|
| OP Mainnet | 10 | WETH `0x4200000000000000000000000000000000000006` (predeploy) | USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, 6 decimals | OP Stack predeploy specification (WETH9); Circle's USDC address list |
| Base | 8453 | WETH `0x4200000000000000000000000000000000000006` (predeploy) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals | OP Stack predeploy specification; Circle's list |
| Arbitrum One | 42161 | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` (upgradeable proxy) | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, 6 decimals (native, not USDC.e) | Arbitrum contract addresses page; Circle's list |
| Linea | 59144 | WETH `0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f` | USDC `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`, 6 decimals | Circle's list for USDC. **WETH: documentation page not reached**; identified on-chain (below) |
| BNB Smart Chain | 56 | WBNB `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | "USDC" `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, **18 decimals, Binance-Peg, not issued by Circle** | Circle's list has no BNB Smart Chain entry. **WBNB: documentation page not reached**; identified on-chain |
| Ethereum | 1 | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals | Circle's list for USDC. **WETH: documentation page not reached**; identified on-chain |

On-chain identification of the three wrappers whose documentation page was not reached: name and symbol as
listed, 18 decimals, and the native coin they held at the time of reading: 2,071,341 ETH (Ethereum), 3,592 ETH
(Linea), 1,567,925 BNB (BNB Smart Chain). The owner should confirm these three addresses against a source the
owner trusts before deploying; the router's wrapped token cannot be changed afterwards.

Other facts:

- **Fee address.** An externally owned account on every chain. Transactions seen from it: Ethereum 223, BNB Smart
  Chain 242, Arbitrum One 11, Base 1, Linea 0, OP Mainnet 0. **On Base it carries an EIP-7702 delegation** to
  `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`: the key still controls the account, and code runs at the address
  when it is called. The fork rehearsal and the simulation on Base's own node show that it receives the native
  coin and redeems its fee shares in that state. What that delegate contract is was not established here; the
  owner should know it (a wallet sets such a delegation).
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
| Does the owner's command work against the chain's real state? | `scripts/multichain/rehearse-fork.mjs`: an anvil fork per chain, `deploy.sh broadcast` with a throwaway key, the post gate, then the flow with signed transactions | PASS on all six (section 11) |
| Do chain-dependent opcodes behave as the contracts expect? | The code uses TIMESTAMP (deadlines, price accumulators), CHAINID (LP permit domain), ORIGIN (first-deposit rule), NUMBER and BLOCKHASH (anchored swaps, lens) | Deadlines, permits' chain id and the flow work on all six nodes. **Anchored swaps (`swap…Anchored`) revert `BDEX: ANCHOR` on Arbitrum One** when given the block number and hash its RPC reports, because there `block.number` and `blockhash` do not refer to Arbitrum's own blocks. They work on the other five. The page does not use anchored swaps; a direct caller on Arbitrum One cannot |
| Does the unchanged test suite hold under later EVM rules? | `forge test` compiled for `shanghai`, `cancun` and `prague` | 238 of 240 pass on each; the 2 that fail are the tests that pin the Paris bytecode's pair init code hash, which is their purpose. The deployed bytecode stays the Paris build |
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
five swaps: 1 native, 3,000 token units, 1 wrapped, 2,000 token units and 0.1 native; then one more deposit). The fee address's shares after that deposit
were worth:

| Chain | Fee shares worth | Redeemed by the fee address |
|---|---|---|
| OP Mainnet | 0.000922 ETH + 2.623572 USDC | 0.000922 ETH + 2.623572 USDC, in two transactions of 264,535 gas |
| Base | 0.000922 ETH + 2.623572 USDC | 0.000922 ETH + 2.623572 USDC, in two transactions of 266,683 gas |
| Arbitrum One | 0.000922 ETH + 2.623572 USDC | 0.000922 ETH + 2.623572 USDC, in two transactions of 268,538 gas |
| Linea | 0.000922 ETH + 2.623572 USDC | 0.000922 ETH + 2.623572 USDC, in two transactions of 268,673 gas |
| BNB Smart Chain | 0.000922 BNB + 2.623572 USDC | 0.000922 BNB + 2.623572 USDC, in two transactions of 269,358 gas |
| Ethereum | 0.000922 ETH + 2.623572 USDC | 0.000922 ETH + 2.623572 USDC, in two transactions of 265,212 gas |

The fee address received exactly what its shares were worth; on Base it did so with its EIP-7702 delegation in place.

The same sequence on each chain's own node (simulation, read-only), fee shares worth: OP Mainnet 0.000897 ETH + 2.554720 USDC; Base 0.000897 ETH + 2.554720 USDC; Arbitrum One 0.000889 ETH + 2.577511 USDC; Linea 0.000897 ETH + 2.554720 USDC; BNB Smart Chain 0.000897 BNB + 2.554720 USDC; Ethereum 0.000897 ETH + 2.554720 USDC. Arbitrum One differs because its anchored swap reverted there (section 5), so that pool saw one swap less.

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

Execution gas is the fork rehearsals' receipts: the same bytes the owner sends. Four transactions: factory, router
and lens through the CREATE2 deployer, and `createPair` for the wrapped native token and USDC.

| Step | Gas |
|---|---|
| Factory | 2,617,452 |
| Router | 4,082,527 to 4,082,743 |
| Lens | 2,261,269 |
| `createPair` | 2,294,996 to 2,295,222 |
| **Total** | **about 11,256,500** |

In native coin, at the gas price each chain's node reported at the time of the run, with the rollup's data fee read
from its own oracle (`scripts/multichain/cost.mjs`, 2026-11-16 about 19:25 UTC):

| Chain | Gas price used | Data fee | Total |
|---|---|---|---|
| OP Mainnet | 0.001030 gwei | 0.000000465 ETH | **0.000012 ETH** |
| Base | 0.006000 gwei | 0.000000322 ETH | **0.000068 ETH** |
| Arbitrum One | 0.020048 gwei | 106,084 gas added | **0.000228 ETH** |
| Linea | 0.039593 gwei | in the gas price | **0.000446 ETH** |
| BNB Smart Chain | 0.050000 gwei | none | **0.000563 BNB** |
| Ethereum | 0.156815 gwei | none | **0.001765 ETH** |

Gas prices were low at that hour (Ethereum 0.16 gwei). A real deployment pays the price of its own hour; plan with
the figures that follow, not with the table. For Ethereum, execution gas only: 0.0113 ETH at 1 gwei, 0.0563
ETH at 5 gwei, 0.2251 ETH at 20 gwei, 0.5628 ETH at 50 gwei. The deploying account needs that much native coin on
each chain, plus a margin. It can be any account; it does not have to be the fee address.

After deployment the owner's first deposit costs about 280,000 to 300,000 gas, an approval 46,000 to 60,000, a
swap 115,000 to 192,000 (measured on the forks).

## 8. Deployment, chain by chain (owner)

Order: cheapest first, so that a mistake is found where it costs least: **OP Mainnet, Base, Arbitrum One, Linea,
BNB Smart Chain, Ethereum.** Finish one chain, including its post gate, before starting the next.

Needs: this repository at the reviewed commit, Foundry (forge, cast), Node 24, `frontend/node_modules` installed
(`npm ci --ignore-scripts` in `frontend/`), and a signer forge supports (`--ledger`, `--trezor`, or
`--account NAME` for an encrypted keystore). Never put a private key on a command line.

Once, before the first chain: make the choices of section 2 in `deployments/multichain.json` and in each
`deployments/<chain>/chain.json`, then print the plan and compare the addresses with what you expect:

```
node scripts/multichain/plan.mjs all
```

For each chain, with its key in place of `op-mainnet` (`op-mainnet`, `base`, `arbitrum-one`, `linea`,
`bnb-smart-chain`, `ethereum`):

Step 1. Dry run. It builds, plans, runs the pre gate (read-only) and simulates the deployment. Nothing is sent.

```
scripts/multichain/deploy.sh op-mainnet dry-run -- --ledger
```

Step 2. Deploy. Four transactions to confirm on the signer.

```
scripts/multichain/deploy.sh op-mainnet broadcast -- --ledger
```

Step 3. Wait until the chain has finalized them (a few minutes on Ethereum; on the rollups until the batch is
finalized on Ethereum, which can take from minutes to about an hour), then run the post gate. It must say PASS.

```
node scripts/multichain/gate.mjs op-mainnet post --out deployments/op-mainnet/gate-report.json
```

Step 4. Write the page's record of this chain from the gate report.

```
node scripts/multichain/frontend-files.mjs op-mainnet --gate-report deployments/op-mainnet/gate-report.json
```

Step 5. First liquidity, from the account that may make the first deposit. This is the owner's own transaction
with the owner's own funds; it sets the opening price. Approve the token to the router, then deposit
(`AMOUNT_TOKEN` in the token's base units, `AMOUNT_NATIVE` in wei, the minimums as the owner chooses):

```
cast send TOKEN_ADDRESS "approve(address,uint256)" ROUTER_ADDRESS AMOUNT_TOKEN --rpc-url RPC_URL --ledger
```

```
cast send ROUTER_ADDRESS "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" TOKEN_ADDRESS AMOUNT_TOKEN MIN_TOKEN MIN_NATIVE YOUR_ADDRESS DEADLINE --value AMOUNT_NATIVE --rpc-url RPC_URL --ledger
```

If the sender through the reviewed public endpoint is a problem (rate limits), set `MC_RPC_URL` to the owner's own
provider for `deploy.sh`; the gate still reads the two reviewed endpoints.

A second run of step 2 is safe: steps that already have code are skipped.

## 9. After deployment: the page

The multichain site is its own build with its own entry (`frontend/multichain.html`) and output
(`frontend/dist-multichain`); the Bloch L2 site does not contain it. It shows a network selector over the six
chains. A chain whose record says "not-deployed" shows "Not yet live" and makes no request. After step 4 for a
chain, build and publish:

```
npm --prefix frontend run build:multichain
```

The build writes `dist-multichain/_headers` with a Content-Security-Policy that names the twelve reviewed
endpoints. Hosting is the owner's step and follows `docs/FRONTEND-HOSTING-CHECKLIST.md`.

What the page does on these chains, by configuration and not by deleted code:

| Bloch L2 rule | On these chains |
|---|---|
| New-slot priority fee, credit rule | off: the wallet sets the fee |
| Idle-chain rule (deadline raised, heartbeat wait) | off: a latest block older than 10 minutes is reported as a lagging endpoint, the deadline is not changed |
| Bridge token pin, bridge hold notice, Safe pin | off: no bridge is listed and the fee address is an account |
| Finalized reads, code-hash check of every contract and token, same-nonce hold, no second swap request, explicit gas limits, slippage bounds | unchanged |

The page reads through the first endpoint that answers and moves to the second when one fails. Selecting a network
asks nothing of the wallet; "Add or switch to …" and every transaction ask the wallet to switch
(`wallet_switchEthereumChain`, then `wallet_addEthereumChain` if the wallet does not know the chain). A pending
swap on one chain does not hold another chain.

Limits of the page on these chains: the default deadline is the Bloch L2's 60 minutes (the user can set 10 to
180); it lists only the pairs of the record; it has no liquidity form (deposits and withdrawals are made as in
sections 6 and 8, or with any tool that speaks to the router).

## 10. If something goes wrong

- **Nothing can be undone.** A deployed contract stays. There is no upgrade, no pause and no owner.
- A wrong deployment (wrong choice of `firstDepositor` or caps, wrong wrapped token) costs the gas of that chain's
  deployment and leaves unused contracts behind. The fix is to correct the configuration and deploy again: the new
  factory has another address. Nothing is lost as long as no liquidity was put in.
- If liquidity is already in a wrong deployment, its provider withdraws it through that deployment's router; the
  locked minimum (1,000 base units of LP shares, worth a dust amount) stays.
- If the post gate fails, do not write the page's record and do not add liquidity. Read which check failed; the
  gate changes nothing.
- If a transaction of step 2 fails or the signer is interrupted, run step 2 again.
- The fee address cannot be changed (section 1). Check the key before the first chain, not after the sixth.

## 11. Rehearsals and how to repeat them

Everything below is loopback or read-only, with throwaway keys. Run of record: code commit `a986365`, 2026-11-16 (commits after it change documents and Solidity formatting only; the suites were run again on the final commit).

| Rehearsal | Command | What it shows | Result |
|---|---|---|---|
| Kit tests | `node --test scripts/multichain/*.test.mjs` | configuration, plan, gate, opcode set, refusals | 14 pass |
| Deploy script | `forge test --match-contract MultichainScriptTest` | planned addresses on the deployer's real runtime, a second run deploys nothing, refusals | pass |
| Pre gate on the public chains | `node scripts/multichain/gate.mjs <chain> pre --reference` | pins against the real chains, read-only | PASS, six of six |
| Simulation on the real nodes | `node scripts/multichain/simulate-chain.mjs <chain> --out FILE` | deployment and flow on the chain's own node software, read-only | PASS, six of six |
| Fork rehearsal | `node scripts/multichain/rehearse-fork.mjs <chain> --port PORT --out DIR` | the owner's command, the post gate, the flow with signed transactions, gas, fee amounts | PASS, six of six, 13 checks each |
| Page rehearsal | `node scripts/multichain/rehearse-page.mjs --port PORT --out DIR` | the multichain site in a real browser engine against six forks: network switch, one swap per chain, holds per chain | PASS: 6 chains, 37 assertions, 0 failed |
| Page unit tests | `npm --prefix frontend test` | the multichain configuration, endpoint failover, wording, headers, selector | 513 pass (499 as before this line, 14 new), 1 skipped |

Per chain:

| Chain | Pre gate (real chain) | Simulation (real node) | Fork rehearsal | Deployment gas | Page: switch and swap |
|---|---|---|---|---|---|
| OP Mainnet | PASS | PASS (op-reth; anchored swap works) | PASS, 13 checks | 11,256,254 | PASS, swap 142,816 gas |
| Base | PASS | PASS (reth; anchored swap works) | PASS, 13 checks | 11,256,244 | PASS, swap 142,746 gas |
| Arbitrum One | PASS | PASS (nitro; anchored swap reverts) | PASS, 13 checks | 11,256,676 | PASS, swap 158,109 gas |
| Linea | PASS | PASS (Geth; anchored swap works) | PASS, 13 checks | 11,256,686 | PASS, swap 146,883 gas |
| BNB Smart Chain | PASS | PASS (Geth; anchored swap works) | PASS, 13 checks | 11,256,686 | PASS, swap 140,324 gas |
| Ethereum | PASS | PASS (reth; anchored swap works) | PASS, 13 checks | 11,256,686 | PASS, swap 143,720 gas |

Fork sources: the reviewed first endpoint, except BNB Smart Chain (both reviewed endpoints drop a block's state
within minutes; the rehearsal forks from another public endpoint that keeps it) and Ethereum (its first endpoint
answered the fork's block 0 request from a history-pruned backend; the second is used).

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
7. **Permissionless pairs.** Anyone can create a pair with any token, including worthless or hostile ones. The
   page lists only the reviewed pairs, but the contracts serve all.
8. **BNB Smart Chain's "USDC" is not Circle's**, and has 18 decimals (section 4).
9. **Public endpoints.** The page depends on public RPC endpoints the owner does not run; they rate-limit, prune
   history and change. Two are listed per chain; the owner may prefer own endpoints.
