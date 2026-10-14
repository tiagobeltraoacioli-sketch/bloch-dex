#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createJsonRpcRequest, evaluateFinalityGate } from "./finality-gate.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--rpc") {
  console.error(
    "Usage: node scripts/staging/check-finality-gate.mjs --config <gate.json> --rpc <http://host:port>",
  );
  process.exit(2);
}

try {
  const config = JSON.parse(await readFile(args[1], "utf8"));
  const report = await evaluateFinalityGate(config, createJsonRpcRequest(args[3]));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "finality gate: refused");
  process.exitCode = 1;
}
