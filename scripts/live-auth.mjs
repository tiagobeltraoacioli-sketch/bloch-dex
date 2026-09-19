#!/usr/bin/env node
import {
  describeKey,
  canonicalJson,
  canonicalSha256,
  GATE_DOMAIN,
  MANIFEST_DOMAIN,
  PUBLICATION_DOMAIN,
  PUBLICATION_ROTATION_DOMAIN,
  WITNESS_DOMAIN,
  payloadSha256,
  readJson,
  readPrivateKey,
  readPublicKey,
  signEnvelope,
  validateGate,
  validateManifest,
  validatePublication,
  validatePublicationCheckpoint,
  validatePublicationRotation,
  validateWitness,
  verifyEnvelope,
  writeNewJson,
} from "./live-auth/envelope.mjs";

function usage() {
  console.error(`Usage:
  node scripts/live-auth.mjs inspect-key --public-key <ed25519-public.pem>
  node scripts/live-auth.mjs sign-manifest --private-key <ed25519-private.pem> --key-generation <positive-integer> --input <manifest.json> --output <signed.json>
  node scripts/live-auth.mjs sign-gate --private-key <ed25519-private.pem> --key-generation <positive-integer> --input <gate.json> --manifest <signed-manifest.json> --at <unix-seconds> --output <signed.json>
  node scripts/live-auth.mjs sign-witness --private-key <witness-ed25519-private.pem> --key-generation <positive-integer> --input <witness.json> --at <unix-seconds> --output <signed.json>
  node scripts/live-auth.mjs verify-bundle --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --at <unix-seconds>
  node scripts/live-auth.mjs init-publication --publication-public-key <offline-ed25519-public.pem> --publication-key-generation <positive-integer> --output-checkpoint <checkpoint.json>
  node scripts/live-auth.mjs publish-release --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --publication-private-key <offline-ed25519-private.pem> --publication-key-generation <positive-integer> --previous <genesis|signed-entry.json> --at <unix-seconds> --output <signed-entry.json>
  node scripts/live-auth.mjs rotate-publication --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --prior-publication-private-key <old-offline-ed25519-private.pem> --prior-publication-key-generation <positive-integer> --next-publication-private-key <new-offline-ed25519-private.pem> --next-publication-key-generation <greater-positive-integer> --previous <signed-entry.json> --at <unix-seconds> --output <rotation.json>
  node scripts/live-auth.mjs verify-rotation --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --prior-publication-public-key <old-offline-ed25519-public.pem> --prior-publication-key-generation <positive-integer> --next-publication-public-key <new-offline-ed25519-public.pem> --next-publication-key-generation <greater-positive-integer> --rotation <rotation.json> --checkpoint <checkpoint.json> --at <unix-seconds> --output-checkpoint <checkpoint.json>
  node scripts/live-auth.mjs publish-after-rotation --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --prior-publication-public-key <old-offline-ed25519-public.pem> --prior-publication-key-generation <positive-integer> --publication-private-key <new-offline-ed25519-private.pem> --publication-key-generation <greater-positive-integer> --previous-rotation <rotation.json> --at <unix-seconds> --output <signed-entry.json>
  node scripts/live-auth.mjs verify-release --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --witness-public-key <witness-ed25519-public.pem> --witness-key-generation <positive-integer> --witness <signed-witness.json> --publication-public-key <offline-ed25519-public.pem> --publication-key-generation <positive-integer> --entry <signed-entry.json> --checkpoint <checkpoint.json> --at <unix-seconds> --output-checkpoint <checkpoint.json>`);
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

function fail(message) {
  throw new Error(`live auth: ${message}`);
}

function timestamp(value) {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value))
    fail("--at must be an explicit Unix timestamp");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("--at must be a safe integer");
  return parsed;
}

function keyGeneration(value) {
  if (!/^[1-9][0-9]*$/.test(value))
    fail("--key-generation must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    fail("--key-generation must be a safe integer");
  return parsed;
}

async function verifiedBundle(values, at) {
  const key = await readPublicKey(values["--public-key"]);
  const generation = keyGeneration(values["--key-generation"]);
  const manifestEnvelope = await readJson(values["--manifest"]);
  const manifest = validateManifest(
    verifyEnvelope(manifestEnvelope, key, MANIFEST_DOMAIN, generation),
  );
  const gateEnvelope = await readJson(values["--gate"], 4_096);
  const gate = validateGate(
    verifyEnvelope(gateEnvelope, key, GATE_DOMAIN, generation),
    at,
  );
  if (gate.manifestSha256 !== payloadSha256(MANIFEST_DOMAIN, manifest))
    fail("gate manifest pin does not match");
  const witnessKey = await readPublicKey(values["--witness-public-key"]);
  if (describeKey(witnessKey).keyId === describeKey(key).keyId)
    fail("witness key must be independent from the live-read key");
  const witnessGeneration = keyGeneration(values["--witness-key-generation"]);
  const witnessEnvelope = await readJson(values["--witness"], 4_096);
  const witness = validateWitness(
    verifyEnvelope(
      witnessEnvelope,
      witnessKey,
      WITNESS_DOMAIN,
      witnessGeneration,
    ),
    at,
  );
  if (
    witness.liveReadKeyId !== describeKey(key).keyId ||
    generation < witness.minimumLiveReadKeyGeneration
  )
    fail("witness does not authorize the live-read generation");
  return {
    key,
    generation,
    manifestEnvelope,
    manifest,
    gateEnvelope,
    gate,
    witnessKey,
    witnessGeneration,
    witnessEnvelope,
    witness,
  };
}

function publicationBinding(bundle) {
  const binding = {
    schemaVersion: 1,
    manifestEnvelopeSha256: canonicalSha256(bundle.manifestEnvelope),
    gateEnvelopeSha256: canonicalSha256(bundle.gateEnvelope),
    witnessEnvelopeSha256: canonicalSha256(bundle.witnessEnvelope),
    sourceRevision: bundle.manifest.sourceRevision,
    liveReadKeyId: describeKey(bundle.key).keyId,
    liveReadKeyGeneration: bundle.generation,
    witnessKeyId: describeKey(bundle.witnessKey).keyId,
    witnessKeyGeneration: bundle.witnessGeneration,
  };
  return { ...binding, bundleSha256: canonicalSha256(binding) };
}

function requireIndependentPublicationKey(identity, bundle) {
  if (
    identity.keyId === describeKey(bundle.key).keyId ||
    identity.keyId === describeKey(bundle.witnessKey).keyId
  )
    fail("publication key must be independent from bundle keys");
}

function nextPublicationPayload(bundle, previousPayload, previousSha256, at) {
  const sequence = previousPayload.sequence + 1;
  if (!Number.isSafeInteger(sequence)) fail("publication sequence overflow");
  if (at < previousPayload.publishedAt)
    fail("publication time must not move backwards");
  return validatePublication({
    schemaVersion: 1,
    sequence,
    previousEntrySha256: previousSha256,
    publishedAt: at,
    ...publicationBinding(bundle),
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "inspect-key") {
    const values = parse(command, args, ["--public-key"]);
    console.log(
      canonicalJson(describeKey(await readPublicKey(values["--public-key"]))),
    );
    return;
  }
  if (command === "sign-manifest") {
    const values = parse(command, args, [
      "--private-key",
      "--key-generation",
      "--input",
      "--output",
    ]);
    const key = await readPrivateKey(values["--private-key"]);
    const generation = keyGeneration(values["--key-generation"]);
    const payload = validateManifest(await readJson(values["--input"]));
    await writeNewJson(
      values["--output"],
      signEnvelope(payload, key, MANIFEST_DOMAIN, generation),
    );
    return;
  }
  if (command === "sign-gate") {
    const values = parse(command, args, [
      "--private-key",
      "--key-generation",
      "--input",
      "--manifest",
      "--at",
      "--output",
    ]);
    const key = await readPrivateKey(values["--private-key"]);
    const generation = keyGeneration(values["--key-generation"]);
    const manifest = validateManifest(
      verifyEnvelope(
        await readJson(values["--manifest"]),
        key,
        MANIFEST_DOMAIN,
        generation,
      ),
    );
    const input = await readJson(values["--input"], 4_096);
    if (Object.hasOwn(input, "manifestSha256"))
      fail("gate input must not preselect manifestSha256");
    const payload = validateGate(
      { ...input, manifestSha256: payloadSha256(MANIFEST_DOMAIN, manifest) },
      timestamp(values["--at"]),
    );
    await writeNewJson(
      values["--output"],
      signEnvelope(payload, key, GATE_DOMAIN, generation),
    );
    return;
  }
  if (command === "sign-witness") {
    const values = parse(command, args, [
      "--private-key",
      "--key-generation",
      "--input",
      "--at",
      "--output",
    ]);
    const key = await readPrivateKey(values["--private-key"]);
    const generation = keyGeneration(values["--key-generation"]);
    const payload = validateWitness(
      await readJson(values["--input"], 4_096),
      timestamp(values["--at"]),
    );
    await writeNewJson(
      values["--output"],
      signEnvelope(payload, key, WITNESS_DOMAIN, generation),
    );
    return;
  }
  if (command === "verify-bundle") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--at",
    ]);
    const at = timestamp(values["--at"]);
    const bundle = await verifiedBundle(values, at);
    console.log(
      canonicalJson({
        verified: true,
        keyId: describeKey(bundle.key).keyId,
        keyGeneration: bundle.generation,
        expiresAt: bundle.gate.expiresAt,
        witnessKeyId: describeKey(bundle.witnessKey).keyId,
        witnessExpiresAt: bundle.witness.expiresAt,
      }),
    );
    return;
  }
  if (command === "publish-release") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--publication-private-key",
      "--publication-key-generation",
      "--previous",
      "--at",
      "--output",
    ]);
    const at = timestamp(values["--at"]);
    const bundle = await verifiedBundle(values, at);
    const publicationKey = await readPrivateKey(
      values["--publication-private-key"],
    );
    const publicationIdentity = describeKey(publicationKey);
    requireIndependentPublicationKey(publicationIdentity, bundle);
    const publicationGeneration = keyGeneration(
      values["--publication-key-generation"],
    );
    let sequence = 1;
    let previousEntrySha256 = null;
    if (values["--previous"] !== "genesis") {
      const previous = await readJson(values["--previous"]);
      const previousPayload = validatePublication(
        verifyEnvelope(
          previous,
          publicationKey,
          PUBLICATION_DOMAIN,
          publicationGeneration,
        ),
      );
      sequence = previousPayload.sequence + 1;
      if (!Number.isSafeInteger(sequence)) fail("publication sequence overflow");
      if (at < previousPayload.publishedAt)
        fail("publication time must not move backwards");
      previousEntrySha256 = canonicalSha256(previous);
    }
    const payload = validatePublication({
      schemaVersion: 1,
      sequence,
      previousEntrySha256,
      publishedAt: at,
      ...publicationBinding(bundle),
    });
    await writeNewJson(
      values["--output"],
      signEnvelope(
        payload,
        publicationKey,
        PUBLICATION_DOMAIN,
        publicationGeneration,
      ),
      0o444,
    );
    return;
  }
  if (command === "rotate-publication") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--prior-publication-private-key",
      "--prior-publication-key-generation",
      "--next-publication-private-key",
      "--next-publication-key-generation",
      "--previous",
      "--at",
      "--output",
    ]);
    const at = timestamp(values["--at"]);
    const bundle = await verifiedBundle(values, at);
    const priorKey = await readPrivateKey(
      values["--prior-publication-private-key"],
    );
    const nextKey = await readPrivateKey(
      values["--next-publication-private-key"],
    );
    const priorIdentity = describeKey(priorKey);
    const nextIdentity = describeKey(nextKey);
    requireIndependentPublicationKey(priorIdentity, bundle);
    requireIndependentPublicationKey(nextIdentity, bundle);
    const priorGeneration = keyGeneration(
      values["--prior-publication-key-generation"],
    );
    const nextGeneration = keyGeneration(
      values["--next-publication-key-generation"],
    );
    if (priorIdentity.keyId === nextIdentity.keyId)
      fail("publication rotation must change the key");
    if (nextGeneration <= priorGeneration)
      fail("publication rotation generation must increase");
    const previous = await readJson(values["--previous"]);
    const previousPayload = validatePublication(
      verifyEnvelope(
        previous,
        priorKey,
        PUBLICATION_DOMAIN,
        priorGeneration,
      ),
    );
    const payload = nextPublicationPayload(
      bundle,
      previousPayload,
      canonicalSha256(previous),
      at,
    );
    const rotation = {
      schemaVersion: 1,
      priorAuthorization: signEnvelope(
        payload,
        priorKey,
        PUBLICATION_ROTATION_DOMAIN,
        priorGeneration,
      ),
      nextAcceptance: signEnvelope(
        payload,
        nextKey,
        PUBLICATION_ROTATION_DOMAIN,
        nextGeneration,
      ),
    };
    validatePublicationRotation(
      rotation,
      priorKey,
      priorGeneration,
      nextKey,
      nextGeneration,
    );
    await writeNewJson(values["--output"], rotation, 0o444);
    return;
  }
  if (command === "publish-after-rotation") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--prior-publication-public-key",
      "--prior-publication-key-generation",
      "--publication-private-key",
      "--publication-key-generation",
      "--previous-rotation",
      "--at",
      "--output",
    ]);
    const at = timestamp(values["--at"]);
    const bundle = await verifiedBundle(values, at);
    const priorKey = await readPublicKey(
      values["--prior-publication-public-key"],
    );
    const nextKey = await readPrivateKey(values["--publication-private-key"]);
    requireIndependentPublicationKey(describeKey(priorKey), bundle);
    requireIndependentPublicationKey(describeKey(nextKey), bundle);
    const priorGeneration = keyGeneration(
      values["--prior-publication-key-generation"],
    );
    const nextGeneration = keyGeneration(
      values["--publication-key-generation"],
    );
    const rotation = await readJson(values["--previous-rotation"]);
    const rotationPayload = validatePublicationRotation(
      rotation,
      priorKey,
      priorGeneration,
      nextKey,
      nextGeneration,
    );
    const payload = nextPublicationPayload(
      bundle,
      rotationPayload,
      canonicalSha256(rotation),
      at,
    );
    await writeNewJson(
      values["--output"],
      signEnvelope(payload, nextKey, PUBLICATION_DOMAIN, nextGeneration),
      0o444,
    );
    return;
  }
  if (command === "init-publication") {
    const values = parse(command, args, [
      "--publication-public-key",
      "--publication-key-generation",
      "--output-checkpoint",
    ]);
    const publicationKey = await readPublicKey(
      values["--publication-public-key"],
    );
    const publicationGeneration = keyGeneration(
      values["--publication-key-generation"],
    );
    await writeNewJson(
      values["--output-checkpoint"],
      validatePublicationCheckpoint({
        schemaVersion: 1,
        publicationKeyId: describeKey(publicationKey).keyId,
        publicationKeyGeneration: publicationGeneration,
        sequence: 0,
        entrySha256: null,
      }),
      0o444,
    );
    return;
  }
  if (command === "verify-release") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--publication-public-key",
      "--publication-key-generation",
      "--entry",
      "--checkpoint",
      "--at",
      "--output-checkpoint",
    ]);
    const at = timestamp(values["--at"]);
    const publicationKey = await readPublicKey(
      values["--publication-public-key"],
    );
    const publicationIdentity = describeKey(publicationKey);
    const publicationGeneration = keyGeneration(
      values["--publication-key-generation"],
    );
    const entry = await readJson(values["--entry"]);
    const payload = validatePublication(
      verifyEnvelope(
        entry,
        publicationKey,
        PUBLICATION_DOMAIN,
        publicationGeneration,
      ),
    );
    if (payload.publishedAt > at + 300)
      fail("publication time is in the future");
    const bundle = await verifiedBundle(values, payload.publishedAt);
    requireIndependentPublicationKey(publicationIdentity, bundle);
    const expected = publicationBinding(bundle);
    for (const [field, value] of Object.entries(expected))
      if (payload[field] !== value)
        fail("publication does not match the verified bundle");
    const checkpoint = validatePublicationCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    if (
      checkpoint.publicationKeyId !== publicationIdentity.keyId ||
      checkpoint.publicationKeyGeneration !== publicationGeneration
    )
      fail("publication checkpoint key does not match");
    const entrySha256 = canonicalSha256(entry);
    const alreadyTrusted =
      checkpoint.sequence === payload.sequence &&
      checkpoint.entrySha256 === entrySha256;
    const nextTrusted =
      payload.sequence === checkpoint.sequence + 1 &&
      payload.previousEntrySha256 === checkpoint.entrySha256;
    if (!alreadyTrusted && !nextTrusted)
      fail("publication is not the retained checkpoint or its successor");
    const nextCheckpoint = validatePublicationCheckpoint({
      schemaVersion: 1,
      publicationKeyId: publicationIdentity.keyId,
      publicationKeyGeneration: publicationGeneration,
      sequence: payload.sequence,
      entrySha256,
    });
    await writeNewJson(values["--output-checkpoint"], nextCheckpoint, 0o444);
    console.log(
      canonicalJson({
        verified: true,
        sequence: payload.sequence,
        bundleSha256: payload.bundleSha256,
        entrySha256,
      }),
    );
    return;
  }
  if (command === "verify-rotation") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--witness-public-key",
      "--witness-key-generation",
      "--witness",
      "--prior-publication-public-key",
      "--prior-publication-key-generation",
      "--next-publication-public-key",
      "--next-publication-key-generation",
      "--rotation",
      "--checkpoint",
      "--at",
      "--output-checkpoint",
    ]);
    const at = timestamp(values["--at"]);
    const priorKey = await readPublicKey(
      values["--prior-publication-public-key"],
    );
    const nextKey = await readPublicKey(
      values["--next-publication-public-key"],
    );
    const priorIdentity = describeKey(priorKey);
    const nextIdentity = describeKey(nextKey);
    const priorGeneration = keyGeneration(
      values["--prior-publication-key-generation"],
    );
    const nextGeneration = keyGeneration(
      values["--next-publication-key-generation"],
    );
    const rotation = await readJson(values["--rotation"]);
    const payload = validatePublicationRotation(
      rotation,
      priorKey,
      priorGeneration,
      nextKey,
      nextGeneration,
    );
    if (payload.publishedAt > at + 300)
      fail("publication time is in the future");
    const bundle = await verifiedBundle(values, payload.publishedAt);
    requireIndependentPublicationKey(priorIdentity, bundle);
    requireIndependentPublicationKey(nextIdentity, bundle);
    const expected = publicationBinding(bundle);
    for (const [field, value] of Object.entries(expected))
      if (payload[field] !== value)
        fail("publication does not match the verified bundle");
    const checkpoint = validatePublicationCheckpoint(
      await readJson(values["--checkpoint"], 4_096),
    );
    if (
      checkpoint.publicationKeyId !== priorIdentity.keyId ||
      checkpoint.publicationKeyGeneration !== priorGeneration
    )
      fail("publication checkpoint key does not match prior rotation key");
    if (
      payload.sequence !== checkpoint.sequence + 1 ||
      payload.previousEntrySha256 !== checkpoint.entrySha256
    )
      fail("publication rotation is not the checkpoint successor");
    const entrySha256 = canonicalSha256(rotation);
    const nextCheckpoint = validatePublicationCheckpoint({
      schemaVersion: 1,
      publicationKeyId: nextIdentity.keyId,
      publicationKeyGeneration: nextGeneration,
      sequence: payload.sequence,
      entrySha256,
    });
    await writeNewJson(values["--output-checkpoint"], nextCheckpoint, 0o444);
    console.log(
      canonicalJson({
        verified: true,
        rotated: true,
        sequence: payload.sequence,
        bundleSha256: payload.bundleSha256,
        entrySha256,
        priorPublicationKeyId: priorIdentity.keyId,
        nextPublicationKeyId: nextIdentity.keyId,
      }),
    );
    return;
  }
  usage();
  process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "live auth: unexpected failure",
  );
  process.exitCode = 1;
}
