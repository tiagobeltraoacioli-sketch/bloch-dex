#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import {
  canonicalJson,
  canonicalSha256,
  describeKey,
  readJson,
  readPrivateKey,
  signEnvelope,
  validatePublication,
  validatePublicationCheckpoint,
  verifyEnvelope,
  writeNewJson,
} from "./live-auth/envelope.mjs";

export const AUDITOR_ATTESTATION_DOMAIN =
  "POSTERN_LIVE_PUBLICATION_AUDITOR_ATTESTATION_V1\n";

const HEX = /^[0-9a-f]{64}$/;
const B64_KEY = /^[A-Za-z0-9_-]{43}$/;
const B64_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const AUDITOR_ID = /^[a-z][a-z0-9-]{0,62}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function fail(message) {
  throw new Error(`publication quorum: ${message}`);
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${field} fields are invalid`);
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail(`${field} must be a positive safe integer`);
  return value;
}

function publicKeyFromRaw(value) {
  if (typeof value !== "string" || !B64_KEY.test(value))
    fail("auditor public key encoding is invalid");
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== value)
    fail("auditor public key encoding is invalid");
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("auditor public key is invalid");
  }
}

export function validateAuditorConfig(config) {
  exactKeys(config, ["schemaVersion", "threshold", "auditors"], "config");
  if (config.schemaVersion !== 1) fail("config schema is unsupported");
  if (!Array.isArray(config.auditors) || config.auditors.length < 2)
    fail("config requires at least two auditors");
  if (config.auditors.length > 32) fail("config has too many auditors");
  positiveInteger(config.threshold, "threshold");
  if (config.threshold < 2 || config.threshold > config.auditors.length)
    fail("threshold must be between two and the auditor count");
  const ids = new Set();
  const keyIds = new Set();
  let priorId = null;
  for (const auditor of config.auditors) {
    exactKeys(
      auditor,
      ["auditorId", "keyId", "keyGeneration", "publicKeyBase64Url"],
      "auditor",
    );
    if (
      typeof auditor.auditorId !== "string" ||
      !AUDITOR_ID.test(auditor.auditorId)
    )
      fail("auditor ID is invalid");
    if (priorId !== null && auditor.auditorId <= priorId)
      fail("auditors must be uniquely sorted by ID");
    priorId = auditor.auditorId;
    positiveInteger(auditor.keyGeneration, "auditor key generation");
    const identity = describeKey(publicKeyFromRaw(auditor.publicKeyBase64Url));
    if (auditor.keyId !== identity.keyId) fail("auditor key ID does not match");
    if (ids.has(auditor.auditorId) || keyIds.has(identity.keyId))
      fail("auditor IDs and keys must be independent");
    ids.add(auditor.auditorId);
    keyIds.add(identity.keyId);
  }
  return config;
}

function validateSignatureShape(signature, field) {
  exactKeys(signature, ["algorithm", "keyId", "keyGeneration", "value"], field);
  if (
    signature.algorithm !== "Ed25519" ||
    !HEX.test(signature.keyId) ||
    !Number.isSafeInteger(signature.keyGeneration) ||
    signature.keyGeneration < 1 ||
    typeof signature.value !== "string" ||
    !B64_SIGNATURE.test(signature.value) ||
    Buffer.from(signature.value, "base64url").toString("base64url") !==
      signature.value
  )
    fail(`${field} is invalid`);
}

function publicationEnvelopeHead(envelope, field) {
  exactKeys(envelope, ["schemaVersion", "payload", "signature"], field);
  if (envelope.schemaVersion !== 2) fail(`${field} schema is unsupported`);
  const payload = validatePublication(envelope.payload);
  validateSignatureShape(envelope.signature, `${field} signature`);
  return {
    payload,
    keyId: envelope.signature.keyId,
    keyGeneration: envelope.signature.keyGeneration,
  };
}

export function publicationArtifactHead(entry) {
  if (entry && Object.hasOwn(entry, "priorAuthorization")) {
    exactKeys(
      entry,
      ["schemaVersion", "priorAuthorization", "nextAcceptance"],
      "rotation",
    );
    if (entry.schemaVersion !== 1) fail("rotation schema is unsupported");
    const prior = publicationEnvelopeHead(
      entry.priorAuthorization,
      "prior authorization",
    );
    const next = publicationEnvelopeHead(
      entry.nextAcceptance,
      "next acceptance",
    );
    if (canonicalJson(prior.payload) !== canonicalJson(next.payload))
      fail("rotation signatures disagree");
    if (prior.keyId === next.keyId || next.keyGeneration <= prior.keyGeneration)
      fail("rotation key transition is invalid");
    return {
      ...next,
      priorKeyId: prior.keyId,
      priorKeyGeneration: prior.keyGeneration,
      entrySha256: canonicalSha256(entry),
    };
  }
  const head = publicationEnvelopeHead(entry, "publication entry");
  return { ...head, entrySha256: canonicalSha256(entry) };
}

function configIdentity(config) {
  return canonicalSha256(validateAuditorConfig(config));
}

function requireIndependentAuditors(config, ...publicationKeyIds) {
  const forbidden = new Set(publicationKeyIds.filter(Boolean));
  if (config.auditors.some((auditor) => forbidden.has(auditor.keyId)))
    fail("auditor keys must be independent from publication keys");
}

function validateQuorumCheckpoint(checkpoint) {
  exactKeys(
    checkpoint,
    [
      "schemaVersion",
      "quorumConfigSha256",
      "threshold",
      "publicationKeyId",
      "publicationKeyGeneration",
      "sequence",
      "entrySha256",
    ],
    "quorum checkpoint",
  );
  if (
    checkpoint.schemaVersion !== 1 ||
    !HEX.test(checkpoint.quorumConfigSha256) ||
    !Number.isSafeInteger(checkpoint.threshold) ||
    checkpoint.threshold < 2 ||
    !HEX.test(checkpoint.publicationKeyId) ||
    !Number.isSafeInteger(checkpoint.publicationKeyGeneration) ||
    checkpoint.publicationKeyGeneration < 1 ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    (checkpoint.sequence === 0
      ? checkpoint.entrySha256 !== null
      : !HEX.test(checkpoint.entrySha256))
  )
    fail("quorum checkpoint is invalid");
  return checkpoint;
}

function attestationPayload(configSha256, auditorId, head) {
  return {
    schemaVersion: 1,
    quorumConfigSha256: configSha256,
    auditorId,
    publicationKeyId: head.keyId,
    publicationKeyGeneration: head.keyGeneration,
    sequence: head.payload.sequence,
    previousEntrySha256: head.payload.previousEntrySha256,
    entrySha256: head.entrySha256,
  };
}

function validateAttestationPayload(payload) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "quorumConfigSha256",
      "auditorId",
      "publicationKeyId",
      "publicationKeyGeneration",
      "sequence",
      "previousEntrySha256",
      "entrySha256",
    ],
    "attestation payload",
  );
  if (
    payload.schemaVersion !== 1 ||
    !HEX.test(payload.quorumConfigSha256) ||
    typeof payload.auditorId !== "string" ||
    !AUDITOR_ID.test(payload.auditorId) ||
    !HEX.test(payload.publicationKeyId) ||
    !Number.isSafeInteger(payload.publicationKeyGeneration) ||
    payload.publicationKeyGeneration < 1 ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1 ||
    (payload.sequence === 1
      ? payload.previousEntrySha256 !== null
      : !HEX.test(payload.previousEntrySha256)) ||
    !HEX.test(payload.entrySha256)
  )
    fail("attestation payload is invalid");
  return payload;
}

function parse(command, args, names) {
  if (args.length !== names.length * 2)
    fail("arguments are incomplete or duplicated");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!names.includes(name) || Object.hasOwn(values, name))
      fail(`unexpected ${command} argument`);
    values[name] = args[index + 1];
  }
  if (names.some((name) => !values[name])) fail(`missing ${command} argument`);
  return values;
}

function usage() {
  console.error(`Usage:
  node scripts/publication-quorum.mjs init --config <auditors.json> --publication-checkpoint <checkpoint.json> --output-checkpoint <quorum-checkpoint.json>
  node scripts/publication-quorum.mjs attest --config <auditors.json> --auditor-id <id> --private-key <ed25519-private.pem> --entry <publication-entry.json> --publication-checkpoint <checkpoint.json> --output <attestation.json>
  node scripts/publication-quorum.mjs verify --config <auditors.json> --entry <publication-entry.json> --attestations <attestations.json> --checkpoint <quorum-checkpoint.json> --output-checkpoint <next-quorum-checkpoint.json>`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    const values = parse(command, args, [
      "--config",
      "--publication-checkpoint",
      "--output-checkpoint",
    ]);
    const config = validateAuditorConfig(
      await readJson(values["--config"], 64_000),
    );
    const publication = validatePublicationCheckpoint(
      await readJson(values["--publication-checkpoint"], 4_096),
    );
    requireIndependentAuditors(config, publication.publicationKeyId);
    await writeNewJson(
      values["--output-checkpoint"],
      {
        schemaVersion: 1,
        quorumConfigSha256: configIdentity(config),
        threshold: config.threshold,
        publicationKeyId: publication.publicationKeyId,
        publicationKeyGeneration: publication.publicationKeyGeneration,
        sequence: publication.sequence,
        entrySha256: publication.entrySha256,
      },
      0o444,
    );
    return;
  }
  if (command === "attest") {
    const values = parse(command, args, [
      "--config",
      "--auditor-id",
      "--private-key",
      "--entry",
      "--publication-checkpoint",
      "--output",
    ]);
    const config = validateAuditorConfig(
      await readJson(values["--config"], 64_000),
    );
    const auditor = config.auditors.find(
      (candidate) => candidate.auditorId === values["--auditor-id"],
    );
    if (!auditor) fail("auditor is not configured");
    const privateKey = await readPrivateKey(values["--private-key"]);
    if (describeKey(privateKey).keyId !== auditor.keyId)
      fail("private key does not match configured auditor");
    const entry = await readJson(values["--entry"]);
    const head = publicationArtifactHead(entry);
    requireIndependentAuditors(config, head.keyId, head.priorKeyId);
    const publication = validatePublicationCheckpoint(
      await readJson(values["--publication-checkpoint"], 4_096),
    );
    if (
      publication.entrySha256 !== head.entrySha256 ||
      publication.sequence !== head.payload.sequence ||
      publication.publicationKeyId !== head.keyId ||
      publication.publicationKeyGeneration !== head.keyGeneration
    )
      fail("entry does not match the retained publication checkpoint");
    const payload = attestationPayload(
      configIdentity(config),
      auditor.auditorId,
      head,
    );
    await writeNewJson(
      values["--output"],
      signEnvelope(
        payload,
        privateKey,
        AUDITOR_ATTESTATION_DOMAIN,
        auditor.keyGeneration,
      ),
      0o444,
    );
    return;
  }
  if (command === "verify") {
    const values = parse(command, args, [
      "--config",
      "--entry",
      "--attestations",
      "--checkpoint",
      "--output-checkpoint",
    ]);
    const config = validateAuditorConfig(
      await readJson(values["--config"], 64_000),
    );
    const configSha256 = configIdentity(config);
    const checkpoint = validateQuorumCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    if (
      checkpoint.quorumConfigSha256 !== configSha256 ||
      checkpoint.threshold !== config.threshold
    )
      fail("checkpoint does not match the auditor config");
    const entry = await readJson(values["--entry"]);
    const head = publicationArtifactHead(entry);
    requireIndependentAuditors(config, head.keyId, head.priorKeyId);
    if (
      head.payload.sequence !== checkpoint.sequence + 1 ||
      head.payload.previousEntrySha256 !== checkpoint.entrySha256
    )
      fail("entry is not the retained quorum checkpoint successor");
    if (head.priorKeyId) {
      if (
        head.priorKeyId !== checkpoint.publicationKeyId ||
        head.priorKeyGeneration !== checkpoint.publicationKeyGeneration
      )
        fail("rotation does not start at the retained publication key");
    } else if (
      head.keyId !== checkpoint.publicationKeyId ||
      head.keyGeneration !== checkpoint.publicationKeyGeneration
    ) {
      fail("entry publication key does not match the retained checkpoint");
    }
    const attestations = await readJson(values["--attestations"], 512_000);
    if (
      !Array.isArray(attestations) ||
      attestations.length > config.auditors.length
    )
      fail("attestations must be a bounded array");
    const seen = new Set();
    for (const envelope of attestations) {
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        fail("attestation must be an object");
      const claimedId = envelope.payload?.auditorId;
      if (typeof claimedId !== "string" || seen.has(claimedId))
        fail("duplicate or invalid auditor attestation");
      const auditor = config.auditors.find(
        (candidate) => candidate.auditorId === claimedId,
      );
      if (!auditor) fail("attestation auditor is not configured");
      validateSignatureShape(envelope.signature, "attestation signature");
      const payload = validateAttestationPayload(
        verifyEnvelope(
          envelope,
          publicKeyFromRaw(auditor.publicKeyBase64Url),
          AUDITOR_ATTESTATION_DOMAIN,
          auditor.keyGeneration,
        ),
      );
      if (
        canonicalJson(payload) !==
        canonicalJson(attestationPayload(configSha256, auditor.auditorId, head))
      )
        fail("attestation does not bind the exact entry head");
      seen.add(claimedId);
    }
    if (seen.size < config.threshold) fail("auditor threshold is not met");
    const next = {
      schemaVersion: 1,
      quorumConfigSha256: configSha256,
      threshold: config.threshold,
      publicationKeyId: head.keyId,
      publicationKeyGeneration: head.keyGeneration,
      sequence: head.payload.sequence,
      entrySha256: head.entrySha256,
    };
    await writeNewJson(values["--output-checkpoint"], next, 0o444);
    console.log(
      canonicalJson({
        verified: true,
        sequence: next.sequence,
        auditors: seen.size,
      }),
    );
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
