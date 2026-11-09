// Local rehearsal ONLY. Runs the mainnet finality gate (check-finality-gate-mainnet.mjs: the Safe pin, the bridge
// deployment plan and record, the reviewed bridge token build and the owner's launch policy) against a loopback
// rehearsal chain whose genesis is NOT the pinned mainnet genesis, by replacing that one pin with the genesis the
// rehearsal chain serves. Every other check is the mainnet gate's own. It refuses a chain that serves the pinned
// genesis (use the real gate there) and any RPC that is not on loopback. It can never open mainnet liquidity: the
// mainnet procedure runs check-finality-gate-mainnet.mjs, which takes no pin override.
//
//   node scripts/fixtures/mainnet-gate-rehearsal-genesis.mjs --config <gate.json> --safe-plan <safe.plan.json>
//        --bridge-plan <busdc.plan.json> --bridge-record <busdc.record.json> --rpc http://127.0.0.1:<port>
import { readFile } from "node:fs/promises";
import { createJsonRpcRequest } from "../staging/finality-gate.mjs";
import { PINS, evaluateMainnetGate, readBridgeArgs } from "../staging/check-finality-gate-mainnet.mjs";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [config, safePlan, bridgePlan, bridgeRecord, rpc] = ["--config", "--safe-plan", "--bridge-plan", "--bridge-record", "--rpc"].map(opt);
if (!config || !safePlan || !bridgePlan || !bridgeRecord || !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc ?? "")) {
  console.error("usage: mainnet-gate-rehearsal-genesis.mjs --config G --safe-plan S --bridge-plan P --bridge-record R --rpc http://127.0.0.1:<port>");
  process.exit(2);
}
try {
  const request = createJsonRpcRequest(rpc);
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  if (typeof genesis?.hash !== "string" || genesis.hash.toLowerCase() === PINS.l2.genesisHash) {
    throw new Error("rehearsal gate: this chain serves the pinned mainnet genesis; run check-finality-gate-mainnet.mjs");
  }
  const pins = { ...PINS, l2: { ...PINS.l2, genesisHash: genesis.hash.toLowerCase() } };
  const gate = JSON.parse(await readFile(config, "utf8"));
  const plan = JSON.parse(await readFile(safePlan, "utf8"));
  const bridgeTokens = await readBridgeArgs([[bridgePlan, bridgeRecord]]);
  const report = await evaluateMainnetGate(gate, plan, request, bridgeTokens, pins);
  console.log(JSON.stringify({ ...report, rehearsal: "mainnet gate with the genesis pin replaced by the rehearsal chain's genesis" }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "rehearsal gate: refused");
  process.exitCode = 1;
}
