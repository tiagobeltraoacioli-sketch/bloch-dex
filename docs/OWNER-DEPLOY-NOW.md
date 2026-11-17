# PosternDEX on six public chains: the owner's deployment, step by step

Status: **ready for the owner to run; dry-run on a fork of each chain (section 8); nothing deployed.** Written
2026-11-17 by agent 367 (round 18) from the tools of `docs/MULTICHAIN-DEPLOY.md` (agent 360's line). The reasons
behind every rule are in that document; this one is only the sequence, with every command exactly as you type it.
A Portuguese copy for the owner is `docs/OWNER-DEPLOY-NOW-PT.md`; this English file is the one the dry run executes.

What happens: on each of OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain and Ethereum, three contracts
(factory, router, lens; the audited Bloch L2 release candidate, byte for byte) are deployed at the planned
addresses, then the first pool (the chain's wrapped native coin against its USDC) is opened by your depositing
account with your money at the chain's market price, proven, and recorded for the page. The protocol fee goes to
`0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` on every chain, for ever (it cannot be changed after step 4 of a chain).

Rules for the whole procedure:

- Every command is one block; paste one block at a time; nothing in a block is a comment. Words in capitals
  (`DEPLOYER_ADDRESS`, `DEPOSIT_HASH`, `TOKEN_AMOUNT`) are yours to replace.
- **Nothing in this procedure ever asks for a private key on the command line.** Keys live in encrypted keystore
  files; `cast` and `forge` ask for the password.
- One chain at a time, in the order of section 4 (cheapest first: a mistake is found where it costs least).
  Finish a chain (through its step 11) before starting the next.
- **Any line starting `FAIL`, any `STOP`, any error: stop that chain and read section 6.** A `WAIT` line is not a
  failure (the chain has not finalized yet: run the same command again later).
- Run everything from the repository's top directory.

## 1. What you need

| What | Detail |
|---|---|
| This repository | postern-dex at the commit the integrator (agent 366) names as reviewed, on `main`; `git status` clean |
| Foundry | `forge`, `cast` (the dry run used Foundry 1.7.1) |
| Node.js | version 24, and the frontend's packages installed once (section 2.1) |
| The fee address's wallet | the wallet that holds `0x775a…0544` (a MetaMask account, or a Ledger): used once, to sign one message, no transaction (section 2.3) |
| The depositing key | the encrypted keystore `~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante` (address `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3`, created 2026-11-17). It signs only the two transactions step 7 prints on each chain |
| A deploying key (new) | a **plain hot key, used once**: created in section 2.4, funded with a little gas money per chain, used for the three deployment transactions of each chain and nothing else, emptied and deleted at the end. It has **no power** over anything it deploys (the contracts have no owner); losing it or leaking it after the deployment costs nothing but its leftover gas money |
| Money | per chain: the deploying account's gas (section 3); the first deposit itself (your amount, in the native coin and USDC, at least the minimum of section 3) plus the depositing account's gas |

Three different accounts appear, and they must stay different: the fee address (receives, never signs anything
here except the message), the depositing account (steps 6 and 7 only), the deploying account (steps 2 to 4 only).

## 2. Once, before the first chain

### 2.1 Get the reviewed repository and install

```
cd ~/postern-dex
```

```
git fetch origin
```

```
git checkout main
```

```
git pull --ff-only
```

```
git log -1 --oneline
```

Compare the commit printed with the one the integrator names. Then install the frontend's packages (used by the
tools as a library; no install script runs):

```
npm --prefix frontend ci --ignore-scripts
```

<!-- run: once kit-tests -->
```
node --test scripts/multichain/multichain.test.mjs
```

It must end with `fail 0`.

### 2.2 Check the depositing account again (read-only)

<!-- run: once check-depositor -->
```
node scripts/multichain/check-depositor.mjs 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3
```

It must say FIT: no code, nonce 0, no delegation on all six chains. If it does not, stop: the account was used,
and section 6 ("the depositing account was used") applies before anything is deployed.

### 2.3 The fee address: sign the proof of control (no transaction, no cost)

Every pre gate refuses until this is recorded. Print the message:

<!-- run: once fee-proof-message -->
```
node scripts/multichain/fee-proof.mjs message
```

It prints exactly this one line (compare it word for word with what your wallet shows before you confirm):

> PosternDEX fee address proof (postern.dex.multichain.fee-address-proof.v1). I control the address 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 and name it as the protocol fee recipient (feeTo) of the PosternDEX factory on the chains with ids 10, 8453, 42161, 59144, 56, 1. This message is not a transaction and authorizes no transfer and no approval.

Sign it **as a message** with the fee address. With a Ledger:

```
cast wallet sign --ledger "$(node scripts/multichain/fee-proof.mjs message)"
```

With MetaMask (the fee address carries MetaMask's smart-account delegation on Base, so it is presumably a MetaMask
account): write the local signing page, serve it on this machine only, open `http://127.0.0.1:8765/`, choose the
fee account, press the button, confirm in the wallet, copy the signature (`0x` and 130 hex digits), then stop the
server with Ctrl-C:

<!-- run: once fee-proof-page -->
```
node scripts/multichain/fee-proof.mjs page --out /tmp/fee-proof-page
```

```
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/fee-proof-page
```

Record the signature (`0xSIGNATURE` is what you copied). The tool checks it offline, in its own process (65 bytes,
low `s`, `v` 27 or 28, recovered address equal to the fee address) and writes `deployments/fee-address-proof.json`
only if it is valid:

<!-- run: once fee-proof-record -->
```
node scripts/multichain/fee-proof.mjs record --signature 0xSIGNATURE
```

<!-- run: once fee-proof-verify -->
```
node scripts/multichain/fee-proof.mjs verify
```

It must end with `fee address proof: VALID`. Commit the file (a signature is public: it proves, it authorizes nothing):

```
git add deployments/fee-address-proof.json
```

```
git commit -m "Fee address: the owner's signed proof of control"
```

Never sign anything else with the fee wallet on any site: no "permission", "delegation" or "smart account"
request (`docs/MULTICHAIN-DEPLOY.md` section 2.3).

### 2.4 Create the deploying key (plain hot key, used once)

On this machine. `cast` asks for a new password twice and prints the keystore's path and `Address: 0x…`. That
address is `DEPLOYER_ADDRESS` in the rest of this document. The private key is never shown.

<!-- run: once deployer-dir -->
```
mkdir -p ~/Desktop/DEX-CHAVE-DEPLOY
```

<!-- run: once deployer-new -->
```
cast wallet new ~/Desktop/DEX-CHAVE-DEPLOY deployer
```

To print the address again later:

<!-- run: once deployer-address -->
```
cast wallet address --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

Check that it is neither `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` (the depositing account) nor
`0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` (the fee address). It is a new key: it would be either only by an
error of the tool, so if it is, stop.

### 2.5 The plan

<!-- run: once plan -->
```
node scripts/multichain/plan.mjs all
```

The addresses printed must be these (they follow from the committed choices; `docs/MULTICHAIN-DEPLOY.md`
section 3): factory `0x47D4ae3D6d8e2d8261Ee7beEF510a217Bf4a4C50` and lens
`0x5709FF514a909aD0D994eC73D6128F38bF4F1Ca6` on all six; router `0xc1D01eF14c0Cfe961f548398f9b12CfDC71172C9`
(OP Mainnet and Base), `0xFf5f74c4Ca90Ae6024a29175c6d9d92CbD51C5E1` (Arbitrum One),
`0xf6046184F7267f0872BaB182C661f1C85695cAE2` (Linea), `0x605E6b76402FF050BddC903Ea2326451272f7e32` (BNB Smart
Chain), `0x8A1DdC0BAE18A038D4E5Bb088eeDcdE10b61db53` (Ethereum). If any differs, stop.

## 3. Money per chain

RESULTS-MONEY

## 4. Chain by chain

Order: OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain, Ethereum (cheapest first; section 3 shows today's
costs). Each chain has the same eleven steps.

### 4.1 OP Mainnet (`op-mainnet`, chain id 10)

Endpoint used for sending in this section: `https://mainnet.optimism.io` (the first reviewed endpoint of `deployments/op-mainnet/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, 6 decimals. Minimum first deposit: 0.1 ETH and its USDC.

**op-mainnet-1. Pre gate (read-only).** Must end with `multichain gate op-mainnet pre: PASS`.

<!-- run: op-mainnet pre-gate -->
```
node scripts/multichain/gate.mjs op-mainnet pre
```

**op-mainnet-2. Fund the deploying account** with **0.001 ETH** on OP Mainnet (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: op-mainnet deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://mainnet.optimism.io
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: op-mainnet gas-price -->
```
cast gas-price --rpc-url https://mainnet.optimism.io
```

**op-mainnet-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: op-mainnet deploy-dry-run -->
```
scripts/multichain/deploy.sh op-mainnet dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**op-mainnet-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: op-mainnet deploy-broadcast -->
```
scripts/multichain/deploy.sh op-mainnet broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**op-mainnet-5. Post gate**, after waiting 16 to 23 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: op-mainnet post-gate-deployed -->
```
node scripts/multichain/gate.mjs op-mainnet post --out deployments/op-mainnet/gate-report.json
```

**op-mainnet-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on OP Mainnet with the native amount you will deposit **plus 0.0005 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.1` by your amount (at least 0.1). Transfers **to** the depositing account are safe; it must **send** nothing but step op-mainnet-7.

<!-- run: op-mainnet market -->
```
node scripts/multichain/market.mjs op-mainnet --native 0.1
```

Check both balances arrived:

<!-- run: op-mainnet depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://mainnet.optimism.io
```
<!-- run: op-mainnet depositor-token -->
```
cast call 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://mainnet.optimism.io
```

(The second number is in base units: 6 decimals.)

**op-mainnet-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: op-mainnet prepare -->
```
node scripts/multichain/first-deposit.mjs op-mainnet prepare --pair WETH/USDC --native 0.1 --gate-report deployments/op-mainnet/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 10):

<!-- run: op-mainnet send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://mainnet.optimism.io
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**op-mainnet-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: op-mainnet verify -->
```
node scripts/multichain/first-deposit.mjs op-mainnet verify --pair WETH/USDC --native 0.1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**op-mainnet-9. Post gate with the opening**, after the same wait as op-mainnet-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: op-mainnet post-gate-open -->
```
node scripts/multichain/gate.mjs op-mainnet post --opening WETH/USDC=DEPOSIT_HASH --out deployments/op-mainnet/gate-report.json
```

**op-mainnet-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: op-mainnet frontend-record -->
```
node scripts/multichain/frontend-files.mjs op-mainnet --gate-report deployments/op-mainnet/gate-report.json
```

**op-mainnet-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: op-mainnet record-add -->
```
git add deployments/op-mainnet
```
<!-- run: op-mainnet record-commit -->
```
git commit -m "OP Mainnet: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

### 4.2 Base (`base`, chain id 8453)

Endpoint used for sending in this section: `https://mainnet.base.org` (the first reviewed endpoint of `deployments/base/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals. Minimum first deposit: 0.1 ETH and its USDC.

**base-1. Pre gate (read-only).** Must end with `multichain gate base pre: PASS`.

<!-- run: base pre-gate -->
```
node scripts/multichain/gate.mjs base pre
```

**base-2. Fund the deploying account** with **0.001 ETH** on Base (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: base deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://mainnet.base.org
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: base gas-price -->
```
cast gas-price --rpc-url https://mainnet.base.org
```

**base-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: base deploy-dry-run -->
```
scripts/multichain/deploy.sh base dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**base-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: base deploy-broadcast -->
```
scripts/multichain/deploy.sh base broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**base-5. Post gate**, after waiting 16 to 23 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: base post-gate-deployed -->
```
node scripts/multichain/gate.mjs base post --out deployments/base/gate-report.json
```

**base-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on Base with the native amount you will deposit **plus 0.0005 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.1` by your amount (at least 0.1). Transfers **to** the depositing account are safe; it must **send** nothing but step base-7.

<!-- run: base market -->
```
node scripts/multichain/market.mjs base --native 0.1
```

Check both balances arrived:

<!-- run: base depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://mainnet.base.org
```
<!-- run: base depositor-token -->
```
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://mainnet.base.org
```

(The second number is in base units: 6 decimals.)

**base-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: base prepare -->
```
node scripts/multichain/first-deposit.mjs base prepare --pair WETH/USDC --native 0.1 --gate-report deployments/base/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 8453):

<!-- run: base send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://mainnet.base.org
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**base-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: base verify -->
```
node scripts/multichain/first-deposit.mjs base verify --pair WETH/USDC --native 0.1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**base-9. Post gate with the opening**, after the same wait as base-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: base post-gate-open -->
```
node scripts/multichain/gate.mjs base post --opening WETH/USDC=DEPOSIT_HASH --out deployments/base/gate-report.json
```

**base-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: base frontend-record -->
```
node scripts/multichain/frontend-files.mjs base --gate-report deployments/base/gate-report.json
```

**base-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: base record-add -->
```
git add deployments/base
```
<!-- run: base record-commit -->
```
git commit -m "Base: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

### 4.3 Arbitrum One (`arbitrum-one`, chain id 42161)

Endpoint used for sending in this section: `https://arb1.arbitrum.io/rpc` (the first reviewed endpoint of `deployments/arbitrum-one/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, 6 decimals. Minimum first deposit: 0.1 ETH and its USDC.

**arbitrum-one-1. Pre gate (read-only).** Must end with `multichain gate arbitrum-one pre: PASS`.

<!-- run: arbitrum-one pre-gate -->
```
node scripts/multichain/gate.mjs arbitrum-one pre
```

**arbitrum-one-2. Fund the deploying account** with **0.002 ETH** on Arbitrum One (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: arbitrum-one deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://arb1.arbitrum.io/rpc
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: arbitrum-one gas-price -->
```
cast gas-price --rpc-url https://arb1.arbitrum.io/rpc
```

**arbitrum-one-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: arbitrum-one deploy-dry-run -->
```
scripts/multichain/deploy.sh arbitrum-one dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**arbitrum-one-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: arbitrum-one deploy-broadcast -->
```
scripts/multichain/deploy.sh arbitrum-one broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**arbitrum-one-5. Post gate**, after waiting about 20 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: arbitrum-one post-gate-deployed -->
```
node scripts/multichain/gate.mjs arbitrum-one post --out deployments/arbitrum-one/gate-report.json
```

**arbitrum-one-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on Arbitrum One with the native amount you will deposit **plus 0.001 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.1` by your amount (at least 0.1). Transfers **to** the depositing account are safe; it must **send** nothing but step arbitrum-one-7.

<!-- run: arbitrum-one market -->
```
node scripts/multichain/market.mjs arbitrum-one --native 0.1
```

Check both balances arrived:

<!-- run: arbitrum-one depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://arb1.arbitrum.io/rpc
```
<!-- run: arbitrum-one depositor-token -->
```
cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://arb1.arbitrum.io/rpc
```

(The second number is in base units: 6 decimals.)

**arbitrum-one-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: arbitrum-one prepare -->
```
node scripts/multichain/first-deposit.mjs arbitrum-one prepare --pair WETH/USDC --native 0.1 --gate-report deployments/arbitrum-one/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 42161):

<!-- run: arbitrum-one send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://arb1.arbitrum.io/rpc
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**arbitrum-one-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: arbitrum-one verify -->
```
node scripts/multichain/first-deposit.mjs arbitrum-one verify --pair WETH/USDC --native 0.1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**arbitrum-one-9. Post gate with the opening**, after the same wait as arbitrum-one-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: arbitrum-one post-gate-open -->
```
node scripts/multichain/gate.mjs arbitrum-one post --opening WETH/USDC=DEPOSIT_HASH --out deployments/arbitrum-one/gate-report.json
```

**arbitrum-one-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: arbitrum-one frontend-record -->
```
node scripts/multichain/frontend-files.mjs arbitrum-one --gate-report deployments/arbitrum-one/gate-report.json
```

**arbitrum-one-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: arbitrum-one record-add -->
```
git add deployments/arbitrum-one
```
<!-- run: arbitrum-one record-commit -->
```
git commit -m "Arbitrum One: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

### 4.4 Linea (`linea`, chain id 59144)

Endpoint used for sending in this section: `https://rpc.linea.build` (the first reviewed endpoint of `deployments/linea/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`, 6 decimals. Minimum first deposit: 0.1 ETH and its USDC.

**linea-1. Pre gate (read-only).** Must end with `multichain gate linea pre: PASS`.

<!-- run: linea pre-gate -->
```
node scripts/multichain/gate.mjs linea pre
```

**linea-2. Fund the deploying account** with **0.003 ETH** on Linea (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: linea deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://rpc.linea.build
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: linea gas-price -->
```
cast gas-price --rpc-url https://rpc.linea.build
```

**linea-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: linea deploy-dry-run -->
```
scripts/multichain/deploy.sh linea dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**linea-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: linea deploy-broadcast -->
```
scripts/multichain/deploy.sh linea broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**linea-5. Post gate**, after waiting 1 h 40 min to more than 5 hours for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: linea post-gate-deployed -->
```
node scripts/multichain/gate.mjs linea post --out deployments/linea/gate-report.json
```

**linea-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on Linea with the native amount you will deposit **plus 0.001 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.1` by your amount (at least 0.1). Transfers **to** the depositing account are safe; it must **send** nothing but step linea-7.

<!-- run: linea market -->
```
node scripts/multichain/market.mjs linea --native 0.1
```

Check both balances arrived:

<!-- run: linea depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://rpc.linea.build
```
<!-- run: linea depositor-token -->
```
cast call 0x176211869cA2b568f2A7D4EE941E073a821EE1ff "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://rpc.linea.build
```

(The second number is in base units: 6 decimals.)

**linea-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: linea prepare -->
```
node scripts/multichain/first-deposit.mjs linea prepare --pair WETH/USDC --native 0.1 --gate-report deployments/linea/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 59144):

<!-- run: linea send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://rpc.linea.build
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**linea-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: linea verify -->
```
node scripts/multichain/first-deposit.mjs linea verify --pair WETH/USDC --native 0.1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**linea-9. Post gate with the opening**, after the same wait as linea-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: linea post-gate-open -->
```
node scripts/multichain/gate.mjs linea post --opening WETH/USDC=DEPOSIT_HASH --out deployments/linea/gate-report.json
```

**linea-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: linea frontend-record -->
```
node scripts/multichain/frontend-files.mjs linea --gate-report deployments/linea/gate-report.json
```

**linea-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: linea record-add -->
```
git add deployments/linea
```
<!-- run: linea record-commit -->
```
git commit -m "Linea: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

### 4.5 BNB Smart Chain (`bnb-smart-chain`, chain id 56)

Endpoint used for sending in this section: `https://bsc-rpc.publicnode.com` (the first reviewed endpoint of `deployments/bnb-smart-chain/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC (Binance-Peg) `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, 18 decimals. Minimum first deposit: 0.5 BNB and its USDC (Binance-Peg).

**bnb-smart-chain-1. Pre gate (read-only).** Must end with `multichain gate bnb-smart-chain pre: PASS`.

<!-- run: bnb-smart-chain pre-gate -->
```
node scripts/multichain/gate.mjs bnb-smart-chain pre
```

**bnb-smart-chain-2. Fund the deploying account** with **0.005 BNB** on BNB Smart Chain (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: bnb-smart-chain deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://bsc-rpc.publicnode.com
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: bnb-smart-chain gas-price -->
```
cast gas-price --rpc-url https://bsc-rpc.publicnode.com
```

**bnb-smart-chain-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: bnb-smart-chain deploy-dry-run -->
```
scripts/multichain/deploy.sh bnb-smart-chain dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**bnb-smart-chain-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: bnb-smart-chain deploy-broadcast -->
```
scripts/multichain/deploy.sh bnb-smart-chain broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**bnb-smart-chain-5. Post gate**, after waiting seconds (run it after one minute) for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: bnb-smart-chain post-gate-deployed -->
```
node scripts/multichain/gate.mjs bnb-smart-chain post --out deployments/bnb-smart-chain/gate-report.json
```

**bnb-smart-chain-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on BNB Smart Chain with the native amount you will deposit **plus 0.003 BNB** for its two transactions, and with the USDC (Binance-Peg) amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.5` by your amount (at least 0.5). Transfers **to** the depositing account are safe; it must **send** nothing but step bnb-smart-chain-7.

<!-- run: bnb-smart-chain market -->
```
node scripts/multichain/market.mjs bnb-smart-chain --native 0.5
```

Check both balances arrived:

<!-- run: bnb-smart-chain depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://bsc-rpc.publicnode.com
```
<!-- run: bnb-smart-chain depositor-token -->
```
cast call 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://bsc-rpc.publicnode.com
```

(The second number is in base units: 18 decimals.)

**bnb-smart-chain-7. Open the pool.** Use your amount in place of `0.5`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: bnb-smart-chain prepare -->
```
node scripts/multichain/first-deposit.mjs bnb-smart-chain prepare --pair WBNB/USDC --native 0.5 --gate-report deployments/bnb-smart-chain/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 56):

<!-- run: bnb-smart-chain send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://bsc-rpc.publicnode.com
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**bnb-smart-chain-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: bnb-smart-chain verify -->
```
node scripts/multichain/first-deposit.mjs bnb-smart-chain verify --pair WBNB/USDC --native 0.5 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**bnb-smart-chain-9. Post gate with the opening**, after the same wait as bnb-smart-chain-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: bnb-smart-chain post-gate-open -->
```
node scripts/multichain/gate.mjs bnb-smart-chain post --opening WBNB/USDC=DEPOSIT_HASH --out deployments/bnb-smart-chain/gate-report.json
```

**bnb-smart-chain-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: bnb-smart-chain frontend-record -->
```
node scripts/multichain/frontend-files.mjs bnb-smart-chain --gate-report deployments/bnb-smart-chain/gate-report.json
```

**bnb-smart-chain-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: bnb-smart-chain record-add -->
```
git add deployments/bnb-smart-chain
```
<!-- run: bnb-smart-chain record-commit -->
```
git commit -m "BNB Smart Chain: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

### 4.6 Ethereum (`ethereum`, chain id 1)

Endpoint used for sending in this section: `https://ethereum-rpc.publicnode.com` (the first reviewed endpoint of `deployments/ethereum/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals. Minimum first deposit: 1 ETH and its USDC.

**ethereum-1. Pre gate (read-only).** Must end with `multichain gate ethereum pre: PASS`.

<!-- run: ethereum pre-gate -->
```
node scripts/multichain/gate.mjs ethereum pre
```

**ethereum-2. Fund the deploying account** with **0.03 ETH** on Ethereum (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: ethereum deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://ethereum-rpc.publicnode.com
```

And the gas price now, in gwei; if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: ethereum gas-price -->
```
cast gas-price --rpc-url https://ethereum-rpc.publicnode.com
```

**ethereum-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error.

<!-- run: ethereum deploy-dry-run -->
```
scripts/multichain/deploy.sh ethereum dry-run -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**ethereum-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. It must end with `== sent.` and print the next command. No pair is created.

<!-- run: ethereum deploy-broadcast -->
```
scripts/multichain/deploy.sh ethereum broadcast -- --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer
```

**ethereum-5. Post gate**, after waiting about 15 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: ethereum post-gate-deployed -->
```
node scripts/multichain/gate.mjs ethereum post --out deployments/ethereum/gate-report.json
```

**ethereum-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on Ethereum with the native amount you will deposit **plus 0.015 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `1` by your amount (at least 1). Transfers **to** the depositing account are safe; it must **send** nothing but step ethereum-7.

<!-- run: ethereum market -->
```
node scripts/multichain/market.mjs ethereum --native 1
```

Check both balances arrived:

<!-- run: ethereum depositor-native -->
```
cast balance 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --ether --rpc-url https://ethereum-rpc.publicnode.com
```
<!-- run: ethereum depositor-token -->
```
cast call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 "balanceOf(address)(uint256)" 0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3 --rpc-url https://ethereum-rpc.publicnode.com
```

(The second number is in base units: 6 decimals.)

**ethereum-7. Open the pool.** Use your amount in place of `1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 6. If it prints "no market price", wait a few minutes and run it again.

<!-- run: ethereum prepare -->
```
node scripts/multichain/first-deposit.mjs ethereum prepare --pair WETH/USDC --native 1 --gate-report deployments/ethereum/gate-report.json
```

Send the two printed lines **in order, within a few minutes**, each one exactly as printed with this added at its end (cast asks for the depositing key's password; check that the `--from` it printed is `0x1ec3…C8f3` and the `--chain` is 1):

<!-- run: ethereum send-suffix -->
```
--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante --rpc-url https://ethereum-rpc.publicnode.com
```

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (its `verify` line has it filled in: copy that line).

**ethereum-8. Prove the opening** from the deposit transaction. It must say `PASS`.

<!-- run: ethereum verify -->
```
node scripts/multichain/first-deposit.mjs ethereum verify --pair WETH/USDC --native 1 --token TOKEN_AMOUNT --tx DEPOSIT_HASH
```

**ethereum-9. Post gate with the opening**, after the same wait as ethereum-5. It must end with `post: PASS` and report the pair `open`, opened by `0x1ec3…C8f3`.

<!-- run: ethereum post-gate-open -->
```
node scripts/multichain/gate.mjs ethereum post --opening WETH/USDC=DEPOSIT_HASH --out deployments/ethereum/gate-report.json
```

**ethereum-10. The page's record of this chain**, written from that report (the tool refuses a report without every opening proven):

<!-- run: ethereum frontend-record -->
```
node scripts/multichain/frontend-files.mjs ethereum --gate-report deployments/ethereum/gate-report.json
```

**ethereum-11. Record.** Commit the chain's files (the gate report and the two page files are public facts; no key is in them):

<!-- run: ethereum record-add -->
```
git add deployments/ethereum
```
<!-- run: ethereum record-commit -->
```
git commit -m "Ethereum: deployed and pool opened (owner run)"
```

Then fill the chain's row of the progress table (section 5) and go on to the next chain.

## 5. Progress table (fill as you go)

| Chain | 1 pre | 4 deployed (3 tx hashes) | 5 post | 7 deposit hash | 8 verify | 9 post open | 10 record | 11 committed |
|---|---|---|---|---|---|---|---|---|
| OP Mainnet | | | | | | | | |
| Base | | | | | | | | |
| Arbitrum One | | | | | | | | |
| Linea | | | | | | | | |
| BNB Smart Chain | | | | | | | | |
| Ethereum | | | | | | | | |

## 6. If a step fails midway

The principle: **every step before 7 can be repeated safely; nothing of yours is at risk before step 7; from step 7
on, only the printed transactions go in, and the tools refuse rather than guess.** A failure on one chain does not
touch the chains already finished, and you may stop between chains for as long as you like (each chain's
deployment is independent; the depositing account's rule holds for as long as it is kept).

| Where | What you see | What it means | What to do |
|---|---|---|---|
| 2.2 | `check-depositor` is not FIT | the depositing account has code, a delegation or a transaction on some chain | Stop before any deployment. If it sent a transaction, treat the key as used: a new depositing key means a new factory address (`docs/MULTICHAIN-DEPLOY.md` sections 2.1, 10); ask the developer (agent 360's line) to record a new one |
| 2.3 | `record` refuses the signature | wrong account signed, the text changed, or a smart-account signature | Sign again with the fee address itself, as a plain message; nothing is recorded until it is valid |
| 1 or 3 | pre gate `FAIL` | the chain differs from what was reviewed (a token's code changed, the depositing account was used, the fee address delegates to an unidentified contract, the proof is missing) | Do not deploy on that chain. Read the failing line; a delegation change at the fee address on any chain stops that chain until it is cleared or identified (`docs/MULTICHAIN-DEPLOY.md` 2.3) |
| 3 | "lack of funds" / insufficient funds | the deploying account holds less than the gas | Fund more (step 2) and repeat step 3 |
| 4 | interrupted, a transaction failed, the terminal closed | some of the three contracts may be deployed | **Run step 4 again, unchanged.** A contract whose planned address already has code is skipped (shown in the dry run: the second run sends nothing). Then step 5 checks all three |
| 4 | someone else deployed the same contracts first | harmless: the addresses depend only on the code and its fixed arguments, so theirs are identical to yours | Step 4 skips them; step 5 checks the code |
| 5 | `WAIT …` | deployed, not finalized yet | Wait and run step 5 again (Linea: hours) |
| 5 | any `FAIL` | the deployed code is not the planned code at the finalized block | Stop that chain; put no money in; report the output |
| 6 | `market.mjs` prints no market price | the two references disagree or a feed is stale | Wait; it never falls back to one reference |
| 7 | `prepare` FAIL, "no market price", "below the minimum" | nothing was printed, nothing is to be sent | Wait, or use a larger amount, and run step 7 again |
| 7 | `prepare` says tokens sit at the pair's address and prints a `skim` command | someone sent tokens to the not-yet-created pair (above 0.1% of a side) | Send the printed `skim` from **the deploying account, never the depositing account** (`--keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer`), naming an address of yours; then step 7 again |
| 7 | **`STOP`: the pool is already open** | you did not open it: the depositing key was used elsewhere or stolen | Deposit nothing on that chain; do not use `add`. That pair of that factory is lost (no money is). `docs/MULTICHAIN-DEPLOY.md` section 10: a new depositing key, a new factory on that chain |
| 7 | the `approve` went through, the deposit was not sent (closed terminal, waited too long) | an allowance of exactly the token amount to the router stands; no money moved | **Run `prepare` again** (shown in the dry run: it prints a fresh pair of lines) and send both new lines; the new `approve` replaces the old allowance |
| 7 | the deposit reverted (`status 0`), for example sent after its 20-minute deadline | nothing was deposited; only its gas was spent | **Run `prepare` again** and send the new lines (shown in the dry run). Never write a deposit by hand or with other minimums |
| 8 | `verify` reports a gift above 0.1% | someone sent tokens to the pair's address in front of your deposit; they are now in the pool and owned by your shares | Nothing is lost: **do not withdraw**. Continue with step 9; compare the pool's price with the market before the page is published |
| 8 or 9 | `verify` or the gate cannot prove the opening | the opening was not your printed deposit | As for `STOP` |
| 10 | `frontend-files` refuses | the report is not a passed post gate with the opening proven | Repeat step 9 until it passes |
| any | the machine or session is lost | | Start again at the first step of that chain whose output you do not have; every step up to 6 can be repeated, step 7 by `prepare` again, steps 8 to 11 any time |

## 7. After the last chain

**The page.** The integrator (agent 366) merges the committed records into `main`; the multichain site is built
from `main` with:

```
npm --prefix frontend run build:multichain
```

and published as a preview (agent 368's Cloudflare Pages project `postern-dex-multichain-preview`). A chain whose
record is not committed shows "Not yet live" and makes no request. A custom domain is your decision. Before
announcing anything: open the published page yourself on the first chain and make one small swap with your own
wallet (no real wallet and no real transaction were used in any rehearsal).

**Retire the deploying key.** It has no power over the contracts. Move what is left on each chain to an account of
yours (from a wallet that imports nothing: `cast send` with the keystore; `RECIPIENT` is yours, `AMOUNT` is the
balance less a little for gas):

```
cast send RECIPIENT --value AMOUNT --keystore ~/Desktop/DEX-CHAVE-DEPLOY/deployer --rpc-url RPC_URL
```

Then delete `~/Desktop/DEX-CHAVE-DEPLOY`. Leftover dust lost with it is harmless.

**The depositing key** stays as `docs/MULTICHAIN-DEPLOY.md` section 2.1 says: keep it (and its rule: it sends
nothing but printed deposits) if you will open further pairs on these factories; otherwise empty it and delete it.

**Bloch L2 DEX (separate product).** Not part of this procedure: its fee goes to the Bloch Inc Safe through
`blochInc`; that is the integrator's owner checklist item (agent 366).

## 8. The dry run of this document

RESULTS-DRYRUN

## 9. What the dry run changes, exactly

The dry run (`scripts/multichain/owner-dry-run.mjs`) reads the command blocks of this file (the ones marked
`<!-- run: … -->`), refuses to start if a block it expects is missing, and runs each as written with only these
changes, each of which points a command at the loopback fork or at a throwaway key instead of a real one. Every
command it actually ran is in its evidence (`commands.log`), next to the block it came from.

| Command | Change for the fork | Why |
|---|---|---|
| `gate.mjs`, `market.mjs`, `first-deposit.mjs`, `frontend-files.mjs` | `--rpc http://127.0.0.1:PORT --rehearsal` added | the tools' only way to read a fork; `--rehearsal` refuses any non-loopback URL |
| `deploy.sh` | `--rehearsal-rpc http://127.0.0.1:PORT` added before `--` | as above |
| `--out deployments/<chain>/…`, `--gate-report deployments/<chain>/…`, `fee-proof.mjs page --out /tmp/…` | the path is the dry run's own directory; `frontend-files.mjs` gets `--out DIR` | nothing of a dry run is written into `deployments/` |
| `~/Desktop/DEX-CHAVE-DEPLOY` | a throwaway directory; `cast wallet new` gets `--unsafe-password`, `forge` and `cast` get `--password-file` | a throwaway key with a throwaway password, never the owner's |
| `--rpc-url https://…` (public endpoint) in `cast` | the fork's URL | nothing is sent to a public chain |
| the printed `cast send` lines and their suffix | the suffix `--keystore ~/Desktop/DEX-CHAVE-DEPOSITANTE/depositante` becomes `--unlocked`; the depositing account is impersonated on the fork | nobody but the owner has that key |
| `DEPLOYER_ADDRESS`, `DEPOSIT_HASH`, `TOKEN_AMOUNT` | the values the earlier steps printed | as the owner does |
| funding (steps 2 and 6) and waiting (steps 5 and 9) | `anvil_setBalance` with exactly the amounts of section 3, the token by its balance slot; 70 blocks mined so that anvil's `finalized` (64 behind) covers the transactions | the owner funds from a wallet and waits for the chain |
| `fee-proof.mjs record` | not run (it needs the fee address's signature); the pre gates of the dry run report the proof as "not required (rehearsal)", and the public pre gate is run read-only to show that it fails on the missing proof only | no one but the owner can sign it |
| `git add`, `git commit`, `npm ci`, `git checkout` | not run | they change the repository, not a chain |

## 10. Not done / not proven

NOT-DONE
