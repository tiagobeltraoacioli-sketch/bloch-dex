# Deployment records

No verified deployment manifest is present. The frontend must remain in preview mode.

A release manifest must include chain ID, genesis block hash, RPC URL, deployment
block/hash, source revision, compiler settings, factory/router/lens/collector and
wrapper addresses, runtime code hashes, pair creation-code hash, fee authority,
treasury, token list, and review evidence. Never use example or zero addresses.

The public Bloch L2 RPC returned chain ID 8400 on 2026-09-11. The scaffold wrapper
address 0x4200000000000000000000000000000000000006 returned empty code. This is
an observation, not verification that the chain is suitable for real funds.

## Closed staging build

`staging.template.json` documents the required shape but is intentionally
invalid: all network and deployment identities are null. Never fill it from an
untrusted RPC response alone or commit credentials. Prepare a separately
reviewed JSON file and run the local preflight:

```sh
node scripts/staging/preflight.mjs --config /path/to/reviewed-staging.json
```

The preflight requires the selected chain ID 700771, nonzero genesis/deployment/pair hashes,
a public HTTPS RPC origin without credentials, query data or a secret
path, and unique nonzero addresses plus runtime-code hashes for the factory, router, lens,
collector and wrapped-native contract. The target must remain `bloch-dex` in
`preview` mode with liquidity explicitly disabled. It performs no RPC, SSH,
wallet or deployment action.

Schema version 4 also requires the fee authority and treasury as distinct
nonzero identities, including the expected runtime-code hash (the empty-code
hash for a reviewed EOA). Neither role may alias deployment infrastructure or a
listed token. This closes the gap between the documented custody requirements
and the machine-checked manifest. The signed read-only frontend independently
rechecks both role code hashes, the factory's exact authority, zero fee recipient
and zero pending authority, plus the collector's immutable treasury binding at
the same pinned snapshot used for the other deployment checks.

Chain 700771 is the selected Bloch L2 testnet identity from `bloch-l2-evm`
revision `fb042a5`. The staging schema rejects superseded 84001, retired 8400 and
every other chain before provider access. Selection is not activation: public
registration, a frozen production genesis, authenticated RPC finality, fresh
contract deployment evidence, and coordinated wallet migration are still
required before this manifest can authorize a release.

Schema version 4 also requires 2–64 reviewed token entries. Each pins a unique
address, runtime-code hash, 2–12 character ASCII symbol, display name and 0–36
decimals. Exactly one token must be the wrapped-native deployment identity.
Fee-on-transfer and rebasing assets are rejected because the lens quote and
balance model does not support them. Token addresses cannot alias deployment
infrastructure. These fields are policy assertions by the reviewer, not facts
discovered from untrusted token metadata calls.

Schema version 3 makes the initial asset decision explicit without activating
it. Bloch L1 remains a separate, non-EVM post-quantum authorization boundary;
the EVM pair representing the `BLCH/bUSDC` intent is therefore
`WBLCH/bUSDC`. The bridge asset pins Ethereum mainnet chain ID 1, canonical
USDC at `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, and the independently
reviewed destination bUSDC address. The reviewed token list must contain the
same 18-decimal WBLCH and 6-decimal bUSDC identities.

The pilot remains disabled in both the top-level target and `pilotPool`. The
validator has conservative technical maxima of 10 BLCH base units (`10e18`)
and 10 bUSDC base units (`10e6`) per initial-liquidity side. The template keeps
both selected caps and `policyCapApproval` null, so it cannot be mistaken for an
approved exposure. A reviewed config must select equal-or-lower caps and provide
a bounded `{path, sha256}` reference under `approvals/` to a canonical envelope.
That version-2 envelope binds its schema/domain, selected EVM chain ID and genesis hash,
factory, fee authority, treasury, WBLCH and bUSDC addresses, and both exact caps. The preflight reads it through a
pinned regular-file descriptor, checks its canonical bytes and hash, and rejects
any mismatch. Because signature verification remains an out-of-band human
control, preflight/build report `capApprovalVerified:false`; the hash is not a
claim that a signature was checked. These fields are still not amounts to transfer, a price assertion,
approval to create the pair, or authority to deploy or add liquidity. Bridge
custody, the bUSDC contract/address, selected EVM chain genesis, deployment
bytecode and the exact initial-liquidity transaction require independent human
review and a separate execution approval ceremony.

After the reviewed config and cap envelope exist, collect a read-only RPC
observation before signing or building anything:

```sh
node scripts/staging/verify-rpc.mjs \
  --config /path/to/reviewed-staging.json \
  --output /path/to/new-staging-rpc-observation.json
```

Install the locked frontend dependencies first because the verifier uses the
same pinned `viem` Keccak implementation as the browser. The output path must
not exist. The verifier checks the declared chain ID and genesis, requires the
deployment block to be finalized, and reads every deployment contract, custody
role and token at that exact block number. Contract and token bytecode must be
nonempty; reviewed EOA roles may have empty bytecode but its Keccak hash must
still match. It rereads both the deployment and finalized blocks after all code
queries and refuses a changed snapshot or lost finality. The canonical output
binds the complete configuration hash and observations but does not attest that
the RPC is independently trustworthy. Obtain matching evidence from the
qualified node/validator process before release approval.

The Foundry `InitialLiquidityPreflight` must receive the same WBLCH/bUSDC
addresses, selected caps and canonical approval SHA-256, plus the exact planned
initial amounts. It refuses zero amounts, amounts above either selected cap,
selected caps above the hard 10 BLCH / 10 bUSDC maxima, a zero approval hash or
a base token other than the reviewed WBLCH. Its event binds these values but
does not verify a signature or authorize the later liquidity transaction.

After the reviewed configuration exists and all tracked changes are committed,
build a static bundle and a self-contained artifact manifest:

```sh
node scripts/staging/build.mjs \
  --config /path/to/reviewed-staging.json \
  --output artifacts/bloch-dex-staging.json
```

Configuration validation happens before the frontend build. The build refuses
a dirty tracked worktree and refuses to overwrite an existing manifest. Its
manifest records the exact Git revision, reviewed deployment configuration and
fingerprint, npm lockfile hash, and SHA-256 plus byte length for every static
file. `artifacts/` and `frontend/dist/` are local outputs and remain ignored.
This command does not publish the bundle; host access and release approval are
separate operational steps.

Validate this automation with Node 24:

```sh
node --test scripts/staging/manifest.test.mjs scripts/staging/rpc-verifier.test.mjs
```
