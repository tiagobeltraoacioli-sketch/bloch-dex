#!/usr/bin/env node
// The three priority fees of the driver's sandwich probe (`drive.sh pending-probe`): the attacker's back-run must
// be BELOW the victim's tip and its front-run ABOVE it, and none may be below what the RPC admits. The back-run
// used to carry a tip of 0, which the launch settled RPC refuses (minimum tip 100,000,000 wei), and the step died
// with the victim and the front-run already spooled (defect D1 of the settled run, agents/315).
//
//   node probe-tips.mjs <RPC's eth_maxPriorityFeePerGas, hex or decimal, or empty> <victim tip wei> <max fee wei>
//   prints: BACK VICTIM FRONT (wei)
import { isMain } from "../is-main.mjs";

/// The RPC's minimum when it gives none: the launch settled RPC's default `--min-tip-wei`.
export const DEFAULT_MIN_TIP_WEI = 100_000_000n;

export function probeTips(suggested, victimTip, maxFee) {
  let back = DEFAULT_MIN_TIP_WEI;
  try {
    if (typeof suggested === "string" && /^(0x[0-9a-f]+|[0-9]+)$/i.test(suggested.trim()) && BigInt(suggested.trim()) > 0n) back = BigInt(suggested.trim());
  } catch { /* keep the default */ }
  let victim = BigInt(victimTip);
  // The ordering under test needs back < victim < front.
  if (victim <= back) victim = back * 2n;
  let front = 3_000_000_000n;
  if (front <= victim) front = victim * 3n;
  if (front > BigInt(maxFee)) throw new Error(`the probe's front-run tip ${front} is above the driver's fee ceiling ${maxFee}: raise E2E_MAXFEE`);
  return { back, victim, front };
}

if (isMain(import.meta.url)) {
  try {
    const { back, victim, front } = probeTips(process.argv[2] ?? "", process.argv[3], process.argv[4]);
    console.log(`${back} ${victim} ${front}`);
  } catch (error) {
    console.error(`probe-tips: ${error.message}`);
    process.exit(2);
  }
}
