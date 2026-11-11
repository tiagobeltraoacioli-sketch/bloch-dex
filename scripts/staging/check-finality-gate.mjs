#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createJsonRpcRequest, evaluateFinalityGate } from "./finality-gate.mjs";

// Optional, schema 2: `--bridge-plan P --bridge-record R` pairs check each bridged token against the bridge's own
// deployment files (agent 180 L-3). The mainnet gate (check-finality-gate-mainnet.mjs) requires them.
// For rehearsal chains only: a gate file with the pinned mainnet genesis is refused here.
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
  // This is the generic gate: it checks neither the Bloch Inc Safe build nor the bridge token's signers, guardians
  // and T against the launch policy. A gate file for the pinned mainnet genesis is only ever judged by the wrapper,
  // whose report the record tool and the page require (review R309-B1).
  const pins = JSON.parse(await readFile(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8"));
  if (config?.chain?.genesisHash === pins.l2.genesisHash) {
    console.error("finality gate: this gate file is for the pinned mainnet genesis; run scripts/staging/check-finality-gate-mainnet.mjs (with --safe-plan, --bridge-plan and --bridge-record) instead");
    process.exit(2);
  }
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
