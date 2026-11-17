# Bloch L2 mainnet (chain 700770): DEX deployment package

Branch `codex/dex-mainnet-700770-20261030`. It contains the readiness,
devnet4 main-procedure and Safe/frontend branches (all three were already
ancestors of `feat/dex-safe-frontend-20261016`) and the audit fix DEX-01
(`d6c8b04`, `72b3cb2`). Nothing here has been deployed. The L2 mainnet has
never settled a block, and its head is still the genesis `0x632e45ae…f468`.

## Contents

| File | Role |
|---|---|
| `deployments/mainnet/700770/pins.json` | Chain ID 700770; L2 genesis `0x632e45ae778da371a88dc1ae430193aa77eabb67a11de18e84fea7d20d11f468` (state root `0x2ad7e807…c05d`); rules domain and genesis time; L1 timing and network pin; v2.1 release binary hashes (unsigned); Safe v1.4.1 npm integrity and runtime code hashes |
| `deployments/mainnet/700770/safe.config.json` | Bloch Inc Safe: SafeL2 v1.4.1, 3 of 5, salt nonce 0. `bootstrap.address` and the five owners are `TBD-owner` |
| `deployments/mainnet/dex-mainnet.config.json` | DEX: genesis pinned; caps; the pilot pair WBLCH/bUSDC. `source.revision` is `d18ab04`, the commit with the F1 fix; later commits change no contract (check with `git diff d18ab04 -- contracts foundry.toml`). `deployer.address`, `blochInc`, and the bUSDC `token`/`codeHash` are `TBD-owner` |
| `scripts/staging/deploy-safe.mjs` (+ `safe-deploy-config.mjs`) | `validate`, `pending`, `plan`, `preflight`, `txs`, `blochinc` |
| `scripts/staging/deploy-dex.mjs` | Existing `validate`/`plan`/`run`/`record`, plus `pending`, `preflight`, `txs` and `record --tx-hashes` |
| `scripts/staging/sign-and-publish.sh` | Signs each planned transaction offline with `cast mktx` (explicit nonce, gas limit and fees; `--ledger` or any cast signer), journals its public fields before publication with `publish-recorded.mjs`, and waits for the receipt |
| `scripts/staging/verify-deployment.mjs` | Post-deployment verification (details below) |
| `scripts/staging/check-finality-gate-mainnet.mjs` | The schema-2 finality gate, with chain 700770, the genesis and the reviewed Safe plan pinned by the repository |
| `scripts/staging/private-l2.sh`, `scripts/staging/rehearse-mainnet-package.sh` | Full dry run on anvil (chain 700770) or on a private L2 built from the v2.1 binaries at the real genesis |

## Why a raw-transaction path

The settled L2 RPC answers `pending` with the latest state and spools
transactions for the sequencer. It cannot estimate gas for a sequence whose
later steps call contracts created by earlier ones. Every transaction is
therefore planned with its nonce, gas limit and calldata (or init code),
signed offline and published one at a time:

- `txs` re-derives every init code from the artifacts and checks it against
  the plan's `initCodeHash` (for the Safe proxy call, the calldata against
  `dataHash`).
- The signer refuses to start unless all of these hold:
  - the `--confirm` value equals the config's SHA-256;
  - chain ID and genesis match;
  - the signer is the planned key;
  - the balance covers every gas limit at the max fee.
- Before each transaction it checks the latest nonce and that the planned
  creation address is still empty.
- After each receipt it checks status 1 and the planned address.

The forge path (`deploy-dex.mjs run --broadcast`) is unchanged. `run` without
`--broadcast` stays the forge dry run.

Gas limits are about 1.5 times the measured gas (factory, lens and createPair
remeasured on anvil at 4ec2fe9c, 2026-11-02; margins now 1.33 to 1.43):

| Step | Gas used | Limit |
|---|---|---|
| SafeL2 singleton | 5,321,999 | 8,000,000 |
| SafeProxyFactory | 711,231 | 1,100,000 |
| CompatibilityFallbackHandler | 1,267,726 | 1,900,000 |
| createProxyWithNonce (3 of 5) | 352,788 | 550,000 |
| WBLCH | 612,333 | 1,000,000 |
| Factory (2 caps) | 2,661,496 | 3,700,000 |
| Router | 4,074,147 | 6,200,000 |
| Lens | 2,256,517 | 3,000,000 |
| createPair | 2,315,112 | 3,300,000 |

## Multicall3 and the CREATE2 deployer

The L2 genesis has neither contract, and the L2 refuses the pre-EIP-155
transactions that place them at their usual addresses on other chains. They are
therefore ordinary CREATE deployments, first in the deploy order, from a fresh
key holding gas only (`deployments/mainnet/700770/infra.config.json`,
`TBD-owner`):

| Nonce | Contract | Runtime code hash |
|---|---|---|
| n | Multicall3 | `0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891` |
| n+1 | Deterministic CREATE2 deployer | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |

- The addresses differ from those on other chains. They are recorded in the
  infra plan, and integrators must take them from there. Tools with built-in
  defaults must be told: `forge script --create2-deployer <address>`, and a
  viem chain's `contracts.multicall3.address`.
- `deployments/mainnet/700770/infra-artifacts.json` holds the runtime read from
  Ethereum mainnet. Its hash is checked before any plan exists. The init code
  is a fixed 12-byte constructor that returns that runtime
  (`wrapRuntime` in `scripts/staging/infra-deploy-config.mjs`).
- `verify-deployment.mjs --infra-plan` checks the exact code, a real
  `aggregate3`, and that the deployer predicts the planned CREATE2 address.
- The frontend record carries the infra plan. The site verifies the Multicall3
  code at the finalized block and reads balances through it.

## Bloch Inc Safe on a chain without the singleton factory

The Safe singleton factory (`0x914d7Fec…`) needs a pre-signed deployment for
each chain ID, and 700770 has none. The bootstrap path is used instead. A
fresh bootstrap key deploys, by CREATE at nonces n to n+2:

- `SafeL2`;
- `SafeProxyFactory`;
- `CompatibilityFallbackHandler`.

At n+3 it calls `createProxyWithNonce(singleton, setup(owners, 3, 0, 0x, handler, 0, 0, 0), saltNonce)`.
The bytecode comes from the npm tarball `@safe-global/safe-contracts@1.4.1`:

- integrity `sha512-fP1jewyw…MU7dQ==`, which equals the npm registry's
  `dist.integrity`;
- sha256 `8803f7cf…0bf79`.

The tool refuses artifacts whose runtime code hash is not the canonical
v1.4.1 hash (the same hashes as safe-deployments). The proxy address is
`CREATE2(factory, keccak256(keccak256(initializer) ‖ saltNonce), keccak256(SafeProxy creation code ‖ singleton))`.
It therefore depends on the bootstrap address and nonce, the owners (in
order), the threshold and the salt. The bootstrap key holds nothing
afterwards and has no role in the Safe or the DEX. `deploy-safe.mjs blochinc`
prints the exact `blochInc` value for the DEX config.

Only the three contracts the Safe needs are deployed. MultiSend,
MultiSendCallOnly, SignMessageLib, CreateCall and SimulateTxAccessor are
optional, and the same path could deploy them (open decision).

## Caps: guarded launch

| Token | Cap | Justification |
|---|---|---|
| WBLCH | 10 BLCH (`10000000000000000000`) | The code ceiling `MAX_WRAPPED_CAP`, checked by the deploy script, the config validator and the gate. It is applied per pair, so any other WBLCH pair anyone creates is also limited to 10 WBLCH |
| bUSDC | 1,000 bUSDC (`1000000000`) | One tenth of the bridge bucket of 10,000 bUSDC (BRIDGES-MAINNET.md: supply cap 100,000, 24 h refill). That bucket fraction is also the bridge's large-transfer delay threshold |

The practices behind these caps are those of guarded launches: supply caps on
new listings, as Aave and Compound use, and the 10%-of-rate-limit rule used for
bridged assets. The caps are fixed in the constructor (there is no setter),
and they are raised only by a new deployment after an external audit (stage 1
in MAINNET-READINESS.md §3). The caps give these guarantees:

- **Bounded loss while unaudited.** One pilot pair can hold at most 10 BLCH
  plus 1,000 bUSDC.
- **Bridge failure.** If the bUSDC bridge minted unbacked tokens up to its
  bucket, the cap stops the dump at `cap − reserve`. The share of the WBLCH side
  lost is 50% only when the bUSDC cap is near `10 × opening price`; at 1,000 bUSDC
  and a price of about 25.5 it measured 87%. Fill `openingPrice.quotePerWrapped`
  (bUSDC base units per BLCH): `validate` and `plan` refuse a cap outside 75–125%
  of `WBLCH cap × price`. The low side is waived when the 1/10 bucket rule is what
  holds the cap down. The cap cannot change after deployment.
- **bUSDC pause.** It stops mints only. Swaps, transfers, bridge burns, `skim` and
  LP exits continue.
- **Exit always fits the bridge.** A full pool side is at most 1/10 of the
  bucket, so it can be withdrawn and bridged out in one undelayed transfer.
- **Seeding.**
  - Seed at most 50% of the tighter cap at the market price. The price can
    then move 4× either way before one side is capped.
  - At a BLCH price p (USD), the bUSDC cap binds first when p > 100.
- **Rule enforcement.** The rule `cap × 10 ≤ bucketCapacity()` is enforced
  three times: by the validator, by the preflight (at latest) and by the
  gate (at finalized).

wGSMH is deprioritized (the GnB-SMH chain is stopped), so it is not in the
launch factory:

- If someone creates a wGSMH/WBLCH pair permissionlessly, the WBLCH side is
  capped at 10 BLCH and the wGSMH side is uncapped (F4).
- Listing wGSMH with a cap means a new factory deployment once its bridge
  exists.

The frontend's planned pools and caps are read from
`deployments/mainnet/dex-mainnet.config.json`, so the site and the package
cannot disagree.

## Quotes and donations in the site

- Balances, allowances, caps and the binding quote are read at the finalized
  block. The lens quote is also taken at `latest`. If it falls below the active
  quote's minimum output, the site warns and disables Swap until the user
  reconfirms at the latest price; the default slippage stays 0.50%, and the
  maximum is 3.00% (DEX-5). The check
  runs again when Swap is pressed.
- A donation above the reserves (accepted residual risk DEX-02) is shown per
  pool with a `skim` action. The lens reports such a route as unavailable.
- The site reads the public RPC directly. The gateway allows CORS from any
  origin, and the CSP's `connect-src` names the RPC origin.
  `scripts/devnet4/rpc_compat_proxy.py` is not in this path.

## L2 binaries

`deployments/mainnet/700770/pins.json` records the final L2 deposit-only launch
release `bloch-l2-2026-11-03-next-native-78d4921c` (build commit `926d2cf`, native
`78d4921c`), with `status: unsigned`: the release awaits the owner's signature,
and `sha256sums` is the hash of its `SHA256SUMS` file, the owner's signing target
(`6d3bd628…`). It replaces the v2.1 release (`c18752fd…`, `fb0d5313…`,
`18be911a…`) and the superseded 17383fe candidate (settled RPC `e5754d05…`). The
bridge signers pin the same three binaries (`l2_finality.MAINNET_V2`). No tool reads
`l2Release` to select a binary; an operator compares the hashes with `sha256sum`.

## Post-deployment verification (`verify-deployment.mjs`)

The script reads at `latest` or `finalized`, through EIP-1898 block-hash
calls.

- **Chain:** the chain ID and genesis match both plans.
- **Fee recipient:** the DEX plan's fee recipient and `blochInc` pin are
  exactly the Safe plan's.
- **Safe contracts:**
  - the runtime code hash of the singleton, the proxy factory, the handler
    and the proxy;
  - the factory's `proxyCreationCode()` hash;
  - `verifySafe`: singleton slot, fallback-handler slot, guard slot empty, no
    module, `getThreshold() == 3`, `getOwners()` equal to the five pinned
    owners, and `VERSION() == "1.4.1"`.
- **DEX contracts:**
  - the runtime code hashes of WBLCH, the factory, the router, the lens and
    the pair;
  - the immutables, read back from the deployed runtime at solc's
    `immutableReferences`: factory `feeTo`, router `factory` and `WBLCH`, and
    lens `factory`. They are also read through their getters.
- **Factory state:** `INIT_CODE_PAIR_HASH` (`0x16bd5cad…6683` at this
  revision), `reserveCap` per token, `allPairsLength`, and `getPair`.
- **Pairs:** factory, token0/token1, `reserveCaps()`; with `--expect-empty`,
  zero reserves and supply.
- **bUSDC:** the code hash and `bucketCapacity()`, with the cap at most 1/10
  of it.
- **Keys:** the bootstrap and deployer nonces equal the plans' final nonces,
  and their leftover balances are reported.
- **Transactions:** with the hash files, each transaction came from the
  planned key with the planned nonce, succeeded, and has the planned init
  code, calldata and created address.

## Dry runs (2026-10-30, build host, loopback only, throwaway keys)

`rehearse-mainnet-package.sh` takes the committed configs, fills the
`TBD-owner` fields with throwaway values and runs the whole sequence:

0. Multicall3 and the CREATE2 deployer: config, plan, preflight, txs, sign and
   publish.
1. Safe: config, plan, preflight, txs, a refused wrong `--confirm`, then sign
   and publish.
2. bUSDC. With `BRIDGE_REPO=<clean checkout of the bridge RC>` and `ETH_PORT=<port>` (required in
   private-L2 mode) it is the real `BridgedStablecoinV3`, created by the bridge's own
   `deploy_pontes.py` over a `ProvenanceSourceVault` from `vault_pontes.py` on a loopback
   "Ethereum" anvil, both under the mainnet policy: 5 of 7 signers, 6 for the switch, 3 guardians,
   T = 0, 12 h mint delay, 5 + 5 bps vault fee (`scripts/staging/bridge-v3-real.sh`). The issuer's
   bUSDC comes from a real vault deposit, the committee's mint and an execute after the delay. The
   gates take the bridge's `busdc.plan.json` and `busdc.record.json`. Without `BRIDGE_REPO`, anvil
   mode uses a test token with `bucketCapacity()` and shows only the genesis refusal and the
   generic gate.
3. DEX:
   - config with `blochInc` from the Safe plan;
   - plan;
   - preflight and forge dry run (the chain is unchanged afterwards);
   - txs, sign and publish, then record.
4. `verify-deployment` at latest.
5. Gate refused before finality; finality; gate passes; `verify-deployment` at
   finalized.
6. Launch checks:
   - `setFeeTo` reverts;
   - a seed at 50% of the caps succeeds;
   - an over-cap deposit reverts;
   - swaps run;
   - an over-cap swap reverts and the lens reports it unavailable;
   - a donation above the cap is reported, blocks swaps and is cleared by `skim`;
   - both utility contracts work in real calls;
   - the protocol fee reaches the Safe;
   - the Safe redeems it with `execTransaction`, after 2 of 5 signatures are
     refused and with 3 of 5 accepted.

The two runs differ as follows:

- **anvil, chain 700770:** the mainnet gate wrapper refuses the run, because
  anvil's genesis is not the pin. The generic gate passes through the anvil
  finality shim. With `BRIDGE_REPO`, every other check of the mainnet gate (Safe pin,
  bridge plan and record, reviewed token build, launch policy) is also run with only
  the genesis pin replaced (`scripts/fixtures/mainnet-gate-rehearsal-genesis.mjs`,
  rehearsal only), and a bridge plan with another signer is refused.
- **private L2:** it uses the `bloch-l2-produce-dev` and `bloch-l2-settled-rpc`
  named by `l2Release` in `pins.json` with `--rules mainnet` and the
  ceremony's domain and genesis time. Its genesis is the real
  `0x632e45ae…f468`, so the mainnet gate wrapper itself passes.
  - Block 1 mints synthetic deposits to the throwaway keys.
  - A producer loop includes the spooled transactions.
  - Finality is a synthetic follower status (schema v2) written by
    `private-l2.sh finalize`.
  - The bridge token's 12 h mint delay passes on the rehearsal clock
    (`private-l2.sh warp`: later blocks are anchored that far ahead).
  - The mainnet gate is refused before finality and without the bridge record,
    and passes with the bridge's plan and record.

  It proves the tooling against the real RPC binary and genesis. It does not
  prove L1 settlement.

The run results are in the agent report
(agent 15's report, `agents/15-dex-deploy.md` in the coordination folder, not in this repository).

## Mainnet sequence (owner)

Preconditions:

- the L2 is live and settled;
- your own follower and settled RPC replay from the pinned genesis;
- the bUSDC bridge is deployed;
- every `TBD-owner` is filled.

The sequence:

**Owner decision of 2026-11-17: Bloch Inc is the owner's plain address
`0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544` (no Safe).** Steps 1 to 4 (the Safe) are then
skipped, and step 5 sets, in `dex-mainnet.config.json`:

```
"blochInc": { "address": "0x775a993f09bd80aecf8f8c2ade0c84158e3a0544", "codeHash": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" }
```

That exact address is the only Bloch Inc the tools accept without code (`OWNER_FEE_EOA` in
`script/DeployMainnet.s.sol` and `scripts/staging/finality-gate.mjs`); any other address must still be the
pinned Safe. `deploy-dex.mjs preflight` and `run` then need `--rpc2 <second endpoint, another operator>`:
the address's code is read from both endpoints at one block hash and must be empty (an EIP-7702
delegation is refused), and the deploy script refuses it again on chain. `verify-deployment.mjs` and
`check-finality-gate-mainnet.mjs` are run without `--safe-plan`. The fee is then redeemed by that address
itself (`pair.transfer(pair, fee)`, `pair.burn(address)`), signed with the owner's own wallet. Keep the
address free of any EIP-7702 delegation: it is the permanent fee recipient. Rehearsal:
`BLOCH_INC_MODE=owner-eoa scripts/staging/rehearse-deploy-anvil.sh <revision> 700770 <port>`.

0. Fill `deployer.address` in `infra.config.json` with a fresh key and fund it
   with gas only. Run `deploy-infra.mjs validate`, `plan --write`, `preflight`
   and `txs`, then `sign-and-publish.sh`, and commit the plan and the hashes.
1. Fill `safe.config.json` (the bootstrap address and five hardware-wallet
   owners). Then run `deploy-safe.mjs validate`, then `plan --write`, and
   commit the plan.
2. Fund the bootstrap key with gas only.
3. Run `deploy-safe.mjs preflight` and then `txs`.
4. Run `sign-and-publish.sh … -- --ledger` (or the bootstrap key's signer).
5. Set `blochInc` from `deploy-safe.mjs blochinc`. Fill `deployer.address`
   and the bUSDC `token`/`codeHash`. Then run
   `deploy-dex.mjs validate`, then `plan --write`, and commit the plan.
6. Fund the deployer with gas only. Run `deploy-dex.mjs run` (preflight plus
   forge dry run), then `txs`, then `sign-and-publish.sh`, then `record
   --tx-hashes`.
7. Run `verify-deployment.mjs --infra-plan … --infra-hashes … --expect-empty`.
8. After L1 finality, run `check-finality-gate-mainnet.mjs` with
   `--bridge-plan` and `--bridge-record`: the bUSDC plan and record written by
   the bridge's `deploy_pontes.py` (copied, never retyped). The gate compares the
   token's signers, guardians, thresholds and T with them and checks the
   reviewed build in `deployments/mainnet/bridge-token.pin.json`. Only
   `liquidity-enabled` allows the seeding ceremony (≤ 50% of the tighter
   cap).

Stop at any refusal. If a broadcast lands only partly, do not finish it by
hand: re-plan from the current nonce.

### If a third party calls `createPair` first (F2)

`createPair` is permissionless, so the deployer's planned step can revert with
`PAIR_EXISTS`. The pair is then the planned one, whoever created it, and the
deployment goes on:

- `sign-and-publish.sh --plan <plan>` runs `deploy-dex.mjs check-pair`. It accepts
  the revert only if the factory registers the planned address and the init code
  hash, runtime code, tokens and caps match the plan. It records the reverted hash.
- `record` repeats that check, and lists the hash in the gate file as
  `existingPairTransactions`.
- The gate allows a revert only for a listed hash that called the factory, and
  checks the pair at the finalized block as usual.
- `verify-deployment` repeats the check. `--expect-empty` still refuses a pair
  that holds a deposit.

Check the pair by hand at any time:

```
node scripts/staging/deploy-dex.mjs check-pair --plan deployments/mainnet/700770/dex.plan.json --rpc http://127.0.0.1:18955
```

The check prints the reserves and shares. If they are not zero, someone also
deposited: run `dex-seed-plan.mjs plan` before seeding.

### Round 14 runs (2026-11-09), with the real bridge token

Bridge revision `bb9abe0` (token creation keccak `0xe560441f…1de7`, the pin).

| Run | Where | Result |
|---|---|---|
| `rehearse-mainnet-package.sh anvil` with `BRIDGE_REPO` | Mac | REHEARSAL OK; mainnet gate checks pass with the genesis pin replaced; other signer refused |
| `rehearse-mainnet-package.sh anvil` without `BRIDGE_REPO` | Mac | REHEARSAL OK (stand-in path unchanged) |
| `rehearse-mainnet-package.sh private-l2` with `BRIDGE_REPO` | build host, launch release binaries (`produce-dev e3f1a290…`, `settled-rpc 53e88565…`), pinned genesis | REHEARSAL OK; **the mainnet gate itself passes** with `busdc.plan.json` / `busdc.record.json` |

`scripts/staging/e2e-settled/drive.sh` uses the same library (steps `bridge-eth`, `bridge-credit`,
`bridge-deposit`). Its run on the private settled stack with real proofs was not made in round 14; its
money flow was run without proofs and measured (next section).

### Settled driver budget (measured 2026-11-09, no proofs)

`scripts/staging/e2e-settled/proofless.sh` runs the driver's own steps, with the real bridge token, on
`private-l2.sh` (launch release binaries `produce-dev e3f1a290…`, `settled-rpc 53e88565…`, pinned
genesis, bridge `bb9abe0`, synthetic finality, `warp` for the 12 h mint delay). The mainnet gate passes
in the main flow and in the derived flow `f3`. `drive.sh budget` (`budget.mjs`, read-only) replays the
token's Transfer logs and reports each key's lowest balance.

| Flow | Steps | bUSDC the issuer needs | Bursts (L2 blocks at best) |
|---|---|---|---|
| main | deploy, gate, bridge-credit, rec-fund, seed, safe-fee, cap-skim, fund-user, big-swap 30, donate, fill 300 3, close 200 2, keeper, reopened, fill 100 2 | **3,200.164862** (2,100 of it is `rec-fund`) | 19, counting the L1 funding block; `pending-probe` (not run) adds one |
| `f3` | rec-init, rec-fund, deploy, gate, failed-approve, grief | 2,099.011755 | 6 |
| `f2` (`ATTACK_CREATEPAIR=1`) | rec-init, rec-fund, deploy | 2,100 | 3 |
| all three | | **7,399.176617** of the 9,000 deposited | 28 to 29, fewer when the flows share blocks |

BLCH: each `fund` deposit is 100 BLCH per funded key. The issuer pays `rec-fund` (76 BLCH) and its own
swaps: 78.06 BLCH net in the main flow, so every derived flow needs one more `fund` first. No other key
spends more than 0.03 BLCH of its own deposit; the third party uses 3.1 of the 40 BLCH it receives.

What the measurement changed in the driver:

- The default deposit stays 9,000 bUSDC and now covers the three flows. `rec-fund` gives the third
  party 1,500 bUSDC instead of 4,000 (`REC_FUND_THIRD_PARTY`); its largest use is 1,001. With 4,000 the
  three flows needed 14,899.18 bUSDC, and **one deposit cannot exceed 10,000 USDC** (the vault's
  `windowLimit`), while the token's mint bucket holds 10,000 bUSDC refilled over 24 h: a second
  deposit of that size is refused (`RateLimited`) for about a day, then waits its own 12 h.
  `bridge-deposit` queues one more deposit when the bucket allows it.
- `keys` makes 13 keys: the DEX config requires a first depositor, so the main flow could not deploy
  with 10. `rec-init` replaces the depositor, third party and keeper, and carries the bridge keys, plan
  and record (the gate refused derived flows without them). `rec-fund` is paid by the issuer:
  `verify-deployment --expect-empty` pins the Safe bootstrap key's nonce, and a derived flow failed
  there ("bootstrap nonce 20, plan ends at 4").
- `E2E_RPC`, `E2E_GW` and `E2E_FINALIZE` point the steps at another loopback L2. Without them the
  settled stack's addresses and waits are unchanged.

**Measured on real settlements (agent 315, 2026-11-11, 69 real Groth16 proofs,
`agents/315-settled-fullstack-r15.md`):** main, `f3` and `f2` PASS with the mainnet gate passing at finalized
blocks 9 and 61; the issuer needed 3,200.245774 bUSDC for main and 7,399.338159 for all three flows (proofless
figures: 3,200.164862 and 7,399.18); 14 bursts in main, about 6 to 8 minutes per block. `pending-probe` stopped the
run on defect D1 (a back-run with priority fee 0, refused by the settled RPC) and passed after the tip was raised by
hand; the driver now takes the probe's tips from the RPC and a refused probe transaction no longer ends the step
(docs/audit/KNOWN-ISSUES.md section 13; `proofless.sh probe`). The browser scenes (`ui`, `poll`) were not run there.

Not exercised without proofs, and still owed by the settled run: real settled finality at the gate
(`wait_final`), L1 deposits (`fund`), the nginx gateway and its replica (`gw`, `poll`,
`pending-probe`), the browser scenes (`ui-prep`, `ui`), and tip ordering inside one slow block (the
proofless producer makes a block per second, so `grief` and the seed burst land in other blocks than
on the settled stack).

Window for the settled run (inferred from the round-3 run on the same stack, not measured this
round): one host with the stack of `stack.sh` rebuilt on the current L2 release (5 validators,
relays, follower, settler, settled RPC, gateway pair; ports 25000-25099), the 64 GiB proving scope
plus 16 GiB for the net, `PROVING.lock` held for the run, and about 24 hours: 20 proofs of 25 to 35
minutes (up to 29 if the derived flows do not share blocks), one finality wait of about 40 minutes at the
gate, and the token's 12 h delay between `deploy` and `bridge-credit`, during which nothing else
can proceed.

### New-slot fee on a real settled RPC (measured 2026-11-11, no proofs)

`scripts/staging/newslot-rpc-check.mjs` prices each call with the page's own module
(`frontend/src/mainnet/newslotfee.ts`) against a settled RPC on a private L2 (`private-l2.sh`, pinned genesis, the
real bridge token from the bridge freeze `1aef47c`, the DEX deployed and seeded by `e2e-settled/drive.sh`), and
compares the page's figure with what the node decides for a signed transaction. Two runs on 45.77.142.123:

| RPC | Admission rule | Result |
|---|---|---|
| Launch release `926d2cf` (settled-rpc `53e88565…`, produce-dev `e3f1a290…`) | **not enforced**: the launch release is deposit-only and has no new-slot rule; every transaction was admitted at the wallet's own fee | `eth_createAccessList` is served at `latest`; a zero-balance and a low-balance account get the same answer as a funded one (the balance is not checked against gas), with or without fee fields; a call whose value exceeds the balance answers `"error": "EVM error: OutOfFunds"`, and the page then refuses to price and sends nothing |
| User-transaction candidate `6b75a4c` (built on the host, settled-rpc `0ffafb33…`, produce-dev `1cee819f…`), started with `REQUIRED_TIP_FILE` (policy v2 `admission.version` 1, 200 µBLCH per slot, the rig's own keys exempt as operators) | **enforced** | below |

Candidate run, a fresh account, real `BridgedStablecoinV3`:

| Call | Slots: page / node | Gas: page's lower bound / node | Tip: page / node requires (wei per gas) | Page over node | Wallet's own fee | Node's figure less 1 wei | Page's fee |
|---|---|---|---|---|---|---|---|
| First `approve` of bUSDC | 1 / 1 | 44,037 / 46,137 | 4,995,798,988 / 4,334,915,578 | 1.152 | refused | refused | admitted at the first request |
| Swap bUSDC for BLCH after it (first sale in the pool) | 2 / 2 | 134,606 / 174,226 | 3,268,799,311 / 2,295,868,585 | 1.424 | refused | refused | admitted |
| First `approve` by an account holding 0.002 BLCH | 1 / 1 | 44,037 / 46,137 | 4,995,798,988 / 4,334,915,578 | 1.152 | refused | refused | admitted |
| First native swap BLCH for bUSDC (the account never held bUSDC) | 1 / 1 | 106,289 / 142,289 | 2,069,828,487 / 1,405,590,032 | 1.472 | refused | refused | admitted |
| The same native swap again | 0 / 0 | | wallet's fee | | admitted | | |
| Skim of a donation to the caller | 1 / 0 | 41,586 / 62,586 | 5,290,241,909 / none | | admitted | | not needed |

What this shows: the page counts exactly the slots the node charges for approvals and swaps of the real token, its
fee is admitted at the first request, and it is 15% to 47% above the node's own requirement (10% is the margin; the
rest is the gas lower bound, which subtracts the access list's intrinsic cost: 2,400 gas per address and 1,900 per
key that the simulation carries and the wallet's transaction does not). For the skim the page counts one slot the
node does not charge (a slot that reads zero and stays zero): the page suggests 5.29 gwei where the wallet's own
fee would do, 0.00033 BLCH on that transaction. This is the documented upper bound; an exact figure needs the
node's own quote (the admission quote method requested from the L2 line).

**With the node's own quote** (third run, 2026-11-11): the L2 line published `bloch_admissionQuote`
(bloch-l2-evm `24a116e`, candidate line only). The page asks it first and keeps the access-list computation as the
fallback. Against a settled RPC built from `24a116e` (settled-rpc `b0627a30…`, produce-dev `12cc2841…`), same rig:

| Call | Priced by | Slots: page / node | Tip: page / node requires (wei per gas) | Page over node | Wallet's own fee | Node's figure less 1 wei | Page's fee |
|---|---|---|---|---|---|---|---|
| First `approve` of bUSDC | quote | 1 / 1 | 4,768,407,136 / 4,334,915,578 | 1.100 | refused | refused | admitted at the first request |
| First `approve` by an account holding 0.002 BLCH | quote | 1 / 1 | 4,768,407,136 / 4,334,915,578 | 1.100 | refused | refused | admitted |
| First native swap BLCH for bUSDC | quote | 1 / 1 | 1,546,910,049 / 1,406,281,862 | 1.100 | refused | refused | admitted |
| Sale after the approve, repeat native swap, skim of a donation | quote | 0 / 0 | wallet's fee | | admitted | | not needed |

That run priced with the quote alone. Since the second review pass (R309-2P-2) the node's answer no longer wins
alone: the page always makes its access-list computation too and suggests the **larger** of the two inside the 15 gwei
bound, and sends nothing when the node asks more than twice the page's figure or charges slots the page cannot find.
For the calls above the suggestion is therefore the access-list figure of the second table again (1.15 to 1.47 times
the node's requirement, and one slot for the skim); the quote only raises it, when the operator's slot price is above
the network file's. For an account with no balance at all the quote answers an error (`sender balance 0 is below gas
limit … pass a smaller gas`) and the page's own figure stands alone. The launch gateway does not know the method; the
gateway of the L2 candidate line routes it (bloch-l2-evm `3d4cfd6`, agents/R15-CROSS-AREA.md 2026-11-11 02:05 UTC:
"the candidate gateway routes it to the sequencer first and counts it as a simulation"; not exercised here).

Two values of `deployments/mainnet/frontend.network.json` are pinned to the L2 settler's policy and must move
**before** the settler's, with a page release (review R309-3P-1, 3P-4): `newSlotFee.freshSlotPriceWei` (a settler
price above twice the file's makes the page refuse first approvals and first swaps: it sends nothing when the node
asks more than twice its own figure) and the `l2Idle` block, which mirrors the settler's
`/etc/bloch-l2-mainnet-settler/config.json` (launch kit `install-settler-mainnet.py`):

| Network file | Settler | Used for |
|---|---|---|
| `l2Idle.skipIdleBlocks` (true) | `skip_idle_blocks` (`--skip-idle-blocks`) | true: a block only when there is work, plus the heartbeat; false: a block every cycle, no heartbeat |
| `l2Idle.heartbeatSeconds` (86400) | `max_idle_seconds` (`--max-idle-seconds`; 86,400 is the installer's default, the value is the operator's) | a swap is refused only when the device clock is ahead of the latest block by more than this plus 2 h (with idle blocks not skipped: one block interval plus 2 h) |
| `l2Idle.blockIntervalSeconds` (1800) | the larger of `min_block_interval_seconds` and the measured build-and-prove time of a block (agent 315's settled run, 2026-11-11: 69 real proofs of 278.6 to 522.2 s, median 347.5 s, one block per burst every 6 to 8 minutes on a shared host; 1,800 covers the slowest more than three times) | on an idle chain the first swap lands in the block after the next: the deadline is raised to two intervals plus half an interval (75 minutes) and the page names the wait |

Measured by agent 315 on the settled stack: after the start the first block was empty ("idle-end") and the 14
deposits were in the second, accepted 6 min 13 s later, which is the behaviour the two-interval deadline is built
for. Not measured: the same for a swap sent after a pause of more than 30 minutes (block number relative to the
first block after the pause, and its time after sending); that run's settler made an idle block every 1,920 s
(`max_idle_seconds` 1920 as the rig's heartbeat, not the mainnet's 86,400).

A file heartbeat below the settler's closes the page on a quiet chain; a file interval below the real one lets a
swap sent on an idle chain revert `EXPIRED`. Compare the three before opening (go-live checklist).

**The candidate's credit rule** (fourth run, 2026-11-13 UTC, 45.77.142.123). The L2 candidate `1b55ce1` adds a
per-sender credit rule (docs/audit/KNOWN-ISSUES.md section 13). Binaries copied from agent 312's build of `1b55ce1`
(settled-rpc `f2f6255b…`, produce-dev `628cb7d8…`), admission policy file version 2 (`max_tx_gas` 5,000,000,
`uncovered_max_gas` 1,500,000, empty ledger), same rig, bridge freeze `b5c5763`. The six calls of the tables above
behaved as before (first approve: page 4,997,160,705 wei per gas, node 4,336,043,361, admitted at the first request).
The credit cases, 15 of 15:

| Case | Result |
|---|---|
| First swap of four fresh wallets at the gas limits of 1, 2, 3 and 4 hops (250,000 to 1,000,000; one-hop route, 142,265 to 142,277 gas used) | quote `executable: true, covered: false`; admitted with the page's fees at the first request; mined |
| The same call at 1,750,000 gas from a wallet without credit | quote `needs-credit`; the page sends nothing and says "its gas limit of 1750000 is above the 1500000 the L2 allows such a wallet for one call. A higher fee does not help. What helps: a smaller route (fewer hops), or one earlier transaction from this wallet … (one plain transfer with a priority fee of 128856620167 wei per gas earns enough in one step)"; `eth_sendRawTransaction` refuses `sequencer-needs-credit`; nothing queued |
| At 6,000,000 gas | quote `gas-limit-above-cap`; the page sends nothing ("above the L2's maximum of 5000000 for one transaction. A higher fee does not help. Use a smaller route"); the RPC refuses `sequencer-gas-limit-above-cap` |
| The plain transfer at the fee the page named | admitted and mined; it paid 2,705,989,023,507,000 wei in tips, the quote had asked 2,459,990,020,250,000 |
| The 1,750,000-gas call after it | with the tips paid written into the policy file's ledger **by the check** (this rig has no settler), the quote said `covered: true`; the published tip had moved meanwhile, the page found the credit short of its own tip and named one more transfer (43,648,562,833 wei per gas); after it the call was admitted with the page's fees and mined |

Measured: the RPC's verdicts, refusals and the page's texts against the real `1b55ce1` binary. Modelled: the settler's
credit ledger (written by hand), a route of more than one hop (the launch plan has one pool; the router's gas for 2
to 4 hops is measured in `test/RouteGas.t.sol`), full blocks, and the `first_transfer_priority_fee_wei` field of
`28b74c4`/`e8f40c2` (browser harness model only). Evidence: `agents/313-evidence/credit-1b55ce1/`.

Not shown by this check: a browser and a wallet (the fees are signed by the script, as a wallet that honours the
page's suggestion would), the public gateway, inclusion under load, and real finality.

```
REQUIRED_TIP_FILE=<sequencer-policy.json> PRODUCE_DEV=<candidate produce-dev> SETTLED_RPC=<candidate settled-rpc> scripts/staging/private-l2.sh start <work>/l2 <port>
```

```
node scripts/staging/newslot-rpc-check.mjs --rpc http://127.0.0.1:<port> --gate <work>/flow/evidence/gate.json --funder-key-file <file with the rig's issuer key> --out <result.json>
```
