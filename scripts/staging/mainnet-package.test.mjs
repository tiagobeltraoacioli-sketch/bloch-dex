import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { NETWORKS, SAFE_V141, pendingFields } from "./dex-deploy-config.mjs";
import {
  SAFE_DEPLOY_DOMAIN,
  SAFE_PACKAGE,
  checkSafeArtifacts,
  loadSafeArtifacts,
  planSafe,
  safeInitializer,
  safeProxyAddress,
  safeTransactions,
  validateSafeConfig,
} from "./safe-deploy-config.mjs";
import { parseArgs as parseSafeArgs, preflightSafe } from "./deploy-safe.mjs";
import { PINS, checkPinned } from "./check-finality-gate-mainnet.mjs";
import { readImmutables, verifyDeployment } from "./verify-deployment.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress, concat, encodeAbiParameters, encodePacked } = requireFromFrontend("viem");

const addr = (c) => `0x${c.repeat(40)}`;
const hash = (c) => `0x${c.repeat(64)}`;
const OWNERS = [addr("1"), addr("2"), addr("3"), addr("4"), addr("5")];
const BOOT = addr("b");
const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

function safeConfig(change = (c) => c) {
  const c = {
    schemaVersion: 1,
    domain: SAFE_DEPLOY_DOMAIN,
    network: { name: "bloch-l2-mainnet", chainId: 700770, genesisHash: PINS.l2.genesisHash, rehearsal: false },
    artifacts: { package: SAFE_PACKAGE.name, version: SAFE_PACKAGE.version, integrity: SAFE_PACKAGE.integrity, singleton: "SafeL2" },
    bootstrap: { address: BOOT, startNonce: 0 },
    safe: { owners: [...OWNERS], threshold: 3, saltNonce: "0" },
  };
  change(c);
  return c;
}

test("the 700770 pins agree with the code, the networks file and the committed configurations", async () => {
  assert.equal(PINS.l2.chainId, NETWORKS.mainnet.chainId);
  assert.equal(PINS.l2.genesisHash, "0x632e45ae778da371a88dc1ae430193aa77eabb67a11de18e84fea7d20d11f468");
  assert.deepEqual(PINS.safe.runtimeCodeHashes, {
    SafeL2: SAFE_V141.singletons.SafeL2,
    SafeProxyFactory: SAFE_V141.proxyFactory,
    SafeProxy: SAFE_V141.proxy,
    CompatibilityFallbackHandler: SAFE_V141.fallbackHandler,
  });
  assert.equal(PINS.safe.integrity, SAFE_PACKAGE.integrity);
  assert.equal(PINS.l1.genesisTime, 1786656679);
  const safe = await readJson("../../deployments/mainnet/700770/safe.config.json");
  const dex = await readJson("../../deployments/mainnet/dex-mainnet.config.json");
  for (const c of [safe, dex]) {
    assert.equal(c.network.chainId, PINS.l2.chainId);
    assert.equal(c.network.genesisHash, PINS.l2.genesisHash);
    assert.equal(c.network.rehearsal, false);
  }
});

test("the committed Safe configuration is 3 of 5 and refuses until the owner fills every TBD-owner", async () => {
  const committed = await readJson("../../deployments/mainnet/700770/safe.config.json");
  assert.equal(committed.safe.threshold, 3);
  assert.equal(committed.safe.owners.length, 5);
  assert.equal(committed.artifacts.singleton, "SafeL2");
  assert.deepEqual(pendingFields(committed), ["bootstrap.address", ...[0, 1, 2, 3, 4].map((i) => `safe.owners[${i}]`)]);
  assert.throws(() => validateSafeConfig(committed), /bootstrap.address is pending owner input/);
  const filled = structuredClone(committed);
  filled.bootstrap.address = BOOT;
  assert.throws(() => validateSafeConfig(filled), /safe.owners\[0\] is pending owner input/);
  filled.safe.owners = [...OWNERS];
  assert.equal(validateSafeConfig(filled), filled);
});

test("Safe configuration refusals", () => {
  for (const [change, pattern] of [
    [(c) => { c.safe.threshold = 2; }, /3 of 5/],
    [(c) => { c.safe.owners.pop(); }, /3 of 5/],
    [(c) => { c.safe.owners[0] = BOOT; }, /bootstrap key must not be a Safe owner/],
    [(c) => { c.safe.owners[1] = c.safe.owners[0]; }, /repeats an owner/],
    [(c) => { c.safe.owners[0] = "0x0000000000000000000000000000000000000001"; }, /nonzero lowercase address/],
    [(c) => { c.safe.owners[0] = `0x${"A".repeat(40)}`; }, /lowercase address/],
    [(c) => { c.artifacts.integrity = "sha512-x"; }, /integrity/],
    [(c) => { c.artifacts.version = "1.3.0"; }, /1.4.1/],
    [(c) => { c.artifacts.singleton = "SafeL3"; }, /SafeL2 or Safe/],
    [(c) => { c.network.chainId = 700771; }, /mainnet chain ID/],
    [(c) => { c.network.chainId = 8400; }, /retired/],
    [(c) => { c.network.rehearsal = true; }, /rehearsal network.name/],
    [(c) => { c.safe.saltNonce = 7; }, /saltNonce/],
    [(c) => { c.safe.saltNonce = "01"; }, /saltNonce/],
    [(c) => { c.extra = 1; }, /exactly the fields/],
  ]) {
    assert.throws(() => validateSafeConfig(safeConfig(change)), pattern);
  }
  // A rehearsal may use a smaller Safe, but must say so.
  validateSafeConfig(safeConfig((c) => { c.network = { name: "local-rehearsal", chainId: 31337, genesisHash: hash("9"), rehearsal: true }; c.safe.owners = OWNERS.slice(0, 3); c.safe.threshold = 2; }));
});

test("only the official v1.4.1 runtimes are accepted as artifacts", () => {
  const fake = { bytecode: "0x6000", deployedBytecode: "0x6001" };
  assert.throws(() => checkSafeArtifacts({ singleton: fake, proxyFactory: fake, proxy: fake, fallbackHandler: fake }), /not the official Safe v1.4.1 code/);
});

test("the proxy address follows SafeProxyFactory v1.4.1 createProxyWithNonce", () => {
  const factory = addr("f");
  const singleton = addr("e");
  const creation = "0x608060405234801561001057600080fd5b50";
  const initializer = safeInitializer(OWNERS, 3, addr("d"));
  const salt = keccak256(concat([keccak256(initializer), encodeAbiParameters([{ type: "uint256" }], [42n])]));
  const initCode = concat([creation, encodeAbiParameters([{ type: "uint256" }], [BigInt(singleton)])]);
  const manual = `0x${keccak256(concat(["0xff", factory, salt, keccak256(initCode)])).slice(-40)}`;
  assert.equal(safeProxyAddress(factory, singleton, initializer, "42", creation), manual);
  assert.notEqual(safeProxyAddress(factory, singleton, initializer, "43", creation), manual);
  assert.equal(salt, keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), 42n])));
});

const SAFE_ARTIFACTS = process.env.SAFE_ARTIFACTS;
test("Safe plan and transactions from the official artifacts", { skip: !SAFE_ARTIFACTS && "set SAFE_ARTIFACTS to the safe-contracts 1.4.1 build/artifacts" }, async () => {
  const artifacts = await loadSafeArtifacts(SAFE_ARTIFACTS);
  const config = safeConfig((c) => { c.bootstrap.startNonce = 2; });
  const plan = planSafe(config, artifacts);
  assert.deepEqual(planSafe(structuredClone(config), artifacts), plan);
  const create = (n) => getContractAddress({ from: BOOT, nonce: BigInt(n) }).toLowerCase();
  assert.equal(plan.contracts.singleton.address, create(2));
  assert.equal(plan.contracts.proxyFactory.address, create(3));
  assert.equal(plan.contracts.fallbackHandler.address, create(4));
  assert.equal(plan.finalNonce, 6);
  assert.equal(plan.blochInc.address, plan.contracts.proxy.address);
  assert.equal(plan.blochInc.codeHash, SAFE_V141.proxy);
  assert.deepEqual(plan.blochInc.safe.owners, OWNERS);
  const txs = safeTransactions(config, artifacts, plan);
  assert.equal(txs.from, BOOT);
  assert.deepEqual(txs.transactions.map((t) => t.nonce), [2, 3, 4, 5]);
  assert.deepEqual(txs.transactions.map((t) => t.to), [null, null, null, plan.contracts.proxyFactory.address]);
  // Another salt, owner set or threshold is another Safe address.
  assert.notEqual(planSafe(safeConfig((c) => { c.bootstrap.startNonce = 2; c.safe.saltNonce = "1"; }), artifacts).contracts.proxy.address, plan.contracts.proxy.address);
  const tampered = structuredClone(plan);
  tampered.contracts.proxy.address = addr("9");
  assert.throws(() => safeTransactions(config, artifacts, tampered), /plan differs/);
});

function safePlanFixture() {
  const blochInc = {
    address: addr("a"),
    codeHash: SAFE_V141.proxy,
    safe: {
      version: "1.4.1",
      singleton: { address: addr("6"), codeHash: SAFE_V141.singletons.SafeL2 },
      fallbackHandler: { address: addr("8"), codeHash: SAFE_V141.fallbackHandler },
      threshold: 3,
      owners: [...OWNERS],
    },
  };
  return {
    chain: { id: 700770, genesisHash: PINS.l2.genesisHash, rehearsal: false },
    contracts: { proxy: { address: addr("a"), codeHash: SAFE_V141.proxy } },
    blochInc,
  };
}

test("the mainnet gate pins chain 700770, the genesis and the reviewed Safe before any RPC call", () => {
  const safePlan = safePlanFixture();
  const gate = {
    schemaVersion: 2,
    chain: { id: 700770, genesisHash: PINS.l2.genesisHash },
    deployment: { feeTo: addr("a"), roles: { blochInc: structuredClone(safePlan.blochInc) } },
  };
  assert.equal(checkPinned(gate, safePlan), true);
  for (const [change, pattern] of [
    [(g) => { g.chain.genesisHash = hash("9"); }, /not the pinned/],
    [(g) => { g.chain.id = 700771; }, /is not 700770/],
    [(g) => { g.schemaVersion = 1; }, /schema 2/],
    [(g) => { g.deployment.feeTo = addr("c"); }, /fee recipient/],
    [(g) => { g.deployment.roles.blochInc.safe.owners[0] = addr("9"); }, /differs from the reviewed Safe plan/],
  ]) {
    const copy = structuredClone(gate);
    change(copy);
    assert.throws(() => checkPinned(copy, safePlan), pattern);
  }
  const rehearsal = structuredClone(safePlan);
  rehearsal.chain.rehearsal = true;
  assert.throws(() => checkPinned(gate, rehearsal), /not for the pinned mainnet/);
  const small = structuredClone(safePlan);
  small.blochInc.safe.threshold = 2;
  const smallGate = structuredClone(gate);
  smallGate.deployment.roles.blochInc = structuredClone(small.blochInc);
  assert.throws(() => checkPinned(smallGate, small), /3 of 5/);
});

test("immutables are read back from the deployed runtime in AST id order", () => {
  const w = (c) => c.repeat(64);
  const runtime = `0x00${w("a")}${w("b")}${w("a")}`;
  const refs = { 9: [{ start: 33, length: 32 }], 4: [{ start: 1, length: 32 }, { start: 65, length: 32 }] };
  assert.deepEqual(readImmutables(runtime, refs), [`0x${w("a")}`, `0x${w("b")}`]);
  assert.throws(() => readImmutables(runtime, { 4: [{ start: 1, length: 32 }, { start: 33, length: 32 }] }), /inconsistent copies/);
  assert.throws(() => readImmutables(runtime, { 4: [{ start: 90, length: 32 }] }), /outside the runtime/);
});

test("verification refuses a DEX plan whose fee recipient is not the planned Safe", async () => {
  const safePlan = safePlanFixture();
  const dexPlan = { chain: safePlan.chain, roles: { blochInc: structuredClone(safePlan.blochInc) }, feeTo: addr("a") };
  dexPlan.roles.blochInc.address = addr("c");
  const request = async (method, params) => {
    if (method === "eth_chainId") return "0xab162";
    if (method === "eth_getBlockByNumber") return { number: params[0] === "0x0" ? "0x0" : "0x5", hash: params[0] === "0x0" ? PINS.l2.genesisHash : hash("7") };
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(verifyDeployment({ safePlan, dexPlan, artifacts: {}, request }), /Bloch Inc pin differs from the Safe plan/);
  const wrongChain = async (method, params) => (method === "eth_chainId" ? "0xab163" : request(method, params));
  await assert.rejects(verifyDeployment({ safePlan, dexPlan, artifacts: {}, request: wrongChain }), /chain ID/);
});

test("Safe preflight pins chain, genesis, bootstrap nonce and empty planned addresses", async () => {
  const plan = { chain: { id: 700770, genesisHash: PINS.l2.genesisHash }, bootstrap: BOOT, startNonce: 0,
    contracts: { singleton: { address: addr("6") }, proxy: { address: addr("a") } } };
  const rpc = (over = {}) => async (method, params) => {
    if (over[method]) return over[method](params);
    return { eth_chainId: "0xab162", eth_getBlockByNumber: { hash: PINS.l2.genesisHash }, eth_getTransactionCount: "0x0",
      eth_getCode: "0x", eth_getBalance: "0xde0b6b3a7640000" }[method];
  };
  assert.equal((await preflightSafe(plan, rpc())).decision, "preflight-ok");
  await assert.rejects(preflightSafe(plan, rpc({ eth_getBlockByNumber: () => ({ hash: hash("1") }) })), /genesis/);
  await assert.rejects(preflightSafe(plan, rpc({ eth_getTransactionCount: ([, tag]) => (tag === "pending" ? "0x1" : "0x0") })), /nonce/);
  await assert.rejects(preflightSafe(plan, rpc({ eth_getCode: ([a]) => (a === addr("a") ? "0x60" : "0x") })), /occupied/);
  assert.throws(() => parseSafeArgs(["deploy"]), /unknown command/);
  assert.throws(() => parseSafeArgs(["plan"]), /--config is required/);
  assert.throws(() => parseSafeArgs(["plan", "--config", "a", "--config", "b"]), /given twice/);
});
