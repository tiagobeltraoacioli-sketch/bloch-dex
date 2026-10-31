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
//        --price 25.5 --to 0x<LP recipient> [--fraction-bps 5000] [--deadline-min 60]
//   node scripts/ops/dex-seed-plan.mjs verify --config gate.json --rpc URL
//        --price 25.5 [--tolerance-bps 100]

import { pathToFileURL } from "node:url";
import {
  CRIT, OK, RpcError, UNKNOWN, WARN,
  blockRef, call, checkIdentity, createRequest, deploymentFromGate, encode, formatUnits, isBricked, isqrt,
  parseArgs, parseUnits, readBlock, readGate, readPair, stringify,
} from "./dex-ops-lib.mjs";

const WAD = 10n ** 18n;
const MINIMUM_LIQUIDITY = 1000n;

/// The pure part of `plan`. `wrapped` and `quote` are pair sides; `price` is in
/// quote base units per 1e18 wrapped base units.
export function planOpening({ wrapped, quote, totalSupply, price, fractionBps }) {
  if (totalSupply !== 0n) return { decision: "refuse", reason: "the pair already has LP shares; this is not an opening deposit" };
  if (price <= 0n) return { decision: "refuse", reason: "the price must be positive" };
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
  if (!["plan", "verify"].includes(command) || !args.config || !args.rpc || !args.price) {
    console.error("usage: dex-seed-plan.mjs plan|verify --config <gate.json> --rpc <url> --price <quote per wrapped> [--to <LP recipient>] [--fraction-bps 5000] [--tolerance-bps 100]");
    return UNKNOWN;
  }
  const { deployment, pair, state, wrapped, quote, decimals, latest, price } = await load(args, createRequest(args.rpc));

  if (command === "verify") {
    const tolerance = BigInt(args["tolerance-bps"] ?? 100);
    const gap = priceGapBps({ wrapped, quote, price });
    const pass = state.totalSupply !== 0n && gap !== null && gap <= tolerance;
    console.log(stringify({
      decision: pass ? "seed-verified" : "seed-off-target",
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

  const plan = planOpening({ wrapped, quote, totalSupply: state.totalSupply, price, fractionBps: BigInt(args["fraction-bps"] ?? 5000) });
  if (plan.decision === "skim-first") {
    console.log(stringify({ ...plan, pair: pair.address, excess: { wrapped: wrapped.balance - wrapped.reserve, quote: quote.balance - quote.reserve } }));
    return WARN;
  }
  if (plan.decision !== "proceed") {
    console.log(stringify({ ...plan, pair: pair.address, reserves: { wrapped: wrapped.reserve, quote: quote.reserve }, caps: { wrapped: wrapped.cap, quote: quote.cap } }));
    return CRIT;
  }
  if (!args.to) throw new Error("--to <LP recipient> is required");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * Number(args["deadline-min"] ?? 60));
  const seedCall = encode("addLiquidityBLCH", [quote.token, plan.depositQuote, plan.depositQuote, plan.depositWrapped, args.to, deadline]);
  const liquidity = isqrt(plan.depositWrapped * plan.depositQuote) - MINIMUM_LIQUIDITY;
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
    steps: [
      { description: "approve the router for the quote token", to: quote.token, value: "0", data: encode("approve", [deployment.router.address, plan.depositQuote]) },
      { description: "seed (the minimums equal the deposit; on a fresh pair they do not protect the ratio, verify does)", to: deployment.router.address, value: plan.depositWrapped, data: seedCall, deadline },
    ],
  }));
  return OK;
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
