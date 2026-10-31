// Agent 51 review: a front-run of the planned createPair strands the record.
// The third party's pair is byte-identical (same CREATE2 address, same caps),
// so the plan should accept it. This test fails on the RC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyBroadcast } from "./deploy-dex.mjs";

const FACTORY = `0x${"f".repeat(40)}`;
const DEPLOYER = `0x${"d".repeat(40)}`;
const PAIR = `0x${"a".repeat(40)}`;
const HASH = `0x${"1".repeat(64)}`;
const plan = {
  deployer: DEPLOYER,
  contracts: { factory: { address: FACTORY } },
  steps: [{ nonce: 4, action: "createPair", address: PAIR }],
};
const request = async (method) => {
  if (method === "eth_getTransactionByHash") return { hash: HASH, from: DEPLOYER, nonce: "0x4", to: FACTORY, input: "0x" };
  if (method === "eth_getTransactionReceipt") return { transactionHash: HASH, status: "0x0" };
  if (method === "eth_getCode") return "0x6001";
  throw new Error(`unexpected ${method}`);
};

test("review51 F2: record must accept a planned pair a third party created first", async () => {
  assert.deepEqual(await verifyBroadcast(plan, [HASH], request), [HASH]);
});
