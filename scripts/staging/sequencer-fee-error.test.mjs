import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcResponseError } from "./rpc-transport.mjs";
import { sequencerFeeRequirement } from "./sequencer-fee-error.mjs";

const transactionHash = `0x${"12".repeat(32)}`;
const quote = {
  kind: "sequencer-fee-underpriced", scope: "latest-state-next-block",
  transactionHash, headHash: `0x${"34".repeat(32)}`, headNumber: "0xa",
  baseFeePerGas: "0x3b9aca00", requiredPriorityFeePerGas: "0x77359400",
  requiredMaxFeePerGas: "0xb2d05e00", effectivePriorityFeePerGas: "0x3b9aca00",
  gasUsed: "0xc350", freshSlots: "0x1", chargedFreshSlots: "0x1", freshSlotPriceWei: "0x5af3107a4000",
};
const refusal = (data = quote) => new JsonRpcResponseError("eth_sendRawTransaction", {
  code: -32000, message: "transaction underpriced for sequencer policy", data,
});

test("admission fee refusal returns exact decimal wei and head-specific guidance", () => {
  for (const error of [refusal(), new Error("wrapped RPC failure", { cause: refusal() })]) {
    const result = sequencerFeeRequirement(error, transactionHash);
    assert.equal(result.requiredPriorityFeePerGas, "2000000000");
    assert.equal(result.requiredMaxFeePerGas, "3000000000");
    assert.equal(result.freshSlotPriceWei, "100000000000000");
    assert.equal(result.headNumber, "10");
    assert.equal(result.headHash, quote.headHash);
    assert.match(result.guidance, /inclusion is not guaranteed/);
    assert.match(result.guidance, /No automatic retry or fee increase/);
  }
});

test("admission fee refusal accepts an exempt sender and exact uint256-scale arithmetic", () => {
  const big = { ...quote, chargedFreshSlots: "0x0", freshSlotPriceWei: "0x0", requiredPriorityFeePerGas: `0x${"f".repeat(40)}` };
  big.requiredMaxFeePerGas = `0x${(BigInt(big.requiredPriorityFeePerGas) + BigInt(big.baseFeePerGas)).toString(16)}`;
  const result = sequencerFeeRequirement(refusal(big), transactionHash);
  assert.equal(result.requiredPriorityFeePerGas, BigInt(big.requiredPriorityFeePerGas).toString());
});

for (const [name, changes] of [
  ["another transaction", { transactionHash: `0x${"56".repeat(32)}` }],
  ["unknown kind", { kind: "underpriced" }],
  ["unknown scope", { scope: "pending" }],
  ["missing head", { headHash: undefined }],
  ["zero head", { headHash: `0x${"0".repeat(64)}` }],
  ["decimal quantity", { requiredPriorityFeePerGas: "2000000000" }],
  ["number quantity", { requiredPriorityFeePerGas: 2_000_000_000 }],
  ["leading zero quantity", { gasUsed: "0x0c350" }],
  ["overflow quantity", { headNumber: `0x1${"0".repeat(64)}` }],
  ["zero gas", { gasUsed: "0x0" }],
  ["understated max fee", { requiredMaxFeePerGas: "0x77359400" }],
  ["excess charged slots", { chargedFreshSlots: "0x2" }],
  ["sufficient current tip", { effectivePriorityFeePerGas: "0x77359400" }],
  ["insufficient quoted storage fee", { freshSlotPriceWei: "0xffffffffffffffff" }],
]) test(`admission fee decoder refuses ${name}`, () => {
  assert.equal(sequencerFeeRequirement(refusal({ ...quote, ...changes }), transactionHash), null);
});

test("unverified error objects and generic RPC failures are never preflight refusals", () => {
  assert.equal(sequencerFeeRequirement({ rpcError: refusal().rpcError }, transactionHash), null);
  assert.equal(sequencerFeeRequirement(new Error("nonce too low"), transactionHash), null);
  const error = refusal();
  error.rpcError.code = -32005;
  assert.equal(sequencerFeeRequirement(error, transactionHash), null);
});
