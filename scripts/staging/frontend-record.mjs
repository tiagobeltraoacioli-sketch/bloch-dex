#!/usr/bin/env node
// Assemble the frontend's mainnet deployment record
// (deployments/mainnet/dex-mainnet.record.json) from the reviewed config, the
// committed plan, the infra plan (Multicall3 and the CREATE2 deployer) and the
// schema-2 finality gate report: on mainnet the JSON printed by check-finality-gate-mainnet.mjs (required for the
// pinned genesis), on a rehearsal chain that of check-finality-gate.mjs. The frontend re-verifies everything (config hash,
// chain, gate decision, pairs, code hashes) and again against the RPC at the
// finalized block; this script refuses obvious mismatches early so a wrong
// file is never proposed for review.
//
//   node scripts/staging/frontend-record.mjs --config <config.json> --plan <plan.json> \
//     --infra-plan <infra-plan.json> --gate-report <gate-report.json> --write <record.json>
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

export const RECORD_DOMAIN = "postern.dex.frontend-record.v1";
const MAINNET_CHAIN_ID = JSON.parse(
  readFileSync(new URL("../../deployments/networks.json", import.meta.url), "utf8"),
).mainnet.chainId;

const MAINNET_GENESIS = JSON.parse(
  readFileSync(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8"),
).l2.genesisHash;
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);

/// On the pinned mainnet genesis only the mainnet wrapper's report is accepted (F-L2): the generic gate checks
/// neither the Bloch Inc Safe nor the bridge token's deployment record, and its report carries no `pinned` block.
/// The report is not signed; this refuses a wrong file early, it does not authenticate one.
export function requireMainnetWrapperReport(gateReport, plan, genesisHash = MAINNET_GENESIS) {
  const refuse = (ok, message) => {
    if (!ok) throw new Error(`frontend record: ${message}`);
  };
  const pinned = gateReport.pinned;
  refuse(
    pinned && typeof pinned === "object" && pinned.chainId === MAINNET_CHAIN_ID && pinned.genesisHash === genesisHash,
    "the gate report was not written by the mainnet gate (check-finality-gate-mainnet.mjs): it has no pinned chain",
  );
  refuse(
    /^0x[0-9a-fA-F]{40}$/.test(pinned.safe ?? "") && lower(pinned.safe) === lower(gateReport.feeTo) && lower(pinned.safe) === lower(plan.feeTo),
    "the gate report's pinned Safe is not the plan's fee recipient",
  );
  const wrapped = lower(plan.contracts?.wrappedNative?.address);
  const bridged = (plan.reserveCaps ?? []).map((cap) => lower(cap.token)).filter((token) => token !== wrapped);
  const checked = Array.isArray(gateReport.bridgeTokens) ? gateReport.bridgeTokens.map((t) => lower(t?.address)) : [];
  refuse(
    bridged.length > 0 && checked.length === bridged.length && bridged.every((token) => checked.includes(token)),
    "the gate report does not show every bridge token checked against its bridge deployment record",
  );
}

export function assembleRecord({ config, plan, infra, gateReport }) {
  const refuse = (ok, message) => {
    if (!ok) throw new Error(`frontend record: ${message}`);
  };
  refuse(plan?.domain === "postern.dex.mainnet-plan.v1", "unsupported plan");
  refuse(
    plan.chain?.id === MAINNET_CHAIN_ID && plan.chain?.rehearsal === false,
    `the plan is not a chain ${MAINNET_CHAIN_ID} deployment`,
  );
  refuse(config?.network?.chainId === plan.chain.id, "config and plan disagree on the chain");
  refuse(config.network.genesisHash === plan.chain.genesisHash, "config and plan disagree on the genesis");
  refuse(
    gateReport?.domain === "postern.dex.finality-gate.v1" && gateReport.schemaVersion === 2,
    "unsupported gate report",
  );
  refuse(gateReport.decision === "liquidity-enabled", "the finality gate did not enable liquidity");
  refuse(
    gateReport.chainId === plan.chain.id && gateReport.genesisHash === plan.chain.genesisHash,
    "the gate report is for another chain",
  );
  if (plan.chain.genesisHash === MAINNET_GENESIS) requireMainnetWrapperReport(gateReport, plan);
  refuse(infra?.domain === "postern.dex.mainnet-infra-plan.v1", "unsupported infra plan");
  refuse(
    infra.chain?.id === plan.chain.id && infra.chain?.genesisHash === plan.chain.genesisHash,
    "the infra plan is for another chain",
  );
  return {
    schemaVersion: 1,
    domain: RECORD_DOMAIN,
    status: "liquidity-enabled",
    plan,
    config,
    gateReport,
    infra: { domain: infra.domain, chain: infra.chain, contracts: infra.contracts },
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1]) {
      console.error(
        "Usage: node scripts/staging/frontend-record.mjs --config <c> --plan <p> --infra-plan <i> --gate-report <g> --write <out>",
      );
      process.exit(2);
    }
    return args[i + 1];
  };
  const read = (flag) => JSON.parse(readFileSync(get(flag), "utf8"));
  try {
    const record = assembleRecord({
      config: read("--config"),
      plan: read("--plan"),
      infra: read("--infra-plan"),
      gateReport: read("--gate-report"),
    });
    writeFileSync(get("--write"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${get("--write")} (chain ${record.plan.chain.id}, ${record.plan.pairs.length} pairs)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
