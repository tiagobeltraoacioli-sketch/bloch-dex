# PosternDEX on six public chains: the owner's deployment, step by step

Status: **ready for the owner to run; dry-run on a fork of each of the six chains: PASS on all six (section 9); nothing deployed.** Written
2026-11-17 by agent 367 (round 18; the tools section by agent 401, round 19) from the tools of `docs/MULTICHAIN-DEPLOY.md` (agent 360's line). The reasons
behind every rule are in that document; this one is only the sequence, with every command exactly as you type it.
A Portuguese copy for the owner is kept outside this public repository (the repository is English only), with the same command blocks; this English file is the one the dry run executes.

What happens: on each of OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain and Ethereum, three contracts
(factory, router, lens: the Bloch L2 release candidate, byte for byte; its audit covered the contracts, not these six configurations, `docs/MULTICHAIN-DEPLOY.md` 12.4) are deployed at the planned
addresses, then the first pool (the chain's wrapped native coin against its USDC) is opened by your depositing
account with your money at the chain's market price, proven, and recorded for the page. The protocol fee goes to
`0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` on every chain, for ever (it cannot be changed after step 4 of a chain).

## Before anything: the repository and the tools

Once, on this Mac: get the repository (the folder `~/postern-dex` does not exist yet).

<!-- run: once clone -->
```
git clone https://github.com/tiagobeltraoacioli-sketch/postern-dex.git ~/postern-dex
```

The scripts you are about to run, and the SHA-256 values they compare your tools with, come from this copy.
Before you run anything from it, compare its commit, **all 40 characters**, with the reviewed commit id (a short
form of seven characters can be imitated in minutes, review R402-4).

**The reviewed commit id is not written in this page, on purpose.** A commit cannot contain its own id, and a
copy of the repository that someone altered could print any id it likes. You received the 40-digit id outside
the repository: in the coordinator's message and in your own Portuguese copy of this guide, which is not in the
repository. In the line below, replace `PASTE-THE-40-DIGIT-COMMIT-ID` with those 40 digits, then run it. The
line uses only macOS's own programs and nothing from the clone:

<!-- run: once clone-commit -->
```
[ "$(/usr/bin/git -C ~/postern-dex rev-parse HEAD)" = "PASTE-THE-40-DIGIT-COMMIT-ID" ] && echo "reviewed commit: MATCH" || echo "reviewed commit: MISMATCH; stop and run nothing from this copy"
```

It must print exactly `reviewed commit: MATCH`. **On `MISMATCH`, stop**: run nothing from `~/postern-dex`, and
ask the coordinator. The line printed as it stands here (the placeholder not replaced) prints `MISMATCH` too: it
cannot be skipped by pasting it unchanged.

### Your own tools, checked before any key is used

`forge` and `cast` sign your transactions, `node` runs every check of this guide and `anvil` rehearses: whoever can
change those programs decides what you sign and what the checks print (review R369-16). So you do not use a copy
somebody else put on this Mac (in particular not the one in `~/.local/share/dex-tools/`, which an agent installed
and agents can write). You install your own, from the publishers, into a new directory, and a script of this
repository compares every program with SHA-256 values committed here before each session.

**No agent while you sign.** Before a signing session (any terminal in which you will type a keystore password or
confirm in a wallet), close every assistant or agent session on this Mac (Claude Code, Codex, their terminals and
desktop apps) and leave them closed until you have finished. An agent runs as your macOS user: a directory closed
to other users is not closed to it. This line lists what is still running; it must print nothing:

<!-- run: once no-agents -->
```
pgrep -lf -i "claude|codex"
```

**Once: install.** The directory `~/dex-owner-tools` must not exist yet. The script downloads Foundry v1.7.1 from
its GitHub release, Node.js v24.21.0 from nodejs.org, the Solidity compiler 0.8.24 from the Solidity project's own
site and, on an Intel Mac such as this one (`uname -m` prints `x86_64`), the `libusb` library that Foundry's Intel
build loads, from Homebrew's package store; it compares each
download's SHA-256 with the committed value (`scripts/multichain/owner-toolchain.pins`, which says where every value
comes from) before unpacking it, builds the directory with access for you only, and ends with the check below. It
uses only programs of macOS itself and asks for no password. About 230 MB, about a minute.

<!-- run: once tools-install -->
```
/bin/bash ~/postern-dex/scripts/multichain/owner-toolchain.sh install ~/dex-owner-tools
```

It must end with `owner tools: installed and verified`. If it ends with `FAIL`, nothing was installed: stop.

In **every new terminal** you use for this guide, first these three lines. Use the terminal for this guide only.
The first makes the terminal find programs in two places and nowhere else: your tools, and macOS's own four
directories. What your terminal usually has in its path (for example `~/.local/bin`, where agents install
programs) is deliberately left out: any directory in the path can supply `bash`, `git` or `mkdir` to the commands
below (review R402-1).

<!-- run: once env-path -->
```
export PATH="$HOME/dex-owner-tools/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

The second is the check. It refuses unless: the directory and everything in it is yours alone (no access for group
or others, no access-control list); `forge`, `cast`, `anvil`, `node`, the compiler and `libusb` have the committed
SHA-256, and the directory as a whole (every file, including `npm`) the committed digest; this terminal's path is
exactly the line above, it finds the five programs in your directory and every helper the guide uses (`bash`,
`git`, `mkdir`, `pgrep`, `python3` and the like) in macOS's own directories; no variable is set that would redirect
a program (`NODE_…`, `FOUNDRY_…`, `ETH_…`, a proxy, certificate or git override: the script lists them with the
reason for each; the guide needs none); each program, started as `deploy.sh` will start it, reports Foundry 1.7.1,
Node.js v24.21.0 or Solidity 0.8.24; and `forge` itself reports that it will compile with the compiler in your
directory, with fetching another one switched off. Nothing of the directory is run before the hashes pass. It
takes about ten seconds.

<!-- run: once tools-check -->
```
/bin/bash ~/postern-dex/scripts/multichain/owner-toolchain.sh check ~/dex-owner-tools
```

The last line must be exactly `owner tools: PASS`. **On any `FAIL`, type no password and confirm nothing in a
wallet**: remove the directory (`~/dex-owner-tools` holds nothing but the tools), install again, and if it fails
again, stop and ask.

The third shows what this terminal will really start when you type the five names:

<!-- run: once tools-type -->
```
type forge cast anvil node npm
```

Each of the five lines must end with your home directory followed by `/dex-owner-tools/bin/` and the program's
name (for example `forge is /Users/you/dex-owner-tools/bin/forge`). A line saying `alias` or `function`, or
another path: stop.

`deploy.sh` (steps 3 and 4) and `first-deposit.mjs prepare` (step 7) run the same check again by themselves and
stop unless it passes (review R402-5), so a terminal in which you forgot it cannot sign. Run it yourself all the
same: `cast` is started by you, not by a script.

Why launchers (`~/dex-owner-tools/bin`): Foundry's build for Intel Macs looks for `libusb` at a Homebrew path, and
macOS removes the variable that could point it elsewhere whenever a script runs (`deploy.sh` is one), so each
launcher sets it right before starting the real program (found by the dry run). Each launcher also removes the
variables the check refuses before it starts its program, and the launcher of `forge` names the compiler: the
checked file in your directory, never the copy `forge` would otherwise take from, or download into, your Library
folder (review R402-2).

Then the two keystore variables of the rules below, and section 2.

Rules for the whole procedure:

- Every command is one block; paste one block at a time; nothing in a block is a comment. Words in capitals
  (`DEPLOYER_ADDRESS`, `DEPOSIT_HASH`, `TOKEN_AMOUNT`) are yours to replace.
- **Nothing in this procedure ever asks for a private key on the command line.** Keys live in encrypted keystore
  files; `cast` and `forge` ask for the password.
- Two phases, each one chain at a time in the same order (cheapest first: a mistake is found where it costs least):
  section 4 deploys on all six chains (steps 1 to 5), then section 5 opens the pools (steps 6 to 11). No pool is
  opened before every chain is deployed (the reason is at the top of section 5).
- **Any line starting `FAIL`, any `STOP`, any error: stop that chain and read section 7.** A `WAIT` line is not a
  failure (the chain has not finalized yet: run the same command again later).
- Run everything from the repository's top directory.
- **Two variables name your private keystore directories** (this public repository never names the real ones). In
  every new terminal, before anything else, set both, replacing `<owner-keystore-dir>` and
  `<owner-deployer-keystore-dir>` by your directories (the depositing key's directory is the one it was created in
  on 2026-11-17; the deploying key's is the one you choose in section 2.4):

```
export DEX_DEPOSITOR_KEYSTORE_DIR=<owner-keystore-dir>
```

```
export DEX_DEPLOYER_KEYSTORE_DIR=<owner-deployer-keystore-dir>
```

## 1. What you need

| What | Detail |
|---|---|
| This repository | postern-dex at the commit the integrator (agent 366) names as reviewed, on `main`; `git status` clean |
| Foundry | `forge`, `cast`, `anvil` 1.7.1 and the Solidity compiler 0.8.24: your own copy in `~/dex-owner-tools`, installed from the publishers and checked in every terminal ("Your own tools" above) |
| Node.js | v24.21.0, in the same directory and under the same check; the frontend's packages installed once (section 2.1) |
| The fee address's wallet | the wallet that holds `0x775a…0544` (a MetaMask account, or a Ledger): used once, to sign one message, no transaction (section 2.3) |
| The depositing key | the encrypted keystore `"$DEX_DEPOSITOR_KEYSTORE_DIR/depositante"` (address `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3`, created 2026-11-17). It signs only the two transactions step 7 prints on each chain |
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

<!-- run: once reviewed-commit -->
```
/bin/bash scripts/multichain/reviewed-commit.sh PASTE-THE-40-DIGIT-COMMIT-ID
```

Replace `PASTE-THE-40-DIGIT-COMMIT-ID` with the same 40-digit id as at the start (received outside the
repository; this page does not state it). The last line must be exactly `reviewed commit: PASS` followed by
that id. The script refuses, with a last line starting `reviewed commit: FAIL`, when the copy is at any other
commit, when a file of the copy differs from that commit, and when the placeholder was left as printed or fewer
than 40 digits were given. **On `FAIL`, stop here**: take a fresh clone and ask the coordinator; do not go on
with this copy. (Later, after you commit the files a chain's deployment generates, this copy is at your own new
commit and this line no longer applies; it is for this point, before anything is built or signed.) Then
install the frontend's packages (used by the tools as a library; no install script runs) and build the contracts
(the tests and the plan below read the built code; this is the first run of the compiler in your directory):

<!-- run: once npm-ci -->
```
npm --prefix frontend ci --ignore-scripts
```

<!-- run: once forge-build -->
```
forge build
```

It must say `Compiler run successful` (warnings of the linter are not errors).

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
and section 7 (its first row) applies before anything is deployed.

### 2.3 The fee address: sign the proof of control (no transaction, no cost)

Every pre gate refuses until this is recorded. Print the message:

<!-- run: once fee-proof-message -->
```
node scripts/multichain/fee-proof.mjs message
```

It prints exactly this one line (compare it word for word with what your wallet shows before you confirm):

> PosternDEX fee address proof (postern.dex.multichain.fee-address-proof.v1). I control the address 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 and name it as the protocol fee recipient (feeTo) of the PosternDEX factory on the chains with ids 10, 8453, 42161, 59144, 56, 1. This message is not a transaction and authorizes no transfer and no approval.

Sign it **as a message** with the fee address. With a Ledger (this signs with the Ledger's first account; if the fee address is another account of the Ledger, add
`--mnemonic-index N` to the command, and `cast wallet address --ledger --mnemonic-index N` shows which address index
`N` is; `record` refuses a signature by any other address, review R369-12):

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
mkdir -p "$DEX_DEPLOYER_KEYSTORE_DIR"
```

<!-- run: once deployer-new -->
```
cast wallet new "$DEX_DEPLOYER_KEYSTORE_DIR" deployer
```

To print the address again later:

<!-- run: once deployer-address -->
```
cast wallet address --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
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

Read on 2026-11-17 between 05:48 and 19:41 UTC from each chain's reviewed public endpoint (`eth_gasPrice`; Linea: `linea_estimateGas`; rollup data fees from the rollups' own oracles: OP Stack `GasPriceOracle.getL1Fee`, Arbitrum `NodeInterface.gasEstimateL1Component`), applied to the gas the dry run's own receipts used (the same bytes you send). "Today" is that hour; plan with the funding column, which covers prices well above it. USD at the market price the dry run's `prepare` read (Chainlink and a pool, on the fork).

| Chain | Fund the deploying account (step 2) | It covers forge's upfront bound up to | Today: gas price | Today: deployment (3 tx) | Today: approve + first deposit | Today: total | Depositing account: deposit + this for gas (step 6) | Minimum first deposit |
|---|---|---|---|---|---|---|---|---|
| OP Mainnet | 0.001 ETH | 0.078 gwei (12,889,611 gas) | 0.00104 gwei | 0.00000973 ETH | 0.00000269 ETH | **0.00001243 ETH** (about US$ 0.022) | 0.0005 ETH | 0.1 ETH |
| Base | 0.001 ETH | 0.078 gwei (12,889,611 gas) | 0.00600 gwei | 0.000054 ETH | 0.0000155 ETH | **0.00006949 ETH** (about US$ 0.13) | 0.0005 ETH | 0.1 ETH |
| Arbitrum One | 0.002 ETH | 0.16 gwei (12,726,905 gas) | 0.0200 gwei | 0.00018059 ETH | 0.00005199 ETH | **0.00023259 ETH** (about US$ 0.43) | 0.001 ETH | 0.1 ETH |
| Linea | 0.01 ETH | 0.78 gwei (12,889,927 gas) | 0.0396 gwei | 0.00035495 ETH | 0.00010262 ETH | **0.00045756 ETH** (about US$ 0.84) | 0.003 ETH | 0.1 ETH |
| BNB Smart Chain | 0.005 BNB | 0.39 gwei (12,889,927 gas) | 0.0500 gwei | 0.00044809 BNB | 0.00012916 BNB | **0.00057724 BNB** (about US$ 0.34) | 0.003 BNB | 0.5 BNB |
| Ethereum | 0.03 ETH | 2.3 gwei (12,889,927 gas) | 0.133 gwei | 0.00119128 ETH | 0.00034355 ETH | **0.00153482 ETH** (about US$ 2.82) | 0.015 ETH | 1 ETH |

**Total today for the six chains' transactions: about US$ 4.58** (gas only; the deposits themselves are your liquidity, not a cost). The deploying account needs the sum of its column across the six chains (0.001 ETH + 0.001 ETH + 0.002 ETH + 0.01 ETH + 0.005 BNB + 0.03 ETH); what is not spent stays in it (section 8). The ceiling column is the funding divided by forge's own upfront gas bound (`Estimated total gas used for script`, about 1.4 times the gas spent): above that price step 3 shows an `Estimated amount required` larger than the funding, and you fund the difference. Linea's price moved from 0.04 to 0.32 gwei (`eth_gasPrice`) within this day; its funding is set for that. Today BNB Smart Chain (US$ 0.34) compares with Arbitrum One (US$ 0.43) and Linea (US$ 0.84); the order of section 4 is kept whatever the hour's ranking (the differences are cents; the ETH rollups come first).


## 4. Deploying, chain by chain

Order: OP Mainnet, Base, Arbitrum One, Linea, BNB Smart Chain, Ethereum (cheapest first; section 3 shows today's
costs). Each chain has steps 1 to 5 here and steps 6 to 11 in section 5.

### 4.1 OP Mainnet (`op-mainnet`, chain id 10): deploy

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

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: op-mainnet gas-price -->
```
cast gas-price --rpc-url https://mainnet.optimism.io
```

**op-mainnet-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … ETH`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: op-mainnet deploy-dry-run -->
```
scripts/multichain/deploy.sh op-mainnet dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**op-mainnet-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`op-mainnet`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: op-mainnet deploy-broadcast -->
```
scripts/multichain/deploy.sh op-mainnet broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**op-mainnet-5. Post gate**, after waiting 16 to 23 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: op-mainnet post-gate-deployed -->
```
node scripts/multichain/gate.mjs op-mainnet post --out deployments/op-mainnet/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

### 4.2 Base (`base`, chain id 8453): deploy

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

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: base gas-price -->
```
cast gas-price --rpc-url https://mainnet.base.org
```

**base-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … ETH`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: base deploy-dry-run -->
```
scripts/multichain/deploy.sh base dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**base-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`base`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: base deploy-broadcast -->
```
scripts/multichain/deploy.sh base broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**base-5. Post gate**, after waiting 16 to 23 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: base post-gate-deployed -->
```
node scripts/multichain/gate.mjs base post --out deployments/base/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

### 4.3 Arbitrum One (`arbitrum-one`, chain id 42161): deploy

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

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: arbitrum-one gas-price -->
```
cast gas-price --rpc-url https://arb1.arbitrum.io/rpc
```

**arbitrum-one-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … ETH`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: arbitrum-one deploy-dry-run -->
```
scripts/multichain/deploy.sh arbitrum-one dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**arbitrum-one-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`arbitrum-one`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: arbitrum-one deploy-broadcast -->
```
scripts/multichain/deploy.sh arbitrum-one broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**arbitrum-one-5. Post gate**, after waiting about 20 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: arbitrum-one post-gate-deployed -->
```
node scripts/multichain/gate.mjs arbitrum-one post --out deployments/arbitrum-one/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

### 4.4 Linea (`linea`, chain id 59144): deploy

Endpoint used for sending in this section: `https://rpc.linea.build` (the first reviewed endpoint of `deployments/linea/chain.json`; the tools themselves always read the reviewed endpoints). Listed token: USDC `0x176211869cA2b568f2A7D4EE941E073a821EE1ff`, 6 decimals. Minimum first deposit: 0.1 ETH and its USDC.

**linea-1. Pre gate (read-only).** Must end with `multichain gate linea pre: PASS`.

<!-- run: linea pre-gate -->
```
node scripts/multichain/gate.mjs linea pre
```

**linea-2. Fund the deploying account** with **0.01 ETH** on Linea (from any wallet of yours; a plain transfer to `DEPLOYER_ADDRESS`, the address of section 2.4). Then check it arrived:

<!-- run: linea deployer-balance -->
```
cast balance DEPLOYER_ADDRESS --ether --rpc-url https://rpc.linea.build
```

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: linea gas-price -->
```
cast gas-price --rpc-url https://rpc.linea.build
```

**linea-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … ETH`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: linea deploy-dry-run -->
```
scripts/multichain/deploy.sh linea dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**linea-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`linea`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: linea deploy-broadcast -->
```
scripts/multichain/deploy.sh linea broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**linea-5. Post gate**, after waiting 1 h 40 min to more than 5 hours for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: linea post-gate-deployed -->
```
node scripts/multichain/gate.mjs linea post --out deployments/linea/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

### 4.5 BNB Smart Chain (`bnb-smart-chain`, chain id 56): deploy

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

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: bnb-smart-chain gas-price -->
```
cast gas-price --rpc-url https://bsc-rpc.publicnode.com
```

**bnb-smart-chain-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … BNB`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: bnb-smart-chain deploy-dry-run -->
```
scripts/multichain/deploy.sh bnb-smart-chain dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**bnb-smart-chain-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`bnb-smart-chain`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: bnb-smart-chain deploy-broadcast -->
```
scripts/multichain/deploy.sh bnb-smart-chain broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**bnb-smart-chain-5. Post gate**, after waiting seconds (run it after one minute) for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: bnb-smart-chain post-gate-deployed -->
```
node scripts/multichain/gate.mjs bnb-smart-chain post --out deployments/bnb-smart-chain/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

### 4.6 Ethereum (`ethereum`, chain id 1): deploy

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

And the gas price now, in wei (divide by 10^9 for gwei); if it is above the ceiling in the table of section 3, wait or fund more:

<!-- run: ethereum gas-price -->
```
cast gas-price --rpc-url https://ethereum-rpc.publicnode.com
```

**ethereum-3. Deployment dry run.** Builds, plans, runs the pre gate again and simulates the three deployments from the deploying account. Nothing is sent. `cast` asks for the deploying key's password. It must end with `== dry run only: nothing was sent` and no error. It prints `Estimated amount required: … ETH`: forge's own upper bound at the chain's price now (its gas limits carry a margin, so it is about 1.4 times what is spent). If the deploying account holds less than that, fund the difference and repeat this step.

<!-- run: ethereum deploy-dry-run -->
```
scripts/multichain/deploy.sh ethereum dry-run -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**ethereum-4. Deploy.** Three transactions (factory, router, lens), signed by the deploying key; the password is asked once. Before signing it prints the three transactions (to the CREATE2 deployer, value 0, the chain id, the planned factory, router and lens with `feeTo` and `firstDepositor`) and asks you to type the chain's key (`ethereum`): compare the addresses with section 2.5, then type it (anything else stops; nothing is sent). It must end with `== sent.` and print the next command. No pair is created.

<!-- run: ethereum deploy-broadcast -->
```
scripts/multichain/deploy.sh ethereum broadcast -- --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer"
```

**ethereum-5. Post gate**, after waiting about 15 minutes for the chain to finalize the deployment. A line starting `WAIT` means "not finalized yet": run it again later. It must end with `post: PASS` and report the pair as `absent`.

<!-- run: ethereum post-gate-deployed -->
```
node scripts/multichain/gate.mjs ethereum post --out deployments/ethereum/gate-report.json
```

Fill the chain's deployment columns of the progress table (section 6), then deploy the next chain. **Open no pool before all six chains have passed step 5** (section 5).

## 5. Opening the pools, chain by chain

Only after section 4 is finished on all six chains (every step 5 PASS, the pair `absent`). Same order. Why: the pre gate refuses a chain whose factory is not deployed yet once the depositing account has sent anything there, and the depositing account is the same on all six chains and in every factory's address; deploying all six first means that nothing the depositing account does later can block a deployment (review R369-4).

### 5.1 OP Mainnet (`op-mainnet`, chain id 10): open the pool


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

**op-mainnet-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: op-mainnet prepare -->
```
node scripts/multichain/first-deposit.mjs op-mainnet prepare --pair WETH/USDC --native 0.1 --gate-report deployments/op-mainnet/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 10:

<!-- suffix: op-mainnet send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://mainnet.optimism.io`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

### 5.2 Base (`base`, chain id 8453): open the pool


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

**base-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: base prepare -->
```
node scripts/multichain/first-deposit.mjs base prepare --pair WETH/USDC --native 0.1 --gate-report deployments/base/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 8453:

<!-- suffix: base send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://mainnet.base.org`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

### 5.3 Arbitrum One (`arbitrum-one`, chain id 42161): open the pool


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

**arbitrum-one-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: arbitrum-one prepare -->
```
node scripts/multichain/first-deposit.mjs arbitrum-one prepare --pair WETH/USDC --native 0.1 --gate-report deployments/arbitrum-one/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 42161:

<!-- suffix: arbitrum-one send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://arb1.arbitrum.io/rpc`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

### 5.4 Linea (`linea`, chain id 59144): open the pool


**linea-6. Fund the depositing account** `0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3` on Linea with the native amount you will deposit **plus 0.003 ETH** for its two transactions, and with the USDC amount this command prints for that native amount, **plus 1%** (the price moves). Replace `0.1` by your amount (at least 0.1). Transfers **to** the depositing account are safe; it must **send** nothing but step linea-7.

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

**linea-7. Open the pool.** Use your amount in place of `0.1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: linea prepare -->
```
node scripts/multichain/first-deposit.mjs linea prepare --pair WETH/USDC --native 0.1 --gate-report deployments/linea/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 59144:

<!-- suffix: linea send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://rpc.linea.build`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

### 5.5 BNB Smart Chain (`bnb-smart-chain`, chain id 56): open the pool


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

**bnb-smart-chain-7. Open the pool.** Use your amount in place of `0.5`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: bnb-smart-chain prepare -->
```
node scripts/multichain/first-deposit.mjs bnb-smart-chain prepare --pair WBNB/USDC --native 0.5 --gate-report deployments/bnb-smart-chain/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 56:

<!-- suffix: bnb-smart-chain send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://bsc-rpc.publicnode.com`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

### 5.6 Ethereum (`ethereum`, chain id 1): open the pool


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

**ethereum-7. Open the pool.** Use your amount in place of `1`. The tool reads the market at one block on two endpoints, checks the contracts against the gate report, and prints two `cast send` lines (an `approve` of exactly the token amount to the router, then `addLiquidityBLCH` with minimums equal to the amounts). If it prints `STOP`, deposit nothing and go to section 7. If it prints "no market price", wait a few minutes and run it again.

<!-- run: ethereum prepare -->
```
node scripts/multichain/first-deposit.mjs ethereum prepare --pair WETH/USDC --native 1 --gate-report deployments/ethereum/gate-report.json
```

**Send them only with `cast`, from this terminal, exactly as printed. Never import the depositing key into a browser wallet; never accept "switch to smart account", a batched transaction, or any wallet that bundles the two: the opening must be a transaction from the depositing account straight to the router, or it can never be proven and that pair of that factory is lost (review R369-3).** Each command is one printed line followed by this text (it is not a command by itself: add it at the end of the line, after a space; cast then asks for the depositing key's password). Check that the `--from` printed is `0x1ec3…C8f3` and the `--chain` is 1:

<!-- suffix: ethereum send-suffix -->
`--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante" --rpc-url https://ethereum-rpc.publicnode.com`

The second one prints `transactionHash`: that is `DEPOSIT_HASH` below. `TOKEN_AMOUNT` is the token amount `prepare` printed (`prepare` ends with `Then: node scripts/multichain/first-deposit.mjs … verify … --token N --tx <hash of the deposit>`: `TOKEN_AMOUNT` is that `N`; you may also copy that command from `node` on and put the hash in place of `<hash of the deposit>`).

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

Then fill the chain's row of the progress table (section 6) and go on to the next chain.

## 6. Progress table (fill as you go)

| Chain | 1 pre | 4 deployed (3 tx hashes) | 5 post | 7 deposit hash | 8 verify | 9 post open | 10 record | 11 committed |
|---|---|---|---|---|---|---|---|---|
| OP Mainnet | | | | | | | | |
| Base | | | | | | | | |
| Arbitrum One | | | | | | | | |
| Linea | | | | | | | | |
| BNB Smart Chain | | | | | | | | |
| Ethereum | | | | | | | | |

## 7. If a step fails midway

The principle: **every step before 7 can be repeated safely; nothing of yours is at risk before step 7; from step 7
on, only the printed transactions go in, and the tools refuse rather than guess.** A failure on one chain does not
touch the contracts and pools of the other chains, and you may stop between chains for as long as you like. **One
exception: the depositing account is one account for all six chains and is part of every factory's address.** If
it is ever replaced (it was used for something else, or stolen), the planned factory, router, lens and pairs move
on **every** chain at once, and the committed tools cannot hold the finished chains and the new ones side by side
(review R369-4). Then stop and ask the developer (agent 360's line) before anything else; do not edit
`deployments/` yourself. Pools already opened stay open and yours; only their listing on the page needs that
work.

| Where | What you see | What it means | What to do |
|---|---|---|---|
| 2.2 | `check-depositor` is not FIT | the depositing account has code, a delegation or a transaction on some chain | Stop before any deployment. If it sent a transaction, treat the key as used: a new depositing key means a new factory address on every chain (the exception above); ask the developer (agent 360's line) |
| 2.3 | `record` refuses the signature | wrong account signed, the text changed, or a smart-account signature | Sign again with the fee address itself, as a plain message; nothing is recorded until it is valid |
| 1 or 3 | pre gate `FAIL` | the chain differs from what was reviewed (a token's code changed, the depositing account was used, the fee address delegates to an unidentified contract, the proof is missing) | Do not deploy on that chain. Read the failing line; a delegation change at the fee address on any chain stops that chain until it is cleared or identified (`docs/MULTICHAIN-DEPLOY.md` 2.3) |
| 3 | "lack of funds" / insufficient funds | the deploying account holds less than the gas | Fund more (step 2) and repeat step 3 |
| 4 | interrupted, a transaction failed, the terminal closed | some of the three contracts may be deployed | **Run step 4 again, unchanged.** A contract whose planned address already has code is skipped (shown in the dry run: the second run sends nothing). Then step 5 checks all three |
| 4 | someone else deployed the same contracts first | harmless: the addresses depend only on the code and its fixed arguments, so theirs are identical to yours | Step 4 skips them; step 5 checks the code |
| 5 | `WAIT …` | deployed, not finalized yet | Wait and run step 5 again (Linea: hours) |
| 5 | any `FAIL` | the deployed code is not the planned code at the finalized block | Stop that chain; put no money in; report the output |
| 6 | `market.mjs` prints no market price | the two references disagree or a feed is stale | Wait; it never falls back to one reference |
| 7 | `prepare` FAIL, "no market price", "below the minimum" | nothing was printed, nothing is to be sent | Wait, or use a larger amount, and run step 7 again |
| 7 | `prepare` says tokens sit at the pair's address and prints a `skim` command | someone sent tokens to the not-yet-created pair (above 0.1% of a side) | Send the printed `skim` from **the deploying account, never the depositing account**: the printed line (it already carries `--chain`; do not add another) with `--keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer" --rpc-url RPC_URL` added at its end (if `prepare` printed a `createPair` line first, send that one the same way, then the `skim` line). The `skim` names an address of yours; then step 7 again |
| 7 | **`STOP`: the pool is already open** | you did not open it: the depositing key was used elsewhere or stolen | Deposit nothing on that chain; do not use `add`; stop the remaining chains' openings. That pair of that factory is lost (no money is), and the depositing key must be treated as exposed: the exception above (a new key moves every chain's factory; ask the developer) |
| 7 | the `approve` went through, the deposit was not sent (closed terminal, waited too long) | an allowance of exactly the token amount to the router stands; no money moved | **Run `prepare` again** (shown in the dry run: it prints a fresh pair of lines) and send both new lines; the new `approve` replaces the old allowance |
| 7 | the deposit reverted (`status 0`), for example sent after its 20-minute deadline or with too little gas | nothing was deposited; only its gas was spent | **Run `prepare` again** and send the new lines (shown in the dry run). Never write a deposit by hand or with other minimums |
| 8 | `verify` reports a gift above 0.1% | someone sent tokens to the pair's address in front of your deposit; they are now in the pool and owned by your shares | Nothing is lost: **do not withdraw**. Continue with step 9; compare the pool's price with the market before the page is published |
| 8 or 9 | `verify` or the gate cannot prove the opening | the opening was not your printed deposit | As for `STOP` |
| 10 | `frontend-files` refuses | the report is not a passed post gate with the opening proven | Repeat step 9 until it passes |
| any | the machine or session is lost | | Start again at the first step of that chain whose output you do not have; every step up to 6 can be repeated, step 7 by `prepare` again, steps 8 to 11 any time |

## 8. After the last chain

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
cast send RECIPIENT --value AMOUNT --chain CHAIN_ID --keystore "$DEX_DEPLOYER_KEYSTORE_DIR/deployer" --rpc-url RPC_URL
```

(`CHAIN_ID` and `RPC_URL` as in the chain's section: `--chain` makes the signature valid on that chain only, review
R369-10.)

Then delete `"$DEX_DEPLOYER_KEYSTORE_DIR"`. Leftover dust lost with it is harmless.

**The depositing key** stays as `docs/MULTICHAIN-DEPLOY.md` section 2.1 says: keep it (and its rule: it sends
nothing but printed deposits) if you will open further pairs on these factories; otherwise empty it and delete it.

**Bloch L2 DEX (separate product).** Not part of this procedure: its fee goes to the Bloch Inc Safe through
`blochInc`; that is the integrator's owner checklist item (agent 366).

## 9. The dry run of this document

Run of record: commit `36eca5f` for the once section and OP Mainnet (2026-11-17 22:11 UTC, after review 402's findings R402-1 to R402-8 were fixed; port 47130; in a fresh clone at that commit, with the tools installed from the pinned URLs by this document's block and every program really started); the other five chains at `ab2a3fa` (05:46 UTC onward; ports 46720 to 46760, with the tools of that time), whose 80 chain blocks are byte-identical to these: the 96 chain blocks of this file equal those of `2656604`, `cf93f6e`, `d61c559` and `0dd50c5` (parsed and compared), and every block the dry run executes is found verbatim in those runs' command logs. On the Mac (Intel, macOS 26.6), anvil 1.7.1 forks of each chain on loopback, Foundry 1.7.1, Node v24.21.0. Command: `node scripts/multichain/owner-dry-run.mjs once --out DIR --pt FILE`, then `node scripts/multichain/owner-dry-run.mjs <chain> --port PORT --out DIR --clone DIR/postern-dex --tools DIR/owner-tools` per chain. Evidence (every command run, its output, `evidence.json`) is kept in the agent's scratch (`agents/367-dex-deploykit-r18.md` names it); it contains no key of the owner's (none was used) and the throwaway key never leaves it.

Once ("Before anything" and section 2): **PASS, 32 checks** (the clone: made by the clone block, its commit printed in full, moved to the commit under test and unchanged; the tools: the install block fetches the four downloads from the pinned URLs, each SHA-256 checked before unpacking, and starts every program; the PATH line and the check block end with `owner tools: PASS`; seven refusals on the real directory, each undone: one byte added to `cast`, the directory opened to the group, no PATH line, another directory in the path, one byte added to the compiler, `NODE_TLS_REJECT_UNAUTHORIZED` and `ETH_RPC_URL` set, an access-control list on `cast`; then passing again; `type` finds the five programs in the tools directory only; `npm ci` and `forge build` in the fresh clone, the pair's init code hash built by the pinned compiler equal to the audited `0x16bd5cad…6683`; the no-agent line lists the agent session the dry run was started from; Node v24.21.0, npm 11.19.0 and Foundry 1.7.1 through the launchers inside a script; then the 15 checks of the earlier runs, all kept: kit tests; `check-depositor` FIT on the six chains against the public endpoints; the fee-proof message equal to the one printed here; the signing page written; `record` refusing a throwaway key's signature of the exact message and writing nothing; `verify` NOT VALID because the owner has not signed yet; the deploying key created, read back and distinct from the two other accounts; the plan's addresses; the Portuguese copy's 115 blocks equal to these).

| Chain | Result | Fork block | Public pre gate (real chain, read-only) | Gas: factory, router, lens | Gas: approve, first deposit | Midway drills | Depositing account after (left of the funding) |
|---|---|---|---|---|---|---|---|
| OP Mainnet | **PASS, 44 checks** (the 38 of the first run, all kept, and six more: the clone at the commit under test, the check block, `type`, the pair's init code hash, and `deploy.sh` and `prepare` against the public chain each running the tools check themselves) | 159,677,512 | every check passes but the missing fee-address proof | 2,617,692, 4,082,527, 2,261,269 | 55,449, 2,527,138 | 11 of 11 pass; M3 after the clock jump: PASS | 0.0005 ETH, 1.804243 USDC |
| Base | **PASS, 38 checks** | 58,520,653 | every check passes but the missing fee-address proof | 2,617,692, 4,082,527, 2,261,269 | 55,449, 2,527,198 | 11 of 11 pass; M3 after the clock jump: PASS | 0.0005 ETH, 1.836708 USDC |
| Arbitrum One | **PASS, 38 checks** | 524,954,169 | every check passes but the missing fee-address proof | 2,617,692, 4,082,743, 2,261,269 | 55,449, 2,542,345 | 11 of 11 pass; M3 after the clock jump: refused: a feed is stale on the fork after 21 minutes | 0.001 ETH, 1.836442 USDC |
| Linea | **PASS, 38 checks** | 32,629,084 | every check passes but the missing fee-address proof | 2,617,692, 4,082,743, 2,261,269 | 59,854, 2,531,067 | 11 of 11 pass; M3 after the clock jump: PASS | 0.003 ETH, 1.840888 USDC |
| BNB Smart Chain | **PASS, 38 checks** | 134,066,155 | every check passes but the missing fee-address proof | 2,617,692, 4,082,743, 2,261,269 | 53,476, 2,529,694 | 11 of 11 pass; M3 after the clock jump: refused: a feed is stale on the fork after 21 minutes | 0.003 BNB, 2.969527 USDC (Binance-Peg) |
| Ethereum | **PASS, 38 checks** | 26,432,779 | every check passes but the missing fee-address proof | 2,617,692, 4,082,743, 2,261,269 | 55,570, 2,528,862 | 11 of 11 pass; M3 after the clock jump: PASS | 0.015 ETH, 18.386004 USDC |

What each chain's run checked, in order (OP Mainnet's run first passes the document's check block on the tools directory, in the fresh clone): the owner's step 1 against the public chain untouched (read-only; it fails today on the fee-address proof alone, which is the owner's step 2.3); then on the fork: step 1 PASS; the deploying account funded with exactly the stated amount and read back by step 2; step 3 ends "nothing was sent", the deploying nonce stays 0, and forge's own `Estimated amount required` is below the stated funding; step 4 sends three successful transactions from the throwaway key, the three contracts at the planned addresses; **M1** step 4 again sends nothing; **M4** step 5 before finality prints WAIT and no PASS; step 5 PASS with the pair absent; step 6's market read, the depositing account funded with deposit + allowance and token + 1% and both balances read back by step 6's commands; step 7's `prepare` prints two `cast send` lines from `0x1ec3…C8f3` with `--chain`; **M2** a lone approve, then `prepare` again and its fresh pair opens the pool; **M3** the deposit sent after its 20-minute deadline reverts and creates no pool (then `prepare` either passes or refuses a feed made stale by the clock jump on the fork; both are correct); **M3b** a deposit that runs out of gas reverts, creates no pool, and `prepare` again gives a pair that opens it; M2, M3 and M3b on snapshots, reverted; then the real sequence: `prepare`, the two printed lines with the documented suffix (`--unlocked` for the impersonated account), both mined from the depositing account, exactly two transactions sent by it; step 8 `verify` PASS; step 9 post gate PASS with the pair open and its opening proven; step 10 the page's record written; today's cost from the public chain, cross-checked with `cost.mjs` on the three deployment transactions.


## 10. What the dry run changes, exactly

The dry run (`scripts/multichain/owner-dry-run.mjs`) reads the command blocks of this file (the ones marked
`<!-- run: … -->`), refuses to start if a block it expects is missing, and runs each as written with only these
changes, each of which points a command at the loopback fork or at a throwaway key instead of a real one. Every
command it actually ran is in its evidence (`commands.log`), next to the block it came from.

| Command | Change for the fork | Why |
|---|---|---|
| `gate.mjs`, `market.mjs`, `first-deposit.mjs`, `frontend-files.mjs` | `--rpc http://127.0.0.1:PORT --rehearsal` added | the tools' only way to read a fork; `--rehearsal` refuses any non-loopback URL |
| `deploy.sh` | `--rehearsal-rpc http://127.0.0.1:PORT` added before `--` | as above |
| `--out deployments/<chain>/…`, `--gate-report deployments/<chain>/…`, `fee-proof.mjs page --out /tmp/…` | the path is the dry run's own directory; `frontend-files.mjs` gets `--out DIR` | nothing of a dry run is written into `deployments/` |
| `"$DEX_DEPLOYER_KEYSTORE_DIR"` | a throwaway directory; `cast wallet new` gets `--unsafe-password`, `forge` and `cast` get `--password-file` | a throwaway key with a throwaway password, never the owner's |
| `--rpc-url https://…` (public endpoint) in `cast` | the fork's URL | nothing is sent to a public chain |
| the printed `cast send` lines and their suffix (the inline text marked `<!-- suffix: … -->`) | the suffix `--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante"` becomes `--unlocked`; the depositing account is impersonated on the fork | nobody but the owner has that key |
| `DEPLOYER_ADDRESS`, `DEPOSIT_HASH`, `TOKEN_AMOUNT` | the values the earlier steps printed | as the owner does |
| funding (steps 2 and 6) and waiting (steps 5 and 9) | `anvil_setBalance` with exactly the amounts of section 3, the token by its balance slot; 70 blocks mined so that anvil's `finalized` (64 behind) covers the transactions | the owner funds from a wallet and waits for the chain |
| `fee-proof.mjs record` | not run (it needs the fee address's signature); the pre gates of the dry run report the proof as "not required (rehearsal)", and the public pre gate is run read-only to show that it fails on the missing proof only | no one but the owner can sign it |
| `git add`, `git commit`, `npm ci`, `git checkout` | not run | they change the repository, not a chain |
| `~/postern-dex` (the clone) | the dry run's own directory; after the document's clone block and its commit line have run on the public `main`, the clone is moved to the commit under test, fetched from the agent's worktree (which must have no uncommitted change) | every later block runs in that fresh clone (review R402-3): `npm ci`, `forge build`, the tests, the plan, `deploy.sh`; nothing built or installed in an agent's worktree is used |
| `PASTE-THE-40-DIGIT-COMMIT-ID` (the two commit comparisons, review R402-4) | the id of the commit the clone is at: the public `main`'s for the first line (run right after the clone block), the commit under test for the script's line in section 2.1 | the owner pastes the id he received outside the repository. Each line is also run as printed (placeholder not replaced), with one digit changed or the parent's id, and with seven digits; the script's line also with one byte added to a tracked file: all must refuse |
| `~/dex-owner-tools` (install, PATH line, check, `type`) | the dry run's own directory | the owner's directory is never written by a dry run |
| the terminal's environment | only `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, the PATH line of this document and the two keystore variables | an agent session's own variables are not the owner's terminal; the check's refusal of a set variable is shown separately (T6) |
| `owner-toolchain.sh install`, only with `--archives DIR` | `--from DIR` added | archives already fetched from the same pinned URLs; each is still compared with the pins before it is unpacked |
| `pgrep` (no agent running) | run as written; the dry run is itself started by an agent, so it must list at least one process there (and nothing when a person runs it with no agent) | shows the line finds a running agent |
| `deploy.sh … dry-run` and `first-deposit.mjs … prepare`, once more, exactly as written, against the public chain | nothing changed; read-only up to where they stop today (the missing fee-address proof; the missing gate report) | shows that each runs the owner tools check itself first (review R402-5) |
| the Portuguese owner copy | its marked blocks are compared with this file's (`once --pt FILE`); any difference fails the run | the owner may follow either |

## 11. Not done / not proven

- **Nothing was sent to any public chain and no key of the owner's was used.** Every transaction of the dry run went to a loopback fork; the depositing account and nothing else was impersonated there. Real inclusion, real fees charged, and Linea's prover limits on a real transaction are not shown.
- **The accepting path of the fee-address proof** (`record` with the fee address's real signature) needs the owner's key; only its refusals were exercised here (a throwaway key's signature). The signing page was written, not used with a wallet. The pre gates on the forks run with `--rehearsal`, where the proof is "not required"; on the public chains they fail on it today, by design.
- **Two endpoints on the fork.** With `--rpc … --rehearsal` the tools read one URL (the fork), so the two-endpoint agreement of the gates and of `prepare` was not exercised by this dry run (it is by the tools' own tests and by the read-only public pre gate and `check-depositor` runs above).
- **The owner's machine.** Run on the coordinator's Mac with Foundry 1.7.1. The owner's zsh and keystore prompts were not seen; `npm ci`, `git` and the Ledger and MetaMask paths were not run.
- **The owner's tools (review R369-16): what the check cannot see.** The directory is closed to other macOS users, not to a program running as the owner's own user: such a program could also change the shell's start-up files, this clone, or the guide itself, and no script can rule that out from inside the same account. That is why the check is repeated in every terminal, `type` is shown, and no agent may run during a signing session; a separate macOS user account used only for signing would be the stronger separation (an owner decision). `pgrep` finds only processes whose command line contains "claude" or "codex".
- **Signatures of the releases were not verified, only their published checksums.** Foundry's Sigstore bundles and GitHub attestations, the PGP signature of Node's `SHASUMS256.txt` and Homebrew's attestation were not verified; for the compiler the checksum is the Solidity project's `list.json`. The checksums come from the same publishers' sites as the downloads (the pins file names each source).
- **Apple silicon.** The `darwin-arm64` pins were hashed from the official archives and the directory was built from them on this Intel Mac; nothing was run on an Apple-silicon Mac.
- **What still comes from outside the checked directory.** macOS's own programs in `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` (`bash`, `git`, `curl`, `python3`, `shasum`, `pgrep`: root-owned and system-protected, required to be the only other entries of the path); the 400 npm packages of `frontend/` (each fixed by a sha512 in the committed lockfile and installed without scripts, then lying in the clone under no later check); the clone itself after the commit comparison. `DYLD_…` variables cannot be seen by a script on macOS (the system removes them first, which is also what keeps them from the programs).
- **Gas prices are of one hour.** The cost table is today's reading; Linea's `eth_gasPrice` moved eightfold within the day. The funding column, not the "today" columns, is what to plan with.
- **The deposit size.** The dry run used each chain's minimum (0.1 ETH; 0.5 BNB; 1 ETH on Ethereum). A larger deposit changes the token amount and nothing else in the sequence.
- **Waiting is simulated.** 70 mined blocks stand for the chain's finality; the real waits are in steps 5 and 9.
- **Review of the tools and this sequence** (agent 369, `agents/369-dex-owner-tools-review-r18.md`): R369-1 to R369-3, R369-5 to R369-8 and R369-10 to R369-14 are closed (in 360's tools at `6b260da`, `274ca45`, `279b900`, and in this document); R369-4 is closed by documentation and the two-phase order, with the residual stated in the next item; R369-9 (what a hardware wallet shows) is moot for this sequence, which signs with keystores, and stands only for a fee-address proof signed on a Ledger (a plain message, whose text the device shows). Note: the two-endpoint agreement those fixes added is not exercised on a fork (third item above).
- **The depositing key is one for all six chains** (R369-4): this sequence avoids the dead end (deploy everything first) but a replaced key still needs the developer (section 7).
- **The page after deployment** (build, preview, a real swap) is outside this dry run (agents 366, 368; the owner's own swap).
