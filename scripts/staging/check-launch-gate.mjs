#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateLaunchGate } from "./launch-gate.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--gate") {
  console.error(
    "Usage: node scripts/staging/check-launch-gate.mjs --gate <gate.json>",
  );
  process.exit(2);
}

try {
  const bytes = await readFile(resolve(args[1]));
  if (bytes.length === 0 || bytes.length > 16 * 1024)
    throw new Error("launch gate: document size is invalid");
  const gate = JSON.parse(bytes.toString("utf8"));
  console.log(JSON.stringify(evaluateLaunchGate(gate), null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "launch gate: refused",
  );
  process.exit(1);
}
