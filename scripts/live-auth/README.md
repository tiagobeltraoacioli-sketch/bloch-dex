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
is deliberately inactive. On Linux, initialization builds the store in a
random private staging directory, pins that inode before creating any child or
checkpoint, then publishes the same inode with a no-clobber rename. A raced
public destination is preserved and causes failure. Publication invokes Linux
`renameat2(RENAME_NOREPLACE)` directly through fixed `/usr/bin/python3` code;
the helper runs with `-I -S`, an empty environment and the already pinned
parent descriptor. After publication it syncs that parent and proves its
pathname still identifies the retained descriptor. An absent helper,
unsupported syscall, or invalid flag fails closed without a rename fallback. It addresses every write
through `/proc/self/fd`, and revalidates the root plus both private child
directories after the directory sync. It also requires the exact three-entry
initial namespace and empty history directories both before and after the final
checkpoint read. A concurrent pathname
replacement fails closed: the replacement is never populated, while the
displaced, incomplete tree is preserved for investigation and must not be
activated or retried in place. Activation requires a canonical authorization file
that binds the manifest digest and initial head. The authorization must also
pin an Ed25519 rotation authority as `authorityKeyId`,
`authorityKeyGeneration` and `authorityPublicKeyBase64Url`; its separately
reviewed SHA-256 is the bootstrap trust anchor. Private authority keys are not
stored in the operations store:

```json
{"authorityKeyGeneration":1,"authorityKeyId":"<sha256-of-raw-ed25519-public-key>","authorityPublicKeyBase64Url":"<raw-ed25519-public-key>","authorizationId":"reviewed-bootstrap-1","enabled":true,"expectedHeadSha256":"genesis","manifestSha256":"<approved-preflight-sha256>","schemaVersion":1}
```

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

Every transport `request` requires `--operations-store`,
`--external-anchor-log-adapter <absolute-module.mjs>` and
`--external-anchor-log-config <config.json>`. The owner-controlled,
non-group-writable module must export an async
`createExternalAnchorLogAdapter(config)` factory whose returned adapter exposes
`readLatestHead(query)`. Requiring explicit configuration prevents an adapter
from silently selecting its trust anchors from ambient environment variables.
Immediately before network I/O, while holding the operations lock, the client
passes it an immutable query containing the exact stream ID, checkpoint hash and
generation. The adapter must query an authenticated, independently operated
append-only log and return its latest accepted head in this form:

```json
{"evidence":{"...":"signed operations anchor evidence"},"evidenceSha256":"<sha256>","kind":"operations-anchor-log-head","logSequence":42,"schemaVersion":1,"streamId":"<query streamId>"}
```

The client requires the signed evidence to match the exact audited ready
checkpoint and requires `logSequence` to increase beyond the last accepted
external sequence. Only then does it durably move the checkpoint from `ready`
to `pending`. Before that checkpoint transition, it writes the canonical query
and complete authenticated head as a content-addressed record under the private
`anchor-acceptances/` directory. Each acceptance names the prior acceptance
hash; the checkpoint retains the chain head, record count and latest external
sequence. `audit`, anchor preparation, profile rotation and subsequent requests
walk this chain, verify every content address and evidence signature, require a
single stream and enforce strictly increasing log sequences. Missing, modified,
forked or count-downgraded local evidence therefore blocks further use.

The checkpoint used to build the external query is not trusted merely because
the operations lock still exists. Immediately after the external call returns,
and again after durably retaining the acceptance but before the `pending`
rename, `begin-request` rereads the canonical checkpoint and requires exact
equality with its pre-query snapshot. A non-conforming local writer that
changes the checkpoint during either window therefore cannot have its state
silently overwritten. The changed checkpoint and any already retained
content-addressed acceptance are preserved for inspection; the command does
not merge, roll back, delete, or otherwise guess which state is authoritative.

Absence, timeout, malformed output, stale sequence, wrong stream, bad signature
or mismatched checkpoint fails before either an acceptance or transport state is
committed. The client also
recomputes the preflight identity and compares the retained custody head. A
configuration substitution, rollback, inactive store or existing pending
request therefore fails closed. Only a fully verified
and durably written receipt advances the retained head and returns the store to
`ready`; therefore a timeout or malformed response cannot be retried accidentally.
The final `commit-request` step does not rely on the audit performed before
network I/O. While holding its own exclusive lock, it re-walks the complete
profile-rotation chain and retained external-anchor acceptance chain before
changing `pending` to `ready`. If either history was removed, altered, spliced,
or made unreadable while the request was in flight, receipt commit fails and
the checkpoint remains `pending`. Restore only the exact reviewed,
content-addressed evidence; never bypass the audit by editing the checkpoint or
inventing replacement history.

The repository supplies the strict mTLS client adapter described below, but
does not operate its endpoint, issue credentials or provide a freshness source.
Supplying another module that reads a file on the operations host, caches a
response, trusts an unauthenticated API or merely echoes the query defeats this
gate. A deployment adapter must authenticate the independent log, verify its
own inclusion and consistency semantics, reject equivocation and return only
the live latest head.

The retained acceptance chain is local audit and recovery evidence only. It is
not an independent append-only log, transparency-log consistency proof,
rollback-proof counter or substitute for separately retaining the latest head.
An attacker able to roll back or replace the complete operations directory can
roll back the checkpoint and acceptance records together. Deployment must still
obtain freshness and consistency from the independently operated anchor log.

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
approval. The tool does not activate a service or make any connection during
preflight, initialization, activation or profile rotation.

Every command that mutates an existing operations store creates an exclusive,
durable lock and records its exact canonical bytes and integral inode metadata,
including nanosecond timestamps. Before releasing the active name, the command
revalidates those bytes and metadata through both the still-open descriptor and
the pathname, writes an independent content-addressed recovery copy, creates a
private cleanup directory, and atomically moves the active pathname into that
directory under a 256-bit random basename generated only after the directory is
reserved. The unpublished destination therefore cannot be discovered and
occupied before the rename. The tool then revalidates and fsyncs the moved inode
and both directories.
Cleanup tombstones are intentionally retained instead of unlinked. A substituted,
hard-linked or same-inode rewritten lock, including a substitution in the final
movement window, is therefore preserved for explicit reconciliation rather than
deleted. Every release failure restores the active lock name without overwrite:
first from an accessible tombstone, then from the content-addressed recovery,
and finally by creating the original canonical bytes with `O_EXCL`. An
independently raced occupant already at the active name is preserved as the
poison marker. A retry therefore cannot mutate the store before operator
inspection even if the original active name or staged tombstone was displaced.
Lock reconciliation and retained-evidence inspection read those potentially
mutable files through a fixed 64,001-byte buffer. If a file grows past the
64,000-byte protocol limit after its initial metadata check, the read stops at
the sentinel byte and fails closed; it never follows the post-check file size
into an unbounded allocation. The subsequent descriptor/path metadata checks
still reject truncation, rewrites, relinks and pathname substitution.

Operational state uses a stricter publication sequence than ordinary portable
CLI output. A new checkpoint candidate or content-addressed history record is
created with `O_EXCL`/`O_NOFOLLOW`, written through an open descriptor, fsynced,
and read back through that same descriptor while its inode, ownership, mode,
link count, size and timestamps remain stable. Checkpoint candidates are
published only after that proof; the containing directory is fsynced at every
namespace boundary and the published checkpoint is securely reread. History directories are likewise fsynced after
their durable record. Thus a directory fsync is never treated as a substitute
for first flushing file content.

Publication never uses an overwriting rename. After securely rereading the
exact predecessor, it writes separate mode-`0400`, content-addressed recovery
copies of both the predecessor and candidate, fsyncs the directory, rereads the
predecessor again, then unlinks only that validated pathname. The candidate
recovery copy is a distinct inode, not another hardlink to the temporary file,
so publication can still prove that the final checkpoint is single-link. After
the removal is durable, `link()` conditionally creates `checkpoint.json` from
the already durable temporary candidate: if any writer has occupied the name,
the link fails with `EEXIST` and cannot overwrite it. A successful link and
removal of the temporary alias are each directory-fsynced before the
single-link checkpoint is reread.

If anything fails after predecessor removal, the operation outcome is
ambiguous. The named entry, independent content-addressed candidate and
predecessor recovery copies, and operations lock are preserved even if a
same-UID writer replaces the just-linked name before the temporary alias is
removed. The tool does not select, link, merge, delete or otherwise adopt any
of them; compare all objects and the retained external evidence under a
separately reviewed recovery procedure. This append-and-link protocol
intentionally prefers a recoverable missing-head window over silently
destroying an unexpected same-UID writer's state.

An occupied temporary or content-addressed pathname is preserved, never
truncated or followed. A partial file or failed publication remains crash
evidence for inspection; operators must not delete it merely to retry. These
steps provide the local filesystem ordering required by the workflow, but do
not claim protection from faulty storage that lies about fsync, rollback-proof
hardware, or an independently retained external head.
If the lock is removed, replaced, hardlinked or otherwise changed while an
operation is running, cleanup preserves the observed files and fails closed.
Treat the operation outcome as ambiguous: do not delete either lock path or
retry. Inspect the checkpoint and retained evidence first, then follow a
separately reviewed recovery procedure.

New locks are canonical schema-2 intent records. They bind the operation name
and the canonical SHA-256 of the checkpoint read after exclusive lock creation,
before the operation is allowed to proceed. The PID is diagnostic only. For an
orphaned or deliberately preserved lock, an offline reviewer can classify the
checkpoint against independently approved before/after hashes and emit a
portable receipt:

```sh
node scripts/publication-quorum-transport-operations.mjs reconcile-lock \
  --store <private-operations-directory> \
  --expected-lock-sha256 <authenticated-canonical-lock-sha256> \
  --expected-starting-checkpoint-sha256 <approved-before-sha256> \
  --expected-completed-checkpoint-sha256 <independently-derived-after-sha256> \
  --output <new-lock-reconciliation-receipt.json>
```

The reviewer accepts only the exact lock intent and one of the two approved
checkpoint outcomes, audits the complete retained history, and rereads both
objects before producing the receipt. It supports a preserved hardlink by
recording the observed link count. A substituted pathname, legacy PID-only
lock, malformed lock, unapproved third checkpoint, concurrent change, or audit
failure is rejected. The completed hash must be derived from the authorized
operation inputs; copying the locally observed hash into the command would be
TOFU and defeats the classification.

Reconciliation is intentionally read-only: `lockRemoved` is always false and
neither the primary lock nor any alias is removed. A receipt proves only which
approved checkpoint was observed during this audit. It is not permission to
delete a lock, retry an external side effect, activate the service, or move
funds. Preserve the receipt, its digest, the lock and all aliases for a separate
operator-approved recovery process. Schema-1 PID-only locks predate the bound
starting checkpoint and cannot be reconciled by this command.

Each successful lock release also retains a tombstone in its randomly named
private cleanup directory and an independent content-addressed recovery file.
They are evidence, not garbage-collection candidates. First inspect one exact
pair by copying the two basenames from a separately captured directory listing:

```sh
node scripts/publication-quorum-transport-operations.mjs inspect-lock-evidence \
  --store <private-operations-directory> \
  --cleanup-directory <exact-.operations.lock.cleanup.*-basename> \
  --retained-name <exact-retained-*-basename>
```

The inspection is read-only and explicitly marks its output as unreconciled.
It verifies canonical schema-2 bytes, ownership, release-protocol permissions,
stable inode metadata, the content-addressed recovery name and content, and the
current active-lock relationship. Treat all printed values as untrusted local
observations. Review the lock intent and derive both possible checkpoint hashes
from independently authorized operation inputs; never approve a hash merely
because inspection printed it.

After that independent review, produce a portable receipt with all names,
hashes, checkpoint outcomes and the exact expected active-lock state pinned:

```sh
node scripts/publication-quorum-transport-operations.mjs reconcile-lock-evidence \
  --store <private-operations-directory> \
  --cleanup-directory <externally-recorded-cleanup-basename> \
  --retained-name <externally-recorded-retained-basename> \
  --expected-lock-sha256 <authenticated-canonical-lock-sha256> \
  --expected-starting-checkpoint-sha256 <approved-before-sha256> \
  --expected-completed-checkpoint-sha256 <independently-derived-after-sha256> \
  --expected-active-lock-state <absent-or-exact-alias-state> \
  --output <new-retained-evidence-reconciliation-receipt.json>
```

Reconciliation requires the cleanup directory to contain exactly the approved
tombstone, requires the recovery and tombstone bytes to agree, audits the
retained checkpoint history, and rereads every object after the audit. Private
snapshots compare the complete device, inode, mode, owner, group, link count,
size, nanosecond mtime and nanosecond ctime identity of the store directory,
cleanup directory, tombstone, recovery and optional active lock across that
audit. Every rotation and anchor-acceptance record used by the audit is likewise
retained as exact canonical bytes plus integral metadata and reread after the
audit; a same-inode rewrite therefore fails even if valid content is restored.
Open directory descriptors pin both directories while every child is
read. Linux uses `/proc/self/fd` descriptor-relative child paths and revalidates
membership and pathname identities after each boundary; other platforms fail
closed before inspecting retained evidence.
`same`
is not an accepted shorthand: choose `absent`, `tombstone-alias`,
`recovery-alias`, or `independent-copy` to bind the precise active pathname
relationship and exact expected link counts created by the release failure
fallback. Extra hardlinks are rejected. An independent occupant
with other content is rejected and preserved. Any extra directory entry,
symlink, permission change, third checkpoint outcome, content mismatch or
concurrent namespace change fails closed. Both commands reject path traversal
by accepting only release-protocol basenames.

This command never unlinks, renames, overwrites, adopts or garbage-collects an
artifact. Its receipt fixes `filesRemoved` and `retryAuthorized` to `false`.
The create-once receipt output must resolve outside the operations store and
all of its evidence paths. Before evidence is read, Linux pins both trees,
reserves the output name with `O_EXCL`, and later publishes only through that
descriptor and its pinned parent; a failed reconciliation can therefore leave
an empty reserved output that must be preserved and investigated. Platforms
without strong descriptor-relative child access fail closed for this workflow.
There is deliberately no automatic or age-based cleanup: storage retention,
external archival and any later deletion require a distinct reviewed policy
that can account for all aliases and receipts without destroying ambiguous
evidence.

After the reconciliation receipt has itself been exported and authenticated
over an independent channel, an offline operator may prepare a non-executable
cleanup plan:

```sh
node scripts/publication-quorum-transport-operations.mjs prepare-lock-evidence-cleanup \
  --store <private-operations-directory> \
  --reconciliation-receipt <externally-retained-canonical-receipt.json> \
  --expected-reconciliation-receipt-sha256 <authenticated-receipt-sha256> \
  --output <new-cleanup-plan.json>
```

The command verifies the exact external receipt hash before using any receipt
field, requires its active-lock state to be `absent`, and then reruns the full
retained-evidence reconciliation against the current store. The newly observed
receipt must reproduce the approved receipt exactly. A changed checkpoint,
new lock, alias, extra directory entry, rewritten inode, or missing artifact
therefore fails closed. The plan pins the only tombstone and recovery basenames
that a future reviewed cleanup protocol could consider, but deliberately sets
`deletionAuthorized`, `executionSupported`, `filesRemoved`, and
`retryAuthorized` to `false`. It never unlinks or modifies evidence and is not
authorization to retry an operation. There is currently no cleanup executor;
the plan and all evidence must remain preserved pending a separate archival and
deletion policy.

All external files consumed by this workflow share a bounded pinned-input
reader. It reads at most the 64,000-byte (64 kB) protocol limit plus one
detection byte and
compares device, inode, mode, ownership, link count, size, nanosecond mtime and
nanosecond ctime across the open descriptor and the closing pathname. Growth,
same-inode rewriting, pathname replacement, symlinks and hardlinks therefore
fail closed before an artifact can influence a plan or receipt; a raced file is
left untouched for investigation.

`prepare-anchor` applies the same output separation rule as reconciliation:
on Linux it pins the operations store and the output parent, requires the
create-once output to be outside the entire store tree, and reserves that name
before auditing any checkpoint or history record. The configured store path
must be canonical (not a symlink alias), and the pinned store must retain exact
mode `0700`. The audit itself addresses
the store through that pinned descriptor. The statement is published only
through an `O_RDWR` reserved descriptor after the store identity, output parent
and still-empty output are revalidated. Mode `0444` is set explicitly, and the
complete published bytes are read back and matched across descriptor/path
snapshots both before and after the output-parent directory sync. Normal lock
bookkeeping may change store
membership, but replacement of the pinned store is rejected. An occupied name,
directory substitution, output rewrite, or attempt to place the statement in
the store therefore fails closed. An audit failure leaves an empty reservation;
any publication failure may leave a non-authoritative artifact. In either case
the reserved path must be preserved and investigated, and its bytes must not be
consumed unless the command reported success.

### Pinned mTLS profile rotation

Generate the replacement preflight manifest first and approve its digest over
an independent channel. `prepare-rotation` binds that manifest to the current
manifest, custody head, monotonically increasing rotation sequence, previous
rotation-record hash, current authority and a distinct next authority whose key
generation increases. It durably stores the canonical rotation and moves the
checkpoint to `rotating`. Transport requests then fail closed until the complete
rotation record and replacement checkpoint have both been durably committed:

```sh
node scripts/publication-quorum-transport-operations.mjs prepare-rotation \
  --store <private-operations-directory> \
  --prior-manifest <current-preflight-manifest.json> \
  --next-manifest <replacement-preflight-manifest.json> \
  --expected-next-manifest-sha256 <out-of-band-reviewed-sha256> \
  --next-authority-public-key <next-offline-ed25519-public.pem> \
  --next-authority-key-generation <greater-positive-integer>
node scripts/publication-quorum-transport-operations.mjs inspect-rotation \
  --store <private-operations-directory>
```

The old authority independently issues `prior-authorization`; the new
authority issues `next-acceptance`. Both signatures are domain- and role-bound
to the exact same rotation. Create each output once on the appropriate isolated
operator host, then commit both envelopes:

```sh
node scripts/publication-quorum-transport-operations.mjs authorize-rotation \
  --rotation <store/rotations/printed-rotation-sha256.json> \
  --role prior-authorization \
  --private-key <old-offline-ed25519-private.pem> --key-generation <current> \
  --output <new-prior-authorization.json>
node scripts/publication-quorum-transport-operations.mjs authorize-rotation \
  --rotation <store/rotations/printed-rotation-sha256.json> \
  --role next-acceptance \
  --private-key <next-offline-ed25519-private.pem> --key-generation <greater> \
  --output <new-next-acceptance.json>
node scripts/publication-quorum-transport-operations.mjs commit-rotation \
  --store <private-operations-directory> \
  --prior-manifest <current-preflight-manifest.json> \
  --next-manifest <replacement-preflight-manifest.json> \
  --rotation <store/rotations/printed-rotation-sha256.json> \
  --prior-authorization <prior-authorization.json> \
  --next-acceptance <next-acceptance.json>
```

There is intentionally no cancel, force, rollback or unsigned migration path.
An invalid, incomplete or interrupted rotation remains blocked in `rotating`;
use `inspect` and `inspect-rotation`, recover the two exact authorizations, and
repeat only `commit-rotation`. Never edit the checkpoint or replace the store.
Run a full local chain audit after copying or restoring an operations store:

```sh
node scripts/publication-quorum-transport-operations.mjs audit \
  --store <private-operations-directory>
```

`audit` walks from the retained checkpoint to genesis, verifies every
content-addressed record and both role-bound signatures, and checks exact
sequence, manifest and authority continuity. It also verifies a pending
rotation against the retained checkpoint. Starting transport, preparing a new
rotation and committing a rotation repeat the committed-chain audit while
holding the store lock, so a missing, modified or spliced historical record
blocks the operation before network I/O or checkpoint mutation. Retain the
complete `rotations/` directory; pruning is not supported.

The hash chain prevents replaying an old profile or forking a sequence and the
audit detects local chain damage, but an external append-only anchor is still
required to detect a self-consistent whole-store rollback. Export a statement
only while the checkpoint is `ready`, sign it on the authority's isolated host,
and publish the resulting evidence to an independently operated append-only
log:

```sh
node scripts/publication-quorum-transport-operations.mjs prepare-anchor \
  --store <private-operations-directory> \
  --output <new-anchor-statement.json>
node scripts/publication-quorum-transport-operations.mjs sign-anchor \
  --statement <new-anchor-statement.json> \
  --private-key <current-offline-ed25519-private.pem> \
  --key-generation <current> \
  --output <new-anchor-evidence.json>
node scripts/publication-quorum-transport-operations.mjs verify-anchor \
  --store <private-operations-directory> \
  --evidence <latest-evidence-fetched-from-external-log.json>
```

The statement commits to a deterministic stream ID derived from the audited
genesis manifest and authority, plus the canonical checkpoint hash, checkpoint
generation, custody head, manifest, complete rotation-chain tip and current authority. The
signature is domain- and role-bound and must match that retained authority.
`verify-anchor` repeats the complete rotation-chain audit and requires exact
equality with the current ready checkpoint. The transport path performs that
same verification through the injected latest-head adapter and additionally
retains the accepted external log sequence.

`publication-quorum-anchor-log-mtls.mjs` is the supplied fail-closed
latest-head adapter. Its exact configuration requires a unicast numeric IP
(hostnames and therefore runtime DNS are refused), port, path, absolute
deadline, response byte limit, server CA, exact server leaf SHA-256 pin, client
certificate and owner-only client key. Construction verifies the certificate
and key pair, validity windows and CA role. Each query uses a new TLS 1.3-only
mutually authenticated connection, canonical JSON with an exact
`Content-Length`, no connection pool, redirect, fallback or retry, and checks
the canonical bounded response before returning it to the operations guard.
The absolute deadline covers connection, handshake and response processing.

Use the adapter only through its securely loaded absolute path and a separately
reviewed configuration file:

```sh
node scripts/publication-quorum-witness-transport.mjs request \
  --config <custody-client.json> \
  --witness-config <witness.json> \
  --operations-store <private-operations-directory> \
  --external-anchor-log-adapter \
    <absolute-repository-path>/scripts/publication-quorum-anchor-log-mtls.mjs \
  --external-anchor-log-config <reviewed-anchor-log-client.json> \
  --authenticated-request <envelope.json> \
  --expected-head-sha256 <genesis-or-prior-receipt-sha256> \
  --output <new-receipt.json>
```

The loader rejects relative paths, symlinks, hardlinks, foreign ownership,
group/world-writable modules and modules that change during import. It requires
an explicit factory so configuration cannot be silently taken from ambient
environment variables. Treat both the adapter module digest and canonical
configuration digest as deployment trust anchors approved outside this host.
The adapter authenticates one log endpoint; it does not prove independent
operation, global consistency, inclusion, availability, anti-rollback storage,
certificate revocation or correct server implementation. Those remain external
production and audit requirements.

The evidence file is portable proof, not an external store. Keeping it beside
the operations store provides no rollback protection: a rollback can restore
both files. An operator must publish each newer evidence object outside this
host and fetch the latest accepted object for that exact stream ID from the
independent append-only system for verification. The external system must
enforce increasing checkpoint generations and reject a second checkpoint hash
for an already accepted generation. The core does not claim log inclusion, log
consistency, availability or freshness on behalf of an adapter. The adapter is
an explicit deployment trust boundary and must establish those properties
before returning. A locally supplied evidence file is not a conforming adapter
and is not deployment approval.
This release uses operations-checkpoint schema 4. Schema-3 stores fail closed.
Never edit `checkpoint.json` in place. A schema-3 store that has never accepted
an external anchor head (`externalAnchorSequence` is `null`) can be migrated
offline into a new directory after obtaining its exact canonical checkpoint
SHA-256 through a separate authenticated review:

```sh
node scripts/publication-quorum-transport-operations.mjs migrate-v3-to-v4 \
  --source-store <reviewed-schema-3-store> \
  --destination-store <new-nonexistent-schema-4-store> \
  --expected-v3-checkpoint-sha256 <externally-approved-sha256>
```

The command takes the source operations lock, rejects a hash mismatch rather
than adopting local state, audits and copies the complete referenced rotation
chain, writes a canonical migration record containing the old checkpoint, and
writes the schema-4 checkpoint last. The source is never modified apart from
the temporary operations lock and remains the unambiguous backup. The
destination must not exist and neither path may contain the other; an
interrupted attempt leaves an occupied but
non-runnable directory for manual inspection and must not be resumed or
silently replaced.

Before using the new store, copy the preserved source and completed destination
to a separate offline review environment, transfer the three expected digests
over an authenticated channel, and create a canonical verification receipt:

```sh
node scripts/publication-quorum-transport-operations.mjs verify-v3-to-v4 \
  --source-store <review-copy-of-schema-3-store> \
  --destination-store <review-copy-of-schema-4-store> \
  --expected-v3-checkpoint-sha256 <externally-approved-source-sha256> \
  --expected-v4-checkpoint-sha256 <externally-approved-destination-sha256> \
  --expected-migration-record-sha256 <externally-approved-record-sha256> \
  --output <new-verification-receipt.json>
```

The verifier does not change either checkpoint or its history. It takes the
same exclusive operations lock on both stores, in deterministic canonical-path
order, for the entire audit. This blocks conforming writers without creating a
cross-verifier deadlock and rejects an already active operation. As with every
operations command, a process or host crash can leave a lock that requires
manual inspection; never delete one merely to bypass an uncertain outcome. The
verifier rejects nested store paths, independently revalidates the source
rotation history, rederives the exact schema-4 checkpoint, binds the canonical
migration record to both stores, audits the copied destination, and rereads all
three objects before releasing the locks. The output digest printed to stdout
authenticates the portable receipt. Store that receipt and its digest outside
both operations trees. A receipt kept only beside the destination does not
provide rollback protection, and the expected hashes are review inputs rather
than values the verifier is allowed to adopt from local disk.

A schema-3 store with a non-null external anchor sequence cannot be migrated:
schema 3 did not retain the authenticated acceptance chain required by schema
4. Resetting that sequence, inventing records, or trusting a locally supplied
head would permit rollback. Retain that store for audit and bootstrap a new,
separately reviewed schema-4 store from an independently queried custody and
anchor-log state instead. This command performs no network access, activation,
transport request, deployment, or fund movement.

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
