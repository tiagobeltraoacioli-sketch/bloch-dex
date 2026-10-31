import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  INFRA_CODE_HASHES,
  infraTransactions,
  loadInfraArtifacts,
  planInfra,
  validateInfraConfig,
  verifyInfra,
  wrapRuntime,
} from "./infra-deploy-config.mjs";
import { parseArgs, preflightInfra } from "./deploy-infra.mjs";

const { getContractAddress, keccak256 } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const committed = () => JSON.parse(readFileSync(new URL("../../deployments/mainnet/700770/infra.config.json", import.meta.url), "utf8"));
const KEY = `0x${"ab".repeat(20)}`;
const config = () => {
  const c = committed();
  c.deployer.address = KEY;
  return c;
};

test("the committed config is refused until the owner fills in the key", () => {
  assert.throws(() => validateInfraConfig(committed()), /TBD-owner/);
  assert.deepEqual(validateInfraConfig(config()).deployer, { address: KEY, startNonce: 0 });
});

test("refuses another chain, a rehearsal flag, extra fields and a bad key", () => {
  const edit = (change) => () => {
    const c = config();
    change(c);
    validateInfraConfig(c);
  };
  assert.throws(edit((c) => (c.network.chainId = 1)), /mainnet chain ID/);
  assert.throws(edit((c) => (c.network.rehearsal = true)), /rehearsal/);
  assert.throws(edit((c) => (c.extra = 1)), /exactly the fields/);
  assert.throws(edit((c) => (c.deployer.address = "0xAB")), /lowercase address/);
});

test("the committed artifacts are the canonical runtime code", () => {
  const { contracts } = loadInfraArtifacts();
  assert.equal(keccak256(contracts.multicall3.runtime), INFRA_CODE_HASHES.multicall3);
  assert.equal(keccak256(contracts.create2Deployer.runtime), INFRA_CODE_HASHES.create2Deployer);
});

test("the plan is deterministic CREATE from the key, in order", () => {
  const plan = planInfra(config());
  assert.equal(plan.contracts.multicall3.address, getContractAddress({ from: KEY, nonce: 0n }).toLowerCase());
  assert.equal(plan.contracts.create2Deployer.address, getContractAddress({ from: KEY, nonce: 1n }).toLowerCase());
  assert.equal(plan.finalNonce, 2);
  assert.deepEqual(plan.steps.map((s) => s.action), ["deploy multicall3", "deploy create2Deployer"]);
  assert.deepEqual(planInfra(config()), plan);
});

test("transactions match the plan and refuse a different plan", () => {
  const plan = planInfra(config());
  const file = infraTransactions(config(), plan);
  assert.equal(file.domain, "postern.dex.raw-txs.v1");
  assert.equal(file.from, KEY);
  file.transactions.forEach((tx, i) => {
    assert.equal(tx.to, null);
    assert.equal(keccak256(tx.data), plan.steps[i].initCodeHash);
    assert.equal(tx.expect, plan.steps[i].address);
  });
  assert.throws(() => infraTransactions(config(), { ...plan, finalNonce: 3 }), /differs/);
});

test("wrapRuntime returns the runtime through a fixed 12-byte constructor", () => {
  assert.equal(wrapRuntime("0xaabb"), "0x61000280600c6000396000f3aabb");
});

test("preflight refuses a wrong genesis, a used key and an occupied address", async () => {
  const plan = planInfra(config());
  const rpc = (over = {}) => async (method, params) => {
    const replies = { eth_chainId: "0xab162", eth_getBlockByNumber: { hash: plan.chain.genesisHash }, eth_getTransactionCount: "0x0", eth_getCode: "0x", ...over };
    return replies[method];
  };
  assert.equal((await preflightInfra(plan, rpc())).decision, "preflight-ok");
  await assert.rejects(preflightInfra(plan, rpc({ eth_getBlockByNumber: { hash: "0x00" } })), /genesis/);
  await assert.rejects(preflightInfra(plan, rpc({ eth_getTransactionCount: "0x1" })), /nonce/);
  await assert.rejects(preflightInfra(plan, rpc({ eth_getCode: "0x60" })), /occupied/);
  assert.throws(() => parseArgs(["nope"]), /unknown command/);
});

test("verifyInfra refuses code that is not canonical", async () => {
  const plan = planInfra(config());
  await assert.rejects(verifyInfra(plan, async () => "0x6000", "latest", () => {}), /runtime code differs/);
  await assert.rejects(verifyInfra({ domain: "other" }, async () => "0x", "latest", () => {}), /unsupported/);
});
