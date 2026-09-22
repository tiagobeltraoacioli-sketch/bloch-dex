import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableJson } from "./manifest.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const MAX_VALIDITY_SECONDS = 15 * 60;
const NAMESPACE = "postern.dex.pilot-cap-approval.v1";
const NAMES = ["l2", "bridge", "deployment", "pilot", "aggregator"];

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

function validateApproval(value, expectedPolicySha256, expectedCeremonyId, context, atUnixSeconds) {
  exact(
    value,
    [
      "schemaVersion", "domain", "ceremonyId", "issuedAtUnixSeconds",
      "expiresAtUnixSeconds", "authorityPolicySha256", "selectedChainId",
      "genesisHash", "deploymentConfigurationSha256", "factoryAddress",
      "pilotPoolAddress", "wrappedNativeAddress", "bridgeAssetAddress",
      "maxBaseBaseUnits", "maxQuoteBaseUnits", "sourceRevisions", "controls",
    ],
    "approval",
  );
  required(
    value.schemaVersion === 1 && value.domain === NAMESPACE,
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
    value.selectedChainId === context.selectedChainId &&
      value.genesisHash === context.genesisHash,
    "approval binds another chain",
  );
  for (const field of [
    "deploymentConfigurationSha256", "factoryAddress", "pilotPoolAddress",
    "wrappedNativeAddress", "bridgeAssetAddress", "maxBaseBaseUnits",
    "maxQuoteBaseUnits",
  ])
    required(value[field] === context.pilotCap[field], `approval ${field} does not match pilot evidence`);
  exact(value.sourceRevisions, NAMES, "approval.sourceRevisions");
  for (const name of NAMES)
    required(
      REVISION.test(value.sourceRevisions[name]) &&
        value.sourceRevisions[name] === context.sourceRevisions[name],
      `approval ${name} revision does not match authenticated evidence`,
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
    ],
    "authentication options",
  );
  hash(options.expectedAuthorityPolicySha256, "expected authority policy sha256");
  hash(options.expectedCeremonyId, "expected ceremony id");
  hash(options.expectedSshKeygenSha256, "expected ssh-keygen sha256");
  const [approvalBytes, policyBytes, riskSignature, securitySignature, executable] = await Promise.all([
    readSafeBytes(repository, options.approvalPath, "approval"),
    readSafeBytes(repository, options.authorityPolicyPath, "authority policy"),
    readSafeBytes(repository, options.riskSignaturePath, "risk signature"),
    readSafeBytes(repository, options.securitySignaturePath, "security signature"),
    readPinnedExecutable(options.sshKeygenPath, options.expectedSshKeygenSha256),
  ]);
  validatePolicy(policyBytes, options.expectedAuthorityPolicySha256);
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
    expiresAtUnixSeconds: approval.expiresAtUnixSeconds,
    callerSuppliedPolicyMatched: true,
    callerSuppliedCeremonyMatched: true,
    distinctPublicKeysObserved: true,
    signatureCheckProcessesExitedZero: true,
    verifierIdentityAuthenticated: false,
    authorityOrganizationsSeparated: false,
    replayProtectionAuthenticated: false,
    approvalAuthenticated: false,
  });
}
