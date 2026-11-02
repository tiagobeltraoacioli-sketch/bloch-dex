#!/usr/bin/env node
// Read-only planner and checker for the opening liquidity of a capped pair.
// Runbook: docs/OPS-INITIAL-LIQUIDITY.md. It sends nothing and holds no key.
//
//   plan    amounts for the owner's opening price, accounting for any donation
//           already in the pair (DEX-04), and the router call to make
//   verify  after the seed: the pool price against the target, within a tolerance
//
// Exit status: 0 proceed or verified; 1 do this first (skim); 2 refused or price
// off target; 3 the node could not answer.
//
//   node scripts/ops/dex-seed-plan.mjs plan --config gate.json --rpc URL
//        --price 25.5 --to 0x<LP recipient> [--fraction-bps 5000, at most 7000] [--deadline-min 60]
//        [--write-txs <new file>]   the steps as a raw-transaction file for
//                                   scripts/staging/sign-and-publish.sh
//   node scripts/ops/dex-seed-plan.mjs verify --config gate.json --rpc URL
//        --price 25.5 --to 0x<LP recipient> [--tolerance-bps 100]
//   note-tx record a planned approve or seed the depositor sent, after checking it
//        node scripts/ops/dex-seed-plan.mjs note-tx --config <gate.json> --rpc <url> --tx <hash>[,<hash>...]

import { pathToFileURL } from "node:url";
import {
  CRIT, OK, RpcError, UNKNOWN, WARN,
  blockRef, call, checkIdentity, createRequest, deploymentFromGate, encode, formatUnits, isBricked, isClosed, isqrt,
  parseArgs, parseUnits, readBlock, readGate, readPair, stringify,
} from "./dex-ops-lib.mjs";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyDepositorHistory } from "../staging/finality-gate.mjs";

const WAD = 10n ** 18n;
const MINIMUM_LIQUIDITY = 1000n;
const PRICE_TOLERANCE_BPS = 100n;
const SEED_SHARE_BPS = 9_900n;

/// LP shares already exist: our own seed, or a first mint nobody planned (F1). The
/// price comes first: a swap sets it, then a pro-rata deposit reaches the target.
function planWithShares({ wrapped, quote, totalSupply, price, fractionBps }) {
  if (isClosed({ totalSupply, sides: [wrapped, quote] })) {
    return { decision: "closed", reason: "both reserves are at their caps. No swap or deposit passes until an LP burns; see the runbook (F1)." };
  }
  if ([wrapped, quote].some((s) => s.balance !== s.reserve)) {
    return { decision: "skim-first", reason: "an unsynced donation is in the pair. Run skim, then plan again." };
  }
  const pool = (quote.reserve * WAD) / wrapped.reserve;
  const gap = ((pool > price ? pool - price : price - pool) * 10_000n) / price;
  if (gap > PRICE_TOLERANCE_BPS) {
    const k = wrapped.reserve * quote.reserve;
    const nextWrapped = isqrt((k * WAD) / price);
    const nextQuote = (nextWrapped * price) / WAD;
    const sellWrapped = nextWrapped > wrapped.reserve;
    const [rIn, rOut, next, cap] = sellWrapped
      ? [wrapped.reserve, quote.reserve, nextWrapped, wrapped.cap]
      : [quote.reserve, wrapped.reserve, nextQuote, quote.cap];
    const amountIn = ((next - rIn) * 1000n) / 997n + 1n;
    if (rIn + amountIn > cap) return { decision: "refuse", reason: "the correcting swap would pass this side's cap. The pool cannot reach this price; see the runbook (F1)." };
    const out = (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);
    return { decision: "correct-price", sellWrapped, amountIn, amountOutMin: (out * 99n) / 100n, gapBps: gap, reason: "LP shares exist at another price. Swap to the target price, then plan again." };
  }
  let targetWrapped = (wrapped.cap * fractionBps) / 10_000n;
  let targetQuote = (targetWrapped * price) / WAD;
  const quoteLimit = (quote.cap * fractionBps) / 10_000n;
  if (targetQuote > quoteLimit) {
    targetQuote = quoteLimit;
    targetWrapped = (targetQuote * WAD) / price;
  }
  if (wrapped.reserve >= targetWrapped || quote.reserve >= targetQuote) {
    return { decision: "refuse", reason: "the pool is already at or above the opening target; this is not an opening deposit" };
  }
  const depositWrapped = targetWrapped - wrapped.reserve;
  const depositQuote = (depositWrapped * quote.reserve) / wrapped.reserve + 1n;
  return { decision: "top-up", depositWrapped, depositQuote, poolWrapped: targetWrapped, poolQuote: quote.reserve + depositQuote, donated: null };
}

/// Whether `to` holds the seed: nearly every share, apart from the 1000 locked ones.
/// A first mint nobody planned (spent rule) or a fill leaves a price that can look
/// right, so the price alone proves nothing (N2).
export function holdsSeed({ held, totalSupply, minBps = SEED_SHARE_BPS }) {
  if (totalSupply <= MINIMUM_LIQUIDITY) return false;
  return held * 10_000n >= (totalSupply - MINIMUM_LIQUIDITY) * minBps;
}

/// The pure part of `plan`. `wrapped` and `quote` are pair sides; `price` is in
/// quote base units per 1e18 wrapped base units.
/// Largest seed, in basis points of each cap, the planner accepts (owner decision DEX-4).
export const MAX_FRACTION_BPS = 7_000n;

/// The pair keeps reserve0 * reserve1 at or below 64% of cap0 * cap1 (the k ceiling).
/// A seed of f of both caps has k / ceiling = f^2 / 0.64, so 8,000 bps sits exactly on
/// the ceiling where the caps balance (P = 50, 80 and 100 with the planned caps): from
/// the first swap the fee stays outside the reserves and LPs and the Safe earn nothing.
/// 7,000 bps gives k at 76.6% of the ceiling, about $70k of fee volume of room (agent 177).
export function parseFractionBps(raw) {
  const text = raw === undefined ? "5000" : String(raw);
  if (!/^[0-9]{1,6}$/.test(text)) throw new Error(`--fraction-bps must be a whole number of basis points, got ${JSON.stringify(text)}`);
  const value = BigInt(text);
  if (value < 1n || value > MAX_FRACTION_BPS) {
    throw new Error(
      `--fraction-bps must be 1 to ${MAX_FRACTION_BPS}, got ${value}: the pair caps k at 64% of cap0 * cap1, so a seed of 80% of both caps sits exactly on that k ceiling (above it the seed reverts with K_CEILING). At the ceiling every swap fee stays outside the reserves, where anyone can take it with skim, so LPs and the Safe earn nothing. ${MAX_FRACTION_BPS} keeps k at 76.6% of the ceiling. See docs/OPS-INITIAL-LIQUIDITY.md`,
    );
  }
  return value;
}

export function planOpening({ wrapped, quote, totalSupply, price, fractionBps }) {
  if (typeof fractionBps !== "bigint" || fractionBps < 1n || fractionBps > MAX_FRACTION_BPS) parseFractionBps(String(fractionBps));
  if (price <= 0n) return { decision: "refuse", reason: "the price must be positive" };
  if (totalSupply !== 0n) return planWithShares({ wrapped, quote, totalSupply, price, fractionBps });
  const excess = [wrapped, quote].filter((s) => s.balance !== s.reserve);
  if (excess.length) {
    return { decision: "skim-first", reason: "an unsynced donation is in the pair: anyone may sync it into the reserves between this plan and the seed. Run skim, then plan again." };
  }
  if (isBricked({ totalSupply, sides: [wrapped, quote] })) {
    return { decision: "bricked", reason: "both reserves sit at their caps with no LP shares. mint and swap revert forever on this pair; deploy a new factory (DEX-09)." };
  }
  // Target pool: fraction of the tighter cap at the price (MAINNET-READINESS §3).
  let targetWrapped = (wrapped.cap * fractionBps) / 10_000n;
  let targetQuote = (targetWrapped * price) / WAD;
  const quoteLimit = (quote.cap * fractionBps) / 10_000n;
  if (targetQuote > quoteLimit) {
    targetQuote = quoteLimit;
    targetWrapped = (targetQuote * WAD) / price;
  }
  // A synced donation is part of the opening pool; it cannot be removed. Grow
  // the target until the deposit on both sides is positive and the ratio holds.
  const scaleNum = [wrapped.reserve * targetQuote, quote.reserve * targetWrapped].reduce((a, b) => (a > b ? a : b));
  const gift = wrapped.reserve !== 0n || quote.reserve !== 0n;
  if (gift && (wrapped.reserve >= targetWrapped || quote.reserve >= targetQuote)) {
    const denominator = targetWrapped * targetQuote;
    const grown = (scaleNum * 101n) / 100n; // 1% above the larger donation, so both deposits stay positive
    targetWrapped = (targetWrapped * grown) / denominator + 1n;
    targetQuote = (targetQuote * grown) / denominator + 1n;
  }
  if (targetWrapped > wrapped.cap || targetQuote > quote.cap) {
    return {
      decision: "refuse",
      reason: "the donation is too large for this price within the caps. The opening price cannot be reached by a deposit: if one side is below its cap a swap can take the free reserves first (see the runbook), otherwise use a new factory.",
    };
  }
  const depositWrapped = targetWrapped - wrapped.reserve;
  const depositQuote = targetQuote - quote.reserve;
  if (depositWrapped <= 0n || depositQuote <= 0n || isqrt(depositWrapped * depositQuote) <= MINIMUM_LIQUIDITY) {
    return { decision: "refuse", reason: "the deposit is too small to mint more than the 1000 locked shares" };
  }
  return { decision: "proceed", depositWrapped, depositQuote, poolWrapped: targetWrapped, poolQuote: targetQuote, donated: gift ? { wrapped: wrapped.reserve, quote: quote.reserve } : null };
}

/// Distance of the pool price from `price`, in basis points.
export function priceGapBps({ wrapped, quote, price }) {
  if (wrapped.reserve === 0n) return null;
  const pool = (quote.reserve * WAD) / wrapped.reserve;
  return ((pool > price ? pool - price : price - pool) * 10_000n) / price;
}

/// The depositor's recorded hashes plus `--tx a,b`, if the whole history checks out.
/// One call must name every unrecorded transaction: alone, each would leave a nonce
/// unlisted and be refused.
export async function checkNotedTxs(gate, txArg, request) {
  const deployment = deploymentFromGate(gate);
  const given = txArg.toLowerCase().split(",");
  for (const hash of given) if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`--tx: ${hash} is not a transaction hash`);
  const listed = [...new Set([...deployment.depositorTransactions, ...given])];
  const count = BigInt(await request("eth_getTransactionCount", [deployment.firstDepositor, "latest"]));
  await verifyDepositorHistory(
    { depositor: deployment.firstDepositor, count, transactions: listed, router: deployment.router.address, tokens: deployment.tokens.map((t) => t.token) },
    request,
  );
  return { listed, count };
}

async function load(args, request) {
  const deployment = deploymentFromGate(readGate(args.config));
  await checkIdentity(request, deployment);
  const pair = deployment.pairs.find((p) => p.token0 === deployment.wrapped.address || p.token1 === deployment.wrapped.address);
  if (!pair) throw new Error("no planned pair holds the wrapped native token");
  const latest = await readBlock(request, "latest");
  const at = blockRef(latest);
  const state = await readPair(request, pair, at);
  const wrappedIs0 = pair.token0 === deployment.wrapped.address;
  const [wrapped, quote] = wrappedIs0 ? state.sides : [state.sides[1], state.sides[0]];
  const decimals = Number(await call(request, quote.token, "decimals", [], at));
  return { deployment, pair, state, wrapped, quote, decimals, latest, price: parseUnits(args.price, decimals) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (command === "note-tx") {
    // A planned approve or seed already sent. It is recorded only if it checks out.
    if (!args.config || !args.rpc || !args.tx) {
      console.error("usage: dex-seed-plan.mjs note-tx --config <gate.json> --rpc <url> --tx <hash>[,<hash>...]");
      return UNKNOWN;
    }
    const request = createRequest(args.rpc);
    const gate = readGate(args.config);
    const { listed, count } = await checkNotedTxs(gate, args.tx, request);
    gate.deployment.depositorTransactions = listed;
    const temp = `${args.config}.tmp`;
    writeFileSync(temp, `${JSON.stringify(gate, null, 2)}\n`);
    renameSync(temp, args.config);
    console.log(stringify({ decision: "depositor-history-verified", nonce: count, depositorTransactions: listed }));
    return OK;
  }
  if (!["plan", "verify"].includes(command) || !args.config || !args.rpc || !args.price) {
    console.error("usage: dex-seed-plan.mjs plan|verify --config <gate.json> --rpc <url> --price <quote per wrapped> [--to <LP recipient, required by verify>] [--fraction-bps 5000, at most 7000] [--tolerance-bps 100]");
    return UNKNOWN;
  }
  // Refused before any read: a seed on the k ceiling is never a valid plan.
  const fractionBps = command === "plan" ? parseFractionBps(args["fraction-bps"]) : null;
  const request = createRequest(args.rpc);
  const { deployment, pair, state, wrapped, quote, decimals, latest, price } = await load(args, request);

  if (command === "verify") {
    if (!args.to) throw new Error("--to <LP recipient> is required: verify checks who holds the shares");
    const tolerance = BigInt(args["tolerance-bps"] ?? 100);
    const gap = priceGapBps({ wrapped, quote, price });
    const held = await call(request, pair.address, "balanceOf", [args.to], blockRef(latest));
    const ours = holdsSeed({ held, totalSupply: state.totalSupply });
    const pass = state.totalSupply !== 0n && gap !== null && gap <= tolerance && ours;
    console.log(stringify({
      decision: pass ? "seed-verified" : ours ? "seed-off-target" : "seed-not-ours",
      recipient: args.to,
      recipientShares: held,
      pair: pair.address,
      block: latest.number,
      poolPrice: wrapped.reserve === 0n ? null : formatUnits((quote.reserve * WAD) / wrapped.reserve, decimals),
      targetPrice: args.price,
      gapBps: gap,
      toleranceBps: tolerance,
      reserves: { wrapped: wrapped.reserve, quote: quote.reserve },
      totalSupply: state.totalSupply,
    }));
    return pass ? OK : CRIT;
  }

  // F1, limit L1: before the seed the depositor's key must be untouched and an EOA.
  if (state.totalSupply === 0n) {
    const used = BigInt(await request("eth_getTransactionCount", [deployment.firstDepositor, "latest"]));
    const depositorCode = await request("eth_getCode", [deployment.firstDepositor, "latest"]);
    let historyProblem = depositorCode === "0x" ? null : "the first depositor has code";
    if (!historyProblem && used !== 0n) {
      try {
        await verifyDepositorHistory(
          { depositor: deployment.firstDepositor, count: used, transactions: deployment.depositorTransactions, router: deployment.router.address, tokens: deployment.tokens.map((t) => t.token) },
          request,
        );
      } catch (error) {
        if (error instanceof RpcError) throw error;
        historyProblem = error.message;
      }
    }
    if (historyProblem) {
      console.log(stringify({ decision: "refuse", firstDepositor: deployment.firstDepositor, nonce: used, detail: historyProblem, reason: "the first depositor must be a fresh EOA with nonce 0 before the seed, or its history must be only planned approves and seeds. If the unlisted transaction is your own approve or seed from an earlier plan, record it with note-tx and plan again. Anything else means the key is spent and the factory must be redeployed; see OPS-INITIAL-LIQUIDITY.md" }));
      return CRIT;
    }
  }
  const plan = planOpening({ wrapped, quote, totalSupply: state.totalSupply, price, fractionBps });
  if (plan.decision === "skim-first") {
    console.log(stringify({ ...plan, pair: pair.address, excess: { wrapped: wrapped.balance - wrapped.reserve, quote: quote.balance - quote.reserve } }));
    return WARN;
  }
  if (plan.decision === "correct-price") {
    if (!args.to) throw new Error("--to <recipient of the swap output> is required");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * Number(args["deadline-min"] ?? 60));
    const steps = plan.sellWrapped
      ? [{ description: "sell BLCH to the target price", to: deployment.router.address, value: plan.amountIn, data: encode("swapExactBLCHForTokens", [plan.amountOutMin, [wrapped.token, quote.token], args.to, deadline]), deadline }]
      : [
          { description: "approve the router for the quote token", to: quote.token, value: "0", data: encode("approve", [deployment.router.address, plan.amountIn]) },
          { description: "sell the quote token to the target price", to: deployment.router.address, value: "0", data: encode("swapExactTokensForBLCH", [plan.amountIn, plan.amountOutMin, [quote.token, wrapped.token], args.to, deadline]), deadline },
        ];
    console.log(stringify({ ...plan, pair: pair.address, block: latest.number, targetPrice: args.price, steps }));
    return WARN;
  }
  if (plan.decision !== "proceed" && plan.decision !== "top-up") {
    console.log(stringify({ ...plan, pair: pair.address, reserves: { wrapped: wrapped.reserve, quote: quote.reserve }, caps: { wrapped: wrapped.cap, quote: quote.cap } }));
    return CRIT;
  }
  if (!args.to) throw new Error("--to <LP recipient> is required");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * Number(args["deadline-min"] ?? 60));
  const seeding = state.totalSupply === 0n;
  const allowance = seeding ? await call(request, quote.token, "allowance", [deployment.firstDepositor, deployment.router.address], blockRef(latest)) : 0n;
  const enoughAllowance = seeding && allowance >= plan.depositQuote;
  // On a fresh pair the minimums equal the deposit. A top-up follows the pool's ratio.
  const topUp = plan.decision === "top-up";
  const seedCall = encode("addLiquidityBLCH", [quote.token, plan.depositQuote, topUp ? (plan.depositQuote * 99n) / 100n : plan.depositQuote, topUp ? (plan.depositWrapped * 99n) / 100n : plan.depositWrapped, args.to, deadline]);
  const liquidity = topUp ? (plan.depositWrapped * state.totalSupply) / wrapped.reserve : isqrt(plan.depositWrapped * plan.depositQuote) - MINIMUM_LIQUIDITY;
  const steps = [
    {
      description: enoughAllowance ? "skipped: the router's allowance from the earlier approve is enough (a harmless repeat would use the key again)" : "approve the router for the quote token",
      ...(enoughAllowance ? { skip: true } : {}),
      to: quote.token,
      value: "0",
      data: encode("approve", [deployment.router.address, plan.depositQuote]),
    },
    { description: "seed (the minimums equal the deposit; on a fresh pair they do not protect the ratio, verify does)", to: deployment.router.address, value: plan.depositWrapped, data: seedCall, deadline },
  ];
  let txsFile;
  if (args["write-txs"]) txsFile = await writeSeedTxs(args["write-txs"], readGate(args.config), deployment, steps, request);
  console.log(stringify({
    ...plan,
    pair: pair.address,
    block: latest.number,
    targetPrice: args.price,
    human: {
      wrapped: formatUnits(plan.depositWrapped, 18),
      quote: formatUnits(plan.depositQuote, decimals),
      poolWrapped: formatUnits(plan.poolWrapped, 18),
      poolQuote: formatUnits(plan.poolQuote, decimals),
    },
    expectedLiquidity: liquidity,
    from: state.totalSupply === 0n ? deployment.firstDepositor : undefined,
    steps,
    ...(txsFile ? { txsFile } : {}),
  }));
  return OK;
}

// Gas limits about 1.5 times the gas measured on anvil (approve 46k, seed 283k).
const SEED_GAS = { approve: 100_000n, seed: 400_000n };

/// The plan's unskipped steps as an unsigned-transaction file for
/// scripts/staging/sign-and-publish.sh, from the first depositor at its latest
/// nonce. Its `configSha256` is the SHA-256 of the steps, which the signer's
/// --confirm must repeat. Only for the seed itself (the depositor sends it).
async function writeSeedTxs(file, gate, deployment, steps, request) {
  if (existsSync(file)) throw new Error(`${file} exists; write a new file for every plan`);
  const from = deployment.firstDepositor;
  let nonce = BigInt(await request("eth_getTransactionCount", [from, "latest"]));
  const transactions = [];
  for (const [i, step] of steps.entries()) {
    if (step.skip) continue;
    const label = i === 0 ? "approve" : "seed";
    transactions.push({ label, nonce: (nonce++).toString(), to: step.to, data: step.data, value: String(step.value), gasLimit: SEED_GAS[label].toString(), expect: null });
  }
  const sha = `0x${createHash("sha256").update(JSON.stringify(transactions)).digest("hex")}`;
  const out = { schemaVersion: 1, domain: "postern.dex.raw-txs.v1", chainId: gate.chain.id, genesisHash: gate.chain.genesisHash, from, configSha256: sha, transactions };
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });
  return { file, configSha256: sha, count: transactions.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`dex-seed-plan: ${error.message}`);
      process.exit(error instanceof RpcError ? UNKNOWN : CRIT);
    },
  );
}
