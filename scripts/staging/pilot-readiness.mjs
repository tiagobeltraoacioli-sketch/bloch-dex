import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256, stableJson, validateStagingConfig } from "./manifest.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DOMAIN = "POSTERN_DEX_PILOT_READINESS_V1\n";
const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_VERIFIER_BYTES = 64 * 1024 * 1024;
const MAX_DEADLINE_SECONDS = 15 * 60;
const MAX_RECEIPT_SECONDS = 15 * 60;
const ETHEREUM_GENESIS =
  "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3";
const BLOCH_GENESIS =
  "0x9953da73a2794e190b1c551a787f39d6486a288f40b69ecc361281d5a893e415";
const CONTRACT_NAMES = [
  "factory",
  "router",
  "lens",
  "collector",
  "wrappedNative",
];
const ROLE_NAMES = ["feeAuthority", "treasury"];

function fail(message) {
  throw new Error(`pilot readiness: ${message}`);
}

function required(condition, message) {
  if (!condition) fail(message);
}

function exactKeys(value, keys, field) {
  required(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${field} must be a plain object`,
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

function address(value, field) {
  required(
    ADDRESS.test(value) && !/^0x0{40}$/.test(value),
    `${field} is invalid`,
  );
  return value;
}

function decimal(value, field, { positive = false } = {}) {
  required(
    typeof value === "string" && DECIMAL.test(value) && value.length <= 78,
    `${field} is not a canonical integer`,
  );
  const parsed = BigInt(value);
  required(!positive || parsed > 0n, `${field} must be positive`);
  return parsed;
}

function boolean(value, expected, field) {
  required(value === expected, `${field} must equal ${expected}`);
}

function expectedIdentities(config) {
  const identities = new Map();
  const add = (label, value) => {
    const key = value.address.toLowerCase();
    const prior = identities.get(key);
    if (prior) {
      required(
        prior.runtimeCodeHash === value.runtimeCodeHash,
        `configuration has conflicting identity ${key}`,
      );
      prior.labels.push(label);
    } else {
      identities.set(key, {
        address: key,
        runtimeCodeHash: value.runtimeCodeHash,
        labels: [label],
      });
    }
  };
  for (const name of CONTRACT_NAMES)
    add(`deployment.${name}`, config.deployment[name]);
  for (const name of ROLE_NAMES)
    add(`deployment.${name}`, config.deployment[name]);
  config.tokens.forEach((token, index) => add(`tokens[${index}]`, token));
  return identities;
}

function validateRpcObservation(config, observation) {
  exactKeys(
    observation,
    [
      "schemaVersion",
      "domain",
      "configurationSha256",
      "chainId",
      "genesisHash",
      "snapshot",
      "finalizedBefore",
      "finalizedAfter",
      "identities",
    ],
    "RPC observation",
  );
  required(
    observation.schemaVersion === 1 &&
      observation.domain === "postern.dex.staging-rpc-observation.v1",
    "RPC observation schema is unsupported",
  );
  required(
    observation.configurationSha256 === `0x${sha256(stableJson(config))}`,
    "RPC observation binds another configuration",
  );
  required(
    observation.chainId === config.chain.id &&
      observation.genesisHash === config.chain.genesisHash,
    "RPC observation binds another chain",
  );
  for (const [field, block] of [
    ["snapshot", observation.snapshot],
    ["finalizedBefore", observation.finalizedBefore],
    ["finalizedAfter", observation.finalizedAfter],
  ]) {
    exactKeys(block, ["number", "hash"], `RPC observation ${field}`);
    required(
      Number.isSafeInteger(block.number) && block.number >= 0,
      `RPC observation ${field} number is invalid`,
    );
    hash(block.hash, `RPC observation ${field} hash`);
  }
  required(
    observation.snapshot.number === config.deployment.blockNumber &&
      observation.snapshot.hash === config.deployment.blockHash,
    "RPC snapshot does not match deployment",
  );
  required(
    observation.finalizedBefore.number >= observation.snapshot.number &&
      observation.finalizedAfter.number >= observation.finalizedBefore.number,
    "RPC deployment is not durably finalized",
  );
  if (observation.finalizedAfter.number === observation.finalizedBefore.number)
    required(
      observation.finalizedAfter.hash === observation.finalizedBefore.hash,
      "RPC finalized hash changed at the same height",
    );

  const expected = expectedIdentities(config);
  required(
    Array.isArray(observation.identities) &&
      observation.identities.length === expected.size,
    "RPC observation identity count is invalid",
  );
  const seen = new Set();
  for (const item of observation.identities) {
    exactKeys(
      item,
      ["address", "runtimeCodeHash", "codeBytes", "labels"],
      "RPC identity",
    );
    const identity = expected.get(
      address(item.address, "RPC identity address"),
    );
    required(
      identity && !seen.has(item.address),
      "RPC identity is unexpected or repeated",
    );
    seen.add(item.address);
    required(
      item.runtimeCodeHash === identity.runtimeCodeHash &&
        Number.isSafeInteger(item.codeBytes) &&
        item.codeBytes > 0 &&
        Array.isArray(item.labels) &&
        stableJson([...item.labels].sort()) ===
          stableJson([...identity.labels].sort()),
      "RPC identity does not match a deployed contract",
    );
  }
}

function validateBridgeReadiness(report) {
  exactKeys(
    report,
    [
      "schema",
      "manifestCanonicalSha256",
      "routeId",
      "verifierSha256",
      "readinessCommitmentSha256",
      "settlementVerified",
      "custodyAuthoritiesVerified",
      "pausedDeploymentVerified",
      "disposableCycleVerified",
      "activationAuthorized",
      "mintAuthorized",
      "releaseAuthorized",
      "bridgeReady",
      "broadcastPerformed",
    ],
    "bridge readiness",
  );
  required(
    report.schema === "postern.bridge-activation-readiness-verification.v1",
    "bridge readiness schema is unsupported",
  );
  for (const field of [
    "manifestCanonicalSha256",
    "routeId",
    "verifierSha256",
    "readinessCommitmentSha256",
  ])
    hash(report[field], `bridge readiness ${field}`);
  for (const field of [
    "settlementVerified",
    "custodyAuthoritiesVerified",
    "pausedDeploymentVerified",
    "disposableCycleVerified",
    "activationAuthorized",
    "mintAuthorized",
    "releaseAuthorized",
    "bridgeReady",
  ])
    boolean(report[field], true, `bridge readiness ${field}`);
  boolean(
    report.broadcastPerformed,
    false,
    "bridge readiness broadcastPerformed",
  );
}

function validateBridgeActivationReceipt(readiness, receipt, atUnixSeconds) {
  exactKeys(
    receipt,
    [
      "schema",
      "routeId",
      "readinessCommitmentSha256",
      "sourceGenesisHash",
      "sourceActivationTransactionHash",
      "sourceActivationBlockNumber",
      "sourceActivationBlockHash",
      "sourceFinalizedBlockNumber",
      "sourceFinalizedBlockHash",
      "nativeGenesisHash",
      "nativeActivationTransactionId",
      "nativeActivationHeight",
      "nativeActivationRoot",
      "nativeFinalizedHeight",
      "nativeFinalizedRoot",
      "activatedAtUnixSeconds",
      "issuedAtUnixSeconds",
      "expiresAtUnixSeconds",
      "sourceCanonical",
      "sourceFinalized",
      "nativeCanonical",
      "nativeFinalized",
      "depositsOperational",
      "mintOperational",
      "releasesOperational",
      "paused",
      "activationPerformed",
      "bridgeOperational",
    ],
    "bridge activation receipt",
  );
  required(
    receipt.schema === "postern.bridge-activation-receipt.v1" &&
      receipt.routeId === readiness.routeId &&
      receipt.readinessCommitmentSha256 === readiness.readinessCommitmentSha256,
    "bridge activation receipt binds another readiness decision",
  );
  required(
    receipt.sourceGenesisHash === ETHEREUM_GENESIS &&
      receipt.nativeGenesisHash === BLOCH_GENESIS,
    "bridge activation receipt binds another source or native fork",
  );
  for (const field of [
    "sourceActivationTransactionHash",
    "sourceActivationBlockHash",
    "sourceFinalizedBlockHash",
    "nativeActivationTransactionId",
    "nativeActivationRoot",
    "nativeFinalizedRoot",
  ])
    hash(receipt[field], `bridge activation receipt ${field}`);
  for (const field of [
    "sourceActivationBlockNumber",
    "sourceFinalizedBlockNumber",
    "nativeActivationHeight",
    "nativeFinalizedHeight",
    "activatedAtUnixSeconds",
    "issuedAtUnixSeconds",
    "expiresAtUnixSeconds",
  ])
    required(
      Number.isSafeInteger(receipt[field]) && receipt[field] > 0,
      `bridge activation receipt ${field} is invalid`,
    );
  required(
    receipt.sourceFinalizedBlockNumber >= receipt.sourceActivationBlockNumber &&
      receipt.nativeFinalizedHeight >= receipt.nativeActivationHeight,
    "bridge activation is not finalized in both domains",
  );
  required(
    receipt.activatedAtUnixSeconds <= receipt.issuedAtUnixSeconds &&
      receipt.issuedAtUnixSeconds <= atUnixSeconds + 300 &&
      receipt.expiresAtUnixSeconds > atUnixSeconds &&
      receipt.expiresAtUnixSeconds > receipt.issuedAtUnixSeconds &&
      receipt.expiresAtUnixSeconds - receipt.issuedAtUnixSeconds <=
        MAX_RECEIPT_SECONDS,
    "bridge activation receipt is stale, future-dated or overlong",
  );
  for (const field of [
    "sourceCanonical",
    "sourceFinalized",
    "nativeCanonical",
    "nativeFinalized",
    "depositsOperational",
    "mintOperational",
    "releasesOperational",
    "activationPerformed",
    "bridgeOperational",
  ])
    boolean(receipt[field], true, `bridge activation receipt ${field}`);
  boolean(receipt.paused, false, "bridge activation receipt paused");
}

function validateDeploymentControl(config, observation, control) {
  exactKeys(
    control,
    [
      "configurationSha256",
      "rpcObservationSha256",
      "artifactManifestSha256",
      "sourceRevision",
      "frontendMode",
      "liquidityEnabled",
      "liveExecutionEnabled",
      "protocolFeesEnabled",
      "pendingFeeAuthorityTransfer",
      "deploymentAuthenticated",
    ],
    "deployment control",
  );
  required(
    control.configurationSha256 === `0x${sha256(stableJson(config))}` &&
      control.rpcObservationSha256 === `0x${sha256(stableJson(observation))}`,
    "deployment control binds another configuration or RPC observation",
  );
  hash(control.artifactManifestSha256, "artifact manifest hash");
  required(REVISION.test(control.sourceRevision), "source revision is invalid");
  required(
    control.frontendMode === "preview",
    "frontend must remain preview-only",
  );
  for (const field of [
    "liquidityEnabled",
    "liveExecutionEnabled",
    "protocolFeesEnabled",
    "pendingFeeAuthorityTransfer",
  ])
    boolean(control[field], false, `deployment control ${field}`);
  boolean(
    control.deploymentAuthenticated,
    true,
    "deployment control deploymentAuthenticated",
  );
}

function pilotTokens(config) {
  const base = config.tokens.find((token) => token.symbol === "WBLCH");
  const quote = config.tokens.find((token) => token.symbol === "bUSDC");
  required(base && quote, "pilot tokens are unavailable");
  return { base, quote };
}

function validatePool(config, observation, pool) {
  exactKeys(
    pool,
    [
      "inspectionBlockNumber",
      "inspectionBlockHash",
      "finalizedBlockNumber",
      "finalizedBlockHash",
      "factoryAddress",
      "pairAddress",
      "pairRuntimeCodeHash",
      "token0",
      "token1",
      "forwardRegistryPair",
      "reverseRegistryPair",
      "factoryPairCount",
      "pilotPairCount",
      "reserve0",
      "reserve1",
      "balance0",
      "balance1",
      "totalSupply",
      "capApprovalSha256",
      "inspectionCommitmentSha256",
      "pairIdentityVerified",
      "empty",
    ],
    "pilot pool",
  );
  required(
    Number.isSafeInteger(pool.inspectionBlockNumber) &&
      pool.inspectionBlockNumber >= observation.snapshot.number &&
      Number.isSafeInteger(pool.finalizedBlockNumber) &&
      pool.finalizedBlockNumber >= pool.inspectionBlockNumber,
    "pilot pool inspection is not finalized",
  );
  hash(pool.inspectionBlockHash, "pilot pool inspection hash");
  hash(pool.finalizedBlockHash, "pilot pool finalized hash");
  if (pool.finalizedBlockNumber === pool.inspectionBlockNumber)
    required(
      pool.finalizedBlockHash === pool.inspectionBlockHash,
      "pilot pool finalized hash changed at the inspection height",
    );
  hash(pool.pairRuntimeCodeHash, "pilot pair runtime hash");
  required(
    pool.factoryAddress === config.deployment.factory.address,
    "pilot pool binds another factory",
  );
  address(pool.pairAddress, "pilot pair address");
  const { base, quote } = pilotTokens(config);
  const sorted = [base.address, quote.address].sort();
  required(
    pool.token0 === sorted[0] &&
      pool.token1 === sorted[1] &&
      pool.forwardRegistryPair === pool.pairAddress &&
      pool.reverseRegistryPair === pool.pairAddress,
    "pilot pool identity or registry is inconsistent",
  );
  required(
    pool.factoryPairCount === 1 && pool.pilotPairCount === 1,
    "exactly one pilot pool is required",
  );
  for (const field of [
    "reserve0",
    "reserve1",
    "balance0",
    "balance1",
    "totalSupply",
  ])
    required(
      decimal(pool[field], `pilot pool ${field}`) === 0n,
      "pilot pool must be empty",
    );
  required(
    pool.capApprovalSha256 ===
      config.assetPlan.pilotPool.policyCapApproval.sha256,
    "pilot pool binds another cap approval",
  );
  boolean(pool.pairIdentityVerified, true, "pilot pool pairIdentityVerified");
  boolean(pool.empty, true, "pilot pool empty");
}

function validateAuthorities(
  config,
  bridge,
  bridgeActivationReceipt,
  deployment,
  pool,
  rehearsal,
  authorities,
) {
  exactKeys(
    authorities,
    [
      "feeAuthorityAddress",
      "treasuryAddress",
      "bridgeRouteId",
      "bridgeReadinessCommitmentSha256",
      "bridgeActivationReceiptSha256",
      "capApprovalSha256",
      "deploymentArtifactManifestSha256",
      "deploymentApprovalSha256",
      "poolInspectionCommitmentSha256",
      "poolApprovalSha256",
      "rehearsalArtifactSha256",
      "rehearsalApprovalSha256",
      "activationApprovalSha256",
      "approvalBlockNumber",
      "observedBlockNumber",
      "validUntilBlockNumber",
      "decision",
      "authenticated",
    ],
    "pilot authorities",
  );
  required(
    authorities.feeAuthorityAddress ===
      config.deployment.feeAuthority.address &&
      authorities.treasuryAddress === config.deployment.treasury.address &&
      authorities.feeAuthorityAddress !== authorities.treasuryAddress,
    "pilot authorities do not match separated deployment roles",
  );
  required(
    authorities.bridgeRouteId === bridge.routeId &&
      authorities.bridgeReadinessCommitmentSha256 ===
        bridge.readinessCommitmentSha256 &&
      authorities.capApprovalSha256 ===
        config.assetPlan.pilotPool.policyCapApproval.sha256,
    "pilot authorities bind another bridge or cap policy",
  );
  required(
    authorities.bridgeActivationReceiptSha256 ===
      `0x${sha256(stableJson(bridgeActivationReceipt))}`,
    "pilot authorities bind another bridge activation receipt",
  );
  const approvals = [
    authorities.deploymentApprovalSha256,
    authorities.poolApprovalSha256,
    authorities.rehearsalApprovalSha256,
    authorities.activationApprovalSha256,
  ];
  approvals.forEach((value, index) =>
    hash(value, `authority approval ${index}`),
  );
  required(
    new Set(approvals).size === approvals.length,
    "authority approvals must be distinct",
  );
  const evidenceCommitments = [
    bridge.readinessCommitmentSha256,
    authorities.bridgeActivationReceiptSha256,
    authorities.capApprovalSha256,
    authorities.deploymentArtifactManifestSha256,
    authorities.poolInspectionCommitmentSha256,
    authorities.rehearsalArtifactSha256,
    ...approvals,
  ];
  required(
    new Set(evidenceCommitments).size === evidenceCommitments.length,
    "authority approvals and evidence commitments must be distinct",
  );
  required(
    authorities.deploymentArtifactManifestSha256 ===
      deployment.artifactManifestSha256 &&
      authorities.poolInspectionCommitmentSha256 ===
        pool.inspectionCommitmentSha256 &&
      authorities.rehearsalArtifactSha256 === rehearsal.artifactSha256,
    "pilot authorities bind different reviewed artifacts",
  );
  required(
    Number.isSafeInteger(authorities.approvalBlockNumber) &&
      authorities.approvalBlockNumber === pool.finalizedBlockNumber &&
      Number.isSafeInteger(authorities.observedBlockNumber) &&
      Number.isSafeInteger(authorities.validUntilBlockNumber) &&
      authorities.approvalBlockNumber <= authorities.observedBlockNumber &&
      authorities.observedBlockNumber <= authorities.validUntilBlockNumber &&
      authorities.observedBlockNumber - authorities.approvalBlockNumber <= 32 &&
      authorities.validUntilBlockNumber - authorities.approvalBlockNumber <=
        720,
    "pilot authority approval is stale, future-dated or overlong",
  );
  required(
    authorities.decision === "approve-one-capped-pilot-liquidity-ceremony",
    "pilot authority decision is invalid",
  );
  boolean(authorities.authenticated, true, "pilot authorities authenticated");
}

function validateRehearsal(config, pool, rehearsal) {
  exactKeys(
    rehearsal,
    [
      "environment",
      "forkBlockNumber",
      "forkBlockHash",
      "baseAmount",
      "quoteAmount",
      "baseMinimum",
      "quoteMinimum",
      "recipient",
      "deadlineSeconds",
      "participantBaseBefore",
      "participantBaseAfter",
      "participantQuoteBefore",
      "participantQuoteAfter",
      "pairReserve0Before",
      "pairReserve0After",
      "pairReserve1Before",
      "pairReserve1After",
      "pairSupplyBefore",
      "pairSupplyAfter",
      "wrapVerified",
      "addLiquidityVerified",
      "swapVerified",
      "removeLiquidityVerified",
      "invariantVerified",
      "snapshotRollbackVerified",
      "reconciled",
      "broadcastPerformed",
      "persistentStateChanged",
      "artifactSha256",
      "performedAtUnixSeconds",
    ],
    "pilot rehearsal",
  );
  required(
    rehearsal.environment === "isolated-finalized-fork" &&
      rehearsal.forkBlockNumber === pool.inspectionBlockNumber &&
      rehearsal.forkBlockHash === pool.inspectionBlockHash,
    "pilot rehearsal binds another or non-isolated state",
  );
  const base = decimal(rehearsal.baseAmount, "rehearsal base amount", {
    positive: true,
  });
  const quote = decimal(rehearsal.quoteAmount, "rehearsal quote amount", {
    positive: true,
  });
  const baseMinimum = decimal(rehearsal.baseMinimum, "rehearsal base minimum", {
    positive: true,
  });
  const quoteMinimum = decimal(
    rehearsal.quoteMinimum,
    "rehearsal quote minimum",
    {
      positive: true,
    },
  );
  required(
    base <= BigInt(config.assetPlan.pilotPool.maxBaseBaseUnits) &&
      quote <= BigInt(config.assetPlan.pilotPool.maxQuoteBaseUnits) &&
      baseMinimum <= base &&
      quoteMinimum <= quote,
    "pilot rehearsal exceeds its approved cap or minima",
  );
  required(
    rehearsal.recipient === config.deployment.treasury.address,
    "pilot rehearsal recipient is not the reviewed treasury",
  );
  required(
    Number.isSafeInteger(rehearsal.deadlineSeconds) &&
      rehearsal.deadlineSeconds > 0 &&
      rehearsal.deadlineSeconds <= MAX_DEADLINE_SECONDS,
    "pilot rehearsal deadline is unsafe",
  );
  for (const [before, after, label] of [
    ["participantBaseBefore", "participantBaseAfter", "participant base"],
    ["participantQuoteBefore", "participantQuoteAfter", "participant quote"],
    ["pairReserve0Before", "pairReserve0After", "pair reserve0"],
    ["pairReserve1Before", "pairReserve1After", "pair reserve1"],
    ["pairSupplyBefore", "pairSupplyAfter", "pair supply"],
  ])
    required(
      decimal(rehearsal[before], `${label} before`) ===
        decimal(rehearsal[after], `${label} after`),
      `${label} did not reconcile`,
    );
  for (const field of [
    "wrapVerified",
    "addLiquidityVerified",
    "swapVerified",
    "removeLiquidityVerified",
    "invariantVerified",
    "snapshotRollbackVerified",
    "reconciled",
  ])
    boolean(rehearsal[field], true, `pilot rehearsal ${field}`);
  boolean(
    rehearsal.broadcastPerformed,
    false,
    "pilot rehearsal broadcastPerformed",
  );
  boolean(
    rehearsal.persistentStateChanged,
    false,
    "pilot rehearsal persistentStateChanged",
  );
  hash(rehearsal.artifactSha256, "pilot rehearsal artifact hash");
}

export function validatePilotReadinessBundle(
  bundle,
  atUnixSeconds = Math.floor(Date.now() / 1000),
) {
  exactKeys(
    bundle,
    [
      "schemaVersion",
      "domain",
      "deploymentConfiguration",
      "rpcObservation",
      "bridgeReadiness",
      "bridgeActivationReceipt",
      "deploymentControl",
      "pilotPool",
      "rehearsal",
      "authorities",
    ],
    "readiness bundle",
  );
  required(
    bundle.schemaVersion === 1 &&
      bundle.domain === "postern.dex.pilot-readiness.v1",
    "readiness bundle schema is unsupported",
  );
  const config = validateStagingConfig(bundle.deploymentConfiguration);
  validateRpcObservation(config, bundle.rpcObservation);
  validateBridgeReadiness(bundle.bridgeReadiness);
  required(
    Number.isSafeInteger(atUnixSeconds) && atUnixSeconds > 0,
    "readiness evaluation time is invalid",
  );
  validateBridgeActivationReceipt(
    bundle.bridgeReadiness,
    bundle.bridgeActivationReceipt,
    atUnixSeconds,
  );
  validateDeploymentControl(
    config,
    bundle.rpcObservation,
    bundle.deploymentControl,
  );
  validatePool(config, bundle.rpcObservation, bundle.pilotPool);
  validateRehearsal(config, bundle.pilotPool, bundle.rehearsal);
  required(
    Number.isSafeInteger(bundle.rehearsal.performedAtUnixSeconds) &&
      bundle.rehearsal.performedAtUnixSeconds >=
        bundle.bridgeActivationReceipt.issuedAtUnixSeconds &&
      bundle.rehearsal.performedAtUnixSeconds <= atUnixSeconds,
    "pilot rehearsal did not occur after the authenticated bridge activation",
  );
  const {
    inspectionCommitmentSha256: _inspectionCommitmentSha256,
    ...poolEvidence
  } = bundle.pilotPool;
  const poolCommitment = `0x${sha256(stableJson(poolEvidence))}`;
  required(
    bundle.pilotPool.inspectionCommitmentSha256 === poolCommitment,
    "pilot pool inspection commitment is invalid",
  );
  validateAuthorities(
    config,
    bundle.bridgeReadiness,
    bundle.bridgeActivationReceipt,
    bundle.deploymentControl,
    bundle.pilotPool,
    bundle.rehearsal,
    bundle.authorities,
  );
  const encoded = Buffer.from(`${DOMAIN}${stableJson(bundle)}`, "utf8");
  required(encoded.length <= MAX_BUNDLE_BYTES, "readiness bundle is too large");
  return encoded;
}

export async function readPilotReadinessBundle(path) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  required(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_BUNDLE_BYTES) &&
      Number(before.mode & 0o022n) === 0,
    "readiness bundle file is unsafe",
  );
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const fields = [
      "dev",
      "ino",
      "mode",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ];
    required(
      fields.every((field) => before[field] === opened[field]),
      "readiness bundle changed before reading",
    );
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      required(bytesRead > 0, "readiness bundle ended while reading");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(absolute, { bigint: true });
    required(
      fields.every(
        (field) =>
          before[field] === opened[field] &&
          opened[field] === after[field] &&
          after[field] === named[field],
      ),
      "readiness bundle changed while reading",
    );
    let bundle;
    try {
      bundle = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("readiness bundle is invalid JSON");
    }
    required(
      bytes.equals(Buffer.from(`${stableJson(bundle)}\n`, "utf8")),
      "readiness bundle is not canonical JSON",
    );
    return bundle;
  } finally {
    await handle.close();
  }
}

async function immutableVerifierCopy(path) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  required(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_VERIFIER_BYTES) &&
      Number(before.mode & 0o022n) === 0,
    "readiness verifier is unsafe",
  );
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const directory = await mkdtemp(
    join(tmpdir(), `postern-pilot-verifier-${randomBytes(8).toString("hex")}-`),
  );
  const staged = join(directory, "verifier");
  try {
    const opened = await handle.stat({ bigint: true });
    required(
      ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
        (field) => before[field] === opened[field],
      ),
      "readiness verifier changed before reading",
    );
    const bytes = await readFile(handle);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(absolute, { bigint: true });
    required(
      ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
        (field) =>
          before[field] === opened[field] &&
          opened[field] === after[field] &&
          after[field] === named[field],
      ) && bytes.length === Number(after.size),
      "readiness verifier changed while reading",
    );
    await writeFile(staged, bytes, { flag: "wx", mode: 0o500 });
    await chmod(staged, 0o500);
    return {
      directory,
      staged,
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

async function runVerifier(path, input) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(path, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(rejectPromise, new Error("readiness verifier timed out"));
    }, 10_000);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024) {
        child.kill("SIGKILL");
        finish(
          rejectPromise,
          new Error("readiness verifier output is too large"),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code, signal) =>
      finish(resolvePromise, {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.on("error", (error) => finish(rejectPromise, error));
    child.stdin.end(input);
  });
}

export async function verifyPilotReadiness(
  bundle,
  {
    verifierPath,
    verifierSha256,
    atUnixSeconds = Math.floor(Date.now() / 1000),
  },
) {
  const request = validatePilotReadinessBundle(bundle, atUnixSeconds);
  hash(verifierSha256, "readiness verifier SHA-256");
  const staged = await immutableVerifierCopy(verifierPath);
  try {
    required(
      staged.sha256 === verifierSha256,
      "readiness verifier pin mismatch",
    );
    const commitment = createHash("sha256").update(request).digest("hex");
    let result;
    try {
      result = await runVerifier(staged.staged, request);
    } catch {
      fail("readiness verifier refused the bundle");
    }
    required(
      result.code === 0 && result.signal === null,
      "readiness verifier refused the bundle",
    );
    required(
      result.stdout === `${commitment}\n` && result.stderr === "",
      "readiness verifier returned an invalid decision",
    );
    return Object.freeze({
      schemaVersion: 1,
      domain: "postern.dex.pilot-readiness-verification.v1",
      configurationSha256: bundle.deploymentControl.configurationSha256,
      bridgeReadinessCommitmentSha256:
        bundle.bridgeReadiness.readinessCommitmentSha256,
      bridgeActivationReceiptSha256: `0x${sha256(
        stableJson(bundle.bridgeActivationReceipt),
      )}`,
      poolInspectionCommitmentSha256:
        bundle.pilotPool.inspectionCommitmentSha256,
      rehearsalArtifactSha256: bundle.rehearsal.artifactSha256,
      verifierSha256,
      readinessCommitmentSha256: `0x${commitment}`,
      evaluatedAtUnixSeconds: atUnixSeconds,
      validUntilUnixSeconds:
        bundle.bridgeActivationReceipt.expiresAtUnixSeconds,
      validUntilBlockNumber: bundle.authorities.validUntilBlockNumber,
      bridgeReady: true,
      bridgeOperationalVerified: true,
      disabledDeploymentVerified: true,
      singleEmptyPilotPoolVerified: true,
      authoritiesVerified: true,
      rehearsalReconciled: true,
      pilotLiquidityCeremonyAuthorized: true,
      liquidityEnabled: false,
      liquidityAdded: false,
      activationPerformed: false,
      broadcastPerformed: false,
    });
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
}
