import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACT_NAMES = [
  "factory",
  "router",
  "lens",
  "collector",
  "wrappedNative",
];

function required(condition, message) {
  if (!condition) throw new Error(`staging preflight: ${message}`);
}

function validateHash(value, field) {
  required(
    typeof value === "string" && HASH.test(value),
    `${field} must be a 32-byte hex hash`,
  );
  required(!/^0x0{64}$/.test(value), `${field} must not be zero`);
}

function validateContract(value, field) {
  required(
    value && typeof value === "object" && !Array.isArray(value),
    `${field} is required`,
  );
  required(
    typeof value.address === "string" && ADDRESS.test(value.address),
    `${field}.address is invalid`,
  );
  required(
    !/^0x0{40}$/.test(value.address),
    `${field}.address must not be zero`,
  );
  validateHash(value.runtimeCodeHash, `${field}.runtimeCodeHash`);
}

function validateToken(value, index) {
  const field = `tokens[${index}]`;
  validateContract(value, field);
  required(
    typeof value.symbol === "string" && /^[A-Z0-9]{2,12}$/.test(value.symbol),
    `${field}.symbol is invalid`,
  );
  required(
    typeof value.name === "string" &&
      /^[A-Za-z0-9 ._-]{1,48}$/.test(value.name),
    `${field}.name is invalid`,
  );
  required(
    Number.isSafeInteger(value.decimals) &&
      value.decimals >= 0 &&
      value.decimals <= 36,
    `${field}.decimals is invalid`,
  );
  required(
    typeof value.wrappedNative === "boolean",
    `${field}.wrappedNative is required`,
  );
  required(
    value.policy &&
      typeof value.policy === "object" &&
      !Array.isArray(value.policy),
    `${field}.policy is required`,
  );
  required(
    value.policy.feeOnTransfer === false && value.policy.rebasing === false,
    `${field} uses an unsupported transfer policy`,
  );
}

export function validateStagingConfig(config) {
  required(
    config && typeof config === "object" && !Array.isArray(config),
    "configuration must be an object",
  );
  required(config.schemaVersion === 2, "schemaVersion must equal 2");
  required(config.environment === "staging", "environment must equal staging");
  required(config.host === "bloch-dex", "host must equal bloch-dex");
  required(
    config.frontendMode === "preview",
    "frontendMode must remain preview",
  );
  required(config.liquidityEnabled === false, "liquidity must remain disabled");

  const chain = config.chain;
  required(
    chain && typeof chain === "object" && !Array.isArray(chain),
    "chain is required",
  );
  required(
    Number.isSafeInteger(chain.id) && chain.id > 0,
    "chain.id must be a positive safe integer",
  );
  validateHash(chain.genesisHash, "chain.genesisHash");
  required(
    typeof chain.rpcUrl === "string" && chain.rpcUrl.length > 0,
    "chain.rpcUrl is required",
  );
  let rpc;
  try {
    rpc = new URL(chain.rpcUrl);
  } catch {
    throw new Error("staging preflight: chain.rpcUrl is invalid");
  }
  required(rpc.protocol === "https:", "chain.rpcUrl must use HTTPS");
  required(
    !rpc.username &&
      !rpc.password &&
      !rpc.search &&
      !rpc.hash &&
      (rpc.pathname === "/" || rpc.pathname === ""),
    "chain.rpcUrl must be a credential-free public origin",
  );

  const deployment = config.deployment;
  required(
    deployment && typeof deployment === "object" && !Array.isArray(deployment),
    "deployment is required",
  );
  required(
    Number.isSafeInteger(deployment.blockNumber) && deployment.blockNumber >= 0,
    "deployment.blockNumber must be a nonnegative safe integer",
  );
  validateHash(deployment.blockHash, "deployment.blockHash");
  validateHash(deployment.pairInitCodeHash, "deployment.pairInitCodeHash");
  for (const name of CONTRACT_NAMES)
    validateContract(deployment[name], `deployment.${name}`);

  const addresses = CONTRACT_NAMES.map((name) =>
    deployment[name].address.toLowerCase(),
  );
  required(
    new Set(addresses).size === addresses.length,
    "contract addresses must be unique",
  );
  required(
    Array.isArray(config.tokens) &&
      config.tokens.length >= 2 &&
      config.tokens.length <= 64,
    "tokens must contain between 2 and 64 reviewed assets",
  );
  config.tokens.forEach(validateToken);
  const tokenAddresses = config.tokens.map((token) =>
    token.address.toLowerCase(),
  );
  required(
    new Set(tokenAddresses).size === tokenAddresses.length,
    "token addresses must be unique",
  );
  const wrapped = config.tokens.filter((token) => token.wrappedNative);
  required(
    wrapped.length === 1 &&
      wrapped[0].address.toLowerCase() ===
        deployment.wrappedNative.address.toLowerCase() &&
      wrapped[0].runtimeCodeHash.toLowerCase() ===
        deployment.wrappedNative.runtimeCodeHash.toLowerCase(),
    "wrapped-native token identity must match the deployment",
  );
  const reserved = new Set(
    ["factory", "router", "lens", "collector"].map((name) =>
      deployment[name].address.toLowerCase(),
    ),
  );
  required(
    tokenAddresses.every((address) => !reserved.has(address)),
    "token address collides with deployment infrastructure",
  );
  return config;
}

export async function readAndValidateConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `staging preflight: cannot read configuration: ${error.message}`,
    );
  }
  return validateStagingConfig(parsed);
}

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

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashDirectory(root) {
  const absoluteRoot = resolve(root);
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      required(
        !info.isSymbolicLink(),
        `artifact contains symlink ${relative(absoluteRoot, path)}`,
      );
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        output.push({
          path: relative(absoluteRoot, path).split(sep).join("/"),
          bytes: info.size,
          sha256: sha256(await readFile(path)),
        });
      } else {
        throw new Error(
          `staging preflight: unsupported artifact entry ${relative(absoluteRoot, path)}`,
        );
      }
    }
  }
  await visit(absoluteRoot);
  required(output.length > 0, "frontend artifact is empty");
  return output;
}
