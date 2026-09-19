#!/usr/bin/env node
import { createPublicKey, randomBytes } from "node:crypto";
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
import { basename, dirname, join, resolve } from "node:path";
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
import {
  QUORUM_WITNESS_DOMAIN,
  validateWitnessConfig,
  validateWitnessPayload,
  verifyWitnessReceipt,
} from "./publication-quorum-witness.mjs";

export const CUSTODY_REQUEST_DOMAIN =
  "POSTERN_PUBLICATION_QUORUM_CUSTODY_REQUEST_V1\n";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const B64_KEY = /^[A-Za-z0-9_-]{43}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const STATE = "head.json";
const LOCK = ".custody.lock";
const PENDING = ".pending.json";
const RECEIPTS = "receipts";
const MAX_CONFIG = 64_000;
const MAX_STATE = 8_192;
const MAX_ENVELOPE = 64_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(message) {
  throw new Error(`publication quorum custody: ${message}`);
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
    fail("client public key encoding is invalid");
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== value)
    fail("client public key encoding is invalid");
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("client public key is invalid");
  }
}

export function validateCustodyConfig(config) {
  exactKeys(
    config,
    ["schemaVersion", "custodyId", "witness", "authorizedClient"],
    "custody config",
  );
  if (
    config.schemaVersion !== 1 ||
    typeof config.custodyId !== "string" ||
    !ID.test(config.custodyId)
  )
    fail("custody config identity is invalid");
  const witness = validateWitnessConfig(config.witness);
  exactKeys(
    config.authorizedClient,
    ["clientId", "keyId", "keyGeneration", "publicKeyBase64Url"],
    "authorized client",
  );
  const client = config.authorizedClient;
  if (
    typeof client.clientId !== "string" ||
    !ID.test(client.clientId) ||
    !Number.isSafeInteger(client.keyGeneration) ||
    client.keyGeneration < 1
  )
    fail("authorized client identity is invalid");
  const identity = describeKey(rawPublicKey(client.publicKeyBase64Url));
  if (identity.keyId !== client.keyId)
    fail("authorized client key ID does not match its public key");
  if (client.keyId === witness.keyId)
    fail("custody client and witness keys must be independent");
  return config;
}

function validateState(state, config) {
  exactKeys(
    state,
    [
      "schemaVersion",
      "custodyConfigSha256",
      "witnessSequence",
      "receiptSha256",
      "checkpointSha256",
    ],
    "custody head",
  );
  if (
    state.schemaVersion !== 1 ||
    state.custodyConfigSha256 !== canonicalSha256(config) ||
    !Number.isSafeInteger(state.witnessSequence) ||
    state.witnessSequence < 0 ||
    (state.witnessSequence === 0
      ? state.receiptSha256 !== null
      : !HEX.test(state.receiptSha256)) ||
    !HEX.test(state.checkpointSha256)
  )
    fail("custody head is invalid or belongs to another configuration");
  return state;
}

async function validateRetainedReceipt(root, state, config) {
  if (state.receiptSha256 === null) return null;
  let receipt;
  try {
    receipt = await secureRead(
      join(root, RECEIPTS, `${state.receiptSha256}.json`),
      MAX_ENVELOPE,
      "retained witness receipt",
    );
  } catch (error) {
    if (error?.code === "ENOENT")
      fail("retained witness receipt is missing; inspect before recovery");
    throw error;
  }
  const payload = verifyWitnessReceipt(config.witness, receipt);
  if (
    canonicalSha256(receipt) !== state.receiptSha256 ||
    payload.witnessSequence !== state.witnessSequence ||
    payload.nextCheckpointSha256 !== state.checkpointSha256
  )
    fail("retained witness receipt does not match the custody head");
  return receipt;
}

function parse(command, args, names) {
  if (args.length !== names.length * 2)
    fail("arguments are incomplete or duplicated");
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!names.includes(args[index]) || Object.hasOwn(values, args[index]))
      fail(`unexpected ${command} argument`);
    values[args[index]] = args[index + 1];
  }
  if (names.some((name) => !values[name])) fail(`missing ${command} argument`);
  return values;
}

function requireHash(value, field) {
  if (!HEX.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

async function requireSecureDirectory(path, field) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink())
    fail(`${field} must be a real directory`);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    fail(`${field} must be owned by the current user`);
  if ((metadata.mode & 0o077) !== 0)
    fail(`${field} must not grant group or other permissions`);
  if ((await realpath(path)) !== resolve(path))
    fail(`${field} path must not traverse symlinks`);
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function secureRead(path, maximum, field) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail(`${field} must be owned by the current user`);
    if ((before.mode & 0o077) !== 0)
      fail(`${field} must not grant group or other permissions`);
    if (before.size < 2 || before.size > maximum)
      fail(`${field} size is invalid`);
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      Buffer.byteLength(text) !== after.size
    )
      fail(`${field} changed while it was being read`);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail(`${field} is not valid JSON`);
    }
    if (`${canonicalJson(value)}\n` !== text)
      fail(`${field} is not canonical JSON`);
    return value;
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(path, value, maximum, field) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  if (bytes.length > maximum) fail(`${field} exceeds its size limit`);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    )
      fail(`${field} failed its ownership, link, or type checks`);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
    const committed = await handle.stat();
    if (
      !committed.isFile() ||
      committed.nlink !== 1 ||
      (committed.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && committed.uid !== process.getuid())
    )
      fail(`${field} changed while it was being written`);
    return {
      dev: committed.dev,
      ino: committed.ino,
      uid: committed.uid,
      mode: committed.mode,
    };
  } finally {
    await handle?.close();
  }
}

function sameIdentity(metadata, identity) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino &&
    metadata.uid === identity.uid &&
    metadata.mode === identity.mode
  );
}

async function atomicReplace(path, value, maximum) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let renamed = false;
  let identity = null;
  try {
    identity = await writeExclusive(
      temporary,
      value,
      maximum,
      "temporary custody head",
    );
    const beforeRename = await lstat(temporary);
    if (!sameIdentity(beforeRename, identity))
      fail("temporary custody head identity changed; preserve it and inspect");
    await rename(temporary, path);
    renamed = true;
    const installed = await lstat(path);
    if (!sameIdentity(installed, identity))
      fail("installed custody head identity is ambiguous; inspect before recovery");
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed && identity) {
      const current = await lstat(temporary).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (current) {
        if (!sameIdentity(current, identity))
          fail("temporary custody head was replaced; preserve it and inspect");
        await unlink(temporary);
      }
    }
  }
}

async function openStore(value) {
  const root = resolve(value);
  await requireSecureDirectory(root, "custody store");
  await requireSecureDirectory(join(root, RECEIPTS), "receipt directory");
  return root;
}

async function acquireLock(root) {
  const path = join(root, LOCK);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${canonicalJson({ schemaVersion: 1, pid: process.pid })}\n`);
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    )
      fail("new lock is unsafe; preserve state and inspect");
    await syncDirectory(root);
    return { handle, path, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await handle?.close();
    if (error?.code === "EEXIST") fail("custody lock already exists; inspect first");
    throw error;
  }
}

async function releaseLock(root, lock) {
  const opened = await lock.handle.stat();
  const linked = await lstat(lock.path).catch(() => null);
  if (
    !linked ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.dev !== lock.dev ||
    opened.ino !== lock.ino ||
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    linked.nlink !== 1 ||
    linked.dev !== lock.dev ||
    linked.ino !== lock.ino ||
    (linked.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && linked.uid !== process.getuid())
  )
    fail("custody lock identity changed; preserve state and inspect");
  await unlink(lock.path);
  const unlinked = await lock.handle.stat();
  if (unlinked.nlink !== 0 || unlinked.dev !== lock.dev || unlinked.ino !== lock.ino)
    fail("custody lock unlink outcome is ambiguous; preserve state and inspect");
  await lock.handle.close();
  await syncDirectory(root);
}

function verifyAuthenticatedRequest(config, envelope) {
  const client = config.authorizedClient;
  const payload = validateWitnessPayload(
    verifyEnvelope(
      envelope,
      rawPublicKey(client.publicKeyBase64Url),
      CUSTODY_REQUEST_DOMAIN,
      client.keyGeneration,
    ),
  );
  if (
    payload.storeId !== config.witness.storeId ||
    payload.witnessId !== config.witness.witnessId
  )
    fail("authenticated request targets another witness store");
  return payload;
}

async function initialize(rootValue, config, initialCheckpoint) {
  const root = resolve(rootValue);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(join(root, RECEIPTS), { mode: 0o700 });
  await chmod(join(root, RECEIPTS), 0o700);
  await requireSecureDirectory(root, "custody store");
  await requireSecureDirectory(join(root, RECEIPTS), "receipt directory");
  const state = {
    schemaVersion: 1,
    custodyConfigSha256: canonicalSha256(config),
    witnessSequence: 0,
    receiptSha256: null,
    checkpointSha256: initialCheckpoint,
  };
  await writeExclusive(join(root, STATE), state, MAX_STATE, "custody head");
  await syncDirectory(join(root, RECEIPTS));
  await syncDirectory(root);
  return state;
}

async function authorize(root, config, witnessPrivateKey, request, expectedHead) {
  const lock = await acquireLock(root);
  let pendingWritten = false;
  let commitConfirmed = false;
  try {
    try {
      await lstat(join(root, PENDING));
      fail("pending custody transaction exists; inspect before recovery");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const state = validateState(
      await secureRead(join(root, STATE), MAX_STATE, "custody head"),
      config,
    );
    await validateRetainedReceipt(root, state, config);
    if (
      expectedHead === "genesis"
        ? state.receiptSha256 !== null
        : state.receiptSha256 !== expectedHead
    )
      fail(`custody head CAS mismatch; retained head is ${state.receiptSha256 ?? "genesis"}`);
    if (
      request.witnessSequence !== state.witnessSequence + 1 ||
      request.previousWitnessReceiptSha256 !== state.receiptSha256 ||
      request.priorCheckpointSha256 !== state.checkpointSha256
    )
      fail("request does not directly extend the retained custody head");

    const receipt = signEnvelope(
      request,
      witnessPrivateKey,
      QUORUM_WITNESS_DOMAIN,
      config.witness.keyGeneration,
    );
    const receiptSha256 = canonicalSha256(receipt);
    const nextState = {
      ...state,
      witnessSequence: request.witnessSequence,
      receiptSha256,
      checkpointSha256: request.nextCheckpointSha256,
    };
    const intent = {
      schemaVersion: 1,
      priorReceiptSha256: state.receiptSha256,
      nextReceiptSha256: receiptSha256,
      priorCheckpointSha256: state.checkpointSha256,
      nextCheckpointSha256: nextState.checkpointSha256,
    };
    await writeExclusive(join(root, PENDING), intent, MAX_STATE, "custody intent");
    await syncDirectory(root);
    pendingWritten = true;
    await writeExclusive(
      join(root, RECEIPTS, `${receiptSha256}.json`),
      receipt,
      MAX_ENVELOPE,
      "witness receipt",
    );
    await syncDirectory(join(root, RECEIPTS));
    const beforeCommit = validateState(
      await secureRead(join(root, STATE), MAX_STATE, "custody head"),
      config,
    );
    if (canonicalJson(beforeCommit) !== canonicalJson(state))
      fail("custody head changed during authorization; inspect before recovery");
    await atomicReplace(join(root, STATE), nextState, MAX_STATE);
    const committed = validateState(
      await secureRead(join(root, STATE), MAX_STATE, "custody head"),
      config,
    );
    if (canonicalJson(committed) !== canonicalJson(nextState))
      fail("custody head readback failed; outcome is ambiguous");
    commitConfirmed = true;
    await unlink(join(root, PENDING));
    await syncDirectory(root);
    pendingWritten = false;
    await releaseLock(root, lock);
    return { receipt, receiptSha256, state: nextState };
  } catch (error) {
    if (!pendingWritten && !commitConfirmed) {
      try {
        await releaseLock(root, lock);
      } catch (lockError) {
        error.message = `${error.message}; ${lockError.message}`;
        await lock.handle.close().catch(() => {});
      }
    } else {
      await lock.handle.close().catch(() => {});
    }
    if (pendingWritten)
      error.message = `${error.message}; durable custody intent exists, do not retry blindly`;
    if (commitConfirmed)
      error.message = `${error.message}; custody commit was confirmed, inspect lock state`;
    throw error;
  }
}

export async function authorizeCustodyRequest({
  store,
  config: configInput,
  witnessPrivateKey,
  authenticatedRequest,
  expectedHead,
}) {
  const root = await openStore(store);
  const config = validateCustodyConfig(configInput);
  if (expectedHead !== "genesis") requireHash(expectedHead, "expected head hash");
  if (describeKey(witnessPrivateKey).keyId !== config.witness.keyId)
    fail("witness private key does not match custody config");
  const request = verifyAuthenticatedRequest(config, authenticatedRequest);
  return authorize(root, config, witnessPrivateKey, request, expectedHead);
}

function usage() {
  console.error(`Usage:
  node scripts/publication-quorum-witness-custody.mjs init --store <new-directory> --config <custody.json> --initial-checkpoint-sha256 <sha256>
  node scripts/publication-quorum-witness-custody.mjs authenticate --config <custody.json> --client-private-key <ed25519-private.pem> --request <prepared-request.json> --output <authenticated-request.json>
  node scripts/publication-quorum-witness-custody.mjs authorize --store <directory> --config <custody.json> --witness-private-key <ed25519-private.pem> --authenticated-request <envelope.json> --expected-head-sha256 <genesis-or-sha256> --output <receipt.json>
  node scripts/publication-quorum-witness-custody.mjs inspect --store <directory> --config <custody.json>
  node scripts/publication-quorum-witness-custody.mjs export --store <directory> --config <custody.json> --receipt-sha256 <sha256> --output <receipt.json>`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    const values = parse(command, args, [
      "--store", "--config", "--initial-checkpoint-sha256",
    ]);
    const config = validateCustodyConfig(await readJson(values["--config"], MAX_CONFIG));
    const state = await initialize(
      values["--store"],
      config,
      requireHash(values["--initial-checkpoint-sha256"], "initial checkpoint hash"),
    );
    console.log(canonicalJson({ initialized: true, head: state }));
    return;
  }
  if (command === "authenticate") {
    const values = parse(command, args, [
      "--config", "--client-private-key", "--request", "--output",
    ]);
    const config = validateCustodyConfig(await readJson(values["--config"], MAX_CONFIG));
    const request = validateWitnessPayload(await readJson(values["--request"], MAX_ENVELOPE));
    if (
      request.storeId !== config.witness.storeId ||
      request.witnessId !== config.witness.witnessId
    )
      fail("request targets another witness store");
    const key = await readPrivateKey(values["--client-private-key"]);
    if (describeKey(key).keyId !== config.authorizedClient.keyId)
      fail("client private key does not match custody config");
    await writeNewJson(
      values["--output"],
      signEnvelope(
        request,
        key,
        CUSTODY_REQUEST_DOMAIN,
        config.authorizedClient.keyGeneration,
      ),
      0o444,
    );
    return;
  }
  if (command === "authorize") {
    const values = parse(command, args, [
      "--store", "--config", "--witness-private-key",
      "--authenticated-request", "--expected-head-sha256", "--output",
    ]);
    const config = validateCustodyConfig(await readJson(values["--config"], MAX_CONFIG));
    const expectedHead = values["--expected-head-sha256"];
    if (expectedHead !== "genesis") requireHash(expectedHead, "expected head hash");
    try {
      await lstat(values["--output"]);
      fail("receipt output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const result = await authorizeCustodyRequest({
      store: values["--store"],
      config,
      witnessPrivateKey: await readPrivateKey(values["--witness-private-key"]),
      authenticatedRequest: await readJson(
        values["--authenticated-request"],
        MAX_ENVELOPE,
      ),
      expectedHead,
    });
    try {
      await writeNewJson(values["--output"], result.receipt, 0o444);
    } catch (error) {
      error.message = `${error.message}; custody head advanced to ${result.receiptSha256}, export the durable receipt instead of retrying`;
      throw error;
    }
    console.log(canonicalJson({
      authorized: true,
      receiptSha256: result.receiptSha256,
      checkpointSha256: result.state.checkpointSha256,
      witnessSequence: result.state.witnessSequence,
    }));
    return;
  }
  if (command === "inspect") {
    const values = parse(command, args, ["--store", "--config"]);
    const root = await openStore(values["--store"]);
    const config = validateCustodyConfig(await readJson(values["--config"], MAX_CONFIG));
    const state = validateState(
      await secureRead(join(root, STATE), MAX_STATE, "custody head"),
      config,
    );
    await validateRetainedReceipt(root, state, config);
    const lock = await lstat(join(root, LOCK)).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    let pending = null;
    try {
      pending = await secureRead(join(root, PENDING), MAX_STATE, "custody intent");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    console.log(canonicalJson({
      schemaVersion: 1,
      head: state,
      lockPresent: lock,
      pending,
      recoveryRequired: lock || pending !== null,
    }));
    return;
  }
  if (command === "export") {
    const values = parse(command, args, [
      "--store", "--config", "--receipt-sha256", "--output",
    ]);
    const root = await openStore(values["--store"]);
    const config = validateCustodyConfig(await readJson(values["--config"], MAX_CONFIG));
    const state = validateState(
      await secureRead(join(root, STATE), MAX_STATE, "custody head"),
      config,
    );
    await validateRetainedReceipt(root, state, config);
    const hash = requireHash(values["--receipt-sha256"], "receipt hash");
    const receipt = await secureRead(
      join(root, RECEIPTS, `${hash}.json`),
      MAX_ENVELOPE,
      "witness receipt",
    );
    if (canonicalSha256(receipt) !== hash)
      fail("stored receipt does not match its content address");
    await writeNewJson(values["--output"], receipt, 0o444);
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
