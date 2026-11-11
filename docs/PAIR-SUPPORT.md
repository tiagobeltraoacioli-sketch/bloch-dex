# EVM pair support and rehearsal

Postern pairs hold two distinct deployed ERC-20 contracts in the selected EVM
environment. This applies to the intended Bloch L2 integration; it does not
execute Bloch L1 native asset transactions. A native L1 stablecoin requires the
L1 asset and settlement rules. Representing that asset on L2 additionally
requires a separately reviewed bridge or issuance mechanism. Giving an ERC-20
a stablecoin name does not create backing, redemption rights or a price peg.

The Bloch repository's `crates/bloch-euvm/src/ustav/pairs.rs` now provides
native pair identity and jointly PQ-authorized atomic settlement between two
registered Ustav assets. See its `crates/bloch-euvm/docs/native-pairs.md` for the
API, stablecoin scope and activation requirements. This L1 reference path has
no AMM reserves or base-BLCH integration and is not wired into Genesis-4.

Native EVM currency cannot be one of the pair's ERC-20 addresses: use the
reviewed wrapped-native contract, with the router's explicit wrapping paths.
The local `TestWrappedNative` fixture is not a production wrapper. L1 BLCH,
L2 wrapped BLCH and any bridged stablecoin are different asset identities.

## Rehearse pair creation

`script/CreatePair.s.sol:CreatePair` creates a missing canonical pair or validates
an existing one. Reversing token order resolves to the same pair. The script
does not issue assets, deposit liquidity, approve allowances or change fees.
An empty pair has no usable swap quote.

Configure these environment variables from an independently reviewed deployment:

| Variable                                         | Required value                                              |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `BLOCH_L2_RPC_URL`                               | RPC endpoint for the intended EVM environment               |
| `EXPECTED_CHAIN_ID`                              | Nonzero chain ID verified against the network configuration |
| `PAIR_FACTORY`                                   | Reviewed deployed Postern factory address                   |
| `PAIR_FACTORY_CODEHASH`                          | Expected hash of its runtime code                           |
| `PAIR_INIT_CODE_HASH`                            | Reviewed pair creation-code hash matching the factory       |
| `PAIR_TOKEN_A`, `PAIR_TOKEN_B`                   | Distinct deployed ERC-20 addresses                          |
| `PAIR_TOKEN_A_CODEHASH`, `PAIR_TOKEN_B_CODEHASH` | Expected runtime code hashes of those tokens                |

Run a simulation with no private key and no broadcast flag:

```sh
forge script script/CreatePair.s.sol:CreatePair --rpc-url bloch_l2
```

The script's broadcast markers delimit the candidate transaction during
simulation; the command above does not submit it. Keep production execution
separate from this rehearsal and review the simulated transaction first.
No production addresses or chain ID are supplied by this repository.

The checks reject absent code, zero or mismatched code hashes, a wrong chain,
identical tokens and a mismatched pair creation hash. Both new and existing
pairs must match the factory-derived CREATE2 address, have code, appear in
both registry directions and report the expected factory and sorted tokens.
Rehearsing an existing funded pair leaves its reserves and LP supply intact.

## Initial liquidity

The former `InitialLiquidityPreflight` script (signed cap-approval amounts,
`feeToSetter` checks) was removed with the legacy staging tooling on
2026-10-14; it is in git history. On the mainnet path the limits it checked
are part of the deployed code: every pilot token has a reserve cap fixed in the
factory constructor (a deposit above it reverts on chain), and the schema-2
finality gate (on mainnet `scripts/staging/check-finality-gate-mainnet.mjs`; the generic
`check-finality-gate.mjs` serves rehearsal chains only) proves at the
finalized block that the factory, router, lens, fixed fee recipient, caps and
every planned pair are exactly the reviewed ones. The deploy script also
asserts every planned pair is empty. The initial-liquidity amounts and their
ratio are reviewed separately; see `docs/MAINNET-READINESS.md`.

Hash pins are configuration guards, not audits: copying hashes from an
untrusted RPC simply pins its claims. A proxy's runtime hash does not pin its
implementation or mutable policy. Review upgradeability, transfer taxes,
rebases, freeze/mint controls, decimals and issuer/bridge assumptions separately.
The AMM and lens assume ordinary ERC-20 accounting; token metadata is not an
asset authenticity check. First liquidity sets the initial price, so specify
both token minimums in integer base units and review the ratio before funding.

## Discover a pair

`BDexLens.poolFor(tokenA, tokenB)` returns `(exists, snapshot)` from its configured
factory without registry pagination. `exists == false` returns a zero snapshot.
Existing empty pairs return `true` with zero reserves. Snapshot reserves always
follow `token0`/`token1` sorted-address order, including reversed lookup inputs.
Use the reviewed factory when deploying the lens and check quote `available`
before presenting a tradable route; pool existence alone is insufficient.

## Validation

`test/PairSupport.t.sol` covers creation and reversed-order idempotence, existing
funded pair preservation, missing/empty/funded discovery, mixed-decimal quote
execution, chain and code hash rejection, CREATE2 identity, asymmetric registry
rejection and inconsistent pair factory/token reporting. Mocked responses in
the adversarial tests exercise fail-closed configuration checks; they do not
claim protection against an operator deliberately approving malicious code.
