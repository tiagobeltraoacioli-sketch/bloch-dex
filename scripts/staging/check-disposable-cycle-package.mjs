#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDisposableCyclePackage } from "./disposable-cycle-package.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--package") {
  console.error("Usage: node scripts/staging/check-disposable-cycle-package.mjs --package <repo-relative-package.json>");
  process.exit(2);
}
try {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const report = await verifyDisposableCyclePackage(repository, args[1]);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.disposableCycleAuthenticated ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "disposable cycle: refused");
  process.exitCode = 1;
}
