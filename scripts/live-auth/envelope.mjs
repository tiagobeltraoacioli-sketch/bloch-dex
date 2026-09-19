import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import {
  validateStagingConfig,
  sha256,
  stableJson,
} from "../staging/manifest.mjs";

export const GATE_DOMAIN = "POSTERN_LIVE_GATE_V2\n";
export const MANIFEST_DOMAIN = "POSTERN_LIVE_MANIFEST_V2\n";
export const WITNESS_DOMAIN = "POSTERN_LIVE_WITNESS_V1\n";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_GATE_SECONDS = 7 * 24 * 60 * 60;
const MAX_WITNESS_SECONDS = 15 * 60;

function fail(message) {
  throw new Error(`live auth: ${message}`);
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

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      fail("only safe integers are canonical");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fail("value is not plain JSON");
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("value is not canonical JSON");
}

export function payloadBytes(domain, payload) {
  return Buffer.from(`${domain}${canonicalJson(payload)}`, "utf8");
}

export function payloadSha256(domain, payload) {
  return createHash("sha256")
    .update(payloadBytes(domain, payload))
    .digest("hex");
}

function rawPublicKey(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519") fail("key must be Ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  if (
    spki.length !== SPKI_PREFIX.length + 32 ||
    !spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)
  )
    fail("Ed25519 public key encoding is unsupported");
  return spki.subarray(SPKI_PREFIX.length);
}

export function describeKey(key) {
  const raw = rawPublicKey(key);
  return {
    algorithm: "Ed25519",
    keyId: createHash("sha256").update(raw).digest("hex"),
    publicKeyBase64Url: raw.toString("base64url"),
  };
}

export function signEnvelope(payload, privateKey, domain, keyGeneration) {
  if (privateKey.asymmetricKeyType !== "ed25519")
    fail("private key must be Ed25519");
  if (!Number.isSafeInteger(keyGeneration) || keyGeneration < 1)
    fail("key generation must be a positive safe integer");
  const identity = describeKey(privateKey);
  return {
    schemaVersion: 2,
    payload,
    signature: {
      algorithm: identity.algorithm,
      keyId: identity.keyId,
      keyGeneration,
      value: sign(
        null,
        payloadBytes(domain, { keyGeneration, payload }),
        privateKey,
      ).toString("base64url"),
    },
  };
}

export function verifyEnvelope(envelope, publicKey, domain, keyGeneration) {
  exactKeys(envelope, ["schemaVersion", "payload", "signature"], "envelope");
  if (envelope.schemaVersion !== 2) fail("envelope schema is unsupported");
  if (!Number.isSafeInteger(keyGeneration) || keyGeneration < 1)
    fail("key generation must be a positive safe integer");
  exactKeys(
    envelope.signature,
    ["algorithm", "keyId", "keyGeneration", "value"],
    "signature",
  );
  const identity = describeKey(publicKey);
  if (
    envelope.signature.algorithm !== "Ed25519" ||
    envelope.signature.keyId !== identity.keyId ||
    envelope.signature.keyGeneration !== keyGeneration
  )
    fail("signature key identity does not match");
  if (
    typeof envelope.signature.value !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature.value)
  )
    fail("signature encoding is invalid");
  const signature = Buffer.from(envelope.signature.value, "base64url");
  if (
    signature.length !== 64 ||
    !verify(
      null,
      payloadBytes(domain, { keyGeneration, payload: envelope.payload }),
      publicKey,
      signature,
    )
  )
    fail("signature is invalid");
  return envelope.payload;
}

export function validateManifest(payload) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "target",
      "sourceRevision",
      "deploymentConfiguration",
      "configurationSha256",
      "frontendLockSha256",
      "files",
    ],
    "manifest",
  );
  if (
    payload.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/.test(payload.sourceRevision)
  )
    fail("manifest identity is invalid");
  exactKeys(
    payload.target,
    ["environment", "host", "frontendMode", "liquidityEnabled"],
    "target",
  );
  if (
    payload.target.environment !== "staging" ||
    payload.target.host !== "bloch-dex" ||
    payload.target.frontendMode !== "preview" ||
    payload.target.liquidityEnabled !== false
  )
    fail("manifest target is not disabled-liquidity staging");
  validateStagingConfig(payload.deploymentConfiguration);
  if (
    !HEX.test(payload.configurationSha256) ||
    payload.configurationSha256 !==
      sha256(stableJson(payload.deploymentConfiguration)) ||
    !HEX.test(payload.frontendLockSha256)
  )
    fail("manifest hash is invalid");
  if (!Array.isArray(payload.files) || payload.files.length === 0)
    fail("manifest files are missing");
  const paths = new Set();
  for (const file of payload.files) {
    exactKeys(file, ["path", "bytes", "sha256"], "manifest file");
    if (
      typeof file.path !== "string" ||
      !/^[A-Za-z0-9._/-]+$/.test(file.path) ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !HEX.test(file.sha256)
    )
      fail("manifest file is invalid");
    if (paths.has(file.path)) fail("manifest file paths must be unique");
    paths.add(file.path);
  }
  return payload;
}

export function validateGate(payload, at) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "enabled",
      "mode",
      "registryUrl",
      "manifestSha256",
      "issuedAt",
      "expiresAt",
      "allowedRpcOrigins",
      "timeoutMs",
    ],
    "gate",
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.enabled !== true ||
    payload.mode !== "read-only" ||
    typeof payload.registryUrl !== "string" ||
    !payload.registryUrl.startsWith("/") ||
    payload.registryUrl.startsWith("//") ||
    payload.registryUrl.includes("?") ||
    payload.registryUrl.includes("#") ||
    !HEX.test(payload.manifestSha256) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > MAX_GATE_SECONDS ||
    payload.expiresAt <= at ||
    payload.issuedAt > at + 300 ||
    !Array.isArray(payload.allowedRpcOrigins) ||
    payload.allowedRpcOrigins.length === 0 ||
    payload.allowedRpcOrigins.length > 8 ||
    new Set(payload.allowedRpcOrigins).size !==
      payload.allowedRpcOrigins.length ||
    !Number.isSafeInteger(payload.timeoutMs) ||
    payload.timeoutMs < 250 ||
    payload.timeoutMs > 30_000
  )
    fail("gate policy is invalid");
  for (const origin of payload.allowedRpcOrigins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail("gate RPC origin is invalid");
    }
    if (url.protocol !== "https:" || url.origin !== origin)
      fail("gate RPC origin is invalid");
  }
  return payload;
}

export function validateWitness(payload, at) {
  exactKeys(
    payload,
    [
      "schemaVersion",
      "liveReadKeyId",
      "minimumLiveReadKeyGeneration",
      "issuedAt",
      "expiresAt",
    ],
    "witness",
  );
  if (
    payload.schemaVersion !== 1 ||
    !HEX.test(payload.liveReadKeyId) ||
    !Number.isSafeInteger(payload.minimumLiveReadKeyGeneration) ||
    payload.minimumLiveReadKeyGeneration < 1 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > MAX_WITNESS_SECONDS ||
    payload.expiresAt <= at ||
    payload.issuedAt > at + 300
  )
    fail("witness policy is invalid");
  return payload;
}

async function regularFile(path, secret = false, limit = 64 * 1024) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    fail("input must be a regular non-symlink file");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino)
      fail("input changed while it was opened");
    if (info.size === 0 || info.size > limit) fail("input size is invalid");
    if (secret && process.platform !== "win32" && (info.mode & 0o077) !== 0)
      fail("private key permissions must not grant group or other access");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readJson(path, limit = MAX_JSON_BYTES) {
  const bytes = await regularFile(path, false, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("JSON input is invalid");
  }
}

export async function readPrivateKey(path) {
  try {
    const encoded = await regularFile(path, true);
    if (!encoded.toString("utf8").startsWith("-----BEGIN PRIVATE KEY-----\n"))
      fail("private key must be unencrypted PKCS#8 PEM");
    const key = createPrivateKey(encoded);
    if (key.asymmetricKeyType !== "ed25519")
      fail("private key must be Ed25519");
    return key;
  } catch (error) {
    if (error.message.startsWith("live auth:")) throw error;
    fail("private key cannot be read");
  }
}

export async function readPublicKey(path) {
  try {
    const encoded = await regularFile(path);
    if (!encoded.toString("utf8").startsWith("-----BEGIN PUBLIC KEY-----\n"))
      fail("public key must be SPKI PEM");
    const key = createPublicKey(encoded);
    if (key.asymmetricKeyType !== "ed25519") fail("public key must be Ed25519");
    return key;
  } catch (error) {
    if (error.message.startsWith("live auth:")) throw error;
    fail("public key cannot be read");
  }
}

export async function writeNewJson(path, value) {
  await writeFile(path, `${canonicalJson(value)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
}
