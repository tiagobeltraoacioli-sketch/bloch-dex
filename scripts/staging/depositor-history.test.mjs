import assert from "node:assert/strict";
import test from "node:test";
import { verifyDepositorHistory } from "./finality-gate.mjs";

const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const depositor = address(1), token = address(2), router = address(3);
const checkpoint = { number: 20n, hash: hash(20) };
const approve = `0x095ea7b3${router.slice(2).padStart(64, "0")}${"0".repeat(63)}1`;

function fixture(change = {}) {
  const tx = {
    hash: hash(100), from: depositor, to: token, nonce: "0x0", input: approve,
    blockNumber: "0xa", blockHash: hash(10), ...change.tx,
  };
  const receipt = {
    transactionHash: hash(100), from: depositor, to: token, status: "0x0",
    blockNumber: "0xa", blockHash: hash(10), ...change.receipt,
  };
  return {
    options: { depositor, router, tokens: [token], count: 1n, transactions: [hash(100)], checkpoint },
    request: async (method, [arg]) => {
      if (method === "eth_getTransactionByHash") return tx;
      if (method === "eth_getTransactionReceipt") return receipt;
      if (method === "eth_getBlockByNumber") {
        const number = BigInt(arg);
        return { number: arg, hash: change.blocks?.[arg] ?? hash(Number(number)) };
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
}

test("canonical reverted planned transactions remain eligible history", async () => {
  const { options, request } = fixture();
  assert.equal(await verifyDepositorHistory(options, request), 1);
});

for (const [name, change] of [
  ["transaction hash substitution", { tx: { hash: hash(101) } }],
  ["receipt hash substitution", { receipt: { transactionHash: hash(101) } }],
  ["receipt sender substitution", { receipt: { from: address(4) } }],
  ["receipt destination substitution", { receipt: { to: address(4) } }],
  ["inconsistent inclusion height", { receipt: { blockNumber: "0xb" } }],
  ["inconsistent inclusion hash", { receipt: { blockHash: hash(11) } }],
  ["missing transaction inclusion", { tx: { blockNumber: null, blockHash: null } }],
  ["history above the nonce checkpoint", { tx: { blockNumber: "0x15", blockHash: hash(21) }, receipt: { blockNumber: "0x15", blockHash: hash(21) } }],
  ["orphaned transaction", { blocks: { "0xa": hash(99) } }],
  ["checkpoint changed during reads", { blocks: { "0x14": hash(99) } }],
  ["malformed receipt status", { receipt: { status: "success" } }],
  ["nonce above the checkpoint count", { tx: { nonce: "0x1" } }],
]) {
  test(`depositor history refuses ${name}`, async () => {
    const { options, request } = fixture(change);
    await assert.rejects(verifyDepositorHistory(options, request));
  });
}

test("depositor history refuses duplicate hashes even if the nonce is otherwise covered", async () => {
  const { options, request } = fixture();
  options.transactions.push(options.transactions[0]);
  await assert.rejects(verifyDepositorHistory(options, request), /repeats/);
});

test("depositor history refuses a negative account nonce count", async () => {
  const { options, request } = fixture();
  options.count = -1n;
  await assert.rejects(verifyDepositorHistory(options, request), /count is invalid/);
});
