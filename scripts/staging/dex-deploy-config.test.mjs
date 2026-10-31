import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  DEPLOY_DOMAIN,
  DEVELOPMENT_CHAIN_IDS,
  EMPTY_CODE_HASH,
  MAINNET_CHAIN_ID,
  NETWORKS,
  RETIRED_CHAIN_IDS,
  SAFE_V141,
  configSha256,
  dexTransactions,
  forgeEnvironment,
  gateConfigFromPlan,
  PENDING,
  pendingFields,
  planDeployment,
  RAW_TXS_DOMAIN,
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
const GSMH = addr("b");
const GSMH_CODE = hash("e");
const BLOCH_INC = addr("5");
const BLOCH_INC_CODE = SAFE_V141.proxy;
/// The pinned Bloch Inc Safe: official v1.4.1 singleton and handler, 3 of 5.
const SAFE_PIN = Object.freeze({
  version: "1.4.1",
  singleton: { address: addr("6"), codeHash: SAFE_V141.singletons.SafeL2 },
  fallbackHandler: { address: addr("8"), codeHash: SAFE_V141.fallbackHandler },
  threshold: 3,
  owners: [addr("1"), addr("2"), addr("3"), addr("4"), addr("c")],
});

function config(change = (c) => c) {
  const base = {
    schemaVersion: 1,
    domain: DEPLOY_DOMAIN,
    network: { name: "bloch-l2-mainnet", chainId: 700770, genesisHash: hash("9"), rehearsal: false },
    source: {
      revision: "a".repeat(40),
      compiler: { solc: "0.8.24", evmVersion: "paris", optimizer: true, optimizerRuns: 200, bytecodeHash: "none" },
    },
    deployer: { address: DEPLOYER, startNonce: 0 },
    blochInc: { address: BLOCH_INC, codeHash: BLOCH_INC_CODE, safe: structuredClone(SAFE_PIN) },
    wrappedNative: { deploy: true },
    fees: { feeTo: "blochInc" },
    reserveCaps: [
      { token: "WBLCH", cap: "1000000000000000000" },
      { symbol: "bUSDC", token: ASSET, codeHash: ASSET_CODE, bridgeBucketCapacity: "100000000", cap: "10000000" },
    ],
    openingPrice: { symbol: "bUSDC", quotePerWrapped: "10000000" },
    initialPairs: [{ tokenA: "WBLCH", tokenB: "bUSDC" }],
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
    factory: runtime("02", [3]),
    router: runtime("03", [11, 7]),
    lens: runtime("04", [5]),
    pair: runtime("06", []),
  };
}

test("accepts a complete mainnet configuration and hashes it canonically", () => {
  const c = config();
  assert.equal(validateDeployConfig(c), c);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(configSha256(reordered), configSha256(c));
});

test("the committed mainnet configuration records the decisions and refuses what is pending", async () => {
  const committed = JSON.parse(await readFile(new URL("../../deployments/mainnet/dex-mainnet.config.json", import.meta.url), "utf8"));
  const pins = JSON.parse(await readFile(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8"));
  assert.equal(committed.network.chainId, MAINNET_CHAIN_ID);
  assert.equal(committed.network.genesisHash, pins.l2.genesisHash);
  assert.equal(committed.network.rehearsal, false);
  assert.equal(committed.fees.feeTo, "blochInc");
  // Pilot (2026-10-30): bUSDC/WBLCH only; wGSMH is deferred to a later deployment.
  assert.deepEqual(committed.initialPairs, [{ tokenA: "WBLCH", tokenB: "bUSDC" }]);
  // Guarded-launch caps: WBLCH at the 10 BLCH ceiling, bUSDC at 1/10 of the 10,000 bUSDC bucket.
  assert.deepEqual(committed.reserveCaps.map((c) => c.cap), ["10000000000000000000", "1000000000"]);
  assert.equal(committed.reserveCaps[1].bridgeBucketCapacity, "10000000000");
  // Built revision: contracts with the DEX-01 fix, the Lens pending excess, the DEX-09 fix and this package's tooling.
  assert.equal(committed.source.revision, "f1ad6f25ddd8082f17124f5dc0dbcf88a167617f");
  assert.deepEqual(pendingFields(committed), [
    "deployer.address", "blochInc", "reserveCaps[1].token", "reserveCaps[1].codeHash", "openingPrice.quotePerWrapped",
  ]);
  // Every pending field is refused, one at a time, until filled.
  const decided = structuredClone(committed);
  const steps = [
    [/deployer.address is undecided/, (c) => { c.deployer.address = DEPLOYER; }],
    [/blochInc is undecided/, (c) => { c.blochInc = { address: BLOCH_INC, codeHash: BLOCH_INC_CODE, safe: structuredClone(SAFE_PIN) }; }],
    [/bUSDC\).token is undecided/, (c) => { c.reserveCaps[1].token = ASSET; }],
    [/bUSDC\).codeHash is undecided/, (c) => { c.reserveCaps[1].codeHash = ASSET_CODE; }],
    [/openingPrice.quotePerWrapped is undecided/, (c) => { c.openingPrice.quotePerWrapped = "100000000"; }],
  ];
  for (const [pattern, fill] of steps) {
    assert.throws(() => validateDeployConfig(decided), pattern);
    fill(decided);
  }
  validateDeployConfig(decided);
  assert.deepEqual(pendingFields(decided), []);
  // A smaller bUSDC bridge bucket than planned forces a smaller DEX cap.
  decided.reserveCaps[1].bridgeBucketCapacity = "9999999999";
  assert.throws(() => validateDeployConfig(decided), /exceeds 1\/10 of the bridge bucket/);
  decided.reserveCaps[1].bridgeBucketCapacity = "10000000000";
  const plan = planDeployment(decided, artifacts());
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.feeTo, BLOCH_INC);
  assert.equal(plan.steps.length, 5);
});

test("the quote cap must balance the WBLCH cap at the opening price", () => {
  // Fixture: WBLCH cap 1, bUSDC bucket 100, so the bucket allows a cap up to 10.
  const withCap = (cap, price, bucket = "100000000") => {
    const c = config();
    c.reserveCaps[1].cap = cap;
    c.reserveCaps[1].bridgeBucketCapacity = bucket;
    c.openingPrice.quotePerWrapped = price;
    return () => validateDeployConfig(c);
  };
  assert.doesNotThrow(withCap("10000000", "10000000"));
  assert.doesNotThrow(withCap("10000000", "8000000"));
  // The measured case: cap 40x the balanced value is refused before any plan.
  assert.throws(withCap("10000000", "255000"), /too high for the opening price: set it near 255000 /);
  assert.throws(withCap("1000000", "10000000", "100000000"), /too low for the opening price/);
  // The bucket rule holds the cap below the band at a high price: shallower, not riskier.
  assert.doesNotThrow(withCap("10000000", "400000000"));
  const noPrice = config();
  delete noPrice.openingPrice;
  assert.throws(() => validateDeployConfig(noPrice), /exactly the fields/);
  const wrongSymbol = config();
  wrongSymbol.openingPrice.symbol = "wGSMH";
  assert.throws(() => validateDeployConfig(wrongSymbol), /not in reserveCaps/);
});

test("TBD-owner is refused exactly like null", () => {
  for (const [change, pattern] of [
    [(c) => { c.deployer.address = PENDING; }, /deployer.address is undecided/],
    [(c) => { c.blochInc = PENDING; }, /blochInc is undecided/],
    [(c) => { c.network.genesisHash = PENDING; }, /genesisHash is undecided/],
    [(c) => { c.reserveCaps[1].token = PENDING; }, /token is undecided/],
  ]) {
    assert.throws(() => validateDeployConfig(config(change)), pattern);
  }
});

test("raw transactions re-derive every init code and createPair call from the plan", () => {
  const c = config();
  const a = artifacts();
  const plan = planDeployment(c, a);
  const txs = dexTransactions(c, a, plan);
  assert.equal(txs.domain, RAW_TXS_DOMAIN);
  assert.equal(txs.from, DEPLOYER);
  assert.equal(txs.configSha256, plan.configSha256);
  assert.deepEqual(txs.transactions.map((t) => t.nonce), plan.steps.map((s) => s.nonce));
  for (const [i, t] of txs.transactions.entries()) {
    const step = plan.steps[i];
    assert.equal(t.expect, step.address);
    assert.ok(t.gasLimit > 0);
    if (step.action === "createPair") {
      assert.equal(t.to, plan.contracts.factory.address);
      assert.ok(t.data.startsWith("0xc9c65396"));
    } else {
      assert.equal(t.to, null);
      assert.equal(keccak256(t.data), step.initCodeHash);
    }
  }
  const tampered = structuredClone(plan);
  tampered.steps[1].initCodeHash = hash("1");
  assert.throws(() => dexTransactions(c, a, tampered), /plan differs/);
});

test("chain IDs come from deployments/networks.json, mirrored by DeployMainnet.s.sol", async () => {
  assert.equal(MAINNET_CHAIN_ID, 700770);
  assert.deepEqual(DEVELOPMENT_CHAIN_IDS, [700771, 31337]);
  assert.deepEqual(RETIRED_CHAIN_IDS, [8400, 84001]);
  const source = await readFile(new URL("../../script/DeployMainnet.s.sol", import.meta.url), "utf8");
  const constant = (name) => Number(source.match(new RegExp(`${name} = ([0-9_]+);`))[1].replaceAll("_", ""));
  assert.equal(constant("MAINNET_CHAIN_ID"), NETWORKS.mainnet.chainId);
  assert.deepEqual([constant("DEVNET4_CHAIN_ID"), constant("LOCAL_CHAIN_ID")], DEVELOPMENT_CHAIN_IDS);
  assert.deepEqual([constant("RETIRED_CHAIN_ID_A"), constant("RETIRED_CHAIN_ID_B")], RETIRED_CHAIN_IDS);
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
  const unknown = config((c) => {
    c.network.chainId = 7007700;
  });
  assert.throws(() => validateDeployConfig(unknown), /neither the Bloch L2 mainnet/);
  const rehearsedUnknown = config((c) => {
    c.network = { name: "local-rehearsal", chainId: 7007700, genesisHash: hash("9"), rehearsal: true };
  });
  assert.throws(() => validateDeployConfig(rehearsedUnknown, { rehearsal: true }), /neither the Bloch L2 mainnet/);
});

test("refuses every unsafe or incomplete configuration", () => {
  for (const [change, pattern] of [
    [(c) => { c.domain = "other"; }, /schema/],
    [(c) => { c.extra = 1; }, /exactly the fields/],
    [(c) => { c.network.chainId = 8400; }, /retired/],
    [(c) => { c.network.chainId = 84001; }, /retired/],
    [(c) => { c.network.chainId = "700770"; }, /chainId/],
    [(c) => { c.network.genesisHash = hash("0"); }, /genesisHash/],
    [(c) => { c.network.genesisHash = hash("A"); }, /genesisHash/],
    [(c) => { c.source.revision = "main"; }, /revision/],
    [(c) => { c.source.compiler.optimizerRuns = 1000; }, /optimizerRuns/],
    [(c) => { c.source.compiler.evmVersion = "cancun"; }, /evmVersion/],
    [(c) => { c.deployer.address = addr("0"); }, /deployer.address/],
    [(c) => { c.deployer.startNonce = -1; }, /startNonce/],
    [(c) => { c.wrappedNative = { deploy: false }; }, /wrappedNative/],
    [(c) => { c.wrappedNative = { deploy: true, address: addr("1") }; }, /wrappedNative/],
    [(c) => { c.fees.feeTo = null; }, /fees.feeTo must be "blochInc"/],
    [(c) => { c.fees.feeTo = BLOCH_INC; }, /fees.feeTo must be "blochInc"/],
    [(c) => { c.fees = { feeTo: "blochInc", feeToSetter: addr("6") }; }, /exactly the fields feeTo/],
    [(c) => { c.blochInc = null; }, /blochInc is undecided/],
    [(c) => { c.blochInc.address = DEPLOYER; }, /distinct/],
    [(c) => { c.blochInc.codeHash = EMPTY_CODE_HASH; }, /multisig contract, not an externally owned account/],
    [(c) => { c.blochInc.codeHash = null; }, /blochInc.codeHash/],
    [(c) => { c.blochInc.treasury = addr("6"); }, /exactly the fields/],
    // Mainnet: Bloch Inc is the pinned, official Safe v1.4.1.
    [(c) => { delete c.blochInc.safe; }, /blochInc.safe is required on the mainnet/],
    [(c) => { c.blochInc.codeHash = hash("7"); }, /Safe v1.4.1 proxy runtime/],
    [(c) => { c.blochInc.safe.singleton.codeHash = hash("7"); }, /official Safe or SafeL2/],
    [(c) => { c.blochInc.safe.fallbackHandler.codeHash = hash("7"); }, /official CompatibilityFallbackHandler/],
    [(c) => { c.blochInc.safe.fallbackHandler.codeHash = EMPTY_CODE_HASH; }, /fallbackHandler must be/],
    [(c) => { c.blochInc.safe.version = "1.3.0"; }, /version must be "1.4.1"/],
    [(c) => { c.blochInc.safe.threshold = 1; }, /threshold of at least 2/],
    [(c) => { c.blochInc.safe.threshold = 6; }, /threshold is invalid/],
    [(c) => { c.blochInc.safe.owners = []; }, /owners must list/],
    [(c) => { c.blochInc.safe.owners[4] = addr("1"); }, /repeats an owner/],
    [(c) => { c.blochInc.safe.owners[4] = DEPLOYER; }, /must not be Safe owners/],
    [(c) => { c.blochInc.safe.owners[4] = BLOCH_INC; }, /must not be Safe owners/],
    [(c) => { c.blochInc.safe.owners[0] = "0x0000000000000000000000000000000000000001"; }, /owners\[0\] is invalid/],
    [(c) => { c.blochInc.safe.modules = []; }, /exactly the fields version/],
    [(c) => { c.reserveCaps = []; }, /reserveCaps/],
    [(c) => { c.reserveCaps.shift(); c.initialPairs = []; }, /must cap "WBLCH"/],
    [(c) => { c.reserveCaps[0].cap = null; }, /cap is undecided/],
    [(c) => { c.reserveCaps[1].cap = "10000001"; }, /exceeds 1\/10 of the bridge bucket/],
    [(c) => { c.reserveCaps[1].bridgeBucketCapacity = "0"; }, /bridgeBucketCapacity/],
    [(c) => { c.reserveCaps[1].symbol = "WBLCH"; }, /symbol is invalid/],
    [(c) => { c.reserveCaps.push({ ...c.reserveCaps[1], token: GSMH }); }, /symbol is listed twice/],
    [(c) => { c.reserveCaps.push({ ...c.reserveCaps[1], symbol: "bUSDC2" }); }, /token is listed twice/],
    [(c) => { c.reserveCaps[0].cap = "0"; }, /positive decimal/],
    [(c) => { c.reserveCaps[0].cap = "1e18"; }, /positive decimal/],
    [(c) => { c.reserveCaps[0].cap = "10000000000000000001"; c.gate.maxWrappedReserveCap = "10000000000000000000"; }, /exceeds gate/],
    [(c) => { c.gate.maxWrappedReserveCap = "10000000000000000001"; }, /maxWrappedReserveCap exceeds/],
    [(c) => { c.reserveCaps[1].cap = (1n << 112n).toString(); }, /exceeds/],
    [(c) => { c.reserveCaps[1].codeHash = EMPTY_CODE_HASH; }, /empty-code/],
    [(c) => { c.reserveCaps[1].token = DEPLOYER; }, /aliases a role/],
    [(c) => { c.reserveCaps[1].token = BLOCH_INC; }, /aliases a role/],
    [(c) => { delete c.reserveCaps[1].codeHash; }, /exactly the fields/],
    [(c) => { c.initialPairs = [{ tokenA: "WBLCH", tokenB: addr("e") }]; }, /capped token/],
    [(c) => { c.initialPairs = [{ tokenA: "WBLCH", tokenB: ASSET }]; }, /reserveCaps symbol/],
    [(c) => { c.initialPairs = [{ tokenA: "WBLCH", tokenB: "WBLCH" }]; }, /itself/],
    [(c) => { c.initialPairs.push({ tokenA: "bUSDC", tokenB: "WBLCH" }); }, /repeats a pair/],
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
    c.reserveCaps.push({ symbol: "xWBLCH", token: addr("1"), codeHash: hash("2"), bridgeBucketCapacity: "10", cap: "1" });
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
    [[0, "deploy wrappedNative"], [1, "deploy factory"], [2, "deploy router"], [3, "deploy lens"], [4, "createPair"]],
  );
  assert.equal(a.contracts.wrappedNative.address, at(0));
  assert.equal(a.contracts.factory.address, at(1));
  assert.equal(a.contracts.lens.address, at(3));
  assert.deepEqual(Object.keys(a.contracts), ["wrappedNative", "factory", "router", "lens"]);
  assert.equal(a.feeTo, BLOCH_INC);
  assert.deepEqual(a.roles, { blochInc: { address: BLOCH_INC, codeHash: BLOCH_INC_CODE, safe: SAFE_PIN } });
  assert.equal(a.finalNonce, 5);
  assert.equal(a.pairInitCodeHash, keccak256(artifacts().pair.bytecode));
  assert.equal(a.reserveCaps[0].token, a.contracts.wrappedNative.address);
  const [token0, token1] = [a.contracts.wrappedNative.address, ASSET].sort();
  assert.deepEqual([a.pairs[0].token0, a.pairs[0].token1], [token0, token1]);
  assert.equal(a.externalTokens[0].codeHash, ASSET_CODE);
  assert.equal(a.externalTokens[0].bridgeBucketCapacity, "100000000");
  // The fee recipient is a factory constructor argument and an immutable.
  const factoryArtifact = artifacts().factory;
  const runtime = factoryArtifact.deployedBytecode.slice(2).split("");
  runtime.splice(4, 64, ...BLOCH_INC.slice(2).padStart(64, "0"));
  assert.equal(a.contracts.factory.codeHash, keccak256(`0x${runtime.join("")}`));
  const otherRecipient = planDeployment(config((c) => { c.blochInc.address = addr("6"); }), artifacts());
  assert.notEqual(otherRecipient.steps[1].initCodeHash, a.steps[1].initCodeHash);
  assert.notEqual(otherRecipient.contracts.factory.codeHash, a.contracts.factory.codeHash);
  assert.equal(otherRecipient.pairInitCodeHash, a.pairInitCodeHash);

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
  assert.throws(() => planDeployment(config(), { ...artifacts(), lens: artifacts().router }), /immutables/);
});

test("forge environment and gate configuration derive only from the plan", () => {
  const plan = planDeployment(config(), artifacts());
  const env = forgeEnvironment(plan);
  assert.equal(env.DEX_CHAIN_ID, "700770");
  assert.equal(env.DEX_BLOCH_INC, BLOCH_INC);
  assert.equal(env.DEX_BLOCH_INC_CODEHASH, BLOCH_INC_CODE);
  assert.ok(!Object.keys(env).some((k) => /COLLECTOR|FEE_TO_SETTER|TREASURY/.test(k)));
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
  assert.equal(gate.deployment.feeTo, BLOCH_INC);
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

const BUCKET_SELECTOR = "0x" + keccak256(new TextEncoder().encode("bucketCapacity()")).slice(2, 10);

function chain(plan, change = {}) {
  const state = {
    chainId: `0x${plan.chain.id.toString(16)}`,
    genesis: plan.chain.genesisHash,
    nonce: "0x0",
    pending: "0x0",
    bucket: 100_000_000n,
    code: {
      [ASSET]: "0xaa",
      [BLOCH_INC]: "0xbb",
    },
    ...change,
  };
  return {
    request: async (method, params) => {
      if (method === "eth_chainId") return state.chainId;
      if (method === "eth_getBlockByNumber") return { number: "0x0", hash: state.genesis };
      if (method === "eth_getTransactionCount") return params[1] === "pending" ? state.pending : state.nonce;
      if (method === "eth_getCode") return state.code[params[0]] ?? "0x";
      if (method === "eth_call" && params[0].to === ASSET && params[0].data === BUCKET_SELECTOR) {
        return `0x${state.bucket.toString(16).padStart(64, "0")}`;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const devnet = (c) => {
  c.network = { name: "devnet4-rehearsal", chainId: 700771, genesisHash: hash("9"), rehearsal: true };
};

test("preflight pins chain, genesis, nonce, empty targets, reviewed code and bridge buckets", async () => {
  const base = config((c) => {
    devnet(c);
    delete c.blochInc.safe;
    c.blochInc.codeHash = keccak256("0xbb");
    c.reserveCaps[1].codeHash = keccak256("0xaa");
  });
  const plan = planDeployment(base, artifacts(), { rehearsal: true });
  assert.deepEqual(await preflight(plan, chain(plan).request), { nonce: "0" });
  for (const [change, pattern] of [
    [{ chainId: "0x1" }, /chain ID/],
    [{ genesis: hash("8") }, /genesis/],
    [{ nonce: "0x1", pending: "0x1" }, /nonce/],
    [{ pending: "0x1" }, /nonce/],
    [{ code: { [ASSET]: "0xaa", [BLOCH_INC]: "0xbb", [plan.contracts.router.address]: "0x00" } }, /occupied/],
    [{ code: { [ASSET]: "0xab", [BLOCH_INC]: "0xbb" } }, /bUSDC code hash/],
    [{ code: { [ASSET]: "0xaa", [BLOCH_INC]: "0xbc" } }, /blochInc code hash differs/],
    [{ code: { [ASSET]: "0xaa" } }, /blochInc code hash differs/],
    [{ bucket: 99_999_999n }, /bucket capacity differs/],
  ]) {
    await assert.rejects(preflight(plan, chain(plan, change).request), pattern);
  }
});

/// Replies of a Safe v1.4.1 proxy at `safe` for the views and slots the
/// preflight and the gate read.
function safeView(safe, pin, change = {}) {
  const st = {
    singleton: pin.singleton.address,
    handler: pin.fallbackHandler.address,
    guard: addr("0"),
    threshold: BigInt(pin.threshold),
    owners: [...pin.owners].reverse(),
    modules: [],
    version: "1.4.1",
    ...change,
  };
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const p = (a) => a.slice(2).padStart(64, "0");
  const sel = (sig) => keccak256(new TextEncoder().encode(sig)).slice(0, 10);
  const text = Buffer.from(st.version).toString("hex").padEnd(64, "0");
  return {
    slot: { "0x0": `0x${p(st.singleton)}`, "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5": `0x${p(st.handler)}`,
      "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8": `0x${p(st.guard)}` },
    call: {
      [sel("getThreshold()")]: `0x${w(st.threshold)}`,
      [sel("getOwners()")]: `0x${w(32)}${w(st.owners.length)}${st.owners.map(p).join("")}`,
      [`${sel("getModulesPaginated(address,uint256)")}${p("0x0000000000000000000000000000000000000001")}${w(10)}`]:
        `0x${w(64)}${w(1)}${w(st.modules.length)}${st.modules.map(p).join("")}`,
      [sel("VERSION()")]: `0x${w(32)}${w(st.version.length)}${text}`,
    },
  };
}

test("preflight verifies the pinned Bloch Inc Safe: singleton, handler, guard, modules, threshold, owners, version", async () => {
  const pin = {
    ...structuredClone(SAFE_PIN),
    singleton: { address: addr("6"), codeHash: keccak256("0x61") },
    fallbackHandler: { address: addr("8"), codeHash: keccak256("0x62") },
  };
  const base = config((c) => {
    devnet(c);
    c.blochInc.codeHash = keccak256("0xbb");
    c.blochInc.safe = pin;
    c.reserveCaps[1].codeHash = keccak256("0xaa");
  });
  const plan = planDeployment(base, artifacts(), { rehearsal: true });
  assert.deepEqual(plan.roles.blochInc.safe, pin);
  const withSafe = (viewChange = {}, code = {}) => {
    const view = safeView(BLOCH_INC, pin, viewChange);
    const inner = chain(plan, { code: { [ASSET]: "0xaa", [BLOCH_INC]: "0xbb", [addr("6")]: "0x61", [addr("8")]: "0x62", ...code } }).request;
    return async (method, params) => {
      if (method === "eth_getStorageAt") {
        assert.equal(params[0], BLOCH_INC);
        assert.equal(params[2], "latest");
        return view.slot[params[1]];
      }
      if (method === "eth_call" && params[0].to === BLOCH_INC) return view.call[params[0].data];
      return inner(method, params);
    };
  };
  assert.deepEqual(await preflight(plan, withSafe()), { nonce: "0" });
  for (const [viewChange, code, pattern] of [
    [{ singleton: addr("9") }, {}, /singleton differs/],
    [{ handler: addr("9") }, {}, /fallback handler differs/],
    [{ guard: addr("9") }, {}, /has a guard/],
    [{}, { [addr("6")]: "0x63" }, /singleton runtime code differs/],
    [{}, { [addr("8")]: "0x" }, /fallback handler runtime code differs/],
    [{ threshold: 2n }, {}, /threshold differs/],
    [{ owners: [addr("1"), addr("2"), addr("3"), addr("4"), addr("9")] }, {}, /owners differ/],
    [{ owners: [addr("1"), addr("2"), addr("3"), addr("4")] }, {}, /owners differ/],
    [{ modules: [addr("9")] }, {}, /enabled module/],
    [{ version: "1.3.0" }, {}, /not version 1.4.1/],
  ]) {
    await assert.rejects(preflight(plan, withSafe(viewChange, code)), pattern, [...Object.keys(viewChange), ...Object.keys(code)].join(","));
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
