import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashDirectory,
  sha256,
  stableJson,
  validateStagingConfig,
} from "./manifest.mjs";

const H1 = `0x${"11".repeat(32)}`;
const H2 = `0x${"22".repeat(32)}`;
const contract = (suffix) => ({
  address: `0x${"00".repeat(19)}${suffix}`,
  runtimeCodeHash: H2,
});
const token = (suffix, symbol, wrappedNative = false) => ({
  ...contract(suffix),
  symbol,
  name: `${symbol} token`,
  decimals: 18,
  wrappedNative,
  policy: { feeOnTransfer: false, rebasing: false },
});
const valid = () => ({
  schemaVersion: 2,
  environment: "staging",
  host: "bloch-dex",
  frontendMode: "preview",
  liquidityEnabled: false,
  chain: { id: 31337, genesisHash: H1, rpcUrl: "https://rpc.invalid/" },
  deployment: {
    blockNumber: 12,
    blockHash: H2,
    pairInitCodeHash: H1,
    factory: contract("01"),
    router: contract("02"),
    lens: contract("03"),
    collector: contract("04"),
    wrappedNative: contract("05"),
  },
  tokens: [token("05", "WBLCH", true), token("06", "ASSET")],
});

test("accepts a complete disabled-liquidity staging configuration", () => {
  assert.equal(validateStagingConfig(valid()).host, "bloch-dex");
});

test("fails closed for every missing identity field", () => {
  for (const mutate of [
    (value) => (value.chain.id = null),
    (value) => (value.chain.genesisHash = null),
    (value) => (value.chain.rpcUrl = null),
    (value) => (value.deployment.blockHash = null),
    (value) => (value.deployment.pairInitCodeHash = null),
    (value) => (value.deployment.factory.address = null),
    (value) => (value.deployment.router.runtimeCodeHash = null),
    (value) => (value.tokens = null),
    (value) => (value.tokens[1].runtimeCodeHash = null),
  ]) {
    const value = valid();
    mutate(value);
    assert.throws(() => validateStagingConfig(value), /staging preflight:/);
  }
});

test("refuses liquidity, live mode, insecure RPC and unsafe token policy", () => {
  const cases = [
    (value) => (value.liquidityEnabled = true),
    (value) => (value.frontendMode = "live"),
    (value) => (value.chain.rpcUrl = "http://rpc.invalid/"),
    (value) => (value.chain.rpcUrl = "https://user:secret@rpc.invalid/"),
    (value) => (value.chain.rpcUrl = "https://rpc.invalid/secret-key"),
    (value) =>
      (value.deployment.router.address = value.deployment.factory.address),
    (value) => (value.tokens[1].address = value.tokens[0].address),
    (value) => (value.tokens[1].policy.feeOnTransfer = true),
    (value) => (value.tokens[1].policy.rebasing = true),
    (value) => (value.tokens[0].wrappedNative = false),
  ];
  for (const mutate of cases) {
    const value = valid();
    mutate(value);
    assert.throws(() => validateStagingConfig(value), /staging preflight:/);
  }
});

test("stable JSON and artifact hashes are deterministic and symlinks fail closed", async () => {
  assert.equal(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  const root = await mkdtemp(join(tmpdir(), "postern-dex-staging-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "index");
  await writeFile(join(root, "assets", "app.js"), "app");
  assert.deepEqual(await hashDirectory(root), [
    { path: "assets/app.js", bytes: 3, sha256: sha256("app") },
    { path: "index.html", bytes: 5, sha256: sha256("index") },
  ]);
  await symlink(join(root, "index.html"), join(root, "linked.html"));
  await assert.rejects(hashDirectory(root), /artifact contains symlink/);
});
