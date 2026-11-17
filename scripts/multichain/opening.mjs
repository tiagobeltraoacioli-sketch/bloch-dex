// Who opened a pool, and at which amounts (docs/MULTICHAIN-DEPLOY.md, "Opening a pool"). Read-only helpers shared
// by gate.mjs and first-deposit.mjs.
//
// Review R328-1: the pair accepts a first mint whose transaction ORIGIN is the factory's first depositor, whoever
// the sender is. "The pool is open" therefore does not prove "the owner opened it at the owner's price": a
// contract called by the depositing account could have opened it. What does prove it is the opening transaction
// itself, and a pair has exactly one: the first mint is the only one that locks MINIMUM_LIQUIDITY (the pair emits
// Transfer(0x0 -> 0x0, 1000) then, and never again, because the share supply never returns to zero). An opening is
// PROVEN when that transaction
//   - succeeded and is canonical (its block is the chain's block at that height, on every endpoint asked),
//   - was sent BY the first depositor TO the router (the account's own transaction, straight to the router: no
//     other contract in between),
//   - is addLiquidityBLCH for the pair's listed token with minimums equal to its amounts (the call
//     first-deposit.mjs prints; it has no other form),
//   - and carries the pair's lock log and one Mint log.
// The Mint log gives the amounts that joined the pool at its opening. They are the deposit plus anything that sat
// at the pair's address before it (a "gift": tokens someone sent there; the router does not look at them, review
// R328-2). The gift belongs to the pool, so to the depositor's shares; it shifts the opening price by its size.
import { createRequire } from "node:module";
import { lower } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { decodeFunctionData, parseAbi, toEventSelector } = requireFromFrontend("viem");

export const ROUTER_DEPOSIT_ABI = parseAbi([
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
]);
export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
export const MINT_TOPIC = toEventSelector("Mint(address,uint256,uint256)");
/** UniswapV2Pair.MINIMUM_LIQUIDITY: locked at address(0) by the first mint only. */
export const LOCKED_SHARES = 1000n;
const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const topicOf = (address) => `0x${"0".repeat(24)}${lower(address).slice(2)}`;
const HASH = /^0x[0-9a-f]{64}$/;

/** The decoded router deposit of a transaction input, or null. `strict`: minimums equal to the amounts. */
export function decodeDeposit(input, value) {
  try {
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_DEPOSIT_ABI, data: input });
    if (functionName !== "addLiquidityBLCH") return null;
    const native = BigInt(value);
    return { token: args[0], tokenAmount: args[1], native, to: args[4], deadline: args[5], strict: args[2] === args[1] && args[3] === native };
  } catch {
    return null;
  }
}

/**
 * What a transaction and its receipt prove about the opening of `pair`. Pure.
 * `wrappedIs0`: the wrapped native token is the pair's token0. Amounts are base units (bigint).
 * Returns { proven, problems, transaction, blockNumber, blockHash, by, sharesTo, deposited, joined, gift }.
 */
export function openingFromReceipt({ tx, receipt, pair, router, depositor, token, wrappedIs0 }) {
  const problems = [];
  const out = { proven: false, problems, transaction: tx?.hash ?? null };
  if (!tx || !receipt) {
    problems.push("the transaction or its receipt was not found");
    return out;
  }
  out.blockNumber = Number(BigInt(receipt.blockNumber));
  out.blockHash = receipt.blockHash;
  out.by = tx.from;
  if (receipt.status !== "0x1") problems.push("the transaction did not succeed");
  if (lower(tx.from ?? "") !== lower(depositor)) problems.push(`it was sent by ${tx.from}, not by the first depositor ${depositor}`);
  if (lower(tx.to ?? "") !== lower(router)) problems.push(`it was sent to ${tx.to}, not to the router ${router}: the pool was opened through another contract`);
  const deposit = decodeDeposit(tx.input ?? "0x", tx.value ?? "0x0");
  if (!deposit) problems.push("it is not the router's addLiquidityBLCH");
  else {
    if (lower(deposit.token) !== lower(token)) problems.push(`it deposits the token ${deposit.token}, not ${token}`);
    if (!deposit.strict) problems.push("its minimums are not equal to its amounts");
    out.sharesTo = deposit.to;
    out.deposited = { native: deposit.native, token: deposit.tokenAmount };
  }
  const logs = (receipt.logs ?? []).filter((log) => lower(log.address ?? "") === lower(pair));
  const lock = logs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC && log.topics[1] === ZERO_TOPIC && log.topics[2] === ZERO_TOPIC && HASH.test(log.data ?? "") && BigInt(log.data) === LOCKED_SHARES);
  if (lock.length !== 1) problems.push("it is not the pair's first mint (no lock of the minimum liquidity in its logs)");
  const mints = logs.filter((log) => log.topics?.[0] === MINT_TOPIC);
  if (mints.length !== 1 || mints[0].topics[1] !== topicOf(router) || !/^0x[0-9a-f]{128}$/.test(mints[0].data ?? "")) problems.push("its logs do not hold exactly one Mint of the pair, made by the router");
  else {
    const [amount0, amount1] = [BigInt(mints[0].data.slice(0, 66)), BigInt(`0x${mints[0].data.slice(66)}`)];
    out.joined = wrappedIs0 ? { native: amount0, token: amount1 } : { native: amount1, token: amount0 };
    if (out.deposited) {
      if (out.joined.native < out.deposited.native || out.joined.token < out.deposited.token) problems.push("less joined the pool than the transaction deposited");
      else out.gift = { native: out.joined.native - out.deposited.native, token: out.joined.token - out.deposited.token };
    }
  }
  out.proven = problems.length === 0;
  return out;
}

/**
 * Read a transaction and prove the opening against the chain. `request` is one endpoint's JSON-RPC, `others`
 * further endpoints that must have the same block at the transaction's height. `finalizedNumber` (optional): the
 * transaction must not be above it.
 */
export async function readOpening({ request, others = [], hash, finalizedNumber = null, ...facts }) {
  if (typeof hash !== "string" || !HASH.test(hash)) return { proven: false, problems: ["the opening transaction hash is not 0x and 64 lowercase hex digits"], transaction: hash ?? null };
  const soft = (work) => work.then((value) => value, () => null);
  const tx = await soft(request("eth_getTransactionByHash", [hash]));
  const receipt = await soft(request("eth_getTransactionReceipt", [hash]));
  const out = openingFromReceipt({ tx, receipt, ...facts });
  if (!tx || !receipt) return out;
  if (lower(receipt.transactionHash ?? "") !== hash || lower(tx.hash ?? "") !== hash) out.problems.push("the endpoint answered with another transaction");
  const block = await soft(request("eth_getBlockByNumber", [receipt.blockNumber, false]));
  if (block?.hash !== receipt.blockHash) out.problems.push("the transaction's block is not the chain's block at that height");
  // Review R369-2: the transaction and its receipt are not one endpoint's word. Every other endpoint must have the
  // same block at that height; and at least one other endpoint (when any is given) must serve the same transaction
  // and the same receipt (inclusion, status, sender, target, input, value, logs). One that does not have them yet
  // is not counted; one that serves different ones fails the proof.
  const txFields = (t) => JSON.stringify([lower(t?.hash ?? ""), lower(t?.from ?? ""), lower(t?.to ?? ""), lower(t?.input ?? ""), String(t?.value ?? ""), String(t?.blockHash ?? ""), String(t?.blockNumber ?? "")]);
  const receiptFields = (r) => JSON.stringify([lower(r?.transactionHash ?? ""), String(r?.blockHash ?? ""), String(r?.blockNumber ?? ""), String(r?.status ?? ""), lower(r?.from ?? ""), lower(r?.to ?? ""), (r?.logs ?? []).map((l) => [lower(l.address ?? ""), (l.topics ?? []).map(lower), lower(l.data ?? ""), String(l.logIndex ?? "")])]);
  let confirmed = 0;
  for (const other of others) {
    const same = await soft(other("eth_getBlockByNumber", [receipt.blockNumber, false]));
    if (same?.hash !== receipt.blockHash) out.problems.push("another endpoint has a different block at the transaction's height");
    const [otherTx, otherReceipt] = [await soft(other("eth_getTransactionByHash", [hash])), await soft(other("eth_getTransactionReceipt", [hash]))];
    if (!otherTx || !otherReceipt) continue;
    if (txFields(otherTx) !== txFields(tx) || receiptFields(otherReceipt) !== receiptFields(receipt)) out.problems.push("another endpoint serves a different transaction or receipt under this hash");
    else confirmed++;
  }
  if (others.length > 0 && confirmed === 0) out.problems.push("no other endpoint serves this transaction and its receipt yet: one endpoint's word is not a proof (try again later)");
  if (finalizedNumber !== null && out.blockNumber > finalizedNumber) out.problems.push(`the transaction is in block ${out.blockNumber}, above the finalized block ${finalizedNumber}: wait`);
  out.proven = out.problems.length === 0;
  return out;
}

/** An opening as it is written into a report: amounts as decimal strings. */
export function openingRecord(opening) {
  const text = (pair) => (pair ? { native: pair.native.toString(), token: pair.token.toString() } : null);
  return { ...opening, deposited: text(opening.deposited), joined: text(opening.joined), gift: text(opening.gift) };
}

/** How far a gift moved the opening price from the deposited one, in basis points (rounded up). */
export function priceShiftBps({ deposited, joined }) {
  // price = token / native; shift = |joined.token * deposited.native - deposited.token * joined.native| / (deposited.token * joined.native)
  const a = joined.token * deposited.native;
  const b = deposited.token * joined.native;
  const diff = a > b ? a - b : b - a;
  return b === 0n ? 0n : (diff * 10_000n + b - 1n) / b;
}
