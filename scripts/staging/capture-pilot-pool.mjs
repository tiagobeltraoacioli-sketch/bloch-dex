#!/usr/bin/env node
import { resolve } from "node:path";
import { readAndValidateConfig, sha256, stableJson } from "./manifest.mjs";
import { createJsonRpcRequest } from "./rpc-verifier.mjs";
import { writePoolInspectionObservation } from "./pool-inspector.mjs";
import { capturePilotPool } from "./pool-replay.mjs";

const args = process.argv.slice(2);
const fields = [
  "--config",
  "--block-number",
  "--block-hash",
  "--pair-runtime-code-hash",
  "--output",
];
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (
    !fields.includes(args[index]) ||
    values.has(args[index]) ||
    !args[index + 1] ||
    args[index + 1].startsWith("--")
  )
    break;
  values.set(args[index], args[index + 1]);
}
if (
  args.length !== fields.length * 2 ||
  values.size !== fields.length ||
  !/^[1-9][0-9]{0,15}$/.test(values.get("--block-number"))
) {
  console.error(
    "Usage: node scripts/staging/capture-pilot-pool.mjs --config <reviewed.json> --block-number <decimal> --block-hash <0x-hash> --pair-runtime-code-hash <0x-hash> --output <new-capture.json>",
  );
  process.exit(2);
}
try {
  const config = await readAndValidateConfig(resolve(values.get("--config")));
  const capture = await capturePilotPool(
    config,
    {
      blockNumber: Number(values.get("--block-number")),
      blockHash: values.get("--block-hash"),
      pairRuntimeCodeHash: values.get("--pair-runtime-code-hash"),
    },
    createJsonRpcRequest(config.chain.rpcUrl),
  );
  await writePoolInspectionObservation(
    resolve(values.get("--output")),
    capture,
  );
  console.log(
    `Pool capture written; file SHA-256: 0x${sha256(`${stableJson(capture)}\n`)}; authentication and execution remain disabled`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
