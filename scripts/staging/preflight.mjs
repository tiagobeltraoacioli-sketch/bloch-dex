#!/usr/bin/env node
import { resolve } from "node:path";
import { readAndValidateConfig, sha256, stableJson } from "./manifest.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config") {
  console.error(
    "Usage: node scripts/staging/preflight.mjs --config <reviewed-config.json>",
  );
  process.exit(2);
}

try {
  const config = await readAndValidateConfig(resolve(args[1]));
  console.log(
    `Staging configuration accepted: sha256:${sha256(stableJson(config))}`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
