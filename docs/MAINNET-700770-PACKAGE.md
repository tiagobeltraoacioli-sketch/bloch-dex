# Bloch L2 mainnet (chain 700770): DEX deployment package

Branch `codex/dex-mainnet-700770-20261030`. It contains the readiness,
devnet4 main-procedure and Safe/frontend branches (all three were already
ancestors of `feat/dex-safe-frontend-20261016`) and the audit fix DEX-01
(`d6c8b04`, `72b3cb2`). Nothing here has been deployed. The L2 mainnet has
never settled a block, and its head is still the genesis `0x632e45ae…f468`.

## Contents

| File | Role |
|---|---|
| `deployments/mainnet/700770/pins.json` | Chain ID 700770; L2 genesis `0x632e45ae778da371a88dc1ae430193aa77eabb67a11de18e84fea7d20d11f468` (state root `0x2ad7e807…c05d`); rules domain and genesis time; L1 timing and network pin; v2 release binary hashes; Safe v1.4.1 npm integrity and runtime code hashes |
| `deployments/mainnet/700770/safe.config.json` | Bloch Inc Safe: SafeL2 v1.4.1, 3 of 5, salt nonce 0. `bootstrap.address` and the five owners are `TBD-owner` |
| `deployments/mainnet/dex-mainnet.config.json` | DEX: genesis pinned; caps; the pilot pair WBLCH/bUSDC. `source.revision` is `bbd5ab0`, the commit with the DEX-01 fix and this tooling; later commits change no contract (check with `git diff bbd5ab0 -- contracts foundry.toml`). `deployer.address`, `blochInc`, and the bUSDC `token`/`codeHash` are `TBD-owner` |
| `scripts/staging/deploy-safe.mjs` (+ `safe-deploy-config.mjs`) | `validate`, `pending`, `plan`, `preflight`, `txs`, `blochinc` |
| `scripts/staging/deploy-dex.mjs` | Existing `validate`/`plan`/`run`/`record`, plus `pending`, `preflight`, `txs` and `record --tx-hashes` |
| `scripts/staging/sign-and-publish.sh` | Signs each planned transaction offline with `cast mktx` (explicit nonce, gas limit and fees; `--ledger` or any cast signer), publishes it with `cast publish`, and waits for the receipt |
| `scripts/staging/verify-deployment.mjs` | Post-deployment verification (details below) |
| `scripts/staging/check-finality-gate-mainnet.mjs` | The schema-2 finality gate, with chain 700770, the genesis and the reviewed Safe plan pinned by the repository |
| `scripts/staging/private-l2.sh`, `scripts/staging/rehearse-mainnet-package.sh` | Full dry run on anvil (chain 700770) or on a private L2 built from the v2 binaries at the real genesis |

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

Gas limits are about 1.5 times the measured gas. The same values were measured
on anvil and on the private L2:

| Step | Gas used | Limit |
|---|---|---|
| SafeL2 singleton | 5,321,999 | 8,000,000 |
| SafeProxyFactory | 711,231 | 1,100,000 |
| CompatibilityFallbackHandler | 1,267,726 | 1,900,000 |
| createProxyWithNonce (3 of 5) | 352,788 | 550,000 |
| WBLCH | 612,333 | 1,000,000 |
| Factory (2 caps) | 2,456,799 | 3,700,000 |
| Router | 4,074,147 | 6,200,000 |
| Lens | 1,938,483 | 3,000,000 |
| createPair | 2,135,685 | 3,300,000 |

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
  bucket, the cap stops the dump at `cap − reserve`.
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
- **Factory state:** `INIT_CODE_PAIR_HASH` (`0xe41e81db…b248` at this
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

1. Safe: config, plan, preflight, txs, a refused wrong `--confirm`, then sign
   and publish.
2. bUSDC test token with `bucketCapacity()`.
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
   - the protocol fee reaches the Safe;
   - the Safe redeems it with `execTransaction`, after 2 of 5 signatures are
     refused and with 3 of 5 accepted.

The two runs differ as follows:

- **anvil, chain 700770:** the mainnet gate wrapper refuses the run, because
  anvil's genesis is not the pin. The generic gate passes through the anvil
  finality shim.
- **private L2:** it uses the v2 `bloch-l2-produce-dev` `7c1cc62b…` and
  `bloch-l2-settled-rpc` `4fc9fa1e…` with `--rules mainnet` and the
  ceremony's domain and genesis time. Its genesis is the real
  `0x632e45ae…f468`, so the mainnet gate wrapper itself passes.
  - Block 1 mints synthetic deposits to the throwaway keys.
  - A producer loop includes the spooled transactions.
  - Finality is a synthetic follower status (schema v2) written by
    `private-l2.sh finalize`.

  It proves the tooling against the real RPC binary and genesis. It does not
  prove L1 settlement.

The run results are in the agent report
(`~/Desktop/BLOCH-L2-DEX-BRIDGE-20261030/agents/15-dex-deploy.md`).

## Mainnet sequence (owner)

Preconditions:

- the L2 is live and settled;
- your own follower and settled RPC replay from the pinned genesis;
- the bUSDC bridge is deployed;
- every `TBD-owner` is filled.

The sequence:

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
7. Run `verify-deployment.mjs --expect-empty`.
8. After L1 finality, run `check-finality-gate-mainnet.mjs`. Only
   `liquidity-enabled` allows the seeding ceremony (≤ 50% of the tighter
   cap).

Stop at any refusal. If a broadcast lands only partly, do not finish it by
hand: re-plan from the current nonce.
