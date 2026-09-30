import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { validateStagingConfig, sha256, stableJson } from "./manifest.mjs";

const require = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  keccak256,
  getCreate2Address,
  encodePacked,
} = require("viem");
const HASH = /^0x[0-9a-f]{64}$/;
const CODE = /^0x(?:[0-9a-f]{2})+$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
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

function required(condition, message) {
  if (!condition) throw new Error(`pilot pool inspection: ${message}`);
}

function hash(value, field) {
  required(
    typeof value === "string" &&
      HASH.test(value) &&
      value !== `0x${"0".repeat(64)}`,
    `${field} must be a nonzero lowercase hash`,
  );
}

function quantity(value, field) {
  required(
    typeof value === "string" &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) &&
      value.length <= 66,
    `${field} is not a bounded canonical quantity`,
  );
  return BigInt(value);
}

function block(value, field) {
  required(
    value && typeof value === "object" && !Array.isArray(value),
    `${field} is unavailable`,
  );
  hash(value.hash, `${field} hash`);
  const number = quantity(value.number, `${field} number`);
  required(
    number <= BigInt(Number.MAX_SAFE_INTEGER),
    `${field} number exceeds the safe range`,
  );
  return { number: Number(number), hash: value.hash };
}

function sameBlock(left, right) {
  return left.number === right.number && left.hash === right.hash;
}

function finality(finalized, snapshot, genesisHash) {
  required(
    finalized.number > 0 && finalized.hash !== genesisHash,
    "finality has not advanced beyond genesis",
  );
  required(
    finalized.number >= snapshot.number,
    "inspection block is not finalized",
  );
  required(
    finalized.number !== snapshot.number || finalized.hash === snapshot.hash,
    "finalized hash conflicts with the inspection block",
  );
}

export async function writePoolInspectionObservation(path, observation) {
  await writeFile(path, `${stableJson(observation)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export function validatePoolInspectionRequest(config, options) {
  validateStagingConfig(config);
  required(
    options &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Object.keys(options).length === 3 &&
      ["blockNumber", "blockHash", "pairRuntimeCodeHash"].every((key) =>
        Object.hasOwn(options, key),
      ),
    "inspection request fields are invalid",
  );
  required(
    Number.isSafeInteger(options.blockNumber) &&
      options.blockNumber > 0 &&
      options.blockNumber >= config.deployment.blockNumber,
    "inspection block precedes deployment or is invalid",
  );
  hash(options.blockHash, "inspection block hash");
  hash(options.pairRuntimeCodeHash, "expected pair runtime code hash");
  required(
    options.blockNumber !== config.deployment.blockNumber ||
      options.blockHash === config.deployment.blockHash,
    "inspection block conflicts with deployment",
  );
}

// Every state read requires EIP-1898 hash pinning. There is no latest/number fallback.
export async function inspectPilotPool(config, options, request) {
  validatePoolInspectionRequest(config, options);
  required(typeof request === "function", "RPC request function is required");
  const snapshot = { number: options.blockNumber, hash: options.blockHash };
  const tag = `0x${snapshot.number.toString(16)}`;
  const pin = { blockHash: snapshot.hash, requireCanonical: true };
  const chainId = quantity(await request("eth_chainId", []), "chain ID");
  required(
    chainId === BigInt(config.chain.id),
    "chain ID does not match configuration",
  );
  const genesis = block(
    await request("eth_getBlockByNumber", ["0x0", false]),
    "genesis",
  );
  required(
    genesis.number === 0 && genesis.hash === config.chain.genesisHash,
    "genesis does not match configuration",
  );
  const opening = block(
    await request("eth_getBlockByNumber", [tag, false]),
    "inspection block",
  );
  required(
    sameBlock(opening, snapshot),
    "inspection block does not match request",
  );
  const finalizedBefore = block(
    await request("eth_getBlockByNumber", ["finalized", false]),
    "initial finalized block",
  );
  finality(finalizedBefore, snapshot, genesis.hash);

  const base = config.tokens.find((token) => token.wrappedNative);
  const quote = config.tokens.find(
    (token) =>
      token.address === config.assetPlan.bridgeAsset.destinationTokenAddress,
  );
  required(base && quote, "pilot tokens are unavailable");
  const [token0, token1] = [base.address, quote.address].sort();
  const factory = config.deployment.factory.address;
  const pair = getCreate2Address({
    from: factory,
    salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
    bytecodeHash: config.deployment.pairInitCodeHash,
  }).toLowerCase();
  required(
    ![
      ...Object.values(config.deployment)
        .filter((value) => value && typeof value === "object")
        .map((value) => value.address),
      ...config.tokens.map((token) => token.address),
    ].includes(pair),
    "derived pair aliases another reviewed identity",
  );

  const runtimeCode = [];
  for (const [name, address, expected] of [
    ["factory", factory, config.deployment.factory.runtimeCodeHash],
    [
      "token0",
      token0,
      config.tokens.find((token) => token.address === token0).runtimeCodeHash,
    ],
    [
      "token1",
      token1,
      config.tokens.find((token) => token.address === token1).runtimeCodeHash,
    ],
    ["pair", pair, options.pairRuntimeCodeHash],
  ]) {
    const code = await request("eth_getCode", [address, pin]);
    required(
      typeof code === "string" &&
        code.length <= 2 + 1024 * 1024 &&
        CODE.test(code),
      `${name} runtime code is empty or malformed`,
    );
    const digest = keccak256(code);
    required(
      digest === expected,
      `${name} runtime code does not match reviewed hash`,
    );
    runtimeCode.push({
      name,
      address,
      runtimeCodeHash: digest,
      codeBytes: (code.length - 2) / 2,
    });
  }

  const calls = [];
  const read = async (to, functionName, args = []) => {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await request("eth_call", [{ to, data }, pin]);
    required(
      typeof result === "string" && result.length <= 194 && CODE.test(result),
      `${functionName} returned malformed ABI data`,
    );
    let value;
    try {
      value = decodeFunctionResult({ abi, functionName, data: result });
      required(
        encodeFunctionResult({
          abi,
          functionName,
          result: value,
        }).toLowerCase() === result,
        `${functionName} returned noncanonical ABI data`,
      );
    } catch {
      throw new Error(
        `pilot pool inspection: ${functionName} returned noncanonical ABI data`,
      );
    }
    calls.push({ to, data, result });
    return typeof value === "string" ? value.toLowerCase() : value;
  };

  required(
    (await read(factory, "INIT_CODE_PAIR_HASH")) ===
      config.deployment.pairInitCodeHash,
    "factory creation-code hash does not match configuration",
  );
  required(
    (await read(factory, "feeTo")) === ZERO_ADDRESS &&
      (await read(factory, "pendingFeeToSetter")) === ZERO_ADDRESS &&
      (await read(factory, "feeToSetter")) ===
        config.deployment.feeAuthority.address,
    "factory fee controls are not in the reviewed disabled state",
  );
  const forwardRegistryPair = await read(factory, "getPair", [token0, token1]);
  const reverseRegistryPair = await read(factory, "getPair", [token1, token0]);
  const factoryPairCount = await read(factory, "allPairsLength");
  required(factoryPairCount === 1n, "exactly one factory pair is required");
  required(
    forwardRegistryPair === pair &&
      reverseRegistryPair === pair &&
      (await read(factory, "allPairs", [0n])) === pair,
    "factory registry does not match the derived pair",
  );
  required(
    (await read(pair, "factory")) === factory &&
      (await read(pair, "token0")) === token0 &&
      (await read(pair, "token1")) === token1,
    "pair bindings do not match configuration",
  );
  const [reserve0, reserve1, reserveTimestamp] = await read(
    pair,
    "getReserves",
  );
  const totalSupply = await read(pair, "totalSupply");
  const balance0 = await read(token0, "balanceOf", [pair]);
  const balance1 = await read(token1, "balanceOf", [pair]);
  required(
    [reserve0, reserve1, totalSupply, balance0, balance1].every(
      (value) => value === 0n,
    ),
    "pilot pair has reserves, donated balances or LP supply",
  );

  const closing = block(
    await request("eth_getBlockByNumber", [tag, false]),
    "closing inspection block",
  );
  required(
    sameBlock(closing, snapshot),
    "inspection block changed during collection",
  );
  const retainedFinalized = block(
    await request("eth_getBlockByNumber", [
      `0x${finalizedBefore.number.toString(16)}`,
      false,
    ]),
    "retained finalized checkpoint",
  );
  required(
    sameBlock(retainedFinalized, finalizedBefore),
    "initial finalized checkpoint changed during collection",
  );
  const finalizedAfter = block(
    await request("eth_getBlockByNumber", ["finalized", false]),
    "closing finalized block",
  );
  finality(finalizedAfter, snapshot, genesis.hash);
  required(
    finalizedAfter.number >= finalizedBefore.number &&
      (finalizedAfter.number !== finalizedBefore.number ||
        finalizedAfter.hash === finalizedBefore.hash),
    "finalized checkpoint regressed or changed",
  );
  required(
    quantity(await request("eth_chainId", []), "closing chain ID") === chainId,
    "chain ID changed during collection",
  );
  const closingGenesis = block(
    await request("eth_getBlockByNumber", ["0x0", false]),
    "closing genesis",
  );
  required(
    sameBlock(closingGenesis, genesis),
    "genesis changed during collection",
  );

  const observation = {
    schemaVersion: 1,
    domain: "postern.dex.pilot-pool-rpc-observation.v1",
    configurationSha256: `0x${sha256(stableJson(config))}`,
    chainId: config.chain.id,
    genesisHash: genesis.hash,
    snapshot,
    finalizedBefore,
    finalizedAfter,
    pool: {
      factoryAddress: factory,
      pairAddress: pair,
      pairRuntimeCodeHash: options.pairRuntimeCodeHash,
      token0,
      token1,
      forwardRegistryPair,
      reverseRegistryPair,
      factoryPairCount: 1,
      pilotPairCount: 1,
      reserve0: reserve0.toString(),
      reserve1: reserve1.toString(),
      reserveTimestamp,
      balance0: balance0.toString(),
      balance1: balance1.toString(),
      totalSupply: totalSupply.toString(),
      capApprovalSha256: config.assetPlan.pilotPool.policyCapApproval.sha256,
    },
    runtimeCode,
    calls,
    observations: {
      create2AddressMatched: true,
      registryMatched: true,
      empty: true,
      stateReadsHashPinned: true,
    },
    authentication: {
      sourceRpcAuthenticated: false,
      finalityAuthenticated: false,
      poolInspectionAuthenticated: false,
      capApprovalAuthenticated: false,
    },
    controls: {
      pilotLiquidityCeremonyAuthorized: false,
      liquidityEnabled: false,
      activationPerformed: false,
      broadcastPerformed: false,
    },
  };
  return {
    ...observation,
    observationSha256: `0x${sha256(stableJson(observation))}`,
  };
}
