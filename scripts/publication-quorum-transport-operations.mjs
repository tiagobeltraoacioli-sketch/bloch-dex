#!/usr/bin/env node
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  canonicalSha256,
  describeKey,
  readJson,
  readPrivateKey,
  readPublicKey,
  signEnvelope,
  verifyEnvelope,
  writeNewJson,
} from "./live-auth/envelope.mjs";
import {
  validateClientConfig,
} from "./publication-quorum-witness-transport.mjs";
import {
  validateWitnessConfig,
  verifyWitnessReceipt,
} from "./publication-quorum-witness.mjs";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const HEAD = "checkpoint.json";
const LOCK = ".operations.lock";
const ROTATIONS = "rotations";
const ANCHOR_ACCEPTANCES = "anchor-acceptances";
const V3_MIGRATION_RECORD = "migration-v3-checkpoint.json";
export const MTLS_PROFILE_ROTATION_DOMAIN =
  "POSTERN_PUBLICATION_QUORUM_MTLS_PROFILE_ROTATION_V1\n";
export const OPERATIONS_ANCHOR_DOMAIN =
  "POSTERN_PUBLICATION_QUORUM_OPERATIONS_ANCHOR_V1\n";
const MAX_JSON = 64_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const RAW_ED25519 = /^[A-Za-z0-9_-]{43}$/;
const TRANSPORT_PATH = /^\/[A-Za-z0-9/_-]{1,127}$/;
const LOCK_OPERATION = /^[a-z][a-z0-9-]{0,62}$/;
const LOCK_CLEANUP_DIRECTORY = /^\.operations\.lock\.cleanup\.[1-9][0-9]*\.[0-9a-f]{32}$/;
const LOCK_RETAINED_NAME = /^retained-[0-9a-f]{64}$/;
const DESCRIPTOR_RELATIVE_PATH = /^\/proc\/self\/fd\/[1-9][0-9]*(?:\/.*)?$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function fail(message) {
  throw new Error(`publication quorum transport operations: ${message}`);
}

async function requireSeparateTrees(sourceRoot, destinationRoot) {
  const source = await realpath(sourceRoot);
  let destination;
  try {
    destination = await realpath(destinationRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const resolvedDestination = resolve(destinationRoot);
    destination = join(await realpath(dirname(resolvedDestination)), basename(resolvedDestination));
  }
  const sourceToDestination = relative(source, destination);
  const destinationToSource = relative(destination, source);
  const isDescendant = (value) => value !== "" && value.split(sep)[0] !== ".." &&
    !isAbsolute(value);
  if (source === destination || isDescendant(sourceToDestination) ||
      isDescendant(destinationToSource))
    fail("schema migration source and destination must be separate non-nested trees");
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
    fail(`${field} fields are invalid`);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function secureBytes(path, privateFile, field) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      fail(`${field} must be owned by the current user`);
    if (privateFile && (before.mode & 0o077n) !== 0n)
      fail(`${field} must not grant group or other permissions`);
    if (!privateFile && (before.mode & 0o022n) !== 0n)
      fail(`${field} must not be writable by group or other users`);
    if (before.size < 1n || before.size > BigInt(MAX_JSON))
      fail(`${field} size is invalid`);

    // Do not let a regular file grow without bound after the initial stat.
    // Reading one byte beyond the protocol limit makes growth fail closed
    // without allocating according to attacker-controlled post-stat size.
    const buffer = Buffer.alloc(MAX_JSON + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer, length, buffer.length - length, null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_JSON) fail(`${field} size is invalid`);
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    const stable = [
      "dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs",
    ].every((name) => before[name] === after[name] && after[name] === linked[name]);
    if (!stable || !after.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
        after.nlink !== 1n || BigInt(bytes.length) !== after.size)
      fail(`${field} changed while it was being read`);
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function buildClientPreflight(configInput, witnessInput) {
  const config = validateClientConfig(configInput);
  const witness = validateWitnessConfig(witnessInput);
  const [caBytes, certificateBytes, keyBytes] = await Promise.all([
    secureBytes(config.serverCaCertificatePath, false, "server CA"),
    secureBytes(config.tlsCertificatePath, false, "client certificate"),
    secureBytes(config.tlsPrivateKeyPath, true, "client TLS key"),
  ]);
  let caCertificate;
  let certificate;
  let key;
  try {
    caCertificate = new X509Certificate(caBytes);
    certificate = new X509Certificate(certificateBytes);
    key = createPrivateKey(keyBytes);
  } catch {
    fail("client certificate or TLS key is invalid");
  } finally {
    // createPrivateKey owns the resulting KeyObject; retain the source bytes
    // only until that import attempt has completed, including on parse errors.
    keyBytes.fill(0);
  }
  const certificateKey = certificate.publicKey.export({ format: "der", type: "spki" });
  const privatePublicKey = createPublicKey(key).export({ format: "der", type: "spki" });
  if (!certificateKey.equals(privatePublicKey))
    fail("client TLS key does not match the client certificate");
  const now = Date.now();
  const caStart = Date.parse(caCertificate.validFrom), caEnd = Date.parse(caCertificate.validTo);
  const clientStart = Date.parse(certificate.validFrom), clientEnd = Date.parse(certificate.validTo);
  if (!caCertificate.ca || !Number.isFinite(caStart) || !Number.isFinite(caEnd) ||
      caStart > now || caEnd <= now)
    fail("server CA certificate is not a currently valid CA");
  if (!Number.isFinite(clientStart) || !Number.isFinite(clientEnd) ||
      clientStart > now || clientEnd <= now)
    fail("client certificate is not currently valid");
  return {
    schemaVersion: 1,
    role: "publication-quorum-witness-client",
    endpoint: config.endpoint,
    serverCertificateSha256: config.serverCertificateSha256.replaceAll(":", "").toLowerCase(),
    serverCaFileSha256: hashBytes(caBytes),
    clientCertificateSha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    witnessConfigSha256: canonicalSha256(witness),
  };
}

function validatePreflightManifest(value) {
  exactKeys(value, [
    "schemaVersion", "role", "endpoint", "serverCertificateSha256",
    "serverCaFileSha256", "clientCertificateSha256", "witnessConfigSha256",
  ], "preflight manifest");
  if (value.schemaVersion !== 1 || value.role !== "publication-quorum-witness-client")
    fail("preflight manifest identity is invalid");
  exactKeys(value.endpoint, ["host", "port", "path", "timeoutMs", "maxBodyBytes"], "preflight endpoint");
  if (typeof value.endpoint.host !== "string" || isIP(value.endpoint.host) === 0 ||
      value.endpoint.host === "0.0.0.0" || value.endpoint.host === "::" ||
      typeof value.endpoint.path !== "string" || !TRANSPORT_PATH.test(value.endpoint.path) ||
      !Number.isSafeInteger(value.endpoint.port) || value.endpoint.port < 1 || value.endpoint.port > 65_535 ||
      !Number.isSafeInteger(value.endpoint.timeoutMs) || value.endpoint.timeoutMs < 500 ||
      value.endpoint.timeoutMs > 30_000 || !Number.isSafeInteger(value.endpoint.maxBodyBytes) ||
      value.endpoint.maxBodyBytes < 1_024 || value.endpoint.maxBodyBytes > 262_144)
    fail("preflight endpoint is invalid");
  requireHash(value.serverCertificateSha256, "server certificate hash");
  requireHash(value.serverCaFileSha256, "server CA file hash");
  requireHash(value.clientCertificateSha256, "client certificate hash");
  requireHash(value.witnessConfigSha256, "witness config hash");
  return value;
}

function requireHash(value, field) {
  if (typeof value !== "string" || !HEX.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function requireHead(value) {
  if (value !== "genesis") requireHash(value, "expected custody head");
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail(`${field} must be a positive safe integer`);
  return value;
}

function authorityFromRaw(publicKeyBase64Url, keyGeneration) {
  if (typeof publicKeyBase64Url !== "string" || !RAW_ED25519.test(publicKeyBase64Url))
    fail("rotation authority public key encoding is invalid");
  const raw = Buffer.from(publicKeyBase64Url, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== publicKeyBase64Url)
    fail("rotation authority public key encoding is invalid");
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki",
    });
  } catch {
    fail("rotation authority public key is invalid");
  }
  positiveInteger(keyGeneration, "rotation authority key generation");
  const identity = describeKey(publicKey);
  return { ...identity, keyGeneration, publicKey };
}

function validateRotationPayload(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "rotationSequence", "previousRotationSha256",
    "priorManifestSha256", "nextManifestSha256", "expectedHeadSha256",
    "priorAuthority", "nextAuthority",
  ], "mTLS profile rotation");
  if (value.schemaVersion !== 1 || value.kind !== "mtls-profile-rotation")
    fail("mTLS profile rotation identity is invalid");
  positiveInteger(value.rotationSequence, "rotation sequence");
  if (value.previousRotationSha256 !== "genesis")
    requireHash(value.previousRotationSha256, "previous rotation hash");
  requireHash(value.priorManifestSha256, "prior manifest hash");
  requireHash(value.nextManifestSha256, "next manifest hash");
  if (value.priorManifestSha256 === value.nextManifestSha256)
    fail("mTLS profile rotation must change the manifest");
  requireHead(value.expectedHeadSha256);
  for (const [name, authority] of [["prior", value.priorAuthority], ["next", value.nextAuthority]]) {
    exactKeys(authority, ["keyId", "keyGeneration", "publicKeyBase64Url"], `${name} rotation authority`);
    const parsed = authorityFromRaw(authority.publicKeyBase64Url, authority.keyGeneration);
    if (authority.keyId !== parsed.keyId) fail(`${name} rotation authority key ID does not match`);
  }
  if (value.priorAuthority.keyId === value.nextAuthority.keyId ||
      value.nextAuthority.keyGeneration <= value.priorAuthority.keyGeneration)
    fail("rotation authorities must use independent keys with increasing generation");
  return value;
}

function validateCheckpoint(value) {
  exactKeys(value, [
    "schemaVersion", "manifestSha256", "generation", "status",
    "expectedHeadSha256", "pendingRequestId", "authorizationSha256",
    "authorityKeyId", "authorityKeyGeneration", "authorityPublicKeyBase64Url",
    "rotationSequence", "previousRotationSha256", "pendingRotationSha256",
    "externalAnchorSequence", "externalAnchorAcceptanceCount",
    "externalAnchorAcceptanceSha256",
  ], "operations checkpoint");
  if (value.schemaVersion !== 4 || !Number.isSafeInteger(value.generation) || value.generation < 0)
    fail("operations checkpoint version or generation is invalid");
  requireHash(value.manifestSha256, "manifest hash");
  requireHead(value.expectedHeadSha256);
  if (!["inactive", "ready", "pending", "rotating"].includes(value.status)) fail("operations checkpoint status is invalid");
  if ((value.status === "pending") !== (typeof value.pendingRequestId === "string" && HEX.test(value.pendingRequestId)))
    fail("operations checkpoint pending request is invalid");
  if (value.status === "inactive" ? value.authorizationSha256 !== null : !HEX.test(value.authorizationSha256))
    fail("operations checkpoint authorization is invalid");
  const authorityAbsent = value.authorityKeyId === null && value.authorityKeyGeneration === null &&
    value.authorityPublicKeyBase64Url === null;
  if (value.status === "inactive") {
    if (!authorityAbsent) fail("inactive operations checkpoint must not have an authority");
  } else {
    const authority = authorityFromRaw(value.authorityPublicKeyBase64Url, value.authorityKeyGeneration);
    if (value.authorityKeyId !== authority.keyId) fail("operations checkpoint authority key ID does not match");
  }
  if (!Number.isSafeInteger(value.rotationSequence) || value.rotationSequence < 0)
    fail("operations checkpoint rotation sequence is invalid");
  if (value.previousRotationSha256 !== "genesis")
    requireHash(value.previousRotationSha256, "previous rotation hash");
  if ((value.status === "rotating") !==
      (typeof value.pendingRotationSha256 === "string" && HEX.test(value.pendingRotationSha256)))
    fail("operations checkpoint pending rotation is invalid");
  if (value.externalAnchorSequence !== null &&
      (!Number.isSafeInteger(value.externalAnchorSequence) || value.externalAnchorSequence < 1))
    fail("operations checkpoint external anchor sequence is invalid");
  if (!Number.isSafeInteger(value.externalAnchorAcceptanceCount) ||
      value.externalAnchorAcceptanceCount < 0)
    fail("operations checkpoint external anchor acceptance count is invalid");
  if (value.externalAnchorAcceptanceCount === 0) {
    if (value.externalAnchorSequence !== null || value.externalAnchorAcceptanceSha256 !== null)
      fail("operations checkpoint external anchor acceptance genesis is invalid");
  } else if (value.externalAnchorSequence === null ||
      typeof value.externalAnchorAcceptanceSha256 !== "string" ||
      !HEX.test(value.externalAnchorAcceptanceSha256)) {
    fail("operations checkpoint external anchor acceptance head is invalid");
  }
  return value;
}

function validateV3Checkpoint(value) {
  exactKeys(value, [
    "schemaVersion", "manifestSha256", "generation", "status",
    "expectedHeadSha256", "pendingRequestId", "authorizationSha256",
    "authorityKeyId", "authorityKeyGeneration", "authorityPublicKeyBase64Url",
    "rotationSequence", "previousRotationSha256", "pendingRotationSha256",
    "externalAnchorSequence",
  ], "schema-3 operations checkpoint");
  if (value.schemaVersion !== 3 || !Number.isSafeInteger(value.generation) || value.generation < 0)
    fail("schema-3 operations checkpoint version or generation is invalid");
  requireHash(value.manifestSha256, "schema-3 manifest hash");
  requireHead(value.expectedHeadSha256);
  if (!["inactive", "ready", "pending", "rotating"].includes(value.status))
    fail("schema-3 operations checkpoint status is invalid");
  if ((value.status === "pending") !==
      (typeof value.pendingRequestId === "string" && HEX.test(value.pendingRequestId)))
    fail("schema-3 operations checkpoint pending request is invalid");
  if (value.status === "inactive" ? value.authorizationSha256 !== null :
      typeof value.authorizationSha256 !== "string" || !HEX.test(value.authorizationSha256))
    fail("schema-3 operations checkpoint authorization is invalid");
  const authorityAbsent = value.authorityKeyId === null &&
    value.authorityKeyGeneration === null && value.authorityPublicKeyBase64Url === null;
  if (value.status === "inactive") {
    if (!authorityAbsent) fail("inactive schema-3 operations checkpoint must not have an authority");
  } else {
    const authority = authorityFromRaw(
      value.authorityPublicKeyBase64Url,
      value.authorityKeyGeneration,
    );
    if (value.authorityKeyId !== authority.keyId)
      fail("schema-3 operations checkpoint authority key ID does not match");
  }
  if (!Number.isSafeInteger(value.rotationSequence) || value.rotationSequence < 0)
    fail("schema-3 operations checkpoint rotation sequence is invalid");
  if (value.previousRotationSha256 !== "genesis")
    requireHash(value.previousRotationSha256, "schema-3 previous rotation hash");
  if ((value.status === "rotating") !==
      (typeof value.pendingRotationSha256 === "string" && HEX.test(value.pendingRotationSha256)))
    fail("schema-3 operations checkpoint pending rotation is invalid");
  if (value.externalAnchorSequence !== null &&
      (!Number.isSafeInteger(value.externalAnchorSequence) || value.externalAnchorSequence < 1))
    fail("schema-3 operations checkpoint external anchor sequence is invalid");
  return value;
}

function validateV3MigrationRecord(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "sourceCheckpointSha256",
    "destinationCheckpointSha256", "copiedRotationRecordCount",
    "sourceCheckpoint",
  ], "schema-3 migration record");
  if (value.schemaVersion !== 1 ||
      value.kind !== "operations-checkpoint-v3-v4-migration")
    fail("schema-3 migration record identity is invalid");
  requireHash(value.sourceCheckpointSha256, "migration source checkpoint hash");
  requireHash(value.destinationCheckpointSha256, "migration destination checkpoint hash");
  if (!Number.isSafeInteger(value.copiedRotationRecordCount) ||
      value.copiedRotationRecordCount < 0)
    fail("schema-3 migration copied rotation record count is invalid");
  validateV3Checkpoint(value.sourceCheckpoint);
  return value;
}

async function requireDirectory(root) {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail("operations store must be a real directory");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) fail("operations store must be owned by the current user");
  if ((metadata.mode & 0o077) !== 0) fail("operations store permissions are unsafe");
  if ((await realpath(root)) !== resolve(root) && !DESCRIPTOR_RELATIVE_PATH.test(root))
    fail("operations store path must not traverse symlinks");
}

async function secureJson(path, field) {
  const bytes = await secureBytes(path, true, field);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${field} is not valid JSON`); }
  if (`${canonicalJson(value)}\n` !== bytes.toString("utf8")) fail(`${field} is not canonical JSON`);
  return value;
}

async function securePublicJson(path, field) {
  const bytes = await secureBytes(path, false, field);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${field} is not valid JSON`); }
  if (`${canonicalJson(value)}\n` !== bytes.toString("utf8")) fail(`${field} is not canonical JSON`);
  return value;
}

async function syncDirectory(path) {
  const openedPath = /^\/proc\/self\/fd\/[1-9][0-9]*$/.test(path)
    ? `${path}/.` : path;
  const handle = await open(openedPath, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeNewDurableJson(path, value, mode, field) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== bytes.length ||
        (before.mode & 0o777) !== mode ||
        (typeof process.getuid === "function" && before.uid !== process.getuid()))
      fail(`${field} is unsafe after durable write; preserve state and inspect`);
    const observed = Buffer.alloc(bytes.length);
    const { bytesRead } = await handle.read(observed, 0, observed.length, 0);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || !observed.equals(bytes) ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== before.nlink || after.size !== before.size ||
        after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail(`${field} changed after durable write; preserve state and inspect`);
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeContentAddressedRecovery(path, value, field) {
  try {
    await writeNewDurableJson(path, value, 0o400, field);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n ||
          before.size < 1n || before.size > BigInt(MAX_JSON) ||
          (before.mode & 0o777n) !== 0o400n ||
          (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())))
        fail(`existing ${field} does not have the exact recovery file identity`);
      const bytes = Buffer.alloc(Number(before.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat({ bigint: true });
      const linked = await lstat(path, { bigint: true });
      if (!["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
          .every((name) => before[name] === after[name] && after[name] === linked[name]) ||
          !linked.isFile() || linked.isSymbolicLink() ||
          bytesRead !== bytes.length || bytes.length !== Number(after.size))
        fail(`existing ${field} changed while it was being validated`);
      let existing;
      try { existing = JSON.parse(bytes.toString("utf8")); } catch {
        fail(`existing ${field} is not valid JSON`);
      }
      if (`${canonicalJson(existing)}\n` !== bytes.toString("utf8") ||
          canonicalJson(existing) !== canonicalJson(value))
        fail(`${field} path contains different content`);
    } finally {
      await handle?.close();
    }
  }
}

async function replaceCheckpoint(root, expectedCurrent, next) {
  const target = join(root, HEAD);
  const temporary = join(root, `.${basename(HEAD)}.${process.pid}.${Date.now()}.tmp`);
  const predecessor = join(
    root,
    `.checkpoint.previous.${canonicalSha256(expectedCurrent)}.json`,
  );
  const candidate = join(
    root,
    `.checkpoint.candidate.${canonicalSha256(next)}.json`,
  );
  await writeNewDurableJson(temporary, next, 0o400, "temporary operations checkpoint");
  await requireUnchangedCheckpoint(root, expectedCurrent, "at checkpoint publication boundary");
  await writeContentAddressedRecovery(
    candidate,
    next,
    "checkpoint recovery candidate",
  );
  await writeContentAddressedRecovery(
    predecessor,
    expectedCurrent,
    "checkpoint recovery predecessor",
  );
  await syncDirectory(root);
  await requireUnchangedCheckpoint(root, expectedCurrent, "before predecessor removal");
  let predecessorRemoved = false;
  try {
    await unlink(target);
    predecessorRemoved = true;
    await syncDirectory(root);
    await link(temporary, target);
    await syncDirectory(root);
    await unlink(temporary);
    await syncDirectory(root);
    if (canonicalJson(await secureJson(target, "published operations checkpoint")) !==
        canonicalJson(next))
      fail("published operations checkpoint differs from the durable candidate");
  } catch (cause) {
    if (!predecessorRemoved) throw cause;
    const error = new Error(
      "publication quorum transport operations: checkpoint publication outcome is ambiguous; preserve lock, candidate, predecessor, and named checkpoint",
      { cause },
    );
    error.preserveOperationsLock = true;
    throw error;
  }
}

async function requireUnchangedCheckpoint(root, expected, phase) {
  const observed = validateCheckpoint(await secureJson(
    join(root, HEAD),
    `operations checkpoint ${phase}`,
  ));
  if (canonicalJson(observed) !== canonicalJson(expected))
    fail(`operations checkpoint changed ${phase}; preserve state and inspect`);
}

async function writeDurableRecord(path, value, mode, parent) {
  try {
    await writeNewDurableJson(path, value, mode, "operations history record");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (canonicalJson(await secureJson(path, "existing rotation record")) !== canonicalJson(value))
      fail("rotation record path is occupied by different content");
  }
  await syncDirectory(parent);
}

function validateOperationsLock(value) {
  exactKeys(value, [
    "schemaVersion", "pid", "operation", "startingCheckpointSha256",
  ], "operations lock");
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.operation !== "string" || !LOCK_OPERATION.test(value.operation))
    fail("operations lock identity is invalid");
  requireHash(value.startingCheckpointSha256, "operations lock starting checkpoint hash");
  return value;
}

async function acquireLock(root, operation) {
  if (typeof operation !== "string" || !LOCK_OPERATION.test(operation))
    fail("operations lock operation is invalid");
  const path = join(root, LOCK);
  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const startingCheckpoint = await secureJson(
      join(root, HEAD),
      "operations checkpoint before lock",
    );
    const record = validateOperationsLock({
      schemaVersion: 2,
      pid: process.pid,
      operation,
      startingCheckpointSha256: canonicalSha256(startingCheckpoint),
    });
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || (metadata.mode & 0o077n) !== 0n ||
        (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())))
      fail("new operations lock is unsafe; preserve state and inspect");
    await syncDirectory(root);
    return {
      handle,
      path,
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
      bytes,
      record,
    };
  } catch (error) {
    await handle?.close();
    if (error?.code === "EEXIST") fail("operations store is locked; inspect before recovery");
    throw error;
  }
}

async function ensureActiveLockPoison(root, lock, evidencePaths) {
  for (const evidencePath of evidencePaths) {
    if (!evidencePath) continue;
    try {
      await link(evidencePath, lock.path);
      await syncDirectory(root);
      return;
    } catch (error) {
      if (error?.code === "EEXIST") {
        await syncDirectory(root);
        return;
      }
      // A raced-away tombstone or recovery is not the last resort: try the
      // next independently retained source before recreating canonical bytes.
    }
  }

  try {
    await writeNewDurableJson(
      lock.path,
      lock.record,
      0o600,
      "operations lock poison marker",
    );
  } catch (error) {
    if (error?.code !== "EEXIST") {
      const present = await lstat(lock.path).then(() => true, (statError) => {
        if (statError?.code === "ENOENT") return false;
        throw statError;
      });
      if (!present) throw error;
    }
  }
  await syncDirectory(root);
}

async function releaseLock(root, lock) {
  const recovery = join(
    root,
    `.operations.lock.recovery.${hashBytes(lock.bytes)}.json`,
  );
  const cleanup = join(
    root,
    `.operations.lock.cleanup.${process.pid}.${randomBytes(16).toString("hex")}`,
  );
  let retainedPath;
  let moved = false;
  let failure = null;
  try {
    const openedBefore = await lock.handle.stat({ bigint: true });
    const observed = Buffer.alloc(lock.bytes.length);
    const { bytesRead } = await lock.handle.read(observed, 0, observed.length, 0);
    const opened = await lock.handle.stat({ bigint: true });
    const linked = await lstat(lock.path, { bigint: true }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!linked || bytesRead !== lock.bytes.length || !observed.equals(lock.bytes) ||
        !openedBefore.isFile() || openedBefore.nlink !== 1n ||
        openedBefore.dev !== lock.dev || openedBefore.ino !== lock.ino ||
        openedBefore.uid !== lock.uid || openedBefore.gid !== lock.gid ||
        openedBefore.mode !== lock.mode || openedBefore.size !== lock.size ||
        openedBefore.mtimeNs !== lock.mtimeNs || openedBefore.ctimeNs !== lock.ctimeNs ||
        !opened.isFile() || opened.nlink !== 1n ||
        opened.dev !== lock.dev || opened.ino !== lock.ino ||
        opened.uid !== lock.uid || opened.gid !== lock.gid || opened.mode !== lock.mode ||
        opened.size !== lock.size || opened.mtimeNs !== lock.mtimeNs ||
        opened.ctimeNs !== lock.ctimeNs ||
        !linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n ||
        linked.dev !== lock.dev || linked.ino !== lock.ino ||
        linked.uid !== lock.uid || linked.gid !== lock.gid || linked.mode !== lock.mode ||
        linked.size !== lock.size || linked.mtimeNs !== lock.mtimeNs ||
        linked.ctimeNs !== lock.ctimeNs)
      fail("operations lock identity changed; preserve state and inspect before recovery");

    await writeContentAddressedRecovery(
      recovery,
      lock.record,
      "operations lock recovery evidence",
    );
    await syncDirectory(root);
    await mkdir(cleanup, { mode: 0o700 });
    await syncDirectory(root);

    // Generate the destination only after reserving the private cleanup
    // namespace. Until the atomic rename publishes it, no filesystem observer
    // can discover this 256-bit basename and race an object into that exact
    // destination. This avoids rename(2)'s overwrite semantics without a
    // check-then-rename window.
    retainedPath = join(cleanup, `retained-${randomBytes(32).toString("hex")}`);
    await rename(lock.path, retainedPath);
    moved = true;
    await syncDirectory(cleanup);
    await syncDirectory(root);

    const active = await lstat(lock.path, { bigint: true }).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const retainedNamed = await lstat(retainedPath, { bigint: true });
    const after = await lock.handle.stat({ bigint: true });
    const retained = Buffer.alloc(lock.bytes.length);
    const retainedRead = await lock.handle.read(retained, 0, retained.length, 0);
    const closing = await lock.handle.stat({ bigint: true });
    if (active || retainedRead.bytesRead !== lock.bytes.length || !retained.equals(lock.bytes) ||
        after.nlink !== 1n || after.dev !== lock.dev || after.ino !== lock.ino ||
        after.uid !== lock.uid || after.gid !== lock.gid || after.mode !== lock.mode ||
        after.size !== lock.size || after.mtimeNs !== lock.mtimeNs ||
        !retainedNamed.isFile() || retainedNamed.isSymbolicLink() ||
        retainedNamed.nlink !== 1n || retainedNamed.dev !== after.dev ||
        retainedNamed.ino !== after.ino || retainedNamed.uid !== after.uid ||
        retainedNamed.gid !== after.gid || retainedNamed.mode !== after.mode ||
        retainedNamed.size !== after.size || retainedNamed.mtimeNs !== after.mtimeNs ||
        retainedNamed.ctimeNs !== after.ctimeNs ||
        closing.nlink !== 1n || closing.dev !== after.dev || closing.ino !== after.ino ||
        closing.uid !== after.uid || closing.gid !== after.gid ||
        closing.mode !== after.mode || closing.size !== after.size ||
        closing.mtimeNs !== after.mtimeNs || closing.ctimeNs !== after.ctimeNs)
      fail("operations lock cleanup outcome is ambiguous; preserve tombstone and recovery evidence");
  } catch (error) {
    failure = error;
  }

  try {
    await lock.handle.close();
    if (moved) {
      await syncDirectory(cleanup);
      await syncDirectory(root);
    }
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error],
        "publication quorum transport operations: lock cleanup and finalization both failed")
      : error;
  }

  if (failure) {
    try {
      // Every failed release stays visibly locked, including failures before
      // rename and failures after the staged pathname itself is displaced.
      // Each publication is create-only; an independently raced active object
      // is evidence and already serves as the poison marker.
      await ensureActiveLockPoison(root, lock, [retainedPath, recovery]);
    } catch (poisonError) {
      throw new AggregateError(
        [failure, poisonError],
        "publication quorum transport operations: ambiguous lock cleanup could not restore the active poison marker",
      );
    }
    throw failure;
  }
}

async function withLock(
  root,
  operationName,
  operation,
  { directoryAlreadyPinned = false } = {},
) {
  if (!directoryAlreadyPinned) await requireDirectory(root);
  const lock = await acquireLock(root, operationName);
  let preserve = false;
  try {
    return await operation();
  } catch (error) {
    preserve = error?.preserveOperationsLock === true;
    throw error;
  } finally {
    if (preserve) {
      await lock.handle.close();
      await syncDirectory(root);
    } else {
      await releaseLock(root, lock);
    }
  }
}

async function withOrderedLocks(roots, operationName, operation) {
  const canonicalRoots = await Promise.all(roots.map(async (root) => {
    await requireDirectory(root);
    return realpath(root);
  }));
  if (new Set(canonicalRoots).size !== canonicalRoots.length)
    fail("each operations store lock target must be distinct");
  const orderedRoots = [...canonicalRoots].sort();
  const acquire = (index) => index === orderedRoots.length
    ? operation(canonicalRoots)
    : withLock(orderedRoots[index], operationName, () => acquire(index + 1));
  return acquire(0);
}

export async function initializeOperationsStore(root, manifest, expectedManifestSha256, initialHead) {
  validatePreflightManifest(manifest);
  requireHash(expectedManifestSha256, "externally approved manifest hash");
  if (canonicalSha256(manifest) !== expectedManifestSha256)
    fail("preflight manifest does not match the externally approved hash; refusing TOFU");
  requireHead(initialHead);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await requireDirectory(root);
  await mkdir(join(root, ROTATIONS), { mode: 0o700 });
  await chmod(join(root, ROTATIONS), 0o700);
  await mkdir(join(root, ANCHOR_ACCEPTANCES), { mode: 0o700 });
  await chmod(join(root, ANCHOR_ACCEPTANCES), 0o700);
  const checkpoint = {
    schemaVersion: 4,
    manifestSha256: expectedManifestSha256,
    generation: 0,
    status: "inactive",
    expectedHeadSha256: initialHead,
    pendingRequestId: null,
    authorizationSha256: null,
    authorityKeyId: null,
    authorityKeyGeneration: null,
    authorityPublicKeyBase64Url: null,
    rotationSequence: 0,
    previousRotationSha256: "genesis",
    pendingRotationSha256: null,
    externalAnchorSequence: null,
    externalAnchorAcceptanceCount: 0,
    externalAnchorAcceptanceSha256: null,
  };
  await writeNewDurableJson(
    join(root, HEAD), checkpoint, 0o400, "initial operations checkpoint",
  );
  await syncDirectory(root);
  return checkpoint;
}

export async function activateOperationsStore(root, authorization, expectedAuthorizationSha256) {
  requireHash(expectedAuthorizationSha256, "externally approved authorization hash");
  if (canonicalSha256(authorization) !== expectedAuthorizationSha256)
    fail("activation authorization does not match the externally approved hash");
  exactKeys(authorization, [
    "schemaVersion", "authorizationId", "manifestSha256", "expectedHeadSha256",
    "enabled", "authorityKeyId", "authorityKeyGeneration", "authorityPublicKeyBase64Url",
  ], "activation authorization");
  if (authorization.schemaVersion !== 1 || authorization.enabled !== true || !ID.test(authorization.authorizationId))
    fail("activation authorization is invalid");
  const authority = authorityFromRaw(
    authorization.authorityPublicKeyBase64Url,
    authorization.authorityKeyGeneration,
  );
  if (authorization.authorityKeyId !== authority.keyId)
    fail("activation authority key ID does not match");
  return withLock(root, "activate", async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    if (current.status !== "inactive" || current.generation !== 0) fail("operations store is already activated or advanced");
    if (authorization.manifestSha256 !== current.manifestSha256 || authorization.expectedHeadSha256 !== current.expectedHeadSha256)
      fail("activation authorization does not bind the retained checkpoint");
    const next = {
      ...current, generation: 1, status: "ready",
      authorizationSha256: expectedAuthorizationSha256,
      authorityKeyId: authority.keyId,
      authorityKeyGeneration: authority.keyGeneration,
      authorityPublicKeyBase64Url: authority.publicKeyBase64Url,
    };
    await replaceCheckpoint(root, current, next);
    return next;
  });
}

function checkpointAuthority(checkpoint) {
  return {
    keyId: checkpoint.authorityKeyId,
    keyGeneration: checkpoint.authorityKeyGeneration,
    publicKeyBase64Url: checkpoint.authorityPublicKeyBase64Url,
  };
}

function validateAnchorStatement(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "streamId", "checkpointSha256", "checkpointGeneration",
    "manifestSha256", "expectedHeadSha256", "rotationSequence",
    "previousRotationSha256", "authority",
  ], "operations anchor statement");
  if (value.schemaVersion !== 1 || value.kind !== "operations-checkpoint-anchor")
    fail("operations anchor statement identity is invalid");
  requireHash(value.streamId, "operations anchor stream ID");
  requireHash(value.checkpointSha256, "anchored checkpoint hash");
  if (!Number.isSafeInteger(value.checkpointGeneration) || value.checkpointGeneration < 1)
    fail("anchored checkpoint generation is invalid");
  requireHash(value.manifestSha256, "anchored manifest hash");
  requireHead(value.expectedHeadSha256);
  if (!Number.isSafeInteger(value.rotationSequence) || value.rotationSequence < 0)
    fail("anchored rotation sequence is invalid");
  if (value.previousRotationSha256 !== "genesis")
    requireHash(value.previousRotationSha256, "anchored previous rotation hash");
  exactKeys(value.authority, [
    "keyId", "keyGeneration", "publicKeyBase64Url",
  ], "anchor authority");
  const authority = authorityFromRaw(
    value.authority.publicKeyBase64Url,
    value.authority.keyGeneration,
  );
  if (value.authority.keyId !== authority.keyId)
    fail("anchor authority key ID does not match");
  return value;
}

function anchorStatement(checkpoint, chain) {
  if (checkpoint.status !== "ready")
    fail("only a ready operations checkpoint can be externally anchored");
  return validateAnchorStatement({
    schemaVersion: 1,
    kind: "operations-checkpoint-anchor",
    streamId: canonicalSha256({
      schemaVersion: 1,
      kind: "operations-anchor-stream",
      initialManifestSha256: chain.initialManifestSha256,
      initialAuthorityKeyId: chain.initialAuthorityKeyId,
    }),
    checkpointSha256: canonicalSha256(checkpoint),
    checkpointGeneration: checkpoint.generation,
    manifestSha256: checkpoint.manifestSha256,
    expectedHeadSha256: checkpoint.expectedHeadSha256,
    rotationSequence: checkpoint.rotationSequence,
    previousRotationSha256: checkpoint.previousRotationSha256,
    authority: checkpointAuthority(checkpoint),
  });
}

export async function prepareOperationsRotation({
  root,
  priorManifest,
  nextManifest,
  expectedNextManifestSha256,
  nextAuthority,
}) {
  validatePreflightManifest(priorManifest);
  validatePreflightManifest(nextManifest);
  requireHash(expectedNextManifestSha256, "externally approved next manifest hash");
  if (canonicalSha256(nextManifest) !== expectedNextManifestSha256)
    fail("next manifest does not match the externally approved hash; refusing TOFU");
  if (priorManifest.witnessConfigSha256 !== nextManifest.witnessConfigSha256)
    fail("mTLS profile rotation must not replace the witness trust anchor");
  const parsedNextAuthority = authorityFromRaw(
    nextAuthority?.publicKeyBase64Url,
    nextAuthority?.keyGeneration,
  );
  if (nextAuthority?.keyId !== parsedNextAuthority.keyId)
    fail("next rotation authority key ID does not match");
  return withLock(root, "prepare-rotation", async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    await auditRotationChain(root, current);
    await auditAnchorAcceptanceChain(root, current);
    if (current.status !== "ready")
      fail("operations store must be ready before starting mTLS profile rotation");
    if (canonicalSha256(priorManifest) !== current.manifestSha256)
      fail("prior manifest differs from the retained approved profile");
    const rotation = validateRotationPayload({
      schemaVersion: 1,
      kind: "mtls-profile-rotation",
      rotationSequence: current.rotationSequence + 1,
      previousRotationSha256: current.previousRotationSha256,
      priorManifestSha256: current.manifestSha256,
      nextManifestSha256: expectedNextManifestSha256,
      expectedHeadSha256: current.expectedHeadSha256,
      priorAuthority: checkpointAuthority(current),
      nextAuthority: {
        keyId: parsedNextAuthority.keyId,
        keyGeneration: parsedNextAuthority.keyGeneration,
        publicKeyBase64Url: parsedNextAuthority.publicKeyBase64Url,
      },
    });
    const rotationSha256 = canonicalSha256(rotation);
    const rotations = join(root, ROTATIONS);
    await requireDirectory(rotations);
    await writeDurableRecord(join(rotations, `${rotationSha256}.json`), rotation, 0o400, rotations);
    const next = {
      ...current,
      generation: current.generation + 1,
      status: "rotating",
      pendingRotationSha256: rotationSha256,
    };
    await replaceCheckpoint(root, current, next);
    return { rotation, rotationSha256, checkpoint: next };
  });
}

export function authorizeOperationsRotation(rotationInput, role, privateKey, keyGeneration) {
  const rotation = validateRotationPayload(rotationInput);
  if (!["prior-authorization", "next-acceptance"].includes(role))
    fail("rotation authorization role is invalid");
  const expected = role === "prior-authorization" ? rotation.priorAuthority : rotation.nextAuthority;
  const identity = describeKey(privateKey);
  if (identity.keyId !== expected.keyId || keyGeneration !== expected.keyGeneration)
    fail("rotation signing key does not match the role-bound authority");
  return signEnvelope({ role, rotation }, privateKey, MTLS_PROFILE_ROTATION_DOMAIN, keyGeneration);
}

function verifyRotationAuthorization(envelope, role, rotation, authority) {
  const parsed = authorityFromRaw(authority.publicKeyBase64Url, authority.keyGeneration);
  const payload = verifyEnvelope(
    envelope,
    parsed.publicKey,
    MTLS_PROFILE_ROTATION_DOMAIN,
    authority.keyGeneration,
  );
  exactKeys(payload, ["role", "rotation"], "rotation authorization payload");
  if (payload.role !== role || canonicalJson(payload.rotation) !== canonicalJson(rotation))
    fail("rotation authorization does not bind the exact role and transition");
}

function validateRotationRecord(value) {
  exactKeys(value, [
    "schemaVersion", "rotation", "priorAuthorization", "nextAcceptance",
  ], "mTLS profile rotation record");
  if (value.schemaVersion !== 1) fail("mTLS profile rotation record version is invalid");
  const rotation = validateRotationPayload(value.rotation);
  verifyRotationAuthorization(
    value.priorAuthorization, "prior-authorization", rotation, rotation.priorAuthority,
  );
  verifyRotationAuthorization(
    value.nextAcceptance, "next-acceptance", rotation, rotation.nextAuthority,
  );
  return { record: value, rotation };
}

async function requireAnchoredPrivateDirectory(path, field) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0)
    fail(`${field} identity or permissions are invalid`);
}

async function auditedHistoryJson(path, field, snapshots) {
  if (!snapshots) return secureJson(path, field);
  const snapshot = await readCanonicalCheckpointSnapshot(path, field);
  snapshots.push({ path, field, bytes: snapshot.bytes, metadata: snapshot.metadata });
  return snapshot.value;
}

async function auditRotationChain(
  root, checkpoint, descriptorRelative = false, snapshots = null,
) {
  const rotations = join(root, ROTATIONS);
  if (descriptorRelative)
    await requireAnchoredPrivateDirectory(rotations, "rotation history directory");
  else await requireDirectory(rotations);
  let expectedRecordSha256 = checkpoint.previousRotationSha256;
  let expectedSequence = checkpoint.rotationSequence;
  let expectedManifestSha256 = checkpoint.manifestSha256;
  let expectedAuthority = checkpointAuthority(checkpoint);
  let verifiedRecords = 0;
  while (expectedSequence > 0) {
    if (expectedRecordSha256 === "genesis")
      fail("rotation chain terminates before its retained sequence");
    const { record, rotation } = validateRotationRecord(await auditedHistoryJson(
      join(rotations, `${expectedRecordSha256}.json`),
      `rotation record ${expectedSequence}`,
      snapshots,
    ));
    if (canonicalSha256(record) !== expectedRecordSha256)
      fail("rotation record content does not match its retained hash");
    if (rotation.rotationSequence !== expectedSequence ||
        rotation.nextManifestSha256 !== expectedManifestSha256 ||
        canonicalJson(rotation.nextAuthority) !== canonicalJson(expectedAuthority))
      fail("rotation record breaks the retained sequence, manifest, or authority chain");
    expectedRecordSha256 = rotation.previousRotationSha256;
    expectedManifestSha256 = rotation.priorManifestSha256;
    expectedAuthority = rotation.priorAuthority;
    expectedSequence -= 1;
    verifiedRecords += 1;
  }
  if (expectedRecordSha256 !== "genesis")
    fail("rotation chain has a non-genesis predecessor at sequence zero");
  return {
    verifiedRecords,
    initialManifestSha256: expectedManifestSha256,
    initialAuthorityKeyId: expectedAuthority.keyId,
  };
}

async function collectRotationArtifacts(root, checkpoint) {
  const records = [];
  let expectedRecordSha256 = checkpoint.previousRotationSha256;
  let expectedSequence = checkpoint.rotationSequence;
  while (expectedSequence > 0) {
    const record = await secureJson(
      join(root, ROTATIONS, `${expectedRecordSha256}.json`),
      `schema-3 rotation record ${expectedSequence}`,
    );
    const { rotation } = validateRotationRecord(record);
    if (canonicalSha256(record) !== expectedRecordSha256 ||
        rotation.rotationSequence !== expectedSequence)
      fail("schema-3 rotation record does not match its retained hash or sequence");
    records.push({ sha256: expectedRecordSha256, value: record });
    expectedRecordSha256 = rotation.previousRotationSha256;
    expectedSequence -= 1;
  }
  let pending = null;
  if (checkpoint.status === "rotating") {
    const value = validateRotationPayload(await secureJson(
      join(root, ROTATIONS, `${checkpoint.pendingRotationSha256}.json`),
      "schema-3 pending rotation",
    ));
    if (canonicalSha256(value) !== checkpoint.pendingRotationSha256)
      fail("schema-3 pending rotation does not match its retained hash");
    pending = { sha256: checkpoint.pendingRotationSha256, value };
  }
  return { records, pending };
}

export async function migrateOperationsStoreV3ToV4({
  sourceRoot,
  destinationRoot,
  expectedV3CheckpointSha256,
}) {
  requireHash(expectedV3CheckpointSha256, "externally approved schema-3 checkpoint hash");
  await requireSeparateTrees(sourceRoot, destinationRoot);
  return withLock(sourceRoot, "migrate-v3-to-v4", async () => {
    const sourceCheckpoint = validateV3Checkpoint(await secureJson(
      join(sourceRoot, HEAD),
      "schema-3 operations checkpoint",
    ));
    if (canonicalSha256(sourceCheckpoint) !== expectedV3CheckpointSha256)
      fail("schema-3 checkpoint does not match the externally approved hash; refusing TOFU");
    if (sourceCheckpoint.externalAnchorSequence !== null)
      fail("schema-3 store has accepted an external anchor head without retaining its evidence chain; safe migration is impossible");
    await auditRotationChain(sourceRoot, sourceCheckpoint);
    const artifacts = await collectRotationArtifacts(sourceRoot, sourceCheckpoint);
    const nextCheckpoint = {
      ...sourceCheckpoint,
      schemaVersion: 4,
      externalAnchorAcceptanceCount: 0,
      externalAnchorAcceptanceSha256: null,
    };
    const destinationCheckpointSha256 = canonicalSha256(nextCheckpoint);
    const migration = {
      schemaVersion: 1,
      kind: "operations-checkpoint-v3-v4-migration",
      sourceCheckpointSha256: expectedV3CheckpointSha256,
      destinationCheckpointSha256,
      copiedRotationRecordCount: artifacts.records.length,
      sourceCheckpoint,
    };

    // mkdir is the no-clobber publication boundary. A failed attempt leaves an
    // occupied, non-runnable directory because checkpoint.json is written last.
    await mkdir(destinationRoot, { mode: 0o700 });
    await chmod(destinationRoot, 0o700);
    await requireDirectory(destinationRoot);
    const rotations = join(destinationRoot, ROTATIONS);
    const acceptances = join(destinationRoot, ANCHOR_ACCEPTANCES);
    await mkdir(rotations, { mode: 0o700 });
    await chmod(rotations, 0o700);
    await mkdir(acceptances, { mode: 0o700 });
    await chmod(acceptances, 0o700);
    for (const artifact of artifacts.records)
      await writeNewDurableJson(
        join(rotations, `${artifact.sha256}.json`),
        artifact.value,
        0o400,
        "migrated rotation record",
      );
    if (artifacts.pending &&
        !artifacts.records.some(({ sha256 }) => sha256 === artifacts.pending.sha256))
      await writeNewDurableJson(
        join(rotations, `${artifacts.pending.sha256}.json`),
        artifacts.pending.value,
        0o400,
        "migrated pending rotation",
      );
    await syncDirectory(rotations);
    await syncDirectory(acceptances);
    await writeNewDurableJson(
      join(destinationRoot, V3_MIGRATION_RECORD),
      migration,
      0o400,
      "schema-3 migration record",
    );
    await syncDirectory(destinationRoot);
    if (canonicalSha256(validateV3Checkpoint(await secureJson(
      join(sourceRoot, HEAD),
      "schema-3 operations checkpoint after copy",
    ))) !== expectedV3CheckpointSha256)
      fail("schema-3 checkpoint changed during migration");
    await writeNewDurableJson(
      join(destinationRoot, HEAD),
      nextCheckpoint,
      0o400,
      "migrated operations checkpoint",
    );
    await syncDirectory(destinationRoot);
    const audit = await auditOperationsStore(destinationRoot);
    return {
      sourceCheckpointSha256: expectedV3CheckpointSha256,
      destinationCheckpointSha256,
      migrationRecordSha256: canonicalSha256(migration),
      sourcePreserved: true,
      audit,
    };
  });
}

export async function verifyOperationsStoreV3ToV4Migration({
  sourceRoot,
  destinationRoot,
  expectedV3CheckpointSha256,
  expectedV4CheckpointSha256,
  expectedMigrationRecordSha256,
}) {
  requireHash(expectedV3CheckpointSha256, "externally approved schema-3 checkpoint hash");
  requireHash(expectedV4CheckpointSha256, "externally approved schema-4 checkpoint hash");
  requireHash(expectedMigrationRecordSha256, "externally approved migration record hash");
  await requireSeparateTrees(sourceRoot, destinationRoot);
  return withOrderedLocks([sourceRoot, destinationRoot], "verify-v3-to-v4", async ([
    canonicalSourceRoot,
    canonicalDestinationRoot,
  ]) => {
    const sourceCheckpoint = validateV3Checkpoint(await secureJson(
      join(canonicalSourceRoot, HEAD),
      "schema-3 source checkpoint",
    ));
    if (canonicalSha256(sourceCheckpoint) !== expectedV3CheckpointSha256)
      fail("schema-3 source checkpoint does not match the externally approved hash");
    if (sourceCheckpoint.externalAnchorSequence !== null)
      fail("schema-3 source has unretained external anchor acceptance history");
    const sourceChain = await auditRotationChain(canonicalSourceRoot, sourceCheckpoint);
    const sourceArtifacts = await collectRotationArtifacts(
      canonicalSourceRoot,
      sourceCheckpoint,
    );

    const destinationCheckpoint = validateCheckpoint(await secureJson(
      join(canonicalDestinationRoot, HEAD),
      "schema-4 destination checkpoint",
    ));
    if (canonicalSha256(destinationCheckpoint) !== expectedV4CheckpointSha256)
      fail("schema-4 destination checkpoint does not match the externally approved hash");
    const derivedDestinationCheckpoint = {
      ...sourceCheckpoint,
      schemaVersion: 4,
      externalAnchorAcceptanceCount: 0,
      externalAnchorAcceptanceSha256: null,
    };
    if (canonicalJson(destinationCheckpoint) !== canonicalJson(derivedDestinationCheckpoint))
      fail("schema-4 destination checkpoint is not the exact migration of the source");

    const migration = validateV3MigrationRecord(await secureJson(
      join(canonicalDestinationRoot, V3_MIGRATION_RECORD),
      "schema-3 migration record",
    ));
    if (canonicalSha256(migration) !== expectedMigrationRecordSha256)
      fail("schema-3 migration record does not match the externally approved hash");
    if (migration.sourceCheckpointSha256 !== expectedV3CheckpointSha256 ||
        migration.destinationCheckpointSha256 !== expectedV4CheckpointSha256 ||
        canonicalJson(migration.sourceCheckpoint) !== canonicalJson(sourceCheckpoint) ||
        migration.copiedRotationRecordCount !== sourceArtifacts.records.length ||
        migration.copiedRotationRecordCount !== sourceChain.verifiedRecords)
      fail("schema-3 migration record does not bind the verified source and destination");

    const destinationAudit = await auditOperationsStore(canonicalDestinationRoot);
    if (destinationAudit.verifiedRecords !== sourceChain.verifiedRecords ||
        destinationAudit.verifiedAnchorAcceptances !== 0)
      fail("schema-4 destination audit does not match the migrated source history");

    const closingSourceCheckpoint = validateV3Checkpoint(await secureJson(
      join(canonicalSourceRoot, HEAD),
      "schema-3 source checkpoint after verification",
    ));
    const closingDestinationCheckpoint = validateCheckpoint(await secureJson(
      join(canonicalDestinationRoot, HEAD),
      "schema-4 destination checkpoint after verification",
    ));
    const closingMigration = validateV3MigrationRecord(await secureJson(
      join(canonicalDestinationRoot, V3_MIGRATION_RECORD),
      "schema-3 migration record after verification",
    ));
    if (canonicalSha256(closingSourceCheckpoint) !== expectedV3CheckpointSha256 ||
        canonicalSha256(closingDestinationCheckpoint) !== expectedV4CheckpointSha256 ||
        canonicalSha256(closingMigration) !== expectedMigrationRecordSha256)
      fail("migration state changed during offline verification");
    const closingSourceChain = await auditRotationChain(
      canonicalSourceRoot,
      closingSourceCheckpoint,
    );
    const closingSourceArtifacts = await collectRotationArtifacts(
      canonicalSourceRoot,
      closingSourceCheckpoint,
    );
    const closingDestinationAudit = await auditOperationsStore(canonicalDestinationRoot);
    if (canonicalJson(closingSourceChain) !== canonicalJson(sourceChain) ||
        canonicalJson(closingSourceArtifacts) !== canonicalJson(sourceArtifacts) ||
        canonicalJson(closingDestinationAudit) !== canonicalJson(destinationAudit))
      fail("migration history changed during offline verification");
    return {
      schemaVersion: 1,
      kind: "operations-checkpoint-v3-v4-verification-receipt",
      sourceCheckpointSha256: expectedV3CheckpointSha256,
      destinationCheckpointSha256: expectedV4CheckpointSha256,
      migrationRecordSha256: expectedMigrationRecordSha256,
      copiedRotationRecordCount: sourceChain.verifiedRecords,
      sourcePreserved: true,
      destinationAudit: closingDestinationAudit,
    };
  });
}

async function auditOperationsStoreAtCheckpoint(
  root, checkpointInput, descriptorRelative = false, snapshots = null,
) {
  const checkpoint = validateCheckpoint(checkpointInput);
  const chain = await auditRotationChain(root, checkpoint, descriptorRelative, snapshots);
  const anchorAcceptances = await auditAnchorAcceptanceChain(
    root, checkpoint, descriptorRelative, snapshots,
  );
  let pendingRotationSha256 = null;
  if (checkpoint.status === "rotating") {
    const rotation = validateRotationPayload(await auditedHistoryJson(
      join(root, ROTATIONS, `${checkpoint.pendingRotationSha256}.json`),
      "pending rotation",
      snapshots,
    ));
    if (canonicalSha256(rotation) !== checkpoint.pendingRotationSha256 ||
        rotation.rotationSequence !== checkpoint.rotationSequence + 1 ||
        rotation.previousRotationSha256 !== checkpoint.previousRotationSha256 ||
        rotation.priorManifestSha256 !== checkpoint.manifestSha256 ||
        rotation.expectedHeadSha256 !== checkpoint.expectedHeadSha256 ||
        canonicalJson(rotation.priorAuthority) !== canonicalJson(checkpointAuthority(checkpoint)))
      fail("pending rotation breaks the retained checkpoint chain");
    pendingRotationSha256 = checkpoint.pendingRotationSha256;
  }
  return {
    valid: true,
    checkpointGeneration: checkpoint.generation,
    rotationSequence: checkpoint.rotationSequence,
    previousRotationSha256: checkpoint.previousRotationSha256,
    pendingRotationSha256,
    ...chain,
    ...anchorAcceptances,
  };
}

export async function auditOperationsStore(root) {
  await requireDirectory(root);
  const checkpoint = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
  return auditOperationsStoreAtCheckpoint(root, checkpoint);
}

async function prepareOperationsAnchorStatementAtRoot(
  root,
  directoryAlreadyPinned = false,
) {
  return withLock(root, "prepare-anchor", async () => {
    const checkpoint = validateCheckpoint(await secureJson(
      join(root, HEAD),
      "operations checkpoint",
    ));
    const chain = await auditRotationChain(root, checkpoint);
    await auditAnchorAcceptanceChain(root, checkpoint);
    return anchorStatement(checkpoint, chain);
  }, { directoryAlreadyPinned });
}

export async function prepareOperationsAnchorStatement(root) {
  return prepareOperationsAnchorStatementAtRoot(root);
}

export function signOperationsAnchorStatement(statementInput, privateKey, keyGeneration) {
  const statement = validateAnchorStatement(statementInput);
  const identity = describeKey(privateKey);
  if (identity.keyId !== statement.authority.keyId ||
      keyGeneration !== statement.authority.keyGeneration)
    fail("anchor signing key does not match the retained operations authority");
  return signEnvelope(
    { role: "operations-checkpoint-anchor", statement },
    privateKey,
    OPERATIONS_ANCHOR_DOMAIN,
    keyGeneration,
  );
}

function verifyAnchorEvidenceForCheckpoint(checkpoint, chain, evidence) {
  const current = anchorStatement(checkpoint, chain);
  const authority = authorityFromRaw(
    current.authority.publicKeyBase64Url,
    current.authority.keyGeneration,
  );
  const payload = verifyEnvelope(
    evidence,
    authority.publicKey,
    OPERATIONS_ANCHOR_DOMAIN,
    authority.keyGeneration,
  );
  exactKeys(payload, ["role", "statement"], "operations anchor evidence payload");
  const statement = validateAnchorStatement(payload.statement);
  if (payload.role !== "operations-checkpoint-anchor" ||
      canonicalJson(statement) !== canonicalJson(current))
    fail("external anchor evidence does not match the current audited checkpoint");
  return { current, evidenceSha256: canonicalSha256(evidence) };
}

export async function verifyOperationsAnchorEvidence(root, evidence) {
  return withLock(root, "verify-anchor", async () => {
    const checkpoint = validateCheckpoint(await secureJson(
      join(root, HEAD),
      "operations checkpoint",
    ));
    const chain = await auditRotationChain(root, checkpoint);
    const { current, evidenceSha256 } = verifyAnchorEvidenceForCheckpoint(
      checkpoint,
      chain,
      evidence,
    );
    return {
      valid: true,
      streamId: current.streamId,
      evidenceSha256,
      checkpointSha256: current.checkpointSha256,
      checkpointGeneration: current.checkpointGeneration,
      rotationSequence: current.rotationSequence,
    };
  });
}

function validateExternalAnchorHead(value, streamId) {
  exactKeys(value, [
    "schemaVersion", "kind", "streamId", "logSequence", "evidenceSha256", "evidence",
  ], "external anchor log head");
  if (value.schemaVersion !== 1 || value.kind !== "operations-anchor-log-head")
    fail("external anchor log head identity is invalid");
  if (value.streamId !== streamId) fail("external anchor log returned the wrong stream");
  if (!Number.isSafeInteger(value.logSequence) || value.logSequence < 1)
    fail("external anchor log sequence is invalid");
  requireHash(value.evidenceSha256, "external anchor evidence hash");
  if (canonicalSha256(value.evidence) !== value.evidenceSha256)
    fail("external anchor log evidence hash does not match");
  return value;
}

function validateExternalAnchorQuery(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "streamId", "checkpointSha256", "checkpointGeneration",
  ], "external anchor log query");
  if (value.schemaVersion !== 1 || value.kind !== "operations-anchor-log-query")
    fail("external anchor log query identity is invalid");
  requireHash(value.streamId, "external anchor query stream ID");
  requireHash(value.checkpointSha256, "external anchor query checkpoint hash");
  if (!Number.isSafeInteger(value.checkpointGeneration) || value.checkpointGeneration < 1)
    fail("external anchor query checkpoint generation is invalid");
  return value;
}

function validateAnchorAcceptance(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "previousAcceptanceSha256", "query", "head",
  ], "external anchor acceptance");
  if (value.schemaVersion !== 1 || value.kind !== "operations-anchor-acceptance")
    fail("external anchor acceptance identity is invalid");
  if (value.previousAcceptanceSha256 !== "genesis")
    requireHash(value.previousAcceptanceSha256, "previous external anchor acceptance hash");
  const query = validateExternalAnchorQuery(value.query);
  const head = validateExternalAnchorHead(value.head, query.streamId);
  const statement = validateAnchorStatement(head.evidence?.payload?.statement);
  const authority = authorityFromRaw(
    statement.authority.publicKeyBase64Url,
    statement.authority.keyGeneration,
  );
  const payload = verifyEnvelope(
    head.evidence,
    authority.publicKey,
    OPERATIONS_ANCHOR_DOMAIN,
    authority.keyGeneration,
  );
  exactKeys(payload, ["role", "statement"], "retained anchor evidence payload");
  if (payload.role !== "operations-checkpoint-anchor" ||
      canonicalJson(payload.statement) !== canonicalJson(statement) ||
      statement.streamId !== query.streamId ||
      statement.checkpointSha256 !== query.checkpointSha256 ||
      statement.checkpointGeneration !== query.checkpointGeneration)
    fail("retained anchor evidence does not bind its exact query");
  return { acceptance: value, query, head, statement };
}

async function auditAnchorAcceptanceChain(
  root, checkpoint, descriptorRelative = false, snapshots = null,
) {
  const acceptances = join(root, ANCHOR_ACCEPTANCES);
  if (descriptorRelative)
    await requireAnchoredPrivateDirectory(acceptances, "anchor acceptance directory");
  else await requireDirectory(acceptances);
  let expectedSha256 = checkpoint.externalAnchorAcceptanceSha256 ?? "genesis";
  let expectedSequence = checkpoint.externalAnchorSequence;
  let expectedStreamId = null;
  for (let remaining = checkpoint.externalAnchorAcceptanceCount; remaining > 0; remaining -= 1) {
    if (expectedSha256 === "genesis" || expectedSequence === null)
      fail("external anchor acceptance chain terminates before its retained count");
    const { acceptance, head } = validateAnchorAcceptance(await auditedHistoryJson(
      join(acceptances, `${expectedSha256}.json`),
      `external anchor acceptance ${remaining}`,
      snapshots,
    ));
    if (canonicalSha256(acceptance) !== expectedSha256)
      fail("external anchor acceptance does not match its retained hash");
    if (remaining === checkpoint.externalAnchorAcceptanceCount
      ? head.logSequence !== expectedSequence
      : head.logSequence >= expectedSequence)
      fail("external anchor acceptance breaks the retained sequence");
    if (expectedStreamId !== null && head.streamId !== expectedStreamId)
      fail("external anchor acceptance changes the retained stream");
    expectedStreamId = head.streamId;
    expectedSha256 = acceptance.previousAcceptanceSha256;
    expectedSequence = head.logSequence;
  }
  if (expectedSha256 !== "genesis")
    fail("external anchor acceptance chain has a non-genesis predecessor at count zero");
  return {
    verifiedAnchorAcceptances: checkpoint.externalAnchorAcceptanceCount,
    externalAnchorStreamId: expectedStreamId,
  };
}

async function requireLatestExternalAnchor(checkpoint, chain, anchorLog) {
  if (!anchorLog || typeof anchorLog !== "object" ||
      typeof anchorLog.readLatestHead !== "function")
    fail("an authenticated external anchor log adapter is required before transport");
  const expected = anchorStatement(checkpoint, chain);
  const query = Object.freeze({
    schemaVersion: 1,
    kind: "operations-anchor-log-query",
    streamId: expected.streamId,
    checkpointSha256: expected.checkpointSha256,
    checkpointGeneration: expected.checkpointGeneration,
  });
  let returned;
  try {
    returned = await anchorLog.readLatestHead(query);
  } catch (error) {
    fail(`external anchor log latest-head query failed: ${error?.message ?? "unknown error"}`);
  }
  const head = validateExternalAnchorHead(returned, expected.streamId);
  if (checkpoint.externalAnchorSequence !== null &&
      head.logSequence <= checkpoint.externalAnchorSequence)
    fail("external anchor log head is stale or rolled back");
  const verified = verifyAnchorEvidenceForCheckpoint(checkpoint, chain, head.evidence);
  if (verified.evidenceSha256 !== head.evidenceSha256)
    fail("external anchor log evidence identity is inconsistent");
  return { head, query };
}

export async function commitOperationsRotation({
  root,
  priorManifest,
  nextManifest,
  rotation: rotationInput,
  priorAuthorization,
  nextAcceptance,
}) {
  validatePreflightManifest(priorManifest);
  validatePreflightManifest(nextManifest);
  const rotation = validateRotationPayload(rotationInput);
  const rotationSha256 = canonicalSha256(rotation);
  return withLock(root, "commit-rotation", async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    await auditRotationChain(root, current);
    await auditAnchorAcceptanceChain(root, current);
    if (current.status !== "rotating" || current.pendingRotationSha256 !== rotationSha256)
      fail("rotation does not match the retained pending transition");
    if (canonicalSha256(priorManifest) !== current.manifestSha256 ||
        current.manifestSha256 !== rotation.priorManifestSha256)
      fail("rotation prior manifest does not match the retained profile");
    if (canonicalSha256(nextManifest) !== rotation.nextManifestSha256)
      fail("rotation next manifest differs from the authorized profile");
    if (rotation.rotationSequence !== current.rotationSequence + 1 ||
        rotation.previousRotationSha256 !== current.previousRotationSha256 ||
        rotation.expectedHeadSha256 !== current.expectedHeadSha256 ||
        canonicalJson(rotation.priorAuthority) !== canonicalJson(checkpointAuthority(current)))
      fail("rotation sequence, chain, head, or prior authority is stale");
    verifyRotationAuthorization(
      priorAuthorization, "prior-authorization", rotation, rotation.priorAuthority,
    );
    verifyRotationAuthorization(
      nextAcceptance, "next-acceptance", rotation, rotation.nextAuthority,
    );
    const record = {
      schemaVersion: 1,
      rotation,
      priorAuthorization,
      nextAcceptance,
    };
    const recordSha256 = canonicalSha256(record);
    const rotations = join(root, ROTATIONS);
    await requireDirectory(rotations);
    await writeDurableRecord(join(rotations, `${recordSha256}.json`), record, 0o400, rotations);
    const next = {
      ...current,
      generation: current.generation + 1,
      status: "ready",
      manifestSha256: rotation.nextManifestSha256,
      authorizationSha256: canonicalSha256(nextAcceptance),
      authorityKeyId: rotation.nextAuthority.keyId,
      authorityKeyGeneration: rotation.nextAuthority.keyGeneration,
      authorityPublicKeyBase64Url: rotation.nextAuthority.publicKeyBase64Url,
      rotationSequence: rotation.rotationSequence,
      previousRotationSha256: recordSha256,
      pendingRotationSha256: null,
    };
    await replaceCheckpoint(root, current, next);
    return { checkpoint: next, rotationRecordSha256: recordSha256 };
  });
}

export async function inspectPendingRotation(root) {
  const checkpoint = await inspectOperationsStore(root);
  if (checkpoint.status !== "rotating") fail("operations store has no pending rotation");
  await requireDirectory(join(root, ROTATIONS));
  const rotation = validateRotationPayload(await secureJson(
    join(root, ROTATIONS, `${checkpoint.pendingRotationSha256}.json`),
    "pending rotation",
  ));
  if (canonicalSha256(rotation) !== checkpoint.pendingRotationSha256)
    fail("pending rotation content does not match the retained hash");
  return { rotationSha256: checkpoint.pendingRotationSha256, rotation };
}

export async function beginTransportRequest(
  root,
  manifestSha256,
  expectedHead,
  requestId,
  anchorLog,
) {
  requireHash(manifestSha256, "manifest hash");
  requireHead(expectedHead);
  requireHash(requestId, "request ID");
  return withLock(root, "begin-request", async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    const chain = await auditRotationChain(root, current);
    await auditAnchorAcceptanceChain(root, current);
    if (current.manifestSha256 !== manifestSha256) fail("runtime configuration differs from the approved preflight manifest");
    if (current.status === "inactive") fail("operations store is inactive; explicit reviewed activation is required");
    if (current.status === "rotating") fail("mTLS profile rotation is pending; requests remain blocked until durable commit");
    if (current.status === "pending") fail("a prior outcome is ambiguous; inspect custody and reconcile, never retry");
    if (current.expectedHeadSha256 !== expectedHead) fail("expected custody head is stale or rolled back");
    if (current.externalAnchorAcceptanceCount === Number.MAX_SAFE_INTEGER)
      fail("external anchor acceptance counter is exhausted");
    const { head: externalHead, query } = await requireLatestExternalAnchor(
      current,
      chain,
      anchorLog,
    );
    await requireUnchangedCheckpoint(root, current, "during external anchor query");
    const acceptance = validateAnchorAcceptance({
      schemaVersion: 1,
      kind: "operations-anchor-acceptance",
      previousAcceptanceSha256: current.externalAnchorAcceptanceSha256 ?? "genesis",
      query,
      head: externalHead,
    }).acceptance;
    const acceptanceSha256 = canonicalSha256(acceptance);
    const acceptances = join(root, ANCHOR_ACCEPTANCES);
    await requireDirectory(acceptances);
    await writeDurableRecord(
      join(acceptances, `${acceptanceSha256}.json`),
      acceptance,
      0o400,
      acceptances,
    );
    const next = {
      ...current,
      generation: current.generation + 1,
      status: "pending",
      pendingRequestId: requestId,
      externalAnchorSequence: externalHead.logSequence,
      externalAnchorAcceptanceCount: current.externalAnchorAcceptanceCount + 1,
      externalAnchorAcceptanceSha256: acceptanceSha256,
    };
    await requireUnchangedCheckpoint(root, current, "before pending transition");
    await replaceCheckpoint(root, current, next);
    return next;
  });
}

export async function commitTransportRequest(root, requestId, receiptSha256) {
  requireHash(requestId, "request ID");
  requireHash(receiptSha256, "receipt hash");
  return withLock(root, "commit-request", async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    if (current.status !== "pending" || current.pendingRequestId !== requestId)
      fail("pending request does not match the confirmed transport response");
    await auditRotationChain(root, current);
    await auditAnchorAcceptanceChain(root, current);
    const next = { ...current, generation: current.generation + 1, status: "ready", expectedHeadSha256: receiptSha256, pendingRequestId: null };
    await replaceCheckpoint(root, current, next);
    return next;
  });
}

export async function reconcileTransportRequest({
  root,
  manifest,
  witnessInput,
  authenticatedRequest,
  expectedHead,
  receipt,
}) {
  const checkpoint = await inspectOperationsStore(root);
  if (canonicalSha256(manifest) !== checkpoint.manifestSha256)
    fail("reconciliation manifest differs from the retained approved manifest");
  const witness = validateWitnessConfig(witnessInput);
  if (manifest?.witnessConfigSha256 !== canonicalSha256(witness))
    fail("reconciliation witness differs from the approved preflight manifest");
  requireHead(expectedHead);
  const requestId = canonicalSha256({
    schemaVersion: 1,
    expectedHeadSha256: expectedHead,
    authenticatedRequest,
  });
  if (checkpoint.status !== "pending" || checkpoint.pendingRequestId !== requestId)
    fail("reconciliation inputs do not match the retained pending request");
  const payload = verifyWitnessReceipt(witness, receipt);
  if (canonicalJson(payload) !== canonicalJson(authenticatedRequest?.payload))
    fail("reconciliation receipt does not authorize the pending request");
  return commitTransportRequest(root, requestId, canonicalSha256(receipt));
}

async function readOperationsLockSnapshot(root) {
  const path = join(root, LOCK);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink < 1 || before.size < 1 || before.size > MAX_JSON)
      fail("operations lock is not a bounded regular file");
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail("operations lock must be owned by the current user");
    if ((before.mode & 0o077) !== 0)
      fail("operations lock must not grant group or other permissions");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const linked = await lstat(path);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== before.nlink || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid ||
        bytes.length !== after.size || !linked.isFile() || linked.isSymbolicLink() ||
        linked.dev !== after.dev || linked.ino !== after.ino || linked.nlink !== after.nlink ||
        linked.mode !== after.mode || linked.uid !== after.uid || linked.gid !== after.gid)
      fail("operations lock changed while it was being reconciled");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail("operations lock is not valid JSON");
    }
    if (`${canonicalJson(value)}\n` !== bytes.toString("utf8"))
      fail("operations lock is not canonical JSON");
    return {
      value: validateOperationsLock(value),
      sha256: canonicalSha256(value),
      linkCount: after.nlink,
    };
  } catch (error) {
    if (error?.code === "ELOOP") fail("operations lock must not be a symlink");
    if (error?.code === "ENOENT") fail("operations store has no lock to reconcile");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readRetainedLockFile(path, field, expectedMode, allowMultipleLinks = false) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_JSON) ||
        (!allowMultipleLinks && before.nlink !== 1n) ||
        (allowMultipleLinks && before.nlink < 1n))
      fail(`${field} is not a bounded regular file with the approved link state`);
    if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      fail(`${field} must be owned by the current user`);
    const expectedModes = Array.isArray(expectedMode) ? expectedMode : [expectedMode];
    if (!expectedModes.some((mode) => (before.mode & 0o777n) === BigInt(mode)))
      fail(`${field} mode is not the release protocol mode`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    const stable = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
      .every((name) => before[name] === after[name] && after[name] === linked[name]);
    if (!stable || !after.isFile() || linked.isSymbolicLink() ||
        bytes.length !== Number(after.size))
      fail(`${field} changed while it was being inspected`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail(`${field} is not valid JSON`);
    }
    if (`${canonicalJson(value)}\n` !== bytes.toString("utf8"))
      fail(`${field} is not canonical JSON`);
    validateOperationsLock(value);
    return { bytes, value, sha256: canonicalSha256(value), metadata: after };
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readCanonicalCheckpointSnapshot(path, field) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n ||
        before.size > BigInt(MAX_JSON) || (before.mode & 0o777n) !== 0o400n ||
        (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())))
      fail(`${field} identity or permissions are invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    if (!sameIntegralMetadata(before, after) || !sameIntegralMetadata(after, linked) ||
        !linked.isFile() || linked.isSymbolicLink() || bytes.length !== Number(after.size))
      fail(`${field} changed while it was being inspected`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail(`${field} is not valid JSON`);
    }
    if (`${canonicalJson(value)}\n` !== bytes.toString("utf8"))
      fail(`${field} is not canonical JSON`);
    return { bytes, value, metadata: after, sha256: canonicalSha256(value) };
  } finally {
    await handle?.close();
  }
}

async function revalidateHistorySnapshots(snapshots) {
  for (const retained of snapshots) {
    const closing = await readCanonicalCheckpointSnapshot(
      retained.path, `${retained.field} after audit`,
    );
    if (!retained.bytes.equals(closing.bytes) ||
        !sameIntegralMetadata(retained.metadata, closing.metadata))
      fail(`${retained.field} changed during retained evidence audit`);
  }
}

function requireRetainedEvidenceNames(cleanupDirectory, retainedName) {
  if (typeof cleanupDirectory !== "string" || !LOCK_CLEANUP_DIRECTORY.test(cleanupDirectory))
    fail("cleanup directory name is invalid");
  if (typeof retainedName !== "string" || !LOCK_RETAINED_NAME.test(retainedName))
    fail("retained lock name is invalid");
}

const INTEGRAL_METADATA = [
  "dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs",
];

function sameIntegralMetadata(left, right) {
  return INTEGRAL_METADATA.every((name) => left?.[name] === right?.[name]);
}

async function openPinnedDirectory(path, field, exactMode = null) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
        !sameIntegralMetadata(opened, linked) ||
        (exactMode !== null && (opened.mode & 0o777n) !== BigInt(exactMode)) ||
        (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid())))
      fail(`${field} identity or permissions are invalid`);
    return {
      handle,
      path,
      anchoredPath: process.platform === "linux"
        ? join("/proc/self/fd", String(handle.fd))
        : path,
      metadata: opened,
    };
  } catch (error) {
    await handle?.close();
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  }
}

async function requirePinnedDirectory(directory, field) {
  const opened = await directory.handle.stat({ bigint: true });
  const linked = await lstat(directory.path, { bigint: true });
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !sameIntegralMetadata(directory.metadata, opened) ||
      !sameIntegralMetadata(opened, linked))
    fail(`${field} changed while retained evidence was being inspected`);
}

async function requirePinnedDirectoryIdentity(directory, field) {
  const opened = await directory.handle.stat({ bigint: true });
  const linked = await lstat(directory.path, { bigint: true });
  // Directory link count can legitimately change when lock cleanup retains a
  // private subdirectory. Device/inode and access identity must not.
  const identity = ["dev", "ino", "mode", "uid", "gid"];
  if (!opened.isDirectory() || !linked.isDirectory() || linked.isSymbolicLink() ||
      !sameIntegralMetadata(opened, linked) ||
      !identity.every((name) => directory.metadata[name] === opened[name]))
    fail(`${field} identity changed while the output was being prepared`);
}

async function readCleanupDirectory(rootDirectory, cleanupDirectory) {
  const directory = await openPinnedDirectory(
    join(rootDirectory.anchoredPath, cleanupDirectory), "cleanup directory", 0o700,
  );
  try {
    const entries = (await readdir(directory.anchoredPath)).sort();
    await requirePinnedDirectory(directory, "cleanup directory");
    return { ...directory, entries };
  } catch (error) {
    await directory.handle.close();
    throw error;
  }
}

async function readOptionalActiveEvidence(rootPath) {
  const path = join(rootPath, LOCK);
  try {
    return await readRetainedLockFile(
      path, "active operations lock evidence", [0o400, 0o600], true,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function collectRetainedOperationsLockEvidence({
  root,
  cleanupDirectory,
  retainedName,
}) {
  requireRetainedEvidenceNames(cleanupDirectory, retainedName);
  if (process.platform !== "linux")
    fail("retained evidence inspection requires descriptor-relative filesystem access");
  await requireDirectory(root);
  const rootDirectory = await openPinnedDirectory(root, "operations store");
  let cleanup;
  try {
    cleanup = await readCleanupDirectory(rootDirectory, cleanupDirectory);
    await requirePinnedDirectory(rootDirectory, "operations store");
    if (!cleanup.entries.includes(retainedName))
      fail("retained lock is not present in the named cleanup directory");
    const tombstone = await readRetainedLockFile(
      join(cleanup.anchoredPath, retainedName),
      "retained operations lock tombstone", 0o600, true,
    );
    await requirePinnedDirectory(cleanup, "cleanup directory");
    await requirePinnedDirectory(rootDirectory, "operations store");
    const recoveryName = `.operations.lock.recovery.${hashBytes(tombstone.bytes)}.json`;
    const recovery = await readRetainedLockFile(
      join(rootDirectory.anchoredPath, recoveryName),
      "content-addressed operations lock recovery", 0o400, true,
    );
    await requirePinnedDirectory(cleanup, "cleanup directory");
    await requirePinnedDirectory(rootDirectory, "operations store");
    const active = await readOptionalActiveEvidence(rootDirectory.anchoredPath);
    await requirePinnedDirectory(cleanup, "cleanup directory");
    await requirePinnedDirectory(rootDirectory, "operations store");
    const closingEntries = (await readdir(cleanup.anchoredPath)).sort();
    if (canonicalJson(closingEntries) !== canonicalJson(cleanup.entries))
      fail("cleanup directory membership changed while evidence was being inspected");
    await requirePinnedDirectory(cleanup, "cleanup directory");
    await requirePinnedDirectory(rootDirectory, "operations store");
    const publicEvidence = {
      schemaVersion: 1,
      kind: "operations-lock-retained-evidence-inspection",
      cleanupDirectory,
      retainedName,
      cleanupEntries: cleanup.entries,
      lock: tombstone.value,
      lockSha256: tombstone.sha256,
      lockBytesSha256: hashBytes(tombstone.bytes),
      tombstoneLinkCount: Number(tombstone.metadata.nlink),
      recoveryName,
      recoverySha256: recovery.sha256,
      recoveryLinkCount: Number(recovery.metadata.nlink),
      recoveryMatchesTombstone: recovery.bytes.equals(tombstone.bytes),
      activeLockSha256: active?.sha256 ?? null,
      activeLockLinkCount: active ? Number(active.metadata.nlink) : null,
      activeLockMode: active ? Number(active.metadata.mode & 0o777n) : null,
      activeMatchesTombstone: active ? active.bytes.equals(tombstone.bytes) : null,
      activeSharesTombstoneInode: active
        ? active.metadata.dev === tombstone.metadata.dev && active.metadata.ino === tombstone.metadata.ino
        : null,
      activeSharesRecoveryInode: active
        ? active.metadata.dev === recovery.metadata.dev && active.metadata.ino === recovery.metadata.ino
        : null,
      reconciled: false,
      filesRemoved: false,
    };
    return {
      publicEvidence,
      snapshot: {
        root: rootDirectory.metadata,
        cleanup: cleanup.metadata,
        tombstone: tombstone.metadata,
        recovery: recovery.metadata,
        active: active?.metadata ?? null,
      },
    };
  } finally {
    await cleanup?.handle.close();
    await rootDirectory.handle.close();
  }
}

export async function inspectRetainedOperationsLockEvidence(input) {
  return (await collectRetainedOperationsLockEvidence(input)).publicEvidence;
}

function sameEvidenceSnapshots(left, right) {
  return ["root", "cleanup", "tombstone", "recovery", "active"].every((name) =>
    left[name] === null || right[name] === null
      ? left[name] === right[name]
      : sameIntegralMetadata(left[name], right[name]));
}

export async function reconcileRetainedOperationsLockEvidence({
  root,
  cleanupDirectory,
  retainedName,
  expectedLockSha256,
  expectedStartingCheckpointSha256,
  expectedCompletedCheckpointSha256,
  expectedActiveLockState,
  expectedStoreMetadata = null,
}) {
  requireHash(expectedLockSha256, "externally approved retained lock hash");
  requireHash(expectedStartingCheckpointSha256, "externally approved starting checkpoint hash");
  requireHash(expectedCompletedCheckpointSha256, "externally approved completed checkpoint hash");
  if (expectedStartingCheckpointSha256 === expectedCompletedCheckpointSha256)
    fail("starting and completed checkpoint hashes must differ");
  const activeStates = new Set([
    "absent", "tombstone-alias", "recovery-alias", "independent-copy",
  ]);
  if (!activeStates.has(expectedActiveLockState))
    fail("externally approved active lock state is invalid");

  const firstCollected = await collectRetainedOperationsLockEvidence({
    root, cleanupDirectory, retainedName,
  });
  const first = firstCollected.publicEvidence;
  if (expectedStoreMetadata &&
      !sameIntegralMetadata(expectedStoreMetadata, firstCollected.snapshot.root))
    fail("operations store differs from the output-separation snapshot");
  if (first.cleanupEntries.length !== 1 || first.cleanupEntries[0] !== retainedName)
    fail("cleanup directory contains unapproved additional evidence");
  if (first.lockSha256 !== expectedLockSha256 ||
      first.recoverySha256 !== expectedLockSha256 || !first.recoveryMatchesTombstone)
    fail("retained lock evidence does not match the externally approved hash");
  if (first.lock.startingCheckpointSha256 !== expectedStartingCheckpointSha256)
    fail("retained lock does not bind the externally approved starting checkpoint");
  if (expectedActiveLockState === "absent" && first.activeLockSha256 !== null)
    fail("active lock state differs from the externally approved absent state");
  if (expectedActiveLockState !== "absent" &&
      (first.activeLockSha256 !== expectedLockSha256 || !first.activeMatchesTombstone))
    fail("active lock content does not match the approved retained lock");
  if (expectedActiveLockState === "tombstone-alias" &&
      (!first.activeSharesTombstoneInode || first.activeSharesRecoveryInode))
    fail("active lock is not the approved tombstone alias");
  if (expectedActiveLockState === "recovery-alias" &&
      (!first.activeSharesRecoveryInode || first.activeSharesTombstoneInode))
    fail("active lock is not the approved recovery alias");
  if (expectedActiveLockState === "independent-copy" &&
      (first.activeSharesTombstoneInode || first.activeSharesRecoveryInode))
    fail("active lock is not the approved independent copy");
  const exactLinkCounts = expectedActiveLockState === "absent"
    ? first.tombstoneLinkCount === 1 && first.recoveryLinkCount === 1
    : expectedActiveLockState === "tombstone-alias"
      ? first.tombstoneLinkCount === 2 && first.recoveryLinkCount === 1 &&
        first.activeLockLinkCount === 2 && first.activeLockMode === 0o600
      : expectedActiveLockState === "recovery-alias"
        ? first.tombstoneLinkCount === 1 && first.recoveryLinkCount === 2 &&
          first.activeLockLinkCount === 2 && first.activeLockMode === 0o400
        : first.tombstoneLinkCount === 1 && first.recoveryLinkCount === 1 &&
          first.activeLockLinkCount === 1 && first.activeLockMode === 0o600;
  if (!exactLinkCounts)
    fail("retained lock evidence has unapproved additional aliases");

  const auditRoot = await openPinnedDirectory(root, "operations store during audit");
  let checkpointSha256;
  let outcome;
  let audit;
  let closingCollected;
  try {
    if (!sameIntegralMetadata(firstCollected.snapshot.root, auditRoot.metadata))
      fail("operations store changed before retained evidence audit");
    const checkpoint = await readCanonicalCheckpointSnapshot(
      join(auditRoot.anchoredPath, HEAD), "retained evidence checkpoint",
    );
    checkpointSha256 = checkpoint.sha256;
    outcome = checkpointSha256 === expectedStartingCheckpointSha256
      ? "not-committed"
      : checkpointSha256 === expectedCompletedCheckpointSha256 ? "committed" : null;
    if (!outcome) fail("checkpoint matches neither externally approved outcome");
    const historySnapshots = [];
    if (checkpoint.value?.schemaVersion === 4) {
      validateCheckpoint(checkpoint.value);
      audit = await auditOperationsStoreAtCheckpoint(
        auditRoot.anchoredPath, checkpoint.value, true, historySnapshots,
      );
    } else if (checkpoint.value?.schemaVersion === 3) {
      audit = await auditRotationChain(
        auditRoot.anchoredPath, validateV3Checkpoint(checkpoint.value), true,
        historySnapshots,
      );
    } else fail("reconciliation checkpoint schema is unsupported");
    await revalidateHistorySnapshots(historySnapshots);
    const closingCheckpoint = await readCanonicalCheckpointSnapshot(
      join(auditRoot.anchoredPath, HEAD), "retained evidence checkpoint after audit",
    );
    if (closingCheckpoint.sha256 !== checkpointSha256 ||
        !checkpoint.bytes.equals(closingCheckpoint.bytes) ||
        !sameIntegralMetadata(checkpoint.metadata, closingCheckpoint.metadata))
      fail("checkpoint changed during retained evidence audit");
    await requirePinnedDirectory(auditRoot, "operations store during audit");
    closingCollected = await collectRetainedOperationsLockEvidence({
      root, cleanupDirectory, retainedName,
    });
  } finally {
    await auditRoot.handle.close();
  }
  const closing = closingCollected.publicEvidence;
  if (canonicalJson(closing) !== canonicalJson(first) ||
      !sameEvidenceSnapshots(firstCollected.snapshot, closingCollected.snapshot))
    fail("checkpoint or retained lock evidence changed during reconciliation");
  return {
    schemaVersion: 1,
    kind: "operations-lock-retained-evidence-reconciliation-receipt",
    cleanupDirectory,
    retainedName,
    recoveryName: first.recoveryName,
    operation: first.lock.operation,
    lockSha256: first.lockSha256,
    startingCheckpointSha256: expectedStartingCheckpointSha256,
    observedCheckpointSha256: checkpointSha256,
    completedCheckpointSha256: expectedCompletedCheckpointSha256,
    activeLockState: expectedActiveLockState,
    outcome,
    audit,
    filesRemoved: false,
    retryAuthorized: false,
  };
}

export async function prepareRetainedOperationsLockCleanupPlan({
  root,
  reconciliationReceipt,
  expectedReconciliationReceiptSha256,
  expectedStoreMetadata = null,
}) {
  requireHash(
    expectedReconciliationReceiptSha256,
    "externally approved retained evidence reconciliation receipt hash",
  );
  // Serialize the untrusted caller value exactly once, then use only the
  // resulting plain-data clone. In particular, accessors and Proxy traps must
  // not be able to return one value for the approved hash and another value
  // after an asynchronous reconciliation boundary.
  const receiptCanonical = canonicalJson(reconciliationReceipt);
  const receipt = JSON.parse(receiptCanonical);
  exactKeys(receipt, [
    "schemaVersion", "kind", "cleanupDirectory", "retainedName", "recoveryName",
    "operation", "lockSha256", "startingCheckpointSha256",
    "observedCheckpointSha256", "completedCheckpointSha256", "activeLockState",
    "outcome", "audit", "filesRemoved", "retryAuthorized",
  ], "retained evidence reconciliation receipt");
  if (hashBytes(Buffer.from(receiptCanonical, "utf8")) !==
      expectedReconciliationReceiptSha256)
    fail("retained evidence reconciliation receipt does not match the externally approved hash");
  if (receipt.schemaVersion !== 1 ||
      receipt.kind !==
        "operations-lock-retained-evidence-reconciliation-receipt" ||
      receipt.filesRemoved !== false ||
      receipt.retryAuthorized !== false)
    fail("retained evidence reconciliation receipt identity is invalid");
  if (receipt.activeLockState !== "absent")
    fail("cleanup planning requires an externally reconciled absent active lock");

  // A hash-pinned receipt still is not trusted as a description of current
  // local state. Re-run its full reconciliation and require byte-for-byte
  // equivalent canonical output before producing a non-executable plan.
  const currentReceipt = await reconcileRetainedOperationsLockEvidence({
    root,
    cleanupDirectory: receipt.cleanupDirectory,
    retainedName: receipt.retainedName,
    expectedLockSha256: receipt.lockSha256,
    expectedStartingCheckpointSha256:
      receipt.startingCheckpointSha256,
    expectedCompletedCheckpointSha256:
      receipt.completedCheckpointSha256,
    expectedActiveLockState: "absent",
    expectedStoreMetadata,
  });
  if (canonicalJson(currentReceipt) !== receiptCanonical)
    fail("current retained evidence does not reproduce the approved reconciliation receipt");

  return {
    schemaVersion: 1,
    kind: "operations-lock-retained-evidence-cleanup-plan",
    reconciliationReceiptSha256: expectedReconciliationReceiptSha256,
    cleanupDirectory: currentReceipt.cleanupDirectory,
    retainedName: currentReceipt.retainedName,
    recoveryName: currentReceipt.recoveryName,
    operation: currentReceipt.operation,
    lockSha256: currentReceipt.lockSha256,
    startingCheckpointSha256: currentReceipt.startingCheckpointSha256,
    observedCheckpointSha256: currentReceipt.observedCheckpointSha256,
    completedCheckpointSha256: currentReceipt.completedCheckpointSha256,
    outcome: currentReceipt.outcome,
    requiredActiveLockState: "absent",
    deletionAuthorized: false,
    executionSupported: false,
    filesRemoved: false,
    retryAuthorized: false,
  };
}

export async function reconcileOperationsLock({
  root,
  expectedLockSha256,
  expectedStartingCheckpointSha256,
  expectedCompletedCheckpointSha256,
}) {
  requireHash(expectedLockSha256, "externally approved operations lock hash");
  requireHash(
    expectedStartingCheckpointSha256,
    "externally approved starting checkpoint hash",
  );
  requireHash(
    expectedCompletedCheckpointSha256,
    "externally approved completed checkpoint hash",
  );
  if (expectedStartingCheckpointSha256 === expectedCompletedCheckpointSha256)
    fail("starting and completed checkpoint hashes must differ");
  await requireDirectory(root);

  const lock = await readOperationsLockSnapshot(root);
  if (lock.sha256 !== expectedLockSha256)
    fail("operations lock does not match the externally approved hash");
  if (lock.value.startingCheckpointSha256 !== expectedStartingCheckpointSha256)
    fail("operations lock does not bind the externally approved starting checkpoint");

  const checkpoint = await secureJson(join(root, HEAD), "reconciliation checkpoint");
  const checkpointSha256 = canonicalSha256(checkpoint);
  let outcome;
  if (checkpointSha256 === expectedStartingCheckpointSha256) outcome = "not-committed";
  else if (checkpointSha256 === expectedCompletedCheckpointSha256) outcome = "committed";
  else fail("checkpoint matches neither externally approved outcome");

  let audit;
  if (checkpoint?.schemaVersion === 4) {
    validateCheckpoint(checkpoint);
    audit = await auditOperationsStore(root);
  } else if (checkpoint?.schemaVersion === 3) {
    const source = validateV3Checkpoint(checkpoint);
    audit = await auditRotationChain(root, source);
  } else {
    fail("reconciliation checkpoint schema is unsupported");
  }

  const closingCheckpoint = await secureJson(
    join(root, HEAD),
    "reconciliation checkpoint after audit",
  );
  const closingLock = await readOperationsLockSnapshot(root);
  if (canonicalSha256(closingCheckpoint) !== checkpointSha256 ||
      closingLock.sha256 !== lock.sha256 || closingLock.linkCount !== lock.linkCount ||
      canonicalJson(closingLock.value) !== canonicalJson(lock.value))
    fail("lock or checkpoint changed during reconciliation");

  return {
    schemaVersion: 1,
    kind: "operations-lock-reconciliation-receipt",
    operation: lock.value.operation,
    lockSha256: lock.sha256,
    lockLinkCount: lock.linkCount,
    startingCheckpointSha256: expectedStartingCheckpointSha256,
    observedCheckpointSha256: checkpointSha256,
    completedCheckpointSha256: expectedCompletedCheckpointSha256,
    outcome,
    audit,
    lockRemoved: false,
  };
}

export async function inspectOperationsStore(root) {
  await requireDirectory(root);
  const checkpoint = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
  const lockPresent = await lstat(join(root, LOCK)).then(() => true, (e) => e?.code === "ENOENT" ? false : Promise.reject(e));
  return { ...checkpoint, lockPresent };
}

function parse(args, names) {
  if (args.length !== names.length * 2) fail("arguments are incomplete or duplicated");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!names.includes(args[i]) || Object.hasOwn(values, args[i])) fail("unexpected or duplicated argument");
    values[args[i]] = args[i + 1];
  }
  if (names.some((name) => !values[name])) fail("argument is missing");
  return values;
}

async function reserveOutputOutsideOperationsStore(root, output) {
  if (process.platform !== "linux")
    fail("safe reconciliation output requires descriptor-relative filesystem access");
  const resolvedRoot = resolve(root);
  const store = await realpath(root);
  if (store !== resolvedRoot)
    fail("operations store path must not traverse symlinks");
  const resolvedOutput = resolve(output);
  const parentPath = await realpath(dirname(resolvedOutput));
  const outputPath = join(parentPath, basename(resolvedOutput));
  const storeToOutput = relative(store, outputPath);
  const outputToStore = relative(outputPath, store);
  const nested = (value) => value === "" ||
    (value.split(sep)[0] !== ".." && !isAbsolute(value));
  if (nested(storeToOutput) || nested(outputToStore))
    fail("reconciliation output must be outside the operations store and evidence tree");
  const storeDirectory = await openPinnedDirectory(
    store, "output-separation operations store", 0o700,
  );
  let parentDirectory;
  let handle;
  try {
    parentDirectory = await openPinnedDirectory(parentPath, "reconciliation output parent");
    const anchoredOutput = join(parentDirectory.anchoredPath, basename(resolvedOutput));
    handle = await open(
      anchoredOutput,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o444);
    await handle.sync();
    await parentDirectory.handle.sync();
    await requirePinnedDirectory(storeDirectory, "output-separation operations store");
    const parentAfter = await parentDirectory.handle.stat({ bigint: true });
    const parentLinked = await lstat(parentDirectory.path, { bigint: true });
    if (!parentAfter.isDirectory() || !parentLinked.isDirectory() ||
        parentLinked.isSymbolicLink() || !sameIntegralMetadata(parentAfter, parentLinked) ||
        !["dev", "ino", "mode", "uid", "gid", "nlink"]
          .every((name) => parentDirectory.metadata[name] === parentAfter[name]))
      fail("reconciliation output parent changed during name reservation");
    parentDirectory.metadata = parentAfter;
    const outputMetadata = await handle.stat({ bigint: true });
    const outputLinked = await lstat(anchoredOutput, { bigint: true });
    if (!outputMetadata.isFile() || outputMetadata.nlink !== 1n ||
        (outputMetadata.mode & 0o777n) !== 0o444n || outputMetadata.size !== 0n ||
        !sameIntegralMetadata(outputMetadata, outputLinked) ||
        outputLinked.isSymbolicLink() ||
        (typeof process.getuid === "function" &&
          outputMetadata.uid !== BigInt(process.getuid())))
      fail("reserved operations output identity is unsafe");
    return {
      handle, parentDirectory, storeDirectory, anchoredOutput, outputMetadata,
    };
  } catch (error) {
    await handle?.close();
    await parentDirectory?.handle.close();
    await storeDirectory.handle.close();
    throw error;
  }
}

async function writeReservedOperationsOutput(
  reservation,
  value,
  { storeMayHaveChanged = false } = {},
) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  await requirePinnedDirectory(
    reservation.parentDirectory, "operations output parent before publication",
  );
  if (storeMayHaveChanged) {
    await requirePinnedDirectoryIdentity(
      reservation.storeDirectory,
      "output-separation operations store before publication",
    );
  } else {
    await requirePinnedDirectory(
      reservation.storeDirectory,
      "output-separation operations store before publication",
    );
  }
  const reservedOpened = await reservation.handle.stat({ bigint: true });
  const reservedLinked = await lstat(reservation.anchoredOutput, { bigint: true });
  if (!sameIntegralMetadata(reservation.outputMetadata, reservedOpened) ||
      !sameIntegralMetadata(reservedOpened, reservedLinked) ||
      !reservedOpened.isFile() || reservedLinked.isSymbolicLink() ||
      reservedOpened.size !== 0n || reservedOpened.nlink !== 1n ||
      (reservedOpened.mode & 0o777n) !== 0o444n)
    fail("reserved operations output changed before publication");
  await reservation.handle.writeFile(bytes);
  await reservation.handle.sync();
  await requireExactReservedOutput(
    reservation, bytes, "reserved operations output changed while it was being published",
  );
  await requirePinnedDirectory(
    reservation.parentDirectory, "operations output parent",
  );
  if (storeMayHaveChanged) {
    await requirePinnedDirectoryIdentity(
      reservation.storeDirectory, "output-separation operations store",
    );
  } else {
    await requirePinnedDirectory(
      reservation.storeDirectory, "output-separation operations store",
    );
  }
  await reservation.parentDirectory.handle.sync();
  await requireExactReservedOutput(
    reservation, bytes,
    "reserved operations output changed after parent synchronization",
  );
  await requirePinnedDirectory(
    reservation.parentDirectory, "operations output parent after synchronization",
  );
  if (storeMayHaveChanged) {
    await requirePinnedDirectoryIdentity(
      reservation.storeDirectory,
      "output-separation operations store after synchronization",
    );
  } else {
    await requirePinnedDirectory(
      reservation.storeDirectory,
      "output-separation operations store after synchronization",
    );
  }
}

async function requireExactReservedOutput(reservation, bytes, message) {
  const opened = await reservation.handle.stat({ bigint: true });
  const observed = Buffer.alloc(bytes.length + 1);
  let observedLength = 0;
  while (observedLength < observed.length) {
    const { bytesRead } = await reservation.handle.read(
      observed, observedLength, observed.length - observedLength, observedLength,
    );
    if (bytesRead === 0) break;
    observedLength += bytesRead;
  }
  const afterRead = await reservation.handle.stat({ bigint: true });
  const linked = await lstat(reservation.anchoredOutput, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o777n) !== 0o444n ||
      opened.size !== BigInt(bytes.length) || !sameIntegralMetadata(opened, linked) ||
      !sameIntegralMetadata(opened, afterRead) || linked.isSymbolicLink() ||
      observedLength !== bytes.length || !observed.subarray(0, observedLength).equals(bytes) ||
      (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid())))
    fail(message);
}

async function closeReservedOperationsOutput(reservation) {
  await reservation.handle.close();
  await reservation.parentDirectory.handle.close();
  await reservation.storeDirectory.handle.close();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "preflight") {
    const v = parse(args, ["--config", "--witness-config", "--output"]);
    const manifest = await buildClientPreflight(await readJson(v["--config"], MAX_JSON), await readJson(v["--witness-config"], MAX_JSON));
    await writeNewJson(v["--output"], manifest, 0o444);
    console.log(canonicalJson({ manifestSha256: canonicalSha256(manifest), active: false }));
    return;
  }
  if (command === "init") {
    const v = parse(args, ["--store", "--manifest", "--expected-manifest-sha256", "--initial-head-sha256"]);
    const result = await initializeOperationsStore(v["--store"], await securePublicJson(v["--manifest"], "preflight manifest"), v["--expected-manifest-sha256"], v["--initial-head-sha256"]);
    console.log(canonicalJson(result)); return;
  }
  if (command === "migrate-v3-to-v4") {
    const v = parse(args, [
      "--source-store", "--destination-store", "--expected-v3-checkpoint-sha256",
    ]);
    const result = await migrateOperationsStoreV3ToV4({
      sourceRoot: v["--source-store"],
      destinationRoot: v["--destination-store"],
      expectedV3CheckpointSha256: v["--expected-v3-checkpoint-sha256"],
    });
    console.log(canonicalJson(result));
    return;
  }
  if (command === "verify-v3-to-v4") {
    const v = parse(args, [
      "--source-store", "--destination-store", "--expected-v3-checkpoint-sha256",
      "--expected-v4-checkpoint-sha256", "--expected-migration-record-sha256",
      "--output",
    ]);
    const receipt = await verifyOperationsStoreV3ToV4Migration({
      sourceRoot: v["--source-store"],
      destinationRoot: v["--destination-store"],
      expectedV3CheckpointSha256: v["--expected-v3-checkpoint-sha256"],
      expectedV4CheckpointSha256: v["--expected-v4-checkpoint-sha256"],
      expectedMigrationRecordSha256: v["--expected-migration-record-sha256"],
    });
    await writeNewJson(v["--output"], receipt, 0o444);
    console.log(canonicalJson({
      verificationReceiptSha256: canonicalSha256(receipt),
      active: false,
    }));
    return;
  }
  if (command === "activate") {
    const v = parse(args, ["--store", "--authorization", "--expected-authorization-sha256"]);
    const result = await activateOperationsStore(v["--store"], await secureJson(v["--authorization"], "activation authorization"), v["--expected-authorization-sha256"]);
    console.log(canonicalJson(result)); return;
  }
  if (command === "prepare-rotation") {
    const v = parse(args, [
      "--store", "--prior-manifest", "--next-manifest",
      "--expected-next-manifest-sha256", "--next-authority-public-key",
      "--next-authority-key-generation",
    ]);
    const publicKey = await readPublicKey(v["--next-authority-public-key"]);
    const identity = describeKey(publicKey);
    const result = await prepareOperationsRotation({
      root: v["--store"],
      priorManifest: await securePublicJson(v["--prior-manifest"], "prior preflight manifest"),
      nextManifest: await securePublicJson(v["--next-manifest"], "next preflight manifest"),
      expectedNextManifestSha256: v["--expected-next-manifest-sha256"],
      nextAuthority: {
        keyId: identity.keyId,
        keyGeneration: Number(v["--next-authority-key-generation"]),
        publicKeyBase64Url: identity.publicKeyBase64Url,
      },
    });
    console.log(canonicalJson({
      rotationSha256: result.rotationSha256,
      rotationPath: join(resolve(v["--store"]), ROTATIONS, `${result.rotationSha256}.json`),
      requestsBlocked: true,
    }));
    return;
  }
  if (command === "authorize-rotation") {
    const v = parse(args, [
      "--rotation", "--role", "--private-key", "--key-generation", "--output",
    ]);
    const envelope = authorizeOperationsRotation(
      await secureJson(v["--rotation"], "mTLS profile rotation"),
      v["--role"],
      await readPrivateKey(v["--private-key"]),
      Number(v["--key-generation"]),
    );
    await writeNewJson(v["--output"], envelope, 0o444);
    console.log(canonicalJson({ authorizationSha256: canonicalSha256(envelope) }));
    return;
  }
  if (command === "commit-rotation") {
    const v = parse(args, [
      "--store", "--prior-manifest", "--next-manifest", "--rotation",
      "--prior-authorization", "--next-acceptance",
    ]);
    const result = await commitOperationsRotation({
      root: v["--store"],
      priorManifest: await securePublicJson(v["--prior-manifest"], "prior preflight manifest"),
      nextManifest: await securePublicJson(v["--next-manifest"], "next preflight manifest"),
      rotation: await secureJson(v["--rotation"], "mTLS profile rotation"),
      priorAuthorization: await securePublicJson(v["--prior-authorization"], "prior rotation authorization"),
      nextAcceptance: await securePublicJson(v["--next-acceptance"], "next rotation acceptance"),
    });
    console.log(canonicalJson(result));
    return;
  }
  if (command === "inspect") {
    const v = parse(args, ["--store"]);
    console.log(canonicalJson(await inspectOperationsStore(v["--store"]))); return;
  }
  if (command === "reconcile-lock") {
    const v = parse(args, [
      "--store", "--expected-lock-sha256",
      "--expected-starting-checkpoint-sha256",
      "--expected-completed-checkpoint-sha256", "--output",
    ]);
    const reservation = await reserveOutputOutsideOperationsStore(
      v["--store"], v["--output"],
    );
    let receipt;
    try {
      receipt = await reconcileOperationsLock({
        root: v["--store"],
        expectedLockSha256: v["--expected-lock-sha256"],
        expectedStartingCheckpointSha256:
          v["--expected-starting-checkpoint-sha256"],
        expectedCompletedCheckpointSha256:
          v["--expected-completed-checkpoint-sha256"],
      });
      await writeReservedOperationsOutput(reservation, receipt);
    } finally {
      await closeReservedOperationsOutput(reservation);
    }
    console.log(canonicalJson({
      reconciliationReceiptSha256: canonicalSha256(receipt),
      outcome: receipt.outcome,
      lockRemoved: false,
    }));
    return;
  }
  if (command === "inspect-lock-evidence") {
    const v = parse(args, ["--store", "--cleanup-directory", "--retained-name"]);
    console.log(canonicalJson(await inspectRetainedOperationsLockEvidence({
      root: v["--store"],
      cleanupDirectory: v["--cleanup-directory"],
      retainedName: v["--retained-name"],
    })));
    return;
  }
  if (command === "reconcile-lock-evidence") {
    const v = parse(args, [
      "--store", "--cleanup-directory", "--retained-name",
      "--expected-lock-sha256", "--expected-starting-checkpoint-sha256",
      "--expected-completed-checkpoint-sha256", "--expected-active-lock-state",
      "--output",
    ]);
    const reservation = await reserveOutputOutsideOperationsStore(
      v["--store"], v["--output"],
    );
    let receipt;
    try {
      receipt = await reconcileRetainedOperationsLockEvidence({
        root: v["--store"],
        cleanupDirectory: v["--cleanup-directory"],
        retainedName: v["--retained-name"],
        expectedLockSha256: v["--expected-lock-sha256"],
        expectedStartingCheckpointSha256: v["--expected-starting-checkpoint-sha256"],
        expectedCompletedCheckpointSha256: v["--expected-completed-checkpoint-sha256"],
        expectedActiveLockState: v["--expected-active-lock-state"],
        expectedStoreMetadata: reservation.storeDirectory.metadata,
      });
      await writeReservedOperationsOutput(reservation, receipt);
    } finally {
      await closeReservedOperationsOutput(reservation);
    }
    console.log(canonicalJson({
      reconciliationReceiptSha256: canonicalSha256(receipt),
      outcome: receipt.outcome,
      filesRemoved: false,
      retryAuthorized: false,
    }));
    return;
  }
  if (command === "prepare-lock-evidence-cleanup") {
    const v = parse(args, [
      "--store", "--reconciliation-receipt",
      "--expected-reconciliation-receipt-sha256", "--output",
    ]);
    const reservation = await reserveOutputOutsideOperationsStore(
      v["--store"], v["--output"],
    );
    let plan;
    try {
      plan = await prepareRetainedOperationsLockCleanupPlan({
        root: v["--store"],
        reconciliationReceipt: await securePublicJson(
          v["--reconciliation-receipt"], "retained evidence reconciliation receipt",
        ),
        expectedReconciliationReceiptSha256:
          v["--expected-reconciliation-receipt-sha256"],
        expectedStoreMetadata: reservation.storeDirectory.metadata,
      });
      await writeReservedOperationsOutput(reservation, plan);
    } finally {
      await closeReservedOperationsOutput(reservation);
    }
    console.log(canonicalJson({
      cleanupPlanSha256: canonicalSha256(plan),
      deletionAuthorized: false,
      executionSupported: false,
      filesRemoved: false,
      retryAuthorized: false,
    }));
    return;
  }
  if (command === "inspect-rotation") {
    const v = parse(args, ["--store"]);
    console.log(canonicalJson(await inspectPendingRotation(v["--store"]))); return;
  }
  if (command === "audit") {
    const v = parse(args, ["--store"]);
    console.log(canonicalJson(await auditOperationsStore(v["--store"]))); return;
  }
  if (command === "prepare-anchor") {
    const v = parse(args, ["--store", "--output"]);
    const reservation = await reserveOutputOutsideOperationsStore(
      v["--store"], v["--output"],
    );
    let statement;
    try {
      statement = await prepareOperationsAnchorStatementAtRoot(
        reservation.storeDirectory.anchoredPath,
        true,
      );
      await writeReservedOperationsOutput(reservation, statement, {
        storeMayHaveChanged: true,
      });
    } finally {
      await closeReservedOperationsOutput(reservation);
    }
    console.log(canonicalJson({
      streamId: statement.streamId,
      checkpointSha256: statement.checkpointSha256,
      checkpointGeneration: statement.checkpointGeneration,
      active: false,
    }));
    return;
  }
  if (command === "sign-anchor") {
    const v = parse(args, [
      "--statement", "--private-key", "--key-generation", "--output",
    ]);
    const evidence = signOperationsAnchorStatement(
      await securePublicJson(v["--statement"], "operations anchor statement"),
      await readPrivateKey(v["--private-key"]),
      Number(v["--key-generation"]),
    );
    await writeNewJson(v["--output"], evidence, 0o444);
    console.log(canonicalJson({ evidenceSha256: canonicalSha256(evidence) }));
    return;
  }
  if (command === "verify-anchor") {
    const v = parse(args, ["--store", "--evidence"]);
    console.log(canonicalJson(await verifyOperationsAnchorEvidence(
      v["--store"],
      await securePublicJson(v["--evidence"], "external anchor evidence"),
    )));
    return;
  }
  if (command === "reconcile") {
    const v = parse(args, ["--store", "--manifest", "--witness-config", "--authenticated-request", "--expected-head-sha256", "--receipt"]);
    const result = await reconcileTransportRequest({
      root: v["--store"],
      manifest: await securePublicJson(v["--manifest"], "preflight manifest"),
      witnessInput: await securePublicJson(v["--witness-config"], "witness config"),
      authenticatedRequest: await securePublicJson(v["--authenticated-request"], "authenticated request"),
      expectedHead: v["--expected-head-sha256"],
      receipt: await securePublicJson(v["--receipt"], "witness receipt"),
    });
    console.log(canonicalJson(result)); return;
  }
  fail("expected preflight, init, migrate-v3-to-v4, verify-v3-to-v4, activate, prepare-rotation, authorize-rotation, commit-rotation, inspect, reconcile-lock, inspect-lock-evidence, reconcile-lock-evidence, prepare-lock-evidence-cleanup, inspect-rotation, audit, prepare-anchor, sign-anchor, verify-anchor, or reconcile");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
