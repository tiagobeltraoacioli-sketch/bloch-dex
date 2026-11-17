// Reviewer 369 (round 18): demonstrations of findings R369-n against the owner-run DEX tools
// (agents/369-dex-owner-tools-review-r18.md). Each test PASSES while the defect is present: it asserts the
// defective behaviour, so a fix turns it red and the developer restates it as a regression test of the fix.
// No RPC, no key, nothing signed.
//   node --test scripts/multichain/review/r369-owner-tools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PENDING, lower, loadArtifacts, loadChain, loadShared, planChain, validateChain, validateShared } from "../lib.mjs";
import { evaluateGate } from "../gate.mjs";
import { offlineProblems } from "../check-depositor.mjs";
import { LOCKED_SHARES, MINT_TOPIC, TRANSFER_TOPIC, openingFromReceipt, readOpening } from "../opening.mjs";

const viem = createRequire(new URL("../../../frontend/package.json", import.meta.url))("viem");
const clone = (v) => JSON.parse(JSON.stringify(v));
const committed = loadShared();
const open = (() => {
  const s = clone(committed);
  s.firstDepositor = PENDING;
  delete s.firstDepositorCheck;
  return validateShared(s);
})();
const artifacts = loadArtifacts();
const base = validateChain({ ...clone(loadChain("base")), reserveCaps: PENDING }, "base");

/** A stand-in chain for the gate (same shape as multichain.test.mjs's gate world). */
function gateWorld(local, chain, plan, over = {}) {
  const { keccak256, encodeFunctionResult, parseAbi, toFunctionSelector, toHex } = viem;
  const code = (label) => toHex(`code:${label}`);
  const abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)"]);
  const names = Object.fromEntries(abi.map((f) => [toFunctionSelector(f), f.name]));
  const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.wrappedNative.address), code("wrapped")], [lower(chain.tokens[0].address), code("token")], [lower(chain.multicall3.address), code("multicall")], [lower(local.feeTo.address), over.feeCode ?? "0x"]]);
  if (over.depositorCode) codes.set(lower(plan.arguments.firstDepositor), over.depositorCode);
  const asked = [];
  const request = async (method, params) => {
    asked.push(method);
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
    if (method === "eth_getCode") return codes.get(lower(params[0])) ?? "0x";
    if (method === "eth_getTransactionCount") return over.depositorNonce ?? "0x0";
    if (method === "eth_call") {
      const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === lower(params[0].to));
      const fn = names[params[0].data.slice(0, 10)];
      if (fn === "getChainId") return encodeFunctionResult({ abi, functionName: fn, result: 8453n });
      return encodeFunctionResult({ abi, functionName: fn, result: fn === "decimals" ? token.decimals : token[fn] });
    }
    throw new Error(`unexpected ${method}`);
  };
  request.asked = asked;
  return { request, pins: { deployer: keccak256(code("deployer")), wrapped: keccak256(code("wrapped")), token: keccak256(code("token")), multicall: keccak256(code("multicall")) } };
}

test("R369-1: the pre gate takes every state answer from the FIRST endpoint alone; a second endpoint that sees the depositor's EIP-7702 delegation (and a used nonce, and an unidentified fee-address delegate) is asked only for block hashes", async () => {
  const local = clone(open);
  const chain = clone(base);
  const plan0 = planChain(local, chain, artifacts, { reference: true });
  const probe = gateWorld(local, chain, plan0);
  local.create2.deployerCodeHash = probe.pins.deployer;
  chain.wrappedNative.codeHash = probe.pins.wrapped;
  chain.tokens[0].codeHash = probe.pins.token;
  chain.multicall3.codeHash = probe.pins.multicall;
  const plan = planChain(local, chain, artifacts, { reference: true });
  const liar = gateWorld(local, chain, plan).request;
  const truth = gateWorld(local, chain, plan, { depositorCode: `0xef0100${"66".repeat(20)}`, depositorNonce: "0x3", feeCode: `0xef0100${"77".repeat(20)}` }).request;
  // The truthful endpoint alone fails the gate on all three.
  const alone = await evaluateGate({ shared: local, chain, plan, phase: "pre", request: truth, feeProof: { valid: true, problems: [] } });
  assert.equal(alone.decision, "fail");
  assert.match(alone.failed.join("; "), /no code and no EIP-7702 delegation/);
  assert.match(alone.failed.join("; "), /never sent a transaction/);
  assert.match(alone.failed.join("; "), /identified delegate/);
  // With the liar first and the truthful one as the "other" reviewed endpoint, the gate PASSES.
  truth.asked.length = 0;
  const both = await evaluateGate({ shared: local, chain, plan, phase: "pre", request: liar, others: [truth], feeProof: { valid: true, problems: [] } });
  assert.equal(both.decision, "pass", JSON.stringify(both.failed));
  assert.deepEqual([...new Set(truth.asked)].sort(), ["eth_chainId", "eth_getBlockByNumber"], "the second endpoint is never asked for code, nonce or calls");
});

function openingFixture({ pair, router, depositor, token, wrappedIs0, native = 10n ** 19n, tokenAmount = 30_000_000_000n, over = {} }) {
  const abi = viem.parseAbi(["function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)"]);
  const word = (n) => n.toString(16).padStart(64, "0");
  const topic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const zero = `0x${"0".repeat(64)}`;
  const [amount0, amount1] = wrappedIs0 ? [native, tokenAmount] : [tokenAmount, native];
  const hash = `0x${"0e".repeat(32)}`;
  const tx = { hash, from: depositor, to: router, value: `0x${native.toString(16)}`, input: viem.encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [token, tokenAmount, tokenAmount, native, depositor, 2_000_000_000n] }), ...over.tx };
  const receipt = {
    transactionHash: hash, status: "0x1", blockNumber: "0x60", blockHash: `0x${"ab".repeat(32)}`,
    logs: [
      { address: pair, topics: [TRANSFER_TOPIC, zero, zero], data: `0x${word(LOCKED_SHARES)}` },
      { address: pair, topics: [MINT_TOPIC, topic(router)], data: `0x${word(amount0)}${word(amount1)}` },
    ],
    ...over.receipt,
  };
  return { hash, tx, receipt };
}

const openingFacts = () => {
  const plan = planChain(open, base, artifacts, { reference: true });
  const pair = plan.pairs[0];
  return { pair: pair.address, router: plan.contracts.router.address, depositor: plan.arguments.firstDepositor, token: base.tokens[0].address, wrappedIs0: lower(pair.token0) === lower(base.wrappedNative.address) };
};

test("R369-2: an opening is 'proven' from one endpoint's transaction and receipt; the other endpoint only has to hold a block of that hash, and is never asked whether the transaction exists", async () => {
  const facts = openingFacts();
  const fake = openingFixture(facts);
  const liar = async (method) => (method === "eth_getTransactionByHash" ? fake.tx : method === "eth_getTransactionReceipt" ? fake.receipt : { number: "0x60", hash: fake.receipt.blockHash });
  const asked = [];
  // The second endpoint has the block at that height, and has NEVER seen the transaction.
  const truth = async (method) => {
    asked.push(method);
    return method === "eth_getBlockByNumber" ? { number: "0x60", hash: fake.receipt.blockHash, transactions: [] } : null;
  };
  const r = await readOpening({ request: liar, others: [truth], hash: fake.hash, finalizedNumber: 100, ...facts });
  assert.equal(r.proven, true, r.problems.join("; "));
  assert.deepEqual(asked, ["eth_getBlockByNumber"]);
});

test("R369-3: a first deposit sent by the depositing key as an EIP-7702 batch (a wallet's 'smart account' approve+deposit) opens the pool at the right price but can never be proven: the pool is stranded for the page", () => {
  const facts = openingFacts();
  // A type-4 transaction from the depositor to itself (the delegate's execute), carrying approve and addLiquidityBLCH:
  // the pair sees tx.origin = depositor and accepts the first mint; the Mint and lock logs are the real ones.
  const batch = openingFixture({ ...facts, over: { tx: { to: facts.depositor, input: "0xe9ae5c53" } } });
  const r = openingFromReceipt({ ...batch, ...facts });
  assert.equal(r.proven, false);
  assert.match(r.problems.join("; "), /not to the router/);
  // Nothing else in the tools proves an opening (gate.mjs:254-262 has no other path) and the pair can never be opened again.
});

test("R369-5: check-depositor's 'used nowhere in the repository' looks under deployments/ only: a key published in this repository's own scripts (anvil's account 0) passes the offline checks", () => {
  const ANVIL_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // lowercase in scripts/staging/rehearse-deploy-anvil.sh; its key is public
  assert.deepEqual(offlineProblems(ANVIL_0, open), []);
});

test("R369-4: one firstDepositor for all six chains: the documented recovery 'a new depositing account for that chain; chains already finished are not affected' (docs/MULTICHAIN-DEPLOY.md section 10) changes the planned factory of EVERY chain, so the finished chains' post gate, first-deposit and record tools then point at a factory that is not deployed", () => {
  const chainsAll = open.chains.map((key) => validateChain({ ...clone(loadChain(key)), reserveCaps: [] }, key));
  const withDepositor = (address) => {
    const s = clone(open);
    s.firstDepositor = address;
    s.firstDepositorCheck = { address, at: "test", chains: {} };
    return validateShared(s);
  };
  const a = withDepositor(viem.getAddress("0x00000000000000000000000000000000000a11ce"));
  const b = withDepositor(viem.getAddress("0x00000000000000000000000000000000000b0b00"));
  for (const chain of chainsAll) {
    const fa = planChain(a, chain, artifacts).contracts.factory.address;
    const fb = planChain(b, chain, artifacts).contracts.factory.address;
    assert.notEqual(fa, fb, chain.chain.key);
  }
  // There is no per-chain depositor in the shared file's schema: validateShared takes exactly one.
  assert.equal(typeof committed.firstDepositor, "string");
});
