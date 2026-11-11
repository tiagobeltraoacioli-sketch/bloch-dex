// Invariants of the skim keeper under a lossy but honest node (round 15 review, agent 309), and the regression
// test of its finding R309-K2. KEEPER_SIM_SEEDS sets the number of seeds (default 8; the review ran 40).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, runKeeper } from "./dex-skim-keeper.mjs";
import { keeperNeedsReconciliation } from "./keeper-accounting.mjs";
import { ABI } from "./dex-ops-lib.mjs";
import { CAP1, KEEPER, PAIR, SAFE, account, gate, mulberry32, signer, simNode } from "./keeper-sim.mjs";
import { CRIT } from "./dex-ops-lib.mjs";
import { keeperWindowSpend } from "./keeper-accounting.mjs";
import { createRequire } from "node:module";

const { decodeFunctionData } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");

const options = (extra = {}) => ({
  keeper: account.address, execute: true, budgetWei: DEFAULTS.budgetWei, maxTx: DEFAULTS.maxTx, maxFeeWei: DEFAULTS.maxFeeWei,
  tipWei: DEFAULTS.tipWei, maxGas: DEFAULTS.maxGas, floorBps: DEFAULTS.floorBps, cooldownSeconds: DEFAULTS.cooldownSeconds,
  pendingTimeoutSeconds: DEFAULTS.pendingTimeoutSeconds, maxTipWei: DEFAULTS.maxTipWei, softShareBps: DEFAULTS.softShareBps,
  hardReserveBps: DEFAULTS.hardReserveBps, maxClockSkewSeconds: DEFAULTS.maxClockSkewSeconds, ...extra,
});

export async function simulate(seed, { passes = 600, step = 300, node: nodeOptions = {}, keeper: keeperOptions = {} } = {}) {
  const rand = mulberry32(seed);
  const node = simNode(rand, nodeOptions);
  let state = { schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 };
  const outcomes = [];
  let time = node.chain.time;
  for (let i = 0; i < passes; i++) {
    time += step;
    node.mineBlock(time);
    const saved = [];
    const outcome = await runKeeper(gate, options(keeperOptions), state, {
      request: node.request, sign: signer, now: time, save: (s) => saved.push(JSON.stringify(s)),
      random: (n) => BigInt(Math.floor(rand() * Number(n))),
    });
    // The next pass starts from the file, as the real keeper does.
    if (saved.length) state = JSON.parse(saved.at(-1));
    outcomes.push({ time, action: outcome.action, level: outcome.level, reason: outcome.reason });
  }
  return { node, state, outcomes };
}

export function checkInvariants({ node, state }, o = options()) {
  const { chain } = node;
  // 1. Everything ever handed to the node is the keeper's skim(Safe) on the pinned pair, inside the ceilings.
  for (const { tx } of chain.handed) {
    const call = decodeFunctionData({ abi: ABI, data: tx.data });
    assert.equal(tx.to.toLowerCase(), PAIR);
    assert.equal(call.functionName, "skim");
    assert.equal(call.args[0].toLowerCase(), SAFE);
    assert.ok(tx.maxFeePerGas <= o.maxFeeWei && tx.maxPriorityFeePerGas <= o.maxTipWei && tx.gas <= o.maxGas);
  }
  // 2. One nonce at a time: a nonce is first published only when every earlier nonce is finalized.
  const firstSeen = new Map();
  for (const h of chain.handed) if (!firstSeen.has(h.nonce)) firstSeen.set(h.nonce, h);
  for (const [nonce, h] of firstSeen) assert.ok(h.finalizedNonce >= nonce, `nonce ${nonce} was signed while nonce ${h.finalizedNonce} was not final`);
  // 3. Real spend and real count in every rolling 24 h window of block time stay inside the budget.
  for (const a of chain.mined) {
    const window = chain.mined.filter((m) => m.timestamp >= a.timestamp && m.timestamp < a.timestamp + 86_400);
    const spent = window.reduce((s, m) => s + m.spentWei, 0n);
    assert.ok(spent <= o.budgetWei, `window from ${a.timestamp}: ${spent} wei spent`);
    assert.ok(window.length <= o.maxTx, `window from ${a.timestamp}: ${window.length} transactions`);
  }
  // 4. The state file agrees with the chain: every mined transaction that is final is recorded at its real cost.
  const final = chain.mined.filter((m) => m.block <= chain.finalized);
  for (const m of final) {
    // A refused first publication can share its hash with a later identical signing (deterministic signatures).
    const entry = state.txs.find((t) => t.hash === m.hash && t.status !== "refused");
    if (!entry) continue; // pruned from the window
    if (!keeperNeedsReconciliation(entry)) assert.equal(entry.spentWei, m.spentWei.toString());
  }
  return { handed: chain.handed.length, mined: chain.mined.length, effective: chain.mined.filter((m) => m.effective).length };
}

const SEEDS = Number(process.env.KEEPER_SIM_SEEDS ?? 8);

test(`sim: ${SEEDS} seeds x 600 passes (50 h each) under a lossy honest node keep every invariant`, async () => {
  const totals = { handed: 0, mined: 0, effective: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const run = await simulate(seed);
    const t = checkInvariants(run);
    for (const k of Object.keys(totals)) totals[k] += t[k];
    const bad = run.outcomes.find((x) => ["rpc-failed", "refused", "simulation-reverted"].includes(x.action));
    assert.equal(bad, undefined, `seed ${seed}: ${JSON.stringify(bad)}`);
    // The pass stamp is the last pass.
    assert.equal(run.state.lastPass.at, run.outcomes.at(-1).time);
    assert.equal(run.state.lastPass.action, run.outcomes.at(-1).action);
  }
  assert.ok(totals.mined > 2 * SEEDS, JSON.stringify(totals));
});

// R309-K2: a publication the node refused used one of the 48 transactions of the 24 h count each time, and a hard
// closure skips the cooldown, so four hours of refusals left the keeper at tx-count-exhausted (CRIT) for 19 hours
// after the node accepted again. Since the round 15 change a refused first publication stays ONE open entry and
// every retry is a replacement at its nonce: the count never moves, and the first accepted retry clears the closure.
test("R309-K2: under a hard closure, hours of refused publications use one place of the 24 h count, and the keeper sends as soon as the node accepts", async () => {
  const rand = mulberry32(7);
  // A node that refuses every publication with a quote above the keeper's tip ceiling (8 gwei).
  const hard = { reserves: [250_375_564n, CAP1], excessBalances: [250_375_564n, CAP1 + 2n * 10n ** 18n], accept: 0, acceptLostReply: 0, silentDrop: 0, redonate: 1, quoteMin: 9_000_000_000n, quoteMax: 9_500_000_000n };
  const node = simNode(rand, hard);
  let state = { schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 };
  let time = node.chain.time;
  const pass = async () => {
    time += 300; // the unit's timer
    node.mineBlock(time);
    const saved = [];
    const outcome = await runKeeper(gate, options(), state, { request: node.request, sign: signer, now: time, save: (s) => saved.push(JSON.stringify(s)), random: () => 0n });
    if (saved.length) state = JSON.parse(saved.at(-1));
    return outcome;
  };
  const outcomes = [];
  for (let i = 0; i < 48; i++) outcomes.push(await pass());
  assert.deepEqual([...new Set(outcomes.map((o) => o.action))].sort(), ["publish-refused", "wait-in-flight"]);
  // The operator is told every time a signature was refused: the quote is above the ceilings.
  assert.ok(outcomes.filter((o) => o.action === "publish-refused").every((o) => o.level === CRIT));
  // Spaced by the re-publication interval (900 s), not signed on every 5-minute pass.
  assert.ok(outcomes.filter((o) => o.action === "publish-refused").length <= 17, String(outcomes.filter((o) => o.action === "publish-refused").length));
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].refusedFirst, true);
  assert.equal(new Set(node.chain.handed.map((h) => h.nonce)).size, 1);
  // One reservation, whatever the number of refusals.
  assert.equal(keeperWindowSpend(state, time), BigInt(state.txs[0].reservedWei));
  // The node accepts from now on: the closure is cleared within one re-publication interval.
  Object.assign(node.prob, { accept: 1, redonate: 0 });
  const after = [];
  for (let i = 0; i < 4 && !after.some((o) => o.action === "replaced"); i++) after.push(await pass());
  assert.equal(after.at(-1).action, "replaced", JSON.stringify(after.map((o) => o.action)));
  assert.ok(!after.some((o) => o.action === "tx-count-exhausted"));
  for (let i = 0; i < 40 && node.chain.mined.length === 0; i++) await pass();
  assert.equal(node.chain.mined.length, 1);
  checkInvariants({ node, state });
});
