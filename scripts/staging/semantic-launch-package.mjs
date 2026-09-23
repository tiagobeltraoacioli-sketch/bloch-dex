import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stableJson } from "./manifest.mjs";
import {
  consumePilotCapCheckpointObservation,
  inspectPilotCapApproval,
} from "./pilot-cap-approval.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_BYTES = 1024 * 1024;
const MAX_PILOT_BLCH_BASE_UNITS = 10n * 10n ** 18n;
const MAX_PILOT_BUSDC_BASE_UNITS = 10n * 10n ** 6n;
const NAMES = ["l2", "bridge", "deployment", "pilot", "aggregator"];
const REPOSITORIES = Object.freeze({
  l2: "bloch-l2-evm",
  bridge: "bloch-l2-bridge",
  deployment: "postern-dex",
  pilot: "postern-dex",
  aggregator: "postern-wallet",
});

function refuse(condition, message) {
  if (!condition) throw new Error(`semantic launch package: ${message}`);
}

function exact(value, keys, field) {
  refuse(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${field} is not an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  refuse(
    actual.length === expected.length &&
      actual.every((key, i) => key === expected[i]),
    `${field} fields are invalid`,
  );
}

function hash(value, field) {
  refuse(HASH.test(value) && !/^0x0{64}$/.test(value), `${field} is invalid`);
  return value;
}

function address(value, field) {
  refuse(
    ADDRESS.test(value) && !/^0x0{40}$/.test(value),
    `${field} is invalid`,
  );
  return value;
}

function falseOnly(value, field) {
  refuse(value === false, `${field} must remain false`);
}

function boundedPositiveBaseUnits(value, ceiling, field) {
  refuse(
    typeof value === "string" && /^(?:[1-9][0-9]*)$/.test(value),
    `${field} is not a canonical positive integer`,
  );
  refuse(BigInt(value) <= ceiling, `${field} exceeds the low-cap ceiling`);
  return value;
}

function validateProvenance(value, name, descriptor) {
  exact(
    value,
    ["repository", "revision", "artifactPath"],
    `${name}.provenance`,
  );
  refuse(
    value.repository === REPOSITORIES[name],
    `${name} repository is not canonical`,
  );
  refuse(
    REVISION.test(value.revision) &&
      value.revision === descriptor.sourceRevision,
    `${name} revision does not match its descriptor`,
  );
  refuse(
    typeof value.artifactPath === "string" &&
      SAFE_PATH.test(value.artifactPath),
    `${name} provenance path is invalid`,
  );
}

function validateTrustRoots(value, expectedSha256, openedPackage, descriptors, opened) {
  exact(
    value,
    ["schemaVersion", "domain", "selectedChainId", "artifacts"],
    "trust roots",
  );
  refuse(
    value.schemaVersion === 1 &&
      value.domain === "postern.dex.semantic-launch-trust-roots.v1",
    "trust roots schema is unsupported",
  );
  refuse(value.selectedChainId === 700771, "trust roots select another chain");
  exact(value.artifacts, NAMES, "trust roots artifacts");
  for (const name of NAMES) {
    const root = value.artifacts[name];
    exact(
      root,
      ["repository", "revision", "artifactPath", "sha256"],
      `trust roots artifacts.${name}`,
    );
    refuse(
      root.repository === REPOSITORIES[name],
      `${name} trust root repository is not canonical`,
    );
    refuse(REVISION.test(root.revision), `${name} trust root revision is invalid`);
    refuse(
      typeof root.artifactPath === "string" && SAFE_PATH.test(root.artifactPath),
      `${name} trust root artifact path is invalid`,
    );
    hash(root.sha256, `${name} trust root sha256`);
    const declared = opened[name].value.provenance;
    refuse(
      root.repository === declared.repository &&
        root.revision === declared.revision &&
        root.revision === descriptors[name].sourceRevision &&
        root.artifactPath === declared.artifactPath,
      `${name} provenance does not match its external trust root`,
    );
    refuse(
      root.sha256 === opened[name].sha256 &&
        root.sha256 === descriptors[name].sha256,
      `${name} content does not match its external trust root`,
    );
  }
  return Object.freeze({
    trustRootsSha256: expectedSha256,
    packageSha256: openedPackage.sha256,
  });
}

async function readCanonical(repository, relativePath, label) {
  refuse(
    typeof relativePath === "string" &&
      SAFE_PATH.test(relativePath) &&
      !isAbsolute(relativePath),
    `${label} path is invalid`,
  );
  const root = resolve(repository);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  refuse(
    fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`),
    `${label} path escapes the repository`,
  );
  let before;
  try {
    before = await lstat(path, { bigint: true });
    refuse(
      (await realpath(path)) === path,
      `${label} path contains a symbolic link`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("semantic launch package:")
    )
      throw error;
    throw new Error(`semantic launch package: cannot inspect ${label}`);
  }
  refuse(
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
    const fields = [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ];
    refuse(
      opened.isFile() &&
        opened.nlink === 1n &&
        fields.every((field) => opened[field] === before[field]),
      `${label} changed before reading`,
    );
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    refuse(offset > 0 && offset <= MAX_BYTES, `${label} is unsafe`);
    const after = await handle.stat({ bigint: true });
    refuse(
      fields.every((field) => after[field] === opened[field]),
      `${label} changed while reading`,
    );
    const raw = bytes.subarray(0, offset);
    const text = raw.toString("utf8");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`semantic launch package: ${label} is invalid JSON`);
    }
    refuse(text === `${stableJson(value)}\n`, `${label} is not canonical JSON`);
    return {
      value,
      sha256: `0x${createHash("sha256").update(raw).digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
}

function validateL2(value, descriptor) {
  exact(
    value,
    [
      "schema",
      "provenance",
      "chainId",
      "genesisHash",
      "finalizedBlockNumber",
      "finalizedBlockHash",
      "rpcObservationSha256",
      "finalityVerified",
    ],
    "l2",
  );
  refuse(
    value.schema === "postern.dex.l2-finality-evidence.v1",
    "l2 schema is unsupported",
  );
  validateProvenance(value.provenance, "l2", descriptor);
  refuse(value.chainId === 700771, "l2 chain is not selected");
  hash(value.genesisHash, "l2.genesisHash");
  refuse(
    Number.isSafeInteger(value.finalizedBlockNumber) &&
      value.finalizedBlockNumber > 0,
    "l2 finalized height is invalid",
  );
  hash(value.finalizedBlockHash, "l2.finalizedBlockHash");
  hash(value.rpcObservationSha256, "l2.rpcObservationSha256");
  refuse(value.finalityVerified === true, "l2 finality is not verified");
}

function validateBridge(value, descriptor, l2) {
  exact(
    value,
    [
      "schema",
      "provenance",
      "chainId",
      "genesisHash",
      "l2ObservationSha256",
      "readinessVerificationSha256",
      "settlementVerified",
      "custodyAuthoritiesVerified",
      "pausedDeploymentVerified",
      "disposableCycleVerified",
      "activationAuthorized",
      "broadcastPerformed",
    ],
    "bridge",
  );
  refuse(
    value.schema === "postern.dex.bridge-readiness-evidence.v1",
    "bridge schema is unsupported",
  );
  validateProvenance(value.provenance, "bridge", descriptor);
  refuse(
    value.chainId === l2.chainId &&
      value.genesisHash === l2.genesisHash &&
      value.l2ObservationSha256 === l2.rpcObservationSha256,
    "bridge does not bind the selected L2 evidence",
  );
  hash(value.readinessVerificationSha256, "bridge.readinessVerificationSha256");
  for (const field of [
    "settlementVerified",
    "custodyAuthoritiesVerified",
    "pausedDeploymentVerified",
    "disposableCycleVerified",
  ])
    refuse(value[field] === true, `bridge.${field} is not verified`);
  falseOnly(value.activationAuthorized, "bridge.activationAuthorized");
  falseOnly(value.broadcastPerformed, "bridge.broadcastPerformed");
}

function validateDeployment(value, descriptor, l2, bridgeSha256) {
  exact(
    value,
    [
      "schema",
      "provenance",
      "chainId",
      "genesisHash",
      "configurationSha256",
      "rpcObservationSha256",
      "bridgeArtifactSha256",
      "contractsVerified",
      "deploymentEnabled",
    ],
    "deployment",
  );
  refuse(
    value.schema === "postern.dex.deployment-evidence.v1",
    "deployment schema is unsupported",
  );
  validateProvenance(value.provenance, "deployment", descriptor);
  refuse(
    value.chainId === l2.chainId &&
      value.genesisHash === l2.genesisHash &&
      value.rpcObservationSha256 === l2.rpcObservationSha256,
    "deployment does not bind the selected L2 evidence",
  );
  hash(value.configurationSha256, "deployment.configurationSha256");
  refuse(
    value.bridgeArtifactSha256 === bridgeSha256,
    "deployment does not bind the opened bridge artifact",
  );
  refuse(
    value.contractsVerified === true,
    "deployment contracts are not verified",
  );
  falseOnly(value.deploymentEnabled, "deployment.deploymentEnabled");
}

function validatePilot(value, descriptor, l2, bridgeSha256, deploymentSha256) {
  exact(
    value,
    [
      "schema",
      "provenance",
      "chainId",
      "genesisHash",
      "bridgeArtifactSha256",
      "deploymentArtifactSha256",
      "deploymentConfigurationSha256",
      "factoryAddress",
      "pilotPoolAddress",
      "wrappedNativeAddress",
      "bridgeAssetAddress",
      "maxBaseBaseUnits",
      "maxQuoteBaseUnits",
      "capApprovalSha256",
      "pilotVerified",
      "liquidityEnabled",
      "liquidityAdded",
    ],
    "pilot",
  );
  refuse(
    value.schema === "postern.dex.pilot-evidence.v3",
    "pilot schema is unsupported",
  );
  validateProvenance(value.provenance, "pilot", descriptor);
  refuse(
    value.chainId === l2.chainId &&
      value.genesisHash === l2.genesisHash &&
      value.bridgeArtifactSha256 === bridgeSha256 &&
      value.deploymentArtifactSha256 === deploymentSha256,
    "pilot cross-bindings are inconsistent",
  );
  boundedPositiveBaseUnits(
    value.maxBaseBaseUnits,
    MAX_PILOT_BLCH_BASE_UNITS,
    "pilot.maxBaseBaseUnits",
  );
  refuse(
    value.deploymentConfigurationSha256 ===
      descriptor.deploymentConfigurationSha256,
    "pilot deployment configuration does not match its descriptor",
  );
  hash(
    value.deploymentConfigurationSha256,
    "pilot.deploymentConfigurationSha256",
  );
  for (const field of [
    "factoryAddress",
    "pilotPoolAddress",
    "wrappedNativeAddress",
    "bridgeAssetAddress",
  ])
    address(value[field], `pilot.${field}`);
  refuse(
    new Set([
      value.factoryAddress,
      value.pilotPoolAddress,
      value.wrappedNativeAddress,
      value.bridgeAssetAddress,
    ]).size === 4,
    "pilot identities must be distinct",
  );
  boundedPositiveBaseUnits(
    value.maxQuoteBaseUnits,
    MAX_PILOT_BUSDC_BASE_UNITS,
    "pilot.maxQuoteBaseUnits",
  );
  hash(value.capApprovalSha256, "pilot.capApprovalSha256");
  refuse(value.pilotVerified === true, "pilot is not verified");
  falseOnly(value.liquidityEnabled, "pilot.liquidityEnabled");
  falseOnly(value.liquidityAdded, "pilot.liquidityAdded");
  return Object.freeze({
    maxBaseBaseUnits: value.maxBaseBaseUnits,
    maxQuoteBaseUnits: value.maxQuoteBaseUnits,
    capApprovalSha256: value.capApprovalSha256,
    deploymentConfigurationSha256: value.deploymentConfigurationSha256,
    factoryAddress: value.factoryAddress,
    pilotPoolAddress: value.pilotPoolAddress,
    wrappedNativeAddress: value.wrappedNativeAddress,
    bridgeAssetAddress: value.bridgeAssetAddress,
  });
}

function validateAggregator(
  value,
  descriptor,
  l2,
  deploymentSha256,
  pilotSha256,
) {
  exact(
    value,
    [
      "schema",
      "provenance",
      "chainId",
      "genesisHash",
      "deploymentArtifactSha256",
      "pilotArtifactSha256",
      "routesVerified",
      "executionEnabled",
      "broadcastPerformed",
    ],
    "aggregator",
  );
  refuse(
    value.schema === "postern.dex.aggregator-evidence.v1",
    "aggregator schema is unsupported",
  );
  validateProvenance(value.provenance, "aggregator", descriptor);
  refuse(
    value.chainId === l2.chainId &&
      value.genesisHash === l2.genesisHash &&
      value.deploymentArtifactSha256 === deploymentSha256 &&
      value.pilotArtifactSha256 === pilotSha256,
    "aggregator cross-bindings are inconsistent",
  );
  refuse(value.routesVerified === true, "aggregator routes are not verified");
  falseOnly(value.executionEnabled, "aggregator.executionEnabled");
  falseOnly(value.broadcastPerformed, "aggregator.broadcastPerformed");
}

export async function verifySemanticLaunchPackage(
  repository,
  packagePath,
  {
    trustRootsPath = null,
    expectedTrustRootsSha256 = null,
    capApproval = null,
    consumeCapCheckpoint = false,
  } = {},
) {
  refuse(
    (trustRootsPath === null) === (expectedTrustRootsSha256 === null),
    "trust roots path and externally expected SHA-256 must be supplied together",
  );
  if (expectedTrustRootsSha256 !== null)
    hash(expectedTrustRootsSha256, "externally expected trust roots sha256");
  const openedPackage = await readCanonical(repository, packagePath, "package");
  const pkg = openedPackage.value;
  exact(
    pkg,
    ["schemaVersion", "domain", "selectedChainId", "artifacts", "controls"],
    "package",
  );
  refuse(
    pkg.schemaVersion === 1 &&
      pkg.domain === "postern.dex.semantic-launch-package.v1",
    "package schema is unsupported",
  );
  refuse(pkg.selectedChainId === 700771, "selected chain must be 700771");
  exact(pkg.artifacts, NAMES, "package.artifacts");
  exact(
    pkg.controls,
    [
      "liquidityEnabled",
      "liquidityAdded",
      "aggregatorExecutionEnabled",
      "activationAuthorized",
    ],
    "package.controls",
  );
  for (const [field, value] of Object.entries(pkg.controls))
    falseOnly(value, `package.controls.${field}`);

  const present = NAMES.filter((name) => pkg.artifacts[name] !== null);
  refuse(
    present.length === 0 || present.length === NAMES.length,
    "artifact descriptors are partial",
  );
  const base = {
    schemaVersion: 1,
    domain: "postern.dex.semantic-launch-verification.v1",
    selectedChainId: 700771,
    packageSha256: openedPackage.sha256,
    artifactContentsOpened: false,
    contentHashesMatched: false,
    declaredProvenanceConsistent: false,
    declaredCrossBindingsConsistent: false,
    semanticStructureVerified: false,
    artifactContentAuthenticated: false,
    provenanceAuthenticated: false,
    semanticEvidenceAuthenticated: false,
    declaredPilotCapBounded: false,
    pilotCapApprovalAuthenticated: false,
    pilotCapApprovalObservation: null,
    pilotCap: null,
    activationApprovalAuthenticated: false,
    trustRootsSha256: null,
    readyForReviewedActivation: false,
    liquidityEnabled: false,
    liquidityAdded: false,
    aggregatorExecutionEnabled: false,
    activationAuthorized: false,
  };
  if (present.length === 0) return Object.freeze(base);

  const descriptors = {};
  const opened = {};
  for (const name of NAMES) {
    const descriptor = pkg.artifacts[name];
    exact(
      descriptor,
      name === "pilot"
        ? ["path", "sha256", "sourceRevision", "deploymentConfigurationSha256"]
        : ["path", "sha256", "sourceRevision"],
      `package.artifacts.${name}`,
    );
    refuse(
      typeof descriptor.path === "string" && SAFE_PATH.test(descriptor.path),
      `${name} descriptor path is invalid`,
    );
    hash(descriptor.sha256, `${name} descriptor sha256`);
    refuse(
      REVISION.test(descriptor.sourceRevision),
      `${name} descriptor revision is invalid`,
    );
    if (name === "pilot")
      hash(
        descriptor.deploymentConfigurationSha256,
        "pilot descriptor deployment configuration sha256",
      );
    descriptors[name] = descriptor;
    opened[name] = await readCanonical(repository, descriptor.path, name);
    refuse(
      opened[name].sha256 === descriptor.sha256,
      `${name} content hash does not match its descriptor`,
    );
  }
  validateL2(opened.l2.value, descriptors.l2);
  validateBridge(opened.bridge.value, descriptors.bridge, opened.l2.value);
  validateDeployment(
    opened.deployment.value,
    descriptors.deployment,
    opened.l2.value,
    opened.bridge.sha256,
  );
  const pilotCap = validatePilot(
    opened.pilot.value,
    descriptors.pilot,
    opened.l2.value,
    opened.bridge.sha256,
    opened.deployment.sha256,
  );
  validateAggregator(
    opened.aggregator.value,
    descriptors.aggregator,
    opened.l2.value,
    opened.deployment.sha256,
    opened.pilot.sha256,
  );
  let authentication = null;
  if (trustRootsPath !== null) {
    const trustRoots = await readCanonical(repository, trustRootsPath, "trust roots");
    refuse(
      trustRoots.sha256 === expectedTrustRootsSha256,
      "trust roots do not match the externally expected SHA-256",
    );
    authentication = validateTrustRoots(
      trustRoots.value,
      expectedTrustRootsSha256,
      openedPackage,
      descriptors,
      opened,
    );
  }
  let capObservation = null;
  if (capApproval !== null) {
    refuse(authentication !== null, "cap approval requires authenticated artifact trust roots");
    const inspect = consumeCapCheckpoint
      ? consumePilotCapCheckpointObservation
      : inspectPilotCapApproval;
    capObservation = await inspect(
      repository,
      capApproval,
      {
        selectedChainId: opened.l2.value.chainId,
        genesisHash: opened.l2.value.genesisHash,
        pilotCap,
        sourceRevisions: Object.fromEntries(
          NAMES.map((name) => [name, descriptors[name].sourceRevision]),
        ),
      },
    );
  }
  return Object.freeze({
    ...base,
    artifactContentsOpened: true,
    contentHashesMatched: true,
    declaredProvenanceConsistent: true,
    declaredCrossBindingsConsistent: true,
    semanticStructureVerified: true,
    artifactContentAuthenticated: authentication !== null,
    provenanceAuthenticated: authentication !== null,
    semanticEvidenceAuthenticated: authentication !== null,
    declaredPilotCapBounded: true,
    pilotCapApprovalAuthenticated: false,
    pilotCapApprovalObservation: capObservation,
    pilotCap,
    trustRootsSha256: authentication?.trustRootsSha256 ?? null,
  });
}
