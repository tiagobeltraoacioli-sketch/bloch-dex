import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalSha256, describeKey } from "./live-auth/envelope.mjs";

const execute = promisify(execFile);
const cli = resolve("scripts/publication-quorum.mjs");
const ZERO_SIGNATURE = Buffer.alloc(64).toString("base64url");
const PUBLICATION_KEY_ID = "a".repeat(64);

async function run(...args) {
  return execute(process.execPath, [cli, ...args], { cwd: resolve(".") });
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
