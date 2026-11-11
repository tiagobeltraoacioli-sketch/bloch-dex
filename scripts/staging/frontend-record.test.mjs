import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assembleRecord, RECORD_DOMAIN } from "./frontend-record.mjs";

const GENESIS = `0x${"9".repeat(64)}`;
const input = () => ({
  config: { network: { chainId: 700770, genesisHash: GENESIS } },
  plan: { domain: "postern.dex.mainnet-plan.v1", chain: { id: 700770, genesisHash: GENESIS, rehearsal: false }, pairs: [] },
  infra: {
    domain: "postern.dex.mainnet-infra-plan.v1",
    chain: { id: 700770, genesisHash: GENESIS, rehearsal: false },
    contracts: { multicall3: { address: `0x${"a".repeat(40)}`, codeHash: `0x${"b".repeat(64)}` } },
    steps: [],
  },
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
  assert.deepEqual(record.infra.contracts, input().infra.contracts);
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
  assert.throws(edit((i) => (i.infra = undefined)), /infra plan/);
  assert.throws(edit((i) => (i.infra.chain.genesisHash = `0x${"1".repeat(64)}`)), /infra plan is for another chain/);
});

// F-L2 (round 15): on the pinned mainnet genesis only the mainnet wrapper's report is accepted.
const PINNED = JSON.parse(readFileSync(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8")).l2.genesisHash;
const SAFE = `0x${"5".repeat(40)}`;
const TOKEN = `0x${"6".repeat(40)}`;
const WRAPPED = `0x${"7".repeat(40)}`;
const mainnetInput = () => {
  const i = input();
  for (const o of [i.config.network, i.plan.chain, i.infra.chain, i.gateReport]) o.genesisHash = PINNED;
  Object.assign(i.plan, { feeTo: SAFE, contracts: { wrappedNative: { address: WRAPPED } }, reserveCaps: [{ token: TOKEN }, { token: WRAPPED }] });
  Object.assign(i.gateReport, { feeTo: SAFE, pinned: { chainId: 700770, genesisHash: PINNED, safe: SAFE }, bridgeTokens: [{ symbol: "bUSDC", address: TOKEN }] });
  return i;
};

test("F-L2: on the pinned genesis a report of the mainnet gate is accepted", () => {
  assert.equal(assembleRecord(mainnetInput()).status, "liquidity-enabled");
});

test("F-L2: on the pinned genesis a generic-gate report, another Safe, or an unchecked bridge token is refused", () => {
  const edit = (change) => {
    const i = mainnetInput();
    change(i);
    return () => assembleRecord(i);
  };
  assert.throws(edit((i) => delete i.gateReport.pinned), /not written by the mainnet gate/);
  assert.throws(edit((i) => (i.gateReport.pinned.genesisHash = GENESIS)), /not written by the mainnet gate/);
  assert.throws(edit((i) => (i.gateReport.pinned.chainId = 1)), /not written by the mainnet gate/);
  assert.throws(edit((i) => (i.gateReport.pinned.safe = `0x${"4".repeat(40)}`)), /pinned Safe is not the plan's fee recipient/);
  assert.throws(edit((i) => (i.gateReport.feeTo = `0x${"4".repeat(40)}`)), /pinned Safe is not the plan's fee recipient/);
  assert.throws(edit((i) => delete i.gateReport.bridgeTokens), /every bridge token/);
  assert.throws(edit((i) => (i.gateReport.bridgeTokens = [])), /every bridge token/);
  assert.throws(edit((i) => (i.gateReport.bridgeTokens[0].address = WRAPPED)), /every bridge token/);
  assert.throws(edit((i) => i.plan.reserveCaps.push({ token: `0x${"8".repeat(40)}` })), /every bridge token/);
});
