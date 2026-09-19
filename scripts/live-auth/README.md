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

4. On a separate verification host, verify both files with the public key and an
   explicit review time:

   ```sh
   node scripts/live-auth.mjs verify-bundle \
     --public-key <public-key.pem> \
     --key-generation <positive-integer> \
     --gate <gate.signed.json> \
     --manifest <artifact-manifest.signed.json> \
     --at <review-unix-seconds>
   ```

Only a verified bundle may be considered for the later host-injection review.
Verification does not publish files or validate a real RPC/CORS deployment.

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

Never decrement or reuse a generation, including after a failed or rolled-back
release. The generation is an externally reviewed release counter, not persistent
browser state: serving an entire older frontend build also restores that build's
older trust policy. TLS, immutable release deployment, and an external monotonic
release process must prevent that whole-build rollback.

Revoke a compromised signer by removing the host gate, preserving preview mode,
and producing a reviewed build pinned to a new key. Retaining an old private key
for rollback would also retain authority to sign accepted data for old builds;
key destruction and archival policy must therefore be decided by the release
owners and recorded outside this repository.

The signatures authenticate release authorization, not truth of chain data.
Independent review of the manifest identities, browser support, clock policy,
RPC behavior and operational custody remains mandatory.

## Browser acceptance

The acceptance test uses only ephemeral test keys, a one-day self-signed test
certificate and an HTTPS server bound to `127.0.0.1`. It builds the actual
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

The test proves that Chrome WebCrypto accepts the CLI signatures, that the exact
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
