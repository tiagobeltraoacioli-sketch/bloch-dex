// Ethereum-model DEX launch gate: no signed checkpoints, cap approvals or
// reviewer quorums. Trust is pinned once (chain ID and genesis hash in the
// configuration); everything else is read from the chain at the RPC's
// `finalized` block, which on Bloch L2 comes from replaying native FFG from the
// pinned genesis. Reserve caps are the factory's constructor-fixed values.

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
  refuse(config.schemaVersion === 1 && config.domain === GATE_DOMAIN, "configuration schema is not supported");
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
