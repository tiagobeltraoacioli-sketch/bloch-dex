#!/usr/bin/env node
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail(`${field} must be owned by the current user`);
    if (privateFile && (before.mode & 0o077) !== 0)
      fail(`${field} must not grant group or other permissions`);
    if (!privateFile && (before.mode & 0o022) !== 0)
      fail(`${field} must not be writable by group or other users`);
    if (before.size < 1 || before.size > MAX_JSON) fail(`${field} size is invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== 1 || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid ||
        bytes.length !== after.size)
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
  if ((await realpath(root)) !== resolve(root)) fail("operations store path must not traverse symlinks");
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
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function replaceCheckpoint(root, next) {
  const target = join(root, HEAD);
  const temporary = join(root, `.${basename(HEAD)}.${process.pid}.${Date.now()}.tmp`);
  await writeNewJson(temporary, next, 0o400);
  await rename(temporary, target);
  await syncDirectory(root);
}

async function writeDurableRecord(path, value, mode, parent) {
  try {
    await writeNewJson(path, value, mode);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (canonicalJson(await secureJson(path, "existing rotation record")) !== canonicalJson(value))
      fail("rotation record path is occupied by different content");
  }
  await syncDirectory(parent);
}

async function withLock(root, operation) {
  await requireDirectory(root);
  const path = join(root, LOCK);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail("operations store is locked; inspect before recovery");
    throw error;
  }
  try {
    await handle.sync();
    await syncDirectory(root);
    return await operation();
  } finally {
    await handle.close();
    await unlink(path).catch(() => {});
    await syncDirectory(root);
  }
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
  await writeNewJson(join(root, HEAD), checkpoint, 0o400);
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
  return withLock(root, async () => {
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
    await replaceCheckpoint(root, next);
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
  return withLock(root, async () => {
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
    await replaceCheckpoint(root, next);
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

async function auditRotationChain(root, checkpoint) {
  const rotations = join(root, ROTATIONS);
  await requireDirectory(rotations);
  let expectedRecordSha256 = checkpoint.previousRotationSha256;
  let expectedSequence = checkpoint.rotationSequence;
  let expectedManifestSha256 = checkpoint.manifestSha256;
  let expectedAuthority = checkpointAuthority(checkpoint);
  let verifiedRecords = 0;
  while (expectedSequence > 0) {
    if (expectedRecordSha256 === "genesis")
      fail("rotation chain terminates before its retained sequence");
    const { record, rotation } = validateRotationRecord(await secureJson(
      join(rotations, `${expectedRecordSha256}.json`),
      `rotation record ${expectedSequence}`,
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
  return withLock(sourceRoot, async () => {
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
      await writeNewJson(join(rotations, `${artifact.sha256}.json`), artifact.value, 0o400);
    if (artifacts.pending &&
        !artifacts.records.some(({ sha256 }) => sha256 === artifacts.pending.sha256))
      await writeNewJson(
        join(rotations, `${artifacts.pending.sha256}.json`),
        artifacts.pending.value,
        0o400,
      );
    await syncDirectory(rotations);
    await syncDirectory(acceptances);
    await writeNewJson(join(destinationRoot, V3_MIGRATION_RECORD), migration, 0o400);
    await syncDirectory(destinationRoot);
    if (canonicalSha256(validateV3Checkpoint(await secureJson(
      join(sourceRoot, HEAD),
      "schema-3 operations checkpoint after copy",
    ))) !== expectedV3CheckpointSha256)
      fail("schema-3 checkpoint changed during migration");
    await writeNewJson(join(destinationRoot, HEAD), nextCheckpoint, 0o400);
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

async function requireUnlocked(root, field) {
  const lockPresent = await lstat(join(root, LOCK)).then(
    () => true,
    (error) => error?.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (lockPresent) fail(`${field} is locked; offline migration verification requires quiescence`);
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
  await requireDirectory(sourceRoot);
  await requireDirectory(destinationRoot);
  await requireUnlocked(sourceRoot, "schema-3 source store");
  await requireUnlocked(destinationRoot, "schema-4 destination store");

  const sourceCheckpoint = validateV3Checkpoint(await secureJson(
    join(sourceRoot, HEAD),
    "schema-3 source checkpoint",
  ));
  if (canonicalSha256(sourceCheckpoint) !== expectedV3CheckpointSha256)
    fail("schema-3 source checkpoint does not match the externally approved hash");
  if (sourceCheckpoint.externalAnchorSequence !== null)
    fail("schema-3 source has unretained external anchor acceptance history");
  const sourceChain = await auditRotationChain(sourceRoot, sourceCheckpoint);
  const sourceArtifacts = await collectRotationArtifacts(sourceRoot, sourceCheckpoint);

  const destinationCheckpoint = validateCheckpoint(await secureJson(
    join(destinationRoot, HEAD),
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
    join(destinationRoot, V3_MIGRATION_RECORD),
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

  const destinationAudit = await auditOperationsStore(destinationRoot);
  if (destinationAudit.verifiedRecords !== sourceChain.verifiedRecords ||
      destinationAudit.verifiedAnchorAcceptances !== 0)
    fail("schema-4 destination audit does not match the migrated source history");

  const closingSourceCheckpoint = validateV3Checkpoint(await secureJson(
    join(sourceRoot, HEAD),
    "schema-3 source checkpoint after verification",
  ));
  const closingDestinationCheckpoint = validateCheckpoint(await secureJson(
    join(destinationRoot, HEAD),
    "schema-4 destination checkpoint after verification",
  ));
  const closingMigration = validateV3MigrationRecord(await secureJson(
    join(destinationRoot, V3_MIGRATION_RECORD),
    "schema-3 migration record after verification",
  ));
  if (canonicalSha256(closingSourceCheckpoint) !== expectedV3CheckpointSha256 ||
      canonicalSha256(closingDestinationCheckpoint) !== expectedV4CheckpointSha256 ||
      canonicalSha256(closingMigration) !== expectedMigrationRecordSha256)
    fail("migration state changed during offline verification");
  const closingSourceChain = await auditRotationChain(sourceRoot, closingSourceCheckpoint);
  const closingSourceArtifacts = await collectRotationArtifacts(
    sourceRoot,
    closingSourceCheckpoint,
  );
  const closingDestinationAudit = await auditOperationsStore(destinationRoot);
  if (canonicalJson(closingSourceChain) !== canonicalJson(sourceChain) ||
      canonicalJson(closingSourceArtifacts) !== canonicalJson(sourceArtifacts) ||
      canonicalJson(closingDestinationAudit) !== canonicalJson(destinationAudit))
    fail("migration history changed during offline verification");
  await requireUnlocked(sourceRoot, "schema-3 source store");
  await requireUnlocked(destinationRoot, "schema-4 destination store");

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
}

export async function auditOperationsStore(root) {
  await requireDirectory(root);
  const checkpoint = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
  const chain = await auditRotationChain(root, checkpoint);
  const anchorAcceptances = await auditAnchorAcceptanceChain(root, checkpoint);
  let pendingRotationSha256 = null;
  if (checkpoint.status === "rotating") {
    const rotation = validateRotationPayload(await secureJson(
      join(root, ROTATIONS, `${checkpoint.pendingRotationSha256}.json`),
      "pending rotation",
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

export async function prepareOperationsAnchorStatement(root) {
  return withLock(root, async () => {
    const checkpoint = validateCheckpoint(await secureJson(
      join(root, HEAD),
      "operations checkpoint",
    ));
    const chain = await auditRotationChain(root, checkpoint);
    await auditAnchorAcceptanceChain(root, checkpoint);
    return anchorStatement(checkpoint, chain);
  });
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
  return withLock(root, async () => {
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

async function auditAnchorAcceptanceChain(root, checkpoint) {
  const acceptances = join(root, ANCHOR_ACCEPTANCES);
  await requireDirectory(acceptances);
  let expectedSha256 = checkpoint.externalAnchorAcceptanceSha256 ?? "genesis";
  let expectedSequence = checkpoint.externalAnchorSequence;
  let expectedStreamId = null;
  for (let remaining = checkpoint.externalAnchorAcceptanceCount; remaining > 0; remaining -= 1) {
    if (expectedSha256 === "genesis" || expectedSequence === null)
      fail("external anchor acceptance chain terminates before its retained count");
    const { acceptance, head } = validateAnchorAcceptance(await secureJson(
      join(acceptances, `${expectedSha256}.json`),
      `external anchor acceptance ${remaining}`,
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
  return withLock(root, async () => {
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
    await replaceCheckpoint(root, next);
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
  return withLock(root, async () => {
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
    await replaceCheckpoint(root, next);
    return next;
  });
}

export async function commitTransportRequest(root, requestId, receiptSha256) {
  requireHash(requestId, "request ID");
  requireHash(receiptSha256, "receipt hash");
  return withLock(root, async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    if (current.status !== "pending" || current.pendingRequestId !== requestId)
      fail("pending request does not match the confirmed transport response");
    const next = { ...current, generation: current.generation + 1, status: "ready", expectedHeadSha256: receiptSha256, pendingRequestId: null };
    await replaceCheckpoint(root, next);
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
    const statement = await prepareOperationsAnchorStatement(v["--store"]);
    await writeNewJson(v["--output"], statement, 0o444);
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
  fail("expected preflight, init, migrate-v3-to-v4, verify-v3-to-v4, activate, prepare-rotation, authorize-rotation, commit-rotation, inspect, inspect-rotation, audit, prepare-anchor, sign-anchor, verify-anchor, or reconcile");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
