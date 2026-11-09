// A tool started from a path with a space or through a symlink must still run: before
// is-main.mjs the mainnet gate printed nothing and exited 0 there (review finding M1, round 14).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOLS = [
  ["scripts/staging/check-finality-gate-mainnet.mjs", 2],
  ["scripts/staging/deploy-dex.mjs", null],
  ["scripts/staging/verify-deployment.mjs", null],
  ["scripts/staging/frontend-record.mjs", null],
  ["scripts/ops/dex-skim-keeper.mjs", 3],
  ["scripts/ops/dex-monitor.mjs", 3],
];

test("tools run, and refuse missing arguments, when started through a symlink with a space in its path", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "is main "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "repo link");
  symlinkSync(ROOT, link, "dir");
  for (const [tool, status] of TOOLS) {
    for (const path of [join(ROOT, tool), join(link, tool)]) {
      const run = spawnSync(process.execPath, [path], { encoding: "utf8" });
      assert.notEqual(run.status, 0, `${path} exited 0 without arguments`);
      assert.ok((run.stderr + run.stdout).length > 0, `${path} printed nothing`);
      if (status !== null) assert.equal(run.status, status, path);
    }
  }
});
