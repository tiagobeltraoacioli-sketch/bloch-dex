// Synthetic RPC fixture only; no deployment or operational evidence.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const {
  parseAbi,
  encodeFunctionResult,
  decodeFunctionData,
  getCreate2Address,
  encodePacked,
  keccak256,
} = require("viem");
export const hash = (digit) => `0x${digit.repeat(64)}`;
export const address = (digit) => `0x${digit.repeat(40)}`;
const code = "0x6001600055";
const codeHash = keccak256(code);
const zero = address("0");
export const template = JSON.parse(
  await readFile(
    new URL("../../deployments/staging.template.json", import.meta.url),
    "utf8",
  ),
);
const abi = parseAbi([
  "function getPair(address, address) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
  "function feeTo() view returns (address)",
  "function feeToSetter() view returns (address)",
  "function pendingFeeToSetter() view returns (address)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export function fixture(overrides = {}) {
  const config = structuredClone(template);
  config.chain = {
    id: 700771,
    genesisHash: hash("1"),
    rpcUrl: "https://rpc.invalid/",
  };
  config.deployment.blockNumber = 20;
  config.deployment.blockHash = hash("2");
  config.deployment.pairInitCodeHash = hash("3");
  [
    "factory",
    "router",
    "lens",
    "collector",
    "wrappedNative",
    "feeAuthority",
    "treasury",
  ].forEach((name, index) => {
    config.deployment[name] = {
      address: address(String(index + 1)),
      runtimeCodeHash: codeHash,
    };
  });
  config.tokens = [
    {
      address: address("5"),
      runtimeCodeHash: codeHash,
      symbol: "WBLCH",
      name: "Wrapped BLCH",
      decimals: 18,
      wrappedNative: true,
      policy: { feeOnTransfer: false, rebasing: false },
    },
    {
      address: address("8"),
      runtimeCodeHash: codeHash,
      symbol: "bUSDC",
      name: "Bloch USDC",
      decimals: 6,
      wrappedNative: false,
      policy: { feeOnTransfer: false, rebasing: false },
    },
  ];
  config.assetPlan.bridgeAsset.destinationTokenAddress = address("8");
  Object.assign(config.assetPlan.pilotPool, {
    maxBaseBaseUnits: "10000000000000000000",
    maxQuoteBaseUnits: "10000000",
    policyCapApproval: { path: "approvals/pilot-cap.json", sha256: hash("a") },
  });
  const options = {
    blockNumber: 32,
    blockHash: hash("4"),
    pairRuntimeCodeHash: codeHash,
  };
  const pair = getCreate2Address({
    from: address("1"),
    salt: keccak256(
      encodePacked(["address", "address"], [address("5"), address("8")]),
    ),
    bytecodeHash: hash("3"),
  }).toLowerCase();
  const calls = [];
  const counts = new Map();
  const request = async (method, params) => {
    calls.push([method, structuredClone(params)]);
    const key = `${method}:${JSON.stringify(params)}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const custom = overrides.rpc?.(method, params, count);
    if (custom !== undefined) return custom;
    if (method === "eth_chainId") return "0xab163";
    if (method === "eth_getCode") return code;
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "0x0") return { number: "0x0", hash: hash("1") };
      if (params[0] === "0x20") return { number: "0x20", hash: hash("4") };
      if (["finalized", "0x28"].includes(params[0]))
        return { number: "0x28", hash: hash("9") };
      throw new Error(`Unexpected block request ${params[0]}`);
    }
    assert.equal(method, "eth_call");
    assert.deepEqual(params[1], {
      blockHash: hash("4"),
      requireCanonical: true,
    });
    const { functionName, args = [] } = decodeFunctionData({
      abi,
      data: params[0].data,
    });
    const defaults = {
      INIT_CODE_PAIR_HASH: hash("3"),
      feeTo: zero,
      pendingFeeToSetter: zero,
      feeToSetter: address("6"),
      getPair: pair,
      allPairsLength: 1n,
      allPairs: pair,
      factory: address("1"),
      token0: address("5"),
      token1: address("8"),
      getReserves: [0n, 0n, 0],
      totalSupply: 0n,
      balanceOf: 0n,
    };
    if (functionName === "balanceOf") assert.equal(args[0].toLowerCase(), pair);
    if (functionName === "allPairs") assert.equal(args[0], 0n);
    const value =
      overrides.read?.(functionName, args, params[0].to) ??
      defaults[functionName];
    return encodeFunctionResult({ abi, functionName, result: value });
  };
  return { config, options, request, calls, pair };
}
