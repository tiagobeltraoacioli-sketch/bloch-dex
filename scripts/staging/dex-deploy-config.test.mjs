import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  DEPLOY_DOMAIN,
  EMPTY_CODE_HASH,
  configSha256,
  forgeEnvironment,
  gateConfigFromPlan,
  planDeployment,
  validateDeployConfig,
} from "./dex-deploy-config.mjs";
import { GATE_DOMAIN, validateGateConfig } from "./finality-gate.mjs";
import { parseArgs, preflight, verifyBroadcast } from "./deploy-dex.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress } = requireFromFrontend("viem");

const hash = (c) => `0x${c.repeat(64)}`;
const addr = (c) => `0x${c.repeat(40)}`;
const DEPLOYER = addr("d");
const ASSET = addr("a");
const ASSET_CODE = hash("c");

function config(change = (c) => c) {
  const base = {
    schemaVersion: 1,
    domain: DEPLOY_DOMAIN,
    network: { name: "bloch-l2-mainnet", chainId: 7007700, genesisHash: hash("9"), rehearsal: false },
    source: {
      revision: "a".repeat(40),
      compiler: { solc: "0.8.24", evmVersion: "paris", optimizer: true, optimizerRuns: 200, bytecodeHash: "none" },
    },
    deployer: { address: DEPLOYER, startNonce: 0 },
    wrappedNative: { deploy: true },
    fees: {
      feeTo: null,
      feeToSetter: { address: addr("5"), codeHash: hash("7") },
      treasury: { address: addr("6"), codeHash: EMPTY_CODE_HASH },
    },
    reserveCaps: [
      { token: "WBLCH", cap: "1000000000000000000" },
      { token: ASSET, symbol: "bUSDC", codeHash: ASSET_CODE, cap: "10000000" },
    ],
    initialPairs: [{ tokenA: "WBLCH", tokenB: ASSET }],
    gate: { maxWrappedReserveCap: "10000000000000000000" },
  };
  const copy = structuredClone(base);
  change(copy);
  return copy;
}

/// Synthetic artifacts: distinct creation code per contract and runtimes
/// with immutable slots where the real contracts have them.
function artifacts() {
  const runtime = (byte, refs) => ({
    bytecode: `0x60${byte}${"00".repeat(8)}`,
    deployedBytecode: `0x${byte.repeat(128)}`,
    immutableReferences: Object.fromEntries(refs.map((id, i) => [String(id), [{ start: 2 + i * 32, length: 32 }]])),
  });
  return {
    wrappedNative: runtime("01", []),
    factory: runtime("02", []),
    router: runtime("03", [11, 7]),
    lens: runtime("04", [5]),
    collector: runtime("05", [30, 10, 20]),
    pair: runtime("06", []),
  };
}

test("accepts a complete mainnet configuration and hashes it canonically", () => {
  const c = config();
  assert.equal(validateDeployConfig(c), c);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(configSha256(reordered), configSha256(c));
});

test("the committed mainnet configuration is refused until its decisions are made", async () => {
  const committed = JSON.parse(await readFile(new URL("../../deployments/mainnet/dex-mainnet.config.json", import.meta.url), "utf8"));
  assert.throws(() => validateDeployConfig(committed), /network.chainId is undecided/);
  // Filling every pending field with the reviewed shape is all that is missing.
  const decided = structuredClone(committed);
  decided.network.chainId = 7007700;
  decided.network.genesisHash = hash("9");
  decided.source.revision = "b".repeat(40);
  decided.deployer.address = DEPLOYER;
  decided.fees.feeToSetter = { address: addr("5"), codeHash: hash("7") };
  decided.fees.treasury = { address: addr("6"), codeHash: EMPTY_CODE_HASH };
  assert.throws(() => validateDeployConfig(decided), /reserveCaps\[0\].cap/);
  decided.reserveCaps[0].cap = "1000000000000000000";
  validateDeployConfig(decided);
});

test("development chains need the configuration flag and the operator flag together", () => {
  const devnet = config((c) => {
    c.network = { name: "devnet4-rehearsal", chainId: 700771, genesisHash: hash("9"), rehearsal: true };
  });
  assert.throws(() => validateDeployConfig(devnet), /development network/);
  validateDeployConfig(devnet, { rehearsal: true });
  const unflagged = config((c) => {
    c.network = { name: "devnet4-rehearsal", chainId: 700771, genesisHash: hash("9"), rehearsal: false };
  });
  assert.throws(() => validateDeployConfig(unflagged, { rehearsal: true }), /development network/);
  assert.throws(() => validateDeployConfig(config(), { rehearsal: true }), /disagree/);
  const local = config((c) => {
    c.network.chainId = 31337;
  });
  assert.throws(() => validateDeployConfig(local), /development network/);
  const mislabelled = config((c) => {
    c.network = { name: "bloch-l2-mainnet", chainId: 700771, genesisHash: hash("9"), rehearsal: true };
  });
  assert.throws(() => validateDeployConfig(mislabelled, { rehearsal: true }), /must say so/);
});

test("refuses every unsafe or incomplete configuration", () => {
  for (const [change, pattern] of [
    [(c) => { c.domain = "other"; }, /schema/],
    [(c) => { c.extra = 1; }, /exactly the fields/],
    [(c) => { c.network.chainId = 8400; }, /retired/],
    [(c) => { c.network.chainId = 84001; }, /retired/],
    [(c) => { c.network.chainId = "7007700"; }, /chainId/],
    [(c) => { c.network.genesisHash = hash("0"); }, /genesisHash/],
    [(c) => { c.network.genesisHash = hash("A"); }, /genesisHash/],
    [(c) => { c.source.revision = "main"; }, /revision/],
    [(c) => { c.source.compiler.optimizerRuns = 1000; }, /optimizerRuns/],
    [(c) => { c.source.compiler.evmVersion = "cancun"; }, /evmVersion/],
    [(c) => { c.deployer.address = addr("0"); }, /deployer.address/],
    [(c) => { c.deployer.startNonce = -1; }, /startNonce/],
    [(c) => { c.wrappedNative = { deploy: false }; }, /wrappedNative/],
    [(c) => { c.wrappedNative = { deploy: true, address: addr("1") }; }, /wrappedNative/],
    [(c) => { c.fees.feeTo = addr("6"); }, /protocol fee is never enabled/],
    [(c) => { c.fees.treasury.address = c.fees.feeToSetter.address; }, /distinct/],
    [(c) => { c.fees.feeToSetter.address = DEPLOYER; }, /distinct/],
    [(c) => { c.fees.treasury.codeHash = null; }, /codeHash/],
    [(c) => { c.reserveCaps = []; }, /reserveCaps/],
    [(c) => { c.reserveCaps.shift(); c.initialPairs = []; }, /must cap "WBLCH"/],
    [(c) => { c.reserveCaps[0].cap = "0"; }, /positive decimal/],
    [(c) => { c.reserveCaps[0].cap = "1e18"; }, /positive decimal/],
    [(c) => { c.reserveCaps[0].cap = "10000000000000000001"; c.gate.maxWrappedReserveCap = "10000000000000000000"; }, /exceeds gate/],
    [(c) => { c.gate.maxWrappedReserveCap = "10000000000000000001"; }, /maxWrappedReserveCap exceeds/],
    [(c) => { c.reserveCaps[1].cap = (1n << 112n).toString(); }, /exceeds/],
    [(c) => { c.reserveCaps.push({ ...c.reserveCaps[1] }); }, /listed twice/],
    [(c) => { c.reserveCaps[1].codeHash = EMPTY_CODE_HASH; }, /empty-code/],
    [(c) => { c.reserveCaps[1].token = DEPLOYER; }, /aliases a role/],
    [(c) => { delete c.reserveCaps[1].codeHash; }, /exactly the fields/],
    [(c) => { c.initialPairs = [{ tokenA: "WBLCH", tokenB: addr("e") }]; }, /capped token/],
    [(c) => { c.initialPairs = [{ tokenA: "WBLCH", tokenB: "WBLCH" }]; }, /itself/],
    [(c) => { c.initialPairs.push({ tokenA: ASSET, tokenB: "WBLCH" }); }, /repeats a pair/],
  ]) {
    assert.throws(() => validateDeployConfig(config(change)), pattern, String(change));
  }
});

test("an existing wrapper is pinned by address and code hash, never capped by address", () => {
  const existing = config((c) => {
    c.wrappedNative = { deploy: false, address: addr("1"), codeHash: hash("2") };
  });
  validateDeployConfig(existing);
  const byAddress = config((c) => {
    c.wrappedNative = { deploy: false, address: addr("1"), codeHash: hash("2") };
    c.reserveCaps.push({ token: addr("1"), symbol: "WBLCH", codeHash: hash("2"), cap: "1" });
  });
  assert.throws(() => validateDeployConfig(byAddress), /use "WBLCH"/);
  const plan = planDeployment(existing, artifacts());
  assert.equal(plan.contracts.wrappedNative.address, addr("1"));
  assert.equal(plan.steps[0].action, "deploy factory");
  assert.equal(plan.steps[0].nonce, 0);
});

test("the plan is deterministic and matches CREATE/CREATE2 derivation", () => {
  const a = planDeployment(config(), artifacts());
  const b = planDeployment(config(), artifacts());
  assert.deepEqual(a, b);
  const at = (nonce) => getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce) }).toLowerCase();
  assert.deepEqual(
    a.steps.map((s) => [s.nonce, s.action]),
    [[0, "deploy wrappedNative"], [1, "deploy factory"], [2, "deploy router"], [3, "deploy lens"], [4, "deploy collector"], [5, "createPair"]],
  );
  assert.equal(a.contracts.wrappedNative.address, at(0));
  assert.equal(a.contracts.factory.address, at(1));
  assert.equal(a.contracts.collector.address, at(4));
  assert.equal(a.finalNonce, 6);
  assert.equal(a.pairInitCodeHash, keccak256(artifacts().pair.bytecode));
  assert.equal(a.reserveCaps[0].token, a.contracts.wrappedNative.address);
  const [token0, token1] = [a.contracts.wrappedNative.address, ASSET].sort();
  assert.deepEqual([a.pairs[0].token0, a.pairs[0].token1], [token0, token1]);
  assert.equal(a.externalTokens[0].codeHash, ASSET_CODE);

  const shifted = planDeployment(config((c) => { c.deployer.startNonce = 3; }), artifacts());
  assert.equal(shifted.contracts.factory.address, at(4));
  assert.notEqual(shifted.pairs[0].address, a.pairs[0].address);
  assert.notEqual(planDeployment(config((c) => { c.reserveCaps[1].cap = "9"; }), artifacts()).steps[1].initCodeHash, a.steps[1].initCodeHash);
});

test("immutables are linked in declaration (AST id) order", () => {
  const plan = planDeployment(config(), artifacts());
  const router = artifacts().router.deployedBytecode.slice(2).split("");
  const word = (v) => v.slice(2).padStart(64, "0");
  // The artifact lists id 11 first, but id 7 is declared first: factory.
  const refs = artifacts().router.immutableReferences;
  const fill = (id, value) => refs[id].forEach(({ start }) => router.splice(start * 2, 64, ...word(value)));
  fill(7, plan.contracts.factory.address);
  fill(11, plan.contracts.wrappedNative.address);
  assert.equal(plan.contracts.router.codeHash, keccak256(`0x${router.join("")}`));
  assert.throws(() => planDeployment(config(), { ...artifacts(), lens: artifacts().factory }), /immutables/);
});

test("forge environment and gate configuration derive only from the plan", () => {
  const plan = planDeployment(config(), artifacts());
  const env = forgeEnvironment(plan);
  assert.equal(env.DEX_CHAIN_ID, "7007700");
  assert.equal(env.DEX_REHEARSAL, "false");
  assert.equal(env.DEX_CAP_TOKENS, `${plan.contracts.wrappedNative.address},${ASSET}`);
  assert.equal(env.DEX_CAP_AMOUNTS, "1000000000000000000,10000000");
  assert.equal(env.DEX_PAIRS, plan.pairs[0].address);
  assert.equal(env.DEX_PAIR_CODEHASH, plan.pairCodeHash);
  assert.ok(Object.values(env).every((v) => typeof v === "string" && v.length > 0));

  const txs = plan.steps.map((_, i) => hash(String(i + 1)));
  const gate = gateConfigFromPlan(plan, txs, GATE_DOMAIN);
  validateGateConfig(gate);
  assert.equal(gate.schemaVersion, 2);
  assert.throws(() => gateConfigFromPlan(plan, txs.slice(1), GATE_DOMAIN), /one transaction per plan step/);
  const pairless = planDeployment(config((c) => { c.initialPairs = []; }), artifacts());
  assert.throws(() => gateConfigFromPlan(pairless, txs.slice(1), GATE_DOMAIN), /creates no pair/);
});

test("the driver refuses broadcast flags it does not own", () => {
  assert.throws(() => parseArgs(["run", "--config", "c", "--", "--broadcast"]), /controlled by this driver/);
  assert.throws(() => parseArgs(["run", "--config", "c", "--", "--rpc-url", "x"]), /controlled by this driver/);
  assert.throws(() => parseArgs(["plan", "--config", "c", "--broadcast"]), /only applies to run/);
  assert.throws(() => parseArgs(["deploy", "--config", "c"]), /unknown command/);
  assert.throws(() => parseArgs(["run", "--config", "c", "--config", "d"]), /given twice/);
  const parsed = parseArgs(["run", "--config", "c", "--rehearsal", "--", "--private-key", "0x01"]);
  assert.equal(parsed.rehearsal, true);
  assert.deepEqual(parsed.forgeArgs, ["--private-key", "0x01"]);
});

function chain(plan, change = {}) {
  const state = {
    chainId: `0x${plan.chain.id.toString(16)}`,
    genesis: plan.chain.genesisHash,
    nonce: "0x0",
    pending: "0x0",
    code: {
      [ASSET]: "0xaa",
      [plan.roles.feeToSetter]: "0xbb",
      [plan.roles.treasury]: "0x",
    },
    ...change,
  };
  const codeHashes = { [ASSET]: keccak256("0xaa"), [plan.roles.feeToSetter]: keccak256("0xbb") };
  return {
    codeHashes,
    request: async (method, params) => {
      if (method === "eth_chainId") return state.chainId;
      if (method === "eth_getBlockByNumber") return { number: "0x0", hash: state.genesis };
      if (method === "eth_getTransactionCount") return params[1] === "pending" ? state.pending : state.nonce;
      if (method === "eth_getCode") return state.code[params[0]] ?? "0x";
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("preflight pins chain, genesis, nonce, empty targets and reviewed code", async () => {
  const base = config((c) => {
    c.fees.feeToSetter.codeHash = keccak256("0xbb");
    c.reserveCaps[1].codeHash = keccak256("0xaa");
  });
  const plan = planDeployment(base, artifacts());
  assert.deepEqual(await preflight(plan, chain(plan).request), { nonce: "0" });
  for (const [change, pattern] of [
    [{ chainId: "0x1" }, /chain ID/],
    [{ genesis: hash("8") }, /genesis/],
    [{ nonce: "0x1", pending: "0x1" }, /nonce/],
    [{ pending: "0x1" }, /nonce/],
    [{ code: { [ASSET]: "0xaa", [plan.roles.feeToSetter]: "0xbb", [plan.contracts.router.address]: "0x00" } }, /occupied/],
    [{ code: { [ASSET]: "0xab", [plan.roles.feeToSetter]: "0xbb" } }, /bUSDC code hash/],
    [{ code: { [ASSET]: "0xaa", [plan.roles.feeToSetter]: "0xbb", [plan.roles.treasury]: "0x00" } }, /treasury code hash/],
  ]) {
    await assert.rejects(preflight(plan, chain(plan, change).request), pattern);
  }
});

test("record verifies sender, nonce, init code and created address of every transaction", async () => {
  const plan = planDeployment(config(), artifacts());
  const initCode = {
    "deploy wrappedNative": artifacts().wrappedNative.bytecode,
  };
  const txs = plan.steps.map((step, i) => ({
    hash: hash(String(i + 1)),
    from: DEPLOYER,
    nonce: `0x${step.nonce.toString(16)}`,
    to: step.action === "createPair" ? plan.contracts.factory.address : null,
    input: initCode[step.action] ?? "0x",
    contractAddress: step.action === "createPair" ? null : step.address,
  }));
  const request = (mutate = (t) => t) => async (method, [h]) => {
    const tx = mutate(structuredClone(txs.find((t) => t.hash === h)));
    if (method === "eth_getTransactionByHash") return { hash: tx.hash, from: tx.from, nonce: tx.nonce, to: tx.to, input: tx.input };
    return { transactionHash: tx.hash, status: tx.status ?? "0x1", contractAddress: tx.contractAddress };
  };
  // Only the wrapper's init code is reproduced here; the others must be refused.
  await assert.rejects(verifyBroadcast(plan, txs.map((t) => t.hash), request()), /deploy factory .* init code differs/);

  const wrapperOnly = { ...plan, steps: plan.steps.slice(0, 1) };
  const reversed = [txs[0].hash];
  assert.deepEqual(await verifyBroadcast(wrapperOnly, reversed, request()), [txs[0].hash]);
  for (const [mutate, pattern] of [
    [(t) => ({ ...t, from: addr("e") }), /not sent by the deployer/],
    [(t) => ({ ...t, status: "0x0" }), /reverted/],
    [(t) => ({ ...t, nonce: "0x9" }), /unplanned nonce/],
    [(t) => ({ ...t, to: addr("e") }), /not a contract creation/],
    [(t) => ({ ...t, contractAddress: addr("e") }), /wrong address/],
  ]) {
    await assert.rejects(verifyBroadcast(wrapperOnly, reversed, request(mutate)), pattern);
  }
  await assert.rejects(verifyBroadcast(wrapperOnly, [], request()), /expected 1 transactions/);
});
