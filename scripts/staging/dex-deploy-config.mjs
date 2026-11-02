// Bloch L2 mainnet DEX deployment: one reviewed JSON configuration, validated
// strictly, from which a deterministic plan is derived (CREATE addresses from
// the pinned deployer and nonce, CREATE2 pair addresses, init-code and runtime
// code hashes from the compiled artifacts). The plan is committed next to the
// configuration and recomputed before any dry run or broadcast; a mismatch is
// a refusal. Nothing here talks to an RPC, signs or broadcasts.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSafePin } from "./finality-gate.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress, encodeAbiParameters, encodeFunctionData, encodePacked } = requireFromFrontend("viem");

export const DEPLOY_DOMAIN = "postern.dex.mainnet-deploy.v1";
export const PLAN_DOMAIN = "postern.dex.mainnet-plan.v1";
export const WRAPPED_REF = "WBLCH";
/// The single source of chain IDs (also read by the frontend; a test keeps
/// script/DeployMainnet.s.sol's constants equal to it).
export const NETWORKS = Object.freeze(
  JSON.parse(readFileSync(new URL("../../deployments/networks.json", import.meta.url), "utf8")),
);
export const MAINNET_CHAIN_ID = NETWORKS.mainnet.chainId;
export const DEVELOPMENT_CHAIN_IDS = Object.freeze(NETWORKS.development.map((n) => n.chainId));
export const RETIRED_CHAIN_IDS = Object.freeze([...NETWORKS.retired]);
/// Same technical ceiling as script/DeployMainnet.s.sol and the finality gate.
export const MAX_WRAPPED_CAP = 10n * 10n ** 18n;
/// A DEX reserve cap on a bridged token is at most this fraction (1/10) of
/// the bridge's token-bucket capacity: the bridge's large-transfer delay
/// threshold. A whole pool side can then be withdrawn and bridged out in one
/// undelayed transfer, and the pool never holds more than a tenth of what the
/// bridge can mint in a full bucket.
export const BRIDGE_BUCKET_DIVISOR = 10n;
/// Bloch Inc (fee recipient and treasury) is a multisig contract.
export const BLOCH_INC_REF = "blochInc";
/// Canonical Safe v1.4.1 runtime code hashes (safe-global/safe-deployments,
/// src/assets/v1.4.1 `codeHash`; the proxy hash is SafeProxy's runtime from the
/// npm package @safe-global/safe-contracts@1.4.1, the code every
/// SafeProxyFactory v1.4.1 proxy has). Bloch Inc is a proxy of one of these
/// singletons with the official fallback handler.
export const SAFE_V141 = Object.freeze({
  proxy: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  singletons: Object.freeze({
    Safe: "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4",
    SafeL2: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  }),
  fallbackHandler: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  proxyFactory: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
});
export const UINT112_MAX = (1n << 112n) - 1n;
export const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
export const MAX_CAP_TOKENS = 8;
export const MAX_INITIAL_PAIRS = 4;
/// Compiler settings the artifacts must have been built with (foundry.toml).
export const COMPILER = Object.freeze({
  solc: "0.8.24",
  evmVersion: "paris",
  optimizer: true,
  optimizerRuns: 200,
  bytecodeHash: "none",
});

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const SYMBOL = /^[A-Za-z0-9.-]{2,12}$/;

/// Placeholder for a value only the owner can supply (an address, a key's
/// public address, a reviewed revision). It is refused like `null`.
export const PENDING = "TBD-owner";

export function isPending(value) {
  return value === null || value === PENDING;
}

/// Every leaf that is still `null` or "TBD-owner", as a JSON path.
export function pendingFields(value, path = "") {
  if (isPending(value)) return [path || "(root)"];
  if (Array.isArray(value)) return value.flatMap((item, i) => pendingFields(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => pendingFields(item, path ? `${path}.${key}` : key));
  }
  return [];
}

/// Canonical JSON: object keys sorted at every level, no whitespace.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function refuse(condition, message) {
  if (!condition) throw new Error(`deploy config: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${field} must have exactly the fields ${keys.join(", ")}`,
  );
}

function address(value, field) {
  refuse(typeof value === "string" && ADDRESS.test(value) && value !== ZERO_ADDRESS, `${field} must be a nonzero lowercase address`);
  return value;
}

function hash(value, field) {
  refuse(typeof value === "string" && HASH.test(value) && value !== ZERO_HASH, `${field} must be a nonzero lowercase 32-byte hash`);
  return value;
}

function amount(value, field, max) {
  refuse(typeof value === "string" && DECIMAL.test(value), `${field} must be a positive decimal string`);
  const parsed = BigInt(value);
  refuse(parsed <= max, `${field} exceeds ${max}`);
  return parsed;
}

function role(value, field) {
  exactKeys(value, ["address", "codeHash"], field);
  address(value.address, `${field}.address`);
  hash(value.codeHash, `${field}.codeHash`);
  return value;
}

/// The quote cap must balance the wrapped cap at the opening price: a dump of
/// unbacked quote tokens up to the cap takes a pool seeded at half the caps from
/// R to R * Rq / cap, so the share lost is 1 - price * wrappedCap / (2 * cap).
/// That is 50% when cap = wrappedCap * price, and it grows as the cap rises above
/// that (87% at 1,000 bUSDC and a price of 25.5). The bridge bucket rule may hold
/// the cap below the band at a high price, which only makes the pool shallower.
export const OPENING_CAP_BAND_PERCENT = Object.freeze({ min: 75n, max: 125n });
function checkOpeningPrice(config, wrappedCap) {
  exactKeys(config.openingPrice, ["symbol", "quotePerWrapped"], "openingPrice");
  const { symbol, quotePerWrapped } = config.openingPrice;
  refuse(!isPending(quotePerWrapped), "openingPrice.quotePerWrapped is undecided (quote base units per 1 BLCH at the opening)");
  const price = amount(quotePerWrapped, "openingPrice.quotePerWrapped", UINT112_MAX);
  const entry = config.reserveCaps.find((e) => e.symbol === symbol);
  refuse(entry, `openingPrice.symbol ${symbol} is not in reserveCaps`);
  const cap = BigInt(entry.cap);
  const balanced = (wrappedCap * price) / 10n ** 18n;
  refuse(
    cap * 100n <= balanced * OPENING_CAP_BAND_PERCENT.max,
    `the ${symbol} cap ${cap} is too high for the opening price: set it near ${balanced} (WBLCH cap x price). Above that, a dump of unbacked ${symbol} takes more than half of the WBLCH side`,
  );
  const bucketLimit = BigInt(entry.bridgeBucketCapacity) / BRIDGE_BUCKET_DIVISOR;
  const atBucketLimit = cap * BRIDGE_BUCKET_DIVISOR >= BigInt(entry.bridgeBucketCapacity);
  const target = balanced < bucketLimit ? balanced : bucketLimit;
  refuse(
    atBucketLimit || cap * 100n >= balanced * OPENING_CAP_BAND_PERCENT.min,
    `the ${symbol} cap ${cap} is too low for the opening price: set it to ${target} (the lower of WBLCH cap x price, ${balanced}, and 1/10 of the bridge bucket, ${bucketLimit})`,
  );
}


/// Validate a deployment configuration. `rehearsal` is the operator's
/// explicit command-line flag; it must agree with the configuration's own
/// `network.rehearsal`. A rehearsal targets a development chain; anything
/// else targets the Bloch L2 mainnet chain ID from deployments/networks.json.
export function validateDeployConfig(config, { rehearsal = false } = {}) {
  refuse(typeof rehearsal === "boolean", "rehearsal flag must be a boolean");
  // openingPrice is required on the mainnet and absent from rehearsal records.
  const topKeys = ["schemaVersion", "domain", "network", "source", "deployer", "firstDepositor", "blochInc", "wrappedNative", "fees", "reserveCaps", "initialPairs", "gate"];
  if (config?.network?.rehearsal === false || Object.hasOwn(config ?? {}, "openingPrice")) topKeys.push("openingPrice");
  exactKeys(config, topKeys, "configuration");
  refuse(config.schemaVersion === 1 && config.domain === DEPLOY_DOMAIN, "configuration schema is not supported");

  exactKeys(config.network, ["name", "chainId", "genesisHash", "rehearsal"], "network");
  const { network } = config;
  refuse(typeof network.name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(network.name), "network.name is invalid");
  refuse(Number.isSafeInteger(network.chainId) && network.chainId > 0, "network.chainId is undecided or invalid");
  refuse(!RETIRED_CHAIN_IDS.includes(network.chainId), `chain ${network.chainId} is retired and never a target`);
  refuse(!isPending(network.genesisHash), "network.genesisHash is undecided (L2 mainnet genesis, M9)");
  hash(network.genesisHash, "network.genesisHash");
  refuse(typeof network.rehearsal === "boolean", "network.rehearsal must be a boolean");
  const development = DEVELOPMENT_CHAIN_IDS.includes(network.chainId);
  refuse(
    !development || (network.rehearsal && rehearsal),
    `chain ${network.chainId} is a development network: set network.rehearsal and pass --rehearsal`,
  );
  refuse(network.rehearsal === rehearsal, "network.rehearsal and the --rehearsal flag disagree");
  refuse(
    development || network.chainId === MAINNET_CHAIN_ID,
    `chain ${network.chainId} is neither the Bloch L2 mainnet (${MAINNET_CHAIN_ID}) nor a development network`,
  );
  refuse(!network.rehearsal || /rehearsal|devnet|local/.test(network.name), "a rehearsal network.name must say so");

  exactKeys(config.source, ["revision", "compiler"], "source");
  refuse(!isPending(config.source.revision), "source.revision is undecided (the reviewed commit to build)");
  refuse(typeof config.source.revision === "string" && REVISION.test(config.source.revision), "source.revision must be a 40-hex commit");
  exactKeys(config.source.compiler, Object.keys(COMPILER), "source.compiler");
  for (const [key, value] of Object.entries(COMPILER)) {
    refuse(config.source.compiler[key] === value, `source.compiler.${key} must be ${JSON.stringify(value)} (foundry.toml)`);
  }

  exactKeys(config.deployer, ["address", "startNonce"], "deployer");
  refuse(!isPending(config.deployer.address), "deployer.address is undecided (fresh Bloch Inc deployer key)");
  address(config.deployer.address, "deployer.address");
  // F1: the only account that may make a pair's first deposit. A fresh key that
  // sends the approve and the seed and nothing else (docs/OPS-OPENING-KIT.md).
  // Zero would turn the rule off, so `address` refuses it.
  refuse(!isPending(config.firstDepositor), "firstDepositor is undecided (a fresh single-purpose EOA)");
  address(config.firstDepositor, "firstDepositor");
  refuse(config.firstDepositor !== config.deployer.address, "the first depositor and the deployer must be distinct accounts");
  refuse(Number.isSafeInteger(config.deployer.startNonce) && config.deployer.startNonce >= 0, "deployer.startNonce is invalid");

  refuse(!isPending(config.blochInc), "blochInc is undecided (Bloch Inc multisig address and runtime code hash)");
  const blochIncKeys = ["address", "codeHash"];
  if (config.blochInc && Object.hasOwn(config.blochInc, "safe")) blochIncKeys.push("safe");
  exactKeys(config.blochInc, blochIncKeys, "blochInc");
  address(config.blochInc.address, "blochInc.address");
  hash(config.blochInc.codeHash, "blochInc.codeHash");
  refuse(config.blochInc.codeHash !== EMPTY_CODE_HASH, "blochInc must be a multisig contract, not an externally owned account");
  refuse(config.blochInc.address !== config.deployer.address, "the deployer and Bloch Inc must be distinct accounts");
  // F1, limit L1: the first depositor is single-purpose, so it is never one of the Safe's owners.
  refuse(!(config.blochInc.safe?.owners ?? []).includes(config.firstDepositor), "the first depositor must not be a Bloch Inc Safe owner: use a fresh EOA made only for the seed");
  const { safe } = config.blochInc;
  refuse(network.rehearsal || safe, "blochInc.safe is required on the mainnet (the pinned Bloch Inc Safe v1.4.1)");
  if (safe) {
    validateSafePin(safe, "blochInc.safe", refuse);
    // On the mainnet the code must be the official v1.4.1 release; a rehearsal
    // may pin any reviewed code (the devnet4 rehearsal pins the official one).
    if (!network.rehearsal) {
      refuse(config.blochInc.codeHash === SAFE_V141.proxy, "blochInc.codeHash must be the Safe v1.4.1 proxy runtime");
      refuse(Object.values(SAFE_V141.singletons).includes(safe.singleton.codeHash), "blochInc.safe.singleton must be the official Safe or SafeL2 v1.4.1");
      refuse(safe.fallbackHandler.codeHash === SAFE_V141.fallbackHandler, "blochInc.safe.fallbackHandler must be the official CompatibilityFallbackHandler v1.4.1");
    }
    refuse(
      !safe.owners.includes(config.deployer.address) && !safe.owners.includes(config.blochInc.address),
      "the deployer and the Safe itself must not be Safe owners",
    );
    refuse(network.rehearsal || safe.threshold >= 2, "a mainnet Bloch Inc Safe needs a threshold of at least 2");
  }
  refuse(config.firstDepositor !== config.blochInc.address, "the first depositor must be a fresh EOA, not Bloch Inc");
  const roles = [config.deployer.address, config.blochInc.address];

  const wrapped = config.wrappedNative;
  refuse(wrapped && typeof wrapped === "object" && typeof wrapped.deploy === "boolean", "wrappedNative.deploy must be a boolean");
  if (wrapped.deploy) {
    exactKeys(wrapped, ["deploy"], "wrappedNative");
  } else {
    exactKeys(wrapped, ["deploy", "address", "codeHash"], "wrappedNative");
    address(wrapped.address, "wrappedNative.address");
    hash(wrapped.codeHash, "wrappedNative.codeHash");
    refuse(!roles.includes(wrapped.address), "wrappedNative.address aliases a role account");
  }

  exactKeys(config.fees, ["feeTo"], "fees");
  refuse(
    config.fees.feeTo === BLOCH_INC_REF,
    `fees.feeTo must be "${BLOCH_INC_REF}": the protocol fee is on, fixed to Bloch Inc in the factory constructor`,
  );

  refuse(
    Array.isArray(config.reserveCaps) && config.reserveCaps.length > 0 && config.reserveCaps.length <= MAX_CAP_TOKENS,
    `reserveCaps must list 1 to ${MAX_CAP_TOKENS} tokens`,
  );
  exactKeys(config.gate, ["maxWrappedReserveCap"], "gate");
  const gateMax = amount(config.gate.maxWrappedReserveCap, "gate.maxWrappedReserveCap", MAX_WRAPPED_CAP);
  const symbols = new Set();
  const addresses = new Set();
  let wrappedCap = 0n;
  config.reserveCaps.forEach((entry, index) => {
    const field = `reserveCaps[${index}]`;
    if (entry?.token === WRAPPED_REF) {
      exactKeys(entry, ["token", "cap"], field);
      refuse(!isPending(entry.cap), `${field}.cap is undecided`);
      wrappedCap = amount(entry.cap, `${field}.cap`, UINT112_MAX);
      refuse(!symbols.has(WRAPPED_REF), `${field} caps "${WRAPPED_REF}" twice`);
      symbols.add(WRAPPED_REF);
      return;
    }
    exactKeys(entry, ["symbol", "token", "codeHash", "bridgeBucketCapacity", "cap"], field);
    refuse(typeof entry.symbol === "string" && SYMBOL.test(entry.symbol) && entry.symbol !== WRAPPED_REF, `${field}.symbol is invalid`);
    const name = `${field} (${entry.symbol})`;
    refuse(!symbols.has(entry.symbol), `${name} symbol is listed twice`);
    symbols.add(entry.symbol);
    refuse(!isPending(entry.token), `${name}.token is undecided (bridge deployment address)`);
    address(entry.token, `${name}.token`);
    refuse(!isPending(entry.codeHash), `${name}.codeHash is undecided (bridge deployment runtime code hash)`);
    hash(entry.codeHash, `${name}.codeHash`);
    refuse(entry.codeHash !== EMPTY_CODE_HASH, `${name}.codeHash is the empty-code hash`);
    refuse(!isPending(entry.bridgeBucketCapacity), `${name}.bridgeBucketCapacity is undecided (the bridge token's bucketCapacity())`);
    const bucket = amount(entry.bridgeBucketCapacity, `${name}.bridgeBucketCapacity`, (1n << 256n) - 1n);
    refuse(!isPending(entry.cap), `${name}.cap is undecided`);
    const cap = amount(entry.cap, `${name}.cap`, UINT112_MAX);
    refuse(
      cap * BRIDGE_BUCKET_DIVISOR <= bucket,
      `${name}.cap exceeds 1/${BRIDGE_BUCKET_DIVISOR} of the bridge bucket capacity`,
    );
    refuse(!roles.includes(entry.token), `${name}.token aliases a role account`);
    refuse(wrapped.deploy || entry.token !== wrapped.address, `${name} caps the wrapper by address; use "${WRAPPED_REF}"`);
    refuse(!addresses.has(entry.token), `${name}.token is listed twice`);
    addresses.add(entry.token);
  });
  refuse(wrappedCap > 0n, `reserveCaps must cap "${WRAPPED_REF}"`);
  refuse(wrappedCap <= gateMax, "the WBLCH reserve cap exceeds gate.maxWrappedReserveCap");
  if (config.openingPrice !== undefined) checkOpeningPrice(config, wrappedCap);

  refuse(Array.isArray(config.initialPairs) && config.initialPairs.length <= MAX_INITIAL_PAIRS, `initialPairs must list 0 to ${MAX_INITIAL_PAIRS} pairs`);
  const seen = new Set();
  config.initialPairs.forEach((entry, index) => {
    const field = `initialPairs[${index}]`;
    exactKeys(entry, ["tokenA", "tokenB"], field);
    for (const side of ["tokenA", "tokenB"]) {
      refuse(symbols.has(entry[side]), `${field}.${side} must name a capped token ("${WRAPPED_REF}" or a reserveCaps symbol)`);
    }
    refuse(entry.tokenA !== entry.tokenB, `${field} pairs a token with itself`);
    const key = [entry.tokenA, entry.tokenB].sort().join("/");
    refuse(!seen.has(key), `${field} repeats a pair`);
    seen.add(key);
  });
  return config;
}

export function configSha256(config) {
  return `0x${sha256(stableJson(config))}`;
}

// ------------------------------------------------------------------------ //
// Deterministic plan                                                        //
// ------------------------------------------------------------------------ //

const ARTIFACTS = Object.freeze({
  wrappedNative: ["WBLCH.sol", "WBLCH"],
  factory: ["UniswapV2Factory.sol", "UniswapV2Factory"],
  router: ["BDexRouter.sol", "BDexRouter"],
  lens: ["BDexLens.sol", "BDexLens"],
  pair: ["UniswapV2Pair.sol", "UniswapV2Pair"],
});

/// Read the compiled artifacts forge wrote to `outDir`.
export async function loadArtifacts(outDir) {
  const artifacts = {};
  for (const [key, [file, name]] of Object.entries(ARTIFACTS)) {
    const json = JSON.parse(await readFile(join(outDir, file, `${name}.json`), "utf8"));
    artifacts[key] = {
      bytecode: json.bytecode?.object,
      deployedBytecode: json.deployedBytecode?.object,
      immutableReferences: json.deployedBytecode?.immutableReferences ?? {},
    };
  }
  return artifacts;
}

function code(value, field) {
  refuse(typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value), `artifact ${field} is not hex bytecode`);
  return value;
}

/// Fill a runtime's immutable slots. solc numbers AST ids in declaration
/// order, so sorted reference ids map onto the constructor-assigned
/// immutables in their declaration order; the anvil rehearsal checks the
/// resulting hashes against the chain.
function linkImmutables(artifact, values, field) {
  const runtime = code(artifact.deployedBytecode, `${field}.deployedBytecode`);
  const ids = Object.keys(artifact.immutableReferences).map(Number).sort((a, b) => a - b);
  refuse(ids.length === values.length, `${field} has ${ids.length} immutables, expected ${values.length}`);
  const bytes = runtime.slice(2).split("");
  ids.forEach((id, index) => {
    const word = values[index].slice(2).toLowerCase().padStart(64, "0");
    for (const { start, length } of artifact.immutableReferences[id]) {
      refuse(length === 32, `${field} immutable ${id} is not one word`);
      for (let i = 0; i < 64; i++) bytes[start * 2 + i] = word[i];
    }
  });
  return `0x${bytes.join("")}`;
}

function create(from, nonce) {
  return getContractAddress({ from, nonce: BigInt(nonce) }).toLowerCase();
}

/// Derive the deterministic deployment plan from a validated configuration
/// and the compiled artifacts. Pure: no RPC, no clock, no randomness.
export function planDeployment(config, artifacts, { rehearsal = false } = {}) {
  validateDeployConfig(config, { rehearsal });
  const deployer = config.deployer.address;
  let nonce = config.deployer.startNonce;
  const steps = [];
  const contracts = {};

  const deployWrapped = config.wrappedNative.deploy;
  const wrapped = deployWrapped ? create(deployer, nonce) : config.wrappedNative.address;
  const bySymbol = new Map(config.reserveCaps.map((entry) => [entry.token === WRAPPED_REF ? WRAPPED_REF : entry.symbol, entry]));
  const resolve = (symbol) => (symbol === WRAPPED_REF ? wrapped : bySymbol.get(symbol).token);
  const capTokens = config.reserveCaps.map((entry) => (entry.token === WRAPPED_REF ? wrapped : entry.token));
  const caps = config.reserveCaps.map((entry) => BigInt(entry.cap));
  const blochInc = config.blochInc;

  const deploy = (key, args) => {
    const artifact = artifacts[key];
    const initCode = `${code(artifact.bytecode, `${key}.bytecode`)}${args.slice(2)}`;
    const at = create(deployer, nonce);
    steps.push({ nonce, action: `deploy ${key}`, address: at, initCodeHash: keccak256(initCode) });
    nonce += 1;
    return at;
  };

  if (deployWrapped) {
    deploy("wrappedNative", "0x");
    contracts.wrappedNative = { address: wrapped, codeHash: keccak256(linkImmutables(artifacts.wrappedNative, [], "wrappedNative")) };
  } else {
    contracts.wrappedNative = { address: wrapped, codeHash: config.wrappedNative.codeHash };
  }
  const factory = deploy(
    "factory",
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address[]" }, { type: "uint256[]" }],
      [blochInc.address, config.firstDepositor, capTokens, caps],
    ),
  );
  contracts.factory = { address: factory, codeHash: keccak256(linkImmutables(artifacts.factory, [blochInc.address, config.firstDepositor], "factory")) };
  const router = deploy("router", encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, wrapped]));
  contracts.router = { address: router, codeHash: keccak256(linkImmutables(artifacts.router, [factory, wrapped], "router")) };
  const lens = deploy("lens", encodeAbiParameters([{ type: "address" }], [factory]));
  contracts.lens = { address: lens, codeHash: keccak256(linkImmutables(artifacts.lens, [factory], "lens")) };

  const pairInitCodeHash = keccak256(code(artifacts.pair.bytecode, "pair.bytecode"));
  const pairCodeHash = keccak256(linkImmutables(artifacts.pair, [], "pair"));
  const pairs = config.initialPairs.map((entry) => {
    const tokenA = resolve(entry.tokenA);
    const tokenB = resolve(entry.tokenB);
    const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
    const pair = getContractAddress({
      opcode: "CREATE2",
      from: factory,
      salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
      bytecodeHash: pairInitCodeHash,
    }).toLowerCase();
    steps.push({ nonce, action: "createPair", address: pair, tokenA, tokenB });
    nonce += 1;
    return { address: pair, token0, token1, codeHash: pairCodeHash };
  });

  const addresses = [
    ...Object.values(contracts).map((c) => c.address),
    ...pairs.map((p) => p.address),
    blochInc.address,
    deployer,
  ];
  refuse(new Set(addresses).size === addresses.length, "planned addresses collide with a role or each other");
  refuse(
    !config.reserveCaps.some((entry) => entry.token !== WRAPPED_REF && addresses.includes(entry.token)),
    "a capped token aliases a planned contract",
  );

  return {
    schemaVersion: 1,
    domain: PLAN_DOMAIN,
    configSha256: configSha256(config),
    chain: { id: config.network.chainId, genesisHash: config.network.genesisHash, rehearsal: config.network.rehearsal },
    source: config.source,
    deployer,
    firstDepositor: config.firstDepositor,
    startNonce: config.deployer.startNonce,
    finalNonce: nonce,
    deployWrapped,
    feeTo: blochInc.address,
    roles: {
      blochInc: { address: blochInc.address, codeHash: blochInc.codeHash, ...(blochInc.safe ? { safe: blochInc.safe } : {}) },
    },
    reserveCaps: capTokens.map((token, index) => ({ token, cap: caps[index].toString() })),
    externalTokens: config.reserveCaps
      .filter((entry) => entry.token !== WRAPPED_REF)
      .map(({ token, symbol, codeHash, bridgeBucketCapacity }) => ({ token, symbol, codeHash, bridgeBucketCapacity })),
    contracts,
    pairInitCodeHash,
    pairCodeHash,
    pairs,
    steps,
    gate: config.gate,
  };
}

/// Environment for script/DeployMainnet.s.sol, derived only from the plan.
export function forgeEnvironment(plan) {
  const { contracts } = plan;
  return {
    DEX_CONFIG_SHA256: plan.configSha256,
    DEX_CHAIN_ID: String(plan.chain.id),
    DEX_REHEARSAL: String(plan.chain.rehearsal),
    DEX_DEPLOYER: plan.deployer,
    DEX_START_NONCE: String(plan.startNonce),
    DEX_DEPLOY_WRAPPED: String(plan.deployWrapped),
    DEX_FIRST_DEPOSITOR: plan.firstDepositor,
    DEX_BLOCH_INC: plan.roles.blochInc.address,
    DEX_BLOCH_INC_CODEHASH: plan.roles.blochInc.codeHash,
    DEX_CAP_TOKENS: plan.reserveCaps.map((c) => c.token).join(","),
    DEX_CAP_AMOUNTS: plan.reserveCaps.map((c) => c.cap).join(","),
    DEX_PAIR_TOKENS_A: plan.steps.filter((s) => s.action === "createPair").map((s) => s.tokenA).join(","),
    DEX_PAIR_TOKENS_B: plan.steps.filter((s) => s.action === "createPair").map((s) => s.tokenB).join(","),
    DEX_PAIRS: plan.pairs.map((p) => p.address).join(","),
    DEX_WRAPPED: contracts.wrappedNative.address,
    DEX_WRAPPED_CODEHASH: contracts.wrappedNative.codeHash,
    DEX_FACTORY: contracts.factory.address,
    DEX_FACTORY_CODEHASH: contracts.factory.codeHash,
    DEX_ROUTER: contracts.router.address,
    DEX_ROUTER_CODEHASH: contracts.router.codeHash,
    DEX_LENS: contracts.lens.address,
    DEX_LENS_CODEHASH: contracts.lens.codeHash,
    DEX_PAIR_INIT_CODE_HASH: plan.pairInitCodeHash,
    DEX_PAIR_CODEHASH: plan.pairCodeHash,
  };
}

/// Build the schema-2 finality gate configuration from the plan and the
/// deployment transaction hashes (in nonce order, verified by `record`).
export function gateConfigFromPlan(plan, transactions, gateDomain, existingPairTransactions = []) {
  refuse(Array.isArray(transactions) && transactions.length === plan.steps.length, "one transaction per plan step is required");
  transactions.forEach((tx, index) => hash(tx, `transactions[${index}]`));
  refuse(plan.pairs.length > 0, "the plan creates no pair; add the pilot pair before generating a gate");
  return {
    schemaVersion: 2,
    domain: gateDomain,
    chain: { id: plan.chain.id, genesisHash: plan.chain.genesisHash },
    deployment: {
      deployer: plan.deployer,
      firstDepositor: plan.firstDepositor,
      contracts: plan.contracts,
      pairInitCodeHash: plan.pairInitCodeHash,
      feeTo: plan.feeTo,
      roles: plan.roles,
      reserveCaps: plan.reserveCaps,
      tokens: plan.externalTokens,
      pairs: plan.pairs,
      transactions,
      ...(existingPairTransactions.length ? { existingPairTransactions } : {}),
    },
    limits: { maxWrappedReserveCap: plan.gate.maxWrappedReserveCap },
  };
}

/// Explicit gas limits for the raw-transaction path (cast mktx): the settled
/// L2 RPC cannot estimate a sequence whose later steps depend on earlier ones.
/// About 1.5x the gas measured on anvil and on the private L2 (612,333 /
/// 2,456,799 / 4,074,147 / 1,938,483 / 2,135,685).
export const DEX_GAS = Object.freeze({
  wrappedNative: 1_000_000,
  factory: 3_700_000,
  router: 6_200_000,
  lens: 3_000_000,
  createPair: 3_300_000,
});

const CREATE_PAIR_ABI = [
  {
    type: "function",
    name: "createPair",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ name: "pair", type: "address" }],
  },
];

/// Unsigned deployment transactions in plan order, for signing offline with
/// `cast mktx` and publishing with `cast publish`
/// (scripts/staging/sign-and-publish.sh). Each creation's init code is
/// re-derived from the artifacts and must hash to the plan's initCodeHash.
export function dexTransactions(config, artifacts, plan) {
  const derived = planDeployment(config, artifacts, { rehearsal: plan.chain.rehearsal });
  refuse(stableJson(derived) === stableJson(plan), "the plan differs from the plan derived from this config and build");
  const { contracts } = plan;
  const wrapped = contracts.wrappedNative.address;
  const args = {
    wrappedNative: "0x",
    factory: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address[]" }, { type: "uint256[]" }],
      [plan.feeTo, plan.firstDepositor, plan.reserveCaps.map((c) => c.token), plan.reserveCaps.map((c) => BigInt(c.cap))],
    ),
    router: encodeAbiParameters([{ type: "address" }, { type: "address" }], [contracts.factory.address, wrapped]),
    lens: encodeAbiParameters([{ type: "address" }], [contracts.factory.address]),
  };
  const transactions = plan.steps.map((step) => {
    if (step.action === "createPair") {
      const data = encodeFunctionData({ abi: CREATE_PAIR_ABI, functionName: "createPair", args: [step.tokenA, step.tokenB] });
      return { nonce: step.nonce, label: step.action, to: contracts.factory.address, value: "0", data, gasLimit: DEX_GAS.createPair, expect: step.address };
    }
    const key = step.action.replace(/^deploy /, "");
    const data = `${code(artifacts[key].bytecode, `${key}.bytecode`)}${args[key].slice(2)}`;
    refuse(keccak256(data) === step.initCodeHash, `${step.action} init code differs from the plan`);
    return { nonce: step.nonce, label: step.action, to: null, value: "0", data, gasLimit: DEX_GAS[key], expect: step.address };
  });
  return rawTxFile(plan.chain, plan.deployer, plan.configSha256, transactions);
}

export const RAW_TXS_DOMAIN = "postern.dex.raw-txs.v1";

/// The unsigned-transaction file read by scripts/staging/sign-and-publish.sh.
export function rawTxFile(chain, from, configSha, transactions) {
  return {
    schemaVersion: 1,
    domain: RAW_TXS_DOMAIN,
    chainId: chain.id,
    genesisHash: chain.genesisHash,
    from,
    configSha256: configSha,
    transactions,
  };
}
