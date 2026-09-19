#!/usr/bin/env node
import {
  describeKey,
  canonicalJson,
  GATE_DOMAIN,
  MANIFEST_DOMAIN,
  payloadSha256,
  readJson,
  readPrivateKey,
  readPublicKey,
  signEnvelope,
  validateGate,
  validateManifest,
  verifyEnvelope,
  writeNewJson,
} from "./live-auth/envelope.mjs";

function usage() {
  console.error(`Usage:
  node scripts/live-auth.mjs inspect-key --public-key <ed25519-public.pem>
  node scripts/live-auth.mjs sign-manifest --private-key <ed25519-private.pem> --key-generation <positive-integer> --input <manifest.json> --output <signed.json>
  node scripts/live-auth.mjs sign-gate --private-key <ed25519-private.pem> --key-generation <positive-integer> --input <gate.json> --manifest <signed-manifest.json> --at <unix-seconds> --output <signed.json>
  node scripts/live-auth.mjs verify-bundle --public-key <ed25519-public.pem> --key-generation <positive-integer> --gate <signed-gate.json> --manifest <signed-manifest.json> --at <unix-seconds>`);
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
  if (command === "verify-bundle") {
    const values = parse(command, args, [
      "--public-key",
      "--key-generation",
      "--gate",
      "--manifest",
      "--at",
    ]);
    const key = await readPublicKey(values["--public-key"]);
    const generation = keyGeneration(values["--key-generation"]);
    const manifest = validateManifest(
      verifyEnvelope(
        await readJson(values["--manifest"]),
        key,
        MANIFEST_DOMAIN,
        generation,
      ),
    );
    const gate = validateGate(
      verifyEnvelope(
        await readJson(values["--gate"], 4_096),
        key,
        GATE_DOMAIN,
        generation,
      ),
      timestamp(values["--at"]),
    );
    if (gate.manifestSha256 !== payloadSha256(MANIFEST_DOMAIN, manifest))
      fail("gate manifest pin does not match");
    console.log(
      canonicalJson({
        verified: true,
        keyId: describeKey(key).keyId,
        keyGeneration: generation,
        expiresAt: gate.expiresAt,
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
