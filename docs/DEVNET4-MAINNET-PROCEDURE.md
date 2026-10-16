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
- wGnB. The devnet4 wGnB (`0xC756139C813aeE5b7a1D640d6265c09443E56812`) has
  no `bucketCapacity()` (the call reverts) and supply 0. The config allows any
  cap and pair list, so this rehearsal capped WBLCH and bUSDC and planned one
  pair. The mainnet wGnB token must expose `bucketCapacity()`.
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
6. **wGnB (D17).** The devnet4 wGnB has no `bucketCapacity()`. A mainnet wGnB
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
