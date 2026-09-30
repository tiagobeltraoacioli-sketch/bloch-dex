import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  capturePilotPool,
  readPoolCapture,
  replayPilotPool,
} from "./pool-replay.mjs";
import { writePoolInspectionObservation } from "./pool-inspector.mjs";
import { fixture, hash } from "./pool-inspection.fixture.mjs";
import { sha256, stableJson } from "./manifest.mjs";

const temporaryDirectory = await realpath(tmpdir());
const digest = (value) => `0x${sha256(stableJson(value))}`;
const fileDigest = (value) => `0x${sha256(`${stableJson(value)}\n`)}`;
const repin = (capture) => {
  const { captureSha256, ...body } = capture;
  capture.captureSha256 = digest(body);
  return capture;
};
async function captured() {
  const item = fixture();
  const capture = await capturePilotPool(
    item.config,
    item.options,
    item.request,
  );
  return { ...item, capture };
}

test("replays actual ordered bytecode and call results without any provider", async () => {
  const item = await captured();
  const report = await replayPilotPool(item.config, item.options, item.capture);
  assert.equal(item.capture.domain, "postern.dex.pilot-pool-rpc-capture.v1");
  assert.equal(report.transcriptCallsReplayed, item.calls.length);
  assert.equal(report.transcriptComplete, true);
  assert.equal(report.observationReproduced, true);
  assert.equal(
    report.observationSha256,
    item.capture.observation.observationSha256,
  );
  assert.equal(
    item.capture.transcript.filter((entry) => entry.method === "eth_getCode")
      .length,
    4,
  );
  assert.ok(
    item.capture.transcript
      .filter((entry) => entry.method === "eth_getCode")
      .every((entry) => entry.result === "0x6001600055"),
  );
  assert.ok(
    Object.values(report.authentication).every((value) => value === false),
  );
  assert.ok(Object.values(report.controls).every((value) => value === false));
  assert.equal(
    stableJson(item.capture).includes(item.config.chain.rpcUrl),
    false,
  );
});

test("capture retains only consumed block fields and no transport metadata", async () => {
  const item = fixture();
  const capture = await capturePilotPool(
    item.config,
    item.options,
    async (method, params) => {
      const value = await item.request(method, params);
      return method === "eth_getBlockByNumber"
        ? {
            ...value,
            transactions: ["irrelevant"],
            providerUrl: "https://private.invalid/secret",
          }
        : value;
    },
  );
  assert.ok(
    capture.transcript
      .filter((entry) => entry.method === "eth_getBlockByNumber")
      .every(
        (entry) => Object.keys(entry.result).sort().join(",") === "hash,number",
      ),
  );
  assert.equal(stableJson(capture).includes("private.invalid"), false);
  await replayPilotPool(item.config, item.options, capture);
});

for (const [name, mutate, expected] of [
  [
    "missing first response",
    (capture) => capture.transcript.shift(),
    /order or parameters/,
  ],
  [
    "missing closing response",
    (capture) => capture.transcript.pop(),
    /missing/,
  ],
  [
    "reordered responses",
    (capture) =>
      ([capture.transcript[0], capture.transcript[1]] = [
        capture.transcript[1],
        capture.transcript[0],
      ]),
    /order or parameters/,
  ],
  [
    "duplicated response",
    (capture) => capture.transcript.splice(1, 0, capture.transcript[0]),
    /order or parameters/,
  ],
  [
    "unused response",
    (capture) => capture.transcript.push(capture.transcript.at(-1)),
    /unused/,
  ],
  [
    "transaction method",
    (capture) => (capture.transcript[0].method = "eth_sendTransaction"),
    /unsupported RPC/,
  ],
  [
    "unfixed state read",
    (capture) =>
      (capture.transcript.find(
        (entry) => entry.method === "eth_call",
      ).params[1] = "latest"),
    /order or parameters/,
  ],
  [
    "weakened canonicality flag",
    (capture) =>
      (capture.transcript.find(
        (entry) => entry.method === "eth_getCode",
      ).params[1].requireCanonical = false),
    /order or parameters/,
  ],
  [
    "substituted runtime bytes",
    (capture) =>
      (capture.transcript.find(
        (entry) => entry.method === "eth_getCode",
      ).result = "0x6002"),
    /runtime code/,
  ],
  [
    "hash in place of bytecode",
    (capture) =>
      (capture.transcript.find(
        (entry) => entry.method === "eth_getCode",
      ).result = hash("a")),
    /runtime code/,
  ],
  [
    "closing checkpoint rewrite",
    (capture) =>
      (capture.transcript
        .filter(
          (entry) =>
            entry.method === "eth_getBlockByNumber" &&
            entry.params[0] === "finalized",
        )
        .at(-1).result.hash = hash("b")),
    /regressed or changed/,
  ],
  [
    "forged amount in report",
    (capture) => (capture.observation.pool.balance0 = "1"),
    /does not match replayed/,
  ],
  [
    "enabled control in report",
    (capture) => {
      capture.observation.controls.liquidityEnabled = true;
      const { observationSha256, ...body } = capture.observation;
      capture.observation.observationSha256 = digest(body);
    },
    /does not match replayed/,
  ],
  [
    "authenticated report",
    (capture) =>
      (capture.observation.authentication.sourceRpcAuthenticated = true),
    /does not match replayed/,
  ],
  [
    "different configuration",
    (capture) => (capture.configurationSha256 = hash("a")),
    /another configuration/,
  ],
  [
    "different block request",
    (capture) => (capture.request.blockHash = hash("a")),
    /independently selected/,
  ],
  [
    "different runtime request",
    (capture) => (capture.request.pairRuntimeCodeHash = hash("a")),
    /independently selected/,
  ],
  [
    "unknown capture field",
    (capture) => (capture.verified = true),
    /capture fields/,
  ],
  [
    "unknown transcript field",
    (capture) => (capture.transcript[0].verified = true),
    /entry fields/,
  ],
  [
    "extra block result claim",
    (capture) => (capture.transcript[1].result.finalityAuthenticated = true),
    /block result fields/,
  ],
  [
    "too many calls",
    (capture) => {
      while (capture.transcript.length <= 48)
        capture.transcript.push(capture.transcript[0]);
    },
    /call count/,
  ],
  [
    "oversized individual result",
    (capture) =>
      (capture.transcript.find(
        (entry) => entry.method === "eth_getCode",
      ).result = "0x" + "00".repeat(524288)),
    /overlong/,
  ],
  [
    "oversized whole capture",
    (capture) => (capture.unbounded = "x".repeat(4 * 1024 * 1024)),
    /byte limit/,
  ],
]) {
  test(`refuses ${name} even when the outer digest is recomputed`, async () => {
    const item = await captured();
    mutate(item.capture);
    repin(item.capture);
    await assert.rejects(
      replayPilotPool(item.config, item.options, item.capture),
      expected,
    );
  });
}

test("refuses stale digest and an old observation without captured bytecode", async () => {
  const item = await captured();
  const mutated = structuredClone(item.capture);
  mutated.observation.pool.balance0 = "1";
  await assert.rejects(
    replayPilotPool(item.config, item.options, mutated),
    /digest mismatch/,
  );
  await assert.rejects(
    replayPilotPool(item.config, item.options, item.capture.observation),
    /capture fields/,
  );
});

test("capture also refuses oversized RPC results without producing a package", async () => {
  const item = fixture({
    rpc(method) {
      if (method === "eth_getCode") return "0x" + "00".repeat(524288);
    },
  });
  await assert.rejects(
    capturePilotPool(item.config, item.options, item.request),
    /overlong/,
  );
});

test("bounded capture reader requires externally supplied pin, canonical bytes and stable private file", async (context) => {
  const directory = await mkdtemp(
    join(temporaryDirectory, "postern-pool-reader-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const item = await captured();
  const file = join(directory, "capture.json");
  await writePoolInspectionObservation(file, item.capture);
  assert.deepEqual(
    await readPoolCapture(file, fileDigest(item.capture)),
    item.capture,
  );
  await assert.rejects(readPoolCapture(file, hash("a")), /file hash mismatch/);
  await assert.rejects(readPoolCapture(file, hash("0")), /nonzero/);
  await chmod(file, 0o622);
  await assert.rejects(
    readPoolCapture(file, fileDigest(item.capture)),
    /regular file/,
  );
  await chmod(file, 0o600);
  const symbolic = join(directory, "symbolic.json");
  await symlink(file, symbolic);
  await assert.rejects(
    readPoolCapture(symbolic, fileDigest(item.capture)),
    /regular file/,
  );
  const hard = join(directory, "hard.json");
  await link(file, hard);
  await assert.rejects(
    readPoolCapture(hard, fileDigest(item.capture)),
    /regular file/,
  );
  await rm(hard);
  const noncanonical = JSON.stringify(item.capture);
  await writeFile(file, noncanonical);
  await assert.rejects(
    readPoolCapture(file, `0x${sha256(noncanonical)}`),
    /not canonical/,
  );
  const duplicate = `${stableJson(item.capture).replace('{"captureSha256":', `{"captureSha256":"${hash("a")}","captureSha256":`)}\n`;
  await writeFile(file, duplicate);
  await assert.rejects(
    readPoolCapture(file, `0x${sha256(duplicate)}`),
    /not canonical/,
  );
  await writeFile(file, "{" + "x".repeat(4 * 1024 * 1024));
  await assert.rejects(readPoolCapture(file, hash("a")), /bounded/);
});

test("offline CLI reproduces retained capture, refuses overwrite and mismatched expected context", async (context) => {
  const directory = await mkdtemp(
    join(temporaryDirectory, "postern-pool-replay-cli-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const item = fixture();
  const config = item.config;
  const envelope = {
    schemaVersion: 2,
    domain: "postern.dex.pilot-cap-approval.v2",
    chainId: config.chain.id,
    genesisHash: config.chain.genesisHash,
    factoryAddress: config.deployment.factory.address,
    feeAuthorityAddress: config.deployment.feeAuthority.address,
    treasuryAddress: config.deployment.treasury.address,
    wrappedNativeAddress: config.deployment.wrappedNative.address,
    bridgeAssetAddress: config.assetPlan.bridgeAsset.destinationTokenAddress,
    maxBaseBaseUnits: config.assetPlan.pilotPool.maxBaseBaseUnits,
    maxQuoteBaseUnits: config.assetPlan.pilotPool.maxQuoteBaseUnits,
  };
  config.assetPlan.pilotPool.policyCapApproval.sha256 = fileDigest(envelope);
  await mkdir(join(directory, "approvals"));
  await writePoolInspectionObservation(
    join(directory, "approvals", "pilot-cap.json"),
    envelope,
  );
  await writePoolInspectionObservation(join(directory, "config.json"), config);
  const capture = await capturePilotPool(config, item.options, item.request);
  const file = join(directory, "capture.json");
  const output = join(directory, "replay.json");
  await writePoolInspectionObservation(file, capture);
  const args = [
    new URL("./replay-pilot-pool.mjs", import.meta.url).pathname,
    "--config",
    join(directory, "config.json"),
    "--block-number",
    String(item.options.blockNumber),
    "--block-hash",
    item.options.blockHash,
    "--pair-runtime-code-hash",
    item.options.pairRuntimeCodeHash,
    "--capture",
    file,
    "--capture-sha256",
    fileDigest(capture),
    "--output",
    output,
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const retained = await readFile(output, "utf8");
  assert.equal(JSON.parse(retained).observationReproduced, true);
  assert.equal(
    JSON.parse(retained).authentication.sourceRpcAuthenticated,
    false,
  );
  const repeated = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /EEXIST/);
  assert.equal(await readFile(output, "utf8"), retained);
  const wrong = [...args];
  wrong[wrong.indexOf("--block-hash") + 1] = hash("b");
  const refused = spawnSync(process.execPath, wrong, { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /independently selected/);
  for (const name of ["replay-pilot-pool.mjs", "capture-pilot-pool.mjs"]) {
    const usage = spawnSync(
      process.execPath,
      [new URL(`./${name}`, import.meta.url).pathname],
      { encoding: "utf8" },
    );
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
  }
});
