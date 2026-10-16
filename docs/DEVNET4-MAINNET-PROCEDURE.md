# Mainnet DEX procedure, run live on devnet4 (2026-10-16)

The runbook in [MAINNET-READINESS.md §6](MAINNET-READINESS.md#6-runbook-deploy-on-the-l2-mainnet-once-it-is-live)
was executed against the Bloch L2 devnet4 (chain 700771, zero value, rehearsal
mode). The counter-asset was the real bridged bUSDC, not a mock. After the gate,
a pilot liquidity ceremony ran: a seed, swaps in both directions, a deposit
that mints the protocol fee, and the fee redemption by Bloch Inc.

- **Driver:** `scripts/devnet4/rehearse-mainnet-procedure.sh`. It is resumable;
  the state is kept in a work directory on the host.
- **Revision:** `source.revision` = `5d46244dd73e79e295384e9de0a7f158b7e82eea`
  (the contracts are unchanged since `4046ebb`).
- **Toolchain:** Foundry 1.7.1, Node 24.
- **RPC:** the settled RPC `127.0.0.1:18945` on host 45.77.142.123, used
  directly with no compatibility shim.
- **Recorded artifacts** are in `deployments/devnet4/mainnet-procedure-20261016/`:
  - `config.json` and `plan.json`;
  - `finality-gate.json` (schema 2) and `gate-report.json`;
  - `gate.early.txt` and `gate.early.finality.json`;
  - the two refusal outputs and the runtime-hash check;
  - `txs.tsv` (every transaction), `report.txt` and `progress.log`.

**Bloch Inc stand-in.** Bloch Inc is played by `test/mocks/RehearsalMultisig.sol`,
a test-only 2-of-3 multisig deployed by the funder. On mainnet it is replaced by
the Safe v1.4.1 (3-of-5, hardware-wallet owners).

**Out of scope:**
- The GnB-SMH token. The devnet4 token then deployed for it, named wGnB on
  chain (`0xC756139C813aeE5b7a1D640d6265c09443E56812`, deployed 2026-10-14 and
  since superseded by wGSMH `0xB2B4952b6E57e589109aF764859886e236798AD4`), has
  no `bucketCapacity()` (the call reverts) and supply 0. The config allows any
  cap and pair list, so this rehearsal capped WBLCH and bUSDC and planned one
  pair. The mainnet wGSMH token must expose `bucketCapacity()`.
- An over-cap deposit. Reaching the cap needs 10 BLCH or 1,000 bUSDC; it is
  proven on anvil by `scripts/staging/rehearse-deploy-anvil.sh`.

## Accounts

| Role | Address | Notes |
|---|---|---|
| Deployer (fresh key, nonce 0) | `0x18ab18d38110751fb540c5cbc9d520b9486c2ebe` | Funded with 0.1 BLCH gas only. Ended at nonce 5, holding nothing but 0.096721059384781058 BLCH |
| Bloch Inc (RehearsalMultisig 2-of-3, TEST ONLY) | `0x92b249fedcbfa52d6e0e973a23f1a2b5690d8c13` | Runtime code hash `0xb752e0c5…683b`, threshold 2 |
| Owner A | `0x9af5b5db50b520a5243927f55fcfa1b3b81efe47` | 0.005 BLCH gas |
| Owner B | `0x27ebe9b4999dcd825cd187c233d25be99b550edc` | 0.005 BLCH gas |
| Owner C | `0x5531d58cc6834d33ddbbff231f2e856cd34ef8a9` | Unfunded; never signed |
| Funder | `0xa3cfcb09a9fcf3cd1c98b5b2ecc1d676f8144c7d` | Devnet operator key (nonces 13–16) |
| Liquidity provider / trader | `0x72dc623d4c03c996a3d20ed2674f24570e8acf44` | L2 dev account (nonces 31–39) |

**Key handling.** All keys are encrypted keystores in the work directory:
- directory mode 0700, a random password file with mode 0600;
- no key was printed;
- the raw dev key copy was shredded after import.

## Deployment

**Config SHA-256:** `0x029893ff8f411365a4fcbec9b26e9c7c456778209528d0b2ae37043b51774482`.

**Network block:** `{name: "bloch-l2-devnet4-rehearsal", chainId: 700771, rehearsal: true}`, genesis `0xaec98443…fefa`.

**Caps:**

| Token | Cap | Bucket | Code hash |
|---|---|---|---|
| WBLCH | 10 BLCH (`10000000000000000000`) | n/a | n/a |
| bUSDC `0x1b7c0fb59f34683cd9214566636e63a0f7e092f6` | 1,000 bUSDC (`1000000000`) | `bucketCapacity()` = `10000000000` | `0x3ee441a1…281b` |

**Refusals:**

| Check | Result |
|---|---|
| `validate` without `--rehearsal` | `deploy config: chain 700771 is a development network: set network.rehearsal and pass --rehearsal` |
| `run --broadcast` without `--confirm` | `deploy-dex: --broadcast needs --confirm 0x029893ff…4482` |

**Dry run.** The preflight passed: chain ID, genesis, nonce 0/0, empty planned
addresses, Bloch Inc code hash, bUSDC code hash and bucket. Forge then
simulated the deployment:
- 14,751,853 gas estimated;
- 0.00723 BLCH estimated at 0.49 gwei;
- the deployer nonce stayed 0.

**Broadcast.** Command:
`run --broadcast --confirm … -- --keystore … --password-file … --timeout 1800`.
- It used the driver's `--slow`: one transaction per L2 block.
- It started at 00:45:54Z; `record` ran at 01:45:29Z.

| Nonce | Action | Address | Tx | Block | Gas used | Price (wei) |
|---|---|---|---|---|---|---|
| 0 | deploy WBLCH | `0xde215b8672fb89692c89b9f5b75d09d4f6e3c2be` | `0xa6823a4d51fef9ab1bfea3a7f904be1f1534ddb474027b8b5dbb6f04e09554cc` | 410 | 612,333 | 293,812,284 |
| 1 | deploy factory (feeTo = Bloch Inc, caps) | `0x213cbb5d00c81eb5c031eebb1467791854423086` | `0x04cf0566b8b29e42eb7b95bd1e19e98c9c661ac555b45581f45e3d8482209a82` | 411 | 2,456,799 | 293,070,270 |
| 2 | deploy router | `0x96f24516c982cc50f2f58a50df9d5754ea8eee9f` | `0x68ca6599f5bdf8b6c430927d7cedbe0d8bf48171079cebfe5f9afbd3e7f73e8b` | 412 | 4,074,135 | 292,423,143 |
| 3 | deploy lens | `0xfdadb1c91f3b3df690d56fff6f0b7c5887c936e5` | `0xb77acdddd73fecd91d33cdadc72d99c1c2c43b48731b9c0afa3b839c749ddd58` | 413 | 1,938,471 | 291,858,650 |
| 4 | createPair WBLCH/bUSDC | `0xe437dfcb73c711a9511ced3660e5d38218213439` | `0x20ae868ab93ce2c55b08f6dd64f13eccb087ba1b7acb312e1ba57f8876b70fd8` | 414 | 2,135,695 | 291,185,783 |

**Totals.** 11,217,433 gas, costing the deployer 0.003278940615218942 BLCH.

**Record.** `record` verified every transaction from the receipts:
- sender, nonce and status;
- init code;
- the created address.

The runtime code hashes on chain equal the plan for WBLCH, the factory, the
router, the lens and the pair. The pair init code hash is
`0x2249ef38f618407ce9328e89491648a4e8ad4b234e70a538ef9d2096b1ceb820`, which
is unchanged.

The pair's `token0` is bUSDC and `token1` is WBLCH. Its `reserveCaps()` are
(1,000,000,000; 10,000,000,000,000,000,000).

## Finality gate

**Before finality: refused** (2026-10-16T01:45:30Z):
`finality gate: transaction 0xb77acddd…dd58 is not finalized`.
- `bloch_finality` at that time reported `finalized` 412 (0x19c), safe 413
  and latest 414.
- The trust model was native FFG replay from the pinned genesis.
- L1 finalized epoch was 4276.

**After finality: `liquidity-enabled`** (2026-10-16T02:03:31Z), once the
finalized block reached 414
(`0xccf96aa827401bbbc65b29e167b14d6fcc9542f82e2f370be8f5a6c5d035aaec`).
- `feeTo` = `0x92b249fe…8c13`;
- `wrappedReserveCap` = 10 BLCH;
- the five deployment transactions are finalized and canonical;
- the full report is in `gate-report.json`.

**Fee recipient cannot change.** Two checks:
- `factory.feeTo()` reads back as Bloch Inc;
- an `eth_call` of `setFeeTo(address)` from the deployer reverts, because the
  function does not exist.

## Pilot liquidity, swaps, protocol fee

All transactions were sent by the dev account, except the multisig confirmations.

| Step | Tx | Block | Gas used | Pair event (bUSDC base units / WBLCH wei) |
|---|---|---|---|---|
| approve router (100 bUSDC) | `0xafdddb22a14726dc37a94b552d23ca22c2df603d13d5319e8f67e9f51222d8c6` | 416 | 46,184 | n/a |
| seed `addLiquidityBLCH` 10 bUSDC + 0.5 BLCH | `0x6f7f6193a6f975b7c8e1c2750ecd56763e501d9350e26142c3c03bffbfa99be7` | 416 | 287,069 | Mint 10,000,000 / 500,000,000,000,000,000; LP 2,236,067,976,499 to dev (+1,000 locked) |
| swap 2.5 bUSDC → BLCH | `0xbdd07a4c289c39dd904db58ccb45d6380246ae977ba4343b2af9ea05cdcc26f7` | 417 | 173,178 | in 2,500,000, out 99,759,855,913,548,128 |
| swap 0.125 BLCH → bUSDC | `0x0d2008e318a3fa58c5e6003d47edd3da99ca8ef8c2c38d49e2d7e20150b1259b` | 417 | 110,992 | in 125,000,000,000,000,000, out 2,968,024 |
| swap 2.5 bUSDC → BLCH | `0x6748e5aeac877648259d9de9e1476838da77327d71e72b5a4dce56c6c533691e` | 417 | 136,492 | out 108,874,686,858,328,071 |
| swap 0.125 BLCH → bUSDC | `0x365b55e1946ef6cf07e04f81950d578d7f4ce05a2297d36f7cc6db8d28df6382` | 417 | 110,992 | out 2,771,740 |
| swap 2.5 bUSDC → BLCH | `0xc4a47cfc59ed8cf8d1e81c68143030b9be0c9cc2d072aa8874b0bfab7563151d` | 417 | 136,492 | out 114,811,853,354,069,943 |
| swap 0.125 BLCH → bUSDC | `0x069ce15f45e88df47d7f9f3c0c3166865934f575b06c59025d9f7bf1faf0410b` | 417 | 110,992 | out 2,659,064 |
| top-up `addLiquidityBLCH` (fee mint) | `0xf6a17403a0d97090fc5ad4699323ae3b8e07a7a23af5d0fbb9ebe4f9a3da745b` | 417 | 180,424 | Mint 990,058 / 60,000,000,000,000,000; **735,375,076 LP to Bloch Inc**; 243,327,458,666 LP to dev |
| owner A confirms `pair.transfer(pair, fee)` | `0x8cc6782a38a2458522de1c2a183a74eb2aa2ffe7f1f2ef6426c4621bb511901b` | 418 | 72,758 | n/a |
| owner B confirms, executes the transfer | `0xf299e3235b1cf240a611e3d312154e92eb62d3ea6212ee005ae869512dde0228` | 418 | 103,841 | n/a |
| owner B confirms `pair.burn(BlochInc)` | `0xc8b419e397484e107aefd0e7b8858477121bd8ebcd9e01a29be4242c0c94ea26` | 419 | 72,570 | n/a |
| owner A confirms, executes the burn | `0xddf42d8d5af7faefa3c83acaa55e058259af3607c94d46739a5db236c90b8686` | 419 | 204,541 | Burn 2,992 / 181,329,660,471,387 to Bloch Inc |

**Seed against the caps.** The seed was 50% of neither cap: 0.5 of 10 BLCH and
10 of 1,000 bUSDC. That is 5% and 1% of the caps, well within the ≤ 50% rule.

**Redemption order.** The multisig's confirmation id includes its nonce, so the
burn was confirmed in the block after the transfer executed. A Safe would batch
both calls in one MultiSend transaction.

**Protocol fee.** Bloch Inc received 735,375,076 LP, which is 0.0297% of the
supply of 2,480,130,811,241. It redeemed them for:
- 2,992 bUSDC base units (0.002992 bUSDC);
- 181,329,660,471,387 WBLCH wei (0.000181 WBLCH).

The multisig holds both as tokens: the WBLCH was not unwrapped.

### State at 2026-10-16T02:44:31Z (latest 419, finalized 417)

**Pair `0xe437…3439`:**
- reserves: 10,088,238 bUSDC base units and 611,372,274,213,582,471 WBLCH wei
  (≈ 16.5 bUSDC per BLCH);
- `totalSupply` 2,479,395,436,165;
- `kLast` 6,167,669,008,867,882,800,076,098.

**Account balances:**

| Account | BLCH (wei) | bUSDC (base units) | Other |
|---|---|---|---|
| Dev account | 835,913,055,275,917,679 (was 1,447,840,545,501,617,244 at block 415) | 10,908,770 (was 21,000,000) | LP 2,479,395,435,165 |
| Bloch Inc | 0 | 2,992 | WBLCH 181,329,660,471,387; LP 0 |
| Deployer | 96,721,059,384,781,058 | 0 | no other holdings |
| Funder | 936,021,674,507,581,970 | 0 | n/a |

The dev account keeps its bUSDC (8.398828 bUSDC came from the swaps); none was
burned.

## Problems and observations

1. **Shim no longer needed (D4).**
   - Blocks from 18945 carry `sha3Uncles` and `nonce`.
   - Forge simulated, broadcast and recorded directly against the RPC, and cast
     read and sent directly.
   - `scripts/devnet4/rpc_compat_proxy.py` still runs on the host (pid
     1728279, started 2026-10-14, port 18946) and can be stopped by its owner.
2. **Wall-clock timestamps (D5/F3).** These are on devnet4 from block 228 on.
   Blocks ≤ 227 keep `timestamp = number`. Router deadlines were set far in the
   future, as on mainnet.
3. **`finalized` tag and `bloch_finality` (D13)** are served. The gate behaved
   as specified: it refused while the last deployment transactions were above
   the finalized block, then enabled liquidity about 18 min after `record`.
4. **Pending estimation (D16).**
   - `eth_estimateGas` at `pending` fails ("pending Bloch derivation is
     unavailable"); with no block tag it works.
   - Forge needed no change, because it uses its own simulation's gas and
     `--timeout 1800`, which the driver forwards.
   - Every cast transaction has an explicit `--gas-limit`.
   - The spool accepts consecutive nonces sent together: seven dev
     transactions were mined in block 417 in nonce order.
5. **Block cadence.** 10–20 min per L2 block. The `--slow` broadcast of five
   transactions took ~1 h, and the whole procedure ~2 h 10 min (00:36Z–02:44Z).
6. **wGSMH (D17).** The 2026-10-14 devnet4 token (named wGnB on chain,
   `0xC756…6812`) has no `bucketCapacity()`. A mainnet wGSMH
   without it cannot pass the preflight or the gate.
7. **Small fee at pilot size.** With pilot-size pools the protocol fee is small,
   as expected: 1/6 of the 0.3% fee on ~15 bUSDC-equivalent of volume.

## Rerun

```
RPC=http://127.0.0.1:18945 REVISION=<commit> FUNDER_KEY_FILE=<raw key> DEV_KEY_FILE=<raw key> \
  scripts/devnet4/rehearse-mainnet-procedure.sh <new work dir> all
```

A new work directory makes a new deployer and multisig. Steps already done are
skipped in an existing work directory.

# Second run: both pilot pairs, wGSMH and bUSDC (2026-10-16)

The same procedure ran again with a new work directory, so with a new deployer
and a new RehearsalMultisig. This time the caps and pairs match the mainnet
config exactly: WBLCH/wGSMH and WBLCH/bUSDC. wGSMH is the bridged GnB-SMH
token; the coin's ticker is now GSMH.

- **Driver:** `scripts/devnet4/rehearse-mainnet-procedure.sh` in two-pair mode
  (`WGSMH_TOKEN` set; owners left unfunded because no fee redemption was
  planned).
- **Revision:** `source.revision` = `212299c37ee779368cd23b8b8bffcee8b07d2f95`.
- **Records:** `deployments/devnet4/mainnet-procedure-2pairs-20261016/`.

## Accounts and tokens

| Role | Address |
|---|---|
| Deployer (fresh, funded 0.05 BLCH) | `0x00297df3a199fc93cb0b85e6310db6b5d731ab08` |
| Bloch Inc (RehearsalMultisig 2-of-3, TEST ONLY) | `0xa2977d9b7d5baba4f74496ed0b9dabe1c11a0de2` (code hash `0xb752e0c5…683b`) |
| Owners A/B/C (unfunded) | `0x5147805a4efe751052962a0eef45757f707daad3`, `0x8772959e835e1d6b5a1b405e59671e6fbd6ea914`, `0x9c16f6f458e1674496547dbba3b856399e865737` |
| Funder | `0xa3cfcb09a9fcf3cd1c98b5b2ecc1d676f8144c7d` (nonces 18–19) |
| bUSDC provider / trader (dev account) | `0x72dc623d4c03c996a3d20ed2674f24570e8acf44` |
| wGSMH holder / trader | `0x4630a5eb8d04401e610dd986b481a489410122d9` |

| Token | Address | Decimals | Code hash | `bucketCapacity()` | DEX cap |
|---|---|---|---|---|---|
| wGSMH | `0xb2b4952b6e57e589109af764859886e236798ad4` | 8 | `0xa7602699759ecff36f21ef98bcd31f8a2f3cd82b79ca742472978a6455c0a7d5` | 1,000,000,000 (10 wGSMH) | 100,000,000 (1 wGSMH) |
| bUSDC | `0x1b7c0fb59f34683cd9214566636e63a0f7e092f6` | 6 | `0x3ee441a1…281b` | 10,000,000,000 | 1,000,000,000 |
| WBLCH | deployed | 18 | n/a | n/a | 10 BLCH |

## Deployment

**Config SHA-256:** `0x01e662387d09ebbb7ec4c55cef0ac858b5a077bf10ede6c12f40685b0f81fd0b`.

**Refusals:** both refused, with the same messages as the first run.

**Dry run:** passed; the deployer nonce stayed 0.

**Broadcast:** `--slow`, from 04:27:32Z to 05:38:36Z.

| Nonce | Action | Address | Tx | Block | Gas used |
|---|---|---|---|---|---|
| 0 | deploy WBLCH | `0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6` | `0x363cb4a4a26e339dd99bcdcd64c440526872807691fd1a9cde5d364e98773a28` | 429 | 612,333 |
| 1 | deploy factory | `0x8cf37b0885cb0cfbbcbd08f08dfc45b201e195a8` | `0x5a86864d7eb40971f17a52f725bf5042da4f7a62d49f31d84fe093cfc5c55c34` | 430 | 2,481,605 |
| 2 | deploy router | `0xb3a451af23df72f72916064c6d33d1fbe25e7106` | `0x95bae1df767365a6c75a379f95005d4f43044fa6691932d21b14ad234fe47511` | 431 | 4,074,147 |
| 3 | deploy lens | `0xb97473777fcf1f4b5be453ba1661b70b191a75cd` | `0x150663d8b5ee2a050477d056bb4f543629d582d083931feba770b96a2cfaba8d` | 432 | 1,938,483 |
| 4 | createPair WBLCH/wGSMH | `0xd71fc81263ba585561ad4d784a4bc096739927b4` (token0 WBLCH) | `0x9bdf0cbaf0dfbf4ac787b04820f83793f28f16475148111e023972ee039b3666` | 433 | 2,135,685 |
| 5 | createPair WBLCH/bUSDC | `0xd98230d9a13cb72f6d75e3bf46c01415027c8033` (token0 bUSDC) | `0x87e41ec8ebe3d831580cb35239411d297cd327bd3d55b5f11169361fba215f63` | 434 | 2,118,595 |

**Totals:** 13,360,848 gas, costing the deployer 0.003722397454235779 BLCH.

**Checks after the broadcast:**
- `record` verified all six transactions;
- the runtime hashes on chain equal the plan for 4 contracts + 2 pairs;
- the pair init code hash is `0x2249ef38…b820`.

## Gate

- **Before finality (05:38:37Z): refused.** Message:
  `transaction 0x9bdf0cba…3666 is not finalized`; the finalized block was 432.
- **After finality (05:56:38Z): `liquidity-enabled`.** The finalized block was
  434 (`0x941c13cf4b2e1514e23ceab9d45d54904833fe897378991be10d822df536e584`),
  with `feeTo` = Bloch Inc.

## Seed (block 436) and multi-hop swaps (block 437)

**Seed prices:**
- WBLCH/bUSDC: 16.5 bUSDC per BLCH (5 bUSDC + 0.30303 BLCH). That is 0.5% of
  the bUSDC cap and 3% of the WBLCH cap.
- WBLCH/wGSMH: **0.2 BLCH per wGSMH** (0.5 wGSMH + 0.1 BLCH), about
  3.3 bUSDC per wGSMH at the bUSDC pool's price. That is 50% of the wGSMH cap.

| Step | Sender | Tx | Block | Gas | Pair events |
|---|---|---|---|---|---|
| approve router 6 bUSDC | dev | `0x851787dfacbfbb5b3d636b2e78a969982a4f77d80e2453f8f9b6dffa41d6c778` | 436 | 46,184 | n/a |
| seed WBLCH/bUSDC | dev | `0xb105c69a51c513a8046725dd6868af7ab0ddb7efd305fb1688a889c3c4fe8948` | 436 | 287,069 | Mint 5,000,000 bUSDC / 303,030,303,030,303,030 wei; LP 1,230,914,908,793 to dev |
| approve router 0.7 wGSMH | holder | `0xcc05b50cb4d79fc4fde00a37fa93b4f0c0cf0e7885e53b0b7ddadd904d73a1a5` | 436 | 46,196 | n/a |
| seed WBLCH/wGSMH | holder | `0xcb5806416a8e1d4f7db05d5b6b1c77502a76b9b9894805e7c356689e7f7f070f` | 436 | 271,977 | Mint 100,000,000,000,000,000 wei / 50,000,000 wGSMH; LP 2,236,067,976,499 to holder |
| bUSDC → WBLCH → wGSMH, output to the holder | dev | `0xe6d85dc51fc71e299cf5ac635a9cdcc481b613297459f79667aed756bc5def9a` | 437 | 153,362 | 1,000,000 bUSDC in → 59,362,979,558,981,716 WBLCH → **31,704,232 wGSMH out** |
| wGSMH → WBLCH → bUSDC | holder | `0x2be8a1d8830ee1d92beab16cd9bb231684d1b3c05da9412a791d9e9530ab2ae8` | 437 | 260,952 | 20,000,000 wGSMH in → 28,510,151,558,478,696 WBLCH → **428,785 bUSDC out** |

Both multi-hop swaps landed in block 437. The holder's reverse swap ran first
(transaction index 0) and the dev's forward swap second (index 1).

The reverse swap's low bUSDC output is slippage, not a fault. Selling
0.2 wGSMH into a 0.5 wGSMH pool (40% of the reserve) returned 0.0285 BLCH
against 0.04 BLCH at the mid price.

### State at 2026-10-16T06:13:42Z (latest 437, finalized 435)

**Pair reserves:**

| Pair | Reserves | `totalSupply` |
|---|---|---|
| WBLCH/wGSMH `0xd71f…27b4` | 130,852,828,000,503,020 WBLCH wei / 38,295,768 wGSMH | 2,236,067,977,499 |
| WBLCH/bUSDC `0xd982…8033` | 5,571,215 bUSDC / 272,177,475,029,800,010 WBLCH wei | 1,230,914,909,793 |

**Account balances:**

| Account | BLCH | bUSDC | wGSMH | LP |
|---|---|---|---|---|
| Holder `0x4630…22d9` | 0.198994080907690901 (was 0.299153674404339946) | 0.428785 | **1.61704232** (was 2) | 2,236,067,976,499 (WBLCH/wGSMH) |
| Dev `0x72dc…cf44` | 0.532748607685479154 (was 0.835913055275917679) | **4.908770** (was 10.908770) | 0 | 1,230,914,908,793 (WBLCH/bUSDC) |

**For the bridge exits:**
- the holder keeps ≥ 0.1 wGSMH for the wGSMH → GSMH exit;
- the dev account keeps ≥ 1 bUSDC for the bUSDC → Ethereum exit;
- nothing was burned.

**Funder:** ends at 0.585888546877079570 BLCH, nonce 20.

The two multi-hop paths run through the router across both pools. The wGSMH
token exposes `bucketCapacity()` and passed the preflight and the gate (D17).

# Third run: Bloch Inc as a real Safe v1.4.1, 3 of 5 (2026-10-16)

Runbook step 0 was done for real, then the procedure ran again with the DEX fee
recipient pinned to that Safe. Bloch Inc is the **official Safe v1.4.1**, not a
test multisig.

The new gate checks were exercised live:
- **Config:** the `blochInc.safe` pin.
- **Preflight:** at `latest`.
- **Schema-2 gate:** at the finalized block.

**Setup:**
- Driver: `scripts/devnet4/rehearse-mainnet-procedure.sh` in Safe mode (`BLOCH_INC_MODE=safe`).
- Revision: `fb914d4542765479a9ee74b14f46fd518f98f44d`.
- Records: `deployments/devnet4/mainnet-procedure-safe-20261016/` (including
  `safe.json` and `safe.fee.txt`).

## Step 0: the Safe

**Bytecode.** It is the build shipped in the npm package
`@safe-global/safe-contracts@1.4.1` (tarball sha256
`8803f7cf26e2c58300b8136342faa7b8bce59436e300f52115fa25b095e0bf79`). Before
sending, the script checks that each runtime hash equals the canonical
`codeHash` in `@safe-global/safe-deployments` (src/assets/v1.4.1). It checks
again on chain after deployment.

**Fallback path.** There is no Safe singleton factory on chain 700771, so:
1. A fresh bootstrap key (`0x4cf4511b16b1ef0fe0a450667f86d74d66642b0f`) was
   funded with 0.03 BLCH (tx `0x7d1b5c32…8058`, block 462).
2. It deployed the three contracts by CREATE.
3. It created the proxy with `createProxyWithNonce`.

All four transactions landed in block 463:

| Contract | Address | Runtime code hash (= canonical v1.4.1) | Tx | Gas |
|---|---|---|---|---|
| SafeL2 singleton | `0xa4c5b945978f770588b6ecb45f2468bec1ba8430` | `0xb1f92697…81ff` | `0x394a61da84bb8333ea8f4c6a0d79680ab61d670482eed8969de4a1193c239bfd` | 5,321,999 |
| SafeProxyFactory | `0x343a2a8aa3be8bb089d0119060b4261638b0a664` | `0x50c3cdc4…3317` | `0x13348ae6093cc77003c9dcd2d2988c3177cc5475a4adf4af5111a301783a8c33` | 711,231 |
| CompatibilityFallbackHandler | `0x6b021610fad4921cd4c4ff46e54d7d7d506a0274` | `0x7c6007a5…42f9` | `0x8d1c2be1f9dcb64eca24377af7668a8c6efefc36c2e64f6aa69134527f554894` | 1,267,726 |
| **Bloch Inc Safe** (proxy, `createProxyWithNonce`, salt 20261016) | `0xc4bee72f3f47e855a0e88356f8f7074631a12031` | `0xd7d408eb…fb4c` | `0xefc49a445b276c8a44687ddefe74967d348801a8f9853542a4891ec973c638d7` | 352,836 |

The four transactions used 7,653,792 gas, which cost the bootstrap key
0.003985267 BLCH. The bootstrap key holds nothing else.

**Owners.** The Safe is **3 of 5**. Five fresh keys stand in for the hardware
wallets:
- `0x1e76c29c10705d1809afa40dd6aeac0bb49aa3f3`
- `0x38c310f30f578968cb9c9e1347f5d152c00fd529`
- `0x4ae37a4d469c72590e580ab3e42623413bc5bd4c`
- `0x9639be8c5464536bcc59d9e48233ae7b07fcb0f8`
- `0xc6c2e5fd23d8b40329d60eb2c8bd918dfb3fd698`

**Checks on chain after deployment** (all passed):
- slot 0 is the singleton;
- the fallback-handler slot is the handler;
- the guard slot is 0;
- `getModulesPaginated` returns no module;
- `getThreshold()` is 3;
- `getOwners()` is the set above;
- `VERSION()` is 1.4.1.

## DEX deployment with feeTo = the Safe

**Config:**
- SHA-256 `0x8ea4bd774d26f58827b2a0b41090889da455e38e8976b156b3e842be96e79828`;
- `blochInc` = the Safe, with its `safe` pin;
- both pilot pairs as in the mainnet config.

**Refusals and dry run.** The refusals behaved as before. The dry run and
broadcast preflights verified the Safe pin at `latest`.

**Broadcast.** Deployer `0xa9ad7020f7351e990d43c2cec393440c8be72809`, from
11:15Z to 12:28Z:

| Nonce | Action | Address | Tx | Block | Gas |
|---|---|---|---|---|---|
| 0 | deploy WBLCH | `0x4a644af569f211ac1b845f2afabffb49eb29d82c` | `0x9379d168947b30e62f5587fc113e237a79cb2bc853c4a6ecf1a3a4f8c0095f85` | 465 | 612,333 |
| 1 | deploy factory (feeTo = Safe) | `0x58b91f9e32207ea61efa30212b5f721e7b15ac86` | `0x0a3e5f699d067a9194df787b6bdb5d471d3a9ce15ee142f3d28225e33331b858` | 466 | 2,481,605 |
| 2 | deploy router | `0xd22f09fd791870733b2d6fd4c399f93796546fc0` | `0xe094a65e2a5e6e52eb45b153316a076d07ece972186e368b24623fb2efdc5900` | 467 | 4,074,147 |
| 3 | deploy lens | `0x412b79fead3c35ad1b89b5744f0040f97c05063c` | `0x0b7d854a0d7dc3cffc1b940a738056b6d52bea94277e1f4395fe65bf212eb192` | 468 | 1,938,483 |
| 4 | createPair WBLCH/wGSMH | `0x446b80d4a8a7fc49647e537bc706172ad10b50f4` | `0xfedb3eb425bf8655a9fd3e4ba7641a2a8a52e3dbefab995b116b36ef631da1a3` | 469 | 2,135,685 |
| 5 | createPair WBLCH/bUSDC | `0xd662252c89e6a0f62e0bd6500f45e319caac7fe3` | `0x20c0d83ccedd6631a45d225c423bc3892d4cbf2d6c6d4271d4fb856c8f45016e` | 470 | 2,118,595 |

**Totals:** 13,360,848 gas, costing the deployer 0.006926075 BLCH at
~0.52 gwei.

**Gate:**
- **Before finality (12:28:57Z): refused.** Message:
  `transaction 0xfedb3eb4…a1a3 is not finalized`.
- **After finality (12:46:58Z): `liquidity-enabled`** at finalized block 470
  (`0x361b4c30…887f`). The report includes
  `blochIncSafe: {address 0xc4be…2031, threshold 3, owners (5), singleton 0xa4c5…8430}`.

## Pilot liquidity and protocol fee

| Step | Sender | Tx | Block | Gas | Result |
|---|---|---|---|---|---|
| approve + seed WBLCH/bUSDC | dev | `0xef308ac7…3e2b`, `0x94ff480e771ab2fc29af5c1f7fc28eb82020b8a021561eb530ad5ad1512cac07` | 472 | 46,184 + 286,316 | 1 bUSDC + 0.060606 BLCH (16.5 bUSDC/BLCH) |
| approve + seed WBLCH/wGSMH | holder | `0xf2c84cef…8989`, `0x19093692190d7ad0934082f6616e02c4d9cf5c1cffa8a380377e22b110e06c6e` | 472 | 46,184 + 266,400 | 0.05 wGSMH + 0.01 BLCH (0.2 BLCH/wGSMH) |
| swap 0.3 bUSDC → BLCH | dev | `0xe486049e5e2ae268910aafc19aef04ec1dd4440474ab7bd49c31b93a1f681f6a` | 473 | 173,178 | out 0.013953716209123798 BLCH |
| swap 0.02 BLCH → bUSDC | dev | `0xd9abadbeb5fcd15a680500b9608226f2b4f39a09a2bf2a093f9049c3db2f44ed` | 473 | 110,992 | out 0.389263 bUSDC |
| top-up (fee mint) | dev | `0x93aee65d989ba22936f2d7eb2f925db41deb9f62756a7ab67b42ef5b2c8d713b` | 473 | 180,865 | Mint 0.1 bUSDC / 0.007318506 WBLCH; **32,696,833 LP to the Safe** |

**Redemption by the Safe.** Both calls are `execTransaction` with **3 of 5**
signatures. The signatures are packed in ascending owner order (65 bytes each,
`v` 27/28, over the EIP-712 Safe transaction hash). The signers were:
- `0x1e76…a3f3`
- `0x4ae3…bd4c`
- `0xc6c2…d698`

The funder (`0xa3cf…4c7d`) submitted both calls, so the owners never needed
gas.

**Two signatures refused.** First, an `eth_call` of the same transfer with only
two signatures reverted with **`GS020`**.

| Safe nonce | Call | safeTxHash | Tx | Block | Gas |
|---|---|---|---|---|---|
| 0 | `pair.transfer(pair, 32696833)` | `0x4fc55b57c2a15e8c99a183e4187f860e29f0fd2373b801443d2176601a83c5a8` | `0x5216ed4972536bc338993dcbd37ed0d28954e3231d1a1b9f85a31cf77cf59f5f` | 474 | 118,733 |
| 1 | `pair.burn(Safe)` | `0x4e5134ead3caf971fe84dd8c06a911b936a1814ad5305b68c8ff3a2eb040e4fc` | `0x3323f0da1996fc13166da4687d9472a1db1eae2245f8edc57e2affbc3b76bff6` | 474 | 217,095 |

**Result.** Both transactions emitted `ExecutionSuccess`, and the Safe nonce is
now 2. The Safe now holds **120 bUSDC base units + 8,851,266,436,457 WBLCH wei**.
Its fee LP balance is 0.

Unlike the test multisig, a Safe signs over an explicit nonce. Both
transactions were therefore signed in advance and mined in the same block.

### State at 2026-10-16T13:17:24Z (latest 474, finalized 472)

**Pair reserves:**

| Pair | Reserves |
|---|---|
| WBLCH/wGSMH | 0.01 WBLCH / 0.05 wGSMH |
| WBLCH/bUSDC | 1.010617 bUSDC / 0.073961999394870504 WBLCH |

**Account balances:**

| Account | bUSDC | wGSMH | BLCH | LP |
|---|---|---|---|---|
| Dev | 3.898033 | n/a | 0.458366 | 273,217,753,761 (bUSDC pair) |
| Holder | 0.428785 | 0.25 | 0.188809 | 223,606,796,749 (wGSMH pair) |

The funder ends at 0.505694 BLCH, nonce 24.

The earlier two-pair deployment (second run) is unchanged.
