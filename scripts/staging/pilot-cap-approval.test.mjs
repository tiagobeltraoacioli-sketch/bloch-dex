import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableJson } from "./manifest.mjs";
import {
  consumePilotCapCheckpointObservation,
  inspectPilotCapApproval,
} from "./pilot-cap-approval.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const revision = (byte) => byte.repeat(40);
const sha256 = (bytes) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const NAMESPACE = "postern.dex.pilot-cap-approval.v1";
const moduleUrl = new URL("./pilot-cap-approval.mjs", import.meta.url).href;
const testTemporaryDirectory = await realpath(tmpdir());

function command(args) {
  const result = spawnSync("ssh-keygen", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function consumeInChild(payload) {
  const source = `
    import { consumePilotCapCheckpointObservation } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.env.POSTERN_CAP_TEST_PAYLOAD);
    const result = await consumePilotCapCheckpointObservation(input.root, input.options, input.context);
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        POSTERN_CAP_TEST_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectChild);
    child.on("close", (code) => {
      if (code !== 0) rejectChild(new Error(stderr || `child exited ${code}`));
      else resolveChild(JSON.parse(stdout));
    });
  });
}

async function fixture(root) {
  const sshKeygenPath = "/usr/bin/ssh-keygen";
  const sshKeygenBytes = await readFile(sshKeygenPath);
  const riskKey = join(root, "risk-key");
  const securityKey = join(root, "security-key");
  command(["-q", "-t", "ed25519", "-N", "", "-f", riskKey]);
  command(["-q", "-t", "ed25519", "-N", "", "-f", securityKey]);
  const publicKey = async (path) =>
    (await readFile(`${path}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  const policy = Buffer.from(
    `postern-dex-pilot-risk namespaces="${NAMESPACE}" ${await publicKey(riskKey)}\n` +
      `postern-dex-pilot-security namespaces="${NAMESPACE}" ${await publicKey(securityKey)}\n`,
  );
  await writeFile(join(root, "policy"), policy, { mode: 0o600 });
  const now = Math.floor(Date.now() / 1000);
  const pilotCap = {
    maxBaseBaseUnits: "100000000000000000",
    maxQuoteBaseUnits: "1000000",
    capApprovalSha256: null,
    deploymentConfigurationSha256: hash("d"),
    factoryAddress: `0x${"11".repeat(20)}`,
    pilotPoolAddress: `0x${"22".repeat(20)}`,
    wrappedNativeAddress: `0x${"33".repeat(20)}`,
    bridgeAssetAddress: `0x${"44".repeat(20)}`,
  };
  const sourceRevisions = {
    l2: revision("1"),
    bridge: revision("2"),
    deployment: revision("3"),
    pilot: revision("4"),
    aggregator: revision("5"),
  };
  const ceremonyId = hash("c");
  const policySha256 = sha256(policy);
  const checkpoint = {
    schemaVersion: 1,
    domain: "postern.dex.pilot-cap-checkpoint.v1",
    retainedAtUnixSeconds: now - 10,
    selectedChainId: 700771,
    genesisHash: hash("a"),
    deploymentConfigurationSha256: pilotCap.deploymentConfigurationSha256,
    factoryAddress: pilotCap.factoryAddress,
    pilotPoolAddress: pilotCap.pilotPoolAddress,
    wrappedNativeAddress: pilotCap.wrappedNativeAddress,
    bridgeAssetAddress: pilotCap.bridgeAssetAddress,
    maxBaseBaseUnits: pilotCap.maxBaseBaseUnits,
    maxQuoteBaseUnits: pilotCap.maxQuoteBaseUnits,
    sourceRevisions,
    lastSequence: "7",
    lastApprovalSha256: hash("b"),
  };
  const checkpointBytes = Buffer.from(`${stableJson(checkpoint)}\n`);
  await writeFile(join(root, "checkpoint.json"), checkpointBytes, { mode: 0o600 });
  const approval = {
    schemaVersion: 2,
    domain: NAMESPACE,
    ceremonyId,
    sequence: "8",
    predecessorApprovalSha256: checkpoint.lastApprovalSha256,
    issuedAtUnixSeconds: now - 5,
    expiresAtUnixSeconds: now + 300,
    authorityPolicySha256: policySha256,
    selectedChainId: 700771,
    genesisHash: hash("a"),
    deploymentConfigurationSha256: pilotCap.deploymentConfigurationSha256,
    factoryAddress: pilotCap.factoryAddress,
    pilotPoolAddress: pilotCap.pilotPoolAddress,
    wrappedNativeAddress: pilotCap.wrappedNativeAddress,
    bridgeAssetAddress: pilotCap.bridgeAssetAddress,
    maxBaseBaseUnits: pilotCap.maxBaseBaseUnits,
    maxQuoteBaseUnits: pilotCap.maxQuoteBaseUnits,
    sourceRevisions,
    controls: {
      liquidityEnabled: false,
      liquidityAdded: false,
      aggregatorExecutionEnabled: false,
      activationAuthorized: false,
    },
  };
  const approvalBytes = Buffer.from(`${stableJson(approval)}\n`);
  await writeFile(join(root, "approval.json"), approvalBytes, { mode: 0o600 });
  pilotCap.capApprovalSha256 = sha256(approvalBytes);
  command(["-Y", "sign", "-f", riskKey, "-n", NAMESPACE, join(root, "approval.json")]);
  await rename(join(root, "approval.json.sig"), join(root, "risk.sig"));
  command(["-Y", "sign", "-f", securityKey, "-n", NAMESPACE, join(root, "approval.json")]);
  await rename(join(root, "approval.json.sig"), join(root, "security.sig"));
  for (const file of ["approval.json", "policy", "risk.sig", "security.sig", "checkpoint.json"])
    await chmod(join(root, file), 0o600);
  return {
    approval,
    checkpoint,
    options: {
      approvalPath: "approval.json",
      authorityPolicyPath: "policy",
      expectedAuthorityPolicySha256: policySha256,
      expectedCeremonyId: ceremonyId,
      riskSignaturePath: "risk.sig",
      securitySignaturePath: "security.sig",
      sshKeygenPath,
      expectedSshKeygenSha256: sha256(sshKeygenBytes),
      checkpointPath: "checkpoint.json",
      expectedCheckpointSha256: sha256(checkpointBytes),
    },
    context: {
      selectedChainId: 700771,
      genesisHash: hash("a"),
      pilotCap,
      sourceRevisions,
    },
  };
}

test("caller-supplied policy and signatures produce an observation, never authentication", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-auth-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const report = await inspectPilotCapApproval(root, value.options, value.context);
  assert.equal(report.approvalSha256, value.context.pilotCap.capApprovalSha256);
  assert.equal(report.callerSuppliedAuthorityPolicySha256, value.options.expectedAuthorityPolicySha256);
  assert.equal(report.callerSuppliedCeremonyId, value.options.expectedCeremonyId);
  assert.equal(report.distinctPublicKeysObserved, true);
  assert.equal(report.signatureCheckProcessesExitedZero, true);
  assert.equal(report.invalidSignatureProbeRefused, true);
  assert.equal(report.verifierExecutionMode, "pinned-root-administered-path");
  assert.equal(report.verifierIdentityAuthenticated, false);
  assert.equal(report.authorityOrganizationsSeparated, false);
  assert.equal(report.replayProtectionAuthenticated, false);
  assert.equal(report.approvalAuthenticated, false);
  assert.equal(report.sequence, "8");
  assert.equal(report.predecessorApprovalSha256, hash("b"));
  assert.equal(report.checkpointSnapshotMatched, true);
  assert.equal(report.monotonicSuccessorObserved, true);
  assert.equal(report.predecessorMatched, true);
  assert.equal(report.checkpointMutationPerformed, false);
  assert.equal(report.concurrentConsumptionPrevented, false);
  assert.equal("liquidityEnabled" in report, false);
});

test("policy, role and replay substitution fail closed", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-attacks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      { ...value.options, expectedAuthorityPolicySha256: hash("9") },
      value.context,
    ),
    /policy hash mismatch/,
  );
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      { ...value.options, expectedCeremonyId: hash("9") },
      value.context,
    ),
    /ceremony is not externally selected/,
  );
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      { ...value.options, expectedCheckpointSha256: hash("9") },
      value.context,
    ),
    /checkpoint hash mismatch/,
  );
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      {
        ...value.options,
        riskSignaturePath: value.options.securitySignaturePath,
        securitySignaturePath: value.options.riskSignaturePath,
      },
      value.context,
    ),
    /signature is not valid/,
  );
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, {
      ...value.context,
      sourceRevisions: { ...value.context.sourceRevisions, bridge: revision("9") },
    }),
    /bridge revision does not match/,
  );
  const rolledBackCheckpoint = { ...value.checkpoint, lastSequence: "6" };
  const rolledBackBytes = `${stableJson(rolledBackCheckpoint)}\n`;
  await writeFile(join(root, "checkpoint.json"), rolledBackBytes, { mode: 0o600 });
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      { ...value.options, expectedCheckpointSha256: sha256(rolledBackBytes) },
      value.context,
    ),
    /replayed, rolled back or skips/,
  );
  const checkpointBytes = `${stableJson(value.checkpoint)}\n`;
  await writeFile(join(root, "checkpoint.json"), checkpointBytes, { mode: 0o600 });
  for (const [mutate, message] of [
    [(candidate) => (candidate.sequence = "7"), /replayed, rolled back or skips/],
    [(candidate) => (candidate.sequence = "9"), /replayed, rolled back or skips/],
    [
      (candidate) => (candidate.predecessorApprovalSha256 = hash("9")),
      /predecessor does not match/,
    ],
  ]) {
    const candidate = structuredClone(value.approval);
    mutate(candidate);
    const bytes = `${stableJson(candidate)}\n`;
    await writeFile(join(root, "approval.json"), bytes, { mode: 0o600 });
    await assert.rejects(
      inspectPilotCapApproval(root, value.options, {
        ...value.context,
        pilotCap: { ...value.context.pilotCap, capApprovalSha256: sha256(bytes) },
      }),
      message,
    );
  }
});

test("self-selected, aliased, stale and mutable inputs fail closed", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-files-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const policy = await readFile(join(root, "policy"), "utf8");
  const [risk] = policy.trim().split("\n");
  const aliased = `${risk}\n${risk.replace("postern-dex-pilot-risk", "postern-dex-pilot-security")}\n`;
  await writeFile(join(root, "aliased-policy"), aliased, { mode: 0o600 });
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      {
        ...value.options,
        authorityPolicyPath: "aliased-policy",
        expectedAuthorityPolicySha256: sha256(aliased),
      },
      value.context,
    ),
    /binds another authority policy|distinct keys/,
  );
  const stale = {
    ...value.approval,
    issuedAtUnixSeconds: Math.floor(Date.now() / 1000) - 1_000,
    expiresAtUnixSeconds: Math.floor(Date.now() / 1000) - 100,
  };
  const staleBytes = `${stableJson(stale)}\n`;
  await writeFile(join(root, "approval.json"), staleBytes, { mode: 0o600 });
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, {
      ...value.context,
      pilotCap: {
        ...value.context.pilotCap,
        capApprovalSha256: sha256(staleBytes),
      },
    }),
    /stale, premature or overlong/,
  );
  const originalBytes = `${stableJson(value.approval)}\n`;
  await writeFile(join(root, "approval.json"), originalBytes, { mode: 0o600 });
  await chmod(join(root, "approval.json"), 0o622);
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, value.context),
    /approval is unsafe/,
  );
  await chmod(join(root, "approval.json"), 0o600);
  await chmod(join(root, "checkpoint.json"), 0o622);
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, value.context),
    /checkpoint is unsafe/,
  );
  await chmod(join(root, "checkpoint.json"), 0o600);
  const replacement = { ...value.checkpoint, lastSequence: "6" };
  await writeFile(
    join(root, "checkpoint-replacement.json"),
    `${stableJson(replacement)}\n`,
    { mode: 0o600 },
  );
  await rename(join(root, "checkpoint-replacement.json"), join(root, "checkpoint.json"));
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, value.context),
    /checkpoint hash mismatch/,
  );
});

test("PATH substitution is ignored and always-success verifier substitution is refused", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-executable-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  await writeFile(join(root, "ssh-keygen"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    const report = await inspectPilotCapApproval(root, value.options, value.context);
    assert.equal(report.signatureCheckProcessesExitedZero, true);
    assert.equal(report.approvalAuthenticated, false);
  } finally {
    process.env.PATH = previousPath;
  }
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      {
        ...value.options,
        sshKeygenPath: join(root, "ssh-keygen"),
        expectedSshKeygenSha256: sha256("#!/bin/sh\nexit 0\n"),
      },
      value.context,
    ),
    /root-administered/,
  );
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      { ...value.options, expectedSshKeygenSha256: hash("9") },
      value.context,
    ),
    /executable hash mismatch/,
  );
  const truePath = "/usr/bin/true";
  const trueBytes = await readFile(truePath);
  await assert.rejects(
    inspectPilotCapApproval(
      root,
      {
        ...value.options,
        sshKeygenPath: truePath,
        expectedSshKeygenSha256: sha256(trueBytes),
      },
      value.context,
    ),
    /accepts an invalid negative probe/,
  );
});

test("verifier selection refuses relative, noncanonical and operator-managed paths", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-verifier-paths-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  for (const path of ["ssh-keygen", "/usr/bin/../bin/ssh-keygen", "/usr/bin/ssh-keygen/"]) {
    await assert.rejects(
      inspectPilotCapApproval(root, { ...value.options, sshKeygenPath: path }, value.context),
      /canonical and absolute/,
    );
  }
  const linked = join(root, "linked-ssh-keygen");
  await symlink(value.options.sshKeygenPath, linked);
  await assert.rejects(
    inspectPilotCapApproval(root, { ...value.options, sshKeygenPath: linked }, value.context),
    /root-administered immutable ancestors/,
  );
  await assert.rejects(
    inspectPilotCapApproval(root, { ...value.options, sshKeygenPath: "/usr/bin" }, value.context),
    /root-administered and immutable/,
  );
});

test("valid verifier refuses changed signatures and cannot replace both reviewers with one", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-invalid-signatures-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const risk = await readFile(join(root, "risk.sig"));
  await writeFile(join(root, "security.sig"), risk);
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, value.context),
    /postern-dex-pilot-security signature is not valid/,
  );
  await writeFile(join(root, "risk.sig"), "invalid signature\n");
  await assert.rejects(
    inspectPilotCapApproval(root, value.options, value.context),
    /postern-dex-pilot-risk signature is not valid/,
  );
});

test("atomic observation consumes once and retries idempotently without authentication", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-consume-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const first = await consumePilotCapCheckpointObservation(root, value.options, value.context);
  assert.equal(first.checkpointConsumedObservation, true);
  assert.equal(first.idempotentRetryObserved, false);
  assert.equal(first.crossProcessLockObserved, true);
  assert.equal(first.casAppliedObserved, true);
  assert.equal(first.durableFileFsyncObserved, true);
  assert.equal(first.durableRenameObserved, true);
  assert.equal(first.durableDirectoryFsyncObserved, true);
  assert.equal(first.replayProtectionAuthenticated, false);
  assert.equal(first.approvalAuthenticated, false);
  const retained = JSON.parse(await readFile(join(root, "checkpoint.json"), "utf8"));
  assert.equal(retained.lastSequence, value.approval.sequence);
  assert.equal(retained.lastApprovalSha256, value.context.pilotCap.capApprovalSha256);
  const retry = await consumePilotCapCheckpointObservation(root, value.options, value.context);
  assert.equal(retry.idempotentRetryObserved, true);
  assert.equal(retry.casAppliedObserved, false);
  assert.equal(retry.replayProtectionAuthenticated, false);
  await assert.rejects(lstat(join(root, "checkpoint.json.intent")), /ENOENT/);
  await assert.rejects(lstat(join(root, "checkpoint.json.lock")), /ENOENT/);
});

test("concurrent consumers serialize to one CAS and one idempotent result", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-concurrent-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const payload = { root, options: value.options, context: value.context };
  const results = await Promise.all([consumeInChild(payload), consumeInChild(payload)]);
  assert.equal(results.filter((result) => result.casAppliedObserved).length, 1);
  assert.equal(results.filter((result) => result.idempotentRetryObserved).length, 1);
  assert.ok(results.every((result) => result.approvalAuthenticated === false));
});

test("durable intent recovery completes a crash and corrupted intent fails closed", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const nextCheckpoint = {
    ...value.checkpoint,
    retainedAtUnixSeconds: Math.floor(Date.now() / 1000),
    lastSequence: value.approval.sequence,
    lastApprovalSha256: value.context.pilotCap.capApprovalSha256,
  };
  const nextBytes = `${stableJson(nextCheckpoint)}\n`;
  const intent = {
    schemaVersion: 1,
    domain: "postern.dex.pilot-cap-checkpoint-intent.v1",
    expectedCheckpointSha256: value.options.expectedCheckpointSha256,
    nextCheckpointSha256: sha256(nextBytes),
    approvalSha256: value.context.pilotCap.capApprovalSha256,
    nextCheckpoint,
  };
  await writeFile(
    join(root, "checkpoint.json.intent"),
    `${stableJson(intent)}\n`,
    { mode: 0o600 },
  );
  const recovered = await consumePilotCapCheckpointObservation(root, value.options, value.context);
  assert.equal(recovered.crashRecoveryPerformed, true);
  assert.equal(recovered.idempotentRetryObserved, true);
  assert.equal(recovered.approvalAuthenticated, false);

  const corruptRoot = await mkdtemp(join(testTemporaryDirectory, "postern-cap-corrupt-"));
  context.after(() => rm(corruptRoot, { recursive: true, force: true }));
  const corrupt = await fixture(corruptRoot);
  await writeFile(join(corruptRoot, "checkpoint.json.intent"), "{}\n", { mode: 0o600 });
  await assert.rejects(
    consumePilotCapCheckpointObservation(corruptRoot, corrupt.options, corrupt.context),
    /checkpoint intent fields are invalid/,
  );
  await assert.rejects(lstat(join(corruptRoot, "checkpoint.json.lock")), /ENOENT/);
});

test("stale dead-process locks recover while CAS digest mismatch fails closed", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-cap-stale-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const lock = join(root, "checkpoint.json.lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(
    join(lock, "owner.json"),
    `${stableJson({
      schemaVersion: 1,
      domain: "postern.dex.pilot-cap-checkpoint-lock.v1",
      pid: 99999999,
      createdAtUnixSeconds: Math.floor(Date.now() / 1000) - 60,
      nonce: "dead",
    })}\n`,
    { mode: 0o600 },
  );
  const recovered = await consumePilotCapCheckpointObservation(root, value.options, value.context);
  assert.equal(recovered.staleLockRecovered, true);
  assert.equal(recovered.approvalAuthenticated, false);

  const mismatchRoot = await mkdtemp(join(testTemporaryDirectory, "postern-cap-cas-mismatch-"));
  context.after(() => rm(mismatchRoot, { recursive: true, force: true }));
  const mismatch = await fixture(mismatchRoot);
  await assert.rejects(
    consumePilotCapCheckpointObservation(
      mismatchRoot,
      { ...mismatch.options, expectedCheckpointSha256: hash("9") },
      mismatch.context,
    ),
    /compare-and-swap digest mismatch/,
  );
});
