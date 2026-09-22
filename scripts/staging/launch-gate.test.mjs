import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateLaunchGate } from "./launch-gate.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const templateUrl = new URL(
  "../../deployments/launch-gate.template.json",
  import.meta.url,
);

const complete = () => ({
  schemaVersion: 1,
  domain: "postern.dex.launch-gate.v1",
  selectedChainId: 700771,
  chainIdentity: { genesisHash: hash("1"), qualified: true },
  finality: {
    rpcObservationSha256: hash("2"),
    finalizedBlockNumber: 1,
    advancedBeyondGenesis: true,
    qualified: true,
  },
  bridge: { readinessVerificationSha256: hash("3"), operational: true },
  deployment: {
    configurationSha256: hash("4"),
    rpcObservationSha256: hash("2"),
    qualified: true,
  },
  liquidity: {
    pilotReadinessVerificationSha256: hash("5"),
    ceremonyAuthorized: true,
    enabled: false,
    added: false,
  },
  aggregatorExecutionEnabled: false,
  activationAuthorized: false,
});

test("checked-in launch gate remains empty, disabled and fail closed", async () => {
  const template = JSON.parse(await readFile(templateUrl, "utf8"));
  const report = evaluateLaunchGate(template);
  assert.equal(report.selectedChainId, 700771);
  assert.equal(report.readyForReviewedActivation, false);
  assert.deepEqual(
    [
      report.chainIdentityQualified,
      report.finalityQualified,
      report.bridgeOperational,
      report.deploymentQualified,
      report.pilotLiquidityCeremonyAuthorized,
      report.liquidityEnabled,
      report.liquidityAdded,
      report.aggregatorExecutionEnabled,
      report.activationAuthorized,
    ],
    Array(9).fill(false),
  );
});

test("aggregates chain, post-genesis finality, bridge and deployment evidence without activation", () => {
  const report = evaluateLaunchGate(complete());
  assert.equal(report.readyForReviewedActivation, true);
  assert.equal(report.pilotLiquidityCeremonyAuthorized, true);
  assert.equal(report.liquidityEnabled, false);
  assert.equal(report.aggregatorExecutionEnabled, false);
  assert.equal(report.activationAuthorized, false);
});

test("refuses disconnected evidence and every enablement shortcut", () => {
  for (const mutate of [
    (gate) => (gate.selectedChainId = 84001),
    (gate) => (gate.chainIdentity.genesisHash = hash("0")),
    (gate) => (gate.finality.finalizedBlockNumber = 0),
    (gate) => (gate.finality.advancedBeyondGenesis = false),
    (gate) => (gate.deployment.rpcObservationSha256 = hash("9")),
    (gate) => (gate.bridge.operational = false),
    (gate) => (gate.liquidity.ceremonyAuthorized = false),
    (gate) => (gate.liquidity.enabled = true),
    (gate) => (gate.liquidity.added = true),
    (gate) => (gate.aggregatorExecutionEnabled = true),
    (gate) => (gate.activationAuthorized = true),
  ]) {
    const gate = complete();
    mutate(gate);
    assert.throws(() => evaluateLaunchGate(gate), /launch gate:/);
  }
});
