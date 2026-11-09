// Shared helpers of the DEX operations kit. Nothing here holds a key or sends
// a transaction. Identity comes from the schema-2 gate file written by
// `deploy-dex.mjs record`, so the kit has no second source of addresses.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createRpcTransport, JsonRpcResponseError } from "../staging/rpc-transport.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const viem = requireFromFrontend("viem");
export const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, hashTypedData, parseTransaction, recoverAddress, recoverTransactionAddress } = viem;

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
  "eth_getTransactionByHash",
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
  const methods = new Set(allowed);
  const request = createRpcTransport(url, { fetchImpl, timeoutMs });
  return async (method, params) => {
    if (!methods.has(method)) throw new Error(`refused: ${method} is not on this tool's method list`);
    try {
      return await request(method, params);
    } catch (error) {
      if (error instanceof JsonRpcResponseError && (error.rpcError.code === 3 || /revert/i.test(error.rpcError.message))) {
        throw new CallReverted(error.message, { cause: error });
      }
      throw new RpcError(error.message, { cause: error });
    }
  };
}

export const ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function reserveCaps() view returns (uint112, uint112)",
  "function feeTo() view returns (address)",
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
  "function pendingSupply() view returns (uint256)",
  "function nextSlot() view returns (uint64)",
  "function mintCount() view returns (uint64)",
  "function verifier() view returns (address)",
  "function mintHead() view returns (bytes32)",
  "function provenanceMode() view returns (uint8)",
  "function depositCount() view returns (uint64)",
  "function chainHeadAt(uint64) view returns (bytes32)",
  "function releasesEnabled() view returns (bool)",
  "function position(address pair, address owner) view returns ((uint256 liquidity, uint256 pendingProtocolLiquidity, uint256 dilutedSupply, uint256 reserveShare0, uint256 reserveShare1))",
  "function skim(address to)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function deposit() payable",
  "function sync()",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256)",
  "function addLiquidityBLCH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)",
  "function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

/// Whether bUSDC exits to Ethereum are held or paused (agent 139 finding 1), read as the bridge's reservas
/// monitor and bridge page read it: BridgedStablecoinV3 mintHead()/mintCount() on the L2 against the
/// ProvenanceSourceVault's chainHeadAt(mintCount) on Ethereum, at both finalized blocks and at both latest
/// blocks, plus the vault's pause and releasesEnabled at latest. A difference means a credited mint with no deposit:
/// the vault refuses every burn made from then on, including bUSDC an LP takes out of a pool. Read errors throw
/// (the caller reports UNKNOWN); nothing here can report "normal" on a failed read.
export async function readBridgeExit(ethRequest, l2Request, { vault, token, vaultCodeHash }, l2Finalized) {
  const ethFinal = await readBlock(ethRequest, "finalized");
  if (!ethFinal) throw new RpcError("Ethereum serves no finalized block");
  if (vaultCodeHash) {
    const observed = await codeHash(ethRequest, vault, blockRef(ethFinal));
    if (observed !== vaultCodeHash.toLowerCase()) throw new CallReverted(`vault ${vault} code ${observed} differs from the pin`);
  }
  const side = async (ethAt, l2At) => {
    const [mintCount, mintHead, depositCount, mode] = await Promise.all([
      call(l2Request, token, "mintCount", [], l2At),
      call(l2Request, token, "mintHead", [], l2At),
      call(ethRequest, vault, "depositCount", [], ethAt),
      call(ethRequest, vault, "provenanceMode", [], ethAt),
    ]);
    if (Number(mode) !== 1) throw new CallReverted("the vault is not in mint-chain mode (provenanceMode != 1)");
    const vaultHead = mintCount > depositCount ? null : (await call(ethRequest, vault, "chainHeadAt", [mintCount], ethAt)).toLowerCase();
    return { mintCount, depositCount, mintHead: mintHead.toLowerCase(), vaultHead, clean: vaultHead === null ? null : vaultHead === mintHead.toLowerCase() };
  };
  const [final, latest] = await Promise.all([side(blockRef(ethFinal), blockRef(l2Finalized)), side("latest", "latest")]);
  const [paused, pausedUntil, releasesEnabled] = await Promise.all([
    call(ethRequest, vault, "paused", [], "latest"),
    call(ethRequest, vault, "pausedUntil", [], "latest"),
    call(ethRequest, vault, "releasesEnabled", [], "latest"),
  ]);
  // A finalized credit beyond every deposit the vault has even at latest has no deposit at all (reservas: held).
  const heldFinal = final.clean === false || (final.clean === null && final.mintCount > latest.depositCount);
  const heldLatest = latest.clean !== true;
  const state = heldFinal || heldLatest ? "held" : paused || !releasesEnabled ? "paused" : "normal";
  return { state, heldFinal, heldLatest, final, latest, paused, pausedUntil, releasesEnabled, ethFinalized: ethFinal.number };
}

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
    depositorTransactions: d.depositorTransactions ?? [],
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

/// Would a swap of 0.1% of the input side's cap pass the pair's cap check?
/// The same check as UniswapV2Pair._update: a balance may end above its cap only
/// if it is not above the reserve. Excess counts, on the output side too: it must
/// be paid down by the output, so a small swap out of an overfull side reverts.
function smallSwapFits(into, outOf) {
  if (into.cap === 0n || into.reserve === 0n || outOf.reserve === 0n) return true;
  const input = into.cap / 1000n || 1n;
  const output = (input * 997n * outOf.reserve) / (into.reserve * 1000n + input * 997n);
  const bound = (side) => (side.cap === 0n ? null : side.cap > side.reserve ? side.cap : side.reserve);
  const within = (balance, side) => bound(side) === null || balance <= bound(side);
  return within(into.balance + input, into) && within(outOf.balance - output, outOf);
}

/// The pool's k is within one reserve of the 64% ceiling: the contract's K_CEILING_BPS. Swap
/// fees stay outside the reserves there, so LPs and the protocol fee earn nothing from them
/// and anyone can take them with skim (limit L2 of the k ceiling).
export function isAtKCeiling(state) {
  const [a, b] = state.sides;
  if (a.cap === 0n || b.cap === 0n) return false;
  const margin = a.reserve > b.reserve ? a.reserve : b.reserve;
  return a.reserve * b.reserve + margin > (a.cap * b.cap * 6400n) / 10_000n;
}

/// Unrecorded balance stops swaps of a useful size in both directions until someone
/// skims (limit L3 of the k ceiling). A much larger swap can still pass when its output
/// pays the excess down. The real closure with 200 bUSDC + 2 WBLCH looked like this:
/// only one side was above its cap, and both directions reverted.
export function isClosedByExcess(state) {
  const [a, b] = state.sides;
  return state.sides.some((s) => s.balance > s.reserve) && !smallSwapFits(a, b) && !smallSwapFits(b, a);
}

/// What a closure stops. Swaps into a full side revert at any size. A swap out of an overfull
/// side passes if its output pays down that side's balance above max(cap, reserve), which is
/// `minOutput`; zero on every side means both balances are at their caps and nothing passes.
/// `hard` means an excess at or above the floor, so the griefer has the floor at stake and
/// ordinary swaps stop. A soft closure stops only swaps below the floor, costs about 1 USD
/// when a side already sits at its cap, and must not cost the keeper as if it were hard.
export function closureOf(state, floorBps = DEFAULT_EXCESS_FLOOR_BPS) {
  if (!isClosedByExcess(state)) return null;
  const over = state.sides.map((s) => {
    const bound = s.cap === 0n ? s.balance : s.cap > s.reserve ? s.cap : s.reserve;
    return s.balance > bound ? s.balance - bound : 0n;
  });
  const hard = state.sides.some((s) => s.balance - s.reserve >= excessFloor(s, floorBps));
  return { hard, minOutput: over, tokens: state.sides.map((s) => s.token) };
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
