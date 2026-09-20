#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashDirectory,
  readAndValidateConfig,
  sha256,
  stableJson,
} from "./manifest.mjs";

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
    "Usage: node scripts/staging/build.mjs --config <reviewed-config.json> --output <artifact-manifest.json>",
  );
  process.exit(2);
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(args[configIndex + 1]);
const outputPath = resolve(args[outputIndex + 1]);

try {
  // Configuration is validated before a build can create a staging artifact.
  const config = await readAndValidateConfig(configPath);
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    {
      cwd: repository,
      encoding: "utf8",
    },
  );
  if (status.trim())
    throw new Error("staging preflight: tracked worktree must be clean");
  const sourceRevision = execFileSync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    {
      cwd: repository,
      encoding: "utf8",
    },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision))
    throw new Error("staging preflight: invalid source revision");

  execFileSync("npm", ["run", "build"], {
    cwd: resolve(repository, "frontend"),
    stdio: "inherit",
  });
  const files = await hashDirectory(resolve(repository, "frontend/dist"));
  const manifest = {
    schemaVersion: 1,
    target: {
      environment: "staging",
      host: "bloch-dex",
      frontendMode: "preview",
      liquidityEnabled: false,
    },
    sourceRevision,
    deploymentConfiguration: config,
    configurationSha256: sha256(stableJson(config)),
    capApprovalVerified: false,
    frontendLockSha256: sha256(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(resolve(repository, "frontend/package-lock.json")),
      ),
    ),
    files,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`Staging artifact manifest written to ${outputPath}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
