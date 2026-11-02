#!/usr/bin/env node
// Griefer versus keeper on a private L2: blocks are built by the real selector, so the order
// is the L2's own (highest effective tip first, ties by lowest hash, one sender in nonce
// order). Finality is synthetic. Throwaway keys only. Prints JSON lines.
//   PRODUCE_DEV=… SETTLED_RPC=… BUSDC_ARTIFACT=… KEEPER=<script> node race.mjs WORK PORT [scene…]
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Net, World, BLCH, USD, DEADLINE, ROOT, big, data, fmt, getOut, sleep, gwei } from "./net.mjs";
import { isClosedByExcess, readPair, createRequest, deploymentFromGate } from "../dex-ops-lib.mjs";

const [work, port, ...wanted] = process.argv.slice(2);
const run = promisify(execFile);
const env = process.env;
const KEEPER = env.KEEPER ?? join(ROOT, "scripts/ops/dex-skim-keeper.mjs");
const out = (scene, rec) => console.log(big({ scene, ...rec }));
const money = (w, wei) => fmt(wei, 18);

const net = new Net("private-l2", work, Number(port));
const names = ["deployer", "signer", "guardian", "depositor", "griefer", "keeper", "safe", "user", "thief", "attacker", "victim", "arber"];
const A = Object.fromEntries(names.map((n) => [n, net.actor(n)]));
const busdc = JSON.parse(readFileSync(env.BUSDC_ARTIFACT, "utf8"));
const busdcArtifact = { abi: busdc.abi, bytecode: busdc.bytecode.object };
await net.start(Object.values(A), env);
process.on("exit", () => net.stop());

async function newWorld(aw = 5n * BLCH, aq = 500n * USD) {
  const w = new World(net, A, busdcArtifact);
  await w.deploy();
  await w.seed(aw, aq);
  return w;
}
const lib = createRequest(net.url, { allowed: ["eth_call", "eth_getBlockByNumber"] });
const closed = async (w) => isClosedByExcess(await readPair(lib, w.pairRef(), "latest"));

/// Smallest donation to one side that makes isClosedByExcess true, by bisection on the kit's own test.
function minClose(s, w, side) {
  const st = (extra) => ({
    totalSupply: 1n,
    sides: w.wFirst
      ? [{ reserve: s.rw, balance: s.bw + (side === "w" ? extra : 0n), cap: w.capW }, { reserve: s.rq, balance: s.bq + (side === "q" ? extra : 0n), cap: w.capQ }]
      : [{ reserve: s.rq, balance: s.bq + (side === "q" ? extra : 0n), cap: w.capQ }, { reserve: s.rw, balance: s.bw + (side === "w" ? extra : 0n), cap: w.capW }],
  });
  let hi = (side === "w" ? w.capW : w.capQ) * 2n;
  if (!isClosedByExcess(st(hi))) return null;
  let lo = 0n;
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (isClosedByExcess(st(m))) hi = m;
    else lo = m;
  }
  return hi;
}

async function keeperRun(gatePath, state, extra = []) {
  const args = [KEEPER, "--config", gatePath, "--rpc", net.url, "--keeper", A.keeper.address, "--state", state, "--execute", ...extra, "--", "--private-key", A.keeper.key];
  try {
    const { stdout } = await run(process.execPath, args);
    return { exit: 0, ...JSON.parse(stdout) };
  } catch (e) {
    let body = {};
    try { body = JSON.parse(e.stdout); } catch { body = { raw: `${e.stdout}${e.stderr}` }; }
    return { exit: e.code, ...body };
  }
}
const pendingNonce = async (a) => BigInt(await net.rpc("eth_getTransactionCount", [a.address, "pending"]));
const latestNonce = async (a) => BigInt(await net.rpc("eth_getTransactionCount", [a.address, "latest"]));
const syncNonce = async (a) => { a.nonce = await pendingNonce(a); };

/// Pool with WBLCH exactly at its cap (a 4x fall from 100, or the griefer's own swap).
async function atWCap(w) {
  await w.fund(A.griefer, 12n * BLCH, 300n * USD);
  const s = await w.state();
  await net.must(await A.griefer.send(w.router, w.swapData(true, w.capW - s.rw, 0n, A.griefer.address), { gas: 500_000n }));
  return w.state();
}

// Griefer wins every race until the keeper stops. The griefer sees only the keeper's pending nonce.
async function raceWin() {
  const scene = "race-win";
  const w = await newWorld();
  const s = await atWCap(w);
  const need = minClose(s, w, "w");
  out(scene, { state: s, minCloseW: need, minCloseUSD_pool: fmt((need * s.rq) / s.rw, 6) });
  const d = need + need / 50n;
  const gate = join(work, `gate-${scene}.json`);
  await w.gate(gate);
  const state = join(work, `keeper-${scene}.json`);
  rmSync(state, { force: true });
  const before = { griefW: await net.read(w.w, "balanceOf", [A.griefer.address]), griefPaid: A.griefer.paid };
  await syncNonce(A.keeper);
  for (let round = 1; round <= 40; round++) {
    const donate = await net.must(await A.griefer.send(w.w, data("transfer", [w.pair, d]), { tip: 2, gas: 100_000n }));
    const isClosed = await closed(w);
    const nonce0 = await pendingNonce(A.keeper);
    const k = await keeperRun(gate, state);
    if (k.action !== "sent") {
      out(scene, { round, closed: isClosed, keeperAction: k.action, keeperExit: k.exit, detail: k.detail, level: k.level, maxTx: k.maxTx, spent: k.spentWei });
      break;
    }
    // The griefer's only signal: a pending nonce moved. Calldata is not visible.
    let signal = false;
    for (let i = 0; i < 50 && !signal; i++) { signal = (await pendingNonce(A.keeper)) > nonce0; if (!signal) await sleep(100); }
    const counter = await A.griefer.send(w.pair, data("skim", [A.griefer.address]), { tip: 3, gas: 150_000n });
    const r = await net.must([counter]);
    const kr = await net.rpc("eth_getTransactionReceipt", [k.hash]);
    A.keeper.paid += BigInt(kr.gasUsed) * BigInt(kr.effectiveGasPrice);
    const after = await keeperRun(gate, state); // Reconcile; nothing else to do with the pair open.
    out(scene, { round, closed: isClosed, signal, order: [`griefer@${r[0].index}`, `keeper@${Number(kr.transactionIndex)}`], sameBlock: r[0].block === Number(kr.blockNumber), keeperStatus: kr.status, keeperGas: Number(kr.gasUsed), griefDonateGas: donate.gas, griefSkimGas: r[0].gas, afterAction: after.action, reopened: !(await closed(w)) });
  }
  const st = JSON.parse(readFileSync(state, "utf8"));
  const statuses = st.txs.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {});
  const griefW = await net.read(w.w, "balanceOf", [A.griefer.address]);
  out(scene, {
    summary: true, keeperTx: st.txs.length, statuses, keeperPaidBLCH: fmt(A.keeper.paid, 18),
    griefPaidBLCH: fmt(A.griefer.paid - before.griefPaid, 18), griefCapitalChangeW: fmt(griefW - before.griefW, 18), donationEachW: fmt(d, 18),
    closedNow: await closed(w), excessW: fmt((await w.state()).xw, 18),
  });
  // The pair is closed and the keeper is out. What passes now?
  await syncNonce(A.user);
  await w.fund(A.user, 1n * BLCH, 100n * USD);
  const swaps = [];
  for (const [label, sellW, amt] of [["into WBLCH 0.1% of cap", true, w.capW / 1000n], ["out of WBLCH, 1 bUSDC (0.1% of cap)", false, 1n * USD], ["out of WBLCH, 2 bUSDC", false, 2n * USD], ["out of WBLCH, 10 bUSDC", false, 10n * USD]]) {
    swaps.push({ label, why: await net.why(A.user.address, w.router, w.swapData(sellW, amt, 0n, A.user.address)) });
  }
  out(scene, { closedSwaps: swaps });
  const thiefBefore = await net.read(w.w, "balanceOf", [A.thief.address]);
  const t = await net.must(await A.thief.send(w.pair, data("skim", [A.thief.address]), { gas: 150_000n }));
  out(scene, { thirdPartySkim: true, gas: t.gas, gotW: fmt((await net.read(w.w, "balanceOf", [A.thief.address])) - thiefBefore, 18), closedAfter: await closed(w) });
}

// The keeper wins when the griefer's tip is lower: the donation goes to the Safe.
async function raceLose() {
  const scene = "race-lose";
  const w = await newWorld();
  const s = await atWCap(w);
  const d = minClose(s, w, "w") + 1000n;
  const gate = join(work, `gate-${scene}.json`);
  await w.gate(gate);
  const state = join(work, `keeper-${scene}.json`);
  rmSync(state, { force: true });
  await net.must(await A.griefer.send(w.w, data("transfer", [w.pair, d]), { tip: 2, gas: 100_000n }));
  const safeBefore = await net.read(w.w, "balanceOf", [A.safe.address]);
  const k = await keeperRun(gate, state);
  const counter = await A.griefer.send(w.pair, data("skim", [A.griefer.address]), { tip: 0.5, gas: 150_000n });
  const r = await net.must([counter]);
  const kr = await net.rpc("eth_getTransactionReceipt", [k.hash]);
  out(scene, { keeper: k.action, keeperIndex: Number(kr.transactionIndex), griefIndex: r[0].index, sameBlock: Number(kr.blockNumber) === r[0].block, safeGotW: fmt((await net.read(w.w, "balanceOf", [A.safe.address])) - safeBefore, 18), donationW: fmt(d, 18), griefSkimGas: r[0].gas });
}

// Hold the pair closed through a block: skim above the keeper, re-donate below or above it.
async function bundle() {
  const scene = "same-block-bundle";
  for (const [variant, donateTip, withUser] of [["re-donate below the keeper, no user", 0.1, false], ["re-donate below the keeper, user at the keeper's tip", 0.1, true], ["re-donate above the keeper, no user", 2, false], ["re-donate above the keeper, user at a lower tip", 2, true]]) {
    const w = await newWorld();
    const s = await atWCap(w);
    const d = minClose(s, w, "w") + 1000n;
    const gate = join(work, `gate-${scene}.json`);
    await w.gate(gate);
    const state = join(work, `keeper-${scene}.json`);
    rmSync(state, { force: true });
    await syncNonce(A.user);
    await syncNonce(A.keeper);
    await w.fund(A.user, 1n * BLCH, 100n * USD);
    await net.must(await A.griefer.send(w.w, data("transfer", [w.pair, d]), { tip: 2, gas: 100_000n }));
    const k = await keeperRun(gate, state, ["--max-tx", "50"]);
    const list = [
      await A.griefer.send(w.pair, data("skim", [A.griefer.address]), { tip: 3, gas: 150_000n }),
      await A.griefer.send(w.w, data("transfer", [w.pair, d]), { tip: donateTip, gas: 100_000n }),
    ];
    // A small user swap that the closure would stop, out of the full side.
    if (withUser) list.push(await A.user.send(w.router, w.swapData(false, 1n * USD, 0n, A.user.address), { tip: donateTip > 1 ? 0.5 : 1, gas: 400_000n }));
    const safe0 = await net.read(w.w, "balanceOf", [A.safe.address]);
    const r = await net.settle(list);
    const kr = k.hash ? await net.rpc("eth_getTransactionReceipt", [k.hash]) : null;
    const order = [...r.map((x) => [x.index, `${x.who}:${x.status ? "ok" : "reverted"}`]), ...(kr ? [[Number(kr.transactionIndex), "keeper"]] : [])].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    out(scene, { variant, keeper: k.action, order, closedAfter: await closed(w), safeGotW: fmt((await net.read(w.w, "balanceOf", [A.safe.address])) - safe0, 18), griefGas: r.filter((x) => x.who === "griefer").reduce((n, x) => n + x.gas, 0) });
  }
}

// A sized bracket by tip.
function bestFront(V, min, rIn, rOut) {
  let lo = 0n, hi = rIn;
  while (hi - lo > 1n) {
    const x = (lo + hi) / 2n;
    const o = getOut(x, rIn, rOut);
    if (getOut(V, rIn + x, rOut - o) >= min) lo = x;
    else hi = x;
  }
  return lo;
}

async function bracketRow(cfg) {
  const scene = "bracket";
  const { victimUSD, slipBps, guessUSD, guessSlipBps = slipBps, ceiling, wrongWay } = cfg;
  const w = ceiling ? await newWorld(8n * BLCH, 800n * USD) : await newWorld();
  await w.fund(A.attacker, 3n * BLCH, 600n * USD);
  await w.fund(A.victim, 3n * BLCH, 500n * USD);
  const s = await w.state();
  const V = BigInt(victimUSD) * USD;
  const quote = getOut(V, s.rq, s.rw);
  const min = (quote * BigInt(10_000 - slipBps)) / 10_000n;
  // Sized on what the attacker believes.
  const believedV = BigInt(guessUSD ?? victimUSD) * USD;
  const believedMin = (getOut(believedV, s.rq, s.rw) * BigInt(10_000 - guessSlipBps)) / 10_000n;
  const x = (bestFront(believedV, believedMin, s.rq, s.rw) * 98n) / 100n;
  const q0 = await net.read(w.q, "balanceOf", [A.attacker.address]);
  const w0 = await net.read(w.w, "balanceOf", [A.attacker.address]);
  const paid0 = A.attacker.paid;
  const front = getOut(x, s.rq, s.rw);
  const f = await A.attacker.send(w.router, w.swapData(false, x, 0n, A.attacker.address), { tip: 3, gas: 400_000n });
  const v = wrongWay
    ? await A.victim.send(w.router, w.swapData(true, (V * BLCH) / (100n * USD), 0n, A.victim.address), { tip: 1, gas: 400_000n })
    : await A.victim.send(w.router, w.swapData(false, V, min, A.victim.address), { tip: 1, gas: 400_000n });
  const b = await A.attacker.send(w.router, w.swapData(true, front, 0n, A.attacker.address), { tip: 0.5, gas: 400_000n });
  const list = [f, v, b];
  if (ceiling) list.push(await A.attacker.send(w.pair, data("skim", [A.attacker.address]), { tip: 0.2, gas: 150_000n }));
  const r = await net.settle(list);
  const vr = r.find((x) => x.who === "victim");
  const q1 = await net.read(w.q, "balanceOf", [A.attacker.address]);
  const w1 = await net.read(w.w, "balanceOf", [A.attacker.address]);
  const gasBLCH = fmt(A.attacker.paid - paid0, 18);
  const dq = fmt(q1 - q0, 6);
  const dw = fmt(w1 - w0, 18);
  const price = 100; // BLCH at the opening price, for the gas line only.
  const atEnd = await w.state();
  const poolPrice = Number(atEnd.rq) / 1e6 / (Number(atEnd.rw) / 1e18);
  out(scene, {
    ceiling: !!ceiling, victimUSD, slipBps, guessUSD: guessUSD ?? victimUSD, wrongWay: !!wrongWay, frontUSD: fmt(x, 6),
    order: r.map((t) => `${t.who}@${t.index}:${t.status ? "ok" : "reverted"}`),
    victimOk: vr.status, victimShortfallBps: vr.status ? null : "reverted",
    attackerQ: dq, attackerW: dw, attackerNetUSDatP100: +(dq + dw * price).toFixed(4), attackerNetUSDatPool: +(dq + dw * poolPrice).toFixed(4),
    gasBLCH, gasUSDatP100: +(gasBLCH * price).toFixed(4), victimFeeBLCH: fmt(vr.fee, 18),
  });
}

async function bracket() {
  for (const victimUSD of [10, 50, 200]) for (const slipBps of [50, 100, 500]) await bracketRow({ victimUSD, slipBps });
  // Blind: nonce only. The attacker sizes for a $50 swap at the default 0.5%.
  await bracketRow({ victimUSD: 10, slipBps: 50, guessUSD: 50 });
  await bracketRow({ victimUSD: 200, slipBps: 50, guessUSD: 50 });
  await bracketRow({ victimUSD: 50, slipBps: 50, guessUSD: 50, wrongWay: true });
  // At the ceiling the attacker also collects the fees by skimming.
  await bracketRow({ victimUSD: 50, slipBps: 50, ceiling: true });
  await bracketRow({ victimUSD: 50, slipBps: 500, ceiling: true });
}

// Fee behaviour exactly at the k ceiling, with the real router and the real keeper.
async function ceiling() {
  const scene = "ceiling";
  for (const label of ["seed-50pct", "exact-ceiling"]) {
    const exact = label === "exact-ceiling";
    const w = await newWorld();
    await w.fund(A.user, 4n * BLCH, 400n * USD);
    if (exact) {
      // 5 W + 500 Q, up to exactly 64% of cap0 * cap1, at the same ratio.
      const over = await net.why(A.user.address, w.router, data("addLiquidity", [w.w, w.q, 3n * BLCH + 1n, 300n * USD + 1n, 0n, 0n, A.user.address, DEADLINE]));
      await net.must(await A.user.send(w.router, data("addLiquidity", [w.w, w.q, 3n * BLCH, 300n * USD, 0n, 0n, A.user.address, DEADLINE]), { gas: 800_000n }));
      const s = await w.state();
      out(scene, { label, kIsCeiling: s.rw * s.rq === (w.capW * w.capQ * 64n) / 100n, oneUnitMoreMint: over, state: s, sync: await net.why(A.user.address, w.pair, data("sync")) });
    }
    const gate = join(work, `gate-${scene}-${label}.json`);
    await w.gate(gate);
    const state = join(work, `keeper-${scene}-${label}.json`);
    rmSync(state, { force: true });
    const start = await w.state();
    const supply = await net.read(w.pair, "totalSupply");
    const kLast = await net.read(w.pair, "kLast");
    const rootK = (s) => Math.sqrt(Number(s.rw) * Number(s.rq));
    // Alternating swaps of 4% of the input reserve. Enough volume to reach the keeper's floor.
    let volume = 0;
    let firstKeeper = null;
    let failures = 0;
    const reasons = {};
    const SWAPS = 150;
    await w.fund(A.user, 20n * BLCH, 2000n * USD);
    for (let i = 0; i < SWAPS; i++) {
      const s = await w.state();
      const sellW = i % 2 === 0;
      const amt = sellW ? (s.rw * 4n) / 100n : (s.rq * 4n) / 100n;
      const why = await net.why(A.user.address, w.router, w.swapData(sellW, amt, 0n, A.user.address));
      if (why) {
        failures += 1;
        const key = `${sellW ? "sell W" : "sell Q"}: ${why}`;
        if (!reasons[key]) reasons[key] = { first: i + 1, count: 0, state: s };
        reasons[key].count += 1;
        continue;
      }
      const t = await net.settle(await A.user.send(w.router, w.swapData(sellW, amt, 0n, A.user.address), { gas: 400_000n }));
      if (!t.status) failures += 1;
      volume += Number(sellW ? (amt * s.rq) / s.rw : amt) / 1e6;
      if (!firstKeeper) {
        const dry = await run(process.execPath, [KEEPER, "--config", gate, "--rpc", net.url, "--keeper", A.keeper.address, "--state", state]).then((x) => JSON.parse(x.stdout), (e) => { try { return JSON.parse(e.stdout); } catch { return { action: e.message }; } });
        if (dry.action !== "nothing-to-do") firstKeeper = { swap: i + 1, volumeUSD: Math.round(volume), action: dry.action };
      }
    }
    const end = await w.state();
    const pos = await net.read(w.lens, "position", [w.pair, A.safe.address]);
    out(scene, {
      label, swaps: SWAPS, failures, reasons, volumeUSD: Math.round(volume), start, end, kChangePpm: Math.round((Number(end.rw * end.rq) / Number(start.rw * start.rq) - 1) * 1e6),
      ceilingExact: end.rw * end.rq <= (w.capW * w.capQ * 64n) / 100n, excessW: fmt(end.xw, 18), excessQ: fmt(end.xq, 6), excessUSDatPool: +(fmt(end.xq, 6) + (fmt(end.xw, 18) * Number(end.rq) / 1e6) / (Number(end.rw) / 1e18)).toFixed(4),
      protocolPendingLP: pos.pendingProtocolLiquidity, safeShare0: pos.reserveShare0, supply, kLast, firstKeeper,
    });
    // Who collects? A third party, at what gas, against what the LPs would have had.
    const q0 = await net.read(w.q, "balanceOf", [A.thief.address]);
    const w0 = await net.read(w.w, "balanceOf", [A.thief.address]);
    const t = await net.must(await A.thief.send(w.pair, data("skim", [A.thief.address]), { gas: 200_000n }));
    out(scene, { label, skimGas: t.gas, skimFeeBLCH: fmt(t.fee, 18), thiefQ: fmt((await net.read(w.q, "balanceOf", [A.thief.address])) - q0, 6), thiefW: fmt((await net.read(w.w, "balanceOf", [A.thief.address])) - w0, 18) });
    // An LP burn at the ceiling: does the excess matter, does the fee show up?
    const lp = await net.read(w.pair, "balanceOf", [A.depositor.address]);
    const n = await A.depositor.send(w.pair, data("approve", [w.router, lp]));
    const burn = await A.depositor.send(w.router, data("removeLiquidity", [w.w, w.q, lp / 10n, 0n, 0n, A.depositor.address, DEADLINE]), { gas: 600_000n });
    const br = await net.settle([n, burn]);
    const safeLp = await net.read(w.pair, "balanceOf", [A.safe.address]);
    out(scene, { label, burnOk: br.every((b) => b.status), safeLpAfterBurn: safeLp, safeBpsOfSupply: Number((safeLp * 10_000n * 1000n) / (await net.read(w.pair, "totalSupply"))) / 1000 });
  }
}

// The proposed keeper (or any other through KEEPER) against a griefer with a fixed tip.
async function raceTiers() {
  for (const [label, sized, griefTip] of [["soft, griefer tip 3", "soft", 3], ["hard, griefer tip 3", "hard", 3], ["hard, griefer tip 9, above the keeper's range", "hard", 9]]) {
    const scene = `race-tiers: ${label}`;
    const w = await newWorld();
    const s = await atWCap(w);
    const d = sized === "soft" ? minClose(s, w, "w") + 10n ** 15n : w.capW / 90n;
    const gate = join(work, "gate-tiers.json");
    await w.gate(gate);
    const state = join(work, "keeper-tiers.json");
    rmSync(state, { force: true });
    await syncNonce(A.keeper);
    A.keeper.paid = 0n;
    const griefStart = A.griefer.paid;
    const safe0 = await net.read(w.w, "balanceOf", [A.safe.address]);
    const g0 = await net.read(w.w, "balanceOf", [A.griefer.address]);
    let won = 0, lost = 0, stop = null, rounds = 0;
    for (rounds = 1; rounds <= 60; rounds++) {
      const x = await w.state();
      if (x.xw < d) await net.must(await A.griefer.send(w.w, data("transfer", [w.pair, d - x.xw]), { tip: 2, gas: 100_000n }));
      const k = await keeperRun(gate, state);
      if (k.action !== "sent") { stop = { action: k.action, exit: k.exit }; break; }
      const counter = await A.griefer.send(w.pair, data("skim", [A.griefer.address]), { tip: griefTip, gas: 150_000n });
      const r = await net.settle(counter);
      const kr = await net.rpc("eth_getTransactionReceipt", [k.hash]);
      A.keeper.paid += BigInt(kr.gasUsed) * BigInt(kr.effectiveGasPrice);
      const griefFirst = r.block === Number(kr.blockNumber) && r.index < Number(kr.transactionIndex);
      if (griefFirst) won += 1; else lost += 1;
      await keeperRun(gate, state); // Reconcile.
    }
    const st = JSON.parse(readFileSync(state, "utf8"));
    out(scene, { rounds: rounds - 1, griefWon: won, griefLost: lost, stop, keeperTx: st.txs.length, statuses: st.txs.reduce((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {}), tips: st.txs.slice(0, 12).map((t) => Number(BigInt(t.tipWei ?? 0)) / 1e9), keeperPaidBLCH: fmt(A.keeper.paid, 18), griefPaidBLCH: fmt(A.griefer.paid - griefStart, 18), griefCapitalW: fmt((await net.read(w.w, "balanceOf", [A.griefer.address])) - g0, 18), safeGotW: fmt((await net.read(w.w, "balanceOf", [A.safe.address])) - safe0, 18), donationW: fmt(d, 18), closedAtEnd: await closed(w) });
  }
}

// The read-only footprint tool against the settled RPC itself.
async function footprintTool() {
  const w = await newWorld();
  await w.fund(A.user, BLCH, 50n * USD);
  await net.must(await A.user.send(w.router, w.swapData(false, 5n * USD, 0n, A.user.address), { gas: 400_000n }));
  await net.must(await A.griefer.send(w.q, data("approve", ["0x00000000000000000000000000000000000d00d7", 1n])));
  const gate = join(work, "gate-fp.json");
  await w.gate(gate);
  const state = join(work, "fp.json");
  rmSync(state, { force: true });
  const r = await run(process.execPath, [join(ROOT, "scripts/ops/dex-storage-footprint.mjs"), "--config", gate, "--rpc", net.url, "--state", state, "--json"]).then((x) => x.stdout, (e) => `${e.stdout}${e.stderr}`);
  out("footprint-tool", { output: r.slice(0, 900) });
}

// The monitor's new checks read from the real RPC. No Safe here, so its gate and Safe checks are stubbed.
async function monitorReal() {
  const { runMonitor } = await import("../dex-monitor.mjs");
  const { readGate } = await import("../dex-ops-lib.mjs");
  const show = async (label, w) => {
    const gate = join(work, "gate-mon.json");
    await w.gate(gate);
    const request = createRequest(net.url);
    const r = await runMonitor(readGate(gate), { expectSeeded: false }, request, { evaluateGate: async () => ({ decision: "stub", finalized: { number: 0 } }), verifySafe: async () => {} });
    out("monitor", { label, level: r.level, checks: r.checks.filter((c) => /closed_by_excess|k_ceiling/.test(c.name)).map((c) => ({ name: c.name.replace(/\[.*/, ""), status: c.status, detail: c.detail })) });
  };
  const a = await newWorld();
  const s = await atWCap(a);
  await net.must(await A.griefer.send(a.w, data("transfer", [a.pair, minClose(s, a, "w") + 10n ** 15n]), { tip: 2, gas: 100_000n }));
  await show("soft closure", a);
  await net.must(await A.griefer.send(a.w, data("transfer", [a.pair, a.capW / 50n]), { tip: 2, gas: 100_000n }));
  await show("hard closure", a);
  const b = await newWorld(8n * BLCH, 800n * USD);
  await show("exactly at the ceiling", b);
}

const SCENES = { raceWin, raceLose, bundle, bracket, ceiling, raceTiers, footprintTool, monitorReal };
try {
  for (const name of wanted.length ? wanted : Object.keys(SCENES)) {
    const t = Date.now();
    await SCENES[name]();
    out("timing", { name, s: Math.round((Date.now() - t) / 1000) });
    for (const a of Object.values(A)) await syncNonce(a);
  }
  console.log(big({ done: true }));
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
