#!/usr/bin/env node
// The Bloch L2 mainnet (700770) liquidity gate: the schema-2 finality gate
// with the chain ID, the L2 genesis hash and the Bloch Inc Safe pinned by this
// repository (deployments/mainnet/700770/pins.json and the Safe plan), not by
// the gate file alone. A gate file for another chain or genesis, or whose
// Safe pin differs from the reviewed Safe plan, is refused before any RPC
// call; the RPC must then serve the pinned genesis and a `finalized` block
// that contains every deployment transaction.
//
//   node scripts/staging/check-finality-gate-mainnet.mjs --config <gate.json>
//        --safe-plan <safe.plan.json> --rpc <own-node-url>

import { readFile } from "node:fs/promises";
import { createJsonRpcRequest, evaluateFinalityGate } from "./finality-gate.mjs";
import { SAFE_V141, stableJson } from "./dex-deploy-config.mjs";

export const PINS = Object.freeze(
  JSON.parse(await readFile(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8")),
);

function refuse(condition, message) {
  if (!condition) throw new Error(`mainnet gate: ${message}`);
}

/// Static checks of a gate file and a Safe plan against the repository pins.
export function checkPinned(gate, safePlan, pins = PINS) {
  refuse(gate?.schemaVersion === 2, "the mainnet gate is schema 2");
  refuse(gate.chain?.id === pins.l2.chainId, `gate chain ${gate.chain?.id} is not ${pins.l2.chainId}`);
  refuse(gate.chain.genesisHash === pins.l2.genesisHash, `gate genesis ${gate.chain.genesisHash} is not the pinned ${pins.l2.genesisHash}`);
  refuse(safePlan?.chain?.id === pins.l2.chainId && safePlan.chain.genesisHash === pins.l2.genesisHash && safePlan.chain.rehearsal === false,
    "the Safe plan is not for the pinned mainnet chain and genesis");
  const pin = gate.deployment?.roles?.blochInc;
  refuse(pin && stableJson(pin) === stableJson(safePlan.blochInc), "the gate's Bloch Inc pin differs from the reviewed Safe plan");
  refuse(gate.deployment.feeTo === safePlan.contracts.proxy.address, "the gate's fee recipient is not the planned Safe");
  refuse(pin.codeHash === SAFE_V141.proxy && pin.codeHash === pins.safe.runtimeCodeHashes.SafeProxy, "the Safe proxy code is not the official v1.4.1 proxy");
  refuse(pin.safe.singleton.codeHash === pins.safe.runtimeCodeHashes.SafeL2, "the Safe singleton is not the official SafeL2 v1.4.1");
  refuse(pin.safe.fallbackHandler.codeHash === pins.safe.runtimeCodeHashes.CompatibilityFallbackHandler, "the Safe handler is not the official v1.4.1 handler");
  refuse(pin.safe.threshold === 3 && pin.safe.owners.length === 5, "the Bloch Inc Safe is not 3 of 5");
  return true;
}

export async function evaluateMainnetGate(gate, safePlan, request, pins = PINS) {
  checkPinned(gate, safePlan, pins);
  const report = await evaluateFinalityGate(gate, request);
  refuse(report.chainId === pins.l2.chainId && report.genesisHash === pins.l2.genesisHash, "the RPC is not the pinned chain");
  return { ...report, pinned: { chainId: pins.l2.chainId, genesisHash: pins.l2.genesisHash, safe: safePlan.contracts.proxy.address } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--config" || args[2] !== "--safe-plan" || args[4] !== "--rpc") {
    console.error("Usage: node scripts/staging/check-finality-gate-mainnet.mjs --config <gate.json> --safe-plan <safe.plan.json> --rpc <url>");
    process.exit(2);
  }
  try {
    const gate = JSON.parse(await readFile(args[1], "utf8"));
    const safePlan = JSON.parse(await readFile(args[3], "utf8"));
    console.log(JSON.stringify(await evaluateMainnetGate(gate, safePlan, createJsonRpcRequest(args[5])), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "mainnet gate: refused");
    process.exitCode = 1;
  }
}
