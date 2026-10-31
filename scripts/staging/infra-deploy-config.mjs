// Chain utility contracts of the Bloch L2 mainnet: Multicall3 and the minimal
// deterministic CREATE2 deployer. The L2 genesis has neither, and the L2 refuses
// the pre-EIP-155 transactions that place them at their usual addresses
// elsewhere, so they are ordinary CREATE deployments from a pinned key. Their
// addresses are specific to this chain and recorded in the plan; their runtime
// code is byte-identical to the canonical code (pinned hashes below).
// Nothing here talks to an RPC, signs or broadcasts.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { configSha256, isPending, NETWORKS, pendingFields, rawTxFile, stableJson } from "./dex-deploy-config.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress, parseAbi, encodeFunctionData, decodeFunctionResult } = requireFromFrontend("viem");

export const INFRA_DOMAIN = "postern.dex.mainnet-infra.v1";
export const INFRA_PLAN_DOMAIN = "postern.dex.mainnet-infra-plan.v1";
export const INFRA_ARTIFACTS_DOMAIN = "postern.dex.mainnet-infra-artifacts.v1";
/// Canonical runtime code hashes (the code at 0xcA11bde05977b3631167028862bE2a173976CA11
/// and 0x4e59b44847b379578588920cA78FbF26c0B4956C on Ethereum mainnet).
export const INFRA_CODE_HASHES = Object.freeze({
  multicall3: "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891",
  create2Deployer: "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989",
});
export const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getChainId() view returns (uint256 chainid)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);
const GAS = Object.freeze({ multicall3: "1500000", create2Deployer: "150000" });
const ORDER = ["multicall3", "create2Deployer"];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function refuse(condition, message) {
  if (!condition) throw new Error(`infra config: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value && typeof value === "object" && !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    `${field} must have exactly the fields ${keys.join(", ")}`,
  );
}

export function validateInfraConfig(config) {
  exactKeys(config, ["schemaVersion", "domain", "network", "deployer"], "configuration");
  refuse(config.schemaVersion === 1 && config.domain === INFRA_DOMAIN, "configuration schema is not supported");
  exactKeys(config.network, ["name", "chainId", "genesisHash", "rehearsal"], "network");
  refuse(config.network.chainId === NETWORKS.mainnet.chainId, "the utility contracts target the Bloch L2 mainnet chain ID");
  refuse(config.network.rehearsal === false, "network.rehearsal must be false");
  refuse(typeof config.network.genesisHash === "string" && HASH.test(config.network.genesisHash), "network.genesisHash must be a lowercase 32-byte hash");
  exactKeys(config.deployer, ["address", "startNonce"], "deployer");
  refuse(!isPending(config.deployer.address), "deployer.address is pending owner input (TBD-owner)");
  refuse(typeof config.deployer.address === "string" && ADDRESS.test(config.deployer.address), "deployer.address must be a lowercase address");
  refuse(Number.isSafeInteger(config.deployer.startNonce) && config.deployer.startNonce >= 0, "deployer.startNonce is invalid");
  return config;
}

export function loadInfraArtifacts(url = new URL("../../deployments/mainnet/700770/infra-artifacts.json", import.meta.url)) {
  const artifacts = JSON.parse(readFileSync(url, "utf8"));
  refuse(artifacts.schemaVersion === 1 && artifacts.domain === INFRA_ARTIFACTS_DOMAIN, "artifact file schema is not supported");
  for (const key of ORDER) {
    const runtime = artifacts.contracts?.[key]?.runtime;
    refuse(typeof runtime === "string" && /^0x(?:[0-9a-f]{2})+$/.test(runtime), `artifact ${key} is not hex`);
    refuse(keccak256(runtime) === INFRA_CODE_HASHES[key], `artifact ${key} is not the canonical runtime code`);
  }
  return artifacts;
}

/// Init code that returns `runtime` verbatim and runs nothing else:
/// PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN.
export function wrapRuntime(runtime) {
  const length = (runtime.length - 2) / 2;
  refuse(length > 0 && length <= 0xffff, "runtime length is out of range");
  return `0x61${length.toString(16).padStart(4, "0")}80600c6000396000f3${runtime.slice(2)}`;
}

export function planInfra(config, artifacts = loadInfraArtifacts()) {
  validateInfraConfig(config);
  const from = config.deployer.address;
  const n = config.deployer.startNonce;
  const contracts = {};
  const steps = [];
  ORDER.forEach((key, i) => {
    const address = getContractAddress({ from, nonce: BigInt(n + i) }).toLowerCase();
    contracts[key] = { address, codeHash: INFRA_CODE_HASHES[key] };
    steps.push({ nonce: n + i, action: `deploy ${key}`, address, initCodeHash: keccak256(wrapRuntime(artifacts.contracts[key].runtime)) });
  });
  return {
    schemaVersion: 1,
    domain: INFRA_PLAN_DOMAIN,
    configSha256: configSha256(config),
    chain: { id: config.network.chainId, genesisHash: config.network.genesisHash, rehearsal: false },
    deployer: from,
    startNonce: n,
    finalNonce: n + ORDER.length,
    contracts,
    steps,
  };
}

export function infraTransactions(config, plan, artifacts = loadInfraArtifacts()) {
  refuse(stableJson(planInfra(config, artifacts)) === stableJson(plan), "the plan differs from the plan derived from this config");
  const transactions = ORDER.map((key, i) => ({
    nonce: plan.steps[i].nonce,
    label: plan.steps[i].action,
    to: null,
    value: "0",
    data: wrapRuntime(artifacts.contracts[key].runtime),
    gasLimit: GAS[key],
    expect: plan.steps[i].address,
  }));
  return rawTxFile(plan.chain, plan.deployer, plan.configSha256, transactions);
}

/// Runtime checks of a deployed plan at `block`: exact code, and that each
/// contract does its job (Multicall3 forwards and aggregates; the deployer
/// predicts the planned CREATE2 address in an eth_call).
export async function verifyInfra(plan, request, block, ok) {
  refuse(plan?.domain === INFRA_PLAN_DOMAIN, "unsupported infra plan");
  for (const key of ORDER) {
    const { address, codeHash } = plan.contracts[key];
    refuse(codeHash === INFRA_CODE_HASHES[key], `${key} plan hash is not the canonical code`);
    const code = await request("eth_getCode", [address, block]);
    refuse(typeof code === "string" && code !== "0x" && keccak256(code) === codeHash, `${key} ${address} runtime code differs from the plan`);
    ok(`${key} code`, `${address} ${codeHash}`);
  }
  const multicall = plan.contracts.multicall3.address;
  const inner = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "getChainId" });
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate3", args: [[{ target: multicall, allowFailure: false, callData: inner }]] });
  const [result] = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", data: await request("eth_call", [{ to: multicall, data }, block]) });
  refuse(result.success && BigInt(result.returnData) === BigInt(plan.chain.id), "Multicall3 aggregate3 did not return the chain ID");
  ok("multicall3 aggregate3", "getChainId through aggregate3");
  const deployer = plan.contracts.create2Deployer.address;
  const salt = `0x${"00".repeat(31)}01`;
  const init = wrapRuntime("0x00");
  const predicted = getContractAddress({ opcode: "CREATE2", from: deployer, salt, bytecodeHash: keccak256(init) }).toLowerCase();
  const created = await request("eth_call", [{ to: deployer, data: `${salt}${init.slice(2)}` }, block]);
  refuse(typeof created === "string" && created.toLowerCase() === predicted, `CREATE2 deployer returned ${created}, expected ${predicted}`);
  ok("create2Deployer", `eth_call predicts ${predicted}`);
}

export { pendingFields };
