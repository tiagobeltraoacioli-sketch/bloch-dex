#!/usr/bin/env node
// Multicall3 and the CREATE2 deployer for the Bloch L2 mainnet: the first step
// of the package (see docs/MAINNET-700770-PACKAGE.md). One reviewed JSON
// configuration in, one deterministic plan out; it never signs or broadcasts
// (scripts/staging/sign-and-publish.sh signs and publishes the transactions).
//
//   validate  --config C
//   pending   --config C                 list every TBD-owner/null field
//   plan      --config C [--write P]
//   preflight --config C --plan P --rpc URL
//   txs       --config C --plan P --write T
//
// Post-deployment verification: scripts/staging/verify-deployment.mjs --infra-plan.

import { readFile, writeFile } from "node:fs/promises";
import { createJsonRpcRequest } from "./finality-gate.mjs";
import { configSha256, stableJson } from "./dex-deploy-config.mjs";
import { infraTransactions, pendingFields, planInfra, validateInfraConfig } from "./infra-deploy-config.mjs";
import { isMain } from "./is-main.mjs";

function refuse(condition, message) {
  if (!condition) throw new Error(`deploy-infra: ${message}`);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  refuse(["validate", "pending", "plan", "preflight", "txs"].includes(command), "unknown command");
  const keys = { "--config": "config", "--plan": "plan", "--rpc": "rpc", "--write": "write" };
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = keys[rest[i]];
    refuse(key && i + 1 < rest.length, `unknown or incomplete argument ${rest[i]}`);
    refuse(options[key] === undefined, `${rest[i]} given twice`);
    options[key] = rest[++i];
  }
  refuse(options.config, "--config is required");
  return options;
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/// Read-only checks before the first signature: chain, genesis, the key's
/// nonce (latest and pending) and every planned address still empty.
export async function preflightInfra(plan, request) {
  refuse(BigInt(await request("eth_chainId", [])) === BigInt(plan.chain.id), "RPC chain ID does not match the plan");
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  refuse(genesis?.hash === plan.chain.genesisHash, "RPC genesis hash does not match the pinned value");
  const latest = BigInt(await request("eth_getTransactionCount", [plan.deployer, "latest"]));
  const pending = BigInt(await request("eth_getTransactionCount", [plan.deployer, "pending"]));
  refuse(latest === BigInt(plan.startNonce) && pending === latest, `key nonce is ${latest}/${pending}, plan needs ${plan.startNonce}`);
  for (const [key, { address }] of Object.entries(plan.contracts)) {
    refuse((await request("eth_getCode", [address, "latest"])) === "0x", `${key} address ${address} is already occupied`);
  }
  return { decision: "preflight-ok", nonce: latest.toString() };
}

export async function main(argv) {
  const o = parseArgs(argv);
  const raw = await readJson(o.config);
  if (o.command === "pending") return { pending: pendingFields(raw) };
  const config = validateInfraConfig(raw);
  if (o.command === "validate") return { decision: "config-valid", configSha256: configSha256(config) };
  const plan = planInfra(config);
  if (o.plan) refuse(stableJson(await readJson(o.plan)) === stableJson(plan), "the committed plan differs from the plan derived from this config");
  if (o.command === "plan") {
    if (o.write) await writeFile(o.write, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    return plan;
  }
  refuse(o.plan, "--plan is required");
  if (o.command === "preflight") {
    refuse(o.rpc, "--rpc is required");
    return preflightInfra(plan, createJsonRpcRequest(o.rpc));
  }
  refuse(o.write, "--write is required");
  const txs = infraTransactions(config, plan);
  await writeFile(o.write, `${JSON.stringify(txs, null, 2)}\n`, { flag: "wx" });
  return { decision: "transactions-written", file: o.write, count: txs.transactions.length, configSha256: plan.configSha256 };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
