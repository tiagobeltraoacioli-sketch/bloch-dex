import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "./manifest.mjs";
import { evaluateLaunchGate, readLaunchGate } from "./launch-gate.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const templateUrl = new URL(
  "../../deployments/launch-gate.template.json",
  import.meta.url,
);
const repository = resolve(dirname(fileURLToPath(templateUrl)), "..");
const cli = fileURLToPath(new URL("./check-launch-gate.mjs", import.meta.url));
const NOW = 2_000_000_000;

const complete = () => ({
  schemaVersion: 2,
  domain: "postern.dex.launch-gate.v2",
  selectedChainId: 700771,
  chainIdentity: { genesisHash: hash("1") },
  finality: {
    rpcObservationSha256: hash("2"),
    finalizedBlockNumber: 1,
    finalizedBlockHash: hash("3"),
    observedAtUnixSeconds: NOW - 60,
    validUntilUnixSeconds: NOW + 60,
  },
  bridge: { readinessVerificationSha256: hash("4") },
  deployment: {
    configurationSha256: hash("5"),
    rpcObservationSha256: hash("2"),
  },
  liquidity: { pilotReadinessVerificationSha256: hash("6") },
  controls: {
    liquidityEnabled: false,
    liquidityAdded: false,
    aggregatorExecutionEnabled: false,
    activationAuthorized: false,
  },
});

test("checked-in launch gate is canonical, empty and unauthorized", async () => {
  const text = await readFile(templateUrl, "utf8");
  const template = JSON.parse(text);
  assert.equal(text, `${stableJson(template)}\n`);
  const report = evaluateLaunchGate(template, { nowUnixSeconds: NOW });
  assert.equal(report.evidenceComplete, false);
  for (const field of [
    "readyForReviewedActivation",
    "liquidityEnabled",
    "liquidityAdded",
    "aggregatorExecutionEnabled",
    "activationAuthorized",
  ])
    assert.equal(report[field], false);
});

test("complete self-declared references never produce authorization", () => {
  const report = evaluateLaunchGate(complete(), { nowUnixSeconds: NOW });
  assert.equal(report.evidenceComplete, true);
  assert.equal(report.readyForReviewedActivation, false);
  assert.equal(report.liquidityEnabled, false);
  assert.equal(report.aggregatorExecutionEnabled, false);
  assert.equal(report.activationAuthorized, false);
});

test("refuses partial, stale, cross-fork and enabled packages", () => {
  for (const mutate of [
    (gate) => (gate.selectedChainId = 84001),
    (gate) => (gate.chainIdentity.genesisHash = hash("0")),
    (gate) => (gate.finality.finalizedBlockNumber = 0),
    (gate) => (gate.finality.finalizedBlockHash = null),
    (gate) => (gate.finality.observedAtUnixSeconds = NOW + 1),
    (gate) => (gate.finality.validUntilUnixSeconds = NOW - 1),
    (gate) => (gate.finality.validUntilUnixSeconds = NOW + 901),
    (gate) => (gate.deployment.rpcObservationSha256 = hash("9")),
    (gate) => (gate.bridge.readinessVerificationSha256 = null),
    (gate) => (gate.controls.liquidityEnabled = true),
    (gate) => (gate.controls.liquidityAdded = true),
    (gate) => (gate.controls.aggregatorExecutionEnabled = true),
    (gate) => (gate.controls.activationAuthorized = true),
  ]) {
    const gate = complete();
    mutate(gate);
    assert.throws(
      () => evaluateLaunchGate(gate, { nowUnixSeconds: NOW }),
      /launch gate:/,
    );
  }
});

test("bounded reader accepts only canonical regular repo-relative files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-launch-gate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonical = `${stableJson(complete())}\n`;
  await writeFile(join(root, "gate.json"), canonical, { mode: 0o600 });
  assert.deepEqual(await readLaunchGate(root, "gate.json"), complete());

  await writeFile(
    join(root, "pretty.json"),
    `${JSON.stringify(complete(), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await assert.rejects(readLaunchGate(root, "pretty.json"), /not canonical/);
  await writeFile(
    join(root, "duplicate.json"),
    '{"schemaVersion":2,"schemaVersion":2}\n',
    {
      mode: 0o600,
    },
  );
  await assert.rejects(readLaunchGate(root, "duplicate.json"), /not canonical/);
  await symlink(join(root, "gate.json"), join(root, "link.json"));
  await assert.rejects(readLaunchGate(root, "link.json"), /symbolic link/);
  await writeFile(join(root, "large.json"), "x".repeat(16 * 1024 + 1), {
    mode: 0o600,
  });
  await assert.rejects(readLaunchGate(root, "large.json"), /unsafe/);
  await chmod(join(root, "gate.json"), 0o622);
  await assert.rejects(readLaunchGate(root, "gate.json"), /unsafe/);
  await assert.rejects(readLaunchGate(root, "../outside.json"), /escapes/);
  await assert.rejects(
    readLaunchGate(root, join(root, "gate.json")),
    /repository-relative/,
  );
});

test("CLI exits one for pending gates and two for invalid usage", () => {
  const pending = spawnSync(
    process.execPath,
    [cli, "--gate", "deployments/launch-gate.template.json"],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).readyForReviewedActivation, false);
  assert.equal(pending.stderr, "");

  const usage = spawnSync(process.execPath, [cli], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
});
