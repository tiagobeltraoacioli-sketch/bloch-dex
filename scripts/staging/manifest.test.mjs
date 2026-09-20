import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashDirectory,
  readAndValidateConfig,
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
const token = (suffix, symbol, wrappedNative = false, decimals = 18) => ({
  ...contract(suffix),
  symbol,
  name: `${symbol} token`,
  decimals,
  wrappedNative,
  policy: { feeOnTransfer: false, rebasing: false },
});
const valid = () => ({
  schemaVersion: 4,
  environment: "staging",
  host: "bloch-dex",
  frontendMode: "preview",
  liquidityEnabled: false,
  chain: { id: 700771, genesisHash: H1, rpcUrl: "https://rpc.invalid/" },
  deployment: {
    blockNumber: 12,
    blockHash: H2,
    pairInitCodeHash: H1,
    factory: contract("01"),
    router: contract("02"),
    lens: contract("03"),
    collector: contract("04"),
    wrappedNative: contract("05"),
    feeAuthority: contract("07"),
    treasury: contract("08"),
  },
  tokens: [token("05", "WBLCH", true), token("06", "bUSDC", false, 6)],
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
      destinationTokenAddress: contract("06").address,
    },
    pilotPool: {
      baseSymbol: "BLCH",
      onchainBaseSymbol: "WBLCH",
      quoteSymbol: "bUSDC",
      liquidityEnabled: false,
      maxBaseBaseUnits: "10000000000000000000",
      maxQuoteBaseUnits: "10000000",
      policyCapApproval: { path: "approvals/pilot-cap.json", sha256: H1 },
      requiresSeparateApproval: true,
    },
  },
});

test("accepts a complete disabled-liquidity staging configuration", () => {
  assert.equal(validateStagingConfig(valid()).host, "bloch-dex");
});

test("committed template carries no approved deployment or pilot exposure", async () => {
  const template = JSON.parse(
    await readFile(
      new URL("../../deployments/staging.template.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(template.assetPlan.pilotPool.maxBaseBaseUnits, null);
  assert.equal(template.assetPlan.pilotPool.maxQuoteBaseUnits, null);
  assert.equal(template.assetPlan.pilotPool.policyCapApproval, null);
  assert.throws(() => validateStagingConfig(template), /staging preflight:/);
});

test("fails closed for every missing identity field", () => {
  for (const mutate of [
    (value) => (value.chain.id = null),
    (value) => (value.chain.id = 84001),
    (value) => (value.chain.genesisHash = null),
    (value) => (value.chain.rpcUrl = null),
    (value) => (value.deployment.blockHash = null),
    (value) => (value.deployment.pairInitCodeHash = null),
    (value) => (value.deployment.factory.address = null),
    (value) => (value.deployment.router.runtimeCodeHash = null),
    (value) => (value.deployment.feeAuthority.address = null),
    (value) => (value.deployment.treasury.runtimeCodeHash = null),
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
    (value) =>
      (value.deployment.feeAuthority.address =
        value.deployment.treasury.address),
    (value) => (value.deployment.treasury.address = value.tokens[1].address),
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

test("pins the Bloch L1 and Ethereum USDC/bUSDC pilot decision", () => {
  const cases = [
    (value) => (value.assetPlan.blochL1.evmExecution = true),
    (value) => (value.assetPlan.blochL1.authorizationBoundary = "evm-account"),
    (value) => (value.assetPlan.bridgeAsset.sourceChainId = 11155111),
    (value) =>
      (value.assetPlan.bridgeAsset.sourceTokenAddress = contract("07").address),
    (value) =>
      (value.assetPlan.bridgeAsset.destinationTokenAddress =
        contract("07").address),
    (value) => (value.assetPlan.pilotPool.onchainBaseSymbol = "BLCH"),
    (value) => (value.assetPlan.pilotPool.liquidityEnabled = true),
    (value) => (value.assetPlan.pilotPool.requiresSeparateApproval = false),
    (value) =>
      (value.assetPlan.pilotPool.maxBaseBaseUnits = "10000000000000000001"),
    (value) => (value.assetPlan.pilotPool.maxQuoteBaseUnits = "10000001"),
    (value) => (value.assetPlan.pilotPool.maxQuoteBaseUnits = "01000000"),
    (value) => (value.assetPlan.pilotPool.policyCapApproval = null),
    (value) =>
      (value.assetPlan.pilotPool.policyCapApproval.path = "../pilot-cap.json"),
    (value) => (value.tokens[1].symbol = "USDC"),
    (value) => (value.tokens[1].decimals = 18),
  ];
  for (const mutate of cases) {
    const value = valid();
    mutate(value);
    assert.throws(() => validateStagingConfig(value), /staging preflight:/);
  }
});

test("rejects unknown claims at every staging schema boundary", () => {
  const mutations = [
    (value) => (value.unreviewed = true),
    (value) => (value.chain.unreviewed = true),
    (value) => (value.deployment.unreviewed = true),
    (value) => (value.deployment.factory.unreviewed = true),
    (value) => (value.tokens[0].unreviewed = true),
    (value) => (value.tokens[0].policy.unreviewed = true),
  ];
  for (const mutate of mutations) {
    const value = valid();
    mutate(value);
    assert.throws(() => validateStagingConfig(value), /fields are invalid/);
  }
});

test("preflight reads a bounded canonical cap envelope and pins every financial input", async () => {
  const root = await mkdtemp(join(tmpdir(), "postern-dex-cap-approval-"));
  await mkdir(join(root, "approvals"));
  const value = valid();
  const envelope = {
    schemaVersion: 2,
    domain: "postern.dex.pilot-cap-approval.v2",
    chainId: value.chain.id,
    genesisHash: value.chain.genesisHash,
    factoryAddress: value.deployment.factory.address,
    feeAuthorityAddress: value.deployment.feeAuthority.address,
    treasuryAddress: value.deployment.treasury.address,
    wrappedNativeAddress: value.deployment.wrappedNative.address,
    bridgeAssetAddress: value.assetPlan.bridgeAsset.destinationTokenAddress,
    maxBaseBaseUnits: value.assetPlan.pilotPool.maxBaseBaseUnits,
    maxQuoteBaseUnits: value.assetPlan.pilotPool.maxQuoteBaseUnits,
  };
  const bytes = `${stableJson(envelope)}\n`;
  value.assetPlan.pilotPool.policyCapApproval.sha256 = `0x${sha256(bytes)}`;
  const configPath = join(root, "staging.json");
  const approvalPath = join(root, "approvals", "pilot-cap.json");
  await writeFile(approvalPath, bytes, { mode: 0o600, flag: "wx" });
  await writeFile(configPath, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  assert.deepEqual(await readAndValidateConfig(configPath), value);

  await writeFile(approvalPath, `${bytes}\n`);
  await assert.rejects(
    readAndValidateConfig(configPath),
    /does not match its pinned hash/,
  );
  const oversized = "x".repeat(8193);
  await writeFile(approvalPath, oversized);
  value.assetPlan.pilotPool.policyCapApproval.sha256 = `0x${sha256(oversized)}`;
  await writeFile(configPath, JSON.stringify(value));
  await assert.rejects(readAndValidateConfig(configPath), /artifact is unsafe/);

  for (const mutate of [
    (candidate) => (candidate.chainId += 1),
    (candidate) => (candidate.genesisHash = H2),
    (candidate) => (candidate.factoryAddress = contract("09").address),
    (candidate) => (candidate.feeAuthorityAddress = contract("09").address),
    (candidate) => (candidate.treasuryAddress = contract("09").address),
    (candidate) => (candidate.wrappedNativeAddress = contract("09").address),
    (candidate) => (candidate.bridgeAssetAddress = contract("09").address),
    (candidate) => (candidate.maxBaseBaseUnits = "1"),
    (candidate) => (candidate.maxQuoteBaseUnits = "1"),
    (candidate) => (candidate.extra = true),
  ]) {
    const changed = structuredClone(envelope);
    mutate(changed);
    const changedBytes = `${stableJson(changed)}\n`;
    await writeFile(approvalPath, changedBytes, { mode: 0o444 });
    value.assetPlan.pilotPool.policyCapApproval.sha256 = `0x${sha256(changedBytes)}`;
    await writeFile(configPath, JSON.stringify(value), { mode: 0o444 });
    await assert.rejects(
      readAndValidateConfig(configPath),
      /staging preflight:/,
    );
  }
});

test("rejects noncanonical address and hash casing", () => {
  for (const mutate of [
    (value) =>
      (value.deployment.factory.address =
        value.deployment.factory.address.toUpperCase()),
    (value) =>
      (value.chain.genesisHash = value.chain.genesisHash.toUpperCase()),
  ]) {
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
