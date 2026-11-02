#!/usr/bin/env node
// Read-only model, no network and no key: node scripts/ops/dex-ceiling-capture-model.mjs
// Table source for docs/OPS-DEX-MONITOR-KEEPER.md "The ceiling floor".
// Agent 196: who collects fee excess at the k ceiling, keeper (to the Safe) or a bot.
// Model, deliberately simple and stated in the report:
// - P = 100 (bUSDC per BLCH), pool at the ceiling; ordinary router swaps leave their 0.3%
//   fee as excess (177: a skimmer after every swap takes 98.7% of fees; we use 100%).
// - Arbitrage at the ceiling is swap+skim in one transaction (177 section 4): its fee is
//   refunded atomically and reaches nobody else, so it is left out of the excess here.
// - One L2 block every 10 minutes (144 a day). Swaps: daily volume V in swaps of $8.73
//   (177's mean: $2,618 / 300), Poisson-ish split over blocks with a seeded RNG.
// - After each block both actors see the excess. The bot sends when excess >= its
//   threshold; the keeper sends when excess >= its floor, its 30 min cooldown is over and it
//   has count left (36 non-reserved of 48). If both send, the higher tip lands first and
//   takes everything; the other's skim moves nothing (wasted; the keeper then backs off 2x,
//   4x ... the cooldown, capped at 6 h, and doubles its tip range up to 8 gwei).
// - Keeper tip: uniform in [1, 2^(wasted+1)] gwei, capped at 8 (DEFAULTS + nextTip).
// - Gas: 77k per skim, base fee 1 gwei (launch); cost = 77k * (1 + tip) gwei.
const P = 100;
const GAS = 77_000;
const BASE = 1; // gwei
const FEE = 0.003;
const MEAN = 2618 / 300;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function run({ volume, floorUsd, bot, days = 30, seed = 196 }) {
  const r = rng(seed);
  let excess = 0, safe = 0, botTake = 0, keeperGasUsd = 0, total = 0, sent = 0, wasted = 0;
  let nextAllowed = 0, lastTx = -1e9, txTimes = [];
  const blocks = 144 * days;
  for (let b = 0; b < blocks; b++) {
    const t = b * 600;
    const perBlock = volume / 144;
    // Swaps in this block: draw a count with mean perBlock / MEAN.
    let v = 0; const n = perBlock / MEAN;
    let k = Math.floor(n) + (r() < n - Math.floor(n) ? 1 : 0);
    for (let i = 0; i < k; i++) v += MEAN * (0.4 + 1.2 * r());
    excess += v * FEE; total += v * FEE;
    txTimes = txTimes.filter((x) => t - x < 86_400);
    const keeperWants = excess >= floorUsd && t >= nextAllowed && t - lastTx >= 1800 && txTimes.length < 36;
    const botWants = bot && excess >= bot.threshold;
    if (!keeperWants && !botWants) continue;
    let keeperTip = 0;
    if (keeperWants) {
      const top = Math.min(2 ** (wasted + 1), 8);
      keeperTip = 1 + r() * (top - 1);
      keeperGasUsd += (GAS * (BASE + keeperTip) * 1e-9) * P;
      txTimes.push(t); lastTx = t; sent++;
    }
    const keeperFirst = keeperWants && (!botWants || keeperTip > bot.tip);
    if (keeperFirst) { safe += excess; wasted = 0; }
    else {
      botTake += excess;
      if (keeperWants) { wasted++; nextAllowed = t + Math.min(1800 * 2 ** wasted, 6 * 3600); }
    }
    excess = 0;
  }
  return { total, safe, bot: botTake, left: excess, keeperGasUsd, sent };
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "-");
const floors = [["1% of a cap (old, $10)", 10], ["budget/48 (new, 0.00104 BLCH = $0.104)", 0.104]];
const bots = [
  ["no bot", null],
  ["lazy bot, skims from $1, 1 gwei tip", { threshold: 1, tip: 1 }],
  ["break-even bot, from its gas ($0.0154), 1 gwei tip", { threshold: 0.0154, tip: 1 }],
  ["break-even bot, 3 gwei tip (outbids the keeper until its tip range climbs)", { threshold: 0.031, tip: 3 }],
  ["bot always above 8 gwei", { threshold: 0.07, tip: 9 }],
];
console.log("| Daily ceiling volume | Keeper floor | Competitor | Fees as excess (30 d) | Safe | Bots | Keeper gas | Keeper tx/day |");
console.log("|---|---|---|---:|---:|---:|---:|---:|");
for (const volume of [1000, 5000, 20000]) for (const [fl, floorUsd] of floors) for (const [bl, bot] of bots) {
  const o = run({ volume, floorUsd, bot });
  console.log(`| $${volume.toLocaleString("en-US")} | ${fl} | ${bl} | $${o.total.toFixed(0)} | ${pct(o.safe, o.total)} | ${pct(o.bot, o.total)} | $${o.keeperGasUsd.toFixed(2)} | ${(o.sent / 30).toFixed(1)} |`);
}
