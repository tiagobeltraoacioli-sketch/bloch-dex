import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableJson } from "./manifest.mjs";
import { inspectPilotCapApproval } from "./pilot-cap-approval.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const revision = (byte) => byte.repeat(40);
const sha256 = (bytes) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
const NAMESPACE = "postern.dex.pilot-cap-approval.v1";

function command(args) {
  const result = spawnSync("ssh-keygen", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
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
  const approval = {
    schemaVersion: 1,
    domain: NAMESPACE,
    ceremonyId,
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
  for (const file of ["approval.json", "policy", "risk.sig", "security.sig"])
    await chmod(join(root, file), 0o600);
  return {
    approval,
    options: {
      approvalPath: "approval.json",
      authorityPolicyPath: "policy",
      expectedAuthorityPolicySha256: policySha256,
      expectedCeremonyId: ceremonyId,
      riskSignaturePath: "risk.sig",
      securitySignaturePath: "security.sig",
      sshKeygenPath,
      expectedSshKeygenSha256: sha256(sshKeygenBytes),
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
  const root = await mkdtemp(join(tmpdir(), "postern-cap-auth-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture(root);
  const report = await inspectPilotCapApproval(root, value.options, value.context);
  assert.equal(report.approvalSha256, value.context.pilotCap.capApprovalSha256);
  assert.equal(report.callerSuppliedAuthorityPolicySha256, value.options.expectedAuthorityPolicySha256);
  assert.equal(report.callerSuppliedCeremonyId, value.options.expectedCeremonyId);
  assert.equal(report.distinctPublicKeysObserved, true);
  assert.equal(report.signatureCheckProcessesExitedZero, true);
  assert.equal(report.verifierIdentityAuthenticated, false);
  assert.equal(report.authorityOrganizationsSeparated, false);
  assert.equal(report.replayProtectionAuthenticated, false);
  assert.equal(report.approvalAuthenticated, false);
  assert.equal("liquidityEnabled" in report, false);
});

test("policy, role and replay substitution fail closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-cap-attacks-"));
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
});

test("self-selected, aliased, stale and mutable inputs fail closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-cap-files-"));
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
});

test("PATH substitution is ignored and untrusted verifier observations never authenticate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-cap-executable-"));
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
  const untrustedObservation = await inspectPilotCapApproval(
    root,
    {
      ...value.options,
      sshKeygenPath: truePath,
      expectedSshKeygenSha256: sha256(trueBytes),
    },
    value.context,
  );
  assert.equal(untrustedObservation.signatureCheckProcessesExitedZero, true);
  assert.equal(untrustedObservation.verifierIdentityAuthenticated, false);
  assert.equal(untrustedObservation.approvalAuthenticated, false);
});
