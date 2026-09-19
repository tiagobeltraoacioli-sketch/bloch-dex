import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, link, lstat, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, canonicalSha256, describeKey } from "./live-auth/envelope.mjs";
import {
  activateOperationsStore,
  auditOperationsStore,
  authorizeOperationsRotation,
  beginTransportRequest,
  buildClientPreflight,
  commitOperationsRotation,
  commitTransportRequest,
  initializeOperationsStore,
  inspectPendingRotation,
  inspectOperationsStore,
  migrateOperationsStoreV3ToV4,
  prepareOperationsRotation,
  prepareOperationsAnchorStatement,
  reconcileOperationsLock,
  signOperationsAnchorStatement,
  verifyOperationsAnchorEvidence,
  verifyOperationsStoreV3ToV4Migration,
} from "./publication-quorum-transport-operations.mjs";

const execute = promisify(execFile);

async function certificate(root, name) {
  const key = join(root, `${name}.key`);
  const cert = join(root, `${name}.crt`);
  await execute("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-subj", `/CN=${name}`,
    "-addext", "subjectAltName=IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:TRUE", "-days", "1",
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
  return {
    root,
    server,
    client,
    config,
    witness: witnessConfig(),
    authority: generateKeyPairSync("ed25519"),
  };
}

async function externalAnchorLog(store, privateKey, keyGeneration, logSequence) {
  const statement = await prepareOperationsAnchorStatement(store);
  const evidence = signOperationsAnchorStatement(statement, privateKey, keyGeneration);
  const head = {
    schemaVersion: 1,
    kind: "operations-anchor-log-head",
    streamId: statement.streamId,
    logSequence,
    evidenceSha256: canonicalSha256(evidence),
    evidence,
  };
  return { readLatestHead: async () => structuredClone(head) };
}

async function downgradeFixtureCheckpointToV3(store, overrides = {}) {
  const path = join(store, "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  delete checkpoint.externalAnchorAcceptanceCount;
  delete checkpoint.externalAnchorAcceptanceSha256;
  checkpoint.schemaVersion = 3;
  Object.assign(checkpoint, overrides);
  await chmod(path, 0o600);
  await writeFile(path, `${canonicalJson(checkpoint)}\n`, { mode: 0o600 });
  await chmod(path, 0o400);
  return checkpoint;
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

test("migrates an explicitly approved schema-3 checkpoint into a separate audited schema-4 store", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const manifestHash = canonicalSha256(manifest);
  const source = join(value.root, "schema-3-source");
  const destination = join(value.root, "schema-4-destination");
  await initializeOperationsStore(source, manifest, manifestHash, "genesis");
  const priorIdentity = describeKey(value.authority.publicKey);
  const activation = {
    schemaVersion: 1,
    authorizationId: "migration-bootstrap",
    manifestSha256: manifestHash,
    expectedHeadSha256: "genesis",
    enabled: true,
    authorityKeyId: priorIdentity.keyId,
    authorityKeyGeneration: 1,
    authorityPublicKeyBase64Url: priorIdentity.publicKeyBase64Url,
  };
  await activateOperationsStore(source, activation, canonicalSha256(activation));
  const nextManifest = { ...manifest, serverCertificateSha256: "9".repeat(64) };
  const nextKeys = generateKeyPairSync("ed25519");
  const nextIdentity = describeKey(nextKeys.publicKey);
  const prepared = await prepareOperationsRotation({
    root: source,
    priorManifest: manifest,
    nextManifest,
    expectedNextManifestSha256: canonicalSha256(nextManifest),
    nextAuthority: { ...nextIdentity, keyGeneration: 2 },
  });
  await commitOperationsRotation({
    root: source,
    priorManifest: manifest,
    nextManifest,
    rotation: prepared.rotation,
    priorAuthorization: authorizeOperationsRotation(
      prepared.rotation, "prior-authorization", value.authority.privateKey, 1,
    ),
    nextAcceptance: authorizeOperationsRotation(
      prepared.rotation, "next-acceptance", nextKeys.privateKey, 2,
    ),
  });
  const v3 = await downgradeFixtureCheckpointToV3(source);
  const expectedV3Hash = canonicalSha256(v3);

  const result = await migrateOperationsStoreV3ToV4({
    sourceRoot: source,
    destinationRoot: destination,
    expectedV3CheckpointSha256: expectedV3Hash,
  });
  assert.equal(result.sourceCheckpointSha256, expectedV3Hash);
  assert.equal(result.sourcePreserved, true);
  assert.equal(result.audit.valid, true);
  assert.equal(result.audit.verifiedRecords, 1);
  assert.equal(result.audit.verifiedAnchorAcceptances, 0);
  const retainedSource = JSON.parse(await readFile(join(source, "checkpoint.json"), "utf8"));
  assert.deepEqual(retainedSource, v3);
  const migrated = await inspectOperationsStore(destination);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.externalAnchorSequence, null);
  assert.equal(migrated.externalAnchorAcceptanceCount, 0);
  assert.equal(migrated.externalAnchorAcceptanceSha256, null);
  const { lockPresent, ...migratedCheckpoint } = migrated;
  assert.equal(lockPresent, false);
  assert.equal(canonicalSha256(migratedCheckpoint), result.destinationCheckpointSha256);
  const migration = JSON.parse(await readFile(
    join(destination, "migration-v3-checkpoint.json"),
    "utf8",
  ));
  assert.equal(migration.sourceCheckpointSha256, expectedV3Hash);
  assert.deepEqual(migration.sourceCheckpoint, v3);
  const sourceLock = join(source, ".operations.lock");
  const destinationLock = join(destination, ".operations.lock");
  await writeFile(sourceLock, "occupied", { mode: 0o600 });
  await assert.rejects(
    verifyOperationsStoreV3ToV4Migration({
      sourceRoot: source,
      destinationRoot: destination,
      expectedV3CheckpointSha256: expectedV3Hash,
      expectedV4CheckpointSha256: result.destinationCheckpointSha256,
      expectedMigrationRecordSha256: result.migrationRecordSha256,
    }),
    /operations store is locked/,
  );
  await unlink(sourceLock);
  await writeFile(destinationLock, "occupied", { mode: 0o600 });
  await assert.rejects(
    verifyOperationsStoreV3ToV4Migration({
      sourceRoot: source,
      destinationRoot: destination,
      expectedV3CheckpointSha256: expectedV3Hash,
      expectedV4CheckpointSha256: result.destinationCheckpointSha256,
      expectedMigrationRecordSha256: result.migrationRecordSha256,
    }),
    /operations store is locked/,
  );
  await assert.rejects(lstat(sourceLock), { code: "ENOENT" });
  await unlink(destinationLock);
  const verificationReceipt = await verifyOperationsStoreV3ToV4Migration({
    sourceRoot: source,
    destinationRoot: destination,
    expectedV3CheckpointSha256: expectedV3Hash,
    expectedV4CheckpointSha256: result.destinationCheckpointSha256,
    expectedMigrationRecordSha256: result.migrationRecordSha256,
  });
  assert.equal(
    verificationReceipt.kind,
    "operations-checkpoint-v3-v4-verification-receipt",
  );
  assert.equal(verificationReceipt.sourcePreserved, true);
  assert.equal(verificationReceipt.copiedRotationRecordCount, 1);
  assert.equal(verificationReceipt.destinationAudit.valid, true);
  assert.equal(verificationReceipt.destinationAudit.verifiedRecords, 1);
  await assert.rejects(lstat(sourceLock), { code: "ENOENT" });
  await assert.rejects(lstat(destinationLock), { code: "ENOENT" });

  const tamperedMigration = {
    ...migration,
    copiedRotationRecordCount: migration.copiedRotationRecordCount + 1,
  };
  const migrationPath = join(destination, "migration-v3-checkpoint.json");
  await chmod(migrationPath, 0o600);
  await writeFile(migrationPath, `${canonicalJson(tamperedMigration)}\n`, { mode: 0o600 });
  await chmod(migrationPath, 0o400);
  await assert.rejects(
    verifyOperationsStoreV3ToV4Migration({
      sourceRoot: source,
      destinationRoot: destination,
      expectedV3CheckpointSha256: expectedV3Hash,
      expectedV4CheckpointSha256: result.destinationCheckpointSha256,
      expectedMigrationRecordSha256: canonicalSha256(tamperedMigration),
    }),
    /does not bind the verified source and destination/,
  );
  await assert.rejects(lstat(sourceLock), { code: "ENOENT" });
  await assert.rejects(lstat(destinationLock), { code: "ENOENT" });
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: destination,
      expectedV3CheckpointSha256: expectedV3Hash,
    }),
    { code: "EEXIST" },
  );
});

test("schema-3 migration refuses TOFU, in-place replacement, and missing acceptance history", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const manifestHash = canonicalSha256(manifest);
  const source = join(value.root, "unsafe-schema-3-source");
  await initializeOperationsStore(source, manifest, manifestHash, "genesis");
  const v3 = await downgradeFixtureCheckpointToV3(source);
  const expectedV3Hash = canonicalSha256(v3);
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: join(value.root, "wrong-hash-destination"),
      expectedV3CheckpointSha256: "0".repeat(64),
    }),
    /refusing TOFU/,
  );
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: source,
      expectedV3CheckpointSha256: expectedV3Hash,
    }),
    /separate non-nested trees/,
  );
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: join(source, "nested-destination"),
      expectedV3CheckpointSha256: expectedV3Hash,
    }),
    /separate non-nested trees/,
  );
  const sourceAlias = join(value.root, "schema-3-source-alias");
  await symlink(source, sourceAlias, "dir");
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: join(sourceAlias, "nested-through-symlink"),
      expectedV3CheckpointSha256: expectedV3Hash,
    }),
    /separate non-nested trees/,
  );
  await assert.rejects(lstat(join(source, "nested-through-symlink")), { code: "ENOENT" });
  const accepted = await downgradeFixtureCheckpointToV3(source, {
    externalAnchorSequence: 7,
  });
  await assert.rejects(
    migrateOperationsStoreV3ToV4({
      sourceRoot: source,
      destinationRoot: join(value.root, "history-destination"),
      expectedV3CheckpointSha256: canonicalSha256(accepted),
    }),
    /safe migration is impossible/,
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
    authorityKeyId: describeKey(value.authority.publicKey).keyId,
    authorityKeyGeneration: 1,
    authorityPublicKeyBase64Url: describeKey(value.authority.publicKey).publicKeyBase64Url,
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
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "4".repeat(64)),
    /authenticated external anchor log adapter is required/,
  );
  const anchorLog = await externalAnchorLog(store, value.authority.privateKey, 1, 7);
  await beginTransportRequest(store, manifestHash, "genesis", "4".repeat(64), anchorLog);
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "4".repeat(64)),
    /prior outcome is ambiguous.*never retry/,
  );
  const pending = await inspectOperationsStore(store);
  assert.equal(pending.status, "pending");
  assert.equal(pending.pendingRequestId, "4".repeat(64));
  assert.equal(pending.externalAnchorSequence, 7);
  assert.equal(pending.externalAnchorAcceptanceCount, 1);
  assert.match(pending.externalAnchorAcceptanceSha256, /^[0-9a-f]{64}$/);
  assert.equal((await auditOperationsStore(store)).verifiedAnchorAcceptances, 1);
  const acceptancePath = join(
    store,
    "anchor-acceptances",
    `${pending.externalAnchorAcceptanceSha256}.json`,
  );
  const acceptanceBytes = await readFile(acceptancePath);
  assert.ok(acceptanceBytes.length > 0);

  await unlink(acceptancePath);
  await assert.rejects(
    commitTransportRequest(store, "4".repeat(64), "5".repeat(64)),
    { code: "ENOENT" },
  );
  assert.equal((await inspectOperationsStore(store)).status, "pending");
  await writeFile(acceptancePath, acceptanceBytes, { flag: "wx", mode: 0o400 });

  const acceptance = JSON.parse(acceptanceBytes.toString("utf8"));
  await chmod(acceptancePath, 0o600);
  await writeFile(
    acceptancePath,
    `${canonicalJson({ ...acceptance, injected: true })}\n`,
  );
  await chmod(acceptancePath, 0o400);
  await assert.rejects(
    commitTransportRequest(store, "4".repeat(64), "5".repeat(64)),
    /external anchor acceptance fields are invalid/,
  );
  assert.equal((await inspectOperationsStore(store)).status, "pending");
  await chmod(acceptancePath, 0o600);
  await writeFile(acceptancePath, acceptanceBytes);
  await chmod(acceptancePath, 0o400);

  await commitTransportRequest(store, "4".repeat(64), "5".repeat(64));
  await assert.rejects(
    beginTransportRequest(store, manifestHash, "genesis", "6".repeat(64)),
    /stale or rolled back/,
  );
  const committed = await inspectOperationsStore(store);
  assert.equal(committed.expectedHeadSha256, "5".repeat(64));
  assert.equal(committed.generation, 3);
});

test("operations lock release preserves hardlinked or substituted locks", async (context) => {
  async function activatedStore(name) {
    const value = await fixture();
    const manifest = await buildClientPreflight(value.config, value.witness);
    const manifestHash = canonicalSha256(manifest);
    const store = join(value.root, name);
    await initializeOperationsStore(store, manifest, manifestHash, "genesis");
    const identity = describeKey(value.authority.publicKey);
    const authorization = {
      schemaVersion: 1,
      authorizationId: `${name}-bootstrap`,
      manifestSha256: manifestHash,
      expectedHeadSha256: "genesis",
      enabled: true,
      authorityKeyId: identity.keyId,
      authorityKeyGeneration: 1,
      authorityPublicKeyBase64Url: identity.publicKeyBase64Url,
    };
    await activateOperationsStore(store, authorization, canonicalSha256(authorization));
    const anchorLog = await externalAnchorLog(store, value.authority.privateKey, 1, 1);
    return { store, manifestHash, anchorLog };
  }

  await context.test("hardlink race", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("hardlink-lock");
    const lockPath = join(store, ".operations.lock");
    const aliasPath = join(store, ".operations.lock.alias");
    const starting = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const racingAnchorLog = {
      readLatestHead: async (query) => {
        await link(lockPath, aliasPath);
        return anchorLog.readLatestHead(query);
      },
    };
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "7".repeat(64), racingAnchorLog,
      ),
      /operations lock identity changed; preserve state and inspect/,
    );
    assert.equal((await lstat(lockPath)).nlink, 2);
    assert.equal((await lstat(aliasPath)).nlink, 2);
    assert.equal((await inspectOperationsStore(store)).status, "pending");
    const completed = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(lock.schemaVersion, 2);
    assert.equal(lock.operation, "begin-request");
    assert.equal(lock.startingCheckpointSha256, canonicalSha256(starting));
    const receipt = await reconcileOperationsLock({
      root: store,
      expectedLockSha256: canonicalSha256(lock),
      expectedStartingCheckpointSha256: canonicalSha256(starting),
      expectedCompletedCheckpointSha256: canonicalSha256(completed),
    });
    assert.equal(receipt.kind, "operations-lock-reconciliation-receipt");
    assert.equal(receipt.outcome, "committed");
    assert.equal(receipt.lockLinkCount, 2);
    assert.equal(receipt.lockRemoved, false);
    assert.equal((await lstat(lockPath)).nlink, 2);
    await assert.rejects(
      reconcileOperationsLock({
        root: store,
        expectedLockSha256: "9".repeat(64),
        expectedStartingCheckpointSha256: canonicalSha256(starting),
        expectedCompletedCheckpointSha256: canonicalSha256(completed),
      }),
      /lock does not match the externally approved hash/,
    );
    await assert.rejects(
      reconcileOperationsLock({
        root: store,
        expectedLockSha256: canonicalSha256(lock),
        expectedStartingCheckpointSha256: canonicalSha256(starting),
        expectedCompletedCheckpointSha256: "8".repeat(64),
      }),
      /checkpoint matches neither externally approved outcome/,
    );
  });

  await context.test("pre-commit failure is classified without removing the lock", async () => {
    const { store, manifestHash } = await activatedStore("uncommitted-lock");
    const lockPath = join(store, ".operations.lock");
    const aliasPath = join(store, ".operations.lock.alias");
    const starting = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const racingAnchorLog = {
      readLatestHead: async () => {
        await link(lockPath, aliasPath);
        throw new Error("independent anchor unavailable");
      },
    };
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "a".repeat(64), racingAnchorLog,
      ),
      /operations lock identity changed; preserve state and inspect/,
    );
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const receipt = await reconcileOperationsLock({
      root: store,
      expectedLockSha256: canonicalSha256(lock),
      expectedStartingCheckpointSha256: canonicalSha256(starting),
      expectedCompletedCheckpointSha256: "b".repeat(64),
    });
    assert.equal(receipt.outcome, "not-committed");
    assert.equal(receipt.observedCheckpointSha256, canonicalSha256(starting));
    assert.equal(receipt.lockRemoved, false);
    assert.equal((await lstat(lockPath)).nlink, 2);
  });

  await context.test("pathname substitution race", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("substituted-lock");
    const lockPath = join(store, ".operations.lock");
    const displacedPath = join(store, ".operations.lock.displaced");
    const replacement = "replacement lock must be preserved\n";
    const racingAnchorLog = {
      readLatestHead: async (query) => {
        await rename(lockPath, displacedPath);
        await writeFile(lockPath, replacement, { mode: 0o600, flag: "wx" });
        return anchorLog.readLatestHead(query);
      },
    };
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "8".repeat(64), racingAnchorLog,
      ),
      /operations lock identity changed; preserve state and inspect/,
    );
    assert.equal(await readFile(lockPath, "utf8"), replacement);
    assert.match(await readFile(displacedPath, "utf8"), /"pid":\d+/);
    assert.equal((await inspectOperationsStore(store)).status, "pending");
  });
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

test("signed anchor evidence binds the exact audited ready checkpoint", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const manifestHash = canonicalSha256(manifest);
  const store = join(value.root, "anchored-operations");
  await initializeOperationsStore(store, manifest, manifestHash, "genesis");
  const identity = describeKey(value.authority.publicKey);
  const authorization = {
    schemaVersion: 1,
    authorizationId: "anchor-bootstrap",
    manifestSha256: manifestHash,
    expectedHeadSha256: "genesis",
    enabled: true,
    authorityKeyId: identity.keyId,
    authorityKeyGeneration: 1,
    authorityPublicKeyBase64Url: identity.publicKeyBase64Url,
  };
  await activateOperationsStore(store, authorization, canonicalSha256(authorization));

  const statement = await prepareOperationsAnchorStatement(store);
  const evidence = signOperationsAnchorStatement(statement, value.authority.privateKey, 1);
  assert.deepEqual(await verifyOperationsAnchorEvidence(store, evidence), {
    valid: true,
    streamId: statement.streamId,
    evidenceSha256: canonicalSha256(evidence),
    checkpointSha256: statement.checkpointSha256,
    checkpointGeneration: 1,
    rotationSequence: 0,
  });
  assert.throws(
    () => signOperationsAnchorStatement(
      statement,
      generateKeyPairSync("ed25519").privateKey,
      1,
    ),
    /signing key does not match/,
  );
  const tampered = structuredClone(evidence);
  tampered.payload.statement.checkpointGeneration = 2;
  await assert.rejects(
    verifyOperationsAnchorEvidence(store, tampered),
    /signature is invalid|does not match/,
  );

  const anchorLog = {
    readLatestHead: async () => ({
      schemaVersion: 1,
      kind: "operations-anchor-log-head",
      streamId: statement.streamId,
      logSequence: 1,
      evidenceSha256: canonicalSha256(evidence),
      evidence,
    }),
  };
  await beginTransportRequest(
    store,
    manifestHash,
    "genesis",
    "d".repeat(64),
    anchorLog,
  );
  await assert.rejects(
    prepareOperationsAnchorStatement(store),
    /only a ready operations checkpoint/,
  );
  await commitTransportRequest(store, "d".repeat(64), "e".repeat(64));
  await assert.rejects(
    verifyOperationsAnchorEvidence(store, evidence),
    /does not match the current audited checkpoint/,
  );
  const advancedStatement = await prepareOperationsAnchorStatement(store);
  const advancedEvidence = signOperationsAnchorStatement(
    advancedStatement,
    value.authority.privateKey,
    1,
  );
  const head = (logSequence, selectedEvidence = advancedEvidence) => ({
    readLatestHead: async () => ({
      schemaVersion: 1,
      kind: "operations-anchor-log-head",
      streamId: advancedStatement.streamId,
      logSequence,
      evidenceSha256: canonicalSha256(selectedEvidence),
      evidence: selectedEvidence,
    }),
  });
  await assert.rejects(
    beginTransportRequest(
      store, manifestHash, "e".repeat(64), "f".repeat(64), head(1),
    ),
    /external anchor log head is stale or rolled back/,
  );
  assert.equal((await inspectOperationsStore(store)).status, "ready");
  await assert.rejects(
    beginTransportRequest(
      store, manifestHash, "e".repeat(64), "f".repeat(64), head(2, evidence),
    ),
    /does not match the current audited checkpoint/,
  );
  await beginTransportRequest(
    store, manifestHash, "e".repeat(64), "f".repeat(64), head(2),
  );
  const secondPending = await inspectOperationsStore(store);
  assert.equal(secondPending.externalAnchorSequence, 2);
  assert.equal(secondPending.externalAnchorAcceptanceCount, 2);
  const acceptanceAudit = await auditOperationsStore(store);
  assert.equal(acceptanceAudit.verifiedAnchorAcceptances, 2);
  assert.equal(acceptanceAudit.externalAnchorStreamId, advancedStatement.streamId);
  await unlink(join(
    store,
    "anchor-acceptances",
    `${secondPending.externalAnchorAcceptanceSha256}.json`,
  ));
  await assert.rejects(auditOperationsStore(store), { code: "ENOENT" });
});

test("rotates a pinned mTLS profile only after independent old and new authorization", async () => {
  const value = await fixture();
  const priorManifest = await buildClientPreflight(value.config, value.witness);
  const priorHash = canonicalSha256(priorManifest);
  const store = join(value.root, "rotation-operations");
  await initializeOperationsStore(store, priorManifest, priorHash, "genesis");
  const priorIdentity = describeKey(value.authority.publicKey);
  const activation = {
    schemaVersion: 1,
    authorizationId: "rotation-bootstrap",
    manifestSha256: priorHash,
    expectedHeadSha256: "genesis",
    enabled: true,
    authorityKeyId: priorIdentity.keyId,
    authorityKeyGeneration: 1,
    authorityPublicKeyBase64Url: priorIdentity.publicKeyBase64Url,
  };
  await activateOperationsStore(store, activation, canonicalSha256(activation));
  const initialAnchor = await prepareOperationsAnchorStatement(store);

  const nextManifest = await buildClientPreflight({
    ...value.config,
    serverCertificateSha256: "b".repeat(64),
  }, value.witness);
  const nextHash = canonicalSha256(nextManifest);
  const nextKeys = generateKeyPairSync("ed25519");
  const nextIdentity = describeKey(nextKeys.publicKey);
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest,
      nextManifest,
      expectedNextManifestSha256: "0".repeat(64),
      nextAuthority: { ...nextIdentity, keyGeneration: 2 },
    }),
    /refusing TOFU/,
  );

  const prepared = await prepareOperationsRotation({
    root: store,
    priorManifest,
    nextManifest,
    expectedNextManifestSha256: nextHash,
    nextAuthority: { ...nextIdentity, keyGeneration: 2 },
  });
  assert.equal((await inspectPendingRotation(store)).rotationSha256, prepared.rotationSha256);
  const pendingAudit = await auditOperationsStore(store);
  assert.equal(pendingAudit.valid, true);
  assert.equal(pendingAudit.verifiedRecords, 0);
  assert.equal(pendingAudit.pendingRotationSha256, prepared.rotationSha256);
  await assert.rejects(
    beginTransportRequest(store, priorHash, "genesis", "8".repeat(64)),
    /rotation is pending.*blocked until durable commit/,
  );

  const priorAuthorization = authorizeOperationsRotation(
    prepared.rotation,
    "prior-authorization",
    value.authority.privateKey,
    1,
  );
  const nextAcceptance = authorizeOperationsRotation(
    prepared.rotation,
    "next-acceptance",
    nextKeys.privateKey,
    2,
  );
  await assert.rejects(
    commitOperationsRotation({
      root: store,
      priorManifest,
      nextManifest: { ...nextManifest, serverCertificateSha256: "c".repeat(64) },
      rotation: prepared.rotation,
      priorAuthorization,
      nextAcceptance,
    }),
    /next manifest differs/,
  );
  await assert.rejects(
    commitOperationsRotation({
      root: store,
      priorManifest,
      nextManifest,
      rotation: prepared.rotation,
      priorAuthorization: nextAcceptance,
      nextAcceptance: priorAuthorization,
    }),
    /signature key identity does not match/,
  );
  assert.equal((await inspectOperationsStore(store)).status, "rotating");

  const committed = await commitOperationsRotation({
    root: store,
    priorManifest,
    nextManifest,
    rotation: prepared.rotation,
    priorAuthorization,
    nextAcceptance,
  });
  assert.equal(committed.checkpoint.status, "ready");
  assert.equal(committed.checkpoint.manifestSha256, nextHash);
  assert.equal(committed.checkpoint.rotationSequence, 1);
  assert.equal(committed.checkpoint.previousRotationSha256, committed.rotationRecordSha256);
  assert.equal(committed.checkpoint.authorityKeyId, nextIdentity.keyId);
  const audit = await auditOperationsStore(store);
  assert.equal(audit.valid, true);
  assert.equal(audit.verifiedRecords, 1);
  assert.equal(audit.rotationSequence, 1);
  assert.equal(audit.initialAuthorityKeyId, priorIdentity.keyId);
  const rotatedAnchor = await prepareOperationsAnchorStatement(store);
  assert.equal(rotatedAnchor.streamId, initialAnchor.streamId);
  assert.notEqual(rotatedAnchor.checkpointSha256, initialAnchor.checkpointSha256);
  const rotatedEvidence = signOperationsAnchorStatement(
    rotatedAnchor,
    nextKeys.privateKey,
    2,
  );
  assert.equal(
    (await verifyOperationsAnchorEvidence(store, rotatedEvidence)).rotationSequence,
    1,
  );
  await assert.rejects(
    commitOperationsRotation({
      root: store,
      priorManifest,
      nextManifest,
      rotation: prepared.rotation,
      priorAuthorization,
      nextAcceptance,
    }),
    /does not match the retained pending transition/,
  );
  const anchorLog = await externalAnchorLog(store, nextKeys.privateKey, 2, 1);
  await beginTransportRequest(
    store, nextHash, "genesis", "9".repeat(64), anchorLog,
  );
  const rotationRecordPath = join(
    store,
    "rotations",
    `${committed.rotationRecordSha256}.json`,
  );
  const rotationRecordBytes = await readFile(rotationRecordPath);
  await unlink(rotationRecordPath);
  await assert.rejects(
    commitTransportRequest(store, "9".repeat(64), "a".repeat(64)),
    { code: "ENOENT" },
  );
  assert.equal((await inspectOperationsStore(store)).status, "pending");
  await writeFile(rotationRecordPath, rotationRecordBytes, { flag: "wx", mode: 0o400 });
  const completedRequest = await commitTransportRequest(
    store,
    "9".repeat(64),
    "a".repeat(64),
  );
  assert.equal(completedRequest.status, "ready");
  assert.equal(completedRequest.expectedHeadSha256, "a".repeat(64));
});

test("refuses mTLS rotation downgrade, rollback, shared keys, and stale profile chains", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const manifestHash = canonicalSha256(manifest);
  const store = join(value.root, "adversarial-rotation-operations");
  await initializeOperationsStore(store, manifest, manifestHash, "genesis");
  const identity = describeKey(value.authority.publicKey);
  const activation = {
    schemaVersion: 1,
    authorizationId: "adversarial-bootstrap",
    manifestSha256: manifestHash,
    expectedHeadSha256: "genesis",
    enabled: true,
    authorityKeyId: identity.keyId,
    authorityKeyGeneration: 4,
    authorityPublicKeyBase64Url: identity.publicKeyBase64Url,
  };
  await activateOperationsStore(store, activation, canonicalSha256(activation));
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest: manifest,
      nextManifest: manifest,
      expectedNextManifestSha256: manifestHash,
      nextAuthority: { ...identity, keyGeneration: 5 },
    }),
    /must change the manifest/,
  );
  const changed = { ...manifest, serverCertificateSha256: "d".repeat(64) };
  const invalidEndpoint = { ...changed, endpoint: { ...changed.endpoint, host: "custodian.example" } };
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest: manifest,
      nextManifest: invalidEndpoint,
      expectedNextManifestSha256: canonicalSha256(invalidEndpoint),
      nextAuthority: { ...describeKey(generateKeyPairSync("ed25519").publicKey), keyGeneration: 5 },
    }),
    /preflight endpoint is invalid/,
  );
  const witnessSwap = { ...changed, witnessConfigSha256: "e".repeat(64) };
  const witnessSwapKeys = generateKeyPairSync("ed25519");
  const witnessSwapIdentity = describeKey(witnessSwapKeys.publicKey);
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest: manifest,
      nextManifest: witnessSwap,
      expectedNextManifestSha256: canonicalSha256(witnessSwap),
      nextAuthority: { ...witnessSwapIdentity, keyGeneration: 5 },
    }),
    /must not replace the witness trust anchor/,
  );
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest: manifest,
      nextManifest: changed,
      expectedNextManifestSha256: canonicalSha256(changed),
      nextAuthority: { ...identity, keyGeneration: 5 },
    }),
    /independent keys/,
  );
  const downgrade = generateKeyPairSync("ed25519");
  const downgradeIdentity = describeKey(downgrade.publicKey);
  await assert.rejects(
    prepareOperationsRotation({
      root: store,
      priorManifest: manifest,
      nextManifest: changed,
      expectedNextManifestSha256: canonicalSha256(changed),
      nextAuthority: { ...downgradeIdentity, keyGeneration: 4 },
    }),
    /increasing generation/,
  );
  assert.equal((await inspectOperationsStore(store)).status, "ready");
});
