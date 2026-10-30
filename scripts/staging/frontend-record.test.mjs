import test from "node:test";
import assert from "node:assert/strict";
import { assembleRecord, RECORD_DOMAIN } from "./frontend-record.mjs";

const GENESIS = `0x${"9".repeat(64)}`;
const input = () => ({
  config: { network: { chainId: 700770, genesisHash: GENESIS } },
  plan: { domain: "postern.dex.mainnet-plan.v1", chain: { id: 700770, genesisHash: GENESIS, rehearsal: false }, pairs: [] },
  gateReport: {
    domain: "postern.dex.finality-gate.v1",
    schemaVersion: 2,
    decision: "liquidity-enabled",
    chainId: 700770,
    genesisHash: GENESIS,
  },
});

test("wraps a mainnet plan, config and enabling gate report", () => {
  const record = assembleRecord(input());
  assert.equal(record.domain, RECORD_DOMAIN);
  assert.equal(record.status, "liquidity-enabled");
  assert.deepEqual(record.plan, input().plan);
});

test("refuses rehearsal plans, refused gates and mismatched chains", () => {
  const edit = (change) => {
    const i = input();
    change(i);
    return () => assembleRecord(i);
  };
  assert.throws(edit((i) => (i.plan.chain.rehearsal = true)), /not a chain 700770/);
  assert.throws(edit((i) => (i.plan.chain.id = 700771)), /not a chain 700770/);
  assert.throws(edit((i) => (i.gateReport.decision = "refused")), /did not enable/);
  assert.throws(edit((i) => (i.gateReport.schemaVersion = 1)), /unsupported gate/);
  assert.throws(edit((i) => (i.gateReport.genesisHash = `0x${"1".repeat(64)}`)), /another chain/);
  assert.throws(edit((i) => (i.config.network.genesisHash = null)), /genesis/);
});
