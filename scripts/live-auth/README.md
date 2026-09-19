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

#### External anti-rollback witness protocol

For the production-oriented path, do not use the unwitnessed `verify` or
`rotate` commands. The witnessed commands bind every proposed transition to a
separate Ed25519 witness chain before changing the filesystem checkpoint. A
reviewed witness configuration fixes a unique random 32-byte `storeId`, a
lowercase witness ID, and an Ed25519 public key ID, generation and raw public
key. The witness key must be independent from every publication and auditor
key.

Bind an existing store once with `bind-witness`, supplying its externally
retained checkpoint hash, current auditor config and reviewed witness config.
The binding is an immutable canonical policy file. Once present, the legacy
unwitnessed `verify` and `rotate` paths fail closed, and every witnessed command
requires the exact pinned witness-config hash, store ID and key identity.

First run `prepare-witnessed-verify` or `prepare-witnessed-rotate` with the same
transition arguments shown above, plus the witness configuration, the prior
witness receipt (or `genesis`), and an exclusive output path. The request binds
the exact prior and next checkpoint hashes, complete unsigned transition-record
hash, transition kind, store ID, witness sequence and predecessor receipt hash.
Preparation is read-only and refuses a locked or pending store. The later commit
recomputes the transition under the exclusive store lock, so a stale request
cannot authorize a different head.

Transfer that canonical request to the independent witness. A reference offline
signer is included for interoperability tests and ceremonies:

```sh
node scripts/publication-quorum-witness.mjs sign-reference \
  --config <witness.json> \
  --private-key <external-ed25519-private.pem> \
  --request <prepared-request.json> \
  --retained-head <genesis-or-prior-receipt.json> \
  --retained-checkpoint-sha256 <witness-retained-checkpoint-sha256> \
  --output <witness-receipt.json>
```

The reference signer checks the direct witness-receipt link and retained
checkpoint before signing, but it deliberately does not implement the external
service's monotonic database. Production signing must run behind an independent
authenticated service/HSM that atomically compare-and-swaps its retained
receipt and checkpoint before releasing a signature. Merely running this
reference command on the collector host provides no anti-rollback property.

`publication-quorum-witness-custody.mjs` provides the offline filesystem CAS
adapter for that independent boundary. Its explicit custody configuration
contains the complete witness configuration and exactly one authorized client
Ed25519 identity. Client and witness keys must differ; there are no fallback
keys, default paths, default heads or unauthenticated requests. Initialize it on
the independent host with the externally reviewed initial checkpoint hash:

```sh
node scripts/publication-quorum-witness-custody.mjs init \
  --store <new-private-custody-directory> \
  --config <custody.json> \
  --initial-checkpoint-sha256 <reviewed-sha256>
```

The collector signs each prepared witness request with its separately held
client key using `authenticate`. Transfer only that authenticated envelope to
the custody host. The custody operator then invokes `authorize` with an explicit
expected external head (`genesis` exactly once, otherwise the prior receipt
SHA-256), custody config, witness key and exclusive receipt output. Authorization
verifies the client signature, store/witness identities, sequence, predecessor
receipt and prior checkpoint before signing.

The custody CAS takes an exclusive inode-checked lock and durably writes a
canonical intent, content-addressed receipt and atomically replaced head with
file/directory fsync and readback. Only after the new head is confirmed does it
release the receipt. A CAS mismatch, invalid signature, oversized input,
symlink, hardlink, unsafe permission, config substitution or pending operation
fails closed. `inspect` reports the retained head and ambiguous markers;
`export` recovers a content-addressed receipt if delivery failed after the head
advanced. In that case export the recorded receipt—never resubmit the request.

This adapter is deliberately transport-neutral and starts no listener. Run it
on a genuinely independent host and place its invocation behind reviewed mTLS,
authorization and audit controls. The private key path is an interoperability
boundary, not an HSM implementation. A privileged administrator or snapshot can
still roll back a filesystem-only custody store, so production must additionally
anchor its head in hardware-backed monotonic or independently append-only
storage. The CLI must not be colocated with the collector or treated as proof
that those operational controls exist.

`publication-quorum-witness-transport.mjs` is the bounded network adapter for
placing that custody command on an independent host. Server and client use
separate exact, versioned configuration files; every address, port, path,
timeout, byte limit, certificate path and SHA-256 certificate pin is mandatory.
Wildcard listen addresses, redirects, TLS below 1.3, keep-alive reuse, fallback
certificates and retry loops are rejected or disabled.

The server requires a CA-validated client certificate and its exact pinned leaf
fingerprint. The client likewise validates the server CA, hostname/IP and exact
leaf fingerprint. This mTLS boundary is additional to the application-level
Ed25519 client signature already checked by custody. Only `POST` to the single
configured path with an exact bounded `Content-Length` is accepted. The server
calls the same durable CAS core in process and returns the signed witness receipt
only after custody confirms its new head.

The client derives a deterministic request ID from the expected head and
authenticated request, sends exactly once, bounds the response and independently
verifies the witness signature, receipt hash, request ID and exact signed
payload before creating its output. An occupied output fails before any network
request. Timeout, disconnect, TLS failure, every non-200 response, an invalid
200 response, or a create-once output race after the call is reported as
potentially ambiguous and is never retried: query `custody inspect`, then recover
the content-addressed receipt with `custody export` when the head advanced.
Even a non-200 can follow a committed CAS whose cleanup failed. Reposting the
same request is intentionally rejected by custody CAS.

`serve` runs in the foreground and provides no daemonization, secret manager,
rate-limit cluster or certificate issuance. Deployment must supply process
isolation, firewalling, audited certificate rotation, HSM-backed witness keys,
monitoring and an external monotonic/append-only head anchor. Repository tests
exercise only an ephemeral loopback mTLS server with throwaway keys and do not
constitute a deployed service.

Before using the client, create an operational preflight manifest with
`publication-quorum-transport-operations.mjs preflight`. It verifies that the
client certificate and private key match, the private key has owner-only
permissions, certificate/CA inputs are regular non-writable files, and the
client certificate is currently valid. The canonical manifest binds the exact
endpoint, server leaf pin, CA file digest, client leaf fingerprint and witness
configuration hash. Review its printed SHA-256 through a separate change-control
channel; do not approve a digest obtained only from the machine being enrolled.

Create a private checkpoint store with `init`, supplying that externally
approved manifest digest and the independently queried custody head. The store
is deliberately inactive. Activation requires a canonical authorization file
that binds the manifest digest and initial head, plus that authorization's
separately reviewed SHA-256:

```sh
node scripts/publication-quorum-transport-operations.mjs preflight \
  --config <client.json> --witness-config <witness.json> \
  --output <new-preflight-manifest.json>
node scripts/publication-quorum-transport-operations.mjs init \
  --store <new-private-operations-directory> \
  --manifest <preflight-manifest.json> \
  --expected-manifest-sha256 <out-of-band-reviewed-sha256> \
  --initial-head-sha256 <genesis-or-independently-queried-receipt-sha256>
node scripts/publication-quorum-transport-operations.mjs activate \
  --store <private-operations-directory> \
  --authorization <canonical-change-authorization.json> \
  --expected-authorization-sha256 <out-of-band-reviewed-sha256>
```

Every transport `request` requires `--operations-store`. Before network I/O it
recomputes the preflight identity, compares the retained head, and durably moves
the checkpoint from `ready` to `pending`. A configuration substitution, rollback,
inactive store or existing pending request fails closed. Only a fully verified
and durably written receipt advances the retained head and returns the store to
`ready`; therefore a timeout or malformed response cannot be retried accidentally.

If delivery was ambiguous, run `inspect`, inspect the independent custody head,
and export its content-addressed receipt. When custody did advance, `reconcile`
accepts the retained preflight manifest, exact authenticated request, prior head,
witness config and exported receipt. It verifies the witness signature and exact
payload before resolving the pending checkpoint. Never reconcile from an
unauthenticated status response, edit `checkpoint.json`, delete the lock, or
initialize a replacement store to bypass `pending`. If custody did not advance,
leave the store blocked until a separately reviewed recovery procedure exists;
this tool intentionally has no "clear pending" command.

The preflight and activation flow is a fail-closed local guard, not certificate
issuance, revocation checking, HSM storage, rollback-proof hardware or deployment
approval. Each certificate rotation requires a new manifest, authorization and
store; the tool does not activate a service or make any connection during
preflight, initialization or activation.

Commit with `witnessed-verify` or `witnessed-rotate`. Supply both the ordinary
expected checkpoint hash and the externally queried witness head hash (or
`genesis` only for the first receipt), the prior receipt, and the new signed
receipt. The collector verifies the signature, store identity, monotonic
sequence, prior receipt, externally retained head and exact re-derived
transition. Its durable content-addressed record contains the complete quorum
transition and witness receipt. A tampered, forked, stale, cross-store or
wrong-key receipt fails before checkpoint mutation.

The external head must be obtained through an authenticated channel directly
from the independent witness for every commit; accepting a value restored from
the same disk defeats rollback detection. This protocol is transport-neutral
and does not itself supply mTLS, HSM custody, service availability, global
gossip or recovery authorization. The original unwitnessed commands remain for
backward-compatible offline review and are not the production path.

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
