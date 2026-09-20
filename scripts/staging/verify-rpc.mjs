#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readAndValidateConfig, stableJson } from "./manifest.mjs";
import {
  createJsonRpcRequest,
  verifyStagingDeployment,
} from "./rpc-verifier.mjs";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const outputIndex = args.indexOf("--output");
if (
  args.length !== 4 ||
  configIndex < 0 ||
  outputIndex < 0 ||
  !args[configIndex + 1] ||
  !args[outputIndex + 1]
) {
  console.error(
    "Usage: node scripts/staging/verify-rpc.mjs --config <reviewed-config.json> --output <observation.json>",
  );
  process.exit(2);
}

try {
  const config = await readAndValidateConfig(resolve(args[configIndex + 1]));
  const observation = await verifyStagingDeployment(
    config,
    createJsonRpcRequest(config.chain.rpcUrl),
  );
  await writeFile(
    resolve(args[outputIndex + 1]),
    `${stableJson(observation)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Pinned staging RPC observation written successfully");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
