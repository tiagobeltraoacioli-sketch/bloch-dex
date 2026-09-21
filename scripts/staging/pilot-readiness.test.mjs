import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sha256, stableJson } from "./manifest.mjs";
import {
  validatePilotReadinessBundle,
  readPilotReadinessBundle,
  verifyPilotReadiness,
} from "./pilot-readiness.mjs";

const execute = promisify(execFile);
const NOW = Math.floor(Date.now() / 1000);

const hash = (label) => `0x${createHash("sha256").update(label).digest("hex")}`;
const address = (suffix) => `0x${"00".repeat(19)}${suffix}`;
const contract = (suffix, label) => ({
  address: address(suffix),
  runtimeCodeHash: hash(label),
});

function configuration() {
  const wrapped = {
    ...contract("05", "wrapped-runtime"),
    symbol: "WBLCH",
    name: "Wrapped BLCH",
    decimals: 18,
    wrappedNative: true,
    policy: { feeOnTransfer: false, rebasing: false },
  };
  const busdc = {
    ...contract("06", "busdc-runtime"),
    symbol: "bUSDC",
    name: "Bloch USDC",
    decimals: 6,
    wrappedNative: false,
    policy: { feeOnTransfer: false, rebasing: false },
  };
  return {
    schemaVersion: 4,
    environment: "staging",
    host: "bloch-dex",
    frontendMode: "preview",
    liquidityEnabled: false,
    chain: {
      id: 700771,
      genesisHash: hash("genesis"),
      rpcUrl: "https://rpc.invalid/",
    },
    deployment: {
      blockNumber: 12,
      blockHash: hash("deployment-block"),
      pairInitCodeHash: hash("pair-init"),
      factory: contract("01", "factory-runtime"),
      router: contract("02", "router-runtime"),
      lens: contract("03", "lens-runtime"),
      collector: contract("04", "collector-runtime"),
      wrappedNative: {
        address: wrapped.address,
        runtimeCodeHash: wrapped.runtimeCodeHash,
      },
      feeAuthority: contract("07", "fee-authority-identity"),
      treasury: contract("08", "treasury-identity"),
    },
    tokens: [wrapped, busdc],
    assetPlan: {
      blochL1: {
        nativeSymbol: "BLCH",
        evmExecution: false,
        authorizationBoundary: "external-post-quantum",
      },
      bridgeAsset: {
        sourceChain: "ethereum-mainnet",
        sourceChainId: 1,
        sourceSymbol: "USDC",
        sourceTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        destinationSymbol: "bUSDC",
        destinationTokenAddress: busdc.address,
      },
      pilotPool: {
        baseSymbol: "BLCH",
        onchainBaseSymbol: "WBLCH",
        quoteSymbol: "bUSDC",
        liquidityEnabled: false,
        maxBaseBaseUnits: "1000000000000000000",
        maxQuoteBaseUnits: "1000000",
        policyCapApproval: {
          path: "approvals/pilot-cap.json",
          sha256: hash("cap-approval"),
        },
        requiresSeparateApproval: true,
      },
    },
  };
}

function observation(config) {
  return {
    schemaVersion: 1,
    domain: "postern.dex.staging-rpc-observation.v1",
    configurationSha256: `0x${sha256(stableJson(config))}`,
    chainId: config.chain.id,
    genesisHash: config.chain.genesisHash,
    snapshot: { number: 12, hash: config.deployment.blockHash },
    finalizedBefore: { number: 20, hash: hash("finalized-20") },
    finalizedAfter: { number: 21, hash: hash("finalized-21") },
    identities: [
      [config.deployment.factory, ["deployment.factory"]],
      [config.deployment.router, ["deployment.router"]],
      [config.deployment.lens, ["deployment.lens"]],
      [config.deployment.collector, ["deployment.collector"]],
      [
        config.deployment.wrappedNative,
        ["deployment.wrappedNative", "tokens[0]"],
      ],
      [config.deployment.feeAuthority, ["deployment.feeAuthority"]],
      [config.deployment.treasury, ["deployment.treasury"]],
      [config.tokens[1], ["tokens[1]"]],
    ].map(([identity, labels]) => ({
      address: identity.address,
      runtimeCodeHash: identity.runtimeCodeHash,
      codeBytes: 5,
      labels,
    })),
  };
}

function fixture() {
  const config = configuration();
  const rpc = observation(config);
  const bridge = {
    schema: "postern.bridge-activation-readiness-verification.v1",
    manifestCanonicalSha256: hash("bridge-manifest"),
    routeId: hash("bridge-route"),
    verifierSha256: hash("bridge-verifier"),
    readinessCommitmentSha256: hash("bridge-readiness"),
    settlementVerified: true,
    custodyAuthoritiesVerified: true,
    pausedDeploymentVerified: true,
    disposableCycleVerified: true,
    activationAuthorized: true,
    mintAuthorized: true,
    releaseAuthorized: true,
    bridgeReady: true,
    broadcastPerformed: false,
  };
  const bridgeActivationReceipt = {
    schema: "postern.bridge-activation-receipt.v1",
    routeId: bridge.routeId,
    readinessCommitmentSha256: bridge.readinessCommitmentSha256,
    sourceGenesisHash:
      "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
    sourceActivationTransactionHash: hash("source-activation-transaction"),
    sourceActivationBlockNumber: 100,
    sourceActivationBlockHash: hash("source-activation-block"),
    sourceFinalizedBlockNumber: 110,
    sourceFinalizedBlockHash: hash("source-finalized-block"),
    nativeGenesisHash:
      "0x9953da73a2794e190b1c551a787f39d6486a288f40b69ecc361281d5a893e415",
    nativeActivationTransactionId: hash("native-activation-transaction"),
    nativeActivationHeight: 200,
    nativeActivationRoot: hash("native-activation-root"),
    nativeFinalizedHeight: 210,
    nativeFinalizedRoot: hash("native-finalized-root"),
    activatedAtUnixSeconds: NOW - 120,
    issuedAtUnixSeconds: NOW - 60,
    expiresAtUnixSeconds: NOW + 600,
    sourceCanonical: true,
    sourceFinalized: true,
    nativeCanonical: true,
    nativeFinalized: true,
    depositsOperational: true,
    mintOperational: true,
    releasesOperational: true,
    paused: false,
    activationPerformed: true,
    bridgeOperational: true,
  };
  const control = {
    configurationSha256: `0x${sha256(stableJson(config))}`,
    rpcObservationSha256: `0x${sha256(stableJson(rpc))}`,
    artifactManifestSha256: hash("artifact-manifest"),
    sourceRevision: "12".repeat(20),
    frontendMode: "preview",
    liquidityEnabled: false,
    liveExecutionEnabled: false,
    protocolFeesEnabled: false,
    pendingFeeAuthorityTransfer: false,
    deploymentAuthenticated: true,
  };
  const pool = {
    inspectionBlockNumber: 20,
    inspectionBlockHash: hash("inspection-block"),
    finalizedBlockNumber: 21,
    finalizedBlockHash: hash("inspection-finalized"),
    factoryAddress: config.deployment.factory.address,
    pairAddress: address("09"),
    pairRuntimeCodeHash: hash("pair-runtime"),
    token0: config.tokens[0].address,
    token1: config.tokens[1].address,
    forwardRegistryPair: address("09"),
    reverseRegistryPair: address("09"),
    factoryPairCount: 1,
    pilotPairCount: 1,
    reserve0: "0",
    reserve1: "0",
    balance0: "0",
    balance1: "0",
    totalSupply: "0",
    capApprovalSha256: config.assetPlan.pilotPool.policyCapApproval.sha256,
    inspectionCommitmentSha256: "",
    pairIdentityVerified: true,
    empty: true,
  };
  const { inspectionCommitmentSha256: _, ...poolEvidence } = pool;
  pool.inspectionCommitmentSha256 = `0x${sha256(stableJson(poolEvidence))}`;
  const rehearsal = {
    environment: "isolated-finalized-fork",
    forkBlockNumber: pool.inspectionBlockNumber,
    forkBlockHash: pool.inspectionBlockHash,
    baseAmount: "100000000000000000",
    quoteAmount: "100000",
    baseMinimum: "99000000000000000",
    quoteMinimum: "99000",
    recipient: config.deployment.treasury.address,
    deadlineSeconds: 300,
    participantBaseBefore: "1000000000000000000",
    participantBaseAfter: "1000000000000000000",
    participantQuoteBefore: "1000000",
    participantQuoteAfter: "1000000",
    pairReserve0Before: "0",
    pairReserve0After: "0",
    pairReserve1Before: "0",
    pairReserve1After: "0",
    pairSupplyBefore: "0",
    pairSupplyAfter: "0",
    wrapVerified: true,
    addLiquidityVerified: true,
    swapVerified: true,
    removeLiquidityVerified: true,
    invariantVerified: true,
    snapshotRollbackVerified: true,
    reconciled: true,
    broadcastPerformed: false,
    persistentStateChanged: false,
    artifactSha256: hash("rehearsal-artifact"),
    performedAtUnixSeconds: NOW - 30,
  };
  const authorities = {
    feeAuthorityAddress: config.deployment.feeAuthority.address,
    treasuryAddress: config.deployment.treasury.address,
    bridgeRouteId: bridge.routeId,
    bridgeReadinessCommitmentSha256: bridge.readinessCommitmentSha256,
    bridgeActivationReceiptSha256: `0x${sha256(
      stableJson(bridgeActivationReceipt),
    )}`,
    capApprovalSha256: config.assetPlan.pilotPool.policyCapApproval.sha256,
    deploymentArtifactManifestSha256: control.artifactManifestSha256,
    deploymentApprovalSha256: hash("deployment-approval"),
    poolInspectionCommitmentSha256: pool.inspectionCommitmentSha256,
    poolApprovalSha256: hash("pool-approval"),
    rehearsalArtifactSha256: rehearsal.artifactSha256,
    rehearsalApprovalSha256: hash("rehearsal-approval"),
    activationApprovalSha256: hash("activation-approval"),
    approvalBlockNumber: pool.finalizedBlockNumber,
    observedBlockNumber: pool.finalizedBlockNumber + 1,
    validUntilBlockNumber: pool.finalizedBlockNumber + 100,
    decision: "approve-one-capped-pilot-liquidity-ceremony",
    authenticated: true,
  };
  return {
    schemaVersion: 1,
    domain: "postern.dex.pilot-readiness.v1",
    deploymentConfiguration: config,
    rpcObservation: rpc,
    bridgeReadiness: bridge,
    bridgeActivationReceipt,
    deploymentControl: control,
    pilotPool: pool,
    rehearsal,
    authorities,
  };
}

async function verifier(directory, behavior = "accept") {
  const path = join(directory, `verifier-${behavior}`);
  let decision =
    "console.log(createHash('sha256').update(input).digest('hex'));";
  if (behavior === "wrong") decision = "console.log('00'.repeat(32));";
  if (behavior === "refuse") decision = "process.exit(1);";
  await writeFile(
    path,
    `#!${process.execPath}\nimport { createHash } from 'node:crypto';\nlet chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); const input=Buffer.concat(chunks); ${decision}\n`,
    { mode: 0o500, flag: "wx" },
  );
  const pin = `0x${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
  return { path, pin };
}

test("authenticates complete readiness without enabling or adding liquidity", async () => {
  const bundle = fixture();
  const before = structuredClone(bundle);
  const root = await mkdtemp(join(tmpdir(), "postern-pilot-readiness-"));
  const executable = await verifier(root);
  const report = await verifyPilotReadiness(bundle, {
    verifierPath: executable.path,
    verifierSha256: executable.pin,
  });
  assert.deepEqual(bundle, before);
  assert.equal(
    report.evaluatedAtUnixSeconds <= report.validUntilUnixSeconds,
    true,
  );
  assert.equal(
    report.validUntilBlockNumber,
    bundle.authorities.validUntilBlockNumber,
  );
  for (const field of [
    "bridgeReady",
    "bridgeOperationalVerified",
    "disabledDeploymentVerified",
    "singleEmptyPilotPoolVerified",
    "authoritiesVerified",
    "rehearsalReconciled",
    "pilotLiquidityCeremonyAuthorized",
  ])
    assert.equal(report[field], true);
  for (const field of [
    "liquidityEnabled",
    "liquidityAdded",
    "activationPerformed",
    "broadcastPerformed",
  ])
    assert.equal(report[field], false);
});

test("missing, unknown and premature claims fail closed", () => {
  for (const mutate of [
    (value) => delete value.bridgeReadiness,
    (value) => (value.unknown = true),
    (value) => (value.bridgeReadiness.bridgeReady = false),
    (value) => (value.bridgeReadiness.broadcastPerformed = true),
    (value) => (value.bridgeActivationReceipt.activationPerformed = false),
    (value) => (value.deploymentControl.liquidityEnabled = true),
    (value) => (value.deploymentControl.liveExecutionEnabled = true),
    (value) => (value.deploymentControl.protocolFeesEnabled = true),
    (value) => (value.deploymentControl.pendingFeeAuthorityTransfer = true),
    (value) => (value.deploymentControl.deploymentAuthenticated = false),
    (value) => (value.pilotPool.empty = false),
    (value) => (value.authorities.authenticated = false),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validatePilotReadinessBundle(value),
      /pilot readiness:/,
    );
  }
});

test("cross-artifact substitution, additional pools and funded state fail closed", () => {
  for (const mutate of [
    (value) => (value.rpcObservation.chainId = 84001),
    (value) =>
      (value.rpcObservation.configurationSha256 = hash("other-config")),
    (value) => (value.rpcObservation.identities[0].address = address("0a")),
    (value) => (value.rpcObservation.identities[0].codeBytes = 0),
    (value) => (value.pilotPool.factoryAddress = address("0a")),
    (value) => (value.pilotPool.token0 = address("0a")),
    (value) => (value.pilotPool.reverseRegistryPair = address("0a")),
    (value) => {
      value.pilotPool.finalizedBlockNumber =
        value.pilotPool.inspectionBlockNumber;
      value.pilotPool.finalizedBlockHash = hash("same-height-fork");
    },
    (value) => (value.pilotPool.factoryPairCount = 2),
    (value) => (value.pilotPool.pilotPairCount = 2),
    (value) => (value.pilotPool.reserve0 = "1"),
    (value) => (value.pilotPool.balance1 = "1"),
    (value) => (value.pilotPool.totalSupply = "1"),
    (value) => (value.pilotPool.capApprovalSha256 = hash("other-cap")),
    (value) => (value.authorities.bridgeRouteId = hash("other-route")),
    (value) =>
      (value.authorities.poolInspectionCommitmentSha256 = hash("other-pool")),
    (value) => (value.authorities.observedBlockNumber += 33),
    (value) =>
      (value.authorities.activationApprovalSha256 =
        value.authorities.poolApprovalSha256),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validatePilotReadinessBundle(value),
      /pilot readiness:/,
    );
  }
});

test("bridge must be activated, operational, fresh and on the reviewed forks", () => {
  for (const mutate of [
    (value) => (value.bridgeActivationReceipt.routeId = hash("other-route")),
    (value) =>
      (value.bridgeActivationReceipt.readinessCommitmentSha256 =
        hash("other-readiness")),
    (value) =>
      (value.bridgeActivationReceipt.sourceGenesisHash = hash("source-fork")),
    (value) =>
      (value.bridgeActivationReceipt.nativeGenesisHash = hash("native-fork")),
    (value) => (value.bridgeActivationReceipt.sourceFinalizedBlockNumber = 99),
    (value) => (value.bridgeActivationReceipt.nativeFinalizedHeight = 199),
    (value) => (value.bridgeActivationReceipt.sourceCanonical = false),
    (value) => (value.bridgeActivationReceipt.nativeFinalized = false),
    (value) => (value.bridgeActivationReceipt.depositsOperational = false),
    (value) => (value.bridgeActivationReceipt.mintOperational = false),
    (value) => (value.bridgeActivationReceipt.releasesOperational = false),
    (value) => (value.bridgeActivationReceipt.paused = true),
    (value) => (value.bridgeActivationReceipt.bridgeOperational = false),
    (value) => (value.bridgeActivationReceipt.expiresAtUnixSeconds = NOW),
    (value) =>
      (value.bridgeActivationReceipt.expiresAtUnixSeconds =
        value.bridgeActivationReceipt.issuedAtUnixSeconds + 901),
    (value) => (value.rehearsal.performedAtUnixSeconds = NOW - 61),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validatePilotReadinessBundle(value, NOW),
      /pilot readiness:/,
    );
  }
});

test("rehearsal is capped, isolated, fully exercised and balance-neutral", () => {
  for (const mutate of [
    (value) => (value.rehearsal.environment = "mainnet"),
    (value) => (value.rehearsal.baseAmount = "1000000000000000001"),
    (value) => (value.rehearsal.quoteAmount = "1000001"),
    (value) => (value.rehearsal.baseMinimum = "100000000000000001"),
    (value) => (value.rehearsal.deadlineSeconds = 901),
    (value) => (value.rehearsal.participantQuoteAfter = "999999"),
    (value) => (value.rehearsal.pairReserve0After = "1"),
    (value) => (value.rehearsal.swapVerified = false),
    (value) => (value.rehearsal.invariantVerified = false),
    (value) => (value.rehearsal.broadcastPerformed = true),
    (value) => (value.rehearsal.persistentStateChanged = true),
    (value) => (value.rehearsal.recipient = address("0a")),
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validatePilotReadinessBundle(value),
      /pilot readiness:/,
    );
  }
});

test("wrong, writable, symlinked and refusing verifiers fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "postern-pilot-verifier-test-"));
  const accepted = await verifier(root);
  await assert.rejects(
    verifyPilotReadiness(fixture(), {
      verifierPath: accepted.path,
      verifierSha256: hash("wrong-pin"),
    }),
    /pin mismatch/,
  );
  const wrong = await verifier(root, "wrong");
  await assert.rejects(
    verifyPilotReadiness(fixture(), {
      verifierPath: wrong.path,
      verifierSha256: wrong.pin,
    }),
    /invalid decision/,
  );
  const refused = await verifier(root, "refuse");
  await assert.rejects(
    verifyPilotReadiness(fixture(), {
      verifierPath: refused.path,
      verifierSha256: refused.pin,
    }),
    /refused the bundle/,
  );
  await chmod(accepted.path, 0o522);
  await assert.rejects(
    verifyPilotReadiness(fixture(), {
      verifierPath: accepted.path,
      verifierSha256: accepted.pin,
    }),
    /unsafe/,
  );
  const link = join(root, "verifier-link");
  await symlink(wrong.path, link);
  await assert.rejects(
    verifyPilotReadiness(fixture(), {
      verifierPath: link,
      verifierSha256: wrong.pin,
    }),
    /unsafe/,
  );
});

test("bundle reader requires a bounded canonical stable regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "postern-pilot-bundle-test-"));
  const path = join(root, "bundle.json");
  const canonical = `${stableJson(fixture())}\n`;
  await writeFile(path, canonical, { mode: 0o600, flag: "wx" });
  assert.deepEqual(await readPilotReadinessBundle(path), fixture());

  await writeFile(path, JSON.stringify(fixture(), null, 2));
  await assert.rejects(readPilotReadinessBundle(path), /not canonical JSON/);
  await writeFile(path, canonical);
  await chmod(path, 0o622);
  await assert.rejects(readPilotReadinessBundle(path), /file is unsafe/);

  const link = join(root, "bundle-link.json");
  await symlink(path, link);
  await assert.rejects(readPilotReadinessBundle(link), /file is unsafe/);

  const oversized = join(root, "oversized.json");
  await writeFile(oversized, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(readPilotReadinessBundle(oversized), /file is unsafe/);
});

test("CLI returns false capabilities on refusal and writes no state", async () => {
  const root = await mkdtemp(join(tmpdir(), "postern-pilot-cli-test-"));
  const bundlePath = join(root, "bundle.json");
  await writeFile(bundlePath, `${stableJson(fixture())}\n`, { mode: 0o600 });
  const executable = await verifier(root);
  const cli = new URL("./check-pilot-readiness.mjs", import.meta.url);
  const before = (await readdir(root)).sort();
  const success = await execute(
    process.execPath,
    [
      cli.pathname,
      "--bundle",
      bundlePath,
      "--verifier",
      executable.path,
      "--verifier-sha256",
      executable.pin,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    JSON.parse(success.stdout).pilotLiquidityCeremonyAuthorized,
    true,
  );
  assert.deepEqual((await readdir(root)).sort(), before);
  await assert.rejects(
    execute(
      process.execPath,
      [
        cli.pathname,
        "--bundle",
        bundlePath,
        "--verifier",
        executable.path,
        "--verifier-sha256",
        hash("wrong"),
      ],
      { encoding: "utf8" },
    ),
    (error) => {
      const refusal = JSON.parse(error.stderr);
      for (const field of [
        "bridgeReady",
        "bridgeOperationalVerified",
        "disabledDeploymentVerified",
        "singleEmptyPilotPoolVerified",
        "authoritiesVerified",
        "rehearsalReconciled",
        "pilotLiquidityCeremonyAuthorized",
        "liquidityEnabled",
        "liquidityAdded",
        "activationPerformed",
        "broadcastPerformed",
      ])
        assert.equal(refusal[field], false);
      return true;
    },
  );
});
