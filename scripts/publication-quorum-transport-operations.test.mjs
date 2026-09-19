import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalSha256, describeKey } from "./live-auth/envelope.mjs";
import {
  activateOperationsStore,
  beginTransportRequest,
  buildClientPreflight,
  commitTransportRequest,
  initializeOperationsStore,
  inspectOperationsStore,
} from "./publication-quorum-transport-operations.mjs";

const execute = promisify(execFile);

async function certificate(root, name) {
  const key = join(root, `${name}.key`);
  const cert = join(root, `${name}.crt`);
  await execute("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-subj", `/CN=${name}`,
    "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1",
  ]);
  await chmod(key, 0o600);
  await chmod(cert, 0o444);
  return { key, cert };
}

function witnessConfig() {
  const keys = generateKeyPairSync("ed25519");
  const identity = describeKey(keys.publicKey);
  return {
    schemaVersion: 1,
    storeId: "1".repeat(64),
    witnessId: "external-witness",
    keyId: identity.keyId,
    keyGeneration: 1,
    publicKeyBase64Url: identity.publicKeyBase64Url,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "postern-transport-operations-"));
  const server = await certificate(root, "server");
  const client = await certificate(root, "client");
  const config = {
    schemaVersion: 1,
    endpoint: {
      host: "127.0.0.1", port: 9443, path: "/v1/authorize",
      timeoutMs: 5_000, maxBodyBytes: 65_536,
    },
    serverCertificateSha256: "a".repeat(64),
    serverCaCertificatePath: server.cert,
    tlsCertificatePath: client.cert,
    tlsPrivateKeyPath: client.key,
  };
  return { root, server, client, config, witness: witnessConfig() };
}

test("preflight rejects unsafe key permissions and a certificate/key substitution", async () => {
  const value = await fixture();
  await chmod(value.client.key, 0o644);
  await assert.rejects(
    buildClientPreflight(value.config, value.witness),
    /must not grant group or other permissions/,
  );
  await chmod(value.client.key, 0o600);
  const rogue = await certificate(value.root, "rogue");
  await assert.rejects(
    buildClientPreflight({ ...value.config, tlsPrivateKeyPath: rogue.key }, value.witness),
    /does not match the client certificate/,
  );
});

test("operations checkpoint refuses TOFU, activation drift, rollback, and ambiguous retry", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const manifestHash = canonicalSha256(manifest);
  await assert.rejects(
    initializeOperationsStore(join(value.root, "tofu"), manifest, "0".repeat(64), "genesis"),
    /refusing TOFU/,
  );

  const store = join(value.root, "operations");
  await initializeOperationsStore(store, manifest, manifestHash, "genesis");
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "1".repeat(64)),
    /inactive/,
  );
  const authorization = {
    schemaVersion: 1,
    authorizationId: "reviewed-change-1",
    manifestSha256: manifestHash,
    expectedHeadSha256: "genesis",
    enabled: true,
  };
  await assert.rejects(
    activateOperationsStore(store, authorization, "2".repeat(64)),
    /does not match the externally approved hash/,
  );
  await activateOperationsStore(store, authorization, canonicalSha256(authorization));

  await assert.rejects(
    beginTransportRequest(store, "3".repeat(64), "genesis", "4".repeat(64)),
    /runtime configuration differs/,
  );
  await beginTransportRequest(store, manifestHash, "genesis", "4".repeat(64));
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "4".repeat(64)),
    /prior outcome is ambiguous.*never retry/,
  );
  const pending = await inspectOperationsStore(store);
  assert.equal(pending.status, "pending");
  assert.equal(pending.pendingRequestId, "4".repeat(64));

  await commitTransportRequest(store, "4".repeat(64), "5".repeat(64));
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "6".repeat(64)),
    /stale or rolled back/,
  );
  const committed = await inspectOperationsStore(store);
  assert.equal(committed.expectedHeadSha256, "5".repeat(64));
  assert.equal(committed.generation, 3);
});

test("preflight manifest deterministically binds endpoint, pins, certificate, CA, and witness", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  assert.equal(manifest.role, "publication-quorum-witness-client");
  assert.match(manifest.clientCertificateSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.serverCaFileSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.serverCertificateSha256, value.config.serverCertificateSha256);
  assert.equal(
    canonicalSha256(manifest),
    canonicalSha256(await buildClientPreflight(value.config, value.witness)),
  );
  assert.ok((await readFile(value.client.cert)).length > 0);
});
