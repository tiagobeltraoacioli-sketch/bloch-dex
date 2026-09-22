#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySemanticLaunchPackage } from "./semantic-launch-package.mjs";

const args = process.argv.slice(2);
const basic = args.length === 2 && args[0] === "--package";
const authenticated =
  args.length === 6 &&
  args[0] === "--package" &&
  args[2] === "--trust-roots" &&
  args[4] === "--expected-trust-roots-sha256";
if (!basic && !authenticated) {
  console.error(
    "Usage: node scripts/staging/check-semantic-launch-package.mjs --package <repo-relative-package.json> [--trust-roots <repo-relative-trust-roots.json> --expected-trust-roots-sha256 <externally-retained-0x-sha256>]",
  );
  process.exit(2);
}
try {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const options = authenticated
    ? { trustRootsPath: args[3], expectedTrustRootsSha256: args[5] }
    : undefined;
  const report = await verifySemanticLaunchPackage(repository, args[1], options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.readyForReviewedActivation ? 0 : 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "semantic launch package: refused",
  );
  process.exitCode = 1;
}
