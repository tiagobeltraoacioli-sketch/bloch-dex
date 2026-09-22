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
`preview` mode with execution and liquidity explicitly disabled. It performs no RPC, SSH,
wallet or deployment action.

Schema version 5 adds an exact activation object whose chain-identity,
finality, deployment, execution and liquidity fields must all remain false.
Changing any one field is rejected; activation requires a reviewed schema and
code change after the evidence gates are independently satisfied. Chain 84001
is explicitly retired and cannot be selected even if every other identity is
otherwise well-formed.

Schema version 5 also requires the fee authority and treasury as distinct
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

Schema version 5 also requires 2–64 reviewed token entries. Each pins a unique
address, runtime-code hash, 2–12 character ASCII symbol, display name and 0–36
decimals. Exactly one token must be the wrapped-native deployment identity.
Fee-on-transfer and rebasing assets are rejected because the lens quote and
balance model does not support them. Token addresses cannot alias deployment
infrastructure. These fields are policy assertions by the reviewer, not facts
discovered from untrusted token metadata calls.

The schema also makes the initial asset decision explicit without activating
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
not exist. The verifier checks the declared chain ID and genesis, rejects a
`finalized` head that has not advanced beyond genesis, requires the deployment
block to be finalized, and reads every deployment contract, custody
role and token at that exact block number. Contract and token bytecode must be
nonempty; reviewed EOA roles may have empty bytecode but its Keccak hash must
still match. It rereads both the deployment and finalized blocks after all code
queries and refuses a changed snapshot or lost finality. The canonical output
binds the complete configuration hash and observations but does not attest that
the RPC is independently trustworthy. Obtain matching evidence from the
qualified node/validator process before release approval.

`launch-gate.template.json` is the checked-in version-3 aggregate preflight. It
selects
chain 700771 but deliberately carries no genesis, RPC, bridge, deployment or
pilot-readiness evidence; every evidence field remains null and every control
remains false. The version-3 schema contains no operator-supplied readiness or
authorization booleans. It fingerprints the exact canonical package and reports
only whether all opaque references are present, fresh and carry a declared
cross-binding to the same RPC observation. The report names these properties
`opaqueReferencesComplete` and `declaredCrossBindingsConsistent`; they do not
mean that any referenced artifact was opened or authenticated.
Because this preflight does not reopen and semantically authenticate those
referenced artifacts, `referencesOpaque` is true, `artifactContentsOpened` and
`semanticEvidenceVerified` are false, and `readyForReviewedActivation` is
unconditionally false.
Liquidity, aggregator execution and activation authorization also remain false
even when every opaque reference is present. A future reviewed semantic verifier
that opens canonical artifacts and authenticates their provenance is required
to change that behavior; copying plausible hashes into this package cannot do so.

`semantic-launch-package.template.json` is the separate version-1 input for
that semantic verification step. The checked-in template is deliberately
pending: all five descriptors are null and all controls are false. A complete
operator-created package must point, by repository-relative path, SHA-256 and
40-hex source revision, to canonical JSON evidence for the L2 finality, bridge,
deployment, capped pilot pool and aggregator. The verifier opens every artifact
with bounded, no-follow reads and checks its schema, canonical repository
provenance and revision. It then cross-binds the selected chain and genesis,
the L2 observation, the exact opened bridge/deployment/pilot artifact hashes,
and the disabled execution controls. Recomputing hashes around a semantic lie
does not satisfy these checks.

The pilot artifact uses `postern.dex.pilot-evidence.v2`. It binds distinct
canonical positive limits for WBLCH and bUSDC, capped respectively at 10 BLCH
base units (`10e18`) and 10 bUSDC base units (`10e6`), plus the nonzero SHA-256
of the separately reviewed cap envelope. Passing these structural checks sets
`declaredPilotCapBounded:true`; it never sets
`pilotCapApprovalAuthenticated:true`. The latter remains false because neither
the package nor its artifact trust roots authenticate the approval authority or
signature behind that envelope.

Structural semantic verification is deliberately neither provenance
authentication nor activation authorization. The repository names, revisions
and hashes in the package are declarations supplied by the package itself. A
complete internally consistent package therefore reports
`semanticStructureVerified: true` and `declaredProvenanceConsistent: true`, but
keeps the authentication fields false unless an operator explicitly supplies
external trust roots.

The optional trust-roots document is not named by the package and is never
auto-selected from an environment variable. It canonically fixes repository,
40-hex revision, artifact path and SHA-256 for each of the five artifacts. Its
own exact SHA-256 must be retained through an independent authenticated channel
and supplied explicitly. Never copy that expected value from the package, the
trust-roots file or command output during the verification ceremony.

```json
{"artifacts":{"aggregator":{"artifactPath":"evidence/aggregator.json","repository":"postern-wallet","revision":"<40-hex>","sha256":"0x<64-hex>"},"bridge":{"artifactPath":"evidence/readiness.json","repository":"bloch-l2-bridge","revision":"<40-hex>","sha256":"0x<64-hex>"},"deployment":{"artifactPath":"evidence/deployment.json","repository":"postern-dex","revision":"<40-hex>","sha256":"0x<64-hex>"},"l2":{"artifactPath":"evidence/finality.json","repository":"bloch-l2-evm","revision":"<40-hex>","sha256":"0x<64-hex>"},"pilot":{"artifactPath":"evidence/pilot.json","repository":"postern-dex","revision":"<40-hex>","sha256":"0x<64-hex>"}},"domain":"postern.dex.semantic-launch-trust-roots.v1","schemaVersion":1,"selectedChainId":700771}
```

Matching roots set `artifactContentAuthenticated`,
`provenanceAuthenticated` and `semanticEvidenceAuthenticated` true. This is
content authentication, not operational approval:
`pilotCapApprovalAuthenticated`, `activationApprovalAuthenticated`,
`readyForReviewedActivation`, liquidity,
aggregator execution and activation authorization remain false. The command
never deploys, broadcasts or adds liquidity. Pending, structurally valid and
authenticated packages all exit `1`; malformed input is refused and invalid
CLI usage exits `2`.

```sh
node scripts/staging/check-semantic-launch-package.mjs \
  --package deployments/semantic-launch-package.template.json
```

For an externally authenticated five-artifact package:

```sh
node scripts/staging/check-semantic-launch-package.mjs \
  --package <repo-relative-package.json> \
  --trust-roots <repo-relative-trust-roots.json> \
  --expected-trust-roots-sha256 <externally-retained-0x-sha256>
```

The gate file must be canonical JSON in a regular, single-link, non-writable
repo-relative file of at most 16 KiB. Symlinks, path escape, partial evidence,
stale evidence and finality at genesis are refused. The command exits `1` for
both pending and refused gates, and `2` for invalid CLI usage; it never returns
success in schema version 2.

```sh
node scripts/staging/check-launch-gate.mjs \
  --gate deployments/launch-gate.template.json
```

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
