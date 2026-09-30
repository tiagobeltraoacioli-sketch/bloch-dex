import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  inspectPilotPool,
  writePoolInspectionObservation,
} from "./pool-inspector.mjs";
import { sha256, stableJson } from "./manifest.mjs";
import {
  fixture,
  hash,
  address,
  template,
} from "./pool-inspection.fixture.mjs";

test("collects an empty CREATE2 pool with exact call evidence and disabled capabilities", async () => {
  const item = fixture();
  const result = await inspectPilotPool(
    item.config,
    item.options,
    item.request,
  );
  assert.equal(result.domain, "postern.dex.pilot-pool-rpc-observation.v1");
  assert.equal(result.pool.pairAddress, item.pair);
  assert.equal(
    result.pool.capApprovalSha256,
    item.config.assetPlan.pilotPool.policyCapApproval.sha256,
  );
  assert.equal(
    result.configurationSha256,
    `0x${sha256(stableJson(item.config))}`,
  );
  assert.equal(result.calls.length, 15);
  assert.equal(result.runtimeCode.length, 4);
  assert.ok(
    Object.values(result.authentication).every((value) => value === false),
  );
  assert.ok(Object.values(result.controls).every((value) => value === false));
  assert.ok(
    item.calls.every(([method]) =>
      [
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getCode",
        "eth_call",
      ].includes(method),
    ),
  );
  assert.ok(
    item.calls
      .filter(([method]) => ["eth_call", "eth_getCode"].includes(method))
      .every(
        ([, params]) =>
          params[1].requireCanonical === true &&
          params[1].blockHash === item.options.blockHash,
      ),
  );
  const { observationSha256, ...body } = result;
  assert.equal(observationSha256, `0x${sha256(stableJson(body))}`);
});

for (const [name, mutation, pattern] of [
  ["retired chain", (item) => (item.config.chain.id = 8400), /chain/],
  [
    "activation request",
    (item) => (item.config.activation.executionEnabled = true),
    /disabled/,
  ],
  [
    "zero block hash",
    (item) => (item.options.blockHash = hash("0")),
    /nonzero/,
  ],
  [
    "zero runtime hash",
    (item) => (item.options.pairRuntimeCodeHash = hash("0")),
    /nonzero/,
  ],
  [
    "predeployment block",
    (item) => (item.options.blockNumber = 19),
    /precedes/,
  ],
  [
    "conflicting deployment block",
    (item) => (item.options.blockNumber = 20),
    /conflicts/,
  ],
  [
    "unsafe block",
    (item) => (item.options.blockNumber = Number.MAX_SAFE_INTEGER + 1),
    /invalid/,
  ],
  ["unknown field", (item) => (item.options.ready = true), /fields/],
]) {
  test(`refuses ${name} before provider access`, async () => {
    const item = fixture();
    mutation(item);
    await assert.rejects(
      inspectPilotPool(item.config, item.options, item.request),
      pattern,
    );
    assert.equal(item.calls.length, 0);
  });
}

for (const [name, override, pattern] of [
  [
    "wrong forward registry",
    (name, args) =>
      name === "getPair" && args[0].toLowerCase() === address("5")
        ? address("b")
        : undefined,
    /registry/,
  ],
  [
    "wrong reverse registry",
    (name, args) =>
      name === "getPair" && args[0].toLowerCase() === address("8")
        ? address("b")
        : undefined,
    /registry/,
  ],
  [
    "wrong allPairs entry",
    (name) => (name === "allPairs" ? address("b") : undefined),
    /registry/,
  ],
  [
    "extra pool",
    (name) => (name === "allPairsLength" ? 2n : undefined),
    /exactly one/,
  ],
  [
    "uncreated pool",
    (name) => (name === "allPairsLength" ? 0n : undefined),
    /exactly one/,
  ],
  [
    "wrong factory",
    (name) => (name === "factory" ? address("b") : undefined),
    /bindings/,
  ],
  [
    "wrong token order",
    (name) => (name === "token0" ? address("8") : undefined),
    /bindings/,
  ],
  [
    "wrong creation code",
    (name) => (name === "INIT_CODE_PAIR_HASH" ? hash("b") : undefined),
    /creation-code/,
  ],
  [
    "active fees",
    (name) => (name === "feeTo" ? address("b") : undefined),
    /fee controls/,
  ],
  [
    "pending fee transfer",
    (name) => (name === "pendingFeeToSetter" ? address("b") : undefined),
    /fee controls/,
  ],
  [
    "wrong fee authority",
    (name) => (name === "feeToSetter" ? address("b") : undefined),
    /fee controls/,
  ],
  [
    "reserve0",
    (name) => (name === "getReserves" ? [1n, 0n, 0] : undefined),
    /reserves/,
  ],
  [
    "reserve1",
    (name) => (name === "getReserves" ? [0n, 1n, 0] : undefined),
    /reserves/,
  ],
  [
    "LP supply",
    (name) => (name === "totalSupply" ? 1n : undefined),
    /LP supply/,
  ],
  [
    "base donation",
    (name, args, to) =>
      name === "balanceOf" && to === address("5") ? 1n : undefined,
    /donated/,
  ],
  [
    "quote donation",
    (name, args, to) =>
      name === "balanceOf" && to === address("8") ? 1n : undefined,
    /donated/,
  ],
]) {
  test(`refuses ${name}`, async () => {
    const item = fixture({ read: override });
    await assert.rejects(
      inspectPilotPool(item.config, item.options, item.request),
      pattern,
    );
  });
}

for (const [name, rpc, pattern] of [
  [
    "wrong chain",
    (method) => (method === "eth_chainId" ? "0x1" : undefined),
    /chain ID/,
  ],
  [
    "zero checkpoint hash",
    (method) =>
      method === "eth_getBlockByNumber"
        ? { number: "0x0", hash: hash("0") }
        : undefined,
    /nonzero/,
  ],
  [
    "unfinalized block",
    (method, params) =>
      method === "eth_getBlockByNumber" && params[0] === "finalized"
        ? { number: "0x1f", hash: hash("9") }
        : undefined,
    /not finalized/,
  ],
  [
    "finality at genesis",
    (method, params) =>
      method === "eth_getBlockByNumber" && params[0] === "finalized"
        ? { number: "0x0", hash: hash("1") }
        : undefined,
    /beyond genesis/,
  ],
  [
    "same-height fork",
    (method, params) =>
      method === "eth_getBlockByNumber" && params[0] === "finalized"
        ? { number: "0x20", hash: hash("9") }
        : undefined,
    /conflicts/,
  ],
  [
    "changed snapshot",
    (method, params, count) =>
      method === "eth_getBlockByNumber" && params[0] === "0x20" && count === 2
        ? { number: "0x20", hash: hash("b") }
        : undefined,
    /inspection block changed/,
  ],
  [
    "rewritten finalized checkpoint",
    (method, params) =>
      method === "eth_getBlockByNumber" && params[0] === "0x28"
        ? { number: "0x28", hash: hash("b") }
        : undefined,
    /initial finalized checkpoint changed/,
  ],
  [
    "closing fork",
    (method, params, count) =>
      method === "eth_getBlockByNumber" &&
      params[0] === "finalized" &&
      count === 2
        ? { number: "0x28", hash: hash("b") }
        : undefined,
    /regressed or changed/,
  ],
  [
    "closing finality regression",
    (method, params, count) =>
      method === "eth_getBlockByNumber" &&
      params[0] === "finalized" &&
      count === 2
        ? { number: "0x27", hash: hash("b") }
        : undefined,
    /regressed/,
  ],
  [
    "closing chain change",
    (method, params, count) =>
      method === "eth_chainId" && count === 2 ? "0x1" : undefined,
    /chain ID changed/,
  ],
  [
    "closing genesis change",
    (method, params, count) =>
      method === "eth_getBlockByNumber" && params[0] === "0x0" && count === 2
        ? { number: "0x0", hash: hash("b") }
        : undefined,
    /genesis changed/,
  ],
  [
    "empty runtime",
    (method) => (method === "eth_getCode" ? "0x" : undefined),
    /empty or malformed/,
  ],
  [
    "wrong runtime",
    (method) => (method === "eth_getCode" ? "0x6002" : undefined),
    /reviewed hash/,
  ],
  [
    "malformed call result",
    (method) => (method === "eth_call" ? "0x01" : undefined),
    /noncanonical/,
  ],
  [
    "trailing ABI words",
    (method) => (method === "eth_call" ? `0x${"3".repeat(128)}` : undefined),
    /noncanonical/,
  ],
]) {
  test(`refuses ${name}`, async () => {
    const item = fixture({ rpc });
    await assert.rejects(
      inspectPilotPool(item.config, item.options, item.request),
      pattern,
    );
  });
}

test("does not fall back when the RPC rejects hash pinning", async () => {
  const item = fixture({
    rpc(method) {
      if (method === "eth_getCode") throw new Error("EIP-1898 unsupported");
    },
  });
  await assert.rejects(
    inspectPilotPool(item.config, item.options, item.request),
    /unsupported/,
  );
  assert.equal(
    item.calls.filter(([method]) => method === "eth_getCode").length,
    1,
  );
  assert.equal(
    item.calls.filter(([method]) => method === "eth_call").length,
    0,
  );
});

test("accepts matching finalized snapshot and a later finalized head", async () => {
  const item = fixture({
    rpc(method, params, count) {
      if (method === "eth_getBlockByNumber" && params[0] === "finalized")
        return count === 1
          ? { number: "0x20", hash: hash("4") }
          : { number: "0x21", hash: hash("b") };
    },
  });
  const result = await inspectPilotPool(
    item.config,
    item.options,
    item.request,
  );
  assert.equal(result.finalizedBefore.number, 32);
  assert.equal(result.finalizedAfter.number, 33);
});

test("CLI rejects missing and duplicate arguments without network access", () => {
  const cli = new URL("./inspect-pilot-pool.mjs", import.meta.url);
  for (const args of [
    [],
    [
      "--config",
      "a",
      "--config",
      "b",
      "--block-number",
      "32",
      "--block-hash",
      hash("4"),
      "--output",
      "out",
    ],
  ]) {
    const result = spawnSync(process.execPath, [cli.pathname, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI observation writer creates private canonical output and refuses overwrite or symlink", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "postern-pool-observation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const item = fixture();
  const observation = await inspectPilotPool(
    item.config,
    item.options,
    item.request,
  );
  const output = join(directory, "observation.json");
  await writePoolInspectionObservation(output, observation);
  assert.equal(await readFile(output, "utf8"), `${stableJson(observation)}\n`);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(writePoolInspectionObservation(output, {}), {
    code: "EEXIST",
  });
  assert.equal(await readFile(output, "utf8"), `${stableJson(observation)}\n`);
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  await writeFile(target, "retained evidence");
  await symlink(target, link);
  await assert.rejects(writePoolInspectionObservation(link, observation), {
    code: "EEXIST",
  });
  assert.equal(await readFile(target, "utf8"), "retained evidence");
});

test("pending checked-in configuration cannot reach the provider", async () => {
  const item = fixture();
  await assert.rejects(
    inspectPilotPool(structuredClone(template), item.options, item.request),
    /chain/,
  );
  assert.equal(item.calls.length, 0);
});
