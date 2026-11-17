// Ethereum-model DEX launch gate: no signed checkpoints, cap approvals or
// reviewer quorums. Trust is pinned once (chain ID and genesis hash in the
// configuration); everything else is read from the chain at the RPC's
// `finalized` block, which on Bloch L2 comes from replaying native FFG from the
// pinned genesis. Reserve caps are the factory's constructor-fixed values.

import { createRequire } from "node:module";
import { checkBridgeRecord, verifyBridgeToken } from "./bridge-token-identity.mjs";
import { createRpcTransport } from "./rpc-transport.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, toFunctionSelector } = requireFromFrontend("viem");

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const MAX_TRANSACTIONS = 64;

export const GATE_DOMAIN = "postern.dex.finality-gate.v1";
const SELECTORS = Object.freeze({
  reserveCap: "0xbb75fd60",
  reserveCaps: "0xd3dc9b31",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  getPair: "0xe6a43905",
  feeTo: toFunctionSelector("feeTo()"),
  firstDepositor: toFunctionSelector("firstDepositor()"),
  totalSupply: toFunctionSelector("totalSupply()"),
  bucketCapacity: toFunctionSelector("bucketCapacity()"),
  initCodePairHash: toFunctionSelector("INIT_CODE_PAIR_HASH()"),
  factory: toFunctionSelector("factory()"),
  routerWrapped: toFunctionSelector("WBLCH()"),
});
/// Bridged tokens (SignerMintedToken) expose their immutable token-bucket
/// capacity; a DEX cap is at most 1/BRIDGE_BUCKET_DIVISOR of it.
export const BUCKET_CAPACITY_SELECTOR = SELECTORS.bucketCapacity;
const BRIDGE_BUCKET_DIVISOR = 10n;
const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
/// Owner decision of 2026-11-17: Bloch Inc on the Bloch L2 DEX is the owner's plain address (the only Bloch Inc
/// without code). Single source for the tools; mirrored by script/DeployMainnet.s.sol OWNER_FEE_EOA.
export const OWNER_FEE_EOA = "0x775a993f09bd80aecf8f8c2ade0c84158e3a0544";
const UINT112_MAX = (1n << 112n) - 1n;
const CONTRACT_KEYS = Object.freeze(["wrappedNative", "factory", "router", "lens"]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
/// The Bloch L2 mainnet chain ID (deployments/networks.json): its gate
/// requires the Bloch Inc Safe checks below.
const MAINNET_CHAIN_ID = 700770;

/// Safe v1.4.1 storage layout and views used to pin the Bloch Inc Safe.
export const SAFE = Object.freeze({
  version: "1.4.1",
  singletonSlot: "0x0",
  fallbackHandlerSlot: "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
  guardSlot: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
  sentinel: `0x${"0".repeat(39)}1`,
  maxOwners: 20,
  selectors: Object.freeze({
    getThreshold: toFunctionSelector("getThreshold()"),
    getOwners: toFunctionSelector("getOwners()"),
    getModulesPaginated: toFunctionSelector("getModulesPaginated(address,uint256)"),
    VERSION: toFunctionSelector("VERSION()"),
  }),
});

function refuse(condition, message) {
  if (!condition) throw new Error(`finality gate: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${field} fields are invalid`,
  );
}

function quantity(value, field) {
  refuse(
    typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value),
    `${field} is not a canonical hexadecimal quantity`,
  );
  return BigInt(value);
}

function block(value, field) {
  refuse(value && typeof value === "object", `${field} is unavailable`);
  refuse(HASH.test(value.hash) && value.hash !== ZERO_HASH, `${field}.hash is invalid`);
  return Object.freeze({ number: quantity(value.number, `${field}.number`), hash: value.hash });
}

function sameBlock(left, right) {
  return left.number === right.number && left.hash === right.hash;
}

async function requireCanonicalBlock(request, expected, field) {
  const canonical = block(await request("eth_getBlockByNumber", [`0x${expected.number.toString(16)}`, false]), field);
  refuse(sameBlock(canonical, expected), `${field} is not the expected canonical block`);
}

async function readFinality(request, genesisHash) {
  const finalized = block(await request("eth_getBlockByNumber", ["finalized", false]), "finalized block");
  refuse(finalized.number > 0n && finalized.hash !== genesisHash, "nothing beyond genesis is finalized");
  const finality = await request("bloch_finality", []);
  refuse(finality && typeof finality === "object" && finality.finalized, "bloch_finality is unavailable");
  const reported = block(finality.finalized, "bloch_finality.finalized");
  refuse(reported.number >= finalized.number, "bloch_finality reports an older finalized block than eth_getBlockByNumber");
  refuse(reported.number !== finalized.number || reported.hash === finalized.hash, "bloch_finality conflicts with the finalized block at the same height");
  await requireCanonicalBlock(request, finalized, "finalized checkpoint");
  if (!sameBlock(reported, finalized)) await requireCanonicalBlock(request, reported, "reported finalized checkpoint");
  return { finalized, finality, reported };
}

async function verifyClosingFinality(request, chain, opening) {
  const closing = await readFinality(request, chain.genesisHash);
  for (const field of ["finalized", "reported"]) {
    const before = opening[field], after = closing[field];
    refuse(after.number >= before.number, `${field} checkpoint regressed during verification`);
    refuse(after.number !== before.number || after.hash === before.hash, `${field} checkpoint changed during verification`);
  }
  // When finality advances, retain both earlier observations as canonical too.
  const retained = new Map([opening.finalized, opening.reported].map((checkpoint) => [checkpoint.number, checkpoint]));
  for (const before of retained.values()) {
    if (![closing.finalized, closing.reported].some((after) => sameBlock(before, after))) {
      await requireCanonicalBlock(request, before, "opening finalized checkpoint");
    }
  }
  refuse(quantity(await request("eth_chainId", []), "closing chain ID") === BigInt(chain.id), "chain ID changed during verification");
  const genesis = block(await request("eth_getBlockByNumber", ["0x0", false]), "closing genesis block");
  refuse(genesis.number === 0n && genesis.hash === chain.genesisHash, "genesis changed during verification");
}

function word(data, index, field) {
  refuse(typeof data === "string" && /^0x(?:[0-9a-f]{64})+$/.test(data), `${field} returned malformed data`);
  const start = 2 + index * 64;
  refuse(data.length >= start + 64, `${field} returned too little data`);
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

function wordAddress(data, index, field) {
  const value = word(data, index, field);
  refuse(value < 1n << 160n, `${field} is not an address`);
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function encodeAddress(address) {
  return address.slice(2).padStart(64, "0");
}

export function validateGateConfig(config) {
  exactKeys(config, ["schemaVersion", "domain", "chain", "deployment", "limits"], "configuration");
  refuse(config.domain === GATE_DOMAIN, "configuration schema is not supported");
  if (config.schemaVersion === 2) return validateGateConfigV2(config);
  refuse(config.schemaVersion === 1, "configuration schema is not supported");
  exactKeys(config.chain, ["id", "genesisHash"], "chain");
  refuse(Number.isSafeInteger(config.chain.id) && config.chain.id > 0, "chain.id is invalid");
  refuse(HASH.test(config.chain.genesisHash) && config.chain.genesisHash !== ZERO_HASH, "chain.genesisHash is invalid");
  exactKeys(config.deployment, ["factory", "wrappedNative", "pair", "transactions"], "deployment");
  for (const field of ["factory", "wrappedNative", "pair"]) {
    refuse(ADDRESS.test(config.deployment[field]), `deployment.${field} must be a lowercase address`);
  }
  const { transactions } = config.deployment;
  refuse(
    Array.isArray(transactions) && transactions.length > 0 && transactions.length <= MAX_TRANSACTIONS,
    "deployment.transactions must list 1 to 64 hashes",
  );
  transactions.forEach((hash, index) => refuse(HASH.test(hash), `deployment.transactions[${index}] is invalid`));
  refuse(new Set(transactions).size === transactions.length, "deployment.transactions repeats a hash");
  exactKeys(config.limits, ["maxWrappedReserveCap"], "limits");
  refuse(
    typeof config.limits.maxWrappedReserveCap === "string" && /^[1-9][0-9]*$/.test(config.limits.maxWrappedReserveCap),
    "limits.maxWrappedReserveCap must be a positive decimal string",
  );
}

/// Evaluate the gate against `request(method, params)`. Throws on any refusal;
/// returns the observation that enabled liquidity otherwise.
/// `options.bridgeTokens` (schema 2): a list of `{plan, record}` from the
/// bridge's deploy_pontes.py; each token is then checked against its bridge
/// deployment at the finalized block (bridge-token-identity.mjs, agent 180 L-3).
export async function evaluateFinalityGate(config, request, options = {}) {
  validateGateConfig(config);
  refuse(typeof request === "function", "RPC request function is required");
  const bridgeTokens = options.bridgeTokens ?? [];
  refuse(Array.isArray(bridgeTokens), "bridgeTokens must be a list");
  // `options.bridgePin` is for tests only; the mainnet wrapper always uses the repository pin.
  if (config.schemaVersion === 2) return evaluateFinalityGateV2(config, request, bridgeTokens, options.bridgePin);
  refuse(bridgeTokens.length === 0, "bridge token records need a schema-2 gate");
  const { chain, deployment, limits } = config;

  refuse(quantity(await request("eth_chainId", []), "chain ID") === BigInt(chain.id), "chain ID does not match");
  const genesis = block(await request("eth_getBlockByNumber", ["0x0", false]), "genesis block");
  refuse(genesis.number === 0n && genesis.hash === chain.genesisHash, "genesis hash does not match the pinned value");

  const opening = await readFinality(request, genesis.hash);
  const { finalized, finality } = opening;

  const included = [];
  for (const hash of deployment.transactions) {
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(receipt && receipt.transactionHash === hash, `transaction ${hash} has no receipt`);
    refuse(receipt.status === "0x1", `transaction ${hash} reverted`);
    const number = quantity(receipt.blockNumber, `receipt ${hash} blockNumber`);
    refuse(number <= finalized.number, `transaction ${hash} is not finalized`);
    const canonical = block(
      await request("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]),
      `block ${number}`,
    );
    refuse(canonical.number === number && canonical.hash === receipt.blockHash, `transaction ${hash} is not on the canonical chain`);
    included.push(Object.freeze({ hash, blockNumber: number.toString(), blockHash: receipt.blockHash }));
  }

  const at = { blockHash: finalized.hash, requireCanonical: true };
  const call = (to, data, field) => request("eth_call", [{ to, data }, at]).then((result) => {
    refuse(typeof result === "string", `${field} call failed`);
    return result;
  });
  for (const field of ["factory", "pair"]) {
    const code = await request("eth_getCode", [deployment[field], at]);
    refuse(typeof code === "string" && code.length > 2, `${field} has no code at the finalized block`);
  }
  const { factory, wrappedNative, pair } = deployment;
  const cap = word(await call(factory, SELECTORS.reserveCap + encodeAddress(wrappedNative), "reserveCap"), 0, "reserveCap");
  refuse(cap > 0n, "the factory does not cap the wrapped native reserve");
  refuse(cap <= BigInt(limits.maxWrappedReserveCap), "the wrapped native reserve cap exceeds the configured ceiling");

  const token0 = wordAddress(await call(pair, SELECTORS.token0, "token0"), 0, "token0");
  const token1 = wordAddress(await call(pair, SELECTORS.token1, "token1"), 0, "token1");
  refuse(token0 === wrappedNative || token1 === wrappedNative, "the pair does not hold the wrapped native token");
  const registered = wordAddress(
    await call(factory, SELECTORS.getPair + encodeAddress(token0) + encodeAddress(token1), "getPair"),
    0,
    "getPair",
  );
  refuse(registered === pair, "the factory does not register this pair");
  const caps = await call(pair, SELECTORS.reserveCaps, "reserveCaps");
  const pairCap = word(caps, token0 === wrappedNative ? 0 : 1, "reserveCaps");
  refuse(pairCap === cap, "the pair's wrapped native cap differs from the factory's");

  await verifyClosingFinality(request, chain, opening);

  return Object.freeze({
    domain: GATE_DOMAIN,
    decision: "liquidity-enabled",
    chainId: chain.id,
    genesisHash: genesis.hash,
    finalized: Object.freeze({ number: finalized.number.toString(), hash: finalized.hash }),
    trust: typeof finality.trust === "string" ? finality.trust : null,
    wrappedReserveCap: cap.toString(),
    pair: Object.freeze({ address: pair, token0, token1 }),
    transactions: Object.freeze(included),
  });
}

// ------------------------------------------------------------------------ //
// Schema 2: the mainnet gate, generated by `deploy-dex.mjs record` from the  //
// reviewed deployment plan. Everything schema 1 checks, plus: every         //
// deployment transaction was sent by the pinned deployer; the runtime code  //
// of every contract, pair and capped token matches the plan at the          //
// finalized block, including the Bloch Inc multisig; the factory's pair     //
// init-code hash, fixed fee recipient (Bloch Inc) and every cap equal the    //
// plan; every bridged token's bucket capacity is the reviewed one and at    //
// least ten times its DEX cap; the router and lens are bound to this        //
// factory and wrapper; and every planned pair is registered with the        //
// factory's caps.                                                           //
// ------------------------------------------------------------------------ //

function codeHashOf(code, field) {
  refuse(typeof code === "string" && /^0x(?:[0-9a-f]{2})*$/.test(code), `${field} returned malformed code`);
  return code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
}

function lowerAddress(value, field) {
  refuse(typeof value === "string" && ADDRESS.test(value) && value !== `0x${"0".repeat(40)}`, `${field} must be a nonzero lowercase address`);
}

function nonzeroHash(value, field) {
  refuse(typeof value === "string" && HASH.test(value) && value !== ZERO_HASH, `${field} must be a nonzero 32-byte hash`);
}

/// Validate a pinned Safe description: `{version, singleton: {address,
/// codeHash}, fallbackHandler: {address, codeHash}, threshold, owners}`.
export function validateSafePin(safe, field, fail = refuse) {
  fail(
    safe && typeof safe === "object" && !Array.isArray(safe) && Reflect.ownKeys(safe).length === 5 &&
      ["version", "singleton", "fallbackHandler", "threshold", "owners"].every((key) => Object.hasOwn(safe, key)),
    `${field} must have exactly the fields version, singleton, fallbackHandler, threshold, owners`,
  );
  fail(safe.version === SAFE.version, `${field}.version must be "${SAFE.version}"`);
  for (const key of ["singleton", "fallbackHandler"]) {
    const entry = safe[key];
    fail(
      entry && typeof entry === "object" && Reflect.ownKeys(entry).length === 2 &&
        ADDRESS.test(entry.address) && entry.address !== ZERO_ADDRESS &&
        HASH.test(entry.codeHash) && entry.codeHash !== ZERO_HASH && entry.codeHash !== EMPTY_CODE_HASH,
      `${field}.${key} must be {address, codeHash} of a contract`,
    );
  }
  const { owners, threshold } = safe;
  fail(Array.isArray(owners) && owners.length > 0 && owners.length <= SAFE.maxOwners, `${field}.owners must list 1 to ${SAFE.maxOwners} owners`);
  owners.forEach((owner, index) => fail(ADDRESS.test(owner) && owner !== ZERO_ADDRESS && owner !== SAFE.sentinel, `${field}.owners[${index}] is invalid`));
  fail(new Set(owners).size === owners.length, `${field}.owners repeats an owner`);
  fail(Number.isSafeInteger(threshold) && threshold >= 1 && threshold <= owners.length, `${field}.threshold is invalid`);
}

function dynamicAddresses(data, offsetWord, field) {
  const offset = word(data, offsetWord, field);
  refuse(offset % 32n === 0n && offset < 1n << 16n, `${field} returned a malformed array`);
  const start = Number(offset / 32n);
  const length = word(data, start, field);
  refuse(length <= BigInt(SAFE.maxOwners + 1), `${field} returned too many entries`);
  return Array.from({ length: Number(length) }, (_, i) => wordAddress(data, start + 1 + i, field));
}

function dynamicString(data, field) {
  const offset = word(data, 0, field);
  refuse(offset === 32n, `${field} returned a malformed string`);
  const length = Number(word(data, 1, field));
  refuse(length <= 32, `${field} returned a long string`);
  const hex = data.slice(2 + 128, 2 + 128 + length * 2);
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16)));
}

/// Verify that `address` is the pinned Safe at block `at`: its singleton
/// (storage slot 0) and fallback handler (slot) are the pinned contracts with
/// the pinned runtime code, no guard and no module is set, the threshold and
/// the owner set are exactly the pinned ones and VERSION() is 1.4.1. The
/// proxy's own runtime code hash is checked by the caller.
export async function verifySafe(safe, address, request, at) {
  const call = async (data, field) => {
    const result = await request("eth_call", [{ to: address, data }, at]);
    refuse(typeof result === "string", `Bloch Inc Safe ${field} call failed`);
    return result;
  };
  const slot = async (key, field) => {
    const value = await request("eth_getStorageAt", [address, key, at]);
    refuse(typeof value === "string" && /^0x[0-9a-f]{1,64}$/.test(value), `Bloch Inc Safe ${field} slot is unreadable`);
    return wordAddress(`0x${value.slice(2).padStart(64, "0")}`, 0, `Bloch Inc Safe ${field}`);
  };
  refuse((await slot(SAFE.singletonSlot, "singleton")) === safe.singleton.address, "Bloch Inc Safe singleton differs from the pin");
  refuse((await slot(SAFE.fallbackHandlerSlot, "fallback handler")) === safe.fallbackHandler.address, "Bloch Inc Safe fallback handler differs from the pin");
  refuse((await slot(SAFE.guardSlot, "guard")) === ZERO_ADDRESS, "Bloch Inc Safe has a guard");
  for (const [key, name] of [["singleton", "singleton"], ["fallbackHandler", "fallback handler"]]) {
    const observed = codeHashOf(await request("eth_getCode", [safe[key].address, at]), `Safe ${name}`);
    refuse(observed === safe[key].codeHash, `Bloch Inc Safe ${name} runtime code differs from the pin`);
  }
  const threshold = word(await call(SAFE.selectors.getThreshold, "getThreshold"), 0, "getThreshold");
  refuse(threshold === BigInt(safe.threshold), "Bloch Inc Safe threshold differs from the pin");
  const owners = dynamicAddresses(await call(SAFE.selectors.getOwners, "getOwners"), 0, "getOwners");
  refuse(
    owners.length === safe.owners.length && new Set(owners).size === owners.length && owners.every((o) => safe.owners.includes(o)),
    "Bloch Inc Safe owners differ from the pin",
  );
  const modules = await call(
    `${SAFE.selectors.getModulesPaginated}${encodeAddress(SAFE.sentinel)}${(10).toString(16).padStart(64, "0")}`,
    "getModulesPaginated",
  );
  refuse(dynamicAddresses(modules, 0, "getModulesPaginated").length === 0, "Bloch Inc Safe has an enabled module");
  refuse(wordAddress(modules, 1, "getModulesPaginated next") === SAFE.sentinel, "Bloch Inc Safe module page is incomplete");
  refuse(dynamicString(await call(SAFE.selectors.VERSION, "VERSION"), "VERSION") === SAFE.version, "Bloch Inc Safe is not version 1.4.1");
  return Object.freeze({ address, threshold: safe.threshold, owners: Object.freeze([...safe.owners]), singleton: safe.singleton.address });
}

function validateGateConfigV2(config) {
  exactKeys(config.chain, ["id", "genesisHash"], "chain");
  refuse(Number.isSafeInteger(config.chain.id) && config.chain.id > 0, "chain.id is invalid");
  nonzeroHash(config.chain.genesisHash, "chain.genesisHash");
  const { deployment } = config;
  exactKeys(
    deployment,
    [
      "deployer", "firstDepositor", "contracts", "pairInitCodeHash", "feeTo", "roles", "reserveCaps", "tokens", "pairs", "transactions",
      ...(Object.hasOwn(deployment, "existingPairTransactions") ? ["existingPairTransactions"] : []),
      ...(Object.hasOwn(deployment, "depositorTransactions") ? ["depositorTransactions"] : []),
    ],
    "deployment",
  );
  if (Object.hasOwn(deployment, "existingPairTransactions")) {
    const listed = deployment.existingPairTransactions;
    refuse(Array.isArray(listed) && listed.length > 0 && listed.length <= deployment.pairs?.length, "deployment.existingPairTransactions is invalid");
    for (const hash of listed) refuse(deployment.transactions?.includes(hash), "deployment.existingPairTransactions names an unplanned transaction");
  }
  if (Object.hasOwn(deployment, "depositorTransactions")) {
    refuse(Array.isArray(deployment.depositorTransactions) && deployment.depositorTransactions.every((h) => /^0x[0-9a-f]{64}$/.test(h)), "deployment.depositorTransactions is invalid");
  }
  lowerAddress(deployment.deployer, "deployment.deployer");
  lowerAddress(deployment.firstDepositor, "deployment.firstDepositor");
  refuse(deployment.firstDepositor !== ZERO_ADDRESS, "deployment.firstDepositor must not be zero");
  exactKeys(deployment.contracts, CONTRACT_KEYS, "deployment.contracts");
  for (const key of CONTRACT_KEYS) {
    exactKeys(deployment.contracts[key], ["address", "codeHash"], `deployment.contracts.${key}`);
    lowerAddress(deployment.contracts[key].address, `deployment.contracts.${key}.address`);
    nonzeroHash(deployment.contracts[key].codeHash, `deployment.contracts.${key}.codeHash`);
    refuse(deployment.contracts[key].codeHash !== EMPTY_CODE_HASH, `deployment.contracts.${key} has no code`);
  }
  nonzeroHash(deployment.pairInitCodeHash, "deployment.pairInitCodeHash");
  exactKeys(deployment.roles, ["blochInc"], "deployment.roles");
  const { blochInc } = deployment.roles;
  exactKeys(blochInc, Object.hasOwn(blochInc ?? {}, "safe") ? ["address", "codeHash", "safe"] : ["address", "codeHash"], "deployment.roles.blochInc");
  // Owner decision 2026-11-17: the owner's pinned plain address is the only Bloch Inc without code (no Safe pin).
  const ownerEoa = blochInc?.address === OWNER_FEE_EOA;
  refuse(config.chain.id !== MAINNET_CHAIN_ID || ownerEoa || blochInc.safe, "deployment.roles.blochInc.safe is required on the mainnet");
  if (blochInc.safe) validateSafePin(blochInc.safe, "deployment.roles.blochInc.safe");
  lowerAddress(deployment.roles.blochInc.address, "deployment.roles.blochInc.address");
  nonzeroHash(deployment.roles.blochInc.codeHash, "deployment.roles.blochInc.codeHash");
  if (ownerEoa) {
    refuse(blochInc.codeHash === EMPTY_CODE_HASH && !blochInc.safe, "deployment.roles.blochInc is the owner's plain fee address: empty-code pin, no Safe pin");
  } else {
    refuse(deployment.roles.blochInc.codeHash !== EMPTY_CODE_HASH, "deployment.roles.blochInc must be a multisig contract");
  }
  lowerAddress(deployment.feeTo, "deployment.feeTo");
  refuse(deployment.feeTo === deployment.roles.blochInc.address, "deployment.feeTo must be Bloch Inc");
  const wrapped = deployment.contracts.wrappedNative.address;
  refuse(Array.isArray(deployment.reserveCaps) && deployment.reserveCaps.length > 0 && deployment.reserveCaps.length <= 8, "deployment.reserveCaps must list 1 to 8 caps");
  const capped = new Set();
  deployment.reserveCaps.forEach((entry, index) => {
    exactKeys(entry, ["token", "cap"], `deployment.reserveCaps[${index}]`);
    lowerAddress(entry.token, `deployment.reserveCaps[${index}].token`);
    refuse(typeof entry.cap === "string" && /^[1-9][0-9]*$/.test(entry.cap) && BigInt(entry.cap) <= UINT112_MAX, `deployment.reserveCaps[${index}].cap is invalid`);
    refuse(!capped.has(entry.token), "deployment.reserveCaps repeats a token");
    capped.add(entry.token);
  });
  refuse(capped.has(wrapped), "deployment.reserveCaps must cap the wrapped native token");
  refuse(Array.isArray(deployment.tokens) && deployment.tokens.length < deployment.reserveCaps.length, "deployment.tokens is invalid");
  deployment.tokens.forEach((entry, index) => {
    exactKeys(entry, ["token", "symbol", "codeHash", "bridgeBucketCapacity"], `deployment.tokens[${index}]`);
    refuse(capped.has(entry.token) && entry.token !== wrapped, `deployment.tokens[${index}] is not a capped token`);
    refuse(typeof entry.symbol === "string" && entry.symbol.length > 0, `deployment.tokens[${index}].symbol is invalid`);
    nonzeroHash(entry.codeHash, `deployment.tokens[${index}].codeHash`);
    refuse(
      typeof entry.bridgeBucketCapacity === "string" && /^[1-9][0-9]*$/.test(entry.bridgeBucketCapacity),
      `deployment.tokens[${index}].bridgeBucketCapacity is invalid`,
    );
    const cap = BigInt(deployment.reserveCaps.find((c) => c.token === entry.token).cap);
    refuse(cap * BRIDGE_BUCKET_DIVISOR <= BigInt(entry.bridgeBucketCapacity), `deployment.tokens[${index}] cap exceeds 1/10 of its bridge bucket`);
  });
  refuse(new Set(deployment.tokens.map((t) => t.token)).size === deployment.tokens.length, "deployment.tokens repeats a token");
  refuse(deployment.tokens.length === deployment.reserveCaps.length - 1, "every capped token other than the wrapper must pin its code hash");
  refuse(Array.isArray(deployment.pairs) && deployment.pairs.length > 0 && deployment.pairs.length <= 4, "deployment.pairs must list 1 to 4 pairs");
  deployment.pairs.forEach((entry, index) => {
    exactKeys(entry, ["address", "token0", "token1", "codeHash"], `deployment.pairs[${index}]`);
    for (const key of ["address", "token0", "token1"]) lowerAddress(entry[key], `deployment.pairs[${index}].${key}`);
    refuse(entry.token0 < entry.token1, `deployment.pairs[${index}] tokens are not sorted`);
    refuse(capped.has(entry.token0) && capped.has(entry.token1), `deployment.pairs[${index}] pairs an uncapped token`);
    nonzeroHash(entry.codeHash, `deployment.pairs[${index}].codeHash`);
  });
  refuse(deployment.pairs.some((p) => p.token0 === wrapped || p.token1 === wrapped), "no planned pair holds the wrapped native token");
  const { transactions } = deployment;
  refuse(
    Array.isArray(transactions) && transactions.length > 0 && transactions.length <= MAX_TRANSACTIONS,
    "deployment.transactions must list 1 to 64 hashes",
  );
  transactions.forEach((hash, index) => refuse(HASH.test(hash), `deployment.transactions[${index}] is invalid`));
  refuse(new Set(transactions).size === transactions.length, "deployment.transactions repeats a hash");
  exactKeys(config.limits, ["maxWrappedReserveCap"], "limits");
  refuse(
    typeof config.limits.maxWrappedReserveCap === "string" && /^[1-9][0-9]*$/.test(config.limits.maxWrappedReserveCap),
    "limits.maxWrappedReserveCap must be a positive decimal string",
  );
  const wrappedCap = BigInt(deployment.reserveCaps.find((c) => c.token === wrapped).cap);
  refuse(wrappedCap <= BigInt(config.limits.maxWrappedReserveCap), "the configured wrapped native cap exceeds the ceiling");
}

const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)");
const SEED_SELECTOR = toFunctionSelector("addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)");

/// A griefer can make a planned seed revert for gas, which moves the depositor's
/// nonce with the first-deposit rule unspent (N1). So a nonzero nonce is acceptable
/// only if each of its `count` transactions is, from the chain's own data, an approve of
/// the router on a planned token or a router seed of a planned token. Hashes come from
/// the operator and prove nothing by themselves. A nonce gap, another sender, another
/// target or calldata refuses. A signed transaction that is not yet mined cannot be seen.
/// Every receipt is bound to its transaction and canonical inclusion no later
/// than `checkpoint`, the same block used to read the account nonce.
export async function verifyDepositorHistory({ depositor, count, transactions, router, tokens, checkpoint }, request) {
  refuse(typeof count === "bigint" && count >= 0n, "depositor history nonce count is invalid");
  refuse(checkpoint && typeof checkpoint.number === "bigint" && checkpoint.number >= 0n && HASH.test(checkpoint.hash) && checkpoint.hash !== ZERO_HASH, "depositor history needs the nonce checkpoint");
  refuse(Array.isArray(transactions) && transactions.every((hash) => HASH.test(hash)), "depositor history transaction hashes are invalid");
  refuse(new Set(transactions).size === transactions.length, "depositor history repeats a transaction hash");
  const byNonce = new Map();
  for (const hash of transactions) {
    const tx = await request("eth_getTransactionByHash", [hash]);
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(tx && receipt && tx.blockNumber !== null && tx.blockHash !== null, `depositor transaction ${hash} is not mined`);
    refuse(tx.hash === hash && receipt.transactionHash === hash, `depositor transaction ${hash} identity differs from its receipt`);
    refuse(String(tx.from).toLowerCase() === depositor, `transaction ${hash} was not sent by the first depositor`);
    refuse(String(receipt.from).toLowerCase() === depositor && String(receipt.to).toLowerCase() === String(tx.to).toLowerCase(), `depositor transaction ${hash} receipt participants differ`);
    refuse(receipt.status === "0x0" || receipt.status === "0x1", `depositor transaction ${hash} receipt status is invalid`);
    const number = quantity(tx.blockNumber, `depositor transaction ${hash} blockNumber`);
    refuse(number <= checkpoint.number, `depositor transaction ${hash} is newer than the nonce checkpoint`);
    refuse(quantity(receipt.blockNumber, `depositor receipt ${hash} blockNumber`) === number &&
      HASH.test(tx.blockHash) && receipt.blockHash === tx.blockHash, `depositor transaction ${hash} inclusion differs from its receipt`);
    await requireCanonicalBlock(request, { number, hash: tx.blockHash }, `depositor transaction ${hash}`);
    const nonce = quantity(tx.nonce, `depositor transaction ${hash} nonce`);
    refuse(nonce < count, `depositor transaction ${hash} nonce is outside the checkpoint history`);
    refuse(!byNonce.has(nonce), `depositor history repeats nonce ${nonce}`);
    byNonce.set(nonce, tx);
  }
  const words = (input) => input.slice(10).match(/.{64}/g) ?? [];
  const addressWord = (word) => `0x${word.slice(24)}`.toLowerCase();
  for (let nonce = 0n; nonce < count; nonce += 1n) {
    const tx = byNonce.get(nonce);
    refuse(tx, `the first depositor's transaction at nonce ${nonce} is not listed: its key is not single-purpose`);
    const to = String(tx.to).toLowerCase();
    const input = String(tx.input).toLowerCase();
    const [first] = words(input);
    const planned =
      first !== undefined &&
      ((tokens.includes(to) && input.startsWith(APPROVE_SELECTOR) && addressWord(first) === router) ||
        (to === router && input.startsWith(SEED_SELECTOR) && tokens.includes(addressWord(first))));
    refuse(planned, `the first depositor's transaction at nonce ${nonce} is not a planned approve or seed: its key is not single-purpose`);
  }
  await requireCanonicalBlock(request, checkpoint, "depositor nonce checkpoint");
  return Number(count);
}

async function evaluateFinalityGateV2(config, request, bridgeTokens = [], bridgePin = undefined) {
  const { chain, deployment, limits } = config;
  // Static first, before any RPC call: each bridge record must match this gate file.
  const identities = bridgeTokens.map((b) => checkBridgeRecord(config, b, bridgePin));
  refuse(new Set(identities.map((i) => i.address)).size === identities.length, "a bridge token is listed twice");
  refuse(quantity(await request("eth_chainId", []), "chain ID") === BigInt(chain.id), "chain ID does not match");
  const genesis = block(await request("eth_getBlockByNumber", ["0x0", false]), "genesis block");
  refuse(genesis.number === 0n && genesis.hash === chain.genesisHash, "genesis hash does not match the pinned value");

  const opening = await readFinality(request, genesis.hash);
  const { finalized, finality } = opening;

  const included = [];
  for (const hash of deployment.transactions) {
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(receipt && receipt.transactionHash === hash, `transaction ${hash} has no receipt`);
    // A planned createPair may revert when a third party created the pair first.
    // The pair checks below still require that pair to be exactly the planned one.
    refuse(receipt.status === "0x1" || deployment.existingPairTransactions?.includes(hash), `transaction ${hash} reverted`);
    refuse(receipt.status === "0x1" || receipt.to?.toLowerCase() === deployment.contracts.factory.address, `transaction ${hash} reverted and did not call the factory`);
    refuse(typeof receipt.from === "string" && receipt.from.toLowerCase() === deployment.deployer, `transaction ${hash} was not sent by the deployer`);
    const number = quantity(receipt.blockNumber, `receipt ${hash} blockNumber`);
    refuse(number <= finalized.number, `transaction ${hash} is not finalized`);
    const canonical = block(
      await request("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]),
      `block ${number}`,
    );
    refuse(canonical.number === number && canonical.hash === receipt.blockHash, `transaction ${hash} is not on the canonical chain`);
    included.push(Object.freeze({ hash, blockNumber: number.toString(), blockHash: receipt.blockHash }));
  }

  const at = { blockHash: finalized.hash, requireCanonical: true };
  const call = (to, data, field) => request("eth_call", [{ to, data }, at]).then((result) => {
    refuse(typeof result === "string", `${field} call failed`);
    return result;
  });
  const addressAt = async (to, data, field) => wordAddress(await call(to, data, field), 0, field);
  const codeAt = async (address, expected, field) => {
    const observed = codeHashOf(await request("eth_getCode", [address, at]), field);
    refuse(observed === expected, `${field} runtime code differs from the plan at the finalized block`);
  };
  const { contracts, roles } = deployment;
  for (const key of CONTRACT_KEYS) await codeAt(contracts[key].address, contracts[key].codeHash, key);
  await codeAt(roles.blochInc.address, roles.blochInc.codeHash, roles.blochInc.address === OWNER_FEE_EOA ? "Bloch Inc (the owner's plain fee address: no code, no EIP-7702 delegation)" : "Bloch Inc multisig");
  const safe = roles.blochInc.safe ? await verifySafe(roles.blochInc.safe, roles.blochInc.address, request, at) : null;
  for (const { token, symbol, codeHash, bridgeBucketCapacity } of deployment.tokens) {
    await codeAt(token, codeHash, `token ${symbol}`);
    const bucket = word(await call(token, SELECTORS.bucketCapacity, `${symbol}.bucketCapacity`), 0, `${symbol}.bucketCapacity`);
    refuse(bucket === BigInt(bridgeBucketCapacity), `${symbol} bridge bucket capacity differs from the plan`);
  }
  const bridged = [];
  for (const identity of identities) bridged.push(await verifyBridgeToken(identity, request, at, finalized.number));

  const factory = contracts.factory.address;
  const wrapped = contracts.wrappedNative.address;
  refuse(
    `0x${word(await call(factory, SELECTORS.initCodePairHash, "INIT_CODE_PAIR_HASH"), 0, "INIT_CODE_PAIR_HASH").toString(16).padStart(64, "0")}` ===
      deployment.pairInitCodeHash,
    "the factory's pair init-code hash differs from the plan",
  );
  const feeTo = await addressAt(factory, SELECTORS.feeTo, "feeTo");
  refuse(feeTo !== ZERO_ADDRESS, "the protocol fee is off");
  refuse(feeTo === deployment.feeTo, "the protocol fee recipient is not Bloch Inc");
  const depositor = await addressAt(factory, SELECTORS.firstDepositor, "firstDepositor");
  refuse(depositor !== ZERO_ADDRESS, "the first-deposit rule is off");
  refuse(depositor === deployment.firstDepositor, "the factory's first depositor differs from the plan");
  const capOf = new Map();
  for (const { token, cap } of deployment.reserveCaps) {
    const observed = word(await call(factory, SELECTORS.reserveCap + encodeAddress(token), "reserveCap"), 0, "reserveCap");
    refuse(observed === BigInt(cap), `the factory's cap for ${token} differs from the plan`);
    capOf.set(token, observed);
  }
  const wrappedCap = capOf.get(wrapped);
  refuse(wrappedCap > 0n && wrappedCap <= BigInt(limits.maxWrappedReserveCap), "the wrapped native reserve cap exceeds the configured ceiling");

  const router = contracts.router.address;
  refuse((await addressAt(router, SELECTORS.factory, "router.factory")) === factory, "the router serves another factory");
  refuse((await addressAt(router, SELECTORS.routerWrapped, "router.WBLCH")) === wrapped, "the router wraps another token");
  refuse((await addressAt(contracts.lens.address, SELECTORS.factory, "lens.factory")) === factory, "the lens reads another factory");

  const pairs = [];
  for (const { address: pair, token0, token1, codeHash } of deployment.pairs) {
    await codeAt(pair, codeHash, `pair ${pair}`);
    refuse((await addressAt(pair, SELECTORS.factory, "pair.factory")) === factory, `pair ${pair} belongs to another factory`);
    refuse((await addressAt(pair, SELECTORS.token0, "token0")) === token0, `pair ${pair} token0 differs`);
    refuse((await addressAt(pair, SELECTORS.token1, "token1")) === token1, `pair ${pair} token1 differs`);
    refuse(
      (await addressAt(factory, SELECTORS.getPair + encodeAddress(token0) + encodeAddress(token1), "getPair")) === pair,
      `the factory does not register pair ${pair}`,
    );
    const caps = await call(pair, SELECTORS.reserveCaps, "reserveCaps");
    refuse(
      word(caps, 0, "reserveCaps") === (capOf.get(token0) ?? 0n) && word(caps, 1, "reserveCaps") === (capOf.get(token1) ?? 0n),
      `pair ${pair} caps differ from the factory's`,
    );
    // Before the seed the depositor must be untouched: one call to a hostile contract
    // can spend the first-deposit rule through tx.origin.
    if (word(await call(pair, SELECTORS.totalSupply, "totalSupply"), 0, "totalSupply") === 0n) {
      const used = BigInt(await request("eth_getTransactionCount", [depositor, at]));
      if (used !== 0n) {
        refuse(deployment.depositorTransactions, `the first depositor ${depositor} has sent ${used} transaction(s) before the seed: its key is not single-purpose`);
        await verifyDepositorHistory(
          { depositor, count: used, transactions: deployment.depositorTransactions, router, tokens: deployment.tokens.map((t) => t.token), checkpoint: finalized },
          request,
        );
      }
      refuse((await request("eth_getCode", [depositor, at])) === "0x", "the first depositor must be an EOA");
    }
    pairs.push(Object.freeze({ address: pair, token0, token1 }));
  }

  await verifyClosingFinality(request, chain, opening);

  return Object.freeze({
    domain: GATE_DOMAIN,
    schemaVersion: 2,
    decision: "liquidity-enabled",
    chainId: chain.id,
    genesisHash: genesis.hash,
    finalized: Object.freeze({ number: finalized.number.toString(), hash: finalized.hash }),
    trust: typeof finality.trust === "string" ? finality.trust : null,
    wrappedReserveCap: wrappedCap.toString(),
    feeTo,
    ...(safe ? { blochIncSafe: safe } : {}),
    ...(bridged.length ? { bridgeTokens: Object.freeze(bridged) } : {}),
    pairs: Object.freeze(pairs),
    transactions: Object.freeze(included),
  });
}

export function createJsonRpcRequest(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const request = createRpcTransport(url, { fetchImpl, timeoutMs });
  return async (method, params) => {
    try { return await request(method, params); }
    catch (error) { throw new Error(`finality gate: ${error.message}`, { cause: error }); }
  };
}
