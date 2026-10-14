import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFinalityGate, GATE_DOMAIN } from "./finality-gate.mjs";

const hex = (n) => `0x${n.toString(16)}`;
const hash = (c) => `0x${c.repeat(64)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addr = (c) => `0x${c.repeat(40)}`;
const FACTORY = addr("f");
const PAIR = addr("e");
const WRAPPED = addr("1");
const ASSET = addr("2");
const CAP = 10n ** 18n;
const TX = hash("a");

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    domain: GATE_DOMAIN,
    chain: { id: 700771, genesisHash: hash("9") },
    deployment: { factory: FACTORY, wrappedNative: WRAPPED, pair: PAIR, transactions: [TX] },
    limits: { maxWrappedReserveCap: "10000000000000000000" },
    ...overrides,
  };
}

function rpc(change = {}) {
  const state = {
    chainId: hex(700771),
    genesis: { number: "0x0", hash: config().chain.genesisHash },
    finalized: { number: hex(214), hash: hash("b") },
    reported: { number: hex(214), hash: hash("b") },
    receipt: { transactionHash: TX, status: "0x1", blockNumber: hex(214), blockHash: hash("b") },
    canonical: { 214: hash("b") },
    factoryCap: CAP,
    pairCaps: [CAP, 0n],
    token0: WRAPPED,
    token1: ASSET,
    registered: PAIR,
    ...change,
  };
  const calls = [];
  const request = async (method, params) => {
    calls.push([method, params]);
    switch (method) {
      case "eth_chainId":
        return state.chainId;
      case "eth_getBlockByNumber": {
        const [tag] = params;
        if (tag === "0x0") return state.genesis;
        if (tag === "finalized") return state.finalized;
        const number = Number(BigInt(tag));
        return state.canonical[number] ? { number: tag, hash: state.canonical[number] } : null;
      }
      case "bloch_finality":
        return { finalized: state.reported, trust: "finalized: native FFG replay; no checkpoint signatures" };
      case "eth_getTransactionReceipt":
        return params[0] === TX ? state.receipt : null;
      case "eth_getCode":
        assert.deepEqual(params[1], { blockHash: state.finalized.hash, requireCanonical: true });
        return "0x6001";
      case "eth_call": {
        assert.deepEqual(params[1], { blockHash: state.finalized.hash, requireCanonical: true });
        const { to, data } = params[0];
        if (to === FACTORY && data.startsWith("0xbb75fd60")) return `0x${word(state.factoryCap)}`;
        if (to === FACTORY && data.startsWith("0xe6a43905")) return `0x${state.registered.slice(2).padStart(64, "0")}`;
        if (to === PAIR && data === "0x0dfe1681") return `0x${state.token0.slice(2).padStart(64, "0")}`;
        if (to === PAIR && data === "0xd21220a7") return `0x${state.token1.slice(2).padStart(64, "0")}`;
        if (to === PAIR && data === "0xd3dc9b31") return `0x${word(state.pairCaps[0])}${word(state.pairCaps[1])}`;
        throw new Error(`unexpected call ${to} ${data}`);
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
  return { request, calls };
}

test("enables liquidity from finalized chain state alone", async () => {
  const { request, calls } = rpc();
  const report = await evaluateFinalityGate(config(), request);
  assert.equal(report.decision, "liquidity-enabled");
  assert.equal(report.finalized.number, "214");
  assert.equal(report.wrappedReserveCap, CAP.toString());
  assert.equal(report.transactions[0].blockNumber, "214");
  assert.ok(!calls.some(([method]) => /sign|personal/.test(method)));
});

test("refuses unfinalized, reverted, reorged, uncapped and mismatched deployments", async () => {
  for (const [change, pattern] of [
    [{ chainId: hex(1) }, /chain ID/],
    [{ genesis: { number: "0x0", hash: hash("c") } }, /genesis/],
    [{ finalized: { number: "0x0", hash: hash("b") } }, /beyond genesis/],
    [{ reported: { number: hex(213), hash: hash("d") } }, /older finalized/],
    [{ receipt: { transactionHash: TX, status: "0x0", blockNumber: hex(214), blockHash: hash("b") } }, /reverted/],
    [{ receipt: { transactionHash: TX, status: "0x1", blockNumber: hex(215), blockHash: hash("c") } }, /not finalized/],
    [{ canonical: { 214: hash("d") } }, /canonical/],
    [{ factoryCap: 0n }, /does not cap/],
    [{ factoryCap: 11n * CAP }, /exceeds/],
    [{ token0: ASSET, token1: addr("3") }, /wrapped native token/],
    [{ registered: addr("4") }, /register/],
    [{ pairCaps: [CAP / 2n, 0n] }, /differs/],
  ]) {
    await assert.rejects(evaluateFinalityGate(config(), rpc(change).request), pattern);
  }
});

test("validates the configuration before any RPC request", async () => {
  const { request, calls } = rpc();
  for (const bad of [
    config({ domain: "other" }),
    config({ limits: { maxWrappedReserveCap: "0" } }),
    config({ deployment: { factory: FACTORY, wrappedNative: WRAPPED, pair: PAIR, transactions: [] } }),
    config({ deployment: { factory: FACTORY, wrappedNative: WRAPPED, pair: PAIR, transactions: [TX, TX] } }),
    config({ deployment: { factory: FACTORY.toUpperCase(), wrappedNative: WRAPPED, pair: PAIR, transactions: [TX] } }),
    { ...config(), signatures: [] },
  ]) {
    await assert.rejects(evaluateFinalityGate(bad, request), /finality gate/);
  }
  assert.equal(calls.length, 0);
});
