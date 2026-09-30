import test from "node:test";
import assert from "node:assert/strict";
import {
  captureDeployment,
  replayDeployment,
  readDeploymentCapture,
} from "./deployment-replay.mjs";
import { valid, rpc, hash } from "./deployment-rpc.fixture.mjs";
import { sha256, stableJson } from "./manifest.mjs";
import { writePoolInspectionObservation } from "./pool-inspector.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const resign = (value) => {
  const { captureSha256, ...body } = value;
  value.captureSha256 = "0x" + sha256(stableJson(body));
  return value;
};
test("retains exact bytecode and replays deployment checks offline", async () => {
  const capture = await captureDeployment(valid(), rpc().request),
    report = await replayDeployment(valid(), capture);
  assert.equal(
    capture.transcript.filter((e) => e.method === "eth_getCode").length,
    8,
  );
  assert.equal(report.identities.length, 8);
  assert.equal(report.stateReadsHashPinned, true);
  for (const field of [
    "sourceRpcAuthenticated",
    "finalityAuthenticated",
    "deploymentAuthenticated",
    "activationAuthorized",
    "liquidityEnabled",
    "broadcastPerformed",
  ])
    assert.equal(report[field], false);
  assert.ok(!JSON.stringify(capture).includes("rpc.invalid"));
});
test("recomputed envelope hashes cannot hide tampering or missing calls", async () => {
  const capture = await captureDeployment(valid(), rpc().request);
  for (const mutate of [
    (c) =>
      (c.transcript.find((e) => e.method === "eth_getCode").params[1] = "0x20"),
    (c) =>
      (c.transcript.find(
        (e) => e.method === "eth_getCode",
      ).params[1].requireCanonical = false),
    (c) =>
      (c.transcript.find((e) => e.method === "eth_getCode").result = "0x6009"),
    (c) => c.transcript.shift(),
    (c) => c.transcript.push(c.transcript[0]),
    (c) => c.transcript.reverse(),
    (c) => (c.observation.snapshot.hash = hash("f")),
    (c) => (c.configurationSha256 = hash("f")),
    (c) => (c.transcript[0].method = "eth_sendRawTransaction"),
  ]) {
    const bad = structuredClone(capture);
    mutate(bad);
    await assert.rejects(replayDeployment(valid(), resign(bad)));
  }
});
test("capture file is create-only, canonical and externally digest pinned", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "dex-deployment-capture-")),
  );
  try {
    const path = join(dir, "capture.json"),
      capture = await captureDeployment(valid(), rpc().request);
    await writePoolInspectionObservation(path, capture);
    const pinned = "0x" + sha256(stableJson(capture) + "\n");
    assert.deepEqual(await readDeploymentCapture(path, pinned), capture);
    await assert.rejects(readDeploymentCapture(path, hash("f")));
    await assert.rejects(writePoolInspectionObservation(path, capture));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offline CLI validates reviewed config, pins capture and refuses overwrite", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdir, readFile } = await import("node:fs/promises");
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "dex-deployment-cli-")),
  );
  try {
    const config = valid(),
      envelope = {
        schemaVersion: 2,
        domain: "postern.dex.pilot-cap-approval.v2",
        chainId: config.chain.id,
        genesisHash: config.chain.genesisHash,
        factoryAddress: config.deployment.factory.address,
        feeAuthorityAddress: config.deployment.feeAuthority.address,
        treasuryAddress: config.deployment.treasury.address,
        wrappedNativeAddress: config.deployment.wrappedNative.address,
        bridgeAssetAddress:
          config.assetPlan.bridgeAsset.destinationTokenAddress,
        maxBaseBaseUnits: config.assetPlan.pilotPool.maxBaseBaseUnits,
        maxQuoteBaseUnits: config.assetPlan.pilotPool.maxQuoteBaseUnits,
      };
    const fileDigest = (value) => "0x" + sha256(stableJson(value) + "\n");
    config.assetPlan.pilotPool.policyCapApproval.sha256 = fileDigest(envelope);
    await mkdir(join(dir, "approvals"));
    await writePoolInspectionObservation(
      join(dir, "approvals/pilot-cap.json"),
      envelope,
    );
    await writePoolInspectionObservation(join(dir, "config.json"), config);
    const capture = await captureDeployment(config, rpc().request);
    await writePoolInspectionObservation(join(dir, "capture.json"), capture);
    const args = [
      new URL("./deployment-evidence.mjs", import.meta.url).pathname,
      "replay",
      "--config",
      join(dir, "config.json"),
      "--capture",
      join(dir, "capture.json"),
      "--capture-sha256",
      fileDigest(capture),
      "--output",
      join(dir, "replay.json"),
    ];
    const run = () =>
      spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const before = await readFile(join(dir, "replay.json"), "utf8");
    assert.equal(JSON.parse(before).observationReproduced, true);
    assert.equal(run().status, 1);
    assert.equal(await readFile(join(dir, "replay.json"), "utf8"), before);
    assert.equal(
      spawnSync(process.execPath, [args[0]], { encoding: "utf8" }).status,
      2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
