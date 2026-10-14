// Ethereum-model DEX launch gate: no signed checkpoints, cap approvals or
// reviewer quorums. Trust is pinned once (chain ID and genesis hash in the
// configuration); everything else is read from the chain at the RPC's
// `finalized` block, which on Bloch L2 comes from replaying native FFG from the
// pinned genesis. Reserve caps are the factory's constructor-fixed values.

import { createRequire } from "node:module";

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
const UINT112_MAX = (1n << 112n) - 1n;
const CONTRACT_KEYS = Object.freeze(["wrappedNative", "factory", "router", "lens"]);
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

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
export async function evaluateFinalityGate(config, request) {
  validateGateConfig(config);
  refuse(typeof request === "function", "RPC request function is required");
  if (config.schemaVersion === 2) return evaluateFinalityGateV2(config, request);
  const { chain, deployment, limits } = config;

  refuse(quantity(await request("eth_chainId", []), "chain ID") === BigInt(chain.id), "chain ID does not match");
  const genesis = block(await request("eth_getBlockByNumber", ["0x0", false]), "genesis block");
  refuse(genesis.number === 0n && genesis.hash === chain.genesisHash, "genesis hash does not match the pinned value");

  const finalized = block(await request("eth_getBlockByNumber", ["finalized", false]), "finalized block");
  refuse(finalized.number > 0n, "nothing beyond genesis is finalized");
  const finality = await request("bloch_finality", []);
  refuse(finality && typeof finality === "object" && finality.finalized, "bloch_finality is unavailable");
  const reported = block(finality.finalized, "bloch_finality.finalized");
  refuse(
    reported.number >= finalized.number,
    "bloch_finality reports an older finalized block than eth_getBlockByNumber",
  );

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
    refuse(canonical.hash === receipt.blockHash, `transaction ${hash} is not on the canonical chain`);
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

function validateGateConfigV2(config) {
  exactKeys(config.chain, ["id", "genesisHash"], "chain");
  refuse(Number.isSafeInteger(config.chain.id) && config.chain.id > 0, "chain.id is invalid");
  nonzeroHash(config.chain.genesisHash, "chain.genesisHash");
  const { deployment } = config;
  exactKeys(
    deployment,
    ["deployer", "contracts", "pairInitCodeHash", "feeTo", "roles", "reserveCaps", "tokens", "pairs", "transactions"],
    "deployment",
  );
  lowerAddress(deployment.deployer, "deployment.deployer");
  exactKeys(deployment.contracts, CONTRACT_KEYS, "deployment.contracts");
  for (const key of CONTRACT_KEYS) {
    exactKeys(deployment.contracts[key], ["address", "codeHash"], `deployment.contracts.${key}`);
    lowerAddress(deployment.contracts[key].address, `deployment.contracts.${key}.address`);
    nonzeroHash(deployment.contracts[key].codeHash, `deployment.contracts.${key}.codeHash`);
    refuse(deployment.contracts[key].codeHash !== EMPTY_CODE_HASH, `deployment.contracts.${key} has no code`);
  }
  nonzeroHash(deployment.pairInitCodeHash, "deployment.pairInitCodeHash");
  exactKeys(deployment.roles, ["blochInc"], "deployment.roles");
  exactKeys(deployment.roles.blochInc, ["address", "codeHash"], "deployment.roles.blochInc");
  lowerAddress(deployment.roles.blochInc.address, "deployment.roles.blochInc.address");
  nonzeroHash(deployment.roles.blochInc.codeHash, "deployment.roles.blochInc.codeHash");
  refuse(deployment.roles.blochInc.codeHash !== EMPTY_CODE_HASH, "deployment.roles.blochInc must be a multisig contract");
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

async function evaluateFinalityGateV2(config, request) {
  const { chain, deployment, limits } = config;
  refuse(quantity(await request("eth_chainId", []), "chain ID") === BigInt(chain.id), "chain ID does not match");
  const genesis = block(await request("eth_getBlockByNumber", ["0x0", false]), "genesis block");
  refuse(genesis.number === 0n && genesis.hash === chain.genesisHash, "genesis hash does not match the pinned value");

  const finalized = block(await request("eth_getBlockByNumber", ["finalized", false]), "finalized block");
  refuse(finalized.number > 0n, "nothing beyond genesis is finalized");
  const finality = await request("bloch_finality", []);
  refuse(finality && typeof finality === "object" && finality.finalized, "bloch_finality is unavailable");
  const reported = block(finality.finalized, "bloch_finality.finalized");
  refuse(
    reported.number >= finalized.number,
    "bloch_finality reports an older finalized block than eth_getBlockByNumber",
  );

  const included = [];
  for (const hash of deployment.transactions) {
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(receipt && receipt.transactionHash === hash, `transaction ${hash} has no receipt`);
    refuse(receipt.status === "0x1", `transaction ${hash} reverted`);
    refuse(typeof receipt.from === "string" && receipt.from.toLowerCase() === deployment.deployer, `transaction ${hash} was not sent by the deployer`);
    const number = quantity(receipt.blockNumber, `receipt ${hash} blockNumber`);
    refuse(number <= finalized.number, `transaction ${hash} is not finalized`);
    const canonical = block(
      await request("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]),
      `block ${number}`,
    );
    refuse(canonical.hash === receipt.blockHash, `transaction ${hash} is not on the canonical chain`);
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
  await codeAt(roles.blochInc.address, roles.blochInc.codeHash, "Bloch Inc multisig");
  for (const { token, symbol, codeHash, bridgeBucketCapacity } of deployment.tokens) {
    await codeAt(token, codeHash, `token ${symbol}`);
    const bucket = word(await call(token, SELECTORS.bucketCapacity, `${symbol}.bucketCapacity`), 0, `${symbol}.bucketCapacity`);
    refuse(bucket === BigInt(bridgeBucketCapacity), `${symbol} bridge bucket capacity differs from the plan`);
  }

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
    pairs.push(Object.freeze({ address: pair, token0, token1 }));
  }

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
    pairs: Object.freeze(pairs),
    transactions: Object.freeze(included),
  });
}

export function createJsonRpcRequest(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let id = 0;
  return async (method, params) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    refuse(response.ok, `${method} returned HTTP ${response.status}`);
    const body = await response.json();
    refuse(!body.error, `${method} failed: ${body.error?.message ?? "error"}`);
    return body.result;
  };
}
