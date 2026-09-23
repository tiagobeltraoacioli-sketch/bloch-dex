import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableJson } from "./manifest.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const MAX_VALIDITY_SECONDS = 15 * 60;
const NAMESPACE = "postern.dex.pilot-cap-approval.v1";
const CHECKPOINT_DOMAIN = "postern.dex.pilot-cap-checkpoint.v1";
const NAMES = ["l2", "bridge", "deployment", "pilot", "aggregator"];
const LOCK_STALE_SECONDS = 30;

function fail(message) {
  throw new Error(`pilot cap approval: ${message}`);
}

function required(condition, message) {
  if (!condition) fail(message);
}

function exact(value, keys, field) {
  required(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${field} is not an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  required(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${field} fields are invalid`,
  );
}

function hash(value, field) {
  required(HASH.test(value) && !/^0x0{64}$/.test(value), `${field} is invalid`);
  return value;
}

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function durableAtomicReplace(path, bytes) {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireCheckpointLock(checkpointPath) {
  const lockPath = `${checkpointPath}.lock`;
  let recoveredStaleLock = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = `${stableJson({
        schemaVersion: 1,
        domain: "postern.dex.pilot-cap-checkpoint-lock.v1",
        pid: process.pid,
        createdAtUnixSeconds: Math.floor(Date.now() / 1000),
        nonce: randomBytes(16).toString("hex"),
      })}\n`;
      await writeFile(join(lockPath, "owner.json"), owner, { mode: 0o600, flag: "wx" });
      await syncDirectory(lockPath);
      await syncDirectory(dirname(lockPath));
      return { lockPath, recoveredStaleLock };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      let ownerHandle;
      try {
        ownerHandle = await open(join(lockPath, "owner.json"), constants.O_RDONLY);
        owner = JSON.parse(await ownerHandle.readFile("utf8"));
      } catch {
        try {
          const lockStat = await lstat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_SECONDS * 1_000) {
            const stalePath = `${lockPath}.stale-${randomBytes(12).toString("hex")}`;
            await rename(lockPath, stalePath);
            await syncDirectory(dirname(lockPath));
            await rm(stalePath, { recursive: true, force: true });
            recoveredStaleLock = true;
            continue;
          }
        } catch (recoveryError) {
          if (recoveryError?.code !== "ENOENT") throw recoveryError;
        }
        await delay(25);
        continue;
      } finally {
        await ownerHandle?.close().catch(() => {});
      }
      const age = Math.floor(Date.now() / 1000) - owner.createdAtUnixSeconds;
      if (age > LOCK_STALE_SECONDS && !processAlive(owner.pid)) {
        const stalePath = `${lockPath}.stale-${randomBytes(12).toString("hex")}`;
        try {
          await rename(lockPath, stalePath);
          await syncDirectory(dirname(lockPath));
          await rm(stalePath, { recursive: true, force: true });
          recoveredStaleLock = true;
          continue;
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
      await delay(25);
    }
  }
  fail("checkpoint lock is busy");
}

async function releaseCheckpointLock(lockPath) {
  await rm(lockPath, { recursive: true, force: true });
  await syncDirectory(dirname(lockPath));
}

async function readSafeBytes(repository, relativePath, label) {
  required(
    typeof relativePath === "string" &&
      SAFE_PATH.test(relativePath) &&
      !isAbsolute(relativePath),
    `${label} path is invalid`,
  );
  const root = resolve(repository);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  required(
    fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`),
    `${label} path escapes the repository`,
  );
  let before;
  try {
    before = await lstat(path, { bigint: true });
    required((await realpath(path)) === path, `${label} contains a symbolic link`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pilot cap approval:"))
      throw error;
    fail(`cannot inspect ${label}`);
  }
  required(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_BYTES) &&
      Number(before.mode & 0o022n) === 0,
    `${label} is unsafe`,
  );
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
    required(
      opened.isFile() && fields.every((field) => opened[field] === before[field]),
      `${label} changed before reading`,
    );
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    required(offset > 0 && offset <= MAX_BYTES, `${label} is unsafe`);
    const after = await handle.stat({ bigint: true });
    required(
      fields.every((field) => after[field] === opened[field]),
      `${label} changed while reading`,
    );
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readPinnedExecutable(path, expectedSha256) {
  required(isAbsolute(path), "ssh-keygen path must be absolute");
  let before;
  try {
    before = await lstat(path, { bigint: true });
    required((await realpath(path)) === path, "ssh-keygen path contains a symbolic link");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pilot cap approval:"))
      throw error;
    fail("cannot inspect ssh-keygen executable");
  }
  required(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === 0n &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_EXECUTABLE_BYTES) &&
      Number(before.mode & 0o022n) === 0 &&
      Number(before.mode & 0o100n) !== 0,
    "ssh-keygen executable is not root-administered and immutable to operators",
  );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
  try {
    const opened = await handle.stat({ bigint: true });
    required(
      opened.isFile() && fields.every((field) => opened[field] === before[field]),
      "ssh-keygen executable changed before reading",
    );
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      required(result.bytesRead > 0, "ssh-keygen executable was truncated");
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    required(
      fields.every((field) => after[field] === opened[field]),
      "ssh-keygen executable changed while reading",
    );
    required(sha256(bytes) === expectedSha256, "ssh-keygen executable hash mismatch");
    return { bytes, path, fields, snapshot: after };
  } finally {
    await handle.close();
  }
}

async function requireExecutableUnchanged(executable) {
  const after = await lstat(executable.path, { bigint: true });
  required(
    executable.fields.every((field) => after[field] === executable.snapshot[field]),
    "ssh-keygen executable changed after verification",
  );
}

function validatePolicy(bytes, expectedSha256) {
  required(sha256(bytes) === expectedSha256, "authority policy hash mismatch");
  const lines = bytes.toString("utf8").split("\n");
  required(lines.length === 3 && lines[2] === "", "authority policy is not canonical");
  const patterns = [
    /^postern-dex-pilot-risk namespaces="postern\.dex\.pilot-cap-approval\.v1" ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/,
    /^postern-dex-pilot-security namespaces="postern\.dex\.pilot-cap-approval\.v1" ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/,
  ];
  const keys = lines.slice(0, 2).map((line, index) => {
    const match = line.match(patterns[index]);
    required(match !== null, "authority policy roles or namespaces are invalid");
    return match[1];
  });
  required(keys[0] !== keys[1], "risk and security authorities must use distinct keys");
}

function contextFieldsMatch(value, context, label) {
  required(
    value.selectedChainId === context.selectedChainId &&
      value.genesisHash === context.genesisHash,
    `${label} binds another chain`,
  );
  for (const field of [
    "deploymentConfigurationSha256", "factoryAddress", "pilotPoolAddress",
    "wrappedNativeAddress", "bridgeAssetAddress", "maxBaseBaseUnits",
    "maxQuoteBaseUnits",
  ])
    required(value[field] === context.pilotCap[field], `${label} ${field} does not match pilot evidence`);
  exact(value.sourceRevisions, NAMES, `${label}.sourceRevisions`);
  for (const name of NAMES)
    required(
      REVISION.test(value.sourceRevisions[name]) &&
        value.sourceRevisions[name] === context.sourceRevisions[name],
      `${label} ${name} revision does not match authenticated evidence`,
    );
}

function canonicalSequence(value, { allowZero }, field) {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/;
  required(typeof value === "string" && pattern.test(value), `${field} is invalid`);
  return BigInt(value);
}

function validateCheckpoint(value, context) {
  exact(
    value,
    [
      "schemaVersion", "domain", "retainedAtUnixSeconds", "selectedChainId",
      "genesisHash", "deploymentConfigurationSha256", "factoryAddress",
      "pilotPoolAddress", "wrappedNativeAddress", "bridgeAssetAddress",
      "maxBaseBaseUnits", "maxQuoteBaseUnits", "sourceRevisions",
      "lastSequence", "lastApprovalSha256",
    ],
    "checkpoint",
  );
  required(
    value.schemaVersion === 1 && value.domain === CHECKPOINT_DOMAIN,
    "checkpoint schema is unsupported",
  );
  required(
    Number.isSafeInteger(value.retainedAtUnixSeconds) && value.retainedAtUnixSeconds > 0,
    "checkpoint retention time is invalid",
  );
  contextFieldsMatch(value, context, "checkpoint");
  const lastSequence = canonicalSequence(
    value.lastSequence,
    { allowZero: true },
    "checkpoint.lastSequence",
  );
  hash(value.lastApprovalSha256, "checkpoint.lastApprovalSha256");
  return {
    retainedAtUnixSeconds: value.retainedAtUnixSeconds,
    lastSequence,
    lastApprovalSha256: value.lastApprovalSha256,
  };
}

function validateApproval(value, expectedPolicySha256, expectedCeremonyId, context, checkpoint, atUnixSeconds) {
  exact(
    value,
    [
      "schemaVersion", "domain", "ceremonyId", "sequence",
      "predecessorApprovalSha256", "issuedAtUnixSeconds",
      "expiresAtUnixSeconds", "authorityPolicySha256", "selectedChainId",
      "genesisHash", "deploymentConfigurationSha256", "factoryAddress",
      "pilotPoolAddress", "wrappedNativeAddress", "bridgeAssetAddress",
      "maxBaseBaseUnits", "maxQuoteBaseUnits", "sourceRevisions", "controls",
    ],
    "approval",
  );
  required(
    value.schemaVersion === 2 && value.domain === NAMESPACE,
    "approval schema is unsupported",
  );
  required(value.ceremonyId === expectedCeremonyId, "approval ceremony is not externally selected");
  required(value.authorityPolicySha256 === expectedPolicySha256, "approval binds another authority policy");
  required(
    Number.isSafeInteger(value.issuedAtUnixSeconds) &&
      Number.isSafeInteger(value.expiresAtUnixSeconds) &&
      value.expiresAtUnixSeconds > value.issuedAtUnixSeconds &&
      value.expiresAtUnixSeconds - value.issuedAtUnixSeconds <= MAX_VALIDITY_SECONDS &&
      atUnixSeconds >= value.issuedAtUnixSeconds &&
      atUnixSeconds <= value.expiresAtUnixSeconds,
    "approval is stale, premature or overlong",
  );
  required(
    checkpoint.retainedAtUnixSeconds <= value.issuedAtUnixSeconds,
    "approval predates its retained checkpoint",
  );
  contextFieldsMatch(value, context, "approval");
  const sequence = canonicalSequence(value.sequence, { allowZero: false }, "approval.sequence");
  hash(value.predecessorApprovalSha256, "approval.predecessorApprovalSha256");
  required(sequence === checkpoint.lastSequence + 1n, "approval is replayed, rolled back or skips a sequence");
  required(
    value.predecessorApprovalSha256 === checkpoint.lastApprovalSha256,
    "approval predecessor does not match the retained checkpoint",
  );
  exact(
    value.controls,
    ["liquidityEnabled", "liquidityAdded", "aggregatorExecutionEnabled", "activationAuthorized"],
    "approval.controls",
  );
  for (const [field, control] of Object.entries(value.controls))
    required(control === false, `approval ${field} must remain false`);
}

function verifySignature(executablePath, policyPath, signaturePath, identity, approvalBytes) {
  const result = spawnSync(
    executablePath,
    ["-Y", "verify", "-f", policyPath, "-I", identity, "-n", NAMESPACE, "-s", signaturePath],
    { input: approvalBytes, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  required(result.status === 0, `${identity} signature is not valid`);
}

export async function inspectPilotCapApproval(repository, options, context) {
  exact(
    options,
    [
      "approvalPath", "authorityPolicyPath", "expectedAuthorityPolicySha256",
      "expectedCeremonyId", "riskSignaturePath", "securitySignaturePath",
      "sshKeygenPath", "expectedSshKeygenSha256",
      "checkpointPath", "expectedCheckpointSha256",
    ],
    "authentication options",
  );
  hash(options.expectedAuthorityPolicySha256, "expected authority policy sha256");
  hash(options.expectedCeremonyId, "expected ceremony id");
  hash(options.expectedSshKeygenSha256, "expected ssh-keygen sha256");
  hash(options.expectedCheckpointSha256, "expected checkpoint sha256");
  const [approvalBytes, policyBytes, riskSignature, securitySignature, checkpointBytes, executable] = await Promise.all([
    readSafeBytes(repository, options.approvalPath, "approval"),
    readSafeBytes(repository, options.authorityPolicyPath, "authority policy"),
    readSafeBytes(repository, options.riskSignaturePath, "risk signature"),
    readSafeBytes(repository, options.securitySignaturePath, "security signature"),
    readSafeBytes(repository, options.checkpointPath, "checkpoint"),
    readPinnedExecutable(options.sshKeygenPath, options.expectedSshKeygenSha256),
  ]);
  validatePolicy(policyBytes, options.expectedAuthorityPolicySha256);
  required(
    sha256(checkpointBytes) === options.expectedCheckpointSha256,
    "checkpoint hash mismatch",
  );
  let checkpointValue;
  try {
    checkpointValue = JSON.parse(checkpointBytes.toString("utf8"));
  } catch {
    fail("checkpoint is invalid JSON");
  }
  required(
    checkpointBytes.toString("utf8") === `${stableJson(checkpointValue)}\n`,
    "checkpoint is not canonical JSON",
  );
  const checkpoint = validateCheckpoint(checkpointValue, context);
  let approval;
  try {
    approval = JSON.parse(approvalBytes.toString("utf8"));
  } catch {
    fail("approval is invalid JSON");
  }
  required(
    approvalBytes.toString("utf8") === `${stableJson(approval)}\n`,
    "approval is not canonical JSON",
  );
  required(
    sha256(approvalBytes) === context.pilotCap.capApprovalSha256,
    "approval does not match the pilot cap hash",
  );
  const atUnixSeconds = Math.floor(Date.now() / 1000);
  validateApproval(
    approval,
    options.expectedAuthorityPolicySha256,
    options.expectedCeremonyId,
    context,
    checkpoint,
    atUnixSeconds,
  );
  const temporary = await mkdtemp(join(tmpdir(), "postern-cap-approval-"));
  try {
    await chmod(temporary, 0o700);
    const policyPath = join(temporary, "allowed_signers");
    const riskPath = join(temporary, "risk.sig");
    const securityPath = join(temporary, "security.sig");
    const executablePath = join(temporary, "ssh-keygen");
    await writeFile(policyPath, policyBytes, { mode: 0o600, flag: "wx" });
    await writeFile(riskPath, riskSignature, { mode: 0o600, flag: "wx" });
    await writeFile(securityPath, securitySignature, { mode: 0o600, flag: "wx" });
    await writeFile(executablePath, executable.bytes, { mode: 0o700, flag: "wx" });
    verifySignature(executablePath, policyPath, riskPath, "postern-dex-pilot-risk", approvalBytes);
    verifySignature(executablePath, policyPath, securityPath, "postern-dex-pilot-security", approvalBytes);
    await requireExecutableUnchanged(executable);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return Object.freeze({
    approvalSha256: sha256(approvalBytes),
    callerSuppliedAuthorityPolicySha256: options.expectedAuthorityPolicySha256,
    callerSuppliedCeremonyId: options.expectedCeremonyId,
    callerSuppliedVerifierSha256: options.expectedSshKeygenSha256,
    callerSuppliedCheckpointSha256: options.expectedCheckpointSha256,
    sequence: approval.sequence,
    predecessorApprovalSha256: approval.predecessorApprovalSha256,
    expiresAtUnixSeconds: approval.expiresAtUnixSeconds,
    callerSuppliedPolicyMatched: true,
    callerSuppliedCeremonyMatched: true,
    distinctPublicKeysObserved: true,
    signatureCheckProcessesExitedZero: true,
    checkpointSnapshotMatched: true,
    monotonicSuccessorObserved: true,
    predecessorMatched: true,
    checkpointMutationPerformed: false,
    concurrentConsumptionPrevented: false,
    verifierIdentityAuthenticated: false,
    authorityOrganizationsSeparated: false,
    replayProtectionAuthenticated: false,
    approvalAuthenticated: false,
  });
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is invalid JSON`);
  }
  required(
    bytes.toString("utf8") === `${stableJson(value)}\n`,
    `${label} is not canonical JSON`,
  );
  return value;
}

async function recoverCheckpointIntent(
  repository,
  checkpointRelativePath,
  checkpointPath,
  options,
  context,
  approvalBytes,
) {
  const intentRelativePath = `${checkpointRelativePath}.intent`;
  const intentPath = `${checkpointPath}.intent`;
  try {
    await lstat(intentPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const intentBytes = await readSafeBytes(repository, intentRelativePath, "checkpoint intent");
  const intent = parseCanonicalJson(intentBytes, "checkpoint intent");
  exact(
    intent,
    [
      "schemaVersion", "domain", "expectedCheckpointSha256",
      "nextCheckpointSha256", "approvalSha256", "nextCheckpoint",
    ],
    "checkpoint intent",
  );
  required(
    intent.schemaVersion === 1 &&
      intent.domain === "postern.dex.pilot-cap-checkpoint-intent.v1",
    "checkpoint intent schema is unsupported",
  );
  hash(intent.expectedCheckpointSha256, "checkpoint intent expected digest");
  hash(intent.nextCheckpointSha256, "checkpoint intent next digest");
  hash(intent.approvalSha256, "checkpoint intent approval digest");
  required(
    sha256(approvalBytes) === intent.approvalSha256,
    "checkpoint intent binds another approval",
  );
  const approval = parseCanonicalJson(approvalBytes, "approval");
  contextFieldsMatch(approval, context, "approval");
  const approvalSequence = canonicalSequence(
    approval.sequence,
    { allowZero: false },
    "approval.sequence",
  );
  validateCheckpoint(intent.nextCheckpoint, context);
  required(
    intent.nextCheckpoint.lastApprovalSha256 === intent.approvalSha256 &&
      canonicalSequence(
        intent.nextCheckpoint.lastSequence,
        { allowZero: true },
        "checkpoint intent next sequence",
      ) === approvalSequence,
    "checkpoint intent does not bind its approval",
  );
  const nextBytes = Buffer.from(`${stableJson(intent.nextCheckpoint)}\n`);
  required(
    sha256(nextBytes) === intent.nextCheckpointSha256,
    "checkpoint intent next digest is invalid",
  );
  const currentBytes = await readSafeBytes(repository, checkpointRelativePath, "checkpoint");
  const currentSha256 = sha256(currentBytes);
  if (currentSha256 === intent.expectedCheckpointSha256) {
    await inspectPilotCapApproval(repository, options, context);
    await durableAtomicReplace(checkpointPath, nextBytes);
  } else
    required(
      currentSha256 === intent.nextCheckpointSha256,
      "checkpoint diverged from its durable intent",
    );
  await unlink(intentPath);
  await syncDirectory(dirname(intentPath));
  return true;
}

export async function consumePilotCapCheckpointObservation(repository, options, context) {
  required(
    typeof options?.checkpointPath === "string" &&
      SAFE_PATH.test(options.checkpointPath) &&
      !isAbsolute(options.checkpointPath),
    "checkpoint path is invalid",
  );
  const root = resolve(repository);
  const checkpointPath = resolve(root, options.checkpointPath);
  const fromRoot = relative(root, checkpointPath);
  required(
    fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`),
    "checkpoint path escapes the repository",
  );
  const lock = await acquireCheckpointLock(checkpointPath);
  try {
    const approvalBeforeRecovery = await readSafeBytes(
      repository,
      options.approvalPath,
      "approval",
    );
    const crashRecoveryPerformed = await recoverCheckpointIntent(
      repository,
      options.checkpointPath,
      checkpointPath,
      options,
      context,
      approvalBeforeRecovery,
    );
    const [checkpointBytes, approvalBytes] = await Promise.all([
      readSafeBytes(repository, options.checkpointPath, "checkpoint"),
      readSafeBytes(repository, options.approvalPath, "approval"),
    ]);
    const checkpointValue = parseCanonicalJson(checkpointBytes, "checkpoint");
    const checkpoint = validateCheckpoint(checkpointValue, context);
    const approval = parseCanonicalJson(approvalBytes, "approval");
    const approvalSha256 = sha256(approvalBytes);
    required(
      approvalSha256 === context.pilotCap.capApprovalSha256,
      "approval does not match the pilot cap hash",
    );
    contextFieldsMatch(approval, context, "approval");
    const sequence = canonicalSequence(
      approval.sequence,
      { allowZero: false },
      "approval.sequence",
    );
    if (
      checkpoint.lastSequence === sequence &&
      checkpoint.lastApprovalSha256 === approvalSha256
    )
      return Object.freeze({
        approvalSha256,
        sequence: approval.sequence,
        checkpointSha256: sha256(checkpointBytes),
        checkpointConsumedObservation: true,
        idempotentRetryObserved: true,
        crashRecoveryPerformed,
        staleLockRecovered: lock.recoveredStaleLock,
        crossProcessLockObserved: true,
        casAppliedObserved: false,
        durableFileFsyncObserved: false,
        durableRenameObserved: false,
        durableDirectoryFsyncObserved: false,
        replayProtectionAuthenticated: false,
        approvalAuthenticated: false,
      });
    required(
      sha256(checkpointBytes) === options.expectedCheckpointSha256,
      "checkpoint compare-and-swap digest mismatch",
    );
    const observation = await inspectPilotCapApproval(repository, options, context);
    const nextCheckpoint = {
      ...checkpointValue,
      retainedAtUnixSeconds: Math.floor(Date.now() / 1000),
      lastSequence: approval.sequence,
      lastApprovalSha256: approvalSha256,
    };
    validateCheckpoint(nextCheckpoint, context);
    const nextBytes = Buffer.from(`${stableJson(nextCheckpoint)}\n`);
    const nextCheckpointSha256 = sha256(nextBytes);
    const intent = {
      schemaVersion: 1,
      domain: "postern.dex.pilot-cap-checkpoint-intent.v1",
      expectedCheckpointSha256: options.expectedCheckpointSha256,
      nextCheckpointSha256,
      approvalSha256,
      nextCheckpoint,
    };
    const intentPath = `${checkpointPath}.intent`;
    await durableAtomicReplace(intentPath, Buffer.from(`${stableJson(intent)}\n`));
    await durableAtomicReplace(checkpointPath, nextBytes);
    await unlink(intentPath);
    await syncDirectory(dirname(intentPath));
    return Object.freeze({
      ...observation,
      checkpointSha256: nextCheckpointSha256,
      checkpointConsumedObservation: true,
      idempotentRetryObserved: false,
      crashRecoveryPerformed,
      staleLockRecovered: lock.recoveredStaleLock,
      crossProcessLockObserved: true,
      casAppliedObserved: true,
      durableFileFsyncObserved: true,
      durableRenameObserved: true,
      durableDirectoryFsyncObserved: true,
      replayProtectionAuthenticated: false,
      approvalAuthenticated: false,
    });
  } finally {
    await releaseCheckpointLock(lock.lockPath);
  }
}
