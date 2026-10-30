#!/usr/bin/env node
// Bloch Inc Safe (v1.4.1) deployment driver for a chain without the Safe
// singleton factory. One reviewed JSON configuration in, one deterministic
// plan out; it never signs or broadcasts (scripts/staging/sign-and-publish.sh
// signs each transaction with `cast mktx` and publishes it with `cast publish`).
//
//   validate  --config C
//   pending   --config C                      list every TBD-owner/null field
//   plan      --config C --artifacts DIR [--write P]
//   preflight --config C --artifacts DIR --plan P --rpc URL
//   txs       --config C --artifacts DIR --plan P --write T
//   blochinc  --plan P                        the `blochInc` value for the DEX config
//
// DIR is the build/artifacts directory of @safe-global/safe-contracts@1.4.1
// (its tarball must match the npm registry integrity pinned in the config).
// Post-deployment verification: scripts/staging/verify-deployment.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { createJsonRpcRequest } from "./finality-gate.mjs";
import { configSha256, EMPTY_CODE_HASH, stableJson } from "./dex-deploy-config.mjs";
import { loadSafeArtifacts, pendingFields, planSafe, safeTransactions, validateSafeConfig } from "./safe-deploy-config.mjs";

function refuse(condition, message) {
  if (!condition) throw new Error(`deploy-safe: ${message}`);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  refuse(["validate", "pending", "plan", "preflight", "txs", "blochinc"].includes(command), "unknown command");
  const keys = { "--config": "config", "--artifacts": "artifacts", "--plan": "plan", "--rpc": "rpc", "--write": "write" };
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = keys[rest[i]];
    refuse(key && i + 1 < rest.length, `unknown or incomplete argument ${rest[i]}`);
    refuse(options[key] === undefined, `${rest[i]} given twice`);
    options[key] = rest[++i];
  }
  refuse(command === "blochinc" || options.config, "--config is required");
  return options;
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/// Read-only checks before the first signature: chain, genesis, the bootstrap
/// key's nonce (latest and pending) and every planned address still empty.
export async function preflightSafe(plan, request) {
  refuse(BigInt(await request("eth_chainId", [])) === BigInt(plan.chain.id), "RPC chain ID does not match the plan");
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  refuse(genesis?.hash === plan.chain.genesisHash, "RPC genesis hash does not match the pinned value");
  const latest = BigInt(await request("eth_getTransactionCount", [plan.bootstrap, "latest"]));
  const pending = BigInt(await request("eth_getTransactionCount", [plan.bootstrap, "pending"]));
  refuse(latest === BigInt(plan.startNonce) && pending === latest, `bootstrap nonce is ${latest}/${pending}, plan needs ${plan.startNonce}`);
  for (const [key, { address }] of Object.entries(plan.contracts)) {
    const code = await request("eth_getCode", [address, "latest"]);
    refuse(code === "0x", `${key} address ${address} is already occupied`);
  }
  const balance = BigInt(await request("eth_getBalance", [plan.bootstrap, "latest"]));
  return { decision: "preflight-ok", nonce: latest.toString(), balance: balance.toString(), emptyCodeHash: EMPTY_CODE_HASH };
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.command === "blochinc") {
    refuse(o.plan, "--plan is required");
    return (await readJson(o.plan)).blochInc;
  }
  const raw = await readJson(o.config);
  if (o.command === "pending") return { pending: pendingFields(raw) };
  const config = validateSafeConfig(raw);
  if (o.command === "validate") return { decision: "config-valid", configSha256: configSha256(config) };
  refuse(o.artifacts, "--artifacts is required");
  const artifacts = await loadSafeArtifacts(o.artifacts, config.artifacts.singleton);
  const plan = planSafe(config, artifacts);
  if (o.plan) refuse(stableJson(await readJson(o.plan)) === stableJson(plan), "the committed plan differs from the plan derived from this config");
  if (o.command === "plan") {
    if (o.write) await writeFile(o.write, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    return plan;
  }
  refuse(o.plan, "--plan is required");
  if (o.command === "preflight") {
    refuse(o.rpc, "--rpc is required");
    return preflightSafe(plan, createJsonRpcRequest(o.rpc));
  }
  refuse(o.write, "--write is required");
  const txs = safeTransactions(config, artifacts, plan);
  await writeFile(o.write, `${JSON.stringify(txs, null, 2)}\n`, { flag: "wx" });
  return { decision: "transactions-written", file: o.write, count: txs.transactions.length, configSha256: plan.configSha256 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
