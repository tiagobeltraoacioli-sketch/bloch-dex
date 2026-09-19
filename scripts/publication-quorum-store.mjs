#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
  readJson,
  writeNewJson,
} from "./live-auth/envelope.mjs";
import {
  validateAuditorConfig,
  validateQuorumCheckpoint,
  verifyQuorumConfigRotation,
  verifyQuorumPublication,
} from "./publication-quorum.mjs";
import {
  nextWitnessPayload,
  validateWitnessConfig,
  witnessTransition,
} from "./publication-quorum-witness.mjs";

const CHECKPOINT = "checkpoint.json";
const LOCK = ".quorum.lock";
const PENDING = ".pending.json";
const RECORDS = "records";
const WITNESS_POLICY = "witness-policy.json";
const HEX = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT = 4_096;
const MAX_RECORD = 1_048_576;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(message) {
  throw new Error(`publication quorum store: ${message}`);
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

function requireHash(value, field) {
  if (!HEX.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

async function readPriorWitness(value) {
  return value === "genesis" ? null : await readJson(value, 64_000);
}

function requireExpectedWitnessHead(value, priorReceipt) {
  if (value === "genesis") {
    if (priorReceipt !== null)
      fail("external witness head says genesis but a prior receipt was supplied");
    return;
  }
  const expected = requireHash(value, "expected witness receipt hash");
  if (priorReceipt === null || canonicalSha256(priorReceipt) !== expected)
    fail("prior witness receipt does not match the externally retained head");
}

function requireIndependentWitness(configs, witnessConfig, checkpoint) {
  const forbidden = new Set([
    checkpoint.publicationKeyId,
    ...configs.flatMap((config) => config.auditors.map((auditor) => auditor.keyId)),
  ]);
  if (forbidden.has(witnessConfig.keyId))
    fail("external witness key must be independent from publication and auditor keys");
}

function witnessPolicy(config) {
  return {
    schemaVersion: 1,
    mode: "external-witness-required",
    witnessConfigSha256: canonicalSha256(config),
    storeId: config.storeId,
    witnessId: config.witnessId,
    keyId: config.keyId,
    keyGeneration: config.keyGeneration,
  };
}

async function requireWitnessPolicy(root, config) {
  const policy = await secureRead(
    join(root, WITNESS_POLICY),
    MAX_CHECKPOINT,
    "witness policy",
  ).catch((error) => {
    if (error?.code === "ENOENT")
      fail("store is not bound to an external witness policy");
    throw error;
  });
  if (canonicalJson(policy) !== canonicalJson(witnessPolicy(config)))
    fail("witness config does not match the store's bound policy");
  return policy;
}

async function rejectWitnessPolicy(root) {
  try {
    await lstat(join(root, WITNESS_POLICY));
    fail("store policy requires a witnessed command");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function retainedCheckpoint(root, expectedHash) {
  const checkpoint = validateQuorumCheckpoint(
    await secureRead(join(root, CHECKPOINT), MAX_CHECKPOINT, "checkpoint"),
  );
  const actual = canonicalSha256(checkpoint);
  if (actual !== expectedHash)
    fail(`checkpoint CAS mismatch; retained hash is ${actual}`);
  const lock = await markerStatus(join(root, LOCK));
  const pending = await markerStatus(join(root, PENDING));
  if (lock.present || pending.present)
    fail("store has a lock or pending transaction; inspect before preparing");
  return checkpoint;
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
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1)
      fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      fail(`${field} must be owned by the current user`);
    if ((metadata.mode & 0o077) !== 0)
      fail(`${field} must not grant group or other permissions`);
    if (metadata.size < 2 || metadata.size > maximum)
      fail(`${field} size is invalid`);
    const text = await handle.readFile("utf8");
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

async function writeExclusive(path, value, mode, maximum, field) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  if (bytes.length > maximum) fail(`${field} exceeds its size limit`);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    const created = await handle.stat();
    if (
      !created.isFile() ||
      created.nlink !== 1 ||
      (typeof process.getuid === "function" && created.uid !== process.getuid())
    )
      fail(`${field} failed its ownership, link, or type checks`);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function atomicReplace(path, value, maximum) {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let renamed = false;
  try {
    await writeExclusive(temporary, value, 0o400, maximum, "temporary checkpoint");
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

async function openStore(store) {
  const root = resolve(store);
  await requireSecureDirectory(root, "store");
  await requireSecureDirectory(join(root, RECORDS), "record directory");
  return root;
}

async function markerStatus(path) {
  try {
    const metadata = await lstat(path);
    return {
      present: true,
      currentUserOwned:
        typeof process.getuid !== "function" || metadata.uid === process.getuid(),
      regularSingleLink: metadata.isFile() && metadata.nlink === 1,
      safePermissions: (metadata.mode & 0o077) === 0,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
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
    await handle.writeFile(
      `${canonicalJson({ schemaVersion: 1, pid: process.pid })}\n`,
    );
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    )
      fail(
        "new lock failed its ownership, link, type, or permission checks; preserve state and inspect before recovery",
      );
    await syncDirectory(root);
    return { handle, path, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await handle?.close();
    if (error?.code === "EEXIST")
      fail("lock already exists; inspect the store before any recovery");
    throw error;
  }
}

async function releaseLock(root, lock) {
  const opened = await lock.handle.stat();
  const linked = await lstat(lock.path).catch((error) => {
    if (error?.code === "ENOENT")
      fail("lock path disappeared; preserve state and inspect before recovery");
    throw error;
  });
  if (
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
    fail("lock identity changed; preserve state and inspect before recovery");
  await lock.handle.close();
  await unlink(lock.path);
  await syncDirectory(root);
}

async function transact(root, expectedHash, derive) {
  const lock = await acquireLock(root);
  let durableIntent = false;
  let commitConfirmed = false;
  try {
    const pendingPath = join(root, PENDING);
    try {
      await lstat(pendingPath);
      fail("pending transaction exists; inspect the store before any recovery");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const checkpointPath = join(root, CHECKPOINT);
    const checkpoint = validateQuorumCheckpoint(
      await secureRead(checkpointPath, MAX_CHECKPOINT, "checkpoint"),
    );
    const currentHash = canonicalSha256(checkpoint);
    if (currentHash !== expectedHash)
      fail(`checkpoint CAS mismatch; retained hash is ${currentHash}`);

    const result = await derive(checkpoint);
    validateQuorumCheckpoint(result.checkpoint);
    if (result.record.priorCheckpointSha256 !== currentHash)
      fail("transition record does not bind the retained checkpoint");
    const nextHash = canonicalSha256(result.checkpoint);
    if (result.record.nextCheckpointSha256 !== nextHash)
      fail("transition record does not bind its next checkpoint");
    const recordHash = canonicalSha256(result.record);
    const intent = {
      schemaVersion: 1,
      priorCheckpointSha256: currentHash,
      nextCheckpointSha256: nextHash,
      recordSha256: recordHash,
    };
    await writeExclusive(pendingPath, intent, 0o400, MAX_CHECKPOINT, "intent");
    await syncDirectory(root);
    durableIntent = true;

    const recordPath = join(root, RECORDS, `${recordHash}.json`);
    await writeExclusive(recordPath, result.record, 0o400, MAX_RECORD, "record");
    await syncDirectory(join(root, RECORDS));

    const beforeCommit = validateQuorumCheckpoint(
      await secureRead(checkpointPath, MAX_CHECKPOINT, "checkpoint"),
    );
    if (canonicalSha256(beforeCommit) !== currentHash)
      fail("checkpoint changed during the transaction; inspection is required");
    await atomicReplace(checkpointPath, result.checkpoint, MAX_CHECKPOINT);
    const committed = validateQuorumCheckpoint(
      await secureRead(checkpointPath, MAX_CHECKPOINT, "checkpoint"),
    );
    if (canonicalSha256(committed) !== nextHash)
      fail("checkpoint readback failed; transaction outcome is ambiguous");
    commitConfirmed = true;

    await unlink(pendingPath);
    await syncDirectory(root);
    durableIntent = false;
    await releaseLock(root, lock);
    return { ...result, checkpointSha256: nextHash, recordSha256: recordHash };
  } catch (error) {
    if (!durableIntent && !commitConfirmed) {
      try {
        await releaseLock(root, lock);
      } catch (lockError) {
        error.message = `${error.message}; ${lockError.message}`;
        await lock.handle.close().catch(() => {});
      }
    } else {
      await lock.handle.close().catch(() => {});
    }
    if (durableIntent)
      error.message = `${error.message}; durable intent exists, do not retry blindly`;
    if (commitConfirmed)
      error.message = `${error.message}; checkpoint commit was confirmed, inspect lock state before recovery`;
    throw error;
  }
}

async function initializeStore(store, checkpointInput) {
  const root = resolve(store);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(join(root, RECORDS), { mode: 0o700 });
  await chmod(join(root, RECORDS), 0o700);
  await requireSecureDirectory(root, "store");
  await requireSecureDirectory(join(root, RECORDS), "record directory");
  const checkpoint = validateQuorumCheckpoint(checkpointInput);
  await writeExclusive(
    join(root, CHECKPOINT),
    checkpoint,
    0o400,
    MAX_CHECKPOINT,
    "checkpoint",
  );
  await syncDirectory(join(root, RECORDS));
  await syncDirectory(root);
  return canonicalSha256(checkpoint);
}

async function bindWitnessPolicy(root, expectedHash, config, witnessConfig) {
  const lock = await acquireLock(root);
  let policyWritten = false;
  try {
    const checkpoint = validateQuorumCheckpoint(
      await secureRead(join(root, CHECKPOINT), MAX_CHECKPOINT, "checkpoint"),
    );
    const actual = canonicalSha256(checkpoint);
    if (actual !== expectedHash)
      fail(`checkpoint CAS mismatch; retained hash is ${actual}`);
    requireIndependentWitness([config], witnessConfig, checkpoint);
    await rejectWitnessPolicy(root);
    const pending = await markerStatus(join(root, PENDING));
    if (pending.present)
      fail("pending transaction exists; inspect before binding a witness");
    await writeExclusive(
      join(root, WITNESS_POLICY),
      witnessPolicy(witnessConfig),
      0o400,
      MAX_CHECKPOINT,
      "witness policy",
    );
    await syncDirectory(root);
    policyWritten = true;
    await releaseLock(root, lock);
    return canonicalSha256(witnessPolicy(witnessConfig));
  } catch (error) {
    if (!policyWritten) {
      try {
        await releaseLock(root, lock);
      } catch (lockError) {
        error.message = `${error.message}; ${lockError.message}`;
        await lock.handle.close().catch(() => {});
      }
    } else {
      await lock.handle.close().catch(() => {});
      error.message = `${error.message}; witness policy may be durable, inspect before recovery`;
    }
    throw error;
  }
}

function usage() {
  console.error(`Usage:
  node scripts/publication-quorum-store.mjs init --store <new-directory> --checkpoint <quorum-checkpoint.json>
  node scripts/publication-quorum-store.mjs bind-witness --store <directory> --expected-checkpoint-sha256 <sha256> --config <auditors.json> --witness-config <witness.json>
  node scripts/publication-quorum-store.mjs verify --store <directory> --expected-checkpoint-sha256 <sha256> --config <auditors.json> --entry <entry.json> --attestations <attestations.json>
  node scripts/publication-quorum-store.mjs rotate --store <directory> --expected-checkpoint-sha256 <sha256> --prior-config <auditors.json> --next-config <auditors.json> --prior-approvals <approvals.json> --next-acceptances <acceptances.json>
  node scripts/publication-quorum-store.mjs prepare-witnessed-verify --store <directory> --expected-checkpoint-sha256 <sha256> --config <auditors.json> --entry <entry.json> --attestations <attestations.json> --witness-config <witness.json> --prior-witness-receipt <genesis-or-receipt.json> --output <request.json>
  node scripts/publication-quorum-store.mjs witnessed-verify --store <directory> --expected-checkpoint-sha256 <sha256> --expected-witness-receipt-sha256 <genesis-or-sha256> --config <auditors.json> --entry <entry.json> --attestations <attestations.json> --witness-config <witness.json> --prior-witness-receipt <genesis-or-receipt.json> --witness-receipt <receipt.json>
  node scripts/publication-quorum-store.mjs prepare-witnessed-rotate --store <directory> --expected-checkpoint-sha256 <sha256> --prior-config <auditors.json> --next-config <auditors.json> --prior-approvals <approvals.json> --next-acceptances <acceptances.json> --witness-config <witness.json> --prior-witness-receipt <genesis-or-receipt.json> --output <request.json>
  node scripts/publication-quorum-store.mjs witnessed-rotate --store <directory> --expected-checkpoint-sha256 <sha256> --expected-witness-receipt-sha256 <genesis-or-sha256> --prior-config <auditors.json> --next-config <auditors.json> --prior-approvals <approvals.json> --next-acceptances <acceptances.json> --witness-config <witness.json> --prior-witness-receipt <genesis-or-receipt.json> --witness-receipt <receipt.json>
  node scripts/publication-quorum-store.mjs inspect --store <directory>`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "init") {
    const values = parse(command, args, ["--store", "--checkpoint"]);
    const hash = await initializeStore(
      values["--store"],
      await readJson(values["--checkpoint"], MAX_CHECKPOINT),
    );
    console.log(canonicalJson({ initialized: true, checkpointSha256: hash }));
    return;
  }
  if (command === "bind-witness") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256", "--config",
      "--witness-config",
    ]);
    const root = await openStore(values["--store"]);
    const config = validateAuditorConfig(await readJson(values["--config"], 64_000));
    const witnessConfig = validateWitnessConfig(
      await readJson(values["--witness-config"], 64_000),
    );
    const policySha256 = await bindWitnessPolicy(
      root,
      requireHash(
        values["--expected-checkpoint-sha256"],
        "expected checkpoint hash",
      ),
      config,
      witnessConfig,
    );
    console.log(canonicalJson({ bound: true, policySha256 }));
    return;
  }
  if (command === "inspect") {
    const values = parse(command, args, ["--store"]);
    const root = await openStore(values["--store"]);
    const checkpoint = validateQuorumCheckpoint(
      await secureRead(join(root, CHECKPOINT), MAX_CHECKPOINT, "checkpoint"),
    );
    let pending = null;
    try {
      pending = await secureRead(join(root, PENDING), MAX_CHECKPOINT, "intent");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const lock = await markerStatus(join(root, LOCK));
    let witnessPolicyValue = null;
    try {
      witnessPolicyValue = await secureRead(
        join(root, WITNESS_POLICY),
        MAX_CHECKPOINT,
        "witness policy",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    console.log(canonicalJson({
      schemaVersion: 1,
      checkpoint,
      checkpointSha256: canonicalSha256(checkpoint),
      lock,
      pending,
      recoveryRequired: pending !== null || lock.present,
      witnessPolicy: witnessPolicyValue,
    }));
    return;
  }
  if (command === "prepare-witnessed-verify") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256", "--config", "--entry",
      "--attestations", "--witness-config", "--prior-witness-receipt",
      "--output",
    ]);
    const root = await openStore(values["--store"]);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const checkpoint = await retainedCheckpoint(root, expected);
    const config = validateAuditorConfig(await readJson(values["--config"], 64_000));
    const witnessConfig = validateWitnessConfig(
      await readJson(values["--witness-config"], 64_000),
    );
    await requireWitnessPolicy(root, witnessConfig);
    requireIndependentWitness([config], witnessConfig, checkpoint);
    const result = verifyQuorumPublication(
      config,
      await readJson(values["--entry"], MAX_RECORD),
      await readJson(values["--attestations"], 512_000),
      checkpoint,
    );
    const priorReceipt = await readPriorWitness(values["--prior-witness-receipt"]);
    await writeNewJson(
      values["--output"],
      nextWitnessPayload(witnessConfig, priorReceipt, result.record),
      0o444,
    );
    return;
  }
  if (command === "witnessed-verify") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256",
      "--expected-witness-receipt-sha256", "--config", "--entry",
      "--attestations", "--witness-config", "--prior-witness-receipt",
      "--witness-receipt",
    ]);
    const root = await openStore(values["--store"]);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const config = validateAuditorConfig(await readJson(values["--config"], 64_000));
    const entry = await readJson(values["--entry"], MAX_RECORD);
    const attestations = await readJson(values["--attestations"], 512_000);
    const witnessConfig = validateWitnessConfig(
      await readJson(values["--witness-config"], 64_000),
    );
    await requireWitnessPolicy(root, witnessConfig);
    const priorReceipt = await readPriorWitness(values["--prior-witness-receipt"]);
    requireExpectedWitnessHead(
      values["--expected-witness-receipt-sha256"],
      priorReceipt,
    );
    const receipt = await readJson(values["--witness-receipt"], 64_000);
    const result = await transact(root, expected, (checkpoint) => {
      requireIndependentWitness([config], witnessConfig, checkpoint);
      const derived = verifyQuorumPublication(
        config,
        entry,
        attestations,
        checkpoint,
      );
      return {
        ...derived,
        record: witnessTransition(
          witnessConfig,
          priorReceipt,
          derived.record,
          receipt,
        ),
      };
    });
    console.log(canonicalJson({
      committed: true,
      sequence: result.checkpoint.sequence,
      auditors: result.auditorCount,
      checkpointSha256: result.checkpointSha256,
      recordSha256: result.recordSha256,
      witnessReceiptSha256: canonicalSha256(receipt),
    }));
    return;
  }
  if (command === "prepare-witnessed-rotate") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256", "--prior-config",
      "--next-config", "--prior-approvals", "--next-acceptances",
      "--witness-config", "--prior-witness-receipt", "--output",
    ]);
    const root = await openStore(values["--store"]);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const checkpoint = await retainedCheckpoint(root, expected);
    const priorConfig = validateAuditorConfig(
      await readJson(values["--prior-config"], 64_000),
    );
    const nextConfig = validateAuditorConfig(
      await readJson(values["--next-config"], 64_000),
    );
    const witnessConfig = validateWitnessConfig(
      await readJson(values["--witness-config"], 64_000),
    );
    await requireWitnessPolicy(root, witnessConfig);
    requireIndependentWitness([priorConfig, nextConfig], witnessConfig, checkpoint);
    const result = verifyQuorumConfigRotation(
      priorConfig,
      nextConfig,
      await readJson(values["--prior-approvals"], 512_000),
      await readJson(values["--next-acceptances"], 512_000),
      checkpoint,
    );
    const priorReceipt = await readPriorWitness(values["--prior-witness-receipt"]);
    await writeNewJson(
      values["--output"],
      nextWitnessPayload(witnessConfig, priorReceipt, result.record),
      0o444,
    );
    return;
  }
  if (command === "witnessed-rotate") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256",
      "--expected-witness-receipt-sha256", "--prior-config",
      "--next-config", "--prior-approvals", "--next-acceptances",
      "--witness-config", "--prior-witness-receipt", "--witness-receipt",
    ]);
    const root = await openStore(values["--store"]);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const priorConfig = validateAuditorConfig(
      await readJson(values["--prior-config"], 64_000),
    );
    const nextConfig = validateAuditorConfig(
      await readJson(values["--next-config"], 64_000),
    );
    const priorApprovals = await readJson(values["--prior-approvals"], 512_000);
    const nextAcceptances = await readJson(values["--next-acceptances"], 512_000);
    const witnessConfig = validateWitnessConfig(
      await readJson(values["--witness-config"], 64_000),
    );
    await requireWitnessPolicy(root, witnessConfig);
    const priorReceipt = await readPriorWitness(values["--prior-witness-receipt"]);
    requireExpectedWitnessHead(
      values["--expected-witness-receipt-sha256"],
      priorReceipt,
    );
    const receipt = await readJson(values["--witness-receipt"], 64_000);
    const result = await transact(root, expected, (checkpoint) => {
      requireIndependentWitness(
        [priorConfig, nextConfig],
        witnessConfig,
        checkpoint,
      );
      const derived = verifyQuorumConfigRotation(
        priorConfig,
        nextConfig,
        priorApprovals,
        nextAcceptances,
        checkpoint,
      );
      return {
        ...derived,
        record: witnessTransition(
          witnessConfig,
          priorReceipt,
          derived.record,
          receipt,
        ),
      };
    });
    console.log(canonicalJson({
      committed: true,
      configGeneration: result.checkpoint.quorumConfigGeneration,
      checkpointSha256: result.checkpointSha256,
      recordSha256: result.recordSha256,
      witnessReceiptSha256: canonicalSha256(receipt),
    }));
    return;
  }
  if (command === "verify") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256", "--config", "--entry",
      "--attestations",
    ]);
    const root = await openStore(values["--store"]);
    await rejectWitnessPolicy(root);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const config = validateAuditorConfig(await readJson(values["--config"], 64_000));
    const entry = await readJson(values["--entry"], MAX_RECORD);
    const attestations = await readJson(values["--attestations"], 512_000);
    const result = await transact(root, expected, (checkpoint) =>
      verifyQuorumPublication(config, entry, attestations, checkpoint));
    console.log(canonicalJson({
      committed: true,
      sequence: result.checkpoint.sequence,
      auditors: result.auditorCount,
      checkpointSha256: result.checkpointSha256,
      recordSha256: result.recordSha256,
    }));
    return;
  }
  if (command === "rotate") {
    const values = parse(command, args, [
      "--store", "--expected-checkpoint-sha256", "--prior-config",
      "--next-config", "--prior-approvals", "--next-acceptances",
    ]);
    const root = await openStore(values["--store"]);
    await rejectWitnessPolicy(root);
    const expected = requireHash(
      values["--expected-checkpoint-sha256"],
      "expected checkpoint hash",
    );
    const priorConfig = await readJson(values["--prior-config"], 64_000);
    const nextConfig = await readJson(values["--next-config"], 64_000);
    const priorApprovals = await readJson(values["--prior-approvals"], 512_000);
    const nextAcceptances = await readJson(values["--next-acceptances"], 512_000);
    const result = await transact(root, expected, (checkpoint) =>
      verifyQuorumConfigRotation(
        priorConfig,
        nextConfig,
        priorApprovals,
        nextAcceptances,
        checkpoint,
      ));
    console.log(canonicalJson({
      committed: true,
      configGeneration: result.checkpoint.quorumConfigGeneration,
      checkpointSha256: result.checkpointSha256,
      recordSha256: result.recordSha256,
    }));
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
