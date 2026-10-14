# Devnet4 DEX rehearsal (Bloch L2, chain 700771), 2026-10-14

Zero-value development network on host 45.77.142.123. L2 RPC 127.0.0.1:18945. One L2 block per
settlement proof (~9 min). The L2 block timestamp advances by one per block, so router deadlines are
in L2-block units.

## What ran

`script/Devnet4Rehearsal.s.sol` (commit `a17dea5`, reserve caps), broadcast with Foundry 1.7.1 through
`scripts/devnet4/rpc_compat_proxy.py`. The settled RPC omits `sha3Uncles`/`nonce` from block objects
and forge refuses blocks without them; the shim fills only those two constant fields.

- Operator: `0xa3cfCb09a9fCf3cd1c98b5B2eCc1d676f8144c7d`, a development key funded with 2.5 BLCH from
  the ensaio account by tx `0x2f873cb748d05674486537bc20b39023442c7d4461b2405c9915bf04b41b2102`
  (block 213, status 1).
- Parameters:
  - seed 1 BLCH + 1,000,000 D4TEST;
  - swap 0.1 BLCH → D4TEST, then half of the output back to BLCH;
  - WBLCH reserve cap 1.2 BLCH, fixed in the factory constructor.
- Forge estimate 18.1M gas, ~0.0154 BLCH. All 10 transactions were sent at once with nonces 0–9. The
  producer put 7 in block 214 and deferred 3 to block 215, with none dropped.

## Addresses

| Contract | Address |
|---|---|
| WBLCH | `0xaF9209A96c0883D5E23BABe7eb974CffcB22fF7f` |
| D4TEST (BlochAsset, 18 dec, 10,000,000 supply) | `0x36329948f90c3d4347064715771FC67149a83084` |
| UniswapV2Factory | `0x23cf9753847D098ef23D012608d4D9186EA26Ea4` |
| BDexRouter | `0xF135ed1F03581e6c402737609882f13c4Aac3CF8` |
| BDexLens | `0x691F655464bdbb2f835842A9fe1da8878F9256A8` |
| TreasuryFeeCollector | `0xabfE748dbD4353B97b8FE900470d141Ad1d300b6` |
| Pair D4TEST/WBLCH | `0xaDcb2498945F59559F640D6bbB992485A7C19e63` |
| Pair init code hash | `0x2249ef38f618407ce9328e89491648a4e8ad4b234e70a538ef9d2096b1ceb820` |

## Transactions (as signed; receipts recorded by forge at broadcast)

| Nonce | Action | Tx hash | Block | Status | Gas |
|---|---|---|---|---|---|
| 0 | deploy WBLCH | `0xdbe6340507aa4a064d962d83c5d4b45e66229a70fd4bc6c126cf05db879d81f6` | 214 | 1 | 612,333 |
| 1 | deploy D4TEST | `0x0b3807467f5e775f1df3e7831647595bd505a4f7cc8a944f31bfc442088b1a4b` | 214 | 1 | 555,980 |
| 2 | deploy factory (cap) | `0xed940559fd254cc9611ad00eb8b1d5d93ab1e3e1390ad1a3c1865d0e50b72712` | 214 | 1 | 2,623,076 |
| 3 | deploy router | `0x0e1d49a43bdefabfc8538ba987c94a7a6b63e40c90ca1b101b69921a3a6c962a` | 214 | 1 | 3,923,130 |
| 4 | deploy lens | `0x1b10258092b02e039d918bdedd4c04b4639937c78ebed9e2f6d7de2253710199` | 214 | 1 | 1,880,324 |
| 5 | deploy collector | `0x9bf742d578b779063efcbd13cc987d797ac5746a7843519e8249ef179ef1445e` | 214 | 1 | 1,515,425 |
| 6 | approve router | `0x7bb8604a2242e6716a5cb8329b10d3b4eb4a71793e99740e45e0fde86f7977d6` | 214 | 1 | 46,487 |
| 7 | addLiquidityBLCH (creates pair) | `0x3728140555124f018ecb07b80e0dd84c6d62136dde849fccbc76df51ab647b5c` | 215 | 1 | 2,368,649 |
| 8 | swap 0.1 BLCH → D4TEST | `0x5b035964890cd85cb86cbe8b8076d1ce1de0c4701e5680f8fa95d1fbb44a79e0` | 215 | 1 | 111,277 |
| 9 | swap 45,330.5 D4TEST → BLCH | `0xa70abcde7d7c5897af399b5f37b0804ed61973f38a8fe946eec42fb75ddda9d1` | 215 | 1 | 134,299 |
| 10 | swap 0.1 BLCH (reserve 1.048 → 1.148, under cap) | `0x584f21136018e9aaa0b1a56db59ec6c2645bedf627164d663ab96d716e95b8c9` | 216 | **1** | 156,321 |
| 11 | swap 0.1 BLCH (would reach 1.248 > 1.2 cap) | `0xf8348cdabdfc726ca56cbd22dac8999def5f411d60beb7de899db0244787f5c8` | 216 | **0 (BDEX: RESERVE_CAP)** | 126,028 |

Events, in forge's receipts:
- nonce 7: PairCreated, Deposit, Sync, Mint;
- nonce 8: Deposit, Sync, Swap;
- nonce 9: Sync, Swap, Withdrawal (WBLCH unwrapped to the operator).

Results:
- liquidity minted 999.999999999999999 LP;
- swap outputs 90,661.089 D4TEST and 0.052082 BLCH.

Transactions 10 and 11 were sent with a fixed gas limit so that the over-cap swap reached the chain and
reverted there, instead of being refused by gas estimation. The revert cost only gas; the 0.1 BLCH stayed
with the operator.

## State after block 216

- Reserves: 1.147918003655233263 WBLCH and 871,731.975769377029698207 D4TEST.
- `factory.reserveCap(WBLCH)` = `pair.reserveCaps()` = 1.2 BLCH.
- `feeTo` = 0.
- Operator balance: 1.346122589620496330 BLCH.

## Finality gate (Ethereum model, no signatures)

`node scripts/staging/check-finality-gate.mjs --config finality-gate.devnet4.json --rpc http://127.0.0.1:18945`
pins only chain 700771 and genesis `0xaec9844384415c8ba7157298fa13f7e6c951a6ba9332f516180a4aa22208fefa`.

| UTC | finalized | Result |
|---|---|---|
| 02:57 | 213 | refused: deployment not finalized |
| 03:02 | 214 | refused (see the RPC defect below) |
| 03:11 | 215 | `liquidity-enabled`, cap 1.2 BLCH read at finalized hash `0xe963cbec…` |
| 03:22 | 216 | `liquidity-enabled` at `0xefd4fbfb…` |

## Known defect found: settled RPC permutes transaction hashes within a multi-tx batch

After the broadcast, the settled RPC labels transactions with the wrong hashes: execution and per-position
content are correct, but the hash shown for each position is permuted. For example,
`eth_getTransactionByHash(nonce-0 hash)` returns the nonce-8 transaction, and blocks 214/215 list hashes of
nonces {1,3,9,8,6,2,7} / {4,0,5} instead of {0..6} / {7,8,9}. Block 216 (two txs) is correct. Forge's
receipts at broadcast time matched the execution, so this table uses them. The gate's per-transaction
finality check trusts that index; its cap, registration and code reads are state reads at the finalized
block hash and are unaffected. The fix belongs to the L2 settled RPC/producer (root cause under
investigation); until then, do not rely on hash lookups for multi-tx blocks on devnet4.
