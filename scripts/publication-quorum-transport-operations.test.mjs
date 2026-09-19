import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, watch as watchCallback, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rename, symlink, unlink, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  inspectRetainedOperationsLockEvidence,
  migrateOperationsStoreV3ToV4,
  prepareOperationsRotation,
  prepareOperationsAnchorStatement,
  prepareRetainedOperationsLockCleanupPlan,
  reconcileOperationsLock,
  reconcileRetainedOperationsLockEvidence,
  signOperationsAnchorStatement,
  verifyOperationsAnchorEvidence,
  verifyOperationsStoreV3ToV4Migration,
} from "./publication-quorum-transport-operations.mjs";

const execute = promisify(execFile);
const raceSubprocessTimeoutMs = 10_000;

function supportsModuleRegister(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 21 || major === 20 && minor >= 6 || major === 18 && minor >= 19;
}

function secureBytesRaceLoaderArguments() {
  if (supportsModuleRegister(process.versions.node)) {
    const registration = new URL(
      "./fixtures/register-secure-bytes-race-loader.mjs", import.meta.url,
    );
    return ["--import", registration.href];
  }
  const loader = new URL("./fixtures/secure-bytes-race-loader.mjs", import.meta.url);
  return ["--experimental-loader", loader.href];
}

function operationsOutputRaceLoaderArguments() {
  if (supportsModuleRegister(process.versions.node)) {
    const registration = new URL(
      "./fixtures/register-operations-output-race-loader.mjs", import.meta.url,
    );
    return ["--import", registration.href];
  }
  const loader = new URL(
    "./fixtures/operations-output-race-loader.mjs", import.meta.url,
  );
  return ["--experimental-loader", loader.href];
}

function operationsBoundedReadRaceLoaderArguments() {
  if (supportsModuleRegister(process.versions.node)) {
    const registration = new URL(
      "./fixtures/register-operations-bounded-read-race-loader.mjs", import.meta.url,
    );
    return ["--import", registration.href];
  }
  const loader = new URL(
    "./fixtures/operations-bounded-read-race-loader.mjs", import.meta.url,
  );
  return ["--experimental-loader", loader.href];
}

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
  const invalidKey = join(value.root, "invalid-client.key");
  await writeFile(invalidKey, "not a private key\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    buildClientPreflight({ ...value.config, tlsPrivateKeyPath: invalidKey }, value.witness),
    /client certificate or TLS key is invalid/,
  );
});

test("secure-input race harness selects a supported loader mode", () => {
  assert.equal(supportsModuleRegister("18.18.2"), false);
  assert.equal(supportsModuleRegister("18.19.0"), true);
  assert.equal(supportsModuleRegister("19.9.0"), false);
  assert.equal(supportsModuleRegister("20.5.1"), false);
  assert.equal(supportsModuleRegister("20.6.0"), true);
  assert.equal(supportsModuleRegister("21.0.0"), true);
  assert.equal(supportsModuleRegister("not-a-version"), false);
});

test("lock reconciliation bounds growth after the initial size check", async () => {
  const value = await fixture();
  const manifest = await buildClientPreflight(value.config, value.witness);
  const store = join(value.root, "bounded-lock-store");
  const checkpoint = await initializeOperationsStore(
    store, manifest, canonicalSha256(manifest), "genesis",
  );
  const startingCheckpointSha256 = canonicalSha256(checkpoint);
  const lockPath = join(store, ".operations.lock");
  const lock = {
    schemaVersion: 2,
    pid: process.pid,
    operation: "bounded-read-test",
    startingCheckpointSha256,
  };
  await writeFile(lockPath, `${canonicalJson(lock)}\n`, {
    flag: "wx", mode: 0o600,
  });
  const output = join(value.root, "bounded-lock-reconciliation.json");
  const cli = join(process.cwd(), "scripts", "publication-quorum-transport-operations.mjs");

  await assert.rejects(
    execute(process.execPath, [
      ...operationsBoundedReadRaceLoaderArguments(),
      cli, "reconcile-lock",
      "--store", store,
      "--expected-lock-sha256", canonicalSha256(lock),
      "--expected-starting-checkpoint-sha256", startingCheckpointSha256,
      "--expected-completed-checkpoint-sha256", "f".repeat(64),
      "--output", output,
    ], {
      env: {
        ...process.env,
        POSTERN_OPERATIONS_BOUNDED_READ_RACE_TARGET: lockPath,
      },
      timeout: raceSubprocessTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    }),
    /operations lock exceeded its maximum size while being read/,
  );
  assert.equal((await lstat(lockPath)).size > 64_000, true);
  assert.equal((await lstat(output)).size, 0);
});

test("preflight pins secure input bytes and their pathname across the read", async (context) => {
  const cli = join(process.cwd(), "scripts", "publication-quorum-transport-operations.mjs");
  for (const mode of [
    "grow-during-read", "same-inode-rewrite", "hardlink-after-eof",
    "pathname-replacement",
  ]) {
    await context.test(mode, async () => {
      const value = await fixture();
      const configPath = join(value.root, `${mode}-config.json`);
      const witnessPath = join(value.root, `${mode}-witness.json`);
      const outputPath = join(value.root, `${mode}-manifest.json`);
      const original = await readFile(value.server.cert);
      await writeFile(configPath, `${canonicalJson(value.config)}\n`, {
        flag: "wx", mode: 0o444,
      });
      await writeFile(witnessPath, `${canonicalJson(value.witness)}\n`, {
        flag: "wx", mode: 0o444,
      });

      await assert.rejects(
        execute(process.execPath, [
          ...secureBytesRaceLoaderArguments(),
          cli, "preflight",
          "--config", configPath,
          "--witness-config", witnessPath,
          "--output", outputPath,
        ], {
          env: {
            ...process.env,
            POSTERN_SECURE_BYTES_RACE_TARGET: value.server.cert,
            POSTERN_SECURE_BYTES_RACE_MODE: mode,
          },
          timeout: raceSubprocessTimeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        }),
        mode === "grow-during-read"
          ? /server CA size is invalid/
          : /server CA changed while it was being read/,
      );
      await assert.rejects(lstat(outputPath), { code: "ENOENT" });
      if (mode === "grow-during-read") {
        assert.ok((await lstat(value.server.cert)).size > 64_000);
      } else if (mode === "pathname-replacement") {
        assert.deepEqual(await readFile(`${value.server.cert}.displaced`), original);
        assert.deepEqual(await readFile(value.server.cert), original);
      } else if (mode === "hardlink-after-eof") {
        assert.deepEqual(await readFile(`${value.server.cert}.alias`), original);
        assert.equal((await lstat(value.server.cert)).nlink, 2);
      } else {
        assert.deepEqual(await readFile(value.server.cert), original);
      }
    });
  }
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
  const fixedNow = 1_700_000_000_000;
  const occupiedTemporary = join(
    store,
    `.checkpoint.json.${process.pid}.${fixedNow}.tmp`,
  );
  await symlink("checkpoint.json", occupiedTemporary);
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    await assert.rejects(
      activateOperationsStore(store, authorization, canonicalSha256(authorization)),
      { code: "EEXIST" },
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal((await lstat(occupiedTemporary)).isSymbolicLink(), true);
  assert.equal((await inspectOperationsStore(store)).status, "inactive");
  await unlink(occupiedTemporary);
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
  const durableCheckpoint = await lstat(join(store, "checkpoint.json"));
  assert.equal(durableCheckpoint.mode & 0o777, 0o400);
  assert.equal(durableCheckpoint.nlink, 1);
  assert.equal(
    (await readdir(store)).some(name => name.startsWith(".checkpoint.json.")),
    false,
  );
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

  await context.test("retained evidence is inspected and reconciled without cleanup", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("retained-lock-evidence");
    const starting = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const existing = new Set(await readdir(store));
    await beginTransportRequest(
      store, manifestHash, "genesis", "1".repeat(64), anchorLog,
    );
    const completed = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const cleanupDirectory = (await readdir(store)).find(name =>
      name.startsWith(".operations.lock.cleanup.") && !existing.has(name));
    assert.ok(cleanupDirectory);
    const retainedName = (await readdir(join(store, cleanupDirectory))).find(name =>
      /^retained-[0-9a-f]{64}$/.test(name));
    assert.ok(retainedName);

    const inspection = await inspectRetainedOperationsLockEvidence({
      root: store, cleanupDirectory, retainedName,
    });
    assert.equal(inspection.kind, "operations-lock-retained-evidence-inspection");
    assert.equal(inspection.lock.operation, "begin-request");
    assert.equal(inspection.recoveryMatchesTombstone, true);
    assert.equal(inspection.activeLockSha256, null);
    assert.equal(inspection.filesRemoved, false);

    const approved = {
      root: store,
      cleanupDirectory,
      retainedName,
      expectedLockSha256: inspection.lockSha256,
      expectedStartingCheckpointSha256: canonicalSha256(starting),
      expectedCompletedCheckpointSha256: canonicalSha256(completed),
      expectedActiveLockState: "absent",
    };
    const cli = join(process.cwd(), "scripts", "publication-quorum-transport-operations.mjs");
    const cliArguments = (output) => [
      cli, "reconcile-lock-evidence",
      "--store", store,
      "--cleanup-directory", cleanupDirectory,
      "--retained-name", retainedName,
      "--expected-lock-sha256", approved.expectedLockSha256,
      "--expected-starting-checkpoint-sha256", approved.expectedStartingCheckpointSha256,
      "--expected-completed-checkpoint-sha256", approved.expectedCompletedCheckpointSha256,
      "--expected-active-lock-state", "absent",
      "--output", output,
    ];
    await assert.rejects(
      execute(process.execPath, cliArguments(join(store, ".operations.lock"))),
      /output must be outside the operations store and evidence tree/,
    );
    await assert.rejects(
      execute(process.execPath, cliArguments(join(store, cleanupDirectory, retainedName))),
      /output must be outside the operations store and evidence tree/,
    );
    assert.equal((await inspectOperationsStore(store)).lockPresent, false);
    await assert.rejects(
      reconcileRetainedOperationsLockEvidence({
        ...approved, expectedLockSha256: "f".repeat(64),
      }),
      /does not match the externally approved hash/,
    );
    await assert.rejects(
      reconcileRetainedOperationsLockEvidence({
        ...approved, expectedCompletedCheckpointSha256: "e".repeat(64),
      }),
      /checkpoint matches neither externally approved outcome/,
    );
    const receipt = await reconcileRetainedOperationsLockEvidence(approved);
    assert.equal(receipt.outcome, "committed");
    assert.equal(receipt.filesRemoved, false);
    assert.equal(receipt.retryAuthorized, false);
    assert.equal(await readFile(
      join(store, cleanupDirectory, retainedName), "utf8",
    ), `${canonicalJson(inspection.lock)}\n`);
    assert.equal(await readFile(
      join(store, inspection.recoveryName), "utf8",
    ), `${canonicalJson(inspection.lock)}\n`);

    const receiptSha256 = canonicalSha256(receipt);
    const cleanupPlan = await prepareRetainedOperationsLockCleanupPlan({
      root: store,
      reconciliationReceipt: receipt,
      expectedReconciliationReceiptSha256: receiptSha256,
    });
    assert.deepEqual(cleanupPlan, {
      schemaVersion: 1,
      kind: "operations-lock-retained-evidence-cleanup-plan",
      reconciliationReceiptSha256: receiptSha256,
      cleanupDirectory,
      retainedName,
      recoveryName: inspection.recoveryName,
      operation: receipt.operation,
      lockSha256: inspection.lockSha256,
      startingCheckpointSha256: receipt.startingCheckpointSha256,
      observedCheckpointSha256: receipt.observedCheckpointSha256,
      completedCheckpointSha256: receipt.completedCheckpointSha256,
      outcome: "committed",
      requiredActiveLockState: "absent",
      deletionAuthorized: false,
      executionSupported: false,
      filesRemoved: false,
      retryAuthorized: false,
    });
    let cleanupDirectoryReads = 0;
    const accessorReceipt = { ...receipt };
    Object.defineProperty(accessorReceipt, "cleanupDirectory", {
      enumerable: true,
      configurable: true,
      get() {
        cleanupDirectoryReads += 1;
        return cleanupDirectoryReads === 1 ? receipt.cleanupDirectory : "../substituted";
      },
    });
    assert.deepEqual(await prepareRetainedOperationsLockCleanupPlan({
      root: store,
      reconciliationReceipt: accessorReceipt,
      expectedReconciliationReceiptSha256: receiptSha256,
    }), cleanupPlan);
    assert.equal(cleanupDirectoryReads, 1);
    await assert.rejects(
      prepareRetainedOperationsLockCleanupPlan({
        root: store,
        reconciliationReceipt: receipt,
        expectedReconciliationReceiptSha256: "0".repeat(64),
      }),
      /does not match the externally approved hash/,
    );
    const forgedReceipt = { ...receipt, outcome: "not-committed" };
    await assert.rejects(
      prepareRetainedOperationsLockCleanupPlan({
        root: store,
        reconciliationReceipt: forgedReceipt,
        expectedReconciliationReceiptSha256: canonicalSha256(forgedReceipt),
      }),
      /does not reproduce the approved reconciliation receipt/,
    );

    const receiptPath = join(store, "..", `${cleanupDirectory}.receipt.json`);
    const planPath = join(store, "..", `${cleanupDirectory}.cleanup-plan.json`);
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o444 });
    await execute(process.execPath, [
      cli, "prepare-lock-evidence-cleanup",
      "--store", store,
      "--reconciliation-receipt", receiptPath,
      "--expected-reconciliation-receipt-sha256", receiptSha256,
      "--output", planPath,
    ]);
    assert.deepEqual(JSON.parse(await readFile(planPath, "utf8")), cleanupPlan);
    assert.equal((await lstat(planPath)).mode & 0o777, 0o444);

    await link(join(store, cleanupDirectory, retainedName), join(store, ".operations.lock"));
    await assert.rejects(
      prepareRetainedOperationsLockCleanupPlan({
        root: store,
        reconciliationReceipt: receipt,
        expectedReconciliationReceiptSha256: receiptSha256,
      }),
      /active lock state differs from the externally approved absent state/,
    );
    await assert.rejects(
      reconcileRetainedOperationsLockEvidence(approved),
      /active lock state differs from the externally approved absent state/,
    );
    const aliasedReceipt = await reconcileRetainedOperationsLockEvidence({
      ...approved, expectedActiveLockState: "tombstone-alias",
    });
    assert.equal(aliasedReceipt.activeLockState, "tombstone-alias");
    assert.equal((await lstat(join(store, ".operations.lock"))).nlink, 2);

    await unlink(join(store, ".operations.lock"));
    await link(join(store, inspection.recoveryName), join(store, ".operations.lock"));
    const recoveryAliasReceipt = await reconcileRetainedOperationsLockEvidence({
      ...approved, expectedActiveLockState: "recovery-alias",
    });
    assert.equal(recoveryAliasReceipt.activeLockState, "recovery-alias");
    await unlink(join(store, ".operations.lock"));
    await writeFile(join(store, ".operations.lock"), `${canonicalJson(inspection.lock)}\n`, {
      flag: "wx", mode: 0o600,
    });
    const copiedReceipt = await reconcileRetainedOperationsLockEvidence({
      ...approved, expectedActiveLockState: "independent-copy",
    });
    assert.equal(copiedReceipt.activeLockState, "independent-copy");

    await writeFile(join(store, cleanupDirectory, "unapproved"), "preserve me\n", {
      flag: "wx", mode: 0o600,
    });
    await assert.rejects(
      reconcileRetainedOperationsLockEvidence(approved),
      /contains unapproved additional evidence/,
    );
    assert.equal(await readFile(join(store, cleanupDirectory, "unapproved"), "utf8"),
      "preserve me\n");
  });

  await context.test("preexisting recovery must retain exact mode 0400", async () => {
    const { store, manifestHash } = await activatedStore("recovery-mode");
    const unavailable = { readLatestHead: async () => { throw new Error("offline"); } };
    const existing = new Set(await readdir(store));
    await assert.rejects(
      beginTransportRequest(store, manifestHash, "genesis", "6".repeat(64), unavailable),
      /offline/,
    );
    const recoveryName = (await readdir(store)).find(name =>
      name.startsWith(".operations.lock.recovery.") && !existing.has(name));
    assert.ok(recoveryName);
    const recoveryPath = join(store, recoveryName);
    await chmod(recoveryPath, 0o600);
    await assert.rejects(
      beginTransportRequest(store, manifestHash, "genesis", "6".repeat(64), unavailable),
      /existing operations lock recovery evidence does not have the exact recovery file identity/,
    );
    assert.equal((await lstat(recoveryPath)).mode & 0o777, 0o600);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
  });

  await context.test("oversized preexisting recovery is rejected before reading", async () => {
    const { store, manifestHash } = await activatedStore("recovery-size");
    const unavailable = { readLatestHead: async () => { throw new Error("offline"); } };
    const existing = new Set(await readdir(store));
    await assert.rejects(
      beginTransportRequest(store, manifestHash, "genesis", "7".repeat(64), unavailable),
      /offline/,
    );
    const recoveryName = (await readdir(store)).find(name =>
      name.startsWith(".operations.lock.recovery.") && !existing.has(name));
    assert.ok(recoveryName);
    const recoveryPath = join(store, recoveryName);
    await unlink(recoveryPath);
    await writeFile(recoveryPath, Buffer.alloc(64_001, 0x20), {
      flag: "wx", mode: 0o400,
    });
    await assert.rejects(
      beginTransportRequest(store, manifestHash, "genesis", "7".repeat(64), unavailable),
      /existing operations lock recovery evidence does not have the exact recovery file identity/,
    );
    assert.equal((await lstat(recoveryPath)).size, 64_001);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
  });

  await context.test("checkpoint substitution during external query is preserved", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("checkpoint-race");
    const checkpointPath = join(store, "checkpoint.json");
    const original = JSON.parse(await readFile(checkpointPath, "utf8"));
    const substituted = { ...original, generation: original.generation + 10 };
    const racingAnchorLog = {
      readLatestHead: async (query) => {
        const head = await anchorLog.readLatestHead(query);
        await chmod(checkpointPath, 0o600);
        await writeFile(checkpointPath, `${canonicalJson(substituted)}\n`);
        await chmod(checkpointPath, 0o400);
        return head;
      },
    };
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "6".repeat(64), racingAnchorLog,
      ),
      /checkpoint changed during external anchor query; preserve state and inspect/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(checkpointPath, "utf8")),
      substituted,
      "the operation must not overwrite the concurrently observed checkpoint",
    );
    assert.deepEqual(await readdir(join(store, "anchor-acceptances")), []);
    assert.equal((await inspectOperationsStore(store)).lockPresent, false);
  });

  await context.test("checkpoint substitution at publication preserves the durable candidate", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("publication-race");
    await beginTransportRequest(
      store, manifestHash, "genesis", "d".repeat(64), anchorLog,
    );
    const checkpointPath = join(store, "checkpoint.json");
    const pending = JSON.parse(await readFile(checkpointPath, "utf8"));
    const substituted = { ...pending, generation: pending.generation + 20 };
    const observer = watch(store);
    const substitution = (async () => {
      for await (const event of observer) {
        if (event.filename?.startsWith(".checkpoint.json.") &&
            event.filename.endsWith(".tmp")) {
          await chmod(checkpointPath, 0o600);
          await writeFile(checkpointPath, `${canonicalJson(substituted)}\n`);
          await chmod(checkpointPath, 0o400);
          return;
        }
      }
    })();
    await assert.rejects(
      commitTransportRequest(store, "d".repeat(64), "e".repeat(64)),
      /checkpoint changed at checkpoint publication boundary; preserve state and inspect/,
    );
    await substitution;
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), substituted);
    const candidates = (await readdir(store)).filter(name =>
      name.startsWith(".checkpoint.json.") && name.endsWith(".tmp"));
    assert.equal(candidates.length, 1);
    const candidate = JSON.parse(await readFile(join(store, candidates[0]), "utf8"));
    assert.equal(candidate.status, "ready");
    assert.equal(candidate.expectedHeadSha256, "e".repeat(64));
    assert.equal((await lstat(join(store, candidates[0]))).mode & 0o777, 0o400);
    assert.equal((await inspectOperationsStore(store)).lockPresent, false);
  });

  await context.test("conditional publication never overwrites a final-window intruder", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("conditional-publication");
    await beginTransportRequest(
      store, manifestHash, "genesis", "1".repeat(64), anchorLog,
    );
    const checkpointPath = join(store, "checkpoint.json");
    const pending = JSON.parse(await readFile(checkpointPath, "utf8"));
    const intruder = { ...pending, generation: pending.generation + 30 };
    const observer = watch(store);
    const substitution = (async () => {
      for await (const event of observer) {
        if (event.filename === "checkpoint.json") {
          await writeFile(
            checkpointPath,
            `${canonicalJson(intruder)}\n`,
            { flag: "wx", mode: 0o400 },
          );
          return;
        }
      }
    })();
    await assert.rejects(
      commitTransportRequest(store, "1".repeat(64), "2".repeat(64)),
      /checkpoint publication outcome is ambiguous; preserve lock, candidate, predecessor/,
    );
    await substitution;
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), intruder);
    const names = await readdir(store);
    const candidates = names.filter(name =>
      name.startsWith(".checkpoint.json.") && name.endsWith(".tmp"));
    assert.equal(candidates.length, 1);
    const candidate = JSON.parse(await readFile(join(store, candidates[0]), "utf8"));
    assert.equal(candidate.status, "ready");
    assert.equal(candidate.expectedHeadSha256, "2".repeat(64));
    const predecessorPath = join(
      store,
      `.checkpoint.previous.${canonicalSha256(pending)}.json`,
    );
    assert.deepEqual(JSON.parse(await readFile(predecessorPath, "utf8")), pending);
    assert.equal((await lstat(predecessorPath)).mode & 0o777, 0o400);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
  });

  await context.test("occupied recovery candidate must contain the exact candidate", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("occupied-candidate");
    await beginTransportRequest(
      store, manifestHash, "genesis", "5".repeat(64), anchorLog,
    );
    const checkpointPath = join(store, "checkpoint.json");
    const pending = JSON.parse(await readFile(checkpointPath, "utf8"));
    const next = {
      ...pending,
      generation: pending.generation + 1,
      status: "ready",
      expectedHeadSha256: "6".repeat(64),
      pendingRequestId: null,
    };
    const candidatePath = join(
      store,
      `.checkpoint.candidate.${canonicalSha256(next)}.json`,
    );
    await writeFile(
      candidatePath,
      `${canonicalJson({ corrupt: true })}\n`,
      { flag: "wx", mode: 0o400 },
    );
    await assert.rejects(
      commitTransportRequest(store, "5".repeat(64), "6".repeat(64)),
      /checkpoint recovery candidate path contains different content/,
    );
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), pending);
    assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), { corrupt: true });
    assert.equal((await inspectOperationsStore(store)).lockPresent, false);
  });

  await context.test("post-link substitution retains an independent recovery candidate", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("post-link-substitution");
    await beginTransportRequest(
      store, manifestHash, "genesis", "3".repeat(64), anchorLog,
    );
    const checkpointPath = join(store, "checkpoint.json");
    const pending = JSON.parse(await readFile(checkpointPath, "utf8"));
    const intruder = { ...pending, generation: pending.generation + 40 };
    let resolveSubstitution;
    let rejectSubstitution;
    const substitution = new Promise((resolve, reject) => {
      resolveSubstitution = resolve;
      rejectSubstitution = reject;
    });
    const observer = watchCallback(store, (_event, filename) => {
      if (filename !== "checkpoint.json") return;
      try {
        if (lstatSync(checkpointPath).nlink !== 2) return;
        unlinkSync(checkpointPath);
        writeFileSync(
          checkpointPath,
          `${canonicalJson(intruder)}\n`,
          { flag: "wx", mode: 0o400 },
        );
        observer.close();
        resolveSubstitution();
      } catch (error) {
        if (error?.code === "ENOENT") return;
        observer.close();
        rejectSubstitution(error);
      }
    });
    await assert.rejects(
      commitTransportRequest(store, "3".repeat(64), "4".repeat(64)),
      /checkpoint publication outcome is ambiguous; preserve lock, candidate, predecessor/,
    );
    await substitution;
    assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), intruder);
    const names = await readdir(store);
    assert.equal(
      names.filter(name => name.startsWith(".checkpoint.json.") && name.endsWith(".tmp")).length,
      0,
      "the temporary alias was removed after the race",
    );
    const candidatePath = join(
      store,
      `.checkpoint.candidate.${canonicalSha256({
        ...pending,
        status: "ready",
        expectedHeadSha256: "4".repeat(64),
        pendingRequestId: null,
        generation: pending.generation + 1,
      })}.json`,
    );
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    assert.equal(candidate.status, "ready");
    assert.equal(candidate.expectedHeadSha256, "4".repeat(64));
    assert.equal((await lstat(candidatePath)).mode & 0o777, 0o400);
    assert.equal((await lstat(candidatePath)).nlink, 1);
    const predecessorPath = join(
      store,
      `.checkpoint.previous.${canonicalSha256(pending)}.json`,
    );
    assert.deepEqual(JSON.parse(await readFile(predecessorPath, "utf8")), pending);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
  });

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

  await context.test("same-inode lock rewrite", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("rewritten-lock");
    const lockPath = join(store, ".operations.lock");
    const starting = JSON.parse(await readFile(join(store, "checkpoint.json"), "utf8"));
    const racingAnchorLog = {
      readLatestHead: async (query) => {
        const head = await anchorLog.readLatestHead(query);
        const original = await readFile(lockPath, "utf8");
        const rewritten = original.replace('"operation":"begin-request"',
          '"operation":"evilx-request"');
        assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
        await writeFile(lockPath, rewritten);
        return head;
      },
    };
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "f".repeat(64), racingAnchorLog,
      ),
      /operations lock identity changed; preserve state and inspect/,
    );
    assert.match(await readFile(lockPath, "utf8"), /"operation":"evilx-request"/);
    const checkpoint = await inspectOperationsStore(store);
    assert.equal(checkpoint.status, "pending");
    assert.equal(checkpoint.lockPresent, true);
    assert.notEqual(canonicalSha256(starting), canonicalSha256(checkpoint));
  });

  await context.test("final-window lock substitution is retained in a tombstone", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("cleanup-lock-race");
    const lockPath = join(store, ".operations.lock");
    const displacedPath = join(store, ".operations.lock.displaced-at-cleanup");
    const intruder = "final-window intruder must be preserved\n";
    const existingNames = new Set(await readdir(store));
    let resolveSubstitution;
    let rejectSubstitution;
    const substitution = new Promise((resolve, reject) => {
      resolveSubstitution = resolve;
      rejectSubstitution = reject;
    });
    const observer = watchCallback(store, (_event, filename) => {
      if (!filename?.startsWith(".operations.lock.cleanup.")) return;
      try {
        renameSync(lockPath, displacedPath);
        writeFileSync(lockPath, intruder, { flag: "wx", mode: 0o600 });
        observer.close();
        resolveSubstitution();
      } catch (error) {
        observer.close();
        rejectSubstitution(error);
      }
    });
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "0".repeat(64), anchorLog,
      ),
      /operations lock cleanup outcome is ambiguous; preserve tombstone and recovery evidence/,
    );
    await substitution;

    const names = await readdir(store);
    const cleanups = names.filter(name => name.startsWith(".operations.lock.cleanup.") &&
      !existingNames.has(name));
    const recoveries = names.filter(name => name.startsWith(".operations.lock.recovery.") &&
      !existingNames.has(name));
    assert.equal(cleanups.length, 1);
    assert.equal(recoveries.length, 1);
    const retainedNames = await readdir(join(store, cleanups[0]));
    assert.equal(retainedNames.length, 1);
    const retainedPath = join(store, cleanups[0], retainedNames[0]);
    assert.match(retainedNames[0], /^retained-[0-9a-f]{64}$/);
    assert.equal(await readFile(retainedPath, "utf8"), intruder);
    const original = await readFile(displacedPath, "utf8");
    assert.deepEqual(
      JSON.parse(await readFile(join(store, recoveries[0]), "utf8")),
      JSON.parse(original),
    );
    assert.equal((await lstat(join(store, recoveries[0]))).mode & 0o777, 0o400);
    assert.equal(await readFile(lockPath, "utf8"), intruder);
    assert.equal((await lstat(lockPath)).nlink, 2);
    assert.equal((await lstat(retainedPath)).nlink, 2);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "1".repeat(64), anchorLog,
      ),
      /operations store is locked; inspect before recovery/,
    );
  });

  await context.test("rename-away without replacement restores poison from recovery", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("cleanup-missing-source");
    const lockPath = join(store, ".operations.lock");
    const displacedPath = join(store, ".operations.lock.displaced-before-cleanup");
    const existingNames = new Set(await readdir(store));
    let resolveDisplacement;
    let rejectDisplacement;
    const displacement = new Promise((resolve, reject) => {
      resolveDisplacement = resolve;
      rejectDisplacement = reject;
    });
    const observer = watchCallback(store, (_event, filename) => {
      if (!filename?.startsWith(".operations.lock.cleanup.")) return;
      try {
        renameSync(lockPath, displacedPath);
        observer.close();
        resolveDisplacement();
      } catch (error) {
        observer.close();
        rejectDisplacement(error);
      }
    });

    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "3".repeat(64), anchorLog,
      ),
      /ENOENT|no such file or directory/i,
    );
    await displacement;

    const recoveryNames = (await readdir(store)).filter(name =>
      name.startsWith(".operations.lock.recovery.") && !existingNames.has(name));
    assert.equal(recoveryNames.length, 1);
    const recoveryPath = join(store, recoveryNames[0]);
    assert.equal(await readFile(lockPath, "utf8"), await readFile(displacedPath, "utf8"));
    assert.equal(await readFile(lockPath, "utf8"), await readFile(recoveryPath, "utf8"));
    assert.equal((await lstat(lockPath)).nlink, 2);
    assert.equal((await lstat(recoveryPath)).nlink, 2);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "4".repeat(64), anchorLog,
      ),
      /operations store is locked; inspect before recovery/,
    );
  });

  await context.test("raced-away retained tombstone restores poison from recovery", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("cleanup-missing-retained");
    const lockPath = join(store, ".operations.lock");
    const displacedPath = join(store, ".operations.lock.displaced-retained");
    const existingNames = new Set(await readdir(store));
    let resolveDisplacement;
    let rejectDisplacement;
    const displacement = new Promise((resolve, reject) => {
      resolveDisplacement = resolve;
      rejectDisplacement = reject;
    });
    const rootObserver = watchCallback(store, (_event, filename) => {
      if (!filename?.startsWith(".operations.lock.cleanup.")) return;
      try {
        const cleanup = join(store, filename);
        const cleanupObserver = watchCallback(cleanup, (_cleanupEvent, retainedName) => {
          if (!retainedName?.startsWith("retained-")) return;
          try {
            renameSync(join(cleanup, retainedName), displacedPath);
            cleanupObserver.close();
            resolveDisplacement();
          } catch (error) {
            cleanupObserver.close();
            rejectDisplacement(error);
          }
        });
        rootObserver.close();
      } catch (error) {
        rootObserver.close();
        rejectDisplacement(error);
      }
    });

    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "5".repeat(64), anchorLog,
      ),
      /ENOENT|no such file or directory/i,
    );
    await displacement;

    const recoveryNames = (await readdir(store)).filter(name =>
      name.startsWith(".operations.lock.recovery.") && !existingNames.has(name));
    assert.equal(recoveryNames.length, 1);
    const recoveryPath = join(store, recoveryNames[0]);
    assert.equal(await readFile(lockPath, "utf8"), await readFile(displacedPath, "utf8"));
    assert.equal(await readFile(lockPath, "utf8"), await readFile(recoveryPath, "utf8"));
    assert.equal((await lstat(lockPath)).nlink, 2);
    assert.equal((await lstat(recoveryPath)).nlink, 2);
    assert.equal((await inspectOperationsStore(store)).lockPresent, true);
    await assert.rejects(
      beginTransportRequest(
        store, manifestHash, "genesis", "6".repeat(64), anchorLog,
      ),
      /operations store is locked; inspect before recovery/,
    );
  });

  await context.test("predictable cleanup destination occupation is never overwritten", async () => {
    const { store, manifestHash, anchorLog } = await activatedStore("cleanup-destination-race");
    const occupied = "predictable cleanup occupant must survive\n";
    const existingNames = new Set(await readdir(store));
    let resolveOccupation;
    let rejectOccupation;
    const occupation = new Promise((resolve, reject) => {
      resolveOccupation = resolve;
      rejectOccupation = reject;
    });
    const observer = watchCallback(store, (_event, filename) => {
      if (!filename?.startsWith(".operations.lock.cleanup.")) return;
      try {
        writeFileSync(join(store, filename, "lock"), occupied, { flag: "wx", mode: 0o600 });
        observer.close();
        resolveOccupation();
      } catch (error) {
        observer.close();
        rejectOccupation(error);
      }
    });

    await beginTransportRequest(
      store, manifestHash, "genesis", "2".repeat(64), anchorLog,
    );
    await occupation;

    const cleanupNames = (await readdir(store)).filter(name =>
      name.startsWith(".operations.lock.cleanup.") && !existingNames.has(name));
    assert.equal(cleanupNames.length, 1);
    const cleanup = join(store, cleanupNames[0]);
    const retainedNames = (await readdir(cleanup)).filter(name => name !== "lock");
    assert.equal(await readFile(join(cleanup, "lock"), "utf8"), occupied);
    assert.equal(retainedNames.length, 1);
    assert.match(retainedNames[0], /^retained-[0-9a-f]{64}$/);
    assert.match(await readFile(join(cleanup, retainedNames[0]), "utf8"), /"pid":\d+/);
    assert.equal((await inspectOperationsStore(store)).lockPresent, false);
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

  const cli = join(
    process.cwd(), "scripts", "publication-quorum-transport-operations.mjs",
  );
  const nestedOutput = join(store, "anchor-statement.json");
  await assert.rejects(
    execute(process.execPath, [
      cli, "prepare-anchor", "--store", store, "--output", nestedOutput,
    ]),
    /output must be outside the operations store and evidence tree/,
  );
  await assert.rejects(lstat(nestedOutput), { code: "ENOENT" });
  const symlinkedStore = join(value.root, "anchored-operations-alias");
  await symlink(store, symlinkedStore);
  const symlinkedStoreOutput = join(value.root, "symlinked-store-anchor.json");
  await assert.rejects(execute(process.execPath, [
    cli, "prepare-anchor", "--store", symlinkedStore,
    "--output", symlinkedStoreOutput,
  ]), /store path must not traverse symlinks/);
  await assert.rejects(lstat(symlinkedStoreOutput), { code: "ENOENT" });

  await chmod(store, 0o750);
  const unsafeStoreOutput = join(value.root, "unsafe-store-anchor.json");
  await assert.rejects(execute(process.execPath, [
    cli, "prepare-anchor", "--store", store, "--output", unsafeStoreOutput,
  ]), /store identity or permissions are invalid/);
  await assert.rejects(lstat(unsafeStoreOutput), { code: "ENOENT" });
  await chmod(store, 0o700);

  const cliOutput = join(value.root, "anchor-statement.json");
  const openUmaskRunner = new URL(
    "./fixtures/run-with-open-umask.mjs", import.meta.url,
  );
  await execute(process.execPath, [
    fileURLToPath(openUmaskRunner),
    "prepare-anchor", "--store", store, "--output", cliOutput,
  ]);
  assert.equal((await lstat(cliOutput)).mode & 0o777, 0o444);

  for (const mode of [
    "before-validation", "after-write", "after-parent-sync",
  ]) {
    const racedOutput = join(value.root, `anchor-statement-${mode}.json`);
    await assert.rejects(execute(process.execPath, [
      ...operationsOutputRaceLoaderArguments(), cli,
      "prepare-anchor", "--store", store, "--output", racedOutput,
    ], {
      env: {
        ...process.env,
        POSTERN_OPERATIONS_OUTPUT_RACE_MODE: mode,
        POSTERN_OPERATIONS_OUTPUT_RACE_TARGET: racedOutput,
      },
      timeout: raceSubprocessTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    }), /reserved operations output (?:changed|identity)/);
    assert.equal((await lstat(racedOutput)).mode & 0o777, 0o444);
    assert.ok((await readFile(racedOutput)).length > 0);
  }

  const statement = await prepareOperationsAnchorStatement(store);
  assert.deepEqual(JSON.parse(await readFile(cliOutput, "utf8")), statement);
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
