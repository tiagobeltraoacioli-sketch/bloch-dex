// Shared helpers of the DEX operations kit. Nothing here holds a key or sends
// a transaction. Identity comes from the schema-2 gate file written by
// `deploy-dex.mjs record`, so the kit has no second source of addresses.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const viem = requireFromFrontend("viem");
export const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, hashTypedData, recoverAddress, recoverTransactionAddress } = viem;

// Nagios convention, same as deployment/mainnet/l2_monitor.py in bloch-l2-evm.
export const OK = 0;
export const WARN = 1;
export const CRIT = 2;
export const UNKNOWN = 3;
export const LEVEL_NAMES = Object.freeze({ 0: "OK", 1: "WARN", 2: "CRIT", 3: "UNKNOWN" });
const SEVERITY = Object.freeze({ 0: 0, 1: 1, 3: 2, 2: 3 });
export const worst = (levels) => levels.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), OK);

export const READ_ONLY_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_call",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "bloch_finality",
]);

/// A failure of the transport or of the node, as opposed to a refusal by the
/// chain's state. Monitors report it as UNKNOWN, never as a chain fault.
export class RpcError extends Error {}

/// A call the node executed and the EVM reverted.
export class CallReverted extends Error {}

export function createRequest(url, { allowed = READ_ONLY_METHODS, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  let id = 0;
  return async (method, params) => {
    if (!allowed.includes(method)) throw new Error(`refused: ${method} is not on this tool's method list`);
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new RpcError(`${method} at ${url}: ${error.message}`);
    }
    if (body.error) {
      const message = String(body.error.message ?? "error");
      if (body.error.data !== undefined || /revert/i.test(message)) throw new CallReverted(`${method}: ${message}`);
      throw new RpcError(`${method}: ${message}`);
    }
    return body.result;
  };
}

export const ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function reserveCaps() view returns (uint112, uint112)",
  "function totalSupply() view returns (uint256)",
  "function kLast() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allPairsLength() view returns (uint256)",
  "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function pausedUntil() view returns (uint256)",
  "function availableToMint() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function position(address pair, address owner) view returns ((uint256 liquidity, uint256 pendingProtocolLiquidity, uint256 dilutedSupply, uint256 reserveShare0, uint256 reserveShare1))",
  "function skim(address to)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)",
  "function addLiquidityBLCH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
  "function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const encode = (functionName, args = []) => encodeFunctionData({ abi: ABI, functionName, args });

export async function call(request, to, functionName, args, at) {
  const data = await request("eth_call", [{ to, data: encode(functionName, args) }, at]);
  if (typeof data !== "string" || data === "0x") throw new CallReverted(`${functionName} returned no data from ${to}`);
  return decodeFunctionResult({ abi: ABI, functionName, data });
}

export const blockRef = (block) => ({ blockHash: block.hash, requireCanonical: true });

/// Read a block by tag or null. The settled RPC returns null for `finalized`
/// and `safe` until they exist.
export async function readBlock(request, tag) {
  const block = await request("eth_getBlockByNumber", [tag, false]);
  if (!block) return null;
  return { number: BigInt(block.number), hash: block.hash, timestamp: BigInt(block.timestamp), baseFee: block.baseFeePerGas == null ? 0n : BigInt(block.baseFeePerGas) };
}

/// The deployment as the kit uses it, from a schema-2 gate file.
export function deploymentFromGate(gate) {
  if (gate?.schemaVersion !== 2) throw new Error("the kit reads the schema-2 gate file written by deploy-dex.mjs record");
  const d = gate.deployment;
  const capOf = new Map(d.reserveCaps.map(({ token, cap }) => [token, BigInt(cap)]));
  return Object.freeze({
    chainId: gate.chain.id,
    genesisHash: gate.chain.genesisHash,
    factory: d.contracts.factory,
    router: d.contracts.router,
    lens: d.contracts.lens,
    wrapped: d.contracts.wrappedNative,
    pairInitCodeHash: d.pairInitCodeHash,
    feeTo: d.feeTo,
    firstDepositor: d.firstDepositor,
    safe: d.roles.blochInc,
    tokens: d.tokens,
    pairs: d.pairs,
    capOf,
  });
}

export function readGate(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/// Refuse a node that is not the pinned chain. Returns the genesis block hash.
export async function checkIdentity(request, deployment) {
  const chainId = BigInt(await request("eth_chainId", []));
  if (chainId !== BigInt(deployment.chainId)) throw new IdentityError(`chain ID ${chainId} is not ${deployment.chainId}`);
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  if (genesis?.hash !== deployment.genesisHash) throw new IdentityError(`genesis ${genesis?.hash} is not ${deployment.genesisHash}`);
}

export class IdentityError extends Error {}

export async function codeHash(request, address, at) {
  const code = await request("eth_getCode", [address, at]);
  return typeof code === "string" && code.length > 2 ? keccak256(code) : null;
}

/// One pair at one block. `side` values are in the sorted token0/token1 order.
export async function readPair(request, pair, at) {
  const [reserve0, reserve1] = await call(request, pair.address, "getReserves", [], at);
  const [cap0, cap1] = await call(request, pair.address, "reserveCaps", [], at);
  const [balance0, balance1, totalSupply, kLast, lpInPair] = await Promise.all([
    call(request, pair.token0, "balanceOf", [pair.address], at),
    call(request, pair.token1, "balanceOf", [pair.address], at),
    call(request, pair.address, "totalSupply", [], at),
    call(request, pair.address, "kLast", [], at),
    call(request, pair.address, "balanceOf", [pair.address], at),
  ]);
  return {
    totalSupply,
    kLast,
    lpInPair,
    sides: [
      { token: pair.token0, reserve: reserve0, balance: balance0, cap: cap0 },
      { token: pair.token1, reserve: reserve1, balance: balance1, cap: cap1 },
    ],
  };
}

export const DEFAULT_EXCESS_FLOOR_BPS = 100n;

/// The excess floor of a side: below it a donation is dust. The next swap on
/// that side absorbs dust as input, and it costs a griefer almost nothing to
/// create, so neither the monitor nor the keeper reacts to it.
export function excessFloor(side, floorBps = DEFAULT_EXCESS_FLOOR_BPS) {
  if (side.cap === 0n) return (side.reserve * floorBps) / 10_000n || 1n;
  return (side.cap * floorBps) / 10_000n || 1n;
}

/// Effect of `balance - reserve` on this side (DEX-02):
///   none      no excess
///   negative  balance below reserve; impossible for the pinned tokens
///   dust      below the floor
///   material  at or above the floor; it reduces the side's cap headroom
///   blocking  at or above the floor and balance >= cap: mints and swaps into
///             this side revert RESERVE_CAP, and so do swaps out of it that
///             take less than `balance - max(cap, reserve)`
export function classifyExcess(side, floorBps = DEFAULT_EXCESS_FLOOR_BPS) {
  if (side.balance < side.reserve) return "negative";
  const excess = side.balance - side.reserve;
  if (excess === 0n) return "none";
  if (excess < excessFloor(side, floorBps)) return "dust";
  return side.cap !== 0n && side.balance >= side.cap ? "blocking" : "material";
}

/// True when neither mint nor swap can ever change the pair again: both
/// reserves sit exactly at their caps with no LP shares in existence (DEX-09,
/// docs/OPS-INITIAL-LIQUIDITY.md).
export function isBricked(state) {
  return state.totalSupply === 0n && state.sides.every((s) => s.cap !== 0n && s.reserve >= s.cap);
}

/// LP shares exist and both reserves are within 0.1% of their caps: no swap of a
/// useful size passes in either direction (review finding F1).
export function isClosed(state) {
  return state.totalSupply !== 0n && state.sides.every((s) => s.cap !== 0n && s.reserve * 1000n >= s.cap * 999n);
}

/// Unrecorded balance fills the room on both capped sides, so no swap passes in
/// either direction until someone skims (limit L3 of the k ceiling).
export function isClosedByExcess(state) {
  return state.sides.every((s) => s.cap !== 0n && s.balance >= s.cap) && state.sides.some((s) => s.balance > s.reserve);
}

/// Parse a decimal string into base units. Refuses precision it would lose.
export function parseUnits(text, decimals) {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(String(text));
  if (!match) throw new Error(`not a decimal number: ${text}`);
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`${text} has more than ${decimals} decimals`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatUnits(value, decimals) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/// Integer square root (the pair's Math.sqrt rounds down the same way).
export function isqrt(value) {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/// Minimal `--name value` / repeated / boolean flag parser. Everything after a
/// bare `--` is returned untouched (the signer arguments for `cast mktx`).
export function parseArgs(argv, { flags = [], repeat = [] } = {}) {
  const out = { _: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.includes(name)) {
      out[name] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
    if (repeat.includes(name)) (out[name] ??= []).push(argv[++i]);
    else out[name] = argv[++i];
  }
  return out;
}
