// Test fixture for bridge-token-identity.mjs (agent 227): a synthetic bridge token (runtime code with immutable
// slots), its test pin, and a deploy_pontes.py plan and record in the shape the bridge tools write (field names and
// types copied from a real `rehearse_anvil.py` busdc-700770 plan at bridge eb5c981). Throwaway values only.
import { createRequire } from "node:module";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, toFunctionSelector } = requireFromFrontend("viem");

const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const pad = (a) => a.slice(2).padStart(64, "0");
const addr = (c) => `0x${c.repeat(40)}`;

export const COMPILER = Object.freeze({ solc: "0.8.24+commit.e11b9ed9", optimizer: { enabled: true, runs: 1 }, evmVersion: "shanghai" });
const OFFSETS = [8, 72, 136];
const LENGTH = 200;

/// Runtime code: a fixed body with three 32-byte immutable slots filled from `immutables` (one byte value each).
export function tokenCode(immutables = ["11", "22", "33"], body = "5b") {
  const bytes = Array.from({ length: LENGTH }, (_, i) => (i % 7 === 0 ? body : "60"));
  OFFSETS.forEach((o, k) => {
    for (let i = 0; i < 32; i++) bytes[o + i] = i === 31 ? immutables[k] : "00";
  });
  return `0x${bytes.join("")}`;
}

export function testPin() {
  return {
    schemaVersion: 1,
    domain: "postern.dex.bridge-token-pin.v1",
    tokens: {
      bUSDC: {
        contract: "BridgedStablecoinV3",
        source: "contracts/stable/BridgedStablecoinV3.sol",
        bridgeRevision: "f".repeat(40),
        compiler: COMPILER,
        initCodeKeccak: `0x${"e5".repeat(32)}`,
        runtimeTemplateKeccak: keccak256(tokenCode(["00", "00", "00"])),
        runtimeLength: LENGTH,
        immutableOffsets: OFFSETS,
        maxPending: 2048,
        mainnetPolicy: { signers: 7, threshold: 5, switchThreshold: 6, guardians: 3 },
      },
    },
  };
}

export const SIGNERS = Object.freeze(["0x08", "0x47", "0x79", "0xe5", "0xe1", "0x74", "0xef"].map((p) => `${p}${"a1".repeat(19)}`));
export const GUARDIANS = Object.freeze(["0x4c", "0xf8", "0x7d"].map((p) => `${p}${"b2".repeat(19)}`));

/// A plan and record for `token` on chain `chainId` / `genesisHash`, deployed at block `blockNumber` / `blockHash`.
export function planAndRecord({ token, chainId = 700770, genesisHash, blockNumber = 300, blockHash, bucket = 10_000_000_000, code = tokenCode() }) {
  const configSha256 = `0x${"c0".repeat(32)}`;
  const runtimeCodeHash = keccak256(code);
  const initCodeHash = `0x${"1c".repeat(32)}`;
  const plan = {
    domain: "bloch.bridge.mainnet-deploy.v1",
    bridge: "stable",
    configSha256,
    chain: { id: chainId, genesisHash, rehearsal: false },
    source: { revision: "f".repeat(40), compiler: structuredClone(COMPILER) },
    deployer: { address: addr("d"), nonce: 0, fundedBy: { entity: "Bloch Inc (Safe v1.4.1, 3-of-5)", safe: addr("5") } },
    contract: {
      name: "BridgedStablecoinV3", source: "contracts/stable/BridgedStablecoinV3.sol", address: token,
      constructor: { signature: "constructor(...)", args: [] }, constructorArgs: "0x", initCodeHash, runtimeCodeHash, immutables: {},
    },
    expected: {
      name: "Bloch Bridged USDC", symbol: "bUSDC", decimals: 6, threshold: 5,
      signers: [...SIGNERS], guardians: [...GUARDIANS],
      pauseDuration: 259200, pauseCooldown: 259200,
      supplyCap: 100_000_000_000, bucketCapacity: bucket, refillPerSecond: 115740,
      largeMintThreshold: 0, largeMintDelay: 43200, minBurn: 10_000_000,
      sourceChainId: 1, sourceVault: addr("7"), sourceRoute: `0x${"b5".repeat(32)}`,
      switchThreshold: 6, switchDelay: 1209600, cancelQuorum: 2,
    },
    tx: { gasLimit: 5000000, maxGasPriceWei: 100000000000 },
  };
  const record = {
    domain: "bloch.bridge.mainnet-deploy.v1", bridge: "stable", configSha256, chainId, genesisHash,
    contract: "BridgedStablecoinV3", address: token, runtimeCodeHash, initCodeHash,
    deployer: addr("d"), nonce: 0, transactionHash: `0x${"7a".repeat(32)}`, blockNumber, blockHash, gasUsed: 4822592,
    signerPins: { l2_chain_id: chainId, token_code_keccak: runtimeCodeHash, from_block: blockNumber, threshold: 5 },
  };
  return { plan, record };
}

/// eth_call answers of the token, from a plan's `expected` (overridable per view).
export function tokenViews(expected, overrides = {}) {
  const v = { ...expected, unpauseThreshold: expected.switchThreshold, instantCapacity: 0, MAX_PENDING: 2048, ...overrides };
  const out = {};
  for (const k of ["decimals", "threshold", "pauseDuration", "pauseCooldown", "supplyCap", "bucketCapacity", "refillPerSecond",
    "largeMintThreshold", "largeMintDelay", "minBurn", "sourceChainId", "switchThreshold", "switchDelay", "cancelQuorum",
    "unpauseThreshold", "instantCapacity", "MAX_PENDING"]) {
    out[toFunctionSelector(`${k}()`)] = `0x${word(v[k])}`;
  }
  out[toFunctionSelector("sourceVault()")] = `0x${pad(v.sourceVault)}`;
  out[toFunctionSelector("sourceRoute()")] = v.sourceRoute;
  for (const k of ["signers", "guardians"]) {
    out[toFunctionSelector(`${k}()`)] = `0x${word(32)}${word(v[k].length)}${v[k].map(pad).join("")}`;
  }
  return out;
}

/// A request handler for the token alone; returns undefined for anything else so it can wrap another mock.
export function tokenRpc({ token, code, views, blocks }) {
  return (method, params) => {
    if (method === "eth_getCode" && params[0] === token) return code;
    if (method === "eth_call" && params[0].to === token && Object.hasOwn(views, params[0].data)) return views[params[0].data];
    if (method === "eth_getBlockByNumber" && blocks && Object.hasOwn(blocks, params[0])) return blocks[params[0]];
    return undefined;
  };
}
