#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLaunchGate, readLaunchGate } from "./launch-gate.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--gate") {
  console.error(
    "Usage: node scripts/staging/check-launch-gate.mjs --gate <repo-relative-gate.json>",
  );
  process.exit(2);
}

try {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const gate = await readLaunchGate(repository, args[1]);
  const report = evaluateLaunchGate(gate);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "launch gate: refused",
  );
  process.exitCode = 1;
}
