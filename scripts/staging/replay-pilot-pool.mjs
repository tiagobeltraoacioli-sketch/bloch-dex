#!/usr/bin/env node
import { resolve } from "node:path";
import { readAndValidateConfig } from "./manifest.mjs";
import {
  validatePoolInspectionRequest,
  writePoolInspectionObservation,
} from "./pool-inspector.mjs";
import { readPoolCapture, replayPilotPool } from "./pool-replay.mjs";

const args = process.argv.slice(2);
const fields = [
  "--config",
  "--block-number",
  "--block-hash",
  "--pair-runtime-code-hash",
  "--capture",
  "--capture-sha256",
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
    "Usage: node scripts/staging/replay-pilot-pool.mjs --config <reviewed.json> --block-number <decimal> --block-hash <0x-hash> --pair-runtime-code-hash <0x-hash> --capture <retained-capture.json> --capture-sha256 <retained-file-0x-sha256> --output <new-replay.json>",
  );
  process.exit(2);
}
try {
  const config = await readAndValidateConfig(resolve(values.get("--config")));
  const options = {
    blockNumber: Number(values.get("--block-number")),
    blockHash: values.get("--block-hash"),
    pairRuntimeCodeHash: values.get("--pair-runtime-code-hash"),
  };
  validatePoolInspectionRequest(config, options);
  const capture = await readPoolCapture(
    resolve(values.get("--capture")),
    values.get("--capture-sha256"),
  );
  const report = await replayPilotPool(config, options, capture);
  await writePoolInspectionObservation(resolve(values.get("--output")), report);
  console.log(
    "Pool observation reproduced offline; authentication and execution remain disabled",
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
