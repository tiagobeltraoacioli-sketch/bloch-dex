#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
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
export const AUDITOR_CONFIG_ROTATION_DOMAIN =
  "POSTERN_LIVE_AUDITOR_CONFIG_ROTATION_V1\n";

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
  exactKeys(
    config,
    ["schemaVersion", "configGeneration", "threshold", "auditors"],
    "config",
  );
  if (config.schemaVersion !== 1) fail("config schema is unsupported");
  positiveInteger(config.configGeneration, "config generation");
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

export function validateQuorumCheckpoint(checkpoint) {
  exactKeys(
    checkpoint,
    [
      "schemaVersion",
      "quorumConfigSha256",
      "quorumConfigGeneration",
      "previousQuorumRotationSha256",
      "threshold",
      "publicationKeyId",
      "publicationKeyGeneration",
      "sequence",
      "entrySha256",
    ],
    "quorum checkpoint",
  );
  if (
    checkpoint.schemaVersion !== 2 ||
    !HEX.test(checkpoint.quorumConfigSha256) ||
    !Number.isSafeInteger(checkpoint.quorumConfigGeneration) ||
    checkpoint.quorumConfigGeneration < 1 ||
    (checkpoint.previousQuorumRotationSha256 !== null &&
      !HEX.test(checkpoint.previousQuorumRotationSha256)) ||
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

function configRotationPayload(priorConfig, nextConfig, checkpoint) {
  return {
    schemaVersion: 1,
    priorConfigGeneration: priorConfig.configGeneration,
    nextConfigGeneration: nextConfig.configGeneration,
    priorConfigSha256: configIdentity(priorConfig),
    nextConfigSha256: configIdentity(nextConfig),
    priorQuorumCheckpointSha256: canonicalSha256(checkpoint),
    previousQuorumRotationSha256: checkpoint.previousQuorumRotationSha256,
    publicationKeyId: checkpoint.publicationKeyId,
    publicationKeyGeneration: checkpoint.publicationKeyGeneration,
    sequence: checkpoint.sequence,
    entrySha256: checkpoint.entrySha256,
  };
}

const CONFIG_ROTATION_FIELDS = [
  "schemaVersion",
  "priorConfigGeneration",
  "nextConfigGeneration",
  "priorConfigSha256",
  "nextConfigSha256",
  "priorQuorumCheckpointSha256",
  "previousQuorumRotationSha256",
  "publicationKeyId",
  "publicationKeyGeneration",
  "sequence",
  "entrySha256",
];

function validateConfigRotationPayload(payload) {
  exactKeys(payload, CONFIG_ROTATION_FIELDS, "config rotation payload");
  if (
    payload.schemaVersion !== 1 ||
    !Number.isSafeInteger(payload.priorConfigGeneration) ||
    payload.priorConfigGeneration < 1 ||
    payload.nextConfigGeneration !== payload.priorConfigGeneration + 1 ||
    !HEX.test(payload.priorConfigSha256) ||
    !HEX.test(payload.nextConfigSha256) ||
    payload.priorConfigSha256 === payload.nextConfigSha256 ||
    !HEX.test(payload.priorQuorumCheckpointSha256) ||
    (payload.previousQuorumRotationSha256 !== null &&
      !HEX.test(payload.previousQuorumRotationSha256)) ||
    !HEX.test(payload.publicationKeyId) ||
    !Number.isSafeInteger(payload.publicationKeyGeneration) ||
    payload.publicationKeyGeneration < 1 ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 0 ||
    (payload.sequence === 0
      ? payload.entrySha256 !== null
      : !HEX.test(payload.entrySha256))
  )
    fail("config rotation payload is invalid");
  return payload;
}

function rotationApprovalPayload(role, auditorId, rotation) {
  return { ...rotation, role, auditorId };
}

function validateRotationApprovalPayload(payload) {
  const { role, auditorId, ...rotation } = payload ?? {};
  exactKeys(
    payload,
    [...CONFIG_ROTATION_FIELDS, "role", "auditorId"],
    "config rotation approval payload",
  );
  if (
    (role !== "prior-authorization" && role !== "next-acceptance") ||
    typeof auditorId !== "string" ||
    !AUDITOR_ID.test(auditorId)
  )
    fail("config rotation approval identity is invalid");
  return { role, auditorId, rotation: validateConfigRotationPayload(rotation) };
}

function requireRotationInputs(priorConfig, nextConfig, checkpoint) {
  if (
    checkpoint.quorumConfigSha256 !== configIdentity(priorConfig) ||
    checkpoint.quorumConfigGeneration !== priorConfig.configGeneration ||
    checkpoint.threshold !== priorConfig.threshold
  )
    fail("checkpoint does not match the prior auditor config");
  if (nextConfig.configGeneration !== priorConfig.configGeneration + 1)
    fail("next config generation must increase by exactly one");
  requireIndependentAuditors(priorConfig, checkpoint.publicationKeyId);
  requireIndependentAuditors(nextConfig, checkpoint.publicationKeyId);
  return configRotationPayload(priorConfig, nextConfig, checkpoint);
}

export function verifyQuorumConfigRotation(
  priorConfigInput,
  nextConfigInput,
  priorApprovals,
  nextAcceptances,
  checkpointInput,
) {
  const priorConfig = validateAuditorConfig(priorConfigInput);
  const nextConfig = validateAuditorConfig(nextConfigInput);
  const checkpoint = validateQuorumCheckpoint(checkpointInput);
  const expectedRotation = requireRotationInputs(
    priorConfig,
    nextConfig,
    checkpoint,
  );
  if (
    !Array.isArray(priorApprovals) ||
    priorApprovals.length > priorConfig.auditors.length ||
    !Array.isArray(nextAcceptances) ||
    nextAcceptances.length > nextConfig.auditors.length
  )
    fail("rotation approvals must be bounded arrays");
  const usedIds = new Set();
  const usedKeys = new Set();
  function verifyApprovals(envelopes, config, role) {
    const seen = new Set();
    let priorSignerId = null;
    for (const envelope of envelopes) {
      const claimedId = envelope?.payload?.auditorId;
      if (typeof claimedId !== "string" || seen.has(claimedId))
        fail("duplicate or invalid rotation approval");
      if (priorSignerId !== null && claimedId <= priorSignerId)
        fail("rotation approvals must be uniquely sorted by auditor ID");
      priorSignerId = claimedId;
      const auditor = config.auditors.find(
        (candidate) => candidate.auditorId === claimedId,
      );
      if (!auditor) fail("rotation approver is not configured for its role");
      validateSignatureShape(envelope.signature, "rotation approval signature");
      const approved = validateRotationApprovalPayload(
        verifyEnvelope(
          envelope,
          publicKeyFromRaw(auditor.publicKeyBase64Url),
          AUDITOR_CONFIG_ROTATION_DOMAIN,
          auditor.keyGeneration,
        ),
      );
      if (
        approved.role !== role ||
        canonicalJson(approved.rotation) !== canonicalJson(expectedRotation)
      )
        fail("rotation approval does not bind the exact transition");
      if (usedIds.has(auditor.auditorId) || usedKeys.has(auditor.keyId))
        fail("rotation thresholds must use independent identities and keys");
      seen.add(auditor.auditorId);
      usedIds.add(auditor.auditorId);
      usedKeys.add(auditor.keyId);
    }
    if (seen.size < config.threshold) fail(`${role} threshold is not met`);
    return seen.size;
  }
  const priorCount = verifyApprovals(
    priorApprovals,
    priorConfig,
    "prior-authorization",
  );
  const nextCount = verifyApprovals(
    nextAcceptances,
    nextConfig,
    "next-acceptance",
  );
  const rotationRecord = {
    schemaVersion: 1,
    payload: expectedRotation,
    priorApprovals,
    nextAcceptances,
  };
  const checkpointSha256 = canonicalSha256(checkpoint);
  const nextCheckpoint = {
    ...checkpoint,
    quorumConfigSha256: configIdentity(nextConfig),
    quorumConfigGeneration: nextConfig.configGeneration,
    previousQuorumRotationSha256: canonicalSha256(rotationRecord),
    threshold: nextConfig.threshold,
  };
  return {
    checkpoint: nextCheckpoint,
    priorCount,
    nextCount,
    record: {
      schemaVersion: 1,
      kind: "quorum-config-rotation",
      priorCheckpointSha256: checkpointSha256,
      nextCheckpointSha256: canonicalSha256(nextCheckpoint),
      rotation: rotationRecord,
    },
  };
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

export function verifyQuorumPublication(
  configInput,
  entry,
  attestations,
  checkpointInput,
) {
  const config = validateAuditorConfig(configInput);
  const configSha256 = configIdentity(config);
  const checkpoint = validateQuorumCheckpoint(checkpointInput);
  if (
    checkpoint.quorumConfigSha256 !== configSha256 ||
    checkpoint.quorumConfigGeneration !== config.configGeneration ||
    checkpoint.threshold !== config.threshold
  )
    fail("checkpoint does not match the auditor config");
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
  if (!Array.isArray(attestations) || attestations.length > config.auditors.length)
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
    schemaVersion: 2,
    quorumConfigSha256: configSha256,
    quorumConfigGeneration: config.configGeneration,
    previousQuorumRotationSha256: checkpoint.previousQuorumRotationSha256,
    threshold: config.threshold,
    publicationKeyId: head.keyId,
    publicationKeyGeneration: head.keyGeneration,
    sequence: head.payload.sequence,
    entrySha256: head.entrySha256,
  };
  return {
    checkpoint: next,
    auditorCount: seen.size,
    record: {
      schemaVersion: 1,
      kind: "publication-quorum-advance",
      priorCheckpointSha256: canonicalSha256(checkpoint),
      nextCheckpointSha256: canonicalSha256(next),
      entrySha256: head.entrySha256,
      attestations,
    },
  };
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
  node scripts/publication-quorum.mjs verify --config <auditors.json> --entry <publication-entry.json> --attestations <attestations.json> --checkpoint <quorum-checkpoint.json> --output-checkpoint <next-quorum-checkpoint.json>
  node scripts/publication-quorum.mjs attest-config-rotation --prior-config <auditors.json> --next-config <auditors.json> --role <prior-authorization|next-acceptance> --auditor-id <id> --private-key <ed25519-private.pem> --checkpoint <quorum-checkpoint.json> --output <approval.json>
  node scripts/publication-quorum.mjs rotate-config --prior-config <auditors.json> --next-config <auditors.json> --prior-approvals <approvals.json> --next-acceptances <acceptances.json> --checkpoint <quorum-checkpoint.json> --output-checkpoint <next-quorum-checkpoint.json>`);
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
        schemaVersion: 2,
        quorumConfigSha256: configIdentity(config),
        quorumConfigGeneration: config.configGeneration,
        previousQuorumRotationSha256: null,
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
  if (command === "attest-config-rotation") {
    const values = parse(command, args, [
      "--prior-config",
      "--next-config",
      "--role",
      "--auditor-id",
      "--private-key",
      "--checkpoint",
      "--output",
    ]);
    const priorConfig = validateAuditorConfig(
      await readJson(values["--prior-config"], 64_000),
    );
    const nextConfig = validateAuditorConfig(
      await readJson(values["--next-config"], 64_000),
    );
    const checkpoint = validateQuorumCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    const rotation = requireRotationInputs(priorConfig, nextConfig, checkpoint);
    const role = values["--role"];
    const config = role === "prior-authorization"
      ? priorConfig
      : role === "next-acceptance"
        ? nextConfig
        : fail("rotation role is invalid");
    const auditor = config.auditors.find(
      (candidate) => candidate.auditorId === values["--auditor-id"],
    );
    if (!auditor) fail("auditor is not configured for rotation role");
    const privateKey = await readPrivateKey(values["--private-key"]);
    if (describeKey(privateKey).keyId !== auditor.keyId)
      fail("private key does not match configured auditor");
    await writeNewJson(
      values["--output"],
      signEnvelope(
        rotationApprovalPayload(role, auditor.auditorId, rotation),
        privateKey,
        AUDITOR_CONFIG_ROTATION_DOMAIN,
        auditor.keyGeneration,
      ),
      0o444,
    );
    return;
  }
  if (command === "rotate-config") {
    const values = parse(command, args, [
      "--prior-config",
      "--next-config",
      "--prior-approvals",
      "--next-acceptances",
      "--checkpoint",
      "--output-checkpoint",
    ]);
    const priorConfig = validateAuditorConfig(
      await readJson(values["--prior-config"], 64_000),
    );
    const nextConfig = validateAuditorConfig(
      await readJson(values["--next-config"], 64_000),
    );
    const checkpoint = validateQuorumCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    const priorApprovals = await readJson(values["--prior-approvals"], 512_000);
    const nextAcceptances = await readJson(values["--next-acceptances"], 512_000);
    const result = verifyQuorumConfigRotation(
      priorConfig,
      nextConfig,
      priorApprovals,
      nextAcceptances,
      checkpoint,
    );
    const nextCheckpoint = result.checkpoint;
    await writeNewJson(values["--output-checkpoint"], nextCheckpoint, 0o444);
    console.log(canonicalJson({
      rotated: true,
      configGeneration: nextConfig.configGeneration,
      priorApprovals: result.priorCount,
      nextAcceptances: result.nextCount,
      rotationSha256: nextCheckpoint.previousQuorumRotationSha256,
    }));
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
    const checkpoint = validateQuorumCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    const entry = await readJson(values["--entry"]);
    const attestations = await readJson(values["--attestations"], 512_000);
    const result = verifyQuorumPublication(
      config,
      entry,
      attestations,
      checkpoint,
    );
    const next = result.checkpoint;
    await writeNewJson(values["--output-checkpoint"], next, 0o444);
    console.log(
      canonicalJson({
        verified: true,
        sequence: next.sequence,
        auditors: result.auditorCount,
      }),
    );
    return;
  }
  usage();
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
