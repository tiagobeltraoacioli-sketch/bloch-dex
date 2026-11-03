#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createJsonRpcRequest, evaluateFinalityGate } from "./finality-gate.mjs";

// Optional, schema 2: `--bridge-plan P --bridge-record R` pairs check each bridged token against the bridge's own
// deployment files (agent 180 L-3). The mainnet gate (check-finality-gate-mainnet.mjs) requires them.
const args = process.argv.slice(2);
const usage =
  "Usage: node scripts/staging/check-finality-gate.mjs --config <gate.json> --rpc <http://host:port> [--bridge-plan <plan.json> --bridge-record <record.json>]...";
const named = { config: [], rpc: [], "bridge-plan": [], "bridge-record": [] };
let ok = args.length % 2 === 0;
for (let i = 0; ok && i < args.length; i += 2) {
  const k = args[i].startsWith("--") ? args[i].slice(2) : "";
  if (!Object.hasOwn(named, k) || args[i + 1] === undefined || args[i + 1].startsWith("--")) ok = false;
  else named[k].push(args[i + 1]);
}
if (!ok || named.config.length !== 1 || named.rpc.length !== 1 || named["bridge-plan"].length !== named["bridge-record"].length) {
  console.error(usage);
  process.exit(2);
}

try {
  const config = JSON.parse(await readFile(named.config[0], "utf8"));
  const bridgeTokens = [];
  for (let i = 0; i < named["bridge-plan"].length; i++) {
    bridgeTokens.push({
      plan: JSON.parse(await readFile(named["bridge-plan"][i], "utf8")),
      record: JSON.parse(await readFile(named["bridge-record"][i], "utf8")),
    });
  }
  const report = await evaluateFinalityGate(config, createJsonRpcRequest(named.rpc[0]), { bridgeTokens });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "finality gate: refused");
  process.exitCode = 1;
}
