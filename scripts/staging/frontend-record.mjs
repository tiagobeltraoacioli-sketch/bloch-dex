#!/usr/bin/env node
// Assemble the frontend's mainnet deployment record
// (deployments/mainnet/dex-mainnet.record.json) from the reviewed config, the
// committed plan, the infra plan (Multicall3 and the CREATE2 deployer) and the
// schema-2 finality gate report (the JSON printed by check-finality-gate.mjs). The frontend re-verifies everything (config hash,
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
