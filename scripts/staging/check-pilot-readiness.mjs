#!/usr/bin/env node
import { resolve } from "node:path";
import {
  readPilotReadinessBundle,
  verifyPilotReadiness,
} from "./pilot-readiness.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const bundlePath = option("--bundle");
const verifierPath = option("--verifier");
const verifierSha256 = option("--verifier-sha256");

if (args.length !== 6 || !bundlePath || !verifierPath || !verifierSha256) {
  console.error(
    "Usage: node scripts/staging/check-pilot-readiness.mjs --bundle <bundle.json> --verifier <verifier> --verifier-sha256 <0x...>",
  );
  process.exit(2);
}

try {
  const bundle = await readPilotReadinessBundle(resolve(bundlePath));
  const report = await verifyPilotReadiness(bundle, {
    verifierPath: resolve(verifierPath),
    verifierSha256,
  });
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(
    JSON.stringify({
      bridgeReady: false,
      bridgeOperationalVerified: false,
      disabledDeploymentVerified: false,
      singleEmptyPilotPoolVerified: false,
      authoritiesVerified: false,
      rehearsalReconciled: false,
      pilotLiquidityCeremonyAuthorized: false,
      liquidityEnabled: false,
      liquidityAdded: false,
      activationPerformed: false,
      broadcastPerformed: false,
      error: "pilot-readiness-refused",
    }),
  );
  process.exit(1);
}
