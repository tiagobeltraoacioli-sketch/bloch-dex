import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  canonicalSha256,
  describeKey,
} from "./live-auth/envelope.mjs";

const execute = promisify(execFile);
const cli = resolve("scripts/publication-quorum.mjs");
const storeCli = resolve("scripts/publication-quorum-store.mjs");
const witnessCli = resolve("scripts/publication-quorum-witness.mjs");
const custodyCli = resolve("scripts/publication-quorum-witness-custody.mjs");
const ZERO_SIGNATURE = Buffer.alloc(64).toString("base64url");
const PUBLICATION_KEY_ID = "a".repeat(64);

async function run(...args) {
  return execute(process.execPath, [cli, ...args], { cwd: resolve(".") });
}

async function runStore(...args) {
  return execute(process.execPath, [storeCli, ...args], { cwd: resolve(".") });
}

async function runWitness(...args) {
  return execute(process.execPath, [witnessCli, ...args], { cwd: resolve(".") });
}

async function runCustody(...args) {
  return execute(process.execPath, [custodyCli, ...args], { cwd: resolve(".") });
}

async function interfereAfterLock(
  store,
  args,
  action,
  { executable = storeCli, lockName = ".quorum.lock" } = {},
) {
  let watcher;
  let timer;
  const observed = new Promise((resolveObserved, rejectObserved) => {
    watcher = watch(store, (_event, filename) => {
      if (filename === lockName) {
        clearTimeout(timer);
        watcher.close();
        resolveObserved();
      }
    });
    timer = setTimeout(() => {
      watcher.close();
      rejectObserved(new Error("timed out waiting for quorum lock"));
    }, 5_000);
  });
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClosed) => {
    child.on("close", (code) => resolveClosed(code));
  });
  await observed;
  await action();
  const code = await closed;
  return { code, stdout, stderr };
}

function publication(
  sequence,
  previousEntrySha256,
  publishedAt = 2_000_000_000,
) {
  return {
    schemaVersion: 2,
    payload: {
      schemaVersion: 1,
      sequence,
      previousEntrySha256,
      publishedAt,
      bundleSha256: "b".repeat(64),
      manifestEnvelopeSha256: "c".repeat(64),
      gateEnvelopeSha256: "d".repeat(64),
      witnessEnvelopeSha256: "e".repeat(64),
      sourceRevision: "f".repeat(40),
      liveReadKeyId: "1".repeat(64),
      liveReadKeyGeneration: 7,
      witnessKeyId: "2".repeat(64),
      witnessKeyGeneration: 8,
    },
    signature: {
      algorithm: "Ed25519",
      keyId: PUBLICATION_KEY_ID,
      keyGeneration: 3,
      value: ZERO_SIGNATURE,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "postern-quorum-"));
  const auditors = [];
  for (const auditorId of ["audit-a", "audit-b", "audit-c"]) {
    const keys = generateKeyPairSync("ed25519");
    const identity = describeKey(keys.publicKey);
    const privatePath = join(root, `${auditorId}.private.pem`);
    await writeFile(
      privatePath,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await chmod(privatePath, 0o600);
    auditors.push({
      auditorId,
      keyId: identity.keyId,
      keyGeneration: 1,
      publicKeyBase64Url: identity.publicKeyBase64Url,
      privatePath,
    });
  }
  const configPath = join(root, "auditors.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      configGeneration: 1,
      threshold: 2,
      auditors: auditors.map((auditor) => ({
        auditorId: auditor.auditorId,
        keyId: auditor.keyId,
        keyGeneration: auditor.keyGeneration,
        publicKeyBase64Url: auditor.publicKeyBase64Url,
      })),
    }),
  );
  const publication0 = join(root, "publication-checkpoint-0.json");
  await writeFile(
    publication0,
    JSON.stringify({
      schemaVersion: 1,
      publicationKeyId: PUBLICATION_KEY_ID,
      publicationKeyGeneration: 3,
      sequence: 0,
      entrySha256: null,
    }),
  );
  const quorum0 = join(root, "quorum-0.json");
  await run(
    "init",
    "--config",
    configPath,
    "--publication-checkpoint",
    publication0,
    "--output-checkpoint",
    quorum0,
  );
  return { root, auditors, configPath, quorum0 };
}

async function witnessFixture(files, name = "external-witness") {
  const keys = generateKeyPairSync("ed25519");
  const identity = describeKey(keys.publicKey);
  const privatePath = join(files.root, `${name}.private.pem`);
  const configPath = join(files.root, `${name}.json`);
  await writeFile(
    privatePath,
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await chmod(privatePath, 0o600);
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    storeId: randomBytes(32).toString("hex"),
    witnessId: name,
    keyId: identity.keyId,
    keyGeneration: 1,
    publicKeyBase64Url: identity.publicKeyBase64Url,
  }));
  return { privatePath, configPath };
}

async function custodyFixture(files, witness, name = "witness-custody") {
  const keys = generateKeyPairSync("ed25519");
  const identity = describeKey(keys.publicKey);
  const clientPrivatePath = join(files.root, `${name}.client.private.pem`);
  await writeFile(
    clientPrivatePath,
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await chmod(clientPrivatePath, 0o600);
  const configPath = join(files.root, `${name}.json`);
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    custodyId: name,
    witness: JSON.parse(await readFile(witness.configPath, "utf8")),
    authorizedClient: {
      clientId: "quorum-collector",
      keyId: identity.keyId,
      keyGeneration: 1,
      publicKeyBase64Url: identity.publicKeyBase64Url,
    },
  }));
  return { configPath, clientPrivatePath };
}

async function makeNextConfig(files, name = "next", generation = 2) {
  const auditors = [];
  for (const auditorId of [`${name}-a`, `${name}-b`, `${name}-c`]) {
    const keys = generateKeyPairSync("ed25519");
    const identity = describeKey(keys.publicKey);
    const privatePath = join(files.root, `${auditorId}.private.pem`);
    await writeFile(
      privatePath,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await chmod(privatePath, 0o600);
    auditors.push({
      auditorId,
      keyId: identity.keyId,
      keyGeneration: generation,
      publicKeyBase64Url: identity.publicKeyBase64Url,
      privatePath,
    });
  }
  const configPath = join(files.root, `${name}.config.json`);
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    configGeneration: generation,
    threshold: 2,
    auditors: auditors.map(({ privatePath: _, ...auditor }) => auditor),
  }));
  return { configPath, auditors };
}

async function approveRotation(
  files,
  next,
  role,
  auditor,
  checkpoint,
  suffix,
) {
  const output = join(files.root, `${role}-${suffix}.json`);
  await run(
    "attest-config-rotation",
    "--prior-config",
    files.configPath,
    "--next-config",
    next.configPath,
    "--role",
    role,
    "--auditor-id",
    auditor.auditorId,
    "--private-key",
    auditor.privatePath,
    "--checkpoint",
    checkpoint,
    "--output",
    output,
  );
  return JSON.parse(await readFile(output, "utf8"));
}

async function rotateConfig(files, next, prior, acceptances, checkpoint, name) {
  const priorPath = join(files.root, `${name}.prior.json`);
  const nextPath = join(files.root, `${name}.next.json`);
  await writeFile(priorPath, JSON.stringify(prior));
  await writeFile(nextPath, JSON.stringify(acceptances));
  return run(
    "rotate-config",
    "--prior-config",
    files.configPath,
    "--next-config",
    next.configPath,
    "--prior-approvals",
    priorPath,
    "--next-acceptances",
    nextPath,
    "--checkpoint",
    checkpoint,
    "--output-checkpoint",
    join(files.root, `${name}.checkpoint.json`),
  );
}

async function writeEntry(files, name, entry) {
  const entryPath = join(files.root, `${name}.json`);
  const checkpointPath = join(files.root, `${name}.checkpoint.json`);
  await writeFile(entryPath, JSON.stringify(entry));
  await writeFile(
    checkpointPath,
    JSON.stringify({
      schemaVersion: 1,
      publicationKeyId: entry.signature.keyId,
      publicationKeyGeneration: entry.signature.keyGeneration,
      sequence: entry.payload.sequence,
      entrySha256: canonicalSha256(entry),
    }),
  );
  return { entryPath, checkpointPath };
}

async function attest(files, auditorIndex, entry, suffix = "") {
  const output = join(files.root, `attestation-${auditorIndex}${suffix}.json`);
  const auditor = files.auditors[auditorIndex];
  await run(
    "attest",
    "--config",
    files.configPath,
    "--auditor-id",
    auditor.auditorId,
    "--private-key",
    auditor.privatePath,
    "--entry",
    entry.entryPath,
    "--publication-checkpoint",
    entry.checkpointPath,
    "--output",
    output,
  );
  return JSON.parse(await readFile(output, "utf8"));
}

async function verify(files, entryPath, attestations, checkpoint, output) {
  const attestationsPath = join(files.root, `${output}.attestations.json`);
  await writeFile(attestationsPath, JSON.stringify(attestations));
  return run(
    "verify",
    "--config",
    files.configPath,
    "--entry",
    entryPath,
    "--attestations",
    attestationsPath,
    "--checkpoint",
    checkpoint,
    "--output-checkpoint",
    join(files.root, `${output}.json`),
  );
}

test("requires a canonical independent auditor threshold", async () => {
  const files = await fixture();
  const config = JSON.parse(await readFile(files.configPath, "utf8"));
  config.auditors[1].auditorId = config.auditors[0].auditorId;
  const invalid = join(files.root, "duplicate-config.json");
  await writeFile(invalid, JSON.stringify(config));
  await assert.rejects(
    run(
      "init",
      "--config",
      invalid,
      "--publication-checkpoint",
      join(files.root, "publication-checkpoint-0.json"),
      "--output-checkpoint",
      join(files.root, "invalid-quorum.json"),
    ),
    /uniquely sorted|independent/,
  );

  config.auditors[1].auditorId = "audit-b";
  config.threshold = 1;
  const weak = join(files.root, "weak-config.json");
  await writeFile(weak, JSON.stringify(config));
  await assert.rejects(
    run(
      "init",
      "--config",
      weak,
      "--publication-checkpoint",
      join(files.root, "publication-checkpoint-0.json"),
      "--output-checkpoint",
      join(files.root, "weak-quorum.json"),
    ),
    /threshold must be between two and the auditor count/,
  );
});

test("advances only with distinct exact-head attestations and rejects adversarial inputs", async () => {
  const files = await fixture();
  const entry1 = await writeEntry(files, "entry-1", publication(1, null));
  const a1 = await attest(files, 0, entry1, "-1");
  const b1 = await attest(files, 1, entry1, "-1");

  await assert.rejects(
    verify(files, entry1.entryPath, [a1], files.quorum0, "insufficient"),
    /threshold is not met/,
  );
  await assert.rejects(
    verify(files, entry1.entryPath, [a1, a1], files.quorum0, "duplicate"),
    /duplicate or invalid auditor/,
  );

  const substituted = structuredClone(a1);
  substituted.payload.auditorId = "audit-c";
  await assert.rejects(
    verify(
      files,
      entry1.entryPath,
      [substituted, b1],
      files.quorum0,
      "substitution",
    ),
    /signature key identity does not match|signature is invalid/,
  );

  const q1Name = "quorum-1";
  const verified1 = await verify(
    files,
    entry1.entryPath,
    [a1, b1],
    files.quorum0,
    q1Name,
  );
  assert.deepEqual(JSON.parse(verified1.stdout), {
    verified: true,
    sequence: 1,
    auditors: 2,
  });
  const q1 = join(files.root, `${q1Name}.json`);
  if (process.platform !== "win32")
    assert.equal((await stat(q1)).mode & 0o777, 0o444);

  await assert.rejects(
    verify(files, entry1.entryPath, [a1, b1], q1, "replay"),
    /not the retained quorum checkpoint successor/,
  );

  const tampered = JSON.parse(await readFile(entry1.entryPath, "utf8"));
  tampered.payload.publishedAt += 1;
  const tamperedPath = join(files.root, "entry-1-tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    verify(files, tamperedPath, [a1, b1], files.quorum0, "tampered"),
    /exact entry head/,
  );

  const entry2a = await writeEntry(
    files,
    "entry-2a",
    publication(
      2,
      canonicalSha256(JSON.parse(await readFile(entry1.entryPath))),
    ),
  );
  const entry2bValue = publication(
    2,
    canonicalSha256(JSON.parse(await readFile(entry1.entryPath))),
    2_000_000_002,
  );
  const entry2b = await writeEntry(files, "entry-2b", entry2bValue);
  const a2a = await attest(files, 0, entry2a, "-2a");
  const b2a = await attest(files, 1, entry2a, "-2a");
  const a2b = await attest(files, 0, entry2b, "-2b");
  const b2b = await attest(files, 1, entry2b, "-2b");
  await verify(files, entry2a.entryPath, [a2a, b2a], q1, "quorum-2a");
  await assert.rejects(
    verify(
      files,
      entry2b.entryPath,
      [a2b, b2b],
      join(files.root, "quorum-2a.json"),
      "fork",
    ),
    /not the retained quorum checkpoint successor/,
  );
});

test("binds a dual-signed publication-key rotation to the retained key", async () => {
  const files = await fixture();
  const prior = publication(1, null);
  const next = structuredClone(prior);
  next.signature.keyId = "9".repeat(64);
  next.signature.keyGeneration = 4;
  const rotation = {
    schemaVersion: 1,
    priorAuthorization: prior,
    nextAcceptance: next,
  };
  const entryPath = join(files.root, "rotation.json");
  const checkpointPath = join(files.root, "rotation.checkpoint.json");
  await writeFile(entryPath, JSON.stringify(rotation));
  await writeFile(
    checkpointPath,
    JSON.stringify({
      schemaVersion: 1,
      publicationKeyId: next.signature.keyId,
      publicationKeyGeneration: next.signature.keyGeneration,
      sequence: 1,
      entrySha256: canonicalSha256(rotation),
    }),
  );
  const entry = { entryPath, checkpointPath };
  const a = await attest(files, 0, entry, "-rotation");
  const b = await attest(files, 1, entry, "-rotation");
  await verify(files, entryPath, [a, b], files.quorum0, "rotation-quorum");
  const retained = JSON.parse(
    await readFile(join(files.root, "rotation-quorum.json"), "utf8"),
  );
  assert.equal(retained.publicationKeyId, next.signature.keyId);
  assert.equal(retained.publicationKeyGeneration, 4);

  const wrongPrior = structuredClone(rotation);
  wrongPrior.priorAuthorization.signature.keyId = "8".repeat(64);
  const wrongPriorPath = join(files.root, "rotation-wrong-prior.json");
  await writeFile(wrongPriorPath, JSON.stringify(wrongPrior));
  await assert.rejects(
    verify(files, wrongPriorPath, [a, b], files.quorum0, "wrong-prior"),
    /rotation does not start at the retained publication key/,
  );
});

test("rotates auditor configuration only with independent old and new thresholds", async () => {
  const files = await fixture();
  const next = await makeNextConfig(files);
  const oldA = await approveRotation(
    files,
    next,
    "prior-authorization",
    files.auditors[0],
    files.quorum0,
    "old-a",
  );
  const oldB = await approveRotation(
    files,
    next,
    "prior-authorization",
    files.auditors[1],
    files.quorum0,
    "old-b",
  );
  const newA = await approveRotation(
    files,
    next,
    "next-acceptance",
    next.auditors[0],
    files.quorum0,
    "new-a",
  );
  const newB = await approveRotation(
    files,
    next,
    "next-acceptance",
    next.auditors[1],
    files.quorum0,
    "new-b",
  );

  await assert.rejects(
    rotateConfig(files, next, [oldA], [newA, newB], files.quorum0, "short-old"),
    /prior-authorization threshold is not met/,
  );
  await assert.rejects(
    rotateConfig(files, next, [oldA, oldB], [newA], files.quorum0, "short-new"),
    /next-acceptance threshold is not met/,
  );
  await assert.rejects(
    rotateConfig(
      files,
      next,
      [oldB, oldA],
      [newA, newB],
      files.quorum0,
      "noncanonical-order",
    ),
    /sorted by auditor ID/,
  );
  const result = await rotateConfig(
    files,
    next,
    [oldA, oldB],
    [newA, newB],
    files.quorum0,
    "rotated",
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.configGeneration, 2);
  assert.equal(report.priorApprovals, 2);
  assert.equal(report.nextAcceptances, 2);
  const retained = JSON.parse(
    await readFile(join(files.root, "rotated.checkpoint.json"), "utf8"),
  );
  const initial = JSON.parse(await readFile(files.quorum0, "utf8"));
  assert.equal(retained.sequence, initial.sequence);
  assert.equal(retained.entrySha256, initial.entrySha256);
  assert.equal(retained.quorumConfigGeneration, 2);
  assert.match(retained.previousQuorumRotationSha256, /^[0-9a-f]{64}$/);

  files.configPath = next.configPath;
  files.auditors = next.auditors;
  const entry1 = await writeEntry(
    files,
    "post-rotation-entry-1",
    publication(1, null),
  );
  const postA = await attest(files, 0, entry1, "-post-rotation-a");
  const postB = await attest(files, 1, entry1, "-post-rotation-b");
  await verify(
    files,
    entry1.entryPath,
    [postA, postB],
    join(files.root, "rotated.checkpoint.json"),
    "post-rotation-quorum",
  );

  files.configPath = join(files.root, "auditors.json");

  await assert.rejects(
    rotateConfig(
      files,
      next,
      [oldA, oldB],
      [newA, newB],
      join(files.root, "rotated.checkpoint.json"),
      "replay",
    ),
    /checkpoint does not match the prior auditor config/,
  );
});

test("rejects rollback, substitution, tamper and reused cross-threshold identity", async () => {
  const files = await fixture();
  const rollback = await makeNextConfig(files, "rollback", 1);
  await assert.rejects(
    approveRotation(
      files,
      rollback,
      "prior-authorization",
      files.auditors[0],
      files.quorum0,
      "rollback",
    ),
    /generation must increase by exactly one/,
  );
  const skipped = await makeNextConfig(files, "skipped", 3);
  await assert.rejects(
    approveRotation(
      files,
      skipped,
      "prior-authorization",
      files.auditors[0],
      files.quorum0,
      "skipped",
    ),
    /generation must increase by exactly one/,
  );

  const next = await makeNextConfig(files, "replacement", 2);
  const oldA = await approveRotation(
    files,
    next,
    "prior-authorization",
    files.auditors[0],
    files.quorum0,
    "tamper-old-a",
  );
  const oldB = await approveRotation(
    files,
    next,
    "prior-authorization",
    files.auditors[1],
    files.quorum0,
    "tamper-old-b",
  );
  const newA = await approveRotation(
    files,
    next,
    "next-acceptance",
    next.auditors[0],
    files.quorum0,
    "tamper-new-a",
  );
  const newB = await approveRotation(
    files,
    next,
    "next-acceptance",
    next.auditors[1],
    files.quorum0,
    "tamper-new-b",
  );
  const tampered = structuredClone(newA);
  tampered.payload.sequence += 1;
  await assert.rejects(
    rotateConfig(
      files, next, [oldA, oldB], [tampered, newB], files.quorum0, "tampered",
    ),
    /signature is invalid/,
  );

  const substituted = JSON.parse(await readFile(next.configPath, "utf8"));
  substituted.threshold = 3;
  const substitutedPath = join(files.root, "substituted.config.json");
  await writeFile(substitutedPath, JSON.stringify(substituted));
  const originalPath = next.configPath;
  next.configPath = substitutedPath;
  await assert.rejects(
    rotateConfig(
      files, next, [oldA, oldB], [newA, newB], files.quorum0, "substituted",
    ),
    /exact transition|threshold is not met/,
  );
  next.configPath = originalPath;

  const overlapConfig = JSON.parse(await readFile(next.configPath, "utf8"));
  overlapConfig.auditors[0] = {
    auditorId: files.auditors[0].auditorId,
    keyId: files.auditors[0].keyId,
    keyGeneration: files.auditors[0].keyGeneration,
    publicKeyBase64Url: files.auditors[0].publicKeyBase64Url,
  };
  overlapConfig.auditors.sort((left, right) =>
    left.auditorId.localeCompare(right.auditorId),
  );
  const overlapPath = join(files.root, "overlap.config.json");
  await writeFile(overlapPath, JSON.stringify(overlapConfig));
  const overlap = {
    configPath: overlapPath,
    auditors: [files.auditors[0], ...next.auditors.slice(1)],
  };
  const overlapOldA = await approveRotation(
    files, overlap, "prior-authorization", files.auditors[0], files.quorum0, "overlap-old-a",
  );
  const overlapOldB = await approveRotation(
    files, overlap, "prior-authorization", files.auditors[1], files.quorum0, "overlap-old-b",
  );
  const overlapNewA = await approveRotation(
    files, overlap, "next-acceptance", files.auditors[0], files.quorum0, "overlap-new-a",
  );
  const overlapNewB = await approveRotation(
    files, overlap, "next-acceptance", next.auditors[1], files.quorum0, "overlap-new-b",
  );
  await assert.rejects(
    rotateConfig(
      files,
      overlap,
      [overlapOldA, overlapOldB],
      [overlapNewA, overlapNewB],
      files.quorum0,
      "overlap",
    ),
    /independent identities and keys/,
  );
});

test("durably advances a filesystem checkpoint with CAS and a canonical record", async () => {
  const files = await fixture();
  const entry = await writeEntry(files, "stored-entry-1", publication(1, null));
  const first = await attest(files, 0, entry, "-stored");
  const second = await attest(files, 1, entry, "-stored");
  const attestationsPath = join(files.root, "stored-attestations.json");
  await writeFile(attestationsPath, JSON.stringify([first, second]));
  const store = join(files.root, "quorum-store");
  const initialized = JSON.parse((await runStore(
    "init", "--store", store, "--checkpoint", files.quorum0,
  )).stdout);
  assert.match(initialized.checkpointSha256, /^[0-9a-f]{64}$/);

  const committed = JSON.parse((await runStore(
    "verify",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--config", files.configPath,
    "--entry", entry.entryPath,
    "--attestations", attestationsPath,
  )).stdout);
  assert.equal(committed.committed, true);
  assert.equal(committed.sequence, 1);
  const recordNames = await readdir(join(store, "records"));
  assert.deepEqual(recordNames, [`${committed.recordSha256}.json`]);
  const recordText = await readFile(join(store, "records", recordNames[0]), "utf8");
  const record = JSON.parse(recordText);
  assert.equal(`${JSON.stringify(record)}\n`, recordText);
  assert.equal(record.priorCheckpointSha256, initialized.checkpointSha256);
  assert.equal(record.nextCheckpointSha256, committed.checkpointSha256);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(store, "checkpoint.json"))).mode & 0o777, 0o400);
    assert.equal((await stat(join(store, "records", recordNames[0]))).mode & 0o777, 0o400);
  }

  await assert.rejects(
    runStore(
      "verify",
      "--store", store,
      "--expected-checkpoint-sha256", initialized.checkpointSha256,
      "--config", files.configPath,
      "--entry", entry.entryPath,
      "--attestations", attestationsPath,
    ),
    /checkpoint CAS mismatch/,
  );
  const inspected = JSON.parse((await runStore("inspect", "--store", store)).stdout);
  assert.equal(inspected.checkpointSha256, committed.checkpointSha256);
  assert.deepEqual(inspected.lock, { present: false });
  assert.equal(inspected.recoveryRequired, false);
});

test("serializes config rotation and persists the complete signed transition", async () => {
  const files = await fixture();
  const next = await makeNextConfig(files, "stored-next", 2);
  const oldA = await approveRotation(files, next, "prior-authorization", files.auditors[0], files.quorum0, "stored-old-a");
  const oldB = await approveRotation(files, next, "prior-authorization", files.auditors[1], files.quorum0, "stored-old-b");
  const newA = await approveRotation(files, next, "next-acceptance", next.auditors[0], files.quorum0, "stored-new-a");
  const newB = await approveRotation(files, next, "next-acceptance", next.auditors[1], files.quorum0, "stored-new-b");
  const oldPath = join(files.root, "stored-old-approvals.json");
  const newPath = join(files.root, "stored-new-approvals.json");
  await writeFile(oldPath, JSON.stringify([oldA, oldB]));
  await writeFile(newPath, JSON.stringify([newA, newB]));
  const store = join(files.root, "rotation-store");
  const initialized = JSON.parse((await runStore(
    "init", "--store", store, "--checkpoint", files.quorum0,
  )).stdout);
  const committed = JSON.parse((await runStore(
    "rotate",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--prior-config", files.configPath,
    "--next-config", next.configPath,
    "--prior-approvals", oldPath,
    "--next-acceptances", newPath,
  )).stdout);
  assert.equal(committed.configGeneration, 2);
  const record = JSON.parse(await readFile(
    join(store, "records", `${committed.recordSha256}.json`), "utf8",
  ));
  assert.equal(record.kind, "quorum-config-rotation");
  assert.deepEqual(record.rotation.priorApprovals, [oldA, oldB]);
  assert.deepEqual(record.rotation.nextAcceptances, [newA, newB]);
  const inspected = JSON.parse((await runStore("inspect", "--store", store)).stdout);
  assert.equal(inspected.checkpoint.quorumConfigGeneration, 2);
  assert.equal(inspected.checkpointSha256, committed.checkpointSha256);
});

test("requires an externally chained witness receipt before durable advances", async () => {
  const files = await fixture();
  const witness = await witnessFixture(files);
  const custody = await custodyFixture(files, witness);
  const store = join(files.root, "witnessed-store");
  const initialized = JSON.parse((await runStore(
    "init", "--store", store, "--checkpoint", files.quorum0,
  )).stdout);
  await runStore(
    "bind-witness",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--config", files.configPath,
    "--witness-config", witness.configPath,
  );
  const custodyStore = join(files.root, "external-custody-store");
  await runCustody(
    "init",
    "--store", custodyStore,
    "--config", custody.configPath,
    "--initial-checkpoint-sha256", initialized.checkpointSha256,
  );
  const entry1 = await writeEntry(files, "witnessed-entry-1", publication(1, null));
  const a1 = await attest(files, 0, entry1, "-witnessed-1");
  const b1 = await attest(files, 1, entry1, "-witnessed-1");
  const attestations1 = join(files.root, "witnessed-attestations-1.json");
  await writeFile(attestations1, JSON.stringify([a1, b1]));
  await assert.rejects(
    runStore(
      "verify",
      "--store", store,
      "--expected-checkpoint-sha256", initialized.checkpointSha256,
      "--config", files.configPath,
      "--entry", entry1.entryPath,
      "--attestations", attestations1,
    ),
    /policy requires a witnessed command/,
  );
  const request1 = join(files.root, "witness-request-1.json");
  await runStore(
    "prepare-witnessed-verify",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--config", files.configPath,
    "--entry", entry1.entryPath,
    "--attestations", attestations1,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", "genesis",
    "--output", request1,
  );
  const authenticated1 = join(files.root, "authenticated-request-1.json");
  await runCustody(
    "authenticate",
    "--config", custody.configPath,
    "--client-private-key", custody.clientPrivatePath,
    "--request", request1,
    "--output", authenticated1,
  );
  const tamperedAuthentication = JSON.parse(
    await readFile(authenticated1, "utf8"),
  );
  tamperedAuthentication.payload.nextCheckpointSha256 = "0".repeat(64);
  const tamperedAuthenticationPath = join(
    files.root,
    "tampered-authenticated-request.json",
  );
  await writeFile(
    tamperedAuthenticationPath,
    JSON.stringify(tamperedAuthentication),
  );
  await assert.rejects(
    runCustody(
      "authorize",
      "--store", custodyStore,
      "--config", custody.configPath,
      "--witness-private-key", witness.privatePath,
      "--authenticated-request", tamperedAuthenticationPath,
      "--expected-head-sha256", "genesis",
      "--output", join(files.root, "tampered-must-not-sign.json"),
    ),
    /signature is invalid/,
  );
  const occupiedOutput = join(files.root, "occupied-receipt.json");
  await writeFile(occupiedOutput, "occupied\n");
  await assert.rejects(
    runCustody(
      "authorize",
      "--store", custodyStore,
      "--config", custody.configPath,
      "--witness-private-key", witness.privatePath,
      "--authenticated-request", authenticated1,
      "--expected-head-sha256", "genesis",
      "--output", occupiedOutput,
    ),
    /receipt output already exists/,
  );
  const beforeAuthorization = JSON.parse((await runCustody(
    "inspect", "--store", custodyStore, "--config", custody.configPath,
  )).stdout);
  assert.equal(beforeAuthorization.head.witnessSequence, 0);
  if (process.platform !== "win32") {
    const racedCustodyStore = join(files.root, "raced-custody-store");
    await runCustody(
      "init",
      "--store", racedCustodyStore,
      "--config", custody.configPath,
      "--initial-checkpoint-sha256", initialized.checkpointSha256,
    );
    const raced = await interfereAfterLock(
      racedCustodyStore,
      [
        "authorize",
        "--store", racedCustodyStore,
        "--config", custody.configPath,
        "--witness-private-key", witness.privatePath,
        "--authenticated-request", authenticated1,
        "--expected-head-sha256", "genesis",
        "--output", join(files.root, "raced-receipt.json"),
      ],
      () => link(
        join(racedCustodyStore, ".custody.lock"),
        join(racedCustodyStore, ".custody.lock.alias"),
      ),
      { executable: custodyCli, lockName: ".custody.lock" },
    );
    assert.equal(raced.code, 1);
    assert.match(raced.stderr, /lock .*preserve state and inspect/);
    assert.equal(
      (await stat(join(racedCustodyStore, ".custody.lock"))).nlink,
      2,
    );

    const substitutedLockStore = join(files.root, "substituted-lock-custody");
    await runCustody(
      "init",
      "--store", substitutedLockStore,
      "--config", custody.configPath,
      "--initial-checkpoint-sha256", initialized.checkpointSha256,
    );
    const substitutedLock = await interfereAfterLock(
      substitutedLockStore,
      [
        "authorize",
        "--store", substitutedLockStore,
        "--config", custody.configPath,
        "--witness-private-key", witness.privatePath,
        "--authenticated-request", authenticated1,
        "--expected-head-sha256", "genesis",
        "--output", join(files.root, "substituted-lock-receipt.json"),
      ],
      async () => {
        await rename(
          join(substitutedLockStore, ".custody.lock"),
          join(substitutedLockStore, ".custody.lock.displaced"),
        );
        await writeFile(
          join(substitutedLockStore, ".custody.lock"),
          `${canonicalJson({ schemaVersion: 1, pid: 888_888 })}\n`,
          { mode: 0o600 },
        );
        await chmod(join(substitutedLockStore, ".custody.lock"), 0o600);
      },
      { executable: custodyCli, lockName: ".custody.lock" },
    );
    assert.equal(substitutedLock.code, 1);
    assert.match(
      substitutedLock.stderr,
      /custody lock identity changed; preserve state and inspect/,
    );
    assert.equal(
      await readFile(join(substitutedLockStore, ".custody.lock"), "utf8"),
      `${canonicalJson({ schemaVersion: 1, pid: 888_888 })}\n`,
    );
  }
  const receipt1 = join(files.root, "witness-receipt-1.json");
  const custodyCommit1 = JSON.parse((await runCustody(
    "authorize",
    "--store", custodyStore,
    "--config", custody.configPath,
    "--witness-private-key", witness.privatePath,
    "--authenticated-request", authenticated1,
    "--expected-head-sha256", "genesis",
    "--output", receipt1,
  )).stdout);
  assert.equal(custodyCommit1.witnessSequence, 1);
  const exportedReceipt1 = join(files.root, "exported-receipt-1.json");
  await runCustody(
    "export",
    "--store", custodyStore,
    "--config", custody.configPath,
    "--receipt-sha256", custodyCommit1.receiptSha256,
    "--output", exportedReceipt1,
  );
  assert.equal(
    await readFile(exportedReceipt1, "utf8"),
    await readFile(receipt1, "utf8"),
  );
  await assert.rejects(
    runCustody(
      "authorize",
      "--store", custodyStore,
      "--config", custody.configPath,
      "--witness-private-key", witness.privatePath,
      "--authenticated-request", authenticated1,
      "--expected-head-sha256", "genesis",
      "--output", join(files.root, "must-not-authorize.json"),
    ),
    /custody head CAS mismatch/,
  );
  const committed1 = JSON.parse((await runStore(
    "witnessed-verify",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--expected-witness-receipt-sha256", "genesis",
    "--config", files.configPath,
    "--entry", entry1.entryPath,
    "--attestations", attestations1,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", "genesis",
    "--witness-receipt", receipt1,
  )).stdout);
  assert.equal(committed1.sequence, 1);
  assert.match(committed1.witnessReceiptSha256, /^[0-9a-f]{64}$/);
  const stored1 = JSON.parse(await readFile(
    join(store, "records", `${committed1.recordSha256}.json`), "utf8",
  ));
  assert.equal(stored1.kind, "externally-witnessed-quorum-transition");
  assert.equal(stored1.transition.kind, "publication-quorum-advance");

  const entry2 = await writeEntry(
    files,
    "witnessed-entry-2",
    publication(2, canonicalSha256(JSON.parse(await readFile(entry1.entryPath)))),
  );
  const a2 = await attest(files, 0, entry2, "-witnessed-2");
  const b2 = await attest(files, 1, entry2, "-witnessed-2");
  const attestations2 = join(files.root, "witnessed-attestations-2.json");
  await writeFile(attestations2, JSON.stringify([a2, b2]));
  const request2 = join(files.root, "witness-request-2.json");
  await runStore(
    "prepare-witnessed-verify",
    "--store", store,
    "--expected-checkpoint-sha256", committed1.checkpointSha256,
    "--config", files.configPath,
    "--entry", entry2.entryPath,
    "--attestations", attestations2,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", receipt1,
    "--output", request2,
  );
  const authenticated2 = join(files.root, "authenticated-request-2.json");
  await runCustody(
    "authenticate",
    "--config", custody.configPath,
    "--client-private-key", custody.clientPrivatePath,
    "--request", request2,
    "--output", authenticated2,
  );
  const receipt2 = join(files.root, "witness-receipt-2.json");
  const receipt1Hash = canonicalSha256(JSON.parse(await readFile(receipt1)));
  await runCustody(
    "authorize",
    "--store", custodyStore,
    "--config", custody.configPath,
    "--witness-private-key", witness.privatePath,
    "--authenticated-request", authenticated2,
    "--expected-head-sha256", receipt1Hash,
    "--output", receipt2,
  );
  await assert.rejects(
    runStore(
      "witnessed-verify",
      "--store", store,
      "--expected-checkpoint-sha256", committed1.checkpointSha256,
      "--expected-witness-receipt-sha256", "genesis",
      "--config", files.configPath,
      "--entry", entry2.entryPath,
      "--attestations", attestations2,
      "--witness-config", witness.configPath,
      "--prior-witness-receipt", receipt1,
      "--witness-receipt", receipt2,
    ),
    /head says genesis/,
  );
  const committed2 = JSON.parse((await runStore(
    "witnessed-verify",
    "--store", store,
    "--expected-checkpoint-sha256", committed1.checkpointSha256,
    "--expected-witness-receipt-sha256", receipt1Hash,
    "--config", files.configPath,
    "--entry", entry2.entryPath,
    "--attestations", attestations2,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", receipt1,
    "--witness-receipt", receipt2,
  )).stdout);
  assert.equal(committed2.sequence, 2);
  const custodyInspection = JSON.parse((await runCustody(
    "inspect", "--store", custodyStore, "--config", custody.configPath,
  )).stdout);
  assert.equal(custodyInspection.head.witnessSequence, 2);
  const receipt2Hash = canonicalSha256(JSON.parse(await readFile(receipt2)));
  assert.equal(
    custodyInspection.head.receiptSha256,
    receipt2Hash,
  );
  const substitutedCustodyConfig = JSON.parse(
    await readFile(custody.configPath, "utf8"),
  );
  substitutedCustodyConfig.custodyId = "substituted-custody";
  const substitutedCustodyPath = join(files.root, "substituted-custody.json");
  await writeFile(
    substitutedCustodyPath,
    JSON.stringify(substitutedCustodyConfig),
  );
  await assert.rejects(
    runCustody(
      "inspect",
      "--store", custodyStore,
      "--config", substitutedCustodyPath,
    ),
    /belongs to another configuration/,
  );
  if (process.platform !== "win32") {
    const retainedReceiptPath = join(
      custodyStore,
      "receipts",
      `${receipt2Hash}.json`,
    );
    const displacedReceiptPath = `${retainedReceiptPath}.displaced`;
    await rename(retainedReceiptPath, displacedReceiptPath);
    await assert.rejects(
      runCustody(
        "inspect",
        "--store", custodyStore,
        "--config", custody.configPath,
      ),
      /retained witness receipt is missing/,
    );
    await rename(displacedReceiptPath, retainedReceiptPath);
    await chmod(custodyStore, 0o755);
    await assert.rejects(
      runCustody("inspect", "--store", custodyStore, "--config", custody.configPath),
      /must not grant group or other permissions/,
    );
  }
});

test("witnesses config rotation and rejects substitution, tamper, and shared keys", async () => {
  const files = await fixture();
  const witness = await witnessFixture(files, "rotation-witness");
  const next = await makeNextConfig(files, "witnessed-next", 2);
  const oldA = await approveRotation(files, next, "prior-authorization", files.auditors[0], files.quorum0, "witness-old-a");
  const oldB = await approveRotation(files, next, "prior-authorization", files.auditors[1], files.quorum0, "witness-old-b");
  const newA = await approveRotation(files, next, "next-acceptance", next.auditors[0], files.quorum0, "witness-new-a");
  const newB = await approveRotation(files, next, "next-acceptance", next.auditors[1], files.quorum0, "witness-new-b");
  const oldPath = join(files.root, "witness-old.json");
  const newPath = join(files.root, "witness-new.json");
  await writeFile(oldPath, JSON.stringify([oldA, oldB]));
  await writeFile(newPath, JSON.stringify([newA, newB]));
  const store = join(files.root, "witnessed-rotation-store");
  const initialized = JSON.parse((await runStore(
    "init", "--store", store, "--checkpoint", files.quorum0,
  )).stdout);
  await runStore(
    "bind-witness",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--config", files.configPath,
    "--witness-config", witness.configPath,
  );
  const request = join(files.root, "rotation-witness-request.json");
  await runStore(
    "prepare-witnessed-rotate",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--prior-config", files.configPath,
    "--next-config", next.configPath,
    "--prior-approvals", oldPath,
    "--next-acceptances", newPath,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", "genesis",
    "--output", request,
  );
  const receipt = join(files.root, "rotation-witness-receipt.json");
  await runWitness(
    "sign-reference",
    "--config", witness.configPath,
    "--private-key", witness.privatePath,
    "--request", request,
    "--retained-head", "genesis",
    "--retained-checkpoint-sha256", initialized.checkpointSha256,
    "--output", receipt,
  );
  const tampered = JSON.parse(await readFile(receipt, "utf8"));
  tampered.payload.nextCheckpointSha256 = "f".repeat(64);
  const tamperedPath = join(files.root, "tampered-witness-receipt.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    runStore(
      "witnessed-rotate",
      "--store", store,
      "--expected-checkpoint-sha256", initialized.checkpointSha256,
      "--expected-witness-receipt-sha256", "genesis",
      "--prior-config", files.configPath,
      "--next-config", next.configPath,
      "--prior-approvals", oldPath,
      "--next-acceptances", newPath,
      "--witness-config", witness.configPath,
      "--prior-witness-receipt", "genesis",
      "--witness-receipt", tamperedPath,
    ),
    /signature is invalid/,
  );
  const committed = JSON.parse((await runStore(
    "witnessed-rotate",
    "--store", store,
    "--expected-checkpoint-sha256", initialized.checkpointSha256,
    "--expected-witness-receipt-sha256", "genesis",
    "--prior-config", files.configPath,
    "--next-config", next.configPath,
    "--prior-approvals", oldPath,
    "--next-acceptances", newPath,
    "--witness-config", witness.configPath,
    "--prior-witness-receipt", "genesis",
    "--witness-receipt", receipt,
  )).stdout);
  assert.equal(committed.configGeneration, 2);

  const auditor = files.auditors[0];
  const sharedConfig = join(files.root, "shared-witness.json");
  await writeFile(sharedConfig, JSON.stringify({
    schemaVersion: 1,
    storeId: randomBytes(32).toString("hex"),
    witnessId: "shared-witness",
    keyId: auditor.keyId,
    keyGeneration: auditor.keyGeneration,
    publicKeyBase64Url: auditor.publicKeyBase64Url,
  }));
  const secondStore = join(files.root, "shared-witness-store");
  await runStore("init", "--store", secondStore, "--checkpoint", files.quorum0);
  await assert.rejects(
    runStore(
      "bind-witness",
      "--store", secondStore,
      "--expected-checkpoint-sha256", initialized.checkpointSha256,
      "--config", files.configPath,
      "--witness-config", sharedConfig,
    ),
    /external witness key must be independent/,
  );
});

test("rejects lock races, symlinks, hardlinks, and unsafe store permissions", async () => {
  const files = await fixture();
  async function initializedStore(name) {
    const store = join(files.root, name);
    const report = JSON.parse((await runStore(
      "init", "--store", store, "--checkpoint", files.quorum0,
    )).stdout);
    return { store, hash: report.checkpointSha256 };
  }

  const locked = await initializedStore("locked-store");
  await writeFile(join(locked.store, ".quorum.lock"), "occupied\n", { mode: 0o600 });
  const lockedInspection = JSON.parse(
    (await runStore("inspect", "--store", locked.store)).stdout,
  );
  assert.equal(lockedInspection.lock.present, true);
  assert.equal(lockedInspection.lock.regularSingleLink, true);
  assert.equal(lockedInspection.recoveryRequired, true);
  const entry = await writeEntry(files, "locked-entry", publication(1, null));
  const a = await attest(files, 0, entry, "-locked");
  const b = await attest(files, 1, entry, "-locked");
  const attestations = join(files.root, "locked-attestations.json");
  await writeFile(attestations, JSON.stringify([a, b]));
  await assert.rejects(runStore(
    "verify", "--store", locked.store,
    "--expected-checkpoint-sha256", locked.hash,
    "--config", files.configPath,
    "--entry", entry.entryPath,
    "--attestations", attestations,
  ), /lock already exists; inspect/);

  const pending = await initializedStore("pending-store");
  const pendingValue = {
    schemaVersion: 1,
    priorCheckpointSha256: pending.hash,
    nextCheckpointSha256: "a".repeat(64),
    recordSha256: "b".repeat(64),
  };
  await writeFile(
    join(pending.store, ".pending.json"),
    `${canonicalJson(pendingValue)}\n`,
    { mode: 0o400 },
  );
  await chmod(join(pending.store, ".pending.json"), 0o400);
  const pendingInspection = JSON.parse(
    (await runStore("inspect", "--store", pending.store)).stdout,
  );
  assert.equal(pendingInspection.recoveryRequired, true);
  assert.deepEqual(pendingInspection.pending, pendingValue);
  await assert.rejects(runStore(
    "verify", "--store", pending.store,
    "--expected-checkpoint-sha256", pending.hash,
    "--config", files.configPath,
    "--entry", entry.entryPath,
    "--attestations", attestations,
  ), /pending transaction exists; inspect/);

  if (process.platform !== "win32") {
    const linked = await initializedStore("hardlink-store");
    await link(join(linked.store, "checkpoint.json"), join(files.root, "checkpoint-alias.json"));
    await assert.rejects(runStore("inspect", "--store", linked.store), /single-link/);

    const symbolic = await initializedStore("symlink-store");
    await unlink(join(symbolic.store, "checkpoint.json"));
    await symlink(files.quorum0, join(symbolic.store, "checkpoint.json"));
    await assert.rejects(runStore("inspect", "--store", symbolic.store), /symlink/);

    const permissive = await initializedStore("permissive-store");
    await chmod(permissive.store, 0o755);
    await assert.rejects(runStore("inspect", "--store", permissive.store), /group or other/);

    const realParent = join(files.root, "real-store-parent");
    const aliasParent = join(files.root, "alias-store-parent");
    await mkdir(realParent, { mode: 0o700 });
    await chmod(realParent, 0o700);
    const nestedStore = join(realParent, "store");
    await runStore("init", "--store", nestedStore, "--checkpoint", files.quorum0);
    await symlink(realParent, aliasParent);
    await assert.rejects(
      runStore("inspect", "--store", join(aliasParent, "store")),
      /path must not traverse symlinks/,
    );

    function verifyArgs(store, hash) {
      return [
        "verify", "--store", store,
        "--expected-checkpoint-sha256", hash,
        "--config", files.configPath,
        "--entry", entry.entryPath,
        "--attestations", attestations,
      ];
    }

    const hardlinkedLock = await initializedStore("hardlinked-lock-store");
    const hardlinkResult = await interfereAfterLock(
      hardlinkedLock.store,
      verifyArgs(hardlinkedLock.store, hardlinkedLock.hash),
      () => link(
        join(hardlinkedLock.store, ".quorum.lock"),
        join(hardlinkedLock.store, ".quorum.lock.alias"),
      ),
    );
    assert.equal(hardlinkResult.code, 1);
    assert.match(hardlinkResult.stderr, /lock .*preserve state and inspect/);
    assert.equal((await stat(join(hardlinkedLock.store, ".quorum.lock"))).nlink, 2);

    const substitutedLock = await initializedStore("substituted-lock-store");
    const substitutedResult = await interfereAfterLock(
      substitutedLock.store,
      verifyArgs(substitutedLock.store, substitutedLock.hash),
      async () => {
        await rename(
          join(substitutedLock.store, ".quorum.lock"),
          join(substitutedLock.store, ".quorum.lock.displaced"),
        );
        await writeFile(
          join(substitutedLock.store, ".quorum.lock"),
          `${canonicalJson({ schemaVersion: 1, pid: 999_999 })}\n`,
          { mode: 0o600 },
        );
        await chmod(join(substitutedLock.store, ".quorum.lock"), 0o600);
      },
    );
    assert.equal(substitutedResult.code, 1);
    assert.match(substitutedResult.stderr, /lock identity changed; preserve state/);
    assert.equal(
      await readFile(join(substitutedLock.store, ".quorum.lock"), "utf8"),
      `${canonicalJson({ schemaVersion: 1, pid: 999_999 })}\n`,
    );
  }
});
