#!/usr/bin/env node
import { resolve } from "node:path";
import { readAndValidateConfig, stableJson, sha256 } from "./manifest.mjs";
import { createJsonRpcRequest } from "./rpc-verifier.mjs";
import { writePoolInspectionObservation } from "./pool-inspector.mjs";
import {
  captureDeployment,
  replayDeployment,
  readDeploymentCapture,
} from "./deployment-replay.mjs";
const [mode, ...args] = process.argv.slice(2);
const fields =
  mode === "capture"
    ? ["--config", "--output"]
    : mode === "replay"
      ? ["--config", "--capture", "--capture-sha256", "--output"]
      : [];
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (
    !fields.includes(args[i]) ||
    options.has(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    break;
  options.set(args[i], args[i + 1]);
}
if (
  !fields.length ||
  args.length !== fields.length * 2 ||
  options.size !== fields.length
) {
  console.error(
    "Usage: deployment-evidence.mjs capture --config reviewed.json --output new.json\n       deployment-evidence.mjs replay --config reviewed.json --capture retained.json --capture-sha256 0xHASH --output new.json",
  );
  process.exit(2);
}
try {
  const config = await readAndValidateConfig(resolve(options.get("--config")));
  const result =
    mode === "capture"
      ? await captureDeployment(
          config,
          createJsonRpcRequest(config.chain.rpcUrl),
        )
      : await replayDeployment(
          config,
          await readDeploymentCapture(
            resolve(options.get("--capture")),
            options.get("--capture-sha256"),
          ),
        );
  await writePoolInspectionObservation(
    resolve(options.get("--output")),
    result,
  );
  console.log(
    "Deployment evidence retained; file SHA-256: 0x" +
      sha256(stableJson(result) + "\n") +
      "; no activation authorized",
  );
} catch {
  console.error(
    "Deployment evidence refused; inspect the reviewed inputs and endpoint separately.",
  );
  process.exit(1);
}
