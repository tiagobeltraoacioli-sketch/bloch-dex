import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, readdir, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MAX_PILOT_BLCH_BASE_UNITS = 10n * 10n ** 18n;
const MAX_PILOT_BUSDC_BASE_UNITS = 10n * 10n ** 6n;
const CAP_APPROVAL_PATH = /^approvals\/[a-z0-9][a-z0-9._-]{0,95}\.json$/;
const CAP_APPROVAL_MAX_BYTES = 8 * 1024;
const CONTRACT_NAMES = [
  "factory",
  "router",
  "lens",
  "collector",
  "wrappedNative",
];
const ROLE_NAMES = ["feeAuthority", "treasury"];

function required(condition, message) {
  if (!condition) throw new Error(`staging preflight: ${message}`);
}

function exactKeys(value, keys, field) {
  required(
    value && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${field} fields are invalid`,
  );
}

function validateHash(value, field) {
  required(
    typeof value === "string" && HASH.test(value),
    `${field} must be a 32-byte hex hash`,
  );
  required(!/^0x0{64}$/.test(value), `${field} must not be zero`);
}

function validateContract(value, field, contractOnly = true) {
  if (contractOnly) exactKeys(value, ["address", "runtimeCodeHash"], field);
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
  exactKeys(value, ["address", "runtimeCodeHash", "symbol", "name", "decimals",
    "wrappedNative", "policy"], field);
  validateContract(value, field, false);
  required(
    typeof value.symbol === "string" &&
      (/^[A-Z0-9]{2,12}$/.test(value.symbol) || value.symbol === "bUSDC"),
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
  exactKeys(value.policy, ["feeOnTransfer", "rebasing"], `${field}.policy`);
  required(
    value.policy.feeOnTransfer === false && value.policy.rebasing === false,
    `${field} uses an unsupported transfer policy`,
  );
}

function canonicalBaseUnits(value, maximum, field) {
  required(
    typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    `${field} must be a canonical positive base-unit integer`,
  );
  required(BigInt(value) <= maximum, `${field} exceeds the pilot safety cap`);
}

function validateAssetPlan(config) {
  const plan = config.assetPlan;
  exactKeys(plan, ["blochL1", "bridgeAsset", "pilotPool"], "assetPlan");
  exactKeys(plan.blochL1,
    ["nativeSymbol", "evmExecution", "authorizationBoundary"],
    "assetPlan.blochL1");
  required(plan.blochL1.nativeSymbol === "BLCH", "Bloch L1 native asset must be BLCH");
  required(plan.blochL1.evmExecution === false,
    "Bloch L1 must not be represented as the EVM execution environment");
  required(plan.blochL1.authorizationBoundary === "external-post-quantum",
    "Bloch L1 authorization must remain an external post-quantum boundary");

  exactKeys(plan.bridgeAsset, ["sourceChain", "sourceChainId", "sourceSymbol",
    "sourceTokenAddress", "destinationSymbol", "destinationTokenAddress"],
  "assetPlan.bridgeAsset");
  required(plan.bridgeAsset.sourceChain === "ethereum-mainnet" &&
      plan.bridgeAsset.sourceChainId === 1 && plan.bridgeAsset.sourceSymbol === "USDC" &&
      plan.bridgeAsset.sourceTokenAddress === ETHEREUM_USDC &&
      plan.bridgeAsset.destinationSymbol === "bUSDC" &&
      ADDRESS.test(plan.bridgeAsset.destinationTokenAddress),
  "bridge asset must pin Ethereum mainnet USDC and a canonical bUSDC address");

  exactKeys(plan.pilotPool, ["baseSymbol", "onchainBaseSymbol", "quoteSymbol",
    "liquidityEnabled", "maxBaseBaseUnits", "maxQuoteBaseUnits",
    "policyCapApproval", "requiresSeparateApproval"], "assetPlan.pilotPool");
  required(plan.pilotPool.baseSymbol === "BLCH" &&
      plan.pilotPool.onchainBaseSymbol === "WBLCH" &&
      plan.pilotPool.quoteSymbol === "bUSDC",
  "pilot pool must be the BLCH/bUSDC intent represented on-chain as WBLCH/bUSDC");
  required(plan.pilotPool.liquidityEnabled === false,
    "pilot pool liquidity must remain disabled");
  required(plan.pilotPool.requiresSeparateApproval === true,
    "pilot pool must require separate liquidity approval");
  canonicalBaseUnits(plan.pilotPool.maxBaseBaseUnits,
    MAX_PILOT_BLCH_BASE_UNITS, "assetPlan.pilotPool.maxBaseBaseUnits");
  canonicalBaseUnits(plan.pilotPool.maxQuoteBaseUnits,
    MAX_PILOT_BUSDC_BASE_UNITS, "assetPlan.pilotPool.maxQuoteBaseUnits");
  exactKeys(plan.pilotPool.policyCapApproval, ["path", "sha256"],
    "assetPlan.pilotPool.policyCapApproval");
  required(typeof plan.pilotPool.policyCapApproval.path === "string" &&
      CAP_APPROVAL_PATH.test(plan.pilotPool.policyCapApproval.path),
  "assetPlan.pilotPool.policyCapApproval.path is invalid");
  validateHash(plan.pilotPool.policyCapApproval.sha256,
    "assetPlan.pilotPool.policyCapApproval.sha256");
}

export function validateStagingConfig(config) {
  required(
    config && typeof config === "object" && !Array.isArray(config),
    "configuration must be an object",
  );
  exactKeys(config, ["schemaVersion", "environment", "host", "frontendMode",
    "liquidityEnabled", "chain", "deployment", "tokens", "assetPlan"],
  "configuration");
  required(config.schemaVersion === 4, "schemaVersion must equal 4");
  required(config.environment === "staging", "environment must equal staging");
  required(config.host === "bloch-dex", "host must equal bloch-dex");
  required(
    config.frontendMode === "preview",
    "frontendMode must remain preview",
  );
  required(config.liquidityEnabled === false, "liquidity must remain disabled");

  const chain = config.chain;
  exactKeys(chain, ["id", "genesisHash", "rpcUrl"], "chain");
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
  exactKeys(deployment, ["blockNumber", "blockHash", "pairInitCodeHash",
    ...CONTRACT_NAMES, ...ROLE_NAMES], "deployment");
  required(
    Number.isSafeInteger(deployment.blockNumber) && deployment.blockNumber >= 0,
    "deployment.blockNumber must be a nonnegative safe integer",
  );
  validateHash(deployment.blockHash, "deployment.blockHash");
  validateHash(deployment.pairInitCodeHash, "deployment.pairInitCodeHash");
  for (const name of CONTRACT_NAMES)
    validateContract(deployment[name], `deployment.${name}`);
  for (const name of ROLE_NAMES)
    validateContract(deployment[name], `deployment.${name}`);

  const addresses = [...CONTRACT_NAMES, ...ROLE_NAMES].map((name) =>
    deployment[name].address.toLowerCase(),
  );
  required(
    new Set(addresses).size === addresses.length,
    "deployment and custody addresses must be unique",
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
    ["factory", "router", "lens", "collector", ...ROLE_NAMES].map((name) =>
      deployment[name].address.toLowerCase(),
    ),
  );
  required(
    tokenAddresses.every((address) => !reserved.has(address)),
    "token address collides with deployment infrastructure",
  );
  validateAssetPlan(config);
  const wrappedToken = config.tokens.find((token) => token.symbol === "WBLCH");
  const bridgeToken = config.tokens.find((token) => token.symbol === "bUSDC");
  required(wrappedToken === wrapped[0] && wrappedToken.decimals === 18,
    "asset plan requires the 18-decimal wrapped-native token symbol WBLCH");
  required(bridgeToken && bridgeToken.decimals === 6 && !bridgeToken.wrappedNative &&
      bridgeToken.address === config.assetPlan.bridgeAsset.destinationTokenAddress,
  "asset plan bUSDC identity must match the reviewed 6-decimal token");
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
  const config = validateStagingConfig(parsed);
  await verifyCapApproval(config, resolve(path));
  return config;
}

async function verifyCapApproval(config, configPath) {
  const reference = config.assetPlan.pilotPool.policyCapApproval;
  const approvalPath = join(dirname(configPath), reference.path);
  let before;
  try { before = await lstat(approvalPath, { bigint: true }); }
  catch (error) { throw new Error(`staging preflight: cannot read cap approval: ${error.message}`); }
  required(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n &&
      before.size > 0n && before.size <= BigInt(CAP_APPROVAL_MAX_BYTES) &&
      Number(before.mode & 0o022n) === 0,
  "cap approval artifact is unsafe");
  const handle = await open(approvalPath, constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
    required(opened.isFile() && !opened.isSymbolicLink() && opened.nlink === 1n &&
        opened.size > 0n && opened.size <= BigInt(CAP_APPROVAL_MAX_BYTES) &&
        Number(opened.mode & 0o022n) === 0 &&
        fields.every((field) => before[field] === opened[field]),
    "cap approval artifact changed before reading");
    const bounded = Buffer.alloc(CAP_APPROVAL_MAX_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded, offset, bounded.length - offset, null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    required(offset <= CAP_APPROVAL_MAX_BYTES, "cap approval artifact is unsafe");
    bytes = bounded.subarray(0, offset);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(approvalPath, { bigint: true });
    required(fields.every((field) => before[field] === opened[field] &&
        opened[field] === after[field] && after[field] === named[field]) &&
        bytes.length === Number(after.size),
    "cap approval artifact changed while reading");
  } finally { await handle.close(); }
  required(`0x${sha256(bytes)}` === reference.sha256,
    "cap approval artifact does not match its pinned hash");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("staging preflight: cap approval artifact is invalid JSON"); }
  exactKeys(envelope, ["schemaVersion", "domain", "chainId", "genesisHash",
    "factoryAddress", "feeAuthorityAddress", "treasuryAddress",
    "wrappedNativeAddress", "bridgeAssetAddress", "maxBaseBaseUnits",
    "maxQuoteBaseUnits"], "cap approval envelope");
  required(bytes.equals(Buffer.from(`${stableJson(envelope)}\n`, "utf8")),
    "cap approval envelope is not canonical JSON");
  const expected = {
    schemaVersion: 2,
    domain: "postern.dex.pilot-cap-approval.v2",
    chainId: config.chain.id,
    genesisHash: config.chain.genesisHash,
    factoryAddress: config.deployment.factory.address,
    feeAuthorityAddress: config.deployment.feeAuthority.address,
    treasuryAddress: config.deployment.treasury.address,
    wrappedNativeAddress: config.deployment.wrappedNative.address,
    bridgeAssetAddress: config.assetPlan.bridgeAsset.destinationTokenAddress,
    maxBaseBaseUnits: config.assetPlan.pilotPool.maxBaseBaseUnits,
    maxQuoteBaseUnits: config.assetPlan.pilotPool.maxQuoteBaseUnits,
  };
  required(stableJson(envelope) === stableJson(expected),
    "cap approval envelope does not bind the reviewed pilot policy");
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
