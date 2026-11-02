#!/usr/bin/env node
// Read-only health monitor of the postern-dex deployment on Bloch L2.
// Runbook: docs/OPS-DEX-MONITOR-KEEPER.md. It holds no key and sends nothing:
// JSON-RPC calls are limited to READ_ONLY_METHODS.
//
// Checks (per pair where it applies): reserves vs caps at latest; pending
// excess at finalized and latest; the finality gate; the Bloch Inc Safe still
// pinned at finalized and latest; pair, factory, router, lens and token code
// hashes; fee accrued to the Safe; LP shares stranded in the pair; a leftover
// Safe allowance to the router; a pre-seed pair touched by a donation; L2 head
// and finalized age; pairs beyond the plan; the bridged token's pause state and
// the pool price against an optional operator-supplied reference.
//
// Exit status (Nagios, as deployment/mainnet/l2_monitor.py): 0 OK, 1 WARN,
// 2 CRIT, 3 UNKNOWN. UNKNOWN means the node could not answer, not that the
// chain is unhealthy.
//
//   node scripts/ops/dex-monitor.mjs --config finality-gate.mainnet.json
//        --safe-plan safe.plan.json --rpc http://127.0.0.1:18955 [--expect-seeded]
//        [--lp-recipient 0x… [--lp-min-bps 5000], required with --expect-seeded]
//        [--rehearsal] [--ref-price 25.5] [--json]

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateFinalityGate, verifySafe } from "../staging/finality-gate.mjs";
import {
  CRIT, CallReverted, LEVEL_NAMES, OK, RpcError, UNKNOWN, WARN,
  blockRef, call, checkIdentity, classifyExcess, codeHash, createRequest, deploymentFromGate, excessFloor,
  formatUnits, isBricked, isClosed, isClosedByExcess, parseArgs, parseUnits, readBlock, readGate, readPair, stringify, worst,
} from "./dex-ops-lib.mjs";

export const THRESHOLDS = Object.freeze({
  // Same values and reasoning as the L2 monitor's mainnet profile.
  headAgeWarn: 25n * 60n,
  headAgeCrit: 45n * 60n,
  finalizedAgeWarn: 150n * 60n,
  finalizedAgeCrit: 240n * 60n,
  // Seeding at 50% of a cap leaves room for a 4x price move; 80% means about 2.5x.
  capWarnBps: 8_000n,
  excessFloorBps: 100n,
  refWarnBps: 500n,
  refCritBps: 1_500n,
  driftWarnBps: 1_000n,
  driftCritBps: 5_000n,
});

const bps = (part, whole) => (whole === 0n ? 0n : (part * 10_000n) / whole);
const percent = (value) => `${formatUnits(value, 2)}%`;

/// Runs every check and returns `{level, checks, facts}`. `deps.gate` and
/// `deps.safe` default to the deployment package's own functions, so "the gate
/// still passes" here is the same code that opened the gate.
export async function runMonitor(gate, options, request, deps = {}) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, status: LEVEL_NAMES[level], detail });
  const now = BigInt(deps.now ?? Math.floor(Date.now() / 1000));
  const evaluateGate = deps.evaluateGate ?? evaluateFinalityGate;
  const checkSafe = deps.verifySafe ?? verifySafe;
  const deployment = deploymentFromGate(gate);
  const facts = { pairs: {} };

  // A guarded section: a node failure is UNKNOWN, a revert is CRIT.
  const guarded = async (name, body) => {
    try {
      return await body();
    } catch (error) {
      if (error instanceof RpcError) add(name, UNKNOWN, error.message);
      else add(name, CRIT, error.message);
      return undefined;
    }
  };

  const identity = await guarded("rpc_identity", async () => {
    await checkIdentity(request, deployment);
    add("rpc_identity", OK, `chain ${deployment.chainId}, genesis ${deployment.genesisHash}`);
    return true;
  });
  if (!identity) return finish(checks, facts);

  const latest = await guarded("l2_head", () => readBlock(request, "latest"));
  const finalized = await guarded("l2_finalized", () => readBlock(request, "finalized"));
  if (!latest) return finish(checks, facts);
  facts.latest = latest.number;
  const headAge = now - latest.timestamp;
  add("l2_head_age", headAge >= THRESHOLDS.headAgeCrit ? CRIT : headAge >= THRESHOLDS.headAgeWarn ? WARN : OK, `block ${latest.number}, ${headAge} s old`);
  if (finalized) {
    facts.finalized = finalized.number;
    const age = now - finalized.timestamp;
    add("l2_finalized_age", age >= THRESHOLDS.finalizedAgeCrit ? CRIT : age >= THRESHOLDS.finalizedAgeWarn ? WARN : OK, `block ${finalized.number}, ${age} s old, ${latest.number - finalized.number} behind latest`);
  } else {
    add("l2_finalized_age", CRIT, "the RPC serves no finalized block");
  }

  await guarded("finality_gate", async () => {
    const report = await evaluateGate(gate, request, options);
    add("finality_gate", OK, `${report.decision} at finalized ${report.finalized.number}`);
  });

  const views = finalized ? [["latest", latest], ["finalized", finalized]] : [["latest", latest]];
  for (const [tag, block] of views) {
    await guarded(`safe_pinned[${tag}]`, async () => {
      const at = blockRef(block);
      const proxy = await codeHash(request, deployment.safe.address, at);
      if (proxy !== deployment.safe.codeHash) throw new Error(`Safe proxy code ${proxy} differs from the pin`);
      await checkSafe(deployment.safe.safe, deployment.safe.address, request, at);
      add(`safe_pinned[${tag}]`, OK, `${deployment.safe.safe.threshold} of ${deployment.safe.safe.owners.length}, no guard, no module`);
    });
  }

  const at = blockRef(latest);
  await guarded("contract_code", async () => {
    const expected = [
      ["factory", deployment.factory],
      ["router", deployment.router],
      ["lens", deployment.lens],
      ["wrappedNative", deployment.wrapped],
      ...deployment.tokens.map((t) => [t.symbol, { address: t.token, codeHash: t.codeHash }]),
      ...deployment.pairs.map((p) => [`pair ${p.address}`, p]),
    ];
    const wrong = [];
    for (const [name, { address, codeHash: pinned }] of expected) {
      const observed = await codeHash(request, address, at);
      if (observed !== pinned) wrong.push(`${name}: ${observed} != ${pinned}`);
    }
    const init = await call(request, deployment.factory.address, "INIT_CODE_PAIR_HASH", [], at);
    if (init !== deployment.pairInitCodeHash) wrong.push(`pair init code ${init} != ${deployment.pairInitCodeHash}`);
    add("contract_code", wrong.length ? CRIT : OK, wrong.length ? wrong.join("; ") : `${expected.length} runtime hashes and the pair init code match`);
  });

  await guarded("pair_count", async () => {
    const count = await call(request, deployment.factory.address, "allPairsLength", [], at);
    const planned = BigInt(deployment.pairs.length);
    add("pair_count", count > planned ? WARN : OK, `${count} pairs, ${planned} planned${count > planned ? "; createPair is permissionless, review the new pair (DEX-03)" : ""}`);
  });

  for (const pair of deployment.pairs) {
    await guarded(`pair[${pair.address}]`, () => checkPair({ pair, deployment, latest, finalized, add, facts, options }, request));
  }

  for (const token of deployment.tokens) {
    await guarded(`bridge_token[${token.symbol}]`, async () => {
      let paused;
      try {
        paused = await call(request, token.token, "paused", [], at);
      } catch (error) {
        if (!(error instanceof CallReverted)) throw error;
        add(`bridge_token[${token.symbol}]`, WARN, "the token has no paused() view; this is not BridgedStablecoinV2");
        return;
      }
      const [supply, available, until] = await Promise.all([
        call(request, token.token, "totalSupply", [], at),
        call(request, token.token, "availableToMint", [], at),
        call(request, token.token, "pausedUntil", [], at),
      ]);
      facts[token.symbol] = { paused, totalSupply: supply, availableToMint: available, pausedUntil: until };
      add(
        `bridge_token[${token.symbol}]`,
        paused ? WARN : OK,
        paused
          ? `mints paused until ${until}: no new ${token.symbol} can arrive, transfers, swaps and burns still work (docs/OPS-DEX-INCIDENTS.md)`
          : `mints open, supply ${supply}, bucket ${available}`,
      );
    });
  }

  return finish(checks, facts);
}

async function checkPair({ pair, deployment, latest, finalized, add, facts, options }, request) {
  const tag = pair.address;
  const head = await readPair(request, pair, blockRef(latest));
  const settled = finalized ? await readPair(request, pair, blockRef(finalized)) : null;
  const main = settled ?? head;
  const pairFacts = (facts.pairs[pair.address] = { totalSupply: main.totalSupply, sides: main.sides });

  // A pair with no LP shares: anything in it came from a donation (DEX-04, DEX-09).
  if (head.totalSupply === 0n) {
    if (isBricked(head)) {
      add(`preseed[${tag}]`, CRIT, "both reserves were synced to their caps with no LP shares: this pair can never be seeded, a new factory is required (DEX-09)");
    } else if (head.sides.some((s) => s.reserve !== 0n)) {
      add(`preseed[${tag}]`, CRIT, `donation and sync set the opening reserves (${head.sides.map((s) => s.reserve).join(", ")}); plan the seed with dex-seed-plan.mjs (DEX-04)`);
    } else if (head.sides.some((s) => s.balance !== 0n)) {
      add(`preseed[${tag}]`, WARN, `unsynced donation (${head.sides.map((s) => s.balance).join(", ")}); skim it before the seed (DEX-04)`);
    } else {
      add(`preseed[${tag}]`, options.expectSeeded ? WARN : OK, options.expectSeeded ? "the pair was expected to be seeded and is empty" : "empty, untouched, ready for the seed");
    }
  }

  // Who holds the shares: a price that looks right proves nothing if our seed never
  // landed (N2). Half the pool is the line: later LPs dilute the seed, but a hostile
  // fill holds most of it. An LP who exits on purpose changes --lp-min-bps.
  if (options.expectSeeded && options.lpRecipient && head.totalSupply !== 0n) {
    const held = await call(request, pair.address, "balanceOf", [options.lpRecipient], blockRef(latest));
    const minBps = BigInt(options.lpMinBps ?? 5000);
    const ok = held * 10_000n >= head.totalSupply * minBps;
    add(`lp_recipient[${tag}]`, ok ? OK : CRIT, ok ? `${options.lpRecipient} holds ${held} of ${head.totalSupply} shares` : `${options.lpRecipient} holds only ${held} of ${head.totalSupply} shares: the seed may not have landed, or someone else filled the pool`);
  }

  // LP shares in a run that expects none: someone minted before the planned seed.
  if (head.totalSupply !== 0n && !options.expectSeeded) {
    add(`preseed[${tag}]`, WARN, `LP shares exist (${head.totalSupply}) but the seed has not been announced: a first mint nobody planned? Plan with dex-seed-plan.mjs`);
  }
  if (isClosed(head)) {
    add(`closed[${tag}]`, CRIT, "both reserves are at their caps with LP shares: swaps and deposits revert in both directions until an LP burns (F1)");
  }

  // Reserves against caps, at latest: a dump into a side must alert now, not
  // about 100 minutes later when it reaches finalized. Above cap is a broken
  // invariant; at cap closes the side to inflow by design.
  head.sides.forEach((side) => {
    const name = `reserve_cap[${tag}:${side.token}]`;
    const used = bps(side.reserve, side.cap);
    if (side.cap === 0n) add(name, CRIT, "the pair has no cap on this side; the gate requires one");
    else if (side.reserve > side.cap) {
      // A reserve can exceed the cap only if the pair's bound failed.
      add(name, CRIT, `reserve ${side.reserve} is above the cap ${side.cap}`);
    } else if (side.reserve === side.cap) add(name, WARN, `reserve is at the cap ${side.cap}: swaps and deposits into this side revert until the price moves back`);
    else add(name, used >= THRESHOLDS.capWarnBps ? WARN : OK, `reserve ${side.reserve} of ${side.cap} (${percent(used)})`);
  });

  // Pending excess: at `latest` a blocking donation is a WARN that the keeper
  // should clear; one that has reached `finalized` has stood for about 100
  // minutes, so the keeper did not act.
  const excessLevel = { none: [OK, OK], dust: [OK, OK], material: [OK, WARN], blocking: [WARN, CRIT], negative: [CRIT, CRIT] };
  const views = settled ? [["latest", head, 0], ["finalized", settled, 1]] : [["latest", head, 0]];
  for (const [view, state, index] of views) {
    if (isClosedByExcess(state)) {
      add(`closed_by_excess[${tag}:${view}]`, CRIT, "pair closed: swaps of 0.1% of a cap revert in both directions because of unrecorded balance, until someone calls skim. The keeper should clear it");
    }
    state.sides.forEach((side) => {
      const kind = classifyExcess(side, THRESHOLDS.excessFloorBps);
      const excess = side.balance - side.reserve;
      add(`pending_excess[${tag}:${side.token}:${view}]`, excessLevel[kind][index], `${kind}: ${excess} above the reserve (floor ${excessFloor(side, THRESHOLDS.excessFloorBps)})${kind === "blocking" || kind === "material" ? "; call skim, see docs/OPS-DEX-MONITOR-KEEPER.md" : ""}`);
    });
  }

  // Price moved between what the UI displays (finalized) and latest.
  if (settled && settled.totalSupply !== 0n && head.totalSupply !== 0n) {
    const [a, b] = [settled.sides, head.sides];
    const before = (a[1].reserve * 10n ** 18n) / (a[0].reserve || 1n);
    const after = (b[1].reserve * 10n ** 18n) / (b[0].reserve || 1n);
    const drift = bps(before > after ? before - after : after - before, before);
    add(`price_drift[${tag}]`, drift >= THRESHOLDS.driftCritBps ? CRIT : drift >= THRESHOLDS.driftWarnBps ? WARN : OK, `${percent(drift)} between finalized and latest; the UI asks for reconfirmation beyond slippage`);
  }

  // Protocol fee: minted LP shares in the Safe plus what the next liquidity
  // event would mint. It is expected to accrue, so it is a fact, not an alarm.
  const at = blockRef(finalized ?? latest);
  const position = await call(request, deployment.lens.address, "position", [pair.address, deployment.feeTo], at);
  const allowance = await call(request, pair.address, "allowance", [deployment.feeTo, deployment.router.address], at);
  pairFacts.fee = { minted: position.liquidity, pending: position.pendingProtocolLiquidity, reserveShare0: position.reserveShare0, reserveShare1: position.reserveShare1 };
  add(`fee_accrued[${tag}]`, OK, `Safe holds ${position.liquidity} LP, ${position.pendingProtocolLiquidity} pending, worth about ${position.reserveShare0} + ${position.reserveShare1} base units`);
  if (main.totalSupply !== 0n && main.kLast === 0n) add(`fee_tracking[${tag}]`, CRIT, "kLast is zero on a seeded pair: the protocol fee is not accruing");
  add(`safe_allowance[${tag}]`, allowance === 0n ? OK : WARN, allowance === 0n ? "no LP allowance to the router" : `${allowance} LP approved to the router; a fee redemption has not finished`);

  // LP shares sitting in the pair are burnable by anyone to any address.
  add(`lp_in_pair[${tag}]`, head.lpInPair === 0n ? OK : CRIT, head.lpInPair === 0n ? "no LP shares in the pair" : `${head.lpInPair} LP shares in the pair: anyone can burn them to their own address`);

  // Optional reference price; the kit trusts no oracle, the operator supplies it.
  if (options.refPrice && head.totalSupply !== 0n) {
    const wrappedIs0 = pair.token0 === deployment.wrapped.address;
    const [wrapped, quote] = wrappedIs0 ? head.sides : [head.sides[1], head.sides[0]];
    const decimals = await call(request, quote.token, "decimals", [], at);
    const reference = parseUnits(options.refPrice, Number(decimals));
    const pool = (quote.reserve * 10n ** 18n) / wrapped.reserve;
    const gap = bps(pool > reference ? pool - reference : reference - pool, reference);
    pairFacts.priceInQuote = formatUnits(pool, Number(decimals));
    add(`reference_price[${tag}]`, gap >= THRESHOLDS.refCritBps ? CRIT : gap >= THRESHOLDS.refWarnBps ? WARN : OK, `pool ${formatUnits(pool, Number(decimals))} vs reference ${options.refPrice} (${percent(gap)} apart)`);
  }
}

function finish(checks, facts) {
  return { level: worst(checks.map((c) => c.level)), checks, facts };
}

/// The mainnet gate wrapper, or the generic gate on a rehearsal chain.
async function gateFor(args) {
  if (args.rehearsal) return evaluateFinalityGate;
  const { evaluateMainnetGate } = await import("../staging/check-finality-gate-mainnet.mjs");
  const safePlan = JSON.parse(readFileSync(args["safe-plan"], "utf8"));
  return (gate, request) => evaluateMainnetGate(gate, safePlan, request);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["rehearsal", "json", "expect-seeded"] });
    if (!args.config || !args.rpc || (!args.rehearsal && !args["safe-plan"]) || (args["expect-seeded"] && !args["lp-recipient"])) {
      console.error("usage: dex-monitor.mjs --config <gate.json> --safe-plan <safe.plan.json> --rpc <url> [--expect-seeded --lp-recipient 0x<address> [--lp-min-bps 5000]] [--ref-price P] [--rehearsal] [--json]");
      process.exit(UNKNOWN);
    }
    const request = createRequest(args.rpc);
    const result = await runMonitor(
      readGate(args.config),
      { expectSeeded: Boolean(args["expect-seeded"]), lpRecipient: args["lp-recipient"], lpMinBps: args["lp-min-bps"], refPrice: args["ref-price"] },
      request,
      { evaluateGate: await gateFor(args) },
    );
    if (args.json) console.log(stringify({ level: LEVEL_NAMES[result.level], ...result }));
    else {
      for (const c of result.checks) console.log(`${c.status.padEnd(7)} ${c.name}: ${c.detail}`);
      console.log(`${LEVEL_NAMES[result.level]} dex-monitor`);
    }
    process.exit(result.level);
  } catch (error) {
    console.error(`UNKNOWN dex-monitor: ${error.message}`);
    process.exit(UNKNOWN);
  }
}

