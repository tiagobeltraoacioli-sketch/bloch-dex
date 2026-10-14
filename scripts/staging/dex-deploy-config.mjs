// Bloch L2 mainnet DEX deployment: one reviewed JSON configuration, validated
// strictly, from which a deterministic plan is derived (CREATE addresses from
// the pinned deployer and nonce, CREATE2 pair addresses, init-code and runtime
// code hashes from the compiled artifacts). The plan is committed next to the
// configuration and recomputed before any dry run or broadcast; a mismatch is
// a refusal. Nothing here talks to an RPC, signs or broadcasts.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, stableJson } from "./manifest.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, getContractAddress, encodeAbiParameters, encodePacked } = requireFromFrontend("viem");

export const DEPLOY_DOMAIN = "postern.dex.mainnet-deploy.v1";
export const PLAN_DOMAIN = "postern.dex.mainnet-plan.v1";
export const WRAPPED_REF = "WBLCH";
export const DEVNET4_CHAIN_ID = 700771;
export const LOCAL_CHAIN_ID = 31337;
export const DEVELOPMENT_CHAIN_IDS = Object.freeze([DEVNET4_CHAIN_ID, LOCAL_CHAIN_ID]);
export const RETIRED_CHAIN_IDS = Object.freeze([8400, 84001]);
/// Same technical ceiling as script/Deploy.s.sol and script/DeployMainnet.s.sol.
export const MAX_WRAPPED_CAP = 10n * 10n ** 18n;
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

/// Validate a deployment configuration. `rehearsal` is the operator's
/// explicit command-line flag; it must agree with the configuration's own
/// `network.rehearsal`, and a development chain requires both.
export function validateDeployConfig(config, { rehearsal = false } = {}) {
  refuse(typeof rehearsal === "boolean", "rehearsal flag must be a boolean");
  exactKeys(
    config,
    ["schemaVersion", "domain", "network", "source", "deployer", "wrappedNative", "fees", "reserveCaps", "initialPairs", "gate"],
    "configuration",
  );
  refuse(config.schemaVersion === 1 && config.domain === DEPLOY_DOMAIN, "configuration schema is not supported");

  exactKeys(config.network, ["name", "chainId", "genesisHash", "rehearsal"], "network");
  const { network } = config;
  refuse(typeof network.name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(network.name), "network.name is invalid");
  refuse(Number.isSafeInteger(network.chainId) && network.chainId > 0, "network.chainId is undecided or invalid");
  hash(network.genesisHash, "network.genesisHash");
  refuse(typeof network.rehearsal === "boolean", "network.rehearsal must be a boolean");
  refuse(!RETIRED_CHAIN_IDS.includes(network.chainId), `chain ${network.chainId} is retired and never a target`);
  const development = DEVELOPMENT_CHAIN_IDS.includes(network.chainId);
  refuse(
    !development || (network.rehearsal && rehearsal),
    `chain ${network.chainId} is a development network: set network.rehearsal and pass --rehearsal`,
  );
  refuse(network.rehearsal === rehearsal, "network.rehearsal and the --rehearsal flag disagree");
  refuse(!network.rehearsal || /rehearsal|devnet|local/.test(network.name), "a rehearsal network.name must say so");

  exactKeys(config.source, ["revision", "compiler"], "source");
  refuse(typeof config.source.revision === "string" && REVISION.test(config.source.revision), "source.revision must be a 40-hex commit");
  exactKeys(config.source.compiler, Object.keys(COMPILER), "source.compiler");
  for (const [key, value] of Object.entries(COMPILER)) {
    refuse(config.source.compiler[key] === value, `source.compiler.${key} must be ${JSON.stringify(value)} (foundry.toml)`);
  }

  exactKeys(config.deployer, ["address", "startNonce"], "deployer");
  address(config.deployer.address, "deployer.address");
  refuse(Number.isSafeInteger(config.deployer.startNonce) && config.deployer.startNonce >= 0, "deployer.startNonce is invalid");

  const wrapped = config.wrappedNative;
  refuse(wrapped && typeof wrapped === "object" && typeof wrapped.deploy === "boolean", "wrappedNative.deploy must be a boolean");
  if (wrapped.deploy) {
    exactKeys(wrapped, ["deploy"], "wrappedNative");
  } else {
    exactKeys(wrapped, ["deploy", "address", "codeHash"], "wrappedNative");
    address(wrapped.address, "wrappedNative.address");
    hash(wrapped.codeHash, "wrappedNative.codeHash");
  }

  exactKeys(config.fees, ["feeTo", "feeToSetter", "treasury"], "fees");
  refuse(config.fees.feeTo === null, "fees.feeTo must be null: the protocol fee is never enabled at deployment");
  role(config.fees.feeToSetter, "fees.feeToSetter");
  role(config.fees.treasury, "fees.treasury");
  const roles = [config.deployer.address, config.fees.feeToSetter.address, config.fees.treasury.address];
  refuse(new Set(roles).size === roles.length, "deployer, fee authority and treasury must be three distinct accounts");

  refuse(
    Array.isArray(config.reserveCaps) && config.reserveCaps.length > 0 && config.reserveCaps.length <= MAX_CAP_TOKENS,
    `reserveCaps must list 1 to ${MAX_CAP_TOKENS} tokens`,
  );
  exactKeys(config.gate, ["maxWrappedReserveCap"], "gate");
  const gateMax = amount(config.gate.maxWrappedReserveCap, "gate.maxWrappedReserveCap", MAX_WRAPPED_CAP);
  const capped = new Set();
  let wrappedCap = 0n;
  config.reserveCaps.forEach((entry, index) => {
    const field = `reserveCaps[${index}]`;
    if (entry?.token === WRAPPED_REF) {
      exactKeys(entry, ["token", "cap"], field);
      wrappedCap = amount(entry.cap, `${field}.cap`, UINT112_MAX);
    } else {
      exactKeys(entry, ["token", "symbol", "codeHash", "cap"], field);
      address(entry.token, `${field}.token`);
      refuse(typeof entry.symbol === "string" && /^[A-Za-z0-9.-]{2,12}$/.test(entry.symbol), `${field}.symbol is invalid`);
      hash(entry.codeHash, `${field}.codeHash`);
      refuse(entry.codeHash !== EMPTY_CODE_HASH, `${field}.codeHash is the empty-code hash`);
      amount(entry.cap, `${field}.cap`, UINT112_MAX);
      refuse(!roles.includes(entry.token), `${field}.token aliases a role account`);
      refuse(wrapped.deploy || entry.token !== wrapped.address, `${field} caps the wrapper by address; use "${WRAPPED_REF}"`);
    }
    refuse(!capped.has(entry.token), `${field}.token is listed twice`);
    capped.add(entry.token);
  });
  refuse(wrappedCap > 0n, `reserveCaps must cap "${WRAPPED_REF}"`);
  refuse(wrappedCap <= gateMax, "the WBLCH reserve cap exceeds gate.maxWrappedReserveCap");

  refuse(Array.isArray(config.initialPairs) && config.initialPairs.length <= MAX_INITIAL_PAIRS, `initialPairs must list 0 to ${MAX_INITIAL_PAIRS} pairs`);
  const seen = new Set();
  config.initialPairs.forEach((entry, index) => {
    const field = `initialPairs[${index}]`;
    exactKeys(entry, ["tokenA", "tokenB"], field);
    for (const side of ["tokenA", "tokenB"]) {
      refuse(capped.has(entry[side]), `${field}.${side} must be a capped token ("${WRAPPED_REF}" or a reserveCaps address)`);
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
  collector: ["TreasuryFeeCollector.sol", "TreasuryFeeCollector"],
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
  const resolve = (token) => (token === WRAPPED_REF ? wrapped : token);
  const capTokens = config.reserveCaps.map((entry) => resolve(entry.token));
  const caps = config.reserveCaps.map((entry) => BigInt(entry.cap));
  const { feeToSetter, treasury } = config.fees;

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
    encodeAbiParameters([{ type: "address" }, { type: "address[]" }, { type: "uint256[]" }], [feeToSetter.address, capTokens, caps]),
  );
  contracts.factory = { address: factory, codeHash: keccak256(linkImmutables(artifacts.factory, [], "factory")) };
  const router = deploy("router", encodeAbiParameters([{ type: "address" }, { type: "address" }], [factory, wrapped]));
  contracts.router = { address: router, codeHash: keccak256(linkImmutables(artifacts.router, [factory, wrapped], "router")) };
  const lens = deploy("lens", encodeAbiParameters([{ type: "address" }], [factory]));
  contracts.lens = { address: lens, codeHash: keccak256(linkImmutables(artifacts.lens, [factory], "lens")) };
  const collector = deploy(
    "collector",
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [factory, treasury.address, wrapped]),
  );
  contracts.collector = {
    address: collector,
    codeHash: keccak256(linkImmutables(artifacts.collector, [factory, treasury.address, wrapped], "collector")),
  };

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
    feeToSetter.address,
    treasury.address,
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
    startNonce: config.deployer.startNonce,
    finalNonce: nonce,
    deployWrapped,
    roles: { feeToSetter: feeToSetter.address, treasury: treasury.address },
    roleCodeHashes: { feeToSetter: feeToSetter.codeHash, treasury: treasury.codeHash },
    reserveCaps: capTokens.map((token, index) => ({ token, cap: caps[index].toString() })),
    externalTokens: config.reserveCaps
      .filter((entry) => entry.token !== WRAPPED_REF)
      .map(({ token, symbol, codeHash }) => ({ token, symbol, codeHash })),
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
    DEX_FEE_TO_SETTER: plan.roles.feeToSetter,
    DEX_FEE_TO_SETTER_CODEHASH: plan.roleCodeHashes.feeToSetter,
    DEX_TREASURY: plan.roles.treasury,
    DEX_TREASURY_CODEHASH: plan.roleCodeHashes.treasury,
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
    DEX_COLLECTOR: contracts.collector.address,
    DEX_COLLECTOR_CODEHASH: contracts.collector.codeHash,
    DEX_PAIR_INIT_CODE_HASH: plan.pairInitCodeHash,
    DEX_PAIR_CODEHASH: plan.pairCodeHash,
  };
}

/// Build the schema-2 finality gate configuration from the plan and the
/// deployment transaction hashes (in nonce order, verified by `record`).
export function gateConfigFromPlan(plan, transactions, gateDomain) {
  refuse(Array.isArray(transactions) && transactions.length === plan.steps.length, "one transaction per plan step is required");
  transactions.forEach((tx, index) => hash(tx, `transactions[${index}]`));
  refuse(plan.pairs.length > 0, "the plan creates no pair; add the pilot pair before generating a gate");
  return {
    schemaVersion: 2,
    domain: gateDomain,
    chain: { id: plan.chain.id, genesisHash: plan.chain.genesisHash },
    deployment: {
      deployer: plan.deployer,
      contracts: plan.contracts,
      pairInitCodeHash: plan.pairInitCodeHash,
      roles: plan.roles,
      reserveCaps: plan.reserveCaps,
      tokens: plan.externalTokens,
      pairs: plan.pairs,
      transactions,
    },
    limits: { maxWrappedReserveCap: plan.gate.maxWrappedReserveCap },
  };
}
