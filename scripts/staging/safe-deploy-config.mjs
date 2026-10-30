// Bloch Inc Safe (v1.4.1, official artifacts) on a chain without the Safe
// singleton factory: a fresh bootstrap key deploys the official SafeL2
// singleton, SafeProxyFactory and CompatibilityFallbackHandler by CREATE
// (consecutive nonces), then creates the Bloch Inc proxy with
// `createProxyWithNonce`. Every address follows from the bootstrap address,
// its start nonce, the owners, the threshold and the salt nonce, so the plan
// is reviewable before anything is signed. Nothing here talks to an RPC,
// signs or broadcasts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SAFE_V141, configSha256, isPending, pendingFields, rawTxFile, stableJson, NETWORKS } from "./dex-deploy-config.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress, encodeAbiParameters, encodeFunctionData, encodePacked } = requireFromFrontend("viem");

export const SAFE_DEPLOY_DOMAIN = "postern.dex.safe-deploy.v1";
export const SAFE_PLAN_DOMAIN = "postern.dex.safe-plan.v1";
/// The npm tarball the official bytecode comes from (registry dist.integrity).
export const SAFE_PACKAGE = Object.freeze({
  name: "@safe-global/safe-contracts",
  version: "1.4.1",
  integrity: "sha512-fP1jewywSwsIniM04NsqPyVRFKPMAuirC3ftA/TA4X3Zc5EnwQp/UCJUU2PL/37/z/jMo8UUaJ+pnFNWmMU7dQ==",
});
/// Artifact paths inside the package's build/artifacts directory.
const SAFE_ARTIFACTS = Object.freeze({
  SafeL2: "contracts/SafeL2.sol/SafeL2.json",
  Safe: "contracts/Safe.sol/Safe.json",
  proxyFactory: "contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  proxy: "contracts/proxies/SafeProxy.sol/SafeProxy.json",
  fallbackHandler: "contracts/handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json",
});
/// Explicit gas limits (the settled L2 RPC cannot estimate a sequence whose
/// later steps depend on earlier ones). About 1.5x the gas measured on anvil
/// and on the private L2 (5,321,999 / 711,231 / 1,267,726 / 352,788 for a
/// 3-of-5 proxy).
export const SAFE_GAS = Object.freeze({
  singleton: 8_000_000,
  proxyFactory: 1_100_000,
  fallbackHandler: 1_900_000,
  proxy: 550_000,
});
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const SENTINEL = "0x0000000000000000000000000000000000000001";

const SAFE_ABI = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
];

function refuse(condition, message) {
  if (!condition) throw new Error(`safe config: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value && typeof value === "object" && !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    `${field} must have exactly the fields ${keys.join(", ")}`,
  );
}

function address(value, field) {
  refuse(!isPending(value), `${field} is pending owner input (TBD-owner)`);
  refuse(typeof value === "string" && ADDRESS.test(value) && value !== ZERO_ADDRESS && value !== SENTINEL, `${field} must be a nonzero lowercase address`);
  return value;
}

/// Validate the Safe deployment configuration (one reviewed JSON file).
export function validateSafeConfig(config) {
  exactKeys(config, ["schemaVersion", "domain", "network", "artifacts", "bootstrap", "safe"], "configuration");
  refuse(config.schemaVersion === 1 && config.domain === SAFE_DEPLOY_DOMAIN, "configuration schema is not supported");
  exactKeys(config.network, ["name", "chainId", "genesisHash", "rehearsal"], "network");
  const { network } = config;
  refuse(Number.isSafeInteger(network.chainId) && network.chainId > 0, "network.chainId is invalid");
  refuse(!NETWORKS.retired.includes(network.chainId), `chain ${network.chainId} is retired`);
  refuse(typeof network.rehearsal === "boolean", "network.rehearsal must be a boolean");
  refuse(network.rehearsal || network.chainId === NETWORKS.mainnet.chainId, "a non-rehearsal Safe targets the Bloch L2 mainnet chain ID");
  refuse(!network.rehearsal || /rehearsal|devnet|local|private/.test(network.name), "a rehearsal network.name must say so");
  refuse(typeof network.genesisHash === "string" && HASH.test(network.genesisHash), "network.genesisHash must be a lowercase 32-byte hash");

  exactKeys(config.artifacts, ["package", "version", "integrity", "singleton"], "artifacts");
  refuse(config.artifacts.package === SAFE_PACKAGE.name && config.artifacts.version === SAFE_PACKAGE.version, "artifacts must be @safe-global/safe-contracts 1.4.1");
  refuse(config.artifacts.integrity === SAFE_PACKAGE.integrity, "artifacts.integrity must be the npm registry integrity of the 1.4.1 tarball");
  refuse(config.artifacts.singleton === "SafeL2" || config.artifacts.singleton === "Safe", "artifacts.singleton must be SafeL2 or Safe");

  exactKeys(config.bootstrap, ["address", "startNonce"], "bootstrap");
  address(config.bootstrap.address, "bootstrap.address");
  refuse(Number.isSafeInteger(config.bootstrap.startNonce) && config.bootstrap.startNonce >= 0, "bootstrap.startNonce is invalid");

  exactKeys(config.safe, ["owners", "threshold", "saltNonce"], "safe");
  const { owners, threshold, saltNonce } = config.safe;
  refuse(Array.isArray(owners) && owners.length >= 1 && owners.length <= 20, "safe.owners must list 1 to 20 owners");
  owners.forEach((owner, index) => address(owner, `safe.owners[${index}]`));
  refuse(new Set(owners).size === owners.length, "safe.owners repeats an owner");
  refuse(!owners.includes(config.bootstrap.address), "the bootstrap key must not be a Safe owner");
  refuse(Number.isSafeInteger(threshold) && threshold >= 1 && threshold <= owners.length, "safe.threshold is invalid");
  refuse(network.rehearsal || threshold >= 2, "a mainnet Safe needs a threshold of at least 2");
  refuse(network.rehearsal || (owners.length === 5 && threshold === 3), "the Bloch Inc Safe is 3 of 5 (decision 2b)");
  refuse(typeof saltNonce === "string" && /^(0|[1-9][0-9]{0,76})$/.test(saltNonce) && BigInt(saltNonce) < 1n << 256n, "safe.saltNonce must be a uint256 decimal string");
  return config;
}

/// Read and check the official artifacts (runtime code must be the canonical
/// v1.4.1 code, so a different build is refused before any plan exists).
export async function loadSafeArtifacts(dir, singleton = "SafeL2") {
  const read = async (key) => JSON.parse(await readFile(join(dir, SAFE_ARTIFACTS[key]), "utf8"));
  const out = {};
  for (const key of [singleton, "proxyFactory", "proxy", "fallbackHandler"]) {
    const json = await read(key);
    out[key === singleton ? "singleton" : key] = { bytecode: json.bytecode, deployedBytecode: json.deployedBytecode };
  }
  checkSafeArtifacts(out, singleton);
  return out;
}

export function checkSafeArtifacts(artifacts, singleton = "SafeL2") {
  const expected = {
    singleton: SAFE_V141.singletons[singleton],
    proxyFactory: SAFE_V141.proxyFactory,
    proxy: SAFE_V141.proxy,
    fallbackHandler: SAFE_V141.fallbackHandler,
  };
  for (const [key, codeHash] of Object.entries(expected)) {
    const a = artifacts[key];
    refuse(a && /^0x(?:[0-9a-f]{2})+$/.test(a.bytecode) && /^0x(?:[0-9a-f]{2})+$/.test(a.deployedBytecode), `artifact ${key} is not hex bytecode`);
    refuse(keccak256(a.deployedBytecode) === codeHash, `artifact ${key} runtime is not the official Safe v1.4.1 code`);
  }
  return artifacts;
}

function create(from, nonce) {
  return getContractAddress({ from, nonce: BigInt(nonce) }).toLowerCase();
}

export function safeInitializer(owners, threshold, fallbackHandler) {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [owners, BigInt(threshold), ZERO_ADDRESS, "0x", fallbackHandler, ZERO_ADDRESS, 0n, ZERO_ADDRESS],
  });
}

/// SafeProxyFactory v1.4.1: salt = keccak256(keccak256(initializer) ++ saltNonce),
/// init code = SafeProxy creation code ++ uint256(singleton).
export function safeProxyAddress(factory, singleton, initializer, saltNonce, proxyCreationCode) {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), BigInt(saltNonce)]));
  const initCode = `${proxyCreationCode}${encodeAbiParameters([{ type: "address" }], [singleton]).slice(2)}`;
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: keccak256(initCode) }).toLowerCase();
}

/// Deterministic plan: four transactions from the bootstrap key.
export function planSafe(config, artifacts) {
  validateSafeConfig(config);
  checkSafeArtifacts(artifacts, config.artifacts.singleton);
  const from = config.bootstrap.address;
  const n = config.bootstrap.startNonce;
  const singleton = create(from, n);
  const proxyFactory = create(from, n + 1);
  const fallbackHandler = create(from, n + 2);
  const { owners, threshold, saltNonce } = config.safe;
  const initializer = safeInitializer(owners, threshold, fallbackHandler);
  const proxy = safeProxyAddress(proxyFactory, singleton, initializer, saltNonce, artifacts.proxy.bytecode);
  const createProxy = encodeFunctionData({ abi: SAFE_ABI, functionName: "createProxyWithNonce", args: [singleton, initializer, BigInt(saltNonce)] });
  const all = [singleton, proxyFactory, fallbackHandler, proxy, from, ...owners];
  refuse(new Set(all).size === all.length, "planned Safe addresses collide with the bootstrap key or an owner");
  const blochInc = {
    address: proxy,
    codeHash: SAFE_V141.proxy,
    safe: {
      version: "1.4.1",
      singleton: { address: singleton, codeHash: SAFE_V141.singletons[config.artifacts.singleton] },
      fallbackHandler: { address: fallbackHandler, codeHash: SAFE_V141.fallbackHandler },
      threshold,
      owners: [...owners],
    },
  };
  return {
    schemaVersion: 1,
    domain: SAFE_PLAN_DOMAIN,
    configSha256: configSha256(config),
    chain: { id: config.network.chainId, genesisHash: config.network.genesisHash, rehearsal: config.network.rehearsal },
    artifacts: config.artifacts,
    bootstrap: from,
    startNonce: n,
    finalNonce: n + 4,
    contracts: {
      singleton: { address: singleton, codeHash: SAFE_V141.singletons[config.artifacts.singleton] },
      proxyFactory: { address: proxyFactory, codeHash: SAFE_V141.proxyFactory },
      fallbackHandler: { address: fallbackHandler, codeHash: SAFE_V141.fallbackHandler },
      proxy: { address: proxy, codeHash: SAFE_V141.proxy },
    },
    proxyCreationCodeHash: keccak256(artifacts.proxy.bytecode),
    initializerHash: keccak256(initializer),
    saltNonce,
    steps: [
      { nonce: n, action: "deploy singleton", address: singleton, initCodeHash: keccak256(artifacts.singleton.bytecode) },
      { nonce: n + 1, action: "deploy proxyFactory", address: proxyFactory, initCodeHash: keccak256(artifacts.proxyFactory.bytecode) },
      { nonce: n + 2, action: "deploy fallbackHandler", address: fallbackHandler, initCodeHash: keccak256(artifacts.fallbackHandler.bytecode) },
      { nonce: n + 3, action: "createProxyWithNonce", to: proxyFactory, address: proxy, dataHash: keccak256(createProxy) },
    ],
    blochInc,
  };
}

/// Unsigned transactions for scripts/staging/sign-and-publish.sh (cast mktx
/// + cast publish), re-derived from the artifacts and checked against the plan.
export function safeTransactions(config, artifacts, plan) {
  const derived = planSafe(config, artifacts);
  refuse(stableJson(derived) === stableJson(plan), "the plan differs from the plan derived from this config and the artifacts");
  const { owners, threshold, saltNonce } = config.safe;
  const initializer = safeInitializer(owners, threshold, plan.contracts.fallbackHandler.address);
  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "createProxyWithNonce",
    args: [plan.contracts.singleton.address, initializer, BigInt(saltNonce)],
  });
  const tx = (step, to, input, gasLimit) => ({ nonce: step.nonce, label: step.action, to, value: "0", data: input, gasLimit, expect: step.address });
  const [s0, s1, s2, s3] = plan.steps;
  const transactions = [
    tx(s0, null, artifacts.singleton.bytecode, SAFE_GAS.singleton),
    tx(s1, null, artifacts.proxyFactory.bytecode, SAFE_GAS.proxyFactory),
    tx(s2, null, artifacts.fallbackHandler.bytecode, SAFE_GAS.fallbackHandler),
    tx(s3, plan.contracts.proxyFactory.address, data, SAFE_GAS.proxy),
  ];
  transactions.forEach((t, i) => {
    const step = plan.steps[i];
    refuse(keccak256(t.data) === (step.initCodeHash ?? step.dataHash), `transaction ${i} differs from the plan`);
  });
  return rawTxFile(plan.chain, plan.bootstrap, plan.configSha256, transactions);
}

export { pendingFields, rawTxFile };
