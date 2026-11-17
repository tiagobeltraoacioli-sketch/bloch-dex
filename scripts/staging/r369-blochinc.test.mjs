// Reviewer 369: probes of 366's Bloch Inc owner-EOA rule (4bf1fa1). node --test scripts/staging/r369-blochinc.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { checkOwnerFeeEoa } from "./deploy-dex.mjs";
import { OWNER_FEE_EOA } from "./finality-gate.mjs";
import { checkPinned } from "./check-finality-gate-mainnet.mjs";

const H = `0x${"ab".repeat(32)}`;
const node = ({ code = "0x", hash = H, number = "0x10" } = {}) => async (m, p) => {
  if (m === "eth_getBlockByNumber") return { hash, number };
  if (m === "eth_getBlockByHash") return p[0] === hash ? { hash, number } : null;
  if (m === "eth_getCode") return p[1]?.blockHash === hash ? code : (() => { throw new Error("unknown block"); })();
  throw new Error(m);
};
test("R369 probe: owner EOA accepted only exactly, with no code on two endpoints at one hash", async () => {
  assert.deepEqual((await checkOwnerFeeEoa(OWNER_FEE_EOA, [node(), node()])).block, { number: "16", hash: H });
  await assert.rejects(checkOwnerFeeEoa("0x70997970c51812dc3a010c7d01b50e0d17dc79c8", [node(), node()]), /not the owner's pinned fee address/);
  await assert.rejects(checkOwnerFeeEoa("0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544", [node(), node()]), /not the owner's pinned/); // checksummed spelling: refused (fail closed)
  await assert.rejects(checkOwnerFeeEoa(OWNER_FEE_EOA, [node()]), /two endpoints/);
  await assert.rejects(checkOwnerFeeEoa(OWNER_FEE_EOA, [node(), node({ code: `0xef0100${"63".repeat(20)}` })]), /EIP-7702 delegated \(endpoint 2\)/);
  await assert.rejects(checkOwnerFeeEoa(OWNER_FEE_EOA, [node({ code: "0x6080" }), node()]), /has code \(endpoint 1\)/);
  await assert.rejects(checkOwnerFeeEoa(OWNER_FEE_EOA, [node(), node({ hash: `0x${"cd".repeat(32)}` })]), /endpoint 2 does not know block/);
  await assert.rejects(checkOwnerFeeEoa(OWNER_FEE_EOA, [node(), node({ number: "0x11" })]), /endpoint 2 does not know block/);
});
test("R369 probe: the Safe path without a Safe plan is refused for any other Bloch Inc", () => {
  const PINS = { l2: { chainId: 700770, genesisHash: H }, safe: { runtimeCodeHashes: {} } };
  const gate = { schemaVersion: 2, chain: { id: 700770, genesisHash: H }, deployment: { feeTo: "0x0000000000000000000000000000000000000001", roles: { blochInc: { address: "0x0000000000000000000000000000000000000001", codeHash: H } } } };
  assert.throws(() => checkPinned(gate, null, PINS), /Safe plan is not for the pinned mainnet/);
  const eoaGate = { ...gate, deployment: { feeTo: OWNER_FEE_EOA, roles: { blochInc: { address: OWNER_FEE_EOA, codeHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" } } } };
  assert.equal(checkPinned(eoaGate, null, PINS), true);
  assert.throws(() => checkPinned(eoaGate, { chain: {} }, PINS), /do not pass a Safe plan/);
  assert.throws(() => checkPinned({ ...eoaGate, deployment: { ...eoaGate.deployment, feeTo: "0x0000000000000000000000000000000000000002" } }, null, PINS), /fee recipient/);
});
