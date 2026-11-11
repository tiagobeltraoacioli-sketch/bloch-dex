#!/usr/bin/env node
// Permissionless `skim` keeper for DEX-02 (a standing donation above a reserve
// cap blocks swaps and mints on that side until anyone calls skim).
// Runbook: docs/OPS-DEX-MONITOR-KEEPER.md.
//
// One run does one thing at most, and a timer runs it. It is built to stay
// cheap and harmless under griefing:
//   * it only ever calls skim(Bloch Inc Safe) on a pair the gate file pins, with
//     the pair and token code hashes checked first; the recipient is not an
//     option, so a stolen keeper key can only spend the gas budget;
//   * dust below the floor is ignored, so a griefer cannot trigger a transaction
//     without forfeiting at least the floor to the Safe, except a soft closure: about
//     1 USD on a side already at its cap. That can only use a small share of the count;
//   * part of the count is kept for a hard closure, where the griefer has the floor at
//     stake, so cheap donations cannot spend the keeper before the one that matters;
//   * a tip that varies and climbs after a wasted skim: to win a race for certain a griefer
//     must always pay above the top of the range, and its re-donation cannot land safely
//     above the keeper's tip, so users' swaps get through in between;
//   * every transaction is simulated first, has a gas limit and a fee ceiling,
//     and its worst-case cost is reserved against a rolling 24 h budget and a
//     transaction count BEFORE it is signed; the state file is written before
//     publishing, so a crash cannot double-spend the budget;
//   * one transaction in flight at a time, a cooldown between transactions, and
//     exponential backoff when a skim moved nothing (someone else skimmed first);
//   * it is a dry run unless --execute is given.
//
// Exit status: 0 nothing needed, or sent, or waiting; 1 needs attention (budget,
// fee ceiling, gas limit, funding, backoff); 2 refused (identity, code hash,
// simulation or publication failed); 3 the node could not answer.
//
//   node scripts/ops/dex-skim-keeper.mjs --config finality-gate.mainnet.json
//        --rpc http://127.0.0.1:18955 --keeper 0x… --state /var/lib/…/state.json
//        [--execute] [--budget-wei 50000000000000000] [--max-tx 48]
//        [--max-fee-wei 20000000000] [--max-gas 150000] [--floor-bps 100]
//        [--ceiling-floor-wei <default budget-wei / max-tx>]
//        [--tip-wei 1000000000] [--max-tip-wei 8000000000]
//        [--soft-share-bps 2500] [--hard-reserve-bps 2500]
//        [--cooldown-s 1800] [--pending-timeout-s 7200] [--rebroadcast-s 900]
//        [--replace-after-s 7200] [--max-replacements 4] [--max-clock-skew-s 64800]
//        -- <cast signer arguments>
//
// Recovery of a lost transaction is automatic and never opens a second nonce (docs: "Crash
// behaviour"): the signed bytes are kept in the state file and re-published unchanged; a
// transaction that stays out of the chain is replaced AT THE SAME NONCE by another
// skim(Safe) with higher fees inside the same ceilings, so at most one of them can ever be
// mined; a nonce consumed by a transaction this keeper did not record is settled from the
// finalized chain. A new nonce is used only after the previous one is settled by finalized data.
// That includes a first publication the node refused with its admission price: the refusal is
// the node's word, so the entry keeps its nonce and reservation and the retry replaces it.

import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sequencerFeeRequirement } from "../staging/sequencer-fee-error.mjs";
import { KEEPER_PENDING_TIMEOUT_SECONDS, keeperNeedsReconciliation, keeperWindow as windowTxs, keeperWindowSpend as windowSpend } from "./keeper-accounting.mjs";
import { acquireLock, saveState } from "./keeper-state-store.mjs";
export { acquireLock, saveState } from "./keeper-state-store.mjs";
import {
  CRIT, CallReverted, IdentityError, OK, READ_ONLY_METHODS, RpcError, UNKNOWN, WARN,
  blockRef, checkIdentity, classifyExcess, closureOf, codeHash, createRequest, deploymentFromGate, encode, isAtKCeiling, keccak256,
  call, parseArgs, parseTransaction, readBlock, readBridgeExit, readGate, readPair, recoverTransactionAddress, stringify,
} from "./dex-ops-lib.mjs";
import { isMain } from "../staging/is-main.mjs";

export const DEFAULTS = Object.freeze({
  // 0.05 BLCH per 24 h: about 70 skims at the top of the tip range. A griefer who wins a
  // round pays about 1.7x the keeper's gas in the same fee market, and loses its donation when
  // it loses one, so a larger budget costs the griefer more than it costs the Safe.
  budgetWei: 50_000_000_000_000_000n,
  maxTx: 48, // One every 30 minutes, about every second block at 12-15 min.
  maxFeeWei: 20_000_000_000n,
  tipWei: 1_000_000_000n,
  maxTipWei: 8_000_000_000n,
  softShareBps: 2_500n, // At most this share of maxTx on soft closures.
  hardReserveBps: 2_500n, // This share of maxTx is only for hard closures.
  maxGas: 150_000n, // measured about 60-95k, depending on cold recipient balances
  floorBps: 100n,
  // At the k ceiling a swap's fee stays outside the reserves as excess (DEX-4). There the
  // keeper skims once the excess is worth this much, in wei of the wrapped token at the pool
  // price. null means budgetWei / maxTx: every skim then returns at least its share of the
  // daily budget, so the Safe never spends more gas than it collects even if the keeper
  // skims at every chance. With the RC budget that is 0.05 BLCH / 48 = 0.00104 BLCH,
  // about 1 bps of the 10 WBLCH cap, against 100 bps (0.1 BLCH) for ordinary excess.
  ceilingFloorWei: null,
  cooldownSeconds: 1_800, // a little over two L2 blocks at 12-15 min
  pendingTimeoutSeconds: KEEPER_PENDING_TIMEOUT_SECONDS,
  backoffCapSeconds: 6 * 3_600,
  // Recovery of a transaction that did not reach the chain. The same signed bytes are
  // published again every rebroadcastSeconds (one L2 block). After replaceAfterSeconds
  // without inclusion, or at once when the node proves the bytes are not in its spool, the
  // next needed skim reuses the SAME nonce with fees 12.5% higher (the spool asks 10%).
  rebroadcastSeconds: 900,
  replaceAfterSeconds: KEEPER_PENDING_TIMEOUT_SECONDS,
  maxReplacements: 4,
  // 18 h: above the 12 h 10 min the V3 rehearsal chain starts behind the wall clock, below the 24 h window.
  maxClockSkewSeconds: 64_800,
});
/// A same-nonce replacement raises both fee fields by at least 1/8 (the L2 spool and geth ask 10%).
export const replacementFloor = (wei) => (BigInt(wei) * 9n + 7n) / 8n;
/// Value of a pair's unrecorded balance, in wei of the wrapped token at the pool's own
/// price (reserves). null when the pair has no wrapped side or an empty reserve.
export function excessValueWei(pairState, wrapped) {
  const w = wrapped.toLowerCase();
  const sides = pairState.sides;
  const i = sides.findIndex((side) => side.token.toLowerCase() === w);
  if (i < 0) return null;
  const [mine, other] = [sides[i], sides[1 - i]];
  if (mine.reserve === 0n || other.reserve === 0n) return null;
  const pos = (side) => (side.balance > side.reserve ? side.balance - side.reserve : 0n);
  return pos(mine) + (pos(other) * mine.reserve) / other.reserve;
}

/// The ceiling floor in force: the option, or the budget's per-transaction share.
export function ceilingFloorWei(options) {
  if (options.ceilingFloorWei !== null && options.ceilingFloorWei !== undefined) return options.ceilingFloorWei;
  // --max-tx 0 stops every skim later on; it must not throw here (found by the ops rehearsal).
  return options.maxTx > 0 ? options.budgetWei / BigInt(options.maxTx) : options.budgetWei;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const emptyState = () => ({ schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 });

export function loadState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state.schema !== "postern.dex.skim-keeper.v1") throw new Error("unknown schema");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    // A damaged budget file must stop the keeper, not reset its budget.
    throw new Error(`keeper state ${path} is unreadable: ${error.message}`);
  }
}

/// The tip of the next skim: uniform between tipWei and tipWei * 2^(wasted + 1), capped at
/// maxTipWei. It varies even with no waste, because a known tip tells a griefer exactly how
/// low its re-donation has to go to stay behind the keeper's skim.
export function nextTip(state, options, random = (n) => BigInt(randomInt(Number(n)))) {
  const shift = BigInt(Math.min((state.consecutiveWasted ?? 0) + 1, 16));
  const top = options.tipWei << shift;
  const ceiling = top < options.maxTipWei ? top : options.maxTipWei;
  if (ceiling <= options.tipWei) return options.tipWei;
  // Steps of 1 Mwei keep the range inside randomInt's limits.
  const steps = (ceiling - options.tipWei) / 1_000_000n;
  return options.tipWei + random(steps + 1n) * 1_000_000n;
}

function receiptQuantity(value, field) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) {
    throw new RpcError(`keeper receipt ${field} is not an Ethereum quantity`);
  }
  return BigInt(value);
}

async function requireCanonicalReceiptBlock(request, number, hash) {
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash) || /^0x0+$/.test(hash)) {
    throw new RpcError("keeper receipt checkpoint hash is invalid");
  }
  const block = await request("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
  if (!block || receiptQuantity(block.number, "checkpoint number") !== number || block.hash !== hash) {
    throw new RpcError("keeper receipt checkpoint is not canonical");
  }
  return block;
}

const hex = (n) => `0x${n.toString(16)}`;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/// Every transaction hash signed for an entry's nonce: the current one, then older attempts.
const hashesOf = (entry) => [entry.hash, ...(entry.attempts ?? []).map((a) => a.hash).reverse()];

/// The signed bytes kept in the state file are published again only if they are this keeper's
/// skim(Safe) on a pinned pair: a state file edited by hand cannot make the keeper publish
/// anything else. Throws IdentityError.
export async function storedSkim(entry, keeper, deployment) {
  const refuse = (why) => { throw new IdentityError(`the transaction stored for ${entry.hash} is not this keeper's skim to the Safe (${why}); nothing was published`); };
  if (typeof entry.raw !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(entry.raw)) refuse("no signed bytes");
  if (keccak256(entry.raw) !== entry.hash) refuse("hash");
  let tx;
  try { tx = parseTransaction(entry.raw); } catch { refuse("encoding"); }
  let signer;
  try { signer = (await recoverTransactionAddress({ serializedTransaction: entry.raw })).toLowerCase(); } catch { refuse("signature"); }
  if (signer !== keeper) refuse("signer");
  const pair = deployment.pairs.find((p) => p.address.toLowerCase() === String(entry.pair).toLowerCase());
  if (!pair || tx.to?.toLowerCase() !== pair.address.toLowerCase()) refuse("pair");
  if (tx.type !== "eip1559" || BigInt(tx.chainId) !== BigInt(deployment.chainId) || BigInt(tx.nonce ?? 0) !== BigInt(entry.nonce)) refuse("chain or nonce");
  if ((tx.data ?? "0x").toLowerCase() !== encode("skim", [deployment.feeTo]).toLowerCase() || (tx.value ?? 0n) !== 0n || tx.accessList?.length) refuse("call");
  return tx;
}

/// The finalized transaction that used `nonce` of the keeper account, found by bisecting the
/// account's transaction count over block numbers. null when the node cannot show it.
async function findNonceConsumer(request, keeper, nonce, from, finalizedNumber) {
  const countAt = async (n) => BigInt(await request("eth_getTransactionCount", [keeper, hex(n)]));
  let low = from > 0n && from < finalizedNumber && (await countAt(from)) <= nonce ? from : 0n;
  if (low === 0n && (await countAt(0n)) > nonce) return null;
  let high = finalizedNumber; // count(low) <= nonce < count(high)
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if ((await countAt(mid)) > nonce) high = mid; else low = mid;
  }
  const block = await request("eth_getBlockByNumber", [hex(high), true]);
  if (!block || receiptQuantity(block.number, "block number") !== high || !Array.isArray(block.transactions)) return null;
  const tx = block.transactions.find((t) => t && typeof t === "object" && String(t.from).toLowerCase() === keeper &&
    typeof t.nonce === "string" && /^0x[0-9a-f]+$/.test(t.nonce) && BigInt(t.nonce) === nonce);
  return tx && typeof tx.hash === "string" && /^0x[0-9a-f]{64}$/.test(tx.hash) ? { block, tx } : null;
}

/// Resolve at most one old entry per pass. Every unresolved entry blocks a NEW nonce,
/// including entries expired/replaced by earlier keeper versions. What this may do for a
/// transaction that is not in the chain: publish its stored bytes again, unchanged, and tell
/// the caller that the next needed skim may replace it at the same nonce (`replace`).
async function reconcile(state, keeper, deployment, request, now, options) {
  const open = state.txs.find(keeperNeedsReconciliation);
  if (!open) return null;
  const pending = (reason = "awaiting-receipt", entry = open, extra = {}) => {
    const ageSeconds = Math.max(0, now - entry.at);
    // A refused first publication holds a free nonce and nothing in any spool: waiting is its normal state.
    const overdue = ageSeconds > options.pendingTimeoutSeconds && reason !== "refused-not-in-spool";
    return { hash: entry.hash, ageSeconds, reason: reason === "awaiting-receipt" && overdue ? "pending-timeout" : reason,
      level: overdue || ["nonce-used-without-receipt", "legacy-history", "nonce-gap"].includes(reason) ? WARN : OK, ...extra };
  };
  for (const hash of hashesOf(open)) {
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    if (!receipt) continue;
    const pair = hash === open.hash ? open.pair : open.attempts.find((a) => a.hash === hash).pair;
    if (receipt.transactionHash !== hash || String(receipt.from).toLowerCase() !== keeper ||
      String(receipt.to).toLowerCase() !== String(pair).toLowerCase() || !["0x0", "0x1"].includes(receipt.status)) {
      throw new RpcError("keeper receipt identity or status differs from the published transaction");
    }
    const blockNumber = receiptQuantity(receipt.blockNumber, "blockNumber");
    const gasUsed = receiptQuantity(receipt.gasUsed, "gasUsed");
    const gasPrice = receiptQuantity(receipt.effectiveGasPrice, "effectiveGasPrice");
    const spentWei = gasUsed * gasPrice;
    if (gasUsed === 0n || spentWei > BigInt(open.reservedWei) || !Array.isArray(receipt.logs)) {
      throw new RpcError("keeper receipt cost or logs are invalid");
    }
    const latest = await readBlock(request, "latest");
    // The settled RPC can serve a receipt before its `latest` view reaches that
    // block; reading reserves now would see the excess again and pay twice.
    if (!latest || latest.number < blockNumber) return pending("awaiting-latest");
    const finalized = await readBlock(request, "finalized");
    if (!finalized || finalized.number < blockNumber) return pending("awaiting-finality");
    // Do not reduce the reservation for a receipt that can still be orphaned.
    const included = await requireCanonicalReceiptBlock(request, blockNumber, receipt.blockHash);
    const includedAt = receiptQuantity(included.timestamp, "block timestamp");
    if (includedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError("keeper receipt timestamp cannot be recorded exactly");
    await requireCanonicalReceiptBlock(request, finalized.number, finalized.hash);
    const moved = (receipt.logs ?? []).some((log) => log.topics?.[0] === TRANSFER_TOPIC && /^0x[0-9a-fA-F]+$/.test(log.data ?? "") && BigInt(log.data) > 0n);
    if (hash !== open.hash) {
      // An older attempt of this nonce is the one that was mined: it becomes the entry's transaction.
      const landed = open.attempts.find((a) => a.hash === hash);
      open.attempts = [...open.attempts.filter((a) => a !== landed), { hash: open.hash, raw: open.raw, pair: open.pair, tipWei: open.tipWei, maxFeeWei: open.maxFeeWei, gasLimit: open.gasLimit, at: open.replacedAt }];
      Object.assign(open, { hash, raw: landed.raw, pair: landed.pair, tipWei: landed.tipWei, maxFeeWei: landed.maxFeeWei, gasLimit: landed.gasLimit });
    }
    open.spentWei = spentWei.toString();
    open.includedAt = Number(includedAt);
    open.includedBlockNumber = blockNumber.toString();
    open.includedBlockHash = receipt.blockHash;
    if (receipt.status !== "0x1" || !moved) {
      open.status = receipt.status === "0x1" ? "wasted" : "reverted";
      state.consecutiveWasted += 1;
      const delay = Math.min(options.cooldownSeconds * 2 ** state.consecutiveWasted, DEFAULTS.backoffCapSeconds);
      state.nextAllowedAt = now + delay;
    } else {
      open.status = "effective";
      state.consecutiveWasted = 0;
    }
    const next = state.txs.find(keeperNeedsReconciliation);
    return next ? pending("legacy-history", next) : null;
  }

  const nonce = BigInt(open.nonce);
  const latestNonce = BigInt(await request("eth_getTransactionCount", [keeper, "latest"]));
  if (latestNonce > nonce) {
    // The nonce is used and none of this entry's hashes has a receipt: another transaction of
    // the keeper account took it (a manual skim, another tool). Only the finalized chain can
    // say which one; until it does, nothing is released and no new nonce is opened.
    const waiting = pending("nonce-used-without-receipt");
    const finalized = await readBlock(request, "finalized");
    if (!finalized) return waiting;
    if (BigInt(await request("eth_getTransactionCount", [keeper, hex(finalized.number)])) <= nonce) return waiting;
    const found = await findNonceConsumer(request, keeper, nonce, BigInt(open.sinceBlock ?? 0), finalized.number);
    if (!found) return waiting;
    // One of our own hashes without a receipt: the node's receipt index is behind. Wait for it.
    if (hashesOf(open).includes(found.tx.hash)) return waiting;
    const receipt = await request("eth_getTransactionReceipt", [found.tx.hash]);
    if (!receipt || receipt.transactionHash !== found.tx.hash || String(receipt.from).toLowerCase() !== keeper ||
      receipt.blockHash !== found.block.hash || !["0x0", "0x1"].includes(receipt.status)) return waiting;
    const blockNumber = receiptQuantity(receipt.blockNumber, "blockNumber");
    const spentWei = receiptQuantity(receipt.gasUsed, "gasUsed") * receiptQuantity(receipt.effectiveGasPrice, "effectiveGasPrice");
    if (blockNumber !== BigInt(found.block.number) || blockNumber > finalized.number || spentWei === 0n) return waiting;
    const included = await requireCanonicalReceiptBlock(request, blockNumber, receipt.blockHash);
    const includedAt = receiptQuantity(included.timestamp, "block timestamp");
    if (includedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError("keeper receipt timestamp cannot be recorded exactly");
    await requireCanonicalReceiptBlock(request, finalized.number, finalized.hash);
    // The recorded transaction can never be mined now. The account did spend this gas, so it
    // is charged to the rolling budget at its real cost, in the window of its real block.
    open.status = "superseded";
    open.supersededBy = found.tx.hash;
    open.spentWei = spentWei.toString();
    open.includedAt = Number(includedAt);
    open.includedBlockNumber = blockNumber.toString();
    open.includedBlockHash = receipt.blockHash;
    return { action: "nonce-settled-by-other-transaction", level: WARN, hash: open.hash, supersededBy: found.tx.hash, spentWei: open.spentWei, includedBlockNumber: open.includedBlockNumber };
  }
  // An earlier nonce of the account is still open: nothing recorded here can be mined before it.
  if (latestNonce < nonce) return pending("nonce-gap");

  // Not mined, and the nonce is still free. Publish the same signed bytes again.
  const lastAttemptAt = open.replacedAt ?? open.at;
  // `refusedFirst`: the node refused these bytes with its admission price at their FIRST
  // publication. The keeper never publishes them again by itself (a skim that is no longer
  // needed would only burn gas); the nonce stays reserved and the next needed skim reuses it.
  const refusedFirst = open.refusedFirst === true;
  // The node's "not in my spool" answer and its quote describe one head. After one
  // re-publication interval they are forgotten and the stored bytes are published again, so
  // an old quote above the ceilings cannot hold the entry for ever. For a refused first
  // publication only a quote inside the ceilings is kept, for a day at most.
  if (Number.isSafeInteger(open.notSpooledAt) && now - open.notSpooledAt >= (refusedFirst ? 86_400 : options.rebroadcastSeconds)) {
    if (!refusedFirst) delete open.notSpooledAt;
    delete open.feeRequirement;
  }
  let notSpooled = Number.isSafeInteger(open.notSpooledAt) && open.notSpooledAt >= lastAttemptAt; // kept for good when refusedFirst
  let rebroadcast;
  if (options.execute && open.raw !== undefined && !notSpooled && now - (open.lastBroadcastAt ?? lastAttemptAt) >= options.rebroadcastSeconds) {
    await storedSkim(open, keeper, deployment);
    open.lastBroadcastAt = now;
    open.broadcasts = (open.broadcasts ?? 1) + 1;
    try {
      rebroadcast = (await request("eth_sendRawTransaction", [open.raw])) === open.hash ? "accepted" : "unconfirmed";
    } catch (error) {
      const feeRequirement = sequencerFeeRequirement(error, open.hash);
      if (feeRequirement) {
        // The node answers this only for bytes that are not in its spool (an entry it already
        // holds gets its hash back). The same nonce may be replaced at once.
        open.notSpooledAt = now;
        open.feeRequirement = feeRequirement;
        notSpooled = true;
        rebroadcast = "fee-refused";
      } else rebroadcast = "unconfirmed";
    }
  }
  const stale = now - lastAttemptAt >= options.replaceAfterSeconds;
  const feesKnown = [open.tipWei, open.maxFeeWei].every((v) => typeof v === "string" && DECIMAL.test(v));
  const only = state.txs.filter(keeperNeedsReconciliation).length === 1;
  const exhausted = (open.attempts?.length ?? 0) >= options.maxReplacements;
  const spaced = !(Number.isSafeInteger(open.noReplaceBefore) && now < open.noReplaceBefore);
  // An entry written by a keeper that did not keep the signed bytes cannot be published again.
  // Once stale it is replaced at its own nonce like any other (only one transaction of a nonce
  // can be mined); the replacement's fees are chosen in runKeeper without the unknown figures.
  const legacy = open.raw === undefined;
  const replace = (stale || notSpooled) && (feesKnown || legacy) && only && !exhausted && spaced ? open : undefined;
  return pending(exhausted && stale ? "replacements-exhausted" : refusedFirst ? "refused-not-in-spool" : notSpooled ? "not-in-spool" : undefined, open, { ...(rebroadcast ? { rebroadcast } : {}), replace });
}

/// One keeper pass. `deps`: {request, sign(tx) -> rawHex, now}. Writes state
/// through `deps.save` before anything is published.
export async function runKeeper(gate, givenOptions, state, deps) {
  const outcome = await keeperPass(gate, givenOptions, state, deps);
  // The stamp of every pass, whatever it did: the monitor reads it to tell a keeper that runs and needs nothing
  // from one that never ran, stopped, or keeps ending on a limit (its unit counts exit 1 as a success).
  state.lastPass = { at: deps.now, action: String(outcome.action), level: outcome.level };
  deps.save(state);
  return outcome;
}

async function keeperPass(gate, givenOptions, state, deps) {
  const { request, sign, save, now } = deps;
  const options = { rebroadcastSeconds: DEFAULTS.rebroadcastSeconds, replaceAfterSeconds: DEFAULTS.replaceAfterSeconds, maxReplacements: DEFAULTS.maxReplacements, ...givenOptions };
  const deployment = deploymentFromGate(gate);
  const keeper = options.keeper.toLowerCase();
  const result = (level, action, detail = {}) => ({ level, action, ...detail });

  try {
    // The skim recipient is the gate file's feeTo. It must be the Bloch Inc Safe the same file pins, and (below) the
    // recipient the factory itself pays protocol fees to: a gate file edited by hand cannot redirect the excess.
    if (typeof deployment.feeTo !== "string" || deployment.feeTo.toLowerCase() !== deployment.safe?.address?.toLowerCase()) {
      throw new IdentityError(`the gate file's feeTo ${deployment.feeTo} is not its Bloch Inc Safe ${deployment.safe?.address}`);
    }
    await checkIdentity(request, deployment);
    const head = await readBlock(request, "latest");
    // The budget window is measured on this host's clock. A clock far from the chain's (or a
    // head that stopped long ago) would empty the window or act on stale reserves: do nothing.
    if (options.maxClockSkewSeconds !== undefined) {
      const skew = BigInt(now) - head.timestamp;
      if (skew > BigInt(options.maxClockSkewSeconds) || -skew > BigInt(options.maxClockSkewSeconds)) {
        return result(WARN, "clock-or-head-stale", { now, headTimestamp: head.timestamp, maxClockSkewSeconds: options.maxClockSkewSeconds });
      }
    }
    const requireFactoryRecipient = async (at) => {
      const factoryCode = await codeHash(request, deployment.factory.address, at);
      if (factoryCode !== deployment.factory.codeHash) throw new IdentityError(`factory ${deployment.factory.address} code ${factoryCode} differs from the pin`);
      const chainFeeTo = (await call(request, deployment.factory.address, "feeTo", [], at)).toLowerCase();
      if (chainFeeTo !== deployment.feeTo.toLowerCase()) throw new IdentityError(`the factory pays fees to ${chainFeeTo}, the gate file says ${deployment.feeTo}`);
    };
    // Before anything is published again: recovery re-publishes stored bytes, and they pay the same recipient.
    if (state.txs.some(keeperNeedsReconciliation)) await requireFactoryRecipient(blockRef(await readBlock(request, "latest")));
    const inFlight = await reconcile(state, keeper, deployment, request, now, options);
    save(state);
    // `replacing`: the one open transaction is not in the chain and its nonce is still free, so
    // the skim planned below reuses that nonce. Only one transaction per nonce can be mined.
    const replacing = inFlight?.replace ?? null;
    if (inFlight) delete inFlight.replace;
    if (inFlight?.action) return result(inFlight.level, inFlight.action, inFlight);
    if (inFlight && !replacing) return result(inFlight.level, "wait-in-flight", inFlight);

    const latest = await readBlock(request, "latest");
    const at = blockRef(latest);
    for (const token of [deployment.wrapped, ...deployment.tokens.map((t) => ({ address: t.token, codeHash: t.codeHash }))]) {
      const observed = await codeHash(request, token.address, at);
      if (observed !== token.codeHash) throw new IdentityError(`token ${token.address} code ${observed} differs from the pin`);
    }
    await requireFactoryRecipient(at);

    let target = null;
    let ceilingPair = null;
    const ceilingFloor = ceilingFloorWei(options);
    let hardPair = null;
    let softPair = null;
    const seen = [];
    for (const pair of deployment.pairs) {
      const observed = await codeHash(request, pair.address, at);
      if (observed !== pair.codeHash) throw new IdentityError(`pair ${pair.address} code ${observed} differs from the pin`);
      // The recipient check reads the factory; the pair must be that factory's, or a gate file naming another factory could pass it.
      const pairFactory = (await call(request, pair.address, "factory", [], at)).toLowerCase();
      if (pairFactory !== deployment.factory.address.toLowerCase()) throw new IdentityError(`pair ${pair.address} belongs to factory ${pairFactory}, not the pinned ${deployment.factory.address}`);
      const pairState = await readPair(request, pair, at);
      const kinds = pairState.sides.map((side) => classifyExcess(side, options.floorBps));
      const closure = closureOf(pairState, options.floorBps);
      seen.push({ pair: pair.address, kinds, excess: pairState.sides.map((s) => s.balance - s.reserve), closure: closure ? (closure.hard ? "hard" : "soft") : null });
      if (kinds.includes("negative")) throw new IdentityError(`pair ${pair.address} holds less than its reserves`);
      if (closure?.hard && !hardPair) hardPair = pair;
      if (closure && !closure.hard && !softPair) softPair = pair;
      if (!target && kinds.some((k) => k === "material" || k === "blocking")) target = pair;
      // DEX-4: at the k ceiling the excess is swap fees nobody else will collect for the Safe.
      if (!ceilingPair && isAtKCeiling(pairState)) {
        const value = excessValueWei(pairState, deployment.wrapped.address);
        seen.at(-1).kCeiling = { excessValueWei: value, floorWei: ceilingFloor };
        if (value !== null && value >= ceilingFloor) ceilingPair = pair;
      }
    }
    if (!target && ceilingPair) target = ceilingPair;
    const atCeiling = target !== null && target === ceilingPair && !hardPair;
    // A hard closure outranks everything. A soft one comes last.
    if (hardPair) target = hardPair;
    const soft = !target && Boolean(softPair);
    if (soft) target = softPair;
    // A lost transaction with nothing left to skim stays recorded; its nonce is reused when a skim is next needed.
    if (!target) return replacing ? result(inFlight.level, "wait-in-flight", { ...inFlight, replaceable: true }) : result(OK, "nothing-to-do", { seen });

    // Stopped with a hard closure standing means ordinary swaps stay stopped and nothing
    // here will clear it: that is an operator's problem now, not a warning.
    const blocked = (action, detail) => result(hardPair ? CRIT : WARN, action, { pair: target.address, seen, ...detail });
    // A griefer that wins its own skim could use the backoff to hold a pair closed,
    // so a hard closure skips the backoff and the cooldown. A soft closure does not: it
    // stops only swaps below the floor, and it costs the griefer about 1 USD. The budget
    // and the transaction count always apply.
    if (!hardPair && now < state.nextAllowedAt) return blocked("backoff", { until: state.nextAllowedAt, consecutiveWasted: state.consecutiveWasted });
    // A replacement adds no transaction: the entry it replaces is already counted and reserved.
    const inWindow = windowTxs(state, now).filter((t) => t !== replacing);
    const last = inWindow.at(-1);
    if (!hardPair && last && now - last.at < options.cooldownSeconds) return result(OK, "cooldown", { pair: target.address, seen, until: last.at + options.cooldownSeconds });
    if (inWindow.length >= options.maxTx) return blocked("tx-count-exhausted", { maxTx: options.maxTx });
    const share = (bps) => (BigInt(options.maxTx) * bps) / 10_000n;
    if (soft && BigInt(inWindow.filter((t) => t.kind === "soft").length) >= share(options.softShareBps)) return blocked("soft-closure-share-used", { softTx: share(options.softShareBps) });
    if (!hardPair && BigInt(inWindow.length) >= BigInt(options.maxTx) - share(options.hardReserveBps)) return blocked("reserved-for-hard-closure", { reservedTx: share(options.hardReserveBps) });

    // The recipient is fixed: donations go to the Bloch Inc Safe, never to the
    // keeper, so running or attacking a keeper pays nobody.
    const data = encode("skim", [deployment.feeTo]);
    const txCall = { from: keeper, to: target.address, data };
    await request("eth_call", [txCall, at]);
    const estimate = BigInt(await request("eth_estimateGas", [txCall]));
    const gasLimit = (estimate * 12n) / 10n;
    if (gasLimit > options.maxGas) return blocked("gas-limit-exceeded", { estimate, maxGas: options.maxGas });

    if (latest.baseFee + options.tipWei > options.maxFeeWei) return blocked("fee-above-ceiling", { baseFee: latest.baseFee, maxFeeWei: options.maxFeeWei });
    let tip = nextTip(state, options, deps.random);
    // Fee floors, always inside the operator's ceilings (never raised here): a same-nonce
    // replacement must outbid the attempt it replaces, and the node's own quote for the last
    // refused skim (its price for new storage slots) is honoured on the next attempt.
    const quote = replacing?.feeRequirement ?? null;
    // What a same-nonce replacement must outbid. Two kinds of entry have no binding figure:
    //   * bytes the node refused at their first publication are in no spool, so the 12.5% is
    //     only a precaution against a node that kept them anyway: it is capped at the ceilings;
    //   * an entry without its signed bytes or fees (written by an older keeper) is outbid with
    //     the operator's own ceilings, which no transaction of this keeper can exceed.
    const known = (v) => typeof v === "string" && DECIMAL.test(v);
    const outbid = (field, ceiling) => {
      if (!replacing) return 0n;
      if (!known(replacing[field])) return ceiling;
      const floor = replacementFloor(replacing[field]);
      return replacing.refusedFirst === true && floor > ceiling ? ceiling : floor;
    };
    const tipFloor = [outbid("tipWei", options.maxTipWei), quote ? BigInt(quote.requiredPriorityFeePerGas) : 0n].reduce((a, b) => (a > b ? a : b));
    if (tip < tipFloor) tip = tipFloor;
    if (tip > options.maxTipWei && tipFloor > 0n) return blocked("fee-above-ceiling", { requiredTipWei: tipFloor, maxTipWei: options.maxTipWei, ...(replacing ? { replacesHash: replacing.hash } : {}) });
    if (latest.baseFee + tip > options.maxFeeWei) {
      if (tipFloor > 0n) return blocked("fee-above-ceiling", { baseFee: latest.baseFee, requiredTipWei: tipFloor, maxFeeWei: options.maxFeeWei });
      tip = options.maxFeeWei - latest.baseFee;
    }
    const wanted = latest.baseFee * 2n + tip;
    let maxFee = wanted < options.maxFeeWei ? wanted : options.maxFeeWei;
    if (replacing) {
      const feeFloor = outbid("maxFeeWei", options.maxFeeWei);
      if (feeFloor > options.maxFeeWei) return blocked("fee-above-ceiling", { requiredMaxFeeWei: feeFloor, maxFeeWei: options.maxFeeWei, replacesHash: replacing.hash });
      if (maxFee < feeFloor) maxFee = feeFloor;
    }
    // The node measures the tip against the NEXT block's base fee, which can be 1/8 above this one.
    if (tipFloor > 0n && maxFee - replacementFloor(latest.baseFee) < tipFloor) return blocked("fee-above-ceiling", { baseFee: latest.baseFee, requiredTipWei: tipFloor, maxFeeWei: options.maxFeeWei });
    const worstCase = gasLimit * maxFee;
    // Only one transaction of a nonce can be mined: the entry reserves the dearest attempt once.
    const priorReserved = replacing ? BigInt(replacing.reservedWei) : 0n;
    const reserve = worstCase > priorReserved ? worstCase : priorReserved;
    const spent = windowSpend(state, now) - priorReserved;
    if (spent + reserve > options.budgetWei) return blocked("budget-exhausted", { spentWei: spent, worstCaseWei: reserve, budgetWei: options.budgetWei });
    const funds = BigInt(await request("eth_getBalance", [keeper, "latest"]));
    if (funds < worstCase) return blocked("keeper-underfunded", { balanceWei: funds, worstCaseWei: worstCase });

    const plan = { pair: target.address, to: deployment.feeTo, closure: hardPair ? "hard" : soft ? "soft" : null, kCeiling: atCeiling, tip, gasLimit, maxFee, worstCaseWei: worstCase, spentWei: spent, budgetWei: options.budgetWei, seen,
      ...(replacing ? { replacesHash: replacing.hash, nonce: BigInt(replacing.nonce) } : {}) };
    if (!options.execute) return result(OK, "would-skim", plan);

    // A new nonce only when nothing is open; a replacement keeps the open entry's nonce, which
    // must still be the account's next one (reconcile read it; read again: time has passed).
    const accountNonce = BigInt(await request("eth_getTransactionCount", [keeper, "latest"]));
    if (replacing && accountNonce !== BigInt(replacing.nonce)) return result(inFlight.level, "wait-in-flight", inFlight);
    // A new nonce is the account's next one. If the node counts other queued transactions of
    // this account, signing behind them could leave a gap that nothing here can close.
    const pendingNonce = replacing ? accountNonce : BigInt(await request("eth_getTransactionCount", [keeper, "pending"]));
    if (pendingNonce !== accountNonce) return blocked("keeper-account-has-queued-transactions", { latestNonce: accountNonce, pendingNonce });
    const nonce = accountNonce;
    const raw = String(await sign({ chainId: deployment.chainId, nonce, gasLimit, maxFee, tip, to: target.address, data })).toLowerCase();
    const signer = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
    if (signer !== keeper) throw new IdentityError(`the signer is ${signer}, not the configured keeper ${keeper}`);
    // The signer is an external program: publish only the exact transaction that was planned and reserved.
    const signed = parseTransaction(raw);
    const same = signed.type === "eip1559" && BigInt(signed.chainId) === BigInt(deployment.chainId) && BigInt(signed.nonce) === nonce &&
      signed.to?.toLowerCase() === target.address.toLowerCase() && (signed.data ?? "0x").toLowerCase() === data.toLowerCase() &&
      (signed.value ?? 0n) === 0n && signed.gas === gasLimit && signed.maxFeePerGas === maxFee && signed.maxPriorityFeePerGas === tip &&
      !signed.accessList?.length;
    if (!same) throw new IdentityError("the signed transaction is not the planned skim (chain, nonce, recipient, data, value, gas or fees differ)");
    const hash = keccak256(raw);
    const kind = hardPair ? "hard" : soft ? "soft" : atCeiling ? "ceiling" : "excess";
    // The signed bytes are public data. Kept, they let a later pass publish the identical transaction again.
    const signedFields = { hash, raw, pair: target.address, tipWei: tip.toString(), maxFeeWei: maxFee.toString(), gasLimit: gasLimit.toString() };
    let entry;
    const wasRefusedFirst = replacing?.refusedFirst === true;
    if (replacing) {
      if (hashesOf(replacing).includes(hash)) return result(inFlight.level, "wait-in-flight", inFlight);
      entry = replacing;
      entry.attempts = [...(entry.attempts ?? []), { hash: entry.hash, raw: entry.raw, pair: entry.pair, tipWei: entry.tipWei, maxFeeWei: entry.maxFeeWei, gasLimit: entry.gasLimit, at: entry.replacedAt ?? entry.at }];
      Object.assign(entry, signedFields, { kind, reservedWei: reserve.toString(), replacedAt: now, lastBroadcastAt: now, status: "pending" });
      delete entry.notSpooledAt;
      delete entry.feeRequirement;
      delete entry.refusedFirst;
    } else {
      entry = { at: now, ...signedFields, nonce: nonce.toString(), sinceBlock: latest.number.toString(), reservedWei: worstCase.toString(), kind, status: "pending" };
      state.txs = [...windowTxs(state, now), entry];
    }
    delete state.feeHint; // Written by the round 14 keeper only; quotes now live in the open entry.
    save(state); // Before publishing: a crash after this point cannot overspend.
    try {
      const publishedHash = await request("eth_sendRawTransaction", [raw]);
      if (publishedHash !== hash) throw new RpcError("eth_sendRawTransaction returned a different transaction hash");
    } catch (error) {
      const feeRequirement = sequencerFeeRequirement(error, hash);
      // The next attempt stays inside the same ceilings; if the quote is above them an operator must decide.
      const withinCeilings = feeRequirement && BigInt(feeRequirement.requiredPriorityFeePerGas) <= options.maxTipWei && BigInt(feeRequirement.requiredMaxFeePerGas) <= options.maxFeeWei;
      if (feeRequirement && replacing) {
        // These bytes never entered the node's spool, so they do not count as an attempt: the
        // entry goes back to the attempt before (which may still be queued somewhere), keeps
        // its reservation, and a later pass replaces it again with this quote.
        const previous = entry.attempts.pop();
        Object.assign(entry, { hash: previous.hash, raw: previous.raw, pair: previous.pair, tipWei: previous.tipWei, maxFeeWei: previous.maxFeeWei, gasLimit: previous.gasLimit });
        if (previous.at === entry.at) delete entry.replacedAt; else entry.replacedAt = previous.at;
        if (!entry.attempts.length) delete entry.attempts;
        entry.notSpooledAt = now;
        entry.feeRequirement = feeRequirement;
        entry.noReplaceBefore = now + options.rebroadcastSeconds;
        if (wasRefusedFirst) {
          // Back to the bytes the node refused at their first publication: same rules as below.
          entry.refusedFirst = true;
          if (!withinCeilings) delete entry.feeRequirement;
          entry.noReplaceBefore = now + (hardPair ? options.rebroadcastSeconds : Math.max(options.rebroadcastSeconds, options.cooldownSeconds));
        }
        save(state);
        return result(withinCeilings ? WARN : CRIT, "publish-refused", { hash, detail: error.message, feeRequirement, retry: withinCeilings ? "automatic, at the same nonce" : "needs higher --max-tip-wei / --max-fee-wei" });
      }
      if (feeRequirement) {
        // This specific admission response is emitted before the node's spool
        // write. Never infer rejection from a generic error message or code.
        // The refusal is still only the node's word, so nothing is released on it: the entry
        // stays open with its nonce and its reservation, and the next attempt is a replacement
        // AT THE SAME NONCE. If the node kept these bytes after all and they are mined, the
        // entry settles on their receipt like any other; a second nonce is never opened.
        entry.refusedFirst = true;
        entry.refusalKind = feeRequirement.kind;
        entry.notSpooledAt = now;
        // A quote above the ceilings is reported, never remembered: the next attempt is priced afresh.
        if (withinCeilings) entry.feeRequirement = feeRequirement;
        // A hard closure skips the cooldown here as everywhere else: the next pass replaces at once.
        entry.noReplaceBefore = hardPair ? now : now + options.cooldownSeconds;
        save(state);
        return result(withinCeilings ? WARN : CRIT, "publish-refused", { hash, detail: error.message, feeRequirement, retry: withinCeilings ? "automatic, at the same nonce, after the cooldown" : "needs higher --max-tip-wei / --max-fee-wei" });
      }
      // A lost response, a malformed reply, or a generic RPC error can arrive
      // after acceptance. Even "nonce too low" can mean this transaction landed.
      // Keep the saved reservation; a later pass reconciles its hash and nonce.
      return result(WARN, "publish-unconfirmed", { hash, detail: error.message });
    }
    return result(OK, replacing ? "replaced" : "sent", { hash, ...plan });
  } catch (error) {
    if (error instanceof RpcError) return result(UNKNOWN, "rpc-failed", { detail: error.message });
    if (error instanceof CallReverted) return result(CRIT, "simulation-reverted", { detail: error.message });
    if (error instanceof IdentityError) return result(CRIT, "refused", { detail: error.message });
    throw error;
  }
}

/// Sign offline with `cast mktx`, like scripts/staging/sign-and-publish.sh, so
/// bUSDC exit status for the keeper's log (agent 139 finding 1). It never changes what the keeper does: a skim moves
/// excess to the Safe on the L2 whether or not exits to Ethereum are held. Held or paused raise the outcome to WARN so the
/// operator knows skimmed bUSDC in the Safe cannot leave to Ethereum either.
export async function withBridgeExit(outcome, ethRequest, request, cfg, deployment) {
  try {
    const token = deployment.tokens.find((t) => (cfg.token ? t.token.toLowerCase() === cfg.token.toLowerCase() : t.symbol === "bUSDC"));
    if (!token) throw new Error("no bUSDC token in the deployment");
    const finalized = await readBlock(request, "finalized");
    if (!finalized) throw new Error("no finalized L2 block");
    const x = await readBridgeExit(ethRequest, request, { vault: cfg.vault, token: token.token, vaultCodeHash: cfg.vaultCodeHash }, finalized);
    const level = x.state === "normal" ? outcome.level : Math.max(outcome.level, WARN);
    return { ...outcome, level, bridgeExit: x.state };
  } catch (error) {
    return { ...outcome, bridgeExit: `unknown: ${error.message}` };
  }
}

/// any cast signer works (keystore, hardware wallet). The kit never sees a key.
function castSigner(signerArgs) {
  const run = promisify(execFile);
  return async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) => {
    try {
      const { stdout } = await run("cast", [
        "mktx", "--chain", String(chainId), "--nonce", nonce.toString(), "--gas-limit", gasLimit.toString(),
        "--gas-price", maxFee.toString(), "--priority-gas-price", tip.toString(), ...signerArgs, to, data,
      ]);
      return stdout.trim();
    } catch (error) {
      // The default message carries the whole command line, signer arguments included.
      throw new Error(`cast mktx failed: ${String(error.stderr ?? "").trim().split("\n").at(-1) || `exit ${error.code}`}`);
    }
  };
}

/// Every option of the keeper's command line. Anything else is refused at start (exit 2).
const KEEPER_OPTIONS = ["config", "rpc", "keeper", "state", "budget-wei", "max-tx", "max-fee-wei", "tip-wei", "max-tip-wei", "soft-share-bps",
  "hard-reserve-bps", "max-gas", "floor-bps", "ceiling-floor-wei", "cooldown-s", "pending-timeout-s", "rebroadcast-s", "replace-after-s",
  "max-replacements", "max-clock-skew-s", "eth-rpc", "bridge-vault", "bridge-vault-code-hash", "bridge-token"];

function bigOption(args, name, fallback) {
  return args[name] === undefined ? fallback : BigInt(args[name]);
}

if (isMain(import.meta.url)) {
  let release = () => {};
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["execute"], options: KEEPER_OPTIONS });
    if (!args.config || !args.rpc || !args.keeper || !args.state) {
      console.error("usage: dex-skim-keeper.mjs --config <gate.json> --rpc <url> --keeper <address> --state <file> [--execute] [limits] -- <cast signer args>");
      process.exit(UNKNOWN);
    }
    if (args.execute && args.rest.length === 0) throw new Error("--execute needs signer arguments after --");
    const options = {
      keeper: args.keeper,
      execute: Boolean(args.execute),
      budgetWei: bigOption(args, "budget-wei", DEFAULTS.budgetWei),
      maxTx: Number(args["max-tx"] ?? DEFAULTS.maxTx),
      maxFeeWei: bigOption(args, "max-fee-wei", DEFAULTS.maxFeeWei),
      tipWei: bigOption(args, "tip-wei", DEFAULTS.tipWei),
      maxTipWei: bigOption(args, "max-tip-wei", DEFAULTS.maxTipWei),
      softShareBps: bigOption(args, "soft-share-bps", DEFAULTS.softShareBps),
      hardReserveBps: bigOption(args, "hard-reserve-bps", DEFAULTS.hardReserveBps),
      maxGas: bigOption(args, "max-gas", DEFAULTS.maxGas),
      floorBps: bigOption(args, "floor-bps", DEFAULTS.floorBps),
      ceilingFloorWei: bigOption(args, "ceiling-floor-wei", DEFAULTS.ceilingFloorWei),
      cooldownSeconds: Number(args["cooldown-s"] ?? DEFAULTS.cooldownSeconds),
      pendingTimeoutSeconds: Number(args["pending-timeout-s"] ?? DEFAULTS.pendingTimeoutSeconds),
      rebroadcastSeconds: Number(args["rebroadcast-s"] ?? DEFAULTS.rebroadcastSeconds),
      replaceAfterSeconds: Number(args["replace-after-s"] ?? DEFAULTS.replaceAfterSeconds),
      maxReplacements: Number(args["max-replacements"] ?? DEFAULTS.maxReplacements),
      maxClockSkewSeconds: Number(args["max-clock-skew-s"] ?? DEFAULTS.maxClockSkewSeconds),
    };
    for (const k of ["budgetWei", "maxFeeWei", "tipWei", "maxTipWei", "maxGas", "floorBps", "softShareBps", "hardReserveBps"]) if (options[k] < 0n) throw new Error(`${k} must not be negative`);
    if (options.ceilingFloorWei !== null && options.ceilingFloorWei < 0n) throw new Error("--ceiling-floor-wei must not be negative");
    // The ceilings must be coherent before anything is read or signed: a tip range above the
    // fee ceiling is an operator mistake, refused at start (exit 2), never resolved by a pass.
    if (options.tipWei > options.maxTipWei || options.maxTipWei > options.maxFeeWei) throw new Error("--tip-wei must not exceed --max-tip-wei, and --max-tip-wei must not exceed --max-fee-wei");
    const integerOptions = { maxClockSkewSeconds: "max-clock-skew-s", maxTx: "max-tx", cooldownSeconds: "cooldown-s", pendingTimeoutSeconds: "pending-timeout-s", rebroadcastSeconds: "rebroadcast-s", replaceAfterSeconds: "replace-after-s", maxReplacements: "max-replacements" };
    for (const [k, flag] of Object.entries(integerOptions)) {
      if (!Number.isSafeInteger(options[k]) || options[k] < 0) throw new Error(`--${flag} must be a non-negative integer`);
    }
    const now = Math.floor(Date.now() / 1000);
    release = acquireLock(args.state);
    // A stopped pass is the same as a crashed one: the state was written before anything was
    // published, and the next pass reconciles. Leaving the lock would only block that pass.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => { try { release(); } finally { process.exit(CRIT); } });
    const allowed = args.execute ? [...READ_ONLY_METHODS, "eth_sendRawTransaction"] : READ_ONLY_METHODS;
    const outcome = await runKeeper(readGate(args.config), options, loadState(args.state), {
      request: createRequest(args.rpc, { allowed }),
      sign: castSigner(args.rest),
      save: (state) => saveState(args.state, state),
      now,
    });
    const final = args["eth-rpc"] && args["bridge-vault"]
      ? await withBridgeExit(outcome, createRequest(args["eth-rpc"]), createRequest(args.rpc), { vault: args["bridge-vault"], vaultCodeHash: args["bridge-vault-code-hash"], token: args["bridge-token"] }, deploymentFromGate(readGate(args.config)))
      : outcome;
    console.log(stringify(final));
    release();
    process.exit(final.level);
  } catch (error) {
    release();
    console.error(`keeper: ${error.message}`);
    process.exit(CRIT);
  }
}
