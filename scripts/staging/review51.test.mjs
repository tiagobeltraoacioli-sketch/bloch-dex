// Agent 51 review: a front-run of the planned createPair strands the record.
// The third party's pair is byte-identical (same CREATE2 address, same caps),
// so the plan should accept it. This test fails on the RC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { verifyBroadcast } from "./deploy-dex.mjs";
import { gateConfigFromPlan } from "./dex-deploy-config.mjs";

const { keccak256, stringToHex } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");

const FACTORY = `0x${"f".repeat(40)}`;
const DEPLOYER = `0x${"d".repeat(40)}`;
const PAIR = `0x${"a".repeat(40)}`;
const T0 = `0x${"1".repeat(40)}`;
const T1 = `0x${"2".repeat(40)}`;
const HASH = `0x${"1".repeat(64)}`;
const INIT = `0x${"c".repeat(64)}`;
const CODE = "0x6001";
const CODE_HASH = keccak256(CODE);
const plan = {
  deployer: DEPLOYER,
  contracts: { factory: { address: FACTORY } },
  pairInitCodeHash: INIT,
  pairCodeHash: CODE_HASH,
  reserveCaps: [{ token: T0, cap: "10" }, { token: T1, cap: "20" }],
  pairs: [{ address: PAIR, token0: T0, token1: T1, codeHash: CODE_HASH }],
  steps: [{ nonce: 4, action: "createPair", address: PAIR, tokenA: T0, tokenB: T1 }],
};
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const sig = (s) => keccak256(stringToHex(s)).slice(0, 10);
const chain = (over = {}) => {
  const values = {
    [sig("getPair(address,address)")]: `0x${word(PAIR)}`,
    [sig("INIT_CODE_PAIR_HASH()")]: INIT,
    [sig("factory()")]: `0x${word(FACTORY)}`,
    [sig("token0()")]: `0x${word(T0)}`,
    [sig("token1()")]: `0x${word(T1)}`,
    [sig("reserveCaps()")]: `0x${word(10)}${word(20)}`,
    [sig("getReserves()")]: `0x${word(3)}${word(4)}${word(0)}`,
    [sig("totalSupply()")]: `0x${word(5)}`,
    ...over,
  };
  return async (method, params) => {
    if (method === "eth_getTransactionByHash") return { hash: HASH, from: DEPLOYER, nonce: "0x4", to: FACTORY, input: "0x" };
    if (method === "eth_getTransactionReceipt") return { transactionHash: HASH, status: "0x0" };
    if (method === "eth_getCode") return over.code ?? CODE;
    if (method === "eth_call") return values[params[0].data.slice(0, 10)];
    throw new Error(`unexpected ${method}`);
  };
};

test("review51 F2: record must accept a planned pair a third party created first", async () => {
  const seen = [];
  assert.deepEqual(await verifyBroadcast(plan, [HASH], chain(), (hash, state) => seen.push([hash, state])), [HASH]);
  assert.equal(seen[0][0], HASH);
  assert.equal(seen[0][1].decision, "existing-pair-identical");
  assert.equal(seen[0][1].totalSupply, "5");
});

test("F2: a reverted createPair is refused unless the existing pair is identical", async () => {
  const cases = [
    [{ [sig("getPair(address,address)")]: `0x${word(`0x${"e".repeat(40)}`)}` }, /registers/],
    [{ [sig("INIT_CODE_PAIR_HASH()")]: `0x${"d".repeat(64)}` }, /init code hash/],
    [{ code: "0x6002" }, /runtime code/],
    [{ [sig("factory()")]: `0x${word(`0x${"e".repeat(40)}`)}` }, /another factory/],
    [{ [sig("token0()")]: `0x${word(`0x${"e".repeat(40)}`)}` }, /token0/],
    [{ [sig("reserveCaps()")]: `0x${word(11)}${word(20)}` }, /caps differ/],
  ];
  for (const [over, message] of cases) await assert.rejects(verifyBroadcast(plan, [HASH], chain(over)), message);
});

test("F2: only a createPair may revert", async () => {
  const other = { ...plan, steps: [{ nonce: 4, action: "deploy factory", address: FACTORY, initCodeHash: HASH }] };
  await assert.rejects(verifyBroadcast(other, [HASH], chain()), /reverted/);
});

test("F2: the gate configuration records the reverted createPair", () => {
  const full = { ...plan, chain: { id: 1, genesisHash: HASH }, feeTo: DEPLOYER, roles: {}, externalTokens: [], gate: { maxWrappedReserveCap: "1" } };
  assert.deepEqual(gateConfigFromPlan(full, [HASH], "d", [HASH]).deployment.existingPairTransactions, [HASH]);
  assert.equal(Object.hasOwn(gateConfigFromPlan(full, [HASH], "d").deployment, "existingPairTransactions"), false);
});
