# Deployment records

The Bloch L2 mainnet deployment procedure (one reviewed config, deterministic
plan, dry run, broadcast, on-chain record, schema-2 finality gate) is in
[docs/MAINNET-READINESS.md](../docs/MAINNET-READINESS.md); its input is
`mainnet/dex-mainnet.config.json`.

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
role and token using that exact block hash with `requireCanonical: true`.
Contract and token bytecode must be
nonempty; reviewed EOA roles may have empty bytecode but its Keccak hash must
still match. It rereads both the deployment and finalized blocks after all code
queries and refuses a changed snapshot or lost finality. The canonical output
binds the complete configuration hash and observations but does not attest that
the RPC is independently trustworthy. Obtain matching evidence from the
qualified node/validator process before release approval.

Zero block hashes and different snapshot/finalized hashes at the same height
are also refused, both before and after the deployment code reads.

## Read-only pilot pool collection

After a separately authorized deployment and pool creation have produced real
identities, collect the empty WBLCH/bUSDC pool at an explicitly selected block:

```sh
node scripts/staging/inspect-pilot-pool.mjs \
  --config /path/to/reviewed-staging.json \
  --block-number <reviewed-decimal-block> \
  --block-hash <reviewed-0x-block-hash> \
  --pair-runtime-code-hash <reviewed-0x-runtime-keccak256> \
  --output /path/to/new-pilot-pool-observation.json
```

The configuration and cap-envelope checks are the same as staging preflight.
The block must be at or after the deployment snapshot. The expected pair runtime
hash must come from the reviewed compiled artifact; copying it from the RPC
being inspected would not establish that binding. The output file must not
exist. This command never creates a pair, submits a transaction or enables a
fee, liquidity or execution flag.

The collector checks the selected chain and genesis, the explicit block hash,
and a non-genesis finalized checkpoint. Every state query uses EIP-1898
`{blockHash, requireCanonical: true}`; providers without this feature are
refused without falling back to a moving head or block number. At that block it:

- checks factory, WBLCH, bUSDC and pair bytecode against reviewed hashes;
- derives the pair with CREATE2 from the factory, sorted tokens and reviewed
  creation-code hash, and checks that hash against the factory;
- checks both factory registry directions, `allPairs(0)`, a single factory
  pair and the pair's own factory/token bindings;
- requires disabled protocol fees, no pending fee-authority transfer and the
  configured fee authority;
- requires zero reserves, both raw token balances and LP total supply, so
  donated balances cannot pass as an empty pool.

Before writing output it rereads the inspection block, the original finalized
checkpoint by height, the latest finalized checkpoint, chain ID and genesis.
Changed blocks, conflicting hashes at equal heights and finality regression are
refused. These consistency checks do not authenticate the RPC or establish
ancestry beyond what it reports.

`postern.dex.pilot-pool-rpc-observation.v1` retains the configuration SHA-256,
cap-approval SHA-256, checkpoints, pool values, runtime hashes and exact call
inputs/results. Its `observationSha256` covers canonical `stableJson` of every
other field, excluding that digest itself. The output deliberately has a
different schema from the authenticated `pilotPool` evidence accepted by the
pilot-readiness gate. It is material for independent review; it cannot be
substituted directly for that gate's evidence. `sourceRpcAuthenticated`,
`finalityAuthenticated`, `poolInspectionAuthenticated`,
`capApprovalAuthenticated` and all execution controls remain false.

No reviewed pool identities or operational finality evidence are added by this
collector. The checked-in pending staging template continues to fail before
any provider access.

### Retained capture and offline replay

For a replayable collection, use the same reviewed configuration, block and
runtime pin with `capture-pilot-pool.mjs`:

```sh
node scripts/staging/capture-pilot-pool.mjs \
  --config /path/to/reviewed-staging.json \
  --block-number <reviewed-decimal-block> \
  --block-hash <reviewed-0x-block-hash> \
  --pair-runtime-code-hash <reviewed-0x-runtime-keccak256> \
  --output /path/to/new-pool-capture.json
```

The new `postern.dex.pilot-pool-rpc-capture.v1` envelope retains the observation
and the ordered RPC transcript, including actual factory/token/pair bytecode.
Block results retain only the number and hash consumed by the inspector; other
block metadata, RPC URLs and transport credentials are excluded. No response is
reconstructed from a claimed code hash. The original observation-only command
and schema remain supported, but an observation without this transcript cannot
be replayed as a complete capture.

Retain the printed file SHA-256 separately. It covers the canonical JSON file,
including its final newline. The envelope's `captureSha256` is a different
digest: it covers canonical JSON of all envelope fields except itself, without
the file's newline. Neither digest establishes source authenticity by itself.

Supply the reviewed configuration and expected block/runtime pins again when
replaying; they are not selected from the untrusted capture:

```sh
node scripts/staging/replay-pilot-pool.mjs \
  --config /path/to/reviewed-staging.json \
  --block-number <independently-selected-decimal-block> \
  --block-hash <independently-selected-0x-block-hash> \
  --pair-runtime-code-hash <reviewed-0x-runtime-keccak256> \
  --capture /path/to/retained-pool-capture.json \
  --capture-sha256 <separately-retained-file-0x-sha256> \
  --output /path/to/new-pool-replay.json
```

Replay performs no RPC access. It reruns the pool inspector with only the
retained responses, requiring the exact requested methods, parameters and
order, no missing or unused responses, and an exact match to the derived
observation. Recomputed outer hashes cannot conceal changed bytecode, weakened
block pinning, swapped responses, invented amounts or enabled control flags.
Inputs are bounded to 4 MiB, 48 RPC calls and 1 MiB per string result. The file
reader checks the externally supplied digest, canonical bytes, a stable regular
single-link inode, no symlinks and no group/other write permission. Output is
private and create-only, as with collection.

Successful `postern.dex.pilot-pool-offline-replay.v1` output means the retained
observations reproduce under the supplied configuration. It does not establish
that the RPC told the truth, that a finalized checkpoint was independently
authenticated or that the state is still current. All authentication and
execution controls remain false. Neither the capture nor the replay substitutes
for the pilot-readiness gate's independently authenticated evidence.

## Launch evidence packages

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

The pilot artifact uses `postern.dex.pilot-evidence.v3`. It binds distinct
canonical positive limits for WBLCH and bUSDC, capped respectively at 10 BLCH
base units (`10e18`) and 10 bUSDC base units (`10e6`), plus the nonzero SHA-256
of the separately reviewed cap envelope. It also fixes the deployment
configuration, factory, pilot pair, WBLCH, bUSDC and all five source revisions.
Passing these structural checks sets
`declaredPilotCapBounded:true`; it never sets
`pilotCapApprovalAuthenticated:true`. The latter remains false because neither
the package nor its artifact trust roots authenticate the approval authority or
signature behind that envelope.

Optional cap-signature inspection accepts two distinct Ed25519 public keys named
`postern-dex-pilot-risk` and `postern-dex-pilot-security` in an exact OpenSSH
allowed-signers policy. Both sign the canonical approval with namespace
`postern.dex.pilot-cap-approval.v1`. The approval binds a caller-supplied
ceremony identifier, the exact chain/genesis/deployment/token/pool/caps/source
revisions, a maximum 15-minute validity window and disabled execution controls.
Version 2 also binds a canonical positive `sequence` and the exact predecessor
approval SHA-256. A separate canonical
`postern.dex.pilot-cap-checkpoint.v1` snapshot repeats the full context and
retains `lastSequence` plus `lastApprovalSha256`. The candidate must be the
immediate successor and name that predecessor exactly, rejecting observed
replay, rollback, gaps and cross-context checkpoint substitution.
The policy SHA-256, ceremony identifier and `ssh-keygen` SHA-256 are explicit
caller-supplied inputs. They do not prove an independent trust root, that the
two keys belong to separate organizations, or that the ceremony was not replayed.
The checker requires a canonical absolute, root-owned, regular, single-link
executable with no group/other write permission and an explicit SHA-256 pin.
Every ancestor must be a root-owned directory without symlinks or group/other
write permission. An additional `access(W_OK)` check refuses paths writable by
the current non-root operator, including access granted to that operator by an
ACL. This does not enumerate ACL rights granted to other users. OS administrators
and users to whom they delegate write access remain outside this trust boundary.

The opened descriptor remains in the parent while the original reviewed path
is executed. This supports the platform-signed macOS binary without copying,
re-signing or falling back to a different executable. The descriptor and named
file must retain their inode, size, ownership, permissions and change times;
ancestor identity, ownership, permissions and change time are checked before
and after every child. The child receives only fixed locale settings, no
inherited `PATH`, loader overrides or SSH-agent environment, and has a
10-second timeout and bounded output. Any detected replacement or abnormal
exit refuses the observation. These checks do not sandbox effects of a program
replaced by an administrator during execution.

A negative signature probe must exit normally with a nonzero status before
either real signature check. This rejects an always-success substitute such as
`true`; it does not certify the verifier or establish an external trust root.
The report identifies `verifierExecutionMode` as
`pinned-root-administered-path` and `invalidSignatureProbeRefused:true` while
keeping every authentication field false. User-owned executables remain
unsupported, as before; root-owned files under operator-writable ancestors are
now also refused.

Even two zero-exit signature checks are only an observation over caller-supplied
inputs. The report therefore keeps `pilotCapApprovalAuthenticated:false`,
`verifierIdentityAuthenticated:false`,
`authorityOrganizationsSeparated:false`, `replayProtectionAuthenticated:false`
and `approvalAuthenticated:false`. A later reviewed code change must install
non-caller-selected trust roots, organizational identities and a durable
sequence/predecessor checkpoint before any authenticated claim can become true.
The default observation never updates the retained checkpoint. An explicit
`--consume-cap-checkpoint-observation` mode adds a filesystem compare-and-swap
without promoting trust: an atomic lock directory serializes processes, the
retained digest must match, and only the immediate successor can be stored.
The replacement is written to a same-directory temporary file, `fsync`ed,
renamed atomically and followed by a directory `fsync`. A durable intent record
allows a later process to finish or reconcile a crash between intent and
checkpoint replacement. Completed retries are idempotent when the retained
sequence and approval hash already match. Dead-process locks older than 30
seconds are quarantined before recovery; live locks remain exclusive.

These are observed local durability properties, not authenticated replay
protection. The caller still selects every trust input, and the checkpoint is
not backed by an independent append-only authority. Reports therefore keep
`replayProtectionAuthenticated:false` and `approvalAuthenticated:false` after
both a fresh CAS and an idempotent retry.
This inspection does not enable liquidity, aggregator execution, deployment or
broadcast.

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

For an observation-only check of a caller-supplied two-signature cap envelope,
append:

```sh
  --cap-approval <repo-relative-approval.json> \
  --cap-authority-policy <repo-relative-allowed-signers> \
  --expected-cap-authority-policy-sha256 <caller-supplied-0x-sha256> \
  --expected-cap-ceremony-id <caller-supplied-0x-id> \
  --cap-risk-signature <repo-relative-risk.sig> \
  --cap-security-signature <repo-relative-security.sig> \
  --ssh-keygen /usr/bin/ssh-keygen \
  --expected-ssh-keygen-sha256 <caller-supplied-0x-sha256> \
  --cap-checkpoint <repo-relative-checkpoint.json> \
  --expected-cap-checkpoint-sha256 <caller-supplied-0x-sha256>
```

Append `--consume-cap-checkpoint-observation` only when the local retained
checkpoint should advance. This mutates only that evidence file and its
short-lived lock/intent sidecars; it never deploys, broadcasts, creates a pool,
adds liquidity or changes any execution flag.

The gate file must be canonical JSON in a regular, single-link, non-writable
repo-relative file of at most 16 KiB. Symlinks, path escape, partial evidence,
stale evidence and finality at genesis are refused. The command exits `1` for
both pending and refused gates, and `2` for invalid CLI usage; it never returns
success in schema version 2.

```sh
node scripts/staging/check-launch-gate.mjs \
  --gate deployments/launch-gate.template.json
```

## Disposable end-to-end cycle request

`disposable-cycle-request.template.json` is the fail-closed request for the
first retained bridge/DEX round trip. It fixes Ethereum mainnet USDC,
destination chain 700771, a maximum 1 USDC deposit, a maximum 0.01 WBLCH pilot
leg and a maximum 1 bUSDC quote leg. All destination identities, revisions,
cycle ID and five evidence stages are null, and every execution control remains
false.

A complete `postern.dex.disposable-cycle-package.v1` must compose, in order:

1. a finalized Ethereum USDC deposit receipt;
2. a destination L2 finalized checkpoint bound to that deposit;
3. the exact USDC-to-bUSDC mapping and finalized mint receipt;
4. a capped WBLCH/bUSDC pilot swap out and back, with before/after checkpoints,
   two finalized receipts, no liquidity addition and the base leg reconciled;
5. finalized burn, release and refund receipts whose release, refund and fees
   sum exactly to the original deposit.

Every stage repeats the cycle identifier, synthetic marker and canonical source
revision, and binds the stable SHA-256 digest of its predecessor. The verifier
also pins both genesis identities, contract/token/pool addresses, caps,
transaction blocks, finalized blocks and the final reconciliation checkpoint.

```sh
node scripts/staging/check-disposable-cycle-package.mjs \
  --package deployments/disposable-cycle-request.template.json
```

The checked-in request exits `1` because it is pending. Test-only complete
fixtures are explicitly `synthetic-fixture`; they establish only structural
composition, never provenance or operational truth. A self-declared
`retained-real` package is equally non-authorizing without independent trust
roots. Consequently `externalTrustRootsConfigured`,
`disposableCycleAuthenticated`, `readyForRealExecution`, liquidity, aggregator
execution, activation and broadcast all remain false. The verifier performs no
RPC, SSH, signing, pool creation, liquidity action or transaction.

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

## Hash-pinned deployment capture and offline replay

The deployment runtime inspector now uses EIP-1898
`{blockHash: <reviewed snapshot>, requireCanonical: true}` for every code read.
It refuses unsupported selectors instead of falling back to a height or latest.
This prevents mixing runtime state if the numbered snapshot temporarily changes
between the opening and closing block checks. See [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898).

Retain and replay all actual runtime bytes, rather than only claimed code hashes:

```sh
node scripts/staging/deployment-evidence.mjs capture \
  --config /private/reviewed-staging.json --output /private/new-deployment-capture.json
node scripts/staging/deployment-evidence.mjs replay \
  --config /private/reviewed-staging.json \
  --capture /private/new-deployment-capture.json \
  --capture-sha256 <independently-retained-0x-file-sha256> \
  --output /private/new-deployment-replay.json
```

The capture contains the ordered read-only RPC transcript and the existing
staging observation. Replay repeats every chain/genesis/finality-tag/snapshot
and runtime check, requires the same caller-selected configuration, and rejects
missing, extra, reordered or altered responses even when the envelope digest is
recomputed. Source URLs and transport credentials are omitted. Limits are 80
calls, 1 MiB per string response and 4 MiB for the complete capture. Reads use
the existing canonical, regular-file, no-symlink, externally digest-pinned
capture transport. Outputs use mode 0600 and are create-only.

The outer `captureSha256` binds canonical envelope fields except itself; the
printed **file SHA-256** also covers the final newline. Use the latter for the
replay command. Neither authenticates its own source. A successful replay is
internal consistency evidence, not a proof of finality, a deployment approval
or permission to enable liquidity. The checked-in pending deployment template
still fails before RPC access. No contract deployment or wallet action is added.
