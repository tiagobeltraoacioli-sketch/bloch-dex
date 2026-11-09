#!/usr/bin/env node
// The Bloch L2 mainnet (700770) liquidity gate: the schema-2 finality gate
// with the chain ID, the L2 genesis hash and the Bloch Inc Safe pinned by this
// repository (deployments/mainnet/700770/pins.json and the Safe plan), not by
// the gate file alone. A gate file for another chain or genesis, or whose
// Safe pin differs from the reviewed Safe plan, is refused before any RPC
// call; the RPC must then serve the pinned genesis and a `finalized` block
// that contains every deployment transaction.
//
// Every capped token other than the wrapper must also come with its bridge
// deployment (deploy_pontes.py plan and record, agent 180 L-3): the token on
// chain must be that deployment, in the reviewed build pinned by
// deployments/mainnet/bridge-token.pin.json, with the owner's launch policy
// (5 of 7 signers, 6 for the switch and unpause, 3 guardians, T = 0).
//
//   node scripts/staging/check-finality-gate-mainnet.mjs --config <gate.json>
//        --safe-plan <safe.plan.json> --bridge-plan <busdc.plan.json>
//        --bridge-record <busdc.record.json> --rpc <own-node-url>

import { readFile } from "node:fs/promises";
import { createJsonRpcRequest, evaluateFinalityGate } from "./finality-gate.mjs";
import { checkBridgeRecord, checkMainnetPolicy } from "./bridge-token-identity.mjs";
import { SAFE_V141, stableJson } from "./dex-deploy-config.mjs";
import { isMain } from "./is-main.mjs";

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

/// Static checks of the bridge deployments: one per capped token other than the
/// wrapper, each matching the gate file, the reviewed build and the launch policy.
export function checkBridgePinned(gate, bridgeTokens) {
  refuse(Array.isArray(bridgeTokens), "the bridge deployment records are required");
  const identities = bridgeTokens.map((b) => checkBridgeRecord(gate, b));
  identities.forEach(checkMainnetPolicy);
  const covered = new Set(identities.map((i) => i.address));
  for (const { token, symbol } of gate.deployment.tokens) {
    refuse(covered.has(token), `token ${symbol} ${token} has no bridge deployment record: its signers, guardians and T are not checked`);
  }
  refuse(covered.size === identities.length && covered.size === gate.deployment.tokens.length, "the bridge records do not match the gate's tokens one to one");
  return identities;
}

export async function evaluateMainnetGate(gate, safePlan, request, bridgeTokens, pins = PINS) {
  checkPinned(gate, safePlan, pins);
  checkBridgePinned(gate, bridgeTokens);
  const report = await evaluateFinalityGate(gate, request, { bridgeTokens });
  refuse(report.chainId === pins.l2.chainId && report.genesisHash === pins.l2.genesisHash, "the RPC is not the pinned chain");
  refuse(report.bridgeTokens?.length === gate.deployment.tokens.length, "a bridge token was not checked on chain");
  return { ...report, pinned: { chainId: pins.l2.chainId, genesisHash: pins.l2.genesisHash, safe: safePlan.contracts.proxy.address } };
}

/// `--bridge-plan P --bridge-record R`, once per bridged token, in pairs.
export async function readBridgeArgs(pairs) {
  const out = [];
  for (const [plan, record] of pairs) {
    out.push({ plan: JSON.parse(await readFile(plan, "utf8")), record: JSON.parse(await readFile(record, "utf8")) });
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = "Usage: node scripts/staging/check-finality-gate-mainnet.mjs --config <gate.json> --safe-plan <safe.plan.json> --bridge-plan <plan.json> --bridge-record <record.json> [--bridge-plan … --bridge-record …] --rpc <url>";
  const named = { config: [], "safe-plan": [], "bridge-plan": [], "bridge-record": [], rpc: [] };
  let ok = args.length % 2 === 0;
  for (let i = 0; ok && i < args.length; i += 2) {
    const k = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (!Object.hasOwn(named, k) || args[i + 1] === undefined || args[i + 1].startsWith("--")) ok = false;
    else named[k].push(args[i + 1]);
  }
  if (!ok || named.config.length !== 1 || named["safe-plan"].length !== 1 || named.rpc.length !== 1 ||
      named["bridge-plan"].length === 0 || named["bridge-plan"].length !== named["bridge-record"].length) {
    console.error(usage);
    process.exit(2);
  }
  try {
    const gate = JSON.parse(await readFile(named.config[0], "utf8"));
    const safePlan = JSON.parse(await readFile(named["safe-plan"][0], "utf8"));
    const bridgeTokens = await readBridgeArgs(named["bridge-plan"].map((p, i) => [p, named["bridge-record"][i]]));
    console.log(JSON.stringify(await evaluateMainnetGate(gate, safePlan, createJsonRpcRequest(named.rpc[0]), bridgeTokens), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "mainnet gate: refused");
    process.exitCode = 1;
  }
}
