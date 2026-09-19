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
