const HASH = /^0x[0-9a-f]{64}$/;

function refuse(condition, message) {
  if (!condition) throw new Error(`launch gate: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${field} fields are invalid`,
  );
}

function optionalHash(value, field) {
  refuse(
    value === null || (HASH.test(value) && !/^0x0{64}$/.test(value)),
    `${field} is invalid`,
  );
}

function boolean(value, field) {
  refuse(typeof value === "boolean", `${field} must be boolean`);
}

export function evaluateLaunchGate(gate) {
  exactKeys(
    gate,
    [
      "schemaVersion",
      "domain",
      "selectedChainId",
      "chainIdentity",
      "finality",
      "bridge",
      "deployment",
      "liquidity",
      "aggregatorExecutionEnabled",
      "activationAuthorized",
    ],
    "document",
  );
  refuse(
    gate.schemaVersion === 1 && gate.domain === "postern.dex.launch-gate.v1",
    "schema is unsupported",
  );
  refuse(gate.selectedChainId === 700771, "selected chain must be 700771");

  exactKeys(gate.chainIdentity, ["genesisHash", "qualified"], "chainIdentity");
  optionalHash(gate.chainIdentity.genesisHash, "chainIdentity.genesisHash");
  boolean(gate.chainIdentity.qualified, "chainIdentity.qualified");
  refuse(
    gate.chainIdentity.qualified === (gate.chainIdentity.genesisHash !== null),
    "chain identity qualification does not match its genesis evidence",
  );

  exactKeys(
    gate.finality,
    [
      "rpcObservationSha256",
      "finalizedBlockNumber",
      "advancedBeyondGenesis",
      "qualified",
    ],
    "finality",
  );
  optionalHash(
    gate.finality.rpcObservationSha256,
    "finality.rpcObservationSha256",
  );
  refuse(
    gate.finality.finalizedBlockNumber === null ||
      (Number.isSafeInteger(gate.finality.finalizedBlockNumber) &&
        gate.finality.finalizedBlockNumber > 0),
    "finalized block must be beyond genesis",
  );
  boolean(
    gate.finality.advancedBeyondGenesis,
    "finality.advancedBeyondGenesis",
  );
  boolean(gate.finality.qualified, "finality.qualified");
  const finalityEvidenceComplete =
    gate.chainIdentity.qualified &&
    gate.finality.rpcObservationSha256 !== null &&
    gate.finality.finalizedBlockNumber !== null &&
    gate.finality.advancedBeyondGenesis;
  refuse(
    gate.finality.qualified === finalityEvidenceComplete,
    "finality qualification does not match chain-bound evidence",
  );

  exactKeys(
    gate.bridge,
    ["readinessVerificationSha256", "operational"],
    "bridge",
  );
  optionalHash(
    gate.bridge.readinessVerificationSha256,
    "bridge.readinessVerificationSha256",
  );
  boolean(gate.bridge.operational, "bridge.operational");
  refuse(
    gate.bridge.operational ===
      (gate.bridge.readinessVerificationSha256 !== null),
    "bridge status does not match its verified readiness reference",
  );

  exactKeys(
    gate.deployment,
    ["configurationSha256", "rpcObservationSha256", "qualified"],
    "deployment",
  );
  optionalHash(
    gate.deployment.configurationSha256,
    "deployment.configurationSha256",
  );
  optionalHash(
    gate.deployment.rpcObservationSha256,
    "deployment.rpcObservationSha256",
  );
  boolean(gate.deployment.qualified, "deployment.qualified");
  const deploymentEvidenceComplete =
    gate.finality.qualified &&
    gate.deployment.configurationSha256 !== null &&
    gate.deployment.rpcObservationSha256 === gate.finality.rpcObservationSha256;
  refuse(
    gate.deployment.qualified === deploymentEvidenceComplete,
    "deployment qualification does not match the finalized RPC observation",
  );

  exactKeys(
    gate.liquidity,
    [
      "pilotReadinessVerificationSha256",
      "ceremonyAuthorized",
      "enabled",
      "added",
    ],
    "liquidity",
  );
  optionalHash(
    gate.liquidity.pilotReadinessVerificationSha256,
    "liquidity.pilotReadinessVerificationSha256",
  );
  for (const field of ["ceremonyAuthorized", "enabled", "added"])
    boolean(gate.liquidity[field], `liquidity.${field}`);
  const liquidityEvidenceComplete =
    gate.bridge.operational &&
    gate.deployment.qualified &&
    gate.liquidity.pilotReadinessVerificationSha256 !== null;
  refuse(
    gate.liquidity.ceremonyAuthorized === liquidityEvidenceComplete,
    "liquidity ceremony status does not match bridge and deployment readiness",
  );
  refuse(
    gate.liquidity.enabled === false && gate.liquidity.added === false,
    "liquidity must remain disabled and unfunded",
  );
  boolean(gate.aggregatorExecutionEnabled, "aggregatorExecutionEnabled");
  boolean(gate.activationAuthorized, "activationAuthorized");
  refuse(
    gate.aggregatorExecutionEnabled === false &&
      gate.activationAuthorized === false,
    "preflight cannot enable execution or authorize activation",
  );

  return Object.freeze({
    schemaVersion: 1,
    domain: "postern.dex.launch-gate-preflight.v1",
    selectedChainId: 700771,
    chainIdentityQualified: gate.chainIdentity.qualified,
    finalityQualified: gate.finality.qualified,
    bridgeOperational: gate.bridge.operational,
    deploymentQualified: gate.deployment.qualified,
    pilotLiquidityCeremonyAuthorized: gate.liquidity.ceremonyAuthorized,
    readyForReviewedActivation: liquidityEvidenceComplete,
    liquidityEnabled: false,
    liquidityAdded: false,
    aggregatorExecutionEnabled: false,
    activationAuthorized: false,
  });
}
