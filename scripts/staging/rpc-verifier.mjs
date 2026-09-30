import { createRequire } from "node:module";
import { validateStagingConfig, sha256, stableJson } from "./manifest.mjs";

const requireFromFrontend = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const { keccak256 } = requireFromFrontend("viem");

const HASH = /^0x[0-9a-f]{64}$/;
const CODE = /^0x(?:[0-9a-f]{2})*$/;
const MAX_RPC_BYTES = 1024 * 1024;
const CONTRACT_NAMES = [
  "factory",
  "router",
  "lens",
  "collector",
  "wrappedNative",
];
const ROLE_NAMES = ["feeAuthority", "treasury"];

function required(condition, message) {
  if (!condition) throw new Error(`staging RPC verification: ${message}`);
}

function quantity(value, field) {
  required(
    typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value),
    `${field} is not a canonical hexadecimal quantity`,
  );
  return BigInt(value);
}

function block(value, field) {
  required(
    value && typeof value === "object" && !Array.isArray(value),
    `${field} is unavailable`,
  );
  required(
    HASH.test(value.hash) && value.hash !== `0x${"0".repeat(64)}`,
    `${field}.hash is invalid or zero`,
  );
  const number = quantity(value.number, `${field}.number`);
  required(
    number <= BigInt(Number.MAX_SAFE_INTEGER),
    `${field}.number exceeds the safe integer range`,
  );
  return Object.freeze({
    number,
    hash: value.hash,
  });
}

function blockTag(number) {
  return `0x${BigInt(number).toString(16)}`;
}

function sameBlock(left, right) {
  return left.number === right.number && left.hash === right.hash;
}

function requireFinalityBeyondGenesis(finalized, genesis, field) {
  required(
    finalized.number > genesis.number && finalized.hash !== genesis.hash,
    `${field} has not advanced beyond genesis`,
  );
}

async function boundedBody(response, method) {
  required(
    response.body?.getReader,
    `RPC ${method} response body is unavailable`,
  );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      required(length <= MAX_RPC_BYTES, `RPC ${method} response is too large`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createJsonRpcRequest(rpcUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  required(typeof fetchImpl === "function", "fetch is unavailable");
  required(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
    "RPC timeout is invalid",
  );
  let id = 0;
  return async (method, params) => {
    id += 1;
    const requestId = id;
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    required(response.ok, `RPC ${method} returned HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    required(
      /^application\/json(?:\s*;|$)/i.test(type),
      `RPC ${method} returned a non-JSON content type`,
    );
    const advertised = response.headers.get("content-length");
    required(
      advertised === null ||
        (/^[0-9]+$/.test(advertised) && Number(advertised) <= MAX_RPC_BYTES),
      `RPC ${method} response is too large`,
    );
    const bytes = await boundedBody(response, method);
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(
        `staging RPC verification: RPC ${method} returned invalid JSON`,
      );
    }
    required(
      payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.jsonrpc === "2.0" &&
        payload.id === requestId &&
        !Object.hasOwn(payload, "error") &&
        Object.hasOwn(payload, "result"),
      `RPC ${method} returned an invalid JSON-RPC envelope`,
    );
    return payload.result;
  };
}

export async function verifyStagingDeployment(config, request) {
  validateStagingConfig(config);
  config = structuredClone(config);
  required(typeof request === "function", "RPC request function is required");
  const tag = blockTag(config.deployment.blockNumber);

  const chainId = quantity(await request("eth_chainId", []), "chain ID");
  required(
    chainId === BigInt(config.chain.id),
    "chain ID does not match the manifest",
  );
  const genesis = block(
    await request("eth_getBlockByNumber", ["0x0", false]),
    "genesis block",
  );
  required(genesis.number === 0n, "genesis block number is not zero");
  required(
    genesis.hash === config.chain.genesisHash,
    "genesis hash does not match the manifest",
  );

  const finalizedBefore = block(
    await request("eth_getBlockByNumber", ["finalized", false]),
    "initial finalized block",
  );
  requireFinalityBeyondGenesis(finalizedBefore, genesis, "finalized head");
  const snapshotBefore = block(
    await request("eth_getBlockByNumber", [tag, false]),
    "deployment snapshot",
  );
  required(
    snapshotBefore.number === BigInt(config.deployment.blockNumber) &&
      snapshotBefore.hash === config.deployment.blockHash,
    "deployment snapshot does not match the manifest",
  );
  required(
    finalizedBefore.number >= snapshotBefore.number,
    "deployment snapshot is not finalized",
  );
  required(
    finalizedBefore.number !== snapshotBefore.number ||
      finalizedBefore.hash === snapshotBefore.hash,
    "finalized head conflicts with the deployment snapshot at the same height",
  );

  const identities = new Map();
  const addIdentity = (label, identity, contractRequired) => {
    const address = identity.address.toLowerCase();
    const existing = identities.get(address);
    if (existing) {
      required(
        existing.runtimeCodeHash === identity.runtimeCodeHash,
        `conflicting code hashes for ${address}`,
      );
      existing.labels.push(label);
      existing.contractRequired ||= contractRequired;
      return;
    }
    identities.set(address, {
      address,
      runtimeCodeHash: identity.runtimeCodeHash,
      contractRequired,
      labels: [label],
    });
  };
  for (const name of CONTRACT_NAMES)
    addIdentity(`deployment.${name}`, config.deployment[name], true);
  for (const name of ROLE_NAMES)
    addIdentity(`deployment.${name}`, config.deployment[name], false);
  config.tokens.forEach((token, index) =>
    addIdentity(`tokens[${index}]`, token, true),
  );

  const observations = [];
  for (const identity of identities.values()) {
    const code = await request("eth_getCode", [identity.address, { blockHash: snapshotBefore.hash, requireCanonical: true }]);
    required(
      CODE.test(code),
      `${identity.labels.join("/")} returned invalid runtime code`,
    );
    required(
      !identity.contractRequired || code !== "0x",
      `${identity.labels.join("/")} has no runtime code`,
    );
    const observedHash = keccak256(code);
    required(
      observedHash === identity.runtimeCodeHash,
      `${identity.labels.join("/")} runtime code hash does not match the manifest`,
    );
    observations.push(
      Object.freeze({
        address: identity.address,
        runtimeCodeHash: observedHash,
        codeBytes: (code.length - 2) / 2,
        labels: Object.freeze([...identity.labels]),
      }),
    );
  }

  const snapshotAfter = block(
    await request("eth_getBlockByNumber", [tag, false]),
    "closing deployment snapshot",
  );
  required(
    sameBlock(snapshotBefore, snapshotAfter),
    "deployment snapshot changed during verification",
  );
  const finalizedAfter = block(
    await request("eth_getBlockByNumber", ["finalized", false]),
    "closing finalized block",
  );
  requireFinalityBeyondGenesis(
    finalizedAfter,
    genesis,
    "closing finalized head",
  );
  required(
    finalizedAfter.number >= snapshotBefore.number,
    "deployment snapshot lost finality during verification",
  );
  required(
    finalizedAfter.number !== snapshotAfter.number ||
      finalizedAfter.hash === snapshotAfter.hash,
    "closing finalized head conflicts with the deployment snapshot at the same height",
  );
  required(
    finalizedAfter.number >= finalizedBefore.number,
    "finalized head regressed during verification",
  );
  required(
    finalizedAfter.number !== finalizedBefore.number ||
      finalizedAfter.hash === finalizedBefore.hash,
    "finalized head changed at the same height",
  );

  return Object.freeze({
    schemaVersion: 1,
    domain: "postern.dex.staging-rpc-observation.v1",
    configurationSha256: `0x${sha256(stableJson(config))}`,
    chainId: config.chain.id,
    genesisHash: genesis.hash,
    snapshot: Object.freeze({
      number: Number(snapshotBefore.number),
      hash: snapshotBefore.hash,
    }),
    finalizedBefore: Object.freeze({
      number: Number(finalizedBefore.number),
      hash: finalizedBefore.hash,
    }),
    finalizedAfter: Object.freeze({
      number: Number(finalizedAfter.number),
      hash: finalizedAfter.hash,
    }),
    identities: Object.freeze(observations),
  });
}
