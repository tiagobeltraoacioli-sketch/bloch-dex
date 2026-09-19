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
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  canonicalSha256,
  readJson,
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
const MAX_JSON = 64_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(message) {
  throw new Error(`publication quorum transport operations: ${message}`);
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
    serverCertificateSha256: config.serverCertificateSha256,
    serverCaFileSha256: hashBytes(caBytes),
    clientCertificateSha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    witnessConfigSha256: canonicalSha256(witness),
  };
}

function requireHash(value, field) {
  if (typeof value !== "string" || !HEX.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function requireHead(value) {
  if (value !== "genesis") requireHash(value, "expected custody head");
  return value;
}

function validateCheckpoint(value) {
  exactKeys(value, [
    "schemaVersion", "manifestSha256", "generation", "status",
    "expectedHeadSha256", "pendingRequestId", "authorizationSha256",
  ], "operations checkpoint");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0)
    fail("operations checkpoint version or generation is invalid");
  requireHash(value.manifestSha256, "manifest hash");
  requireHead(value.expectedHeadSha256);
  if (!["inactive", "ready", "pending"].includes(value.status)) fail("operations checkpoint status is invalid");
  if ((value.status === "pending") !== (typeof value.pendingRequestId === "string" && HEX.test(value.pendingRequestId)))
    fail("operations checkpoint pending request is invalid");
  if (value.status === "inactive" ? value.authorizationSha256 !== null : !HEX.test(value.authorizationSha256))
    fail("operations checkpoint authorization is invalid");
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

async function withLock(root, operation) {
  await requireDirectory(root);
  const path = join(root, LOCK);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    await handle.sync();
    await syncDirectory(root);
    return await operation();
  } catch (error) {
    if (error?.code === "EEXIST") fail("operations store is locked; inspect before recovery");
    throw error;
  } finally {
    await handle?.close();
    if (handle) {
      await unlink(path).catch(() => {});
      await syncDirectory(root);
    }
  }
}

export async function initializeOperationsStore(root, manifest, expectedManifestSha256, initialHead) {
  requireHash(expectedManifestSha256, "externally approved manifest hash");
  if (canonicalSha256(manifest) !== expectedManifestSha256)
    fail("preflight manifest does not match the externally approved hash; refusing TOFU");
  requireHead(initialHead);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await requireDirectory(root);
  const checkpoint = {
    schemaVersion: 1,
    manifestSha256: expectedManifestSha256,
    generation: 0,
    status: "inactive",
    expectedHeadSha256: initialHead,
    pendingRequestId: null,
    authorizationSha256: null,
  };
  await writeNewJson(join(root, HEAD), checkpoint, 0o400);
  await syncDirectory(root);
  return checkpoint;
}

export async function activateOperationsStore(root, authorization, expectedAuthorizationSha256) {
  requireHash(expectedAuthorizationSha256, "externally approved authorization hash");
  if (canonicalSha256(authorization) !== expectedAuthorizationSha256)
    fail("activation authorization does not match the externally approved hash");
  exactKeys(authorization, ["schemaVersion", "authorizationId", "manifestSha256", "expectedHeadSha256", "enabled"], "activation authorization");
  if (authorization.schemaVersion !== 1 || authorization.enabled !== true || !ID.test(authorization.authorizationId))
    fail("activation authorization is invalid");
  return withLock(root, async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    if (current.status !== "inactive" || current.generation !== 0) fail("operations store is already activated or advanced");
    if (authorization.manifestSha256 !== current.manifestSha256 || authorization.expectedHeadSha256 !== current.expectedHeadSha256)
      fail("activation authorization does not bind the retained checkpoint");
    const next = { ...current, generation: 1, status: "ready", authorizationSha256: expectedAuthorizationSha256 };
    await replaceCheckpoint(root, next);
    return next;
  });
}

export async function beginTransportRequest(root, manifestSha256, expectedHead, requestId) {
  requireHash(manifestSha256, "manifest hash");
  requireHead(expectedHead);
  requireHash(requestId, "request ID");
  return withLock(root, async () => {
    const current = validateCheckpoint(await secureJson(join(root, HEAD), "operations checkpoint"));
    if (current.manifestSha256 !== manifestSha256) fail("runtime configuration differs from the approved preflight manifest");
    if (current.status === "inactive") fail("operations store is inactive; explicit reviewed activation is required");
    if (current.status === "pending") fail("a prior outcome is ambiguous; inspect custody and reconcile, never retry");
    if (current.expectedHeadSha256 !== expectedHead) fail("expected custody head is stale or rolled back");
    const next = { ...current, generation: current.generation + 1, status: "pending", pendingRequestId: requestId };
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
  if (command === "activate") {
    const v = parse(args, ["--store", "--authorization", "--expected-authorization-sha256"]);
    const result = await activateOperationsStore(v["--store"], await secureJson(v["--authorization"], "activation authorization"), v["--expected-authorization-sha256"]);
    console.log(canonicalJson(result)); return;
  }
  if (command === "inspect") {
    const v = parse(args, ["--store"]);
    console.log(canonicalJson(await inspectOperationsStore(v["--store"]))); return;
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
  fail("expected preflight, init, activate, inspect, or reconcile");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
