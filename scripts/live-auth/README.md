# Offline live-read envelope tooling

This tooling signs and verifies the read-only gate and staging artifact consumed
by the frontend. It does not generate a key, select a deployment, contact a
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
   `VITE_POSTERN_LIVE_READ_PUBLIC_KEY`. This repository supplies no value.

2. Build the unsigned staging artifact with the existing staging pipeline. Move
   the artifact payload into the controlled signing environment and sign it:

   ```sh
   node scripts/live-auth.mjs sign-manifest \
     --private-key <private-key.pem> \
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
     --input <gate-payload.json> \
     --manifest <artifact-manifest.signed.json> \
     --at <review-unix-seconds> \
     --output <gate.signed.json>
   ```

4. On a separate verification host, verify both files with the public key and an
   explicit review time:

   ```sh
   node scripts/live-auth.mjs verify-bundle \
     --public-key <public-key.pem> \
     --gate <gate.signed.json> \
     --manifest <artifact-manifest.signed.json> \
     --at <review-unix-seconds>
   ```

Only a verified bundle may be considered for the later host-injection review.
Verification does not publish files or validate a real RPC/CORS deployment.

## Rotation and recovery

Rotation is intentionally single-key and explicit. Inspect the new public key,
record its key ID in the release review, rebuild the frontend with the new raw
public-key pin, and sign a new gate and manifest with the corresponding private
key. A build pinned to the old key will reject the new bundle and a build pinned
to the new key will reject the old bundle. The runtime has no hidden fallback or
multi-key trust set.

Revoke a compromised signer by removing the host gate, preserving preview mode,
and producing a reviewed build pinned to a new key. Retaining an old private key
for rollback would also retain authority to sign accepted data for old builds;
key destruction and archival policy must therefore be decided by the release
owners and recorded outside this repository.

The signatures authenticate release authorization, not truth of chain data.
Independent review of the manifest identities, browser support, clock policy,
RPC behavior and operational custody remains mandatory.
