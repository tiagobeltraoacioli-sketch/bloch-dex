// Driver defect D1 (agent 315's settled run): the sandwich probe's back-run carried a tip of 0, which the launch
// settled RPC refuses (at least 100,000,000 wei), and the step died with two transactions already spooled.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MIN_TIP_WEI, probeTips } from "./e2e-settled/probe-tips.mjs";

test("D1: the probe's back-run pays the RPC's minimum tip, below the victim's, and the front-run is above it", () => {
  // The launch settled RPC: eth_maxPriorityFeePerGas 0x5f5e100 (100,000,000), victim 1 gwei, ceiling 5 gwei.
  assert.deepEqual(probeTips("0x5f5e100", 1_000_000_000n, 5_000_000_000n), { back: 100_000_000n, victim: 1_000_000_000n, front: 3_000_000_000n });
  // No answer, a zero or a malformed answer: the launch default, never 0.
  for (const answer of ["", "0x0", "0", "null", undefined, "garbage"]) assert.equal(probeTips(answer, 1_000_000_000n, 5_000_000_000n).back, DEFAULT_MIN_TIP_WEI);
  // An RPC that asks more than the victim's tip: the victim and the front-run move up, the order stays.
  const dear = probeTips("2000000000", 1_000_000_000n, 20_000_000_000n);
  assert.ok(dear.back < dear.victim && dear.victim < dear.front);
  assert.deepEqual(dear, { back: 2_000_000_000n, victim: 4_000_000_000n, front: 12_000_000_000n });
  // Above the driver's fee ceiling the probe is refused with the remedy named, not sent underpriced.
  assert.throws(() => probeTips("2000000000", 1_000_000_000n, 5_000_000_000n), /raise E2E_MAXFEE/);
});

test("D1: the command prints the three tips, and the driver uses it and survives a refused probe", () => {
  const cli = fileURLToPath(new URL("./e2e-settled/probe-tips.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "0x5f5e100", "1000000000", "5000000000"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), "100000000 1000000000 3000000000");
  assert.equal(spawnSync(process.execPath, [cli, "9000000000", "1000000000", "5000000000"], { encoding: "utf8" }).status, 2);
  const driver = readFileSync(new URL("./e2e-settled/drive.sh", import.meta.url), "utf8");
  const step = driver.slice(driver.indexOf("\npending-probe)"), driver.indexOf("\npoll)"));
  assert.match(step, /probe-tips\.mjs/);
  // No transaction of the probe is built with a tip of 0, and no publication of it can end the step.
  assert.doesNotMatch(step, /400000 0 0 /);
  assert.doesNotMatch(step, /cast publish --async --rpc-url "\$RPC" "\$r" > \/dev\/null; done/);
  assert.match(step, /probe transaction refused/);
});
