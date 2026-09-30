import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "./manifest.mjs";
import { verifyDisposableCyclePackage } from "./disposable-cycle-package.mjs";

const testTemporaryDirectory = await realpath(tmpdir());

const hash = (byte) => `0x${byte.repeat(64)}`;
const revision = (byte) => byte.repeat(40);
const address = (byte) => `0x${byte.repeat(40)}`;
const templateUrl = new URL("../../deployments/disposable-cycle-request.template.json", import.meta.url);
const repository = resolve(dirname(fileURLToPath(templateUrl)), "..");
const cli = fileURLToPath(new URL("./check-disposable-cycle-package.mjs", import.meta.url));
const digest = (value) => `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function receipt(byte, blockNumber) {
  const receiptHash = (suffix) =>
    `0x${createHash("sha256").update(`${byte}-${suffix}`).digest("hex")}`;
  return {
    transactionHash: receiptHash("transaction"),
    blockNumber,
    blockHash: receiptHash("block"),
    finalizedBlockNumber: blockNumber + 5,
    finalizedBlockHash: receiptHash("finalized"),
  };
}

async function writeCanonical(root, name, value) {
  await writeFile(join(root, name), `${stableJson(value)}\n`, { mode: 0o600 });
}

async function complete(root, mutate = () => {}, evidenceMode = "synthetic-fixture") {
  const synthetic = evidenceMode === "synthetic-fixture";
  const value = {
    schemaVersion: 1,
    domain: "postern.dex.disposable-cycle-package.v1",
    evidenceMode,
    cycleId: hash("1"),
    revisions: {
      bridge: revision("2"),
      dex: revision("3"),
      l2: revision("4"),
      wallet: revision("5"),
    },
    chains: {
      sourceChainId: 1,
      sourceGenesisHash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      destinationChainId: 700771,
      destinationGenesisHash: hash("6"),
    },
    assets: {
      sourceTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      bridgeAssetAddress: address("7"),
      wrappedNativeAddress: address("8"),
      pilotPoolAddress: address("9"),
    },
    caps: {
      depositBaseUnits: "1000000",
      pilotBaseBaseUnits: "10000000000000000",
      pilotQuoteBaseUnits: "1000000",
    },
    stages: {},
    controls: {
      activationAuthorized: false,
      aggregatorExecutionEnabled: false,
      broadcastPerformed: false,
      liquidityAdded: false,
      liquidityEnabled: false,
    },
  };
  mutate("package", value);
  const deposit = {
    schema: "postern.dex.disposable-deposit.v1",
    synthetic,
    cycleId: value.cycleId,
    provenance: { repository: "bloch-l2-bridge", revision: value.revisions.bridge },
    sourceChainId: value.chains.sourceChainId,
    sourceGenesisHash: value.chains.sourceGenesisHash,
    sourceTokenAddress: value.assets.sourceTokenAddress,
    amountBaseUnits: "1000000",
    depositReceipt: receipt("a", 100),
  };
  mutate("deposit", deposit);
  value.stages.deposit = deposit;
  const l2Finality = {
    schema: "postern.dex.disposable-l2-finality.v1",
    synthetic,
    cycleId: value.cycleId,
    provenance: { repository: "bloch-l2-evm", revision: value.revisions.l2 },
    chainId: value.chains.destinationChainId,
    genesisHash: value.chains.destinationGenesisHash,
    depositDigest: digest(deposit),
    finalizedBlockNumber: 200,
    finalizedBlockHash: hash("d"),
    checkpointSha256: hash("e"),
    finalityVerified: true,
  };
  mutate("l2Finality", l2Finality);
  value.stages.l2Finality = l2Finality;
  const mintMapping = {
    schema: "postern.dex.disposable-mint-mapping.v1",
    synthetic,
    cycleId: value.cycleId,
    provenance: { repository: "bloch-l2-bridge", revision: value.revisions.bridge },
    chainId: value.chains.destinationChainId,
    genesisHash: value.chains.destinationGenesisHash,
    depositDigest: digest(deposit),
    finalityDigest: digest(l2Finality),
    sourceTokenAddress: value.assets.sourceTokenAddress,
    destinationTokenAddress: value.assets.bridgeAssetAddress,
    mintedBaseUnits: "1000000",
    mappingVerified: true,
    mintReceipt: receipt("f", 210),
  };
  mutate("mintMapping", mintMapping);
  value.stages.mintMapping = mintMapping;
  const pilotRoundTrip = {
    schema: "postern.dex.disposable-pilot-round-trip.v1",
    synthetic,
    cycleId: value.cycleId,
    provenance: { repository: "postern-dex", revision: value.revisions.dex },
    walletRevision: value.revisions.wallet,
    chainId: value.chains.destinationChainId,
    genesisHash: value.chains.destinationGenesisHash,
    mintDigest: digest(mintMapping),
    poolAddress: value.assets.pilotPoolAddress,
    baseTokenAddress: value.assets.wrappedNativeAddress,
    quoteTokenAddress: value.assets.bridgeAssetAddress,
    quoteInputBaseUnits: "100000",
    baseOutputBaseUnits: "1000000000000000",
    baseReturnInputBaseUnits: "1000000000000000",
    quoteReturnOutputBaseUnits: "99000",
    beforeCheckpointSha256: hash("1"),
    afterCheckpointSha256: hash("2"),
    outboundSwapReceipt: receipt("3", 220),
    returnSwapReceipt: receipt("6", 230),
    invariantVerified: true,
    executionWasDisposable: true,
    liquidityAdded: false,
  };
  mutate("pilotRoundTrip", pilotRoundTrip);
  value.stages.pilotRoundTrip = pilotRoundTrip;
  const burnReleaseRefund = {
    schema: "postern.dex.disposable-burn-release-refund.v1",
    synthetic,
    cycleId: value.cycleId,
    provenance: { repository: "bloch-l2-bridge", revision: value.revisions.bridge },
    pilotDigest: digest(pilotRoundTrip),
    burnedBaseUnits: "1000000",
    releasedBaseUnits: "900000",
    refundedBaseUnits: "90000",
    feesBaseUnits: "10000",
    burnReceipt: receipt("7", 240),
    releaseReceipt: receipt("8", 300),
    refundReceipt: receipt("9", 301),
    finalCheckpointSha256: hash("a"),
    reconciliationVerified: true,
  };
  mutate("burnReleaseRefund", burnReleaseRefund);
  value.stages.burnReleaseRefund = burnReleaseRefund;
  await writeCanonical(root, "cycle.json", value);
  return value;
}

test("checked-in request is canonical, pending and non-authorizing", async () => {
  const text = await readFile(templateUrl, "utf8");
  const value = JSON.parse(text);
  assert.equal(text, `${stableJson(value)}\n`);
  const report = await verifyDisposableCyclePackage(repository, "deployments/disposable-cycle-request.template.json");
  assert.equal(report.artifactContentsOpened, false);
  assert.equal(report.disposableCycleAuthenticated, false);
  assert.equal(report.readyForRealExecution, false);
  assert.equal(report.liquidityEnabled, false);
  assert.equal(report.activationAuthorized, false);
});

test("complete synthetic deposit-to-refund cycle composes without authenticating", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-disposable-cycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(root);
  const report = await verifyDisposableCyclePackage(root, "cycle.json");
  assert.equal(report.syntheticEvidence, true);
  assert.equal(report.artifactContentsOpened, true);
  assert.equal(report.declaredCycleConsistent, true);
  assert.equal(report.disposableCapsBounded, true);
  assert.equal(report.receiptsFinalizedDeclared, true);
  assert.equal(report.checkpointChainConsistent, true);
  assert.equal(report.reconciliationDeclared, true);
  assert.equal(report.externalTrustRootsConfigured, false);
  assert.equal(report.disposableCycleAuthenticated, false);
  assert.equal(report.readyForRealExecution, false);
  for (const field of ["liquidityEnabled", "liquidityAdded", "aggregatorExecutionEnabled", "activationAuthorized", "broadcastPerformed"])
    assert.equal(report[field], false);
});

test("structurally complete retained-real declarations still cannot authenticate themselves", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-disposable-real-declared-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(root, () => {}, "retained-real");
  const report = await verifyDisposableCyclePackage(root, "cycle.json");
  assert.equal(report.syntheticEvidence, false);
  assert.equal(report.declaredCycleConsistent, true);
  assert.equal(report.disposableCycleAuthenticated, false);
  assert.equal(report.readyForRealExecution, false);
});

test("cross-stage, cap, finality and reconciliation lies fail closed", async (context) => {
  const attacks = [
    ["deposit", (value) => (value.amountBaseUnits = "1000001")],
    ["deposit", (value) => (value.depositReceipt.finalizedBlockNumber = 99)],
    ["l2Finality", (value) => (value.finalityVerified = false)],
    ["l2Finality", (value) => (value.genesisHash = hash("f"))],
    ["mintMapping", (value) => (value.mintedBaseUnits = "999999")],
    ["mintMapping", (value) => (value.destinationTokenAddress = address("a"))],
    ["pilotRoundTrip", (value) => (value.baseReturnInputBaseUnits = "999")],
    ["pilotRoundTrip", (value) => (value.quoteInputBaseUnits = "1000001")],
    ["pilotRoundTrip", (value) => (value.liquidityAdded = true)],
    ["burnReleaseRefund", (value) => (value.burnedBaseUnits = "999999")],
    ["burnReleaseRefund", (value) => (value.refundedBaseUnits = "1")],
    ["package", (value) => (value.controls.activationAuthorized = true)],
  ];
  for (const [index, [stage, mutate]] of attacks.entries()) {
    const root = await mkdtemp(join(testTemporaryDirectory, `postern-disposable-attack-${index}-`));
    context.after(() => rm(root, { recursive: true, force: true }));
    await complete(root, (name, value) => {
      if (name === stage) mutate(value);
    });
    await assert.rejects(verifyDisposableCyclePackage(root, "cycle.json"), /disposable cycle:/);
  }
});

test("partial, mixed synthetic and substituted revisions fail closed", async (context) => {
  for (const mutate of [
    (value) => (value.stages.mintMapping = null),
    (value) => (value.stages.deposit.synthetic = false),
    (value) => (value.stages.deposit.provenance.revision = revision("f")),
    (value) => (value.stages.pilotRoundTrip.mintDigest = hash("f")),
    (value) => (value.stages.burnReleaseRefund.pilotDigest = hash("f")),
  ]) {
    const root = await mkdtemp(join(testTemporaryDirectory, "postern-disposable-substitution-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const value = await complete(root);
    mutate(value);
    await writeCanonical(root, "cycle.json", value);
    await assert.rejects(verifyDisposableCyclePackage(root, "cycle.json"), /disposable cycle:/);
  }
});

test("bounded reader and CLI fail closed", async (context) => {
  const root = await mkdtemp(join(testTemporaryDirectory, "postern-disposable-files-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await complete(root);
  await symlink(join(root, "cycle.json"), join(root, "link.json"));
  await assert.rejects(verifyDisposableCyclePackage(root, "link.json"), /symbolic link/);
  await chmod(join(root, "cycle.json"), 0o622);
  await assert.rejects(verifyDisposableCyclePackage(root, "cycle.json"), /unsafe/);
  const pending = spawnSync(process.execPath, [cli, "--package", "deployments/disposable-cycle-request.template.json"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).disposableCycleAuthenticated, false);
  const usage = spawnSync(process.execPath, [cli], { cwd: repository, encoding: "utf8" });
  assert.equal(usage.status, 2);
});
