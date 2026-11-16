#!/usr/bin/env node
// The deterministic plan of one chain, or of all (docs/MULTICHAIN-DEPLOY.md). No RPC, no signature.
//
//   node scripts/multichain/plan.mjs <chain>|all [--reference] [--env] [--json]
//
// --reference  every owner choice that is still TBD-owner takes its reference rehearsal value (first deposits open,
//              no reserve caps); such a plan is marked `reference: true` and deploy.sh refuses to broadcast it.
// --env        print the MC_* environment of script/DeployMultichain.s.sol (one chain).
// --json       print the plan as JSON (without transaction data).
import { forgeEnvironment, loadArtifacts, loadChain, loadShared, MultichainError, planChain, planSummary } from "./lib.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [target] = argv.filter((a) => !a.startsWith("--"));
for (const f of flags) if (!["--reference", "--env", "--json"].includes(f)) { console.error(`unknown option ${f}`); process.exit(2); }
if (!target) { console.error("usage: plan.mjs <chain>|all [--reference] [--env] [--json]"); process.exit(2); }
try {
  const shared = loadShared();
  const artifacts = loadArtifacts();
  const keys = target === "all" ? shared.chains : [target];
  if (target !== "all" && !shared.chains.includes(target)) throw new MultichainError(`multichain: ${target} is not in deployments/multichain.json chains`);
  const plans = keys.map((key) => {
    const chain = loadChain(key);
    return { chain, plan: planChain(shared, chain, artifacts, { reference: flags.has("--reference") }) };
  });
  if (flags.has("--env")) {
    if (plans.length !== 1) throw new MultichainError("multichain: --env takes one chain");
    for (const [k, v] of Object.entries(forgeEnvironment(plans[0].plan, plans[0].chain))) console.log(`${k}=${v}`);
  } else if (flags.has("--json")) {
    console.log(JSON.stringify(plans.length === 1 ? planSummary(plans[0].plan) : plans.map((p) => planSummary(p.plan)), null, 2));
  } else {
    for (const { plan } of plans) {
      console.log(`${plan.chain.key} (chain ${plan.chain.chainId})${plan.reference ? "  REFERENCE PLAN: owner choices open, not for a real deployment" : ""}`);
      for (const c of Object.values(plan.contracts)) console.log(`  ${c.name.padEnd(8)} ${c.address}  runtime ${c.runtimeCodeHash}`);
      for (const p of plan.pairs) console.log(`  pair ${p.tokenA}/${p.tokenB} ${p.address}`);
    }
    const same = (name) => new Set(plans.map((p) => p.plan.contracts[name].address)).size === 1;
    if (plans.length > 1) console.log(`same address on every chain: factory ${same("factory")}, lens ${same("lens")}, router ${same("router")} (the router's address depends on the wrapped native token)`);
  }
} catch (error) {
  if (!(error instanceof MultichainError)) throw error;
  console.error(error.message);
  process.exit(2);
}
