# Offline live-read envelope tooling

This tooling signs and verifies the read-only gate, staging artifact and an
independently keyed generation-witness statement consumed by the frontend. It does not generate a key, select a deployment, contact a
network, modify `index.html`, or enable liquidity.

Run it with Node 24. Inputs must be regular, non-symlink files. A private key must
be an unencrypted Ed25519 PKCS#8 PEM file with no group/other permissions on
POSIX. A public key must be an Ed25519 SPKI PEM file. Signed outputs are created
with exclusive-create semantics and canonical JSON, so an existing path is never
overwritten.

## Controlled signing flow

Generate and hold the Ed25519 key in an approved offline system outside this
repository. This CLI accepts a file-backed PKCS#8 key; it does not claim HSM or
hardware-backed signing support. If policy requires a non-exportable key, add and
review that signer integration before using this workflow. Do not pass
private-key material through an environment variable, command argument, build
log, artifact, browser, or CI secret that is exposed to untrusted jobs.

1. Inspect the reviewed public key:

   ```sh
   node scripts/live-auth.mjs inspect-key --public-key <public-key.pem>
   ```

   Independently compare the displayed `keyId` and `publicKeyBase64Url`. A reviewed
   frontend build receives the latter as
   `VITE_POSTERN_LIVE_READ_PUBLIC_KEY`. Choose the next positive integer key
   generation and pin it in the same build as
   `VITE_POSTERN_LIVE_READ_KEY_GENERATION`. This repository supplies neither
   value.

2. Build the unsigned staging artifact with the existing staging pipeline. Move
   the artifact payload into the controlled signing environment and sign it:

   ```sh
   node scripts/live-auth.mjs sign-manifest \
     --private-key <private-key.pem> \
     --key-generation <positive-integer> \
     --input <artifact-manifest.json> \
     --output <artifact-manifest.signed.json>
   ```

3. Prepare a gate payload containing exactly `schemaVersion`, `enabled`, `mode`,
   `registryUrl`, `issuedAt`, `expiresAt`, `allowedRpcOrigins`, and `timeoutMs`.
   Timestamps are explicit Unix seconds and the validity window cannot exceed
   seven days. Do not include `manifestSha256`; the signer derives it from the
   verified signed manifest so it cannot be copied from a different release.

   ```sh
   node scripts/live-auth.mjs sign-gate \
     --private-key <private-key.pem> \
     --key-generation <positive-integer> \
     --input <gate-payload.json> \
     --manifest <artifact-manifest.signed.json> \
     --at <review-unix-seconds> \
     --output <gate.signed.json>
   ```

4. An independent operator maintains a distinct Ed25519 witness key and HTTPS
   origin. Prepare a payload containing exactly `schemaVersion: 1`, the reviewed
   live-read `liveReadKeyId`, `minimumLiveReadKeyGeneration`, `issuedAt`, and
   `expiresAt`. Its window is at most 15 minutes. Sign it with the witness key:

   ```sh
   node scripts/live-auth.mjs sign-witness \
     --private-key <witness-private-key.pem> \
     --key-generation <witness-key-generation> \
     --input <witness-payload.json> \
     --at <review-unix-seconds> \
     --output <witness.signed.json>
   ```

   Pin its exact cross-origin HTTPS URL, public key, and signer generation in the
   reviewed build as `VITE_POSTERN_LIVE_WITNESS_URL`,
   `VITE_POSTERN_LIVE_WITNESS_PUBLIC_KEY`, and
   `VITE_POSTERN_LIVE_WITNESS_KEY_GENERATION`. Serve only the current statement
   with narrowly scoped CORS and `Cache-Control: no-store`.

5. On a separate verification host, verify all three files with both public keys
   and an explicit review time:

   ```sh
   node scripts/live-auth.mjs verify-bundle \
     --public-key <public-key.pem> \
     --key-generation <positive-integer> \
     --gate <gate.signed.json> \
     --manifest <artifact-manifest.signed.json> \
     --witness-public-key <witness-public-key.pem> \
     --witness-key-generation <witness-key-generation> \
     --witness <witness.signed.json> \
     --at <review-unix-seconds>
   ```

Only a verified bundle may be considered for the later host-injection review.
Verification does not publish files or validate a real RPC/CORS deployment.

## Offline publication receipt and retained checkpoint

The short-lived witness prevents an already witness-aware browser from accepting
a live-read generation below its current floor. It is not a durable release
history. For audit and rollback detection, use a third Ed25519 publication key
that is distinct from both bundle keys and kept offline. The publication command
re-verifies the complete bundle before signing a permanent, content-addressed
receipt. It never copies a private key into the bundle or contacts a network.

Initialize the verifier checkpoint once from the reviewed publication public
key. Store this checkpoint in an independently authenticated system, not beside
the web release:

```sh
node scripts/live-auth.mjs init-publication \
  --publication-public-key <offline-publication-public.pem> \
  --publication-key-generation <positive-integer> \
  --output-checkpoint <checkpoint-0.json>
```

For the first release, pass `genesis`. For every later release, transfer the
previous signed entry into the offline system and pass its path. The CLI derives
the next sequence and previous-entry hash rather than accepting either value
from operator input:

```sh
node scripts/live-auth.mjs publish-release \
  --public-key <public-key.pem> \
  --key-generation <positive-integer> \
  --gate <gate.signed.json> \
  --manifest <artifact-manifest.signed.json> \
  --witness-public-key <witness-public-key.pem> \
  --witness-key-generation <witness-key-generation> \
  --witness <witness.signed.json> \
  --publication-private-key <offline-publication-private.pem> \
  --publication-key-generation <positive-integer> \
  --previous <genesis-or-previous-entry.json> \
  --at <publication-unix-seconds> \
  --output <publication-entry.json>
```

The entry binds the canonical hashes of all three signed envelopes, the source
revision, signer identities and generations, sequence, predecessor and
publication time. Output creation is exclusive and mode `0444` on POSIX. That
mode prevents accidental edits; it is not WORM storage or protection from an
administrator. Publish the entry and bundle under their hashes in immutable
object storage or a transparency service according to the deployment policy.

An auditor verifies a new entry against its retained checkpoint and writes a new
checkpoint to a different path:

```sh
node scripts/live-auth.mjs verify-release \
  --public-key <public-key.pem> \
  --key-generation <positive-integer> \
  --gate <gate.signed.json> \
  --manifest <artifact-manifest.signed.json> \
  --witness-public-key <witness-public-key.pem> \
  --witness-key-generation <witness-key-generation> \
  --witness <witness.signed.json> \
  --publication-public-key <offline-publication-public.pem> \
  --publication-key-generation <positive-integer> \
  --entry <publication-entry.json> \
  --checkpoint <retained-checkpoint.json> \
  --at <audit-unix-seconds> \
  --output-checkpoint <next-checkpoint.json>
```

Verification accepts only the retained entry itself or its direct successor.
This deliberately requires auditors to process every publication in order; it
rejects rollback and a different same-sequence fork once the newer checkpoint
has been retained. Bundle validity is checked at the signed publication time, so
the receipt remains auditable after the gate and witness expire. The explicit
audit time only bounds a publication timestamp from the future.

The browser does not fetch or trust this log, and a checkpoint stored beside a
rollbackable deployment provides no protection. The mechanism neither provides
global gossip nor detects a fork before independent auditors compare/retain a
checkpoint. Coordinated compromise of DNS/TLS, the live-read signer, witness,
publication signer and checkpoint store remains outside its guarantees.

### Offline publication-key rotation

Rotate the offline publication key only after at least one ordinary publication
has been retained. The rotation is itself the next log entry. It contains the
same release binding, sequence and predecessor hash signed independently by the
old key (authorization) and the new key (acceptance). The new generation must be
strictly greater and the key IDs must differ. Both keys must also remain distinct
from the live-read and witness keys.

```sh
node scripts/live-auth.mjs rotate-publication \
  <the same bundle arguments used by publish-release> \
  --prior-publication-private-key <old-private.pem> \
  --prior-publication-key-generation <old-generation> \
  --next-publication-private-key <new-private.pem> \
  --next-publication-key-generation <greater-generation> \
  --previous <last-signed-entry.json> \
  --at <rotation-unix-seconds> \
  --output <rotation.json>
```

An auditor advances from its old checkpoint only after verifying both public
keys, both signatures, the bundle and the direct chain link:

```sh
node scripts/live-auth.mjs verify-rotation \
  <the same bundle arguments used by verify-release> \
  --prior-publication-public-key <old-public.pem> \
  --prior-publication-key-generation <old-generation> \
  --next-publication-public-key <new-public.pem> \
  --next-publication-key-generation <greater-generation> \
  --rotation <rotation.json> \
  --checkpoint <old-retained-checkpoint.json> \
  --at <audit-unix-seconds> \
  --output-checkpoint <new-retained-checkpoint.json>
```

The first ordinary entry after rotation uses `publish-after-rotation`, with the
old public key, new private key and the rotation entry. Later entries return to
`publish-release`. This explicit bridge prevents the CLI from silently treating
an arbitrary file or an old-key entry as new-key history. A consumed rotation,
a competing rotation from the same predecessor, a generation downgrade or key
reuse fails against the advanced checkpoint. Auditors must still exchange and
compare independently retained checkpoint hashes to discover equivocation;
this local, offline mechanism is not a claim of globally visible transparency.

### Offline multi-auditor confirmation

`publication-quorum.mjs` adds an independent threshold confirmation layer over
an already verified publication receipt. Its reviewed configuration contains a
lexicographically sorted list of two or more auditor IDs, raw Ed25519 public
keys, their derived key IDs and generations, plus a threshold of at least two.
Auditor IDs and keys must both be unique, and auditor keys must differ from the
current and (during rotation) prior publication keys. Configuration is
deliberately not discovered from the release or a network service.

```json
{
  "schemaVersion": 1,
  "configGeneration": 1,
  "threshold": 2,
  "auditors": [
    {
      "auditorId": "operations-a",
      "keyId": "<sha256-of-raw-ed25519-key>",
      "keyGeneration": 1,
      "publicKeyBase64Url": "<32-byte-raw-ed25519-key>"
    },
    {
      "auditorId": "security-b",
      "keyId": "<sha256-of-raw-ed25519-key>",
      "keyGeneration": 1,
      "publicKeyBase64Url": "<32-byte-raw-ed25519-key>"
    }
  ]
}
```

Bootstrap a retained quorum checkpoint from the publication checkpoint whose
head was reviewed out of band. This now creates quorum-checkpoint schema 2;
legacy schema-1 quorum checkpoints are deliberately rejected and must not be
silently migrated. Before production use, bootstrap schema 2 once from the
independently retained publication checkpoint:

```sh
node scripts/publication-quorum.mjs init \
  --config <auditors.json> \
  --publication-checkpoint <reviewed-publication-checkpoint.json> \
  --output-checkpoint <quorum-checkpoint.json>
```

Each auditor first verifies and retains the publication checkpoint using the
publication commands above. On its offline system it then signs the exact
canonical receipt hash and its complete head (sequence, predecessor, current
publication key ID and generation):

```sh
node scripts/publication-quorum.mjs attest \
  --config <auditors.json> \
  --auditor-id <configured-id> \
  --private-key <auditor-ed25519-private.pem> \
  --entry <publication-entry-or-rotation.json> \
  --publication-checkpoint <auditor-retained-publication-checkpoint.json> \
  --output <auditor-attestation.json>
```

An offline collector places the individual attestation objects in a JSON array
and advances its checkpoint only from the exact direct predecessor:

```sh
node scripts/publication-quorum.mjs verify \
  --config <auditors.json> \
  --entry <publication-entry-or-rotation.json> \
  --attestations <attestation-array.json> \
  --checkpoint <retained-quorum-checkpoint.json> \
  --output-checkpoint <next-quorum-checkpoint.json>
```

Verification rejects duplicate auditor IDs or keys, unknown/substituted
auditors, invalid signatures, a changed configuration, too few distinct
signers, receipt tampering, replay, rollback, forks and publication-key
transitions that do not start at the retained head. Outputs are exclusive and
read-only (`0444` on POSIX); that mode is only accident protection, so each
checkpoint still needs independent authenticated, anti-rollback storage.

The quorum configuration itself rotates through a separate, versioned offline
transition. Set `configGeneration` to exactly the retained generation plus one,
review both complete canonical configuration files, and have independently
chosen threshold groups sign the same retained checkpoint and publication head.
Old members authorize removal; new members accept responsibility:

```sh
node scripts/publication-quorum.mjs attest-config-rotation \
  --prior-config <auditors-generation-N.json> \
  --next-config <auditors-generation-N-plus-1.json> \
  --role prior-authorization \
  --auditor-id <configured-id> \
  --private-key <auditor-ed25519-private.pem> \
  --checkpoint <retained-quorum-checkpoint.json> \
  --output <rotation-approval.json>

node scripts/publication-quorum.mjs rotate-config \
  --prior-config <auditors-generation-N.json> \
  --next-config <auditors-generation-N-plus-1.json> \
  --prior-approvals <sorted-old-approval-array.json> \
  --next-acceptances <sorted-new-acceptance-array.json> \
  --checkpoint <retained-quorum-checkpoint.json> \
  --output-checkpoint <next-quorum-checkpoint.json>
```

Run the attestation command for each old signer with `prior-authorization` and
for each new signer with `next-acceptance`. Each approval array must be sorted
by auditor ID. The signed transition binds both config
digests and generations, the canonical retained checkpoint digest, the prior
rotation digest, and the exact publication key, sequence and entry hash. A
rotation does not consume a publication sequence or change its head. The
resulting checkpoint commits to the complete ordered approval record so the
next transition is chained to it.

An auditor ID or key may count in only one side of a transition, even if it is
present in both configurations. Operators must select disjoint old and new
threshold subsets; this prevents one identity from being counted twice as both
authorization and acceptance. Invalid thresholds, duplicates, config
substitution, generation skips/downgrades, tampering, replay, and a transition
from any checkpoint other than the exact retained predecessor fail closed.
Like publication verification, preventing two collectors from advancing the
same predecessor requires authenticated compare-and-swap storage and auditor
checkpoint comparison outside this CLI.

### Durable quorum checkpoint store

The path-based `--output-checkpoint` commands above remain useful for offline
review and compatibility, but they do not serialize two collectors. For an
offline collector backed by a local filesystem, initialize the dedicated store
from the reviewed schema-2 checkpoint:

```sh
node scripts/publication-quorum-store.mjs init \
  --store <new-private-directory> \
  --checkpoint <reviewed-quorum-checkpoint.json>
```

Record the printed checkpoint SHA-256 in a separately authenticated system.
Every advance requires that exact digest as a compare-and-swap precondition:

```sh
node scripts/publication-quorum-store.mjs verify \
  --store <private-directory> \
  --expected-checkpoint-sha256 <externally-retained-sha256> \
  --config <auditors.json> \
  --entry <publication-entry-or-rotation.json> \
  --attestations <attestation-array.json>

node scripts/publication-quorum-store.mjs rotate \
  --store <private-directory> \
  --expected-checkpoint-sha256 <externally-retained-sha256> \
  --prior-config <auditors-generation-N.json> \
  --next-config <auditors-generation-N-plus-1.json> \
  --prior-approvals <sorted-old-approval-array.json> \
  --next-acceptances <sorted-new-acceptance-array.json>
```

Both operations take an exclusive lock, re-run the complete cryptographic and
chain validation, persist a bounded canonical transition record, and replace
the checkpoint with a temp-file/fsync/rename/directory-fsync sequence. Files
must be regular, single-link, current-user-owned, non-symlink objects with no
group or other access. Store directories have the same ownership and permission
requirements, and their canonical paths may not traverse symlinks. Before
unlocking, the CLI confirms that the lock path still names the same single-link
inode opened exclusively; replacement or hardlink races preserve state and fail
closed. The store rejects non-canonical state. Successful output includes the new
checkpoint and record hashes; retain and compare both according to operations
policy.

A durable `.pending.json` or `.quorum.lock` means that an operation may have
failed after durable intent was recorded. Do not delete either marker or retry
the operation blindly. Stop writes, preserve an image of the directory, and
use the read-only inspection command to compare the current checkpoint, pending
intent and content-addressed record with the external digest:

```sh
node scripts/publication-quorum-store.mjs inspect --store <private-directory>
```

Recovery is deliberately a manual, separately authorized procedure; this tool
does not guess whether an interrupted rename committed. A same-disk lock and
filesystem checkpoint are not anti-rollback storage. An administrator, disk
snapshot rollback, filesystem corruption, or loss of the whole directory can
restore older state. Production use therefore still requires an externally
retained authenticated checkpoint hash (preferably hardware-backed or an
independent append-only service), backups, host hardening and auditor gossip.

This CLI does not independently re-verify the publication signature or bundle;
the supplied publication checkpoint is the explicit handoff from
`verify-release`/`verify-rotation`. Auditors must run that verification
independently before attesting. The configuration and bootstrap checkpoint are
trust anchors and must be reviewed through a separate authenticated process.
The browser neither produces nor consumes quorum attestations. This mechanism
does not provide transport, gossip, witness consistency or globally visible
transparency, and a threshold compromise can still attest a fork.

## Rotation and recovery

Rotation is intentionally single-key and explicit. Increment the reviewed key
generation, inspect the new public key, record both generation and key ID in the
release review, rebuild the frontend with the new raw public-key pin and exact
generation, and sign a new gate and manifest with the corresponding private key
and generation. Envelope schema 2 signs `{ keyGeneration, payload }`, so changing
metadata cannot relabel an old signature. A build pinned to the old key/generation
rejects the new bundle and a build pinned to the new pair rejects the old bundle.
The runtime has no hidden fallback or multi-key trust set; omitting either build
pin fails closed.

Never decrement or reuse either generation. Before any manifest or RPC request,
the browser fetches the independently hosted statement without credentials or a
referrer and requires its live-read key ID and generation floor to authorize the
build. Advancing the witness floor therefore rejects an older live-read build as
long as that build already contains this witness policy and the independent
origin/key are not compromised. A replay remains possible until the statement's
short expiry.

This is not complete whole-build rollback prevention. Serving a frontend from
before witness enforcement removes the check, while rolling back DNS/TLS, the
witness service and its key together can restore an older policy. Immutable
release deployment, client-visible transparency/pinning, independent custody,
reliable clocks and an external monotonic publication process remain required.
The offline publication receipt above supplies tooling for that process, but its
guarantee depends on independent key custody and durable external checkpoints.

Revoke a compromised signer by removing the host gate, preserving preview mode,
and producing a reviewed build pinned to a new key. Retaining an old private key
for rollback would also retain authority to sign accepted data for old builds;
key destruction and archival policy must therefore be decided by the release
owners and recorded outside this repository.

The signatures authenticate release authorization, not truth of chain data.
Independent review of the manifest identities, browser support, clock policy,
RPC behavior and operational custody remains mandatory.

## Browser acceptance

The acceptance test uses only ephemeral live-read and witness keys, a one-day self-signed test
certificate and two HTTPS origins bound to `127.0.0.1`. It builds the actual
frontend with the ephemeral public-key pin, creates gate/manifest envelopes via
the CLI, and drives an installed Chrome/Chromium through its local DevTools
endpoint:

```sh
node --test scripts/live-auth/browser-acceptance.test.mjs
```

Set `POSTERN_CHROME` to an explicit browser executable when it is not in a
standard location. The test requires `openssl` to create its temporary localhost
certificate and skips when Chrome/Chromium is absent. It disables Chrome
background networking and does not contact a real RPC. The local fake RPC
intentionally returns the wrong chain ID after recording the request, so the UI
must end in an unavailable read-only state.

The test proves that Chrome WebCrypto accepts the CLI signatures, that the independent witness
is fetched without cookies/referrer before the manifest, that a higher witness
generation floor causes zero manifest/RPC requests, and that the exact
manifest pin and gate clock policy are enforced, and that expired, wrong-key and
missing gates make no manifest or RPC request. For the valid gate it permits only
the same-origin manifest GET and allowlisted `eth_chainId` POST, verifies RPC
credentials/referrer omission, and confirms that no wallet or fund control is
rendered. The self-signed certificate is ignored only by this ephemeral browser
profile; this is not a production TLS test.

The signed `expiresAt` is also a hard runtime deadline. Manifest verification
must finish before it, in-flight RPC reads are bounded by it, and an open reader
refuses every request after it. Opening a session before expiry therefore does
not extend the gate's authority.

Publication receipts are intentionally absent from browser requests and do not
expand browser authority. Their CLI tests cover signature tampering, key reuse,
checkpoint rollback and same-sequence forks; browser acceptance continues to
exercise only the short-lived online policy that gates reads.
