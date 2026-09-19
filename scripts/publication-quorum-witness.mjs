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
  verifyEnvelope,
  writeNewJson,
} from "./live-auth/envelope.mjs";

export const QUORUM_WITNESS_DOMAIN =
  "POSTERN_PUBLICATION_QUORUM_EXTERNAL_WITNESS_V1\n";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const B64_KEY = /^[A-Za-z0-9_-]{43}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function fail(message) {
  throw new Error(`publication quorum witness: ${message}`);
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

function rawPublicKey(value) {
  if (typeof value !== "string" || !B64_KEY.test(value))
    fail("public key encoding is invalid");
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== value)
    fail("public key encoding is invalid");
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("public key is invalid");
  }
}

export function validateWitnessConfig(config) {
  exactKeys(
    config,
    [
      "schemaVersion",
      "storeId",
      "witnessId",
      "keyId",
      "keyGeneration",
      "publicKeyBase64Url",
    ],
    "witness config",
  );
  if (
    config.schemaVersion !== 1 ||
    !HEX.test(config.storeId) ||
    typeof config.witnessId !== "string" ||
    !ID.test(config.witnessId) ||
    !Number.isSafeInteger(config.keyGeneration) ||
    config.keyGeneration < 1
  )
    fail("witness config is invalid");
  const identity = describeKey(rawPublicKey(config.publicKeyBase64Url));
  if (identity.keyId !== config.keyId)
    fail("witness key ID does not match its public key");
  return config;
}

export function validateWitnessPayload(payload) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "storeId",
      "witnessId",
      "witnessSequence",
      "previousWitnessReceiptSha256",
      "priorCheckpointSha256",
      "nextCheckpointSha256",
      "transitionRecordSha256",
      "transitionKind",
    ],
    "witness payload",
  );
  if (
    payload.schemaVersion !== 1 ||
    !HEX.test(payload.storeId) ||
    typeof payload.witnessId !== "string" ||
    !ID.test(payload.witnessId) ||
    !Number.isSafeInteger(payload.witnessSequence) ||
    payload.witnessSequence < 1 ||
    (payload.previousWitnessReceiptSha256 !== null &&
      !HEX.test(payload.previousWitnessReceiptSha256)) ||
    !HEX.test(payload.priorCheckpointSha256) ||
    !HEX.test(payload.nextCheckpointSha256) ||
    payload.nextCheckpointSha256 === payload.priorCheckpointSha256 ||
    !HEX.test(payload.transitionRecordSha256) ||
    (payload.transitionKind !== "publication-quorum-advance" &&
      payload.transitionKind !== "quorum-config-rotation")
  )
    fail("witness payload is invalid");
  if (
    (payload.witnessSequence === 1) !==
    (payload.previousWitnessReceiptSha256 === null)
  )
    fail("witness genesis linkage is invalid");
  return payload;
}

export function verifyWitnessReceipt(configInput, receipt) {
  const config = validateWitnessConfig(configInput);
  const payload = validateWitnessPayload(
    verifyEnvelope(
      receipt,
      rawPublicKey(config.publicKeyBase64Url),
      QUORUM_WITNESS_DOMAIN,
      config.keyGeneration,
    ),
  );
  if (payload.storeId !== config.storeId || payload.witnessId !== config.witnessId)
    fail("receipt is for a different store or witness");
  return payload;
}

export function nextWitnessPayload(configInput, priorReceipt, transition) {
  const config = validateWitnessConfig(configInput);
  const priorPayload = priorReceipt === null
    ? null
    : verifyWitnessReceipt(config, priorReceipt);
  if (
    !transition ||
    typeof transition !== "object" ||
    !HEX.test(transition.priorCheckpointSha256) ||
    !HEX.test(transition.nextCheckpointSha256) ||
    (transition.kind !== "publication-quorum-advance" &&
      transition.kind !== "quorum-config-rotation")
  )
    fail("transition record is invalid");
  if (
    priorPayload &&
    priorPayload.nextCheckpointSha256 !== transition.priorCheckpointSha256
  )
    fail("prior witness receipt is not at the retained checkpoint");
  return {
    schemaVersion: 1,
    storeId: config.storeId,
    witnessId: config.witnessId,
    witnessSequence: (priorPayload?.witnessSequence ?? 0) + 1,
    previousWitnessReceiptSha256:
      priorReceipt === null ? null : canonicalSha256(priorReceipt),
    priorCheckpointSha256: transition.priorCheckpointSha256,
    nextCheckpointSha256: transition.nextCheckpointSha256,
    transitionRecordSha256: canonicalSha256(transition),
    transitionKind: transition.kind,
  };
}

export function witnessTransition(config, priorReceipt, transition, receipt) {
  const expected = nextWitnessPayload(config, priorReceipt, transition);
  const actual = verifyWitnessReceipt(config, receipt);
  if (canonicalJson(actual) !== canonicalJson(expected))
    fail("receipt does not authorize the exact transition and witness head");
  return {
    schemaVersion: 1,
    kind: "externally-witnessed-quorum-transition",
    priorCheckpointSha256: transition.priorCheckpointSha256,
    nextCheckpointSha256: transition.nextCheckpointSha256,
    transition,
    witnessReceipt: receipt,
  };
}

function parse(args) {
  const names = [
    "--config",
    "--private-key",
    "--request",
    "--retained-head",
    "--retained-checkpoint-sha256",
    "--output",
  ];
  if (args.length !== names.length * 2)
    fail("arguments are incomplete or duplicated");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!names.includes(args[index]) || Object.hasOwn(values, args[index]))
      fail("unexpected sign-reference argument");
    values[args[index]] = args[index + 1];
  }
  if (names.some((name) => !values[name])) fail("missing sign-reference argument");
  return values;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "sign-reference") {
    console.error(`Usage:
  node scripts/publication-quorum-witness.mjs sign-reference --config <witness.json> --private-key <ed25519-private.pem> --request <request.json> --retained-head <genesis-or-prior-receipt.json> --retained-checkpoint-sha256 <sha256> --output <receipt.json>`);
    process.exitCode = 2;
    return;
  }
  const values = parse(args);
  const config = validateWitnessConfig(await readJson(values["--config"], 64_000));
  const request = validateWitnessPayload(await readJson(values["--request"], 16_384));
  const retainedCheckpoint = values["--retained-checkpoint-sha256"];
  if (!HEX.test(retainedCheckpoint)) fail("retained checkpoint hash is invalid");
  const priorReceipt = values["--retained-head"] === "genesis"
    ? null
    : await readJson(values["--retained-head"], 64_000);
  if (priorReceipt === null) {
    if (
      request.witnessSequence !== 1 ||
      request.previousWitnessReceiptSha256 !== null ||
      request.priorCheckpointSha256 !== retainedCheckpoint
    )
      fail("request does not start at the retained witness genesis");
  } else {
    const prior = verifyWitnessReceipt(config, priorReceipt);
    if (
      canonicalSha256(priorReceipt) !== request.previousWitnessReceiptSha256 ||
      request.witnessSequence !== prior.witnessSequence + 1 ||
      prior.nextCheckpointSha256 !== retainedCheckpoint ||
      request.priorCheckpointSha256 !== retainedCheckpoint
    )
      fail("request does not directly extend the retained witness head");
  }
  if (request.storeId !== config.storeId || request.witnessId !== config.witnessId)
    fail("request is for a different store or witness");
  const privateKey = await readPrivateKey(values["--private-key"]);
  if (describeKey(privateKey).keyId !== config.keyId)
    fail("private key does not match witness config");
  await writeNewJson(
    values["--output"],
    signEnvelope(request, privateKey, QUORUM_WITNESS_DOMAIN, config.keyGeneration),
    0o444,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
