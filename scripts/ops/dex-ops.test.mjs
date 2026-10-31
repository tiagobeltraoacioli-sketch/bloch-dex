// Unit tests of the DEX operations kit, with a fake node. The end-to-end run on
// a private chain is scripts/ops/rehearse-ops-anvil.sh.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABI, CRIT, CallReverted, OK, RpcError, UNKNOWN, WARN, classifyExcess, createRequest, excessFloor, isBricked, keccak256, parseUnits, formatUnits, worst,
} from "./dex-ops-lib.mjs";
import { runMonitor } from "./dex-monitor.mjs";
import { DEFAULTS, runKeeper } from "./dex-skim-keeper.mjs";
import { planOpening, priceGapBps } from "./dex-seed-plan.mjs";
import { assembleSignatures, redemptionMinimums, safeTxHash, safeTxTypedData } from "./dex-fee-redeem.mjs";
import { createRequire } from "node:module";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { privateKeyToAccount } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem/accounts");
const { encodeFunctionResult, decodeFunctionData } = viem;

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const CODE = { pair: "0x6001", token0: "0x6002", token1: "0x6003", factory: "0x6004", router: "0x6005", lens: "0x6006", safe: "0x6007" };
const hashOf = (code) => keccak256(code);
const [T0, T1, PAIR, FACTORY, ROUTER, LENS, SAFE, KEEPER] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => address(0xa00 + n));
const GENESIS = `0x${"ab".repeat(32)}`;
const INIT = `0x${"cd".repeat(32)}`;
const CAP0 = 1_000_000_000n;
const CAP1 = 10n ** 19n;

const gate = {
  schemaVersion: 2,
  chain: { id: 700770, genesisHash: GENESIS },
  deployment: {
    contracts: {
      wrappedNative: { address: T1, codeHash: hashOf(CODE.token1) },
      factory: { address: FACTORY, codeHash: hashOf(CODE.factory) },
      router: { address: ROUTER, codeHash: hashOf(CODE.router) },
      lens: { address: LENS, codeHash: hashOf(CODE.lens) },
    },
    pairInitCodeHash: INIT,
    feeTo: SAFE,
    roles: { blochInc: { address: SAFE, codeHash: hashOf(CODE.safe), safe: { threshold: 3, owners: [] } } },
    reserveCaps: [{ token: T0, cap: String(CAP0) }, { token: T1, cap: String(CAP1) }],
    tokens: [{ token: T0, symbol: "bUSDC", codeHash: hashOf(CODE.token0), bridgeBucketCapacity: "10000000000" }],
    pairs: [{ address: PAIR, token0: T0, token1: T1, codeHash: hashOf(CODE.pair) }],
    transactions: [],
  },
};

/// A fake node: the chain state is plain data the tests change.
function fakeNode(overrides = {}) {
  const now = 2_000_000_000n;
  const chain = {
    now,
    baseFee: 1_000_000_000n,
    reserves: [500_000_000n, 5n * 10n ** 18n],
    balances: [500_000_000n, 5n * 10n ** 18n],
    finalizedReserves: null,
    finalizedBalances: null,
    totalSupply: 10n ** 13n,
    kLast: 25n * 10n ** 26n,
    lpInPair: 0n,
    paused: false,
    keeperBalance: 10n ** 18n,
    nonce: 0n,
    receipts: {},
    sent: [],
    estimate: 80_000n,
    revertSim: false,
    pairCode: CODE.pair,
    allowance: 0n,
    pairCount: 1n,
    ...overrides,
  };
  const reply = (fn, args, block) => {
    const finalized = block === "F";
    const reserves = finalized && chain.finalizedReserves ? chain.finalizedReserves : chain.reserves;
    const balances = finalized && chain.finalizedBalances ? chain.finalizedBalances : chain.balances;
    return reply2(fn, args, { reserves, balances });
  };
  const reply2 = (fn, args, { reserves, balances }) => {
    switch (fn) {
      case "getReserves": return [reserves[0], reserves[1], 1];
      case "reserveCaps": return [CAP0, CAP1];
      case "totalSupply": return chain.totalSupply;
      case "kLast": return chain.kLast;
      case "allPairsLength": return chain.pairCount;
      case "INIT_CODE_PAIR_HASH": return INIT;
      case "paused": return chain.paused;
      case "pausedUntil": return 0n;
      case "availableToMint": return 1n;
      case "decimals": return 6;
      case "allowance": return chain.allowance;
      case "position": return { liquidity: 7n, pendingProtocolLiquidity: 3n, dilutedSupply: 10n, reserveShare0: 1n, reserveShare1: 2n };
      default: throw new Error(`fake: ${fn}`);
    }
  };
  const request = async (method, params) => {
    switch (method) {
      case "eth_chainId": return "0xab162";
      case "eth_getBlockByNumber": {
        const [tag] = params;
        if (tag === "0x0") return { hash: GENESIS };
        if (tag === "finalized" && chain.noFinalized) return null;
        const hash = tag === "finalized" ? "0xF" : "0xL";
        return { number: tag === "finalized" ? "0x5" : "0xa", hash, timestamp: `0x${(now - (tag === "finalized" ? 6000n : 300n)).toString(16)}`, baseFeePerGas: `0x${chain.baseFee.toString(16)}` };
      }
      case "eth_getCode": {
        const [a] = params;
        return { [PAIR]: chain.pairCode, [T0]: CODE.token0, [T1]: CODE.token1, [FACTORY]: CODE.factory, [ROUTER]: CODE.router, [LENS]: CODE.lens, [SAFE]: CODE.safe }[a];
      }
      case "eth_call": {
        const [{ to, data }, at] = params;
        if (chain.revertSim && data.startsWith("0xbc25cf77")) throw new CallReverted("eth_call: execution reverted");
        const { functionName, args } = decodeFunctionData({ abi: ABI, data });
        const blockTag = at?.blockHash === "0xF" ? "F" : "L";
        let value;
        if (functionName === "skim") return "0x";
        if (functionName === "balanceOf") {
          if (to === PAIR) value = chain.lpInPair;
          else {
            const finalized = blockTag === "F" && chain.finalizedBalances;
            value = (finalized ? chain.finalizedBalances : chain.balances)[to === T0 ? 0 : 1];
          }
        } else value = reply(functionName, args, blockTag);
        return encodeFunctionResult({ abi: ABI, functionName, result: value });
      }
      case "eth_estimateGas": return `0x${chain.estimate.toString(16)}`;
      case "eth_getBalance": return `0x${chain.keeperBalance.toString(16)}`;
      case "eth_getTransactionCount": return `0x${chain.nonce.toString(16)}`;
      case "eth_getTransactionReceipt": return chain.receipts[params[0]] ?? null;
      case "eth_sendRawTransaction": chain.sent.push(params[0]); return keccak256(params[0]);
      default: throw new Error(`fake: ${method}`);
    }
  };
  return { chain, request };
}

const monitorDeps = (node) => ({
  now: node.chain.now,
  evaluateGate: async () => ({ decision: "liquidity-enabled", finalized: { number: "5" } }),
  verifySafe: async () => ({}),
});
const levelOf = (result, prefix) => result.checks.filter((c) => c.name.startsWith(prefix)).map((c) => c.level);

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const keeperOptions = (extra = {}) => ({
  keeper: account.address, execute: true, budgetWei: DEFAULTS.budgetWei, maxTx: DEFAULTS.maxTx, maxFeeWei: DEFAULTS.maxFeeWei,
  tipWei: DEFAULTS.tipWei, maxGas: DEFAULTS.maxGas, floorBps: DEFAULTS.floorBps, cooldownSeconds: DEFAULTS.cooldownSeconds,
  pendingTimeoutSeconds: DEFAULTS.pendingTimeoutSeconds, ...extra,
});
const emptyKeeperState = () => ({ schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 });
const signer = async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) =>
  account.signTransaction({ chainId, nonce: Number(nonce), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, to, data, type: "eip1559" });
function keeperDeps(node, now = 1_000_000) {
  const saves = [];
  return { request: node.request, sign: signer, now, save: (s) => saves.push(JSON.stringify(s)), saves };
}
const ABOVE_CAP = [CAP0 + 1n, 5n * 10n ** 18n];

// ---- helpers

test("worst ranks CRIT over UNKNOWN over WARN over OK, as the L2 monitor", () => {
  assert.equal(worst([OK, WARN]), WARN);
  assert.equal(worst([WARN, UNKNOWN]), UNKNOWN);
  assert.equal(worst([UNKNOWN, CRIT, OK]), CRIT);
});

test("classifyExcess separates dust, material, blocking and impossible", () => {
  const side = (reserve, balance) => ({ reserve, balance, cap: 1000n });
  assert.equal(excessFloor(side(0n, 0n)), 10n);
  assert.equal(classifyExcess(side(500n, 500n)), "none");
  assert.equal(classifyExcess(side(500n, 509n)), "dust");
  assert.equal(classifyExcess(side(500n, 510n)), "material");
  assert.equal(classifyExcess(side(500n, 1000n)), "blocking");
  assert.equal(classifyExcess(side(1000n, 1001n)), "dust", "one wei above a full reserve is not an alarm");
  assert.equal(classifyExcess(side(500n, 499n)), "negative");
});

test("isBricked needs both reserves at cap and no LP shares", () => {
  const at = { reserve: 5n, cap: 5n };
  const below = { reserve: 4n, cap: 5n };
  assert.equal(isBricked({ totalSupply: 0n, sides: [at, at] }), true);
  assert.equal(isBricked({ totalSupply: 0n, sides: [at, below] }), false);
  assert.equal(isBricked({ totalSupply: 1n, sides: [at, at] }), false);
});

test("parseUnits and formatUnits round-trip and refuse lost precision", () => {
  assert.equal(parseUnits("25.5", 6), 25_500_000n);
  assert.equal(formatUnits(25_500_000n, 6), "25.5");
  assert.throws(() => parseUnits("1.0000001", 6));
});

test("createRequest refuses a method outside its list before any request", async () => {
  let called = false;
  const request = createRequest("http://x", { fetchImpl: async () => { called = true; } });
  await assert.rejects(request("eth_sendRawTransaction", ["0x"]), /refused/);
  assert.equal(called, false);
});

test("createRequest separates node failures from reverts", async () => {
  const fail = createRequest("http://x", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(fail("eth_call", []), RpcError);
  const revert = createRequest("http://x", { fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: "execution reverted", data: "0x" } }) }) });
  await assert.rejects(revert("eth_call", []), CallReverted);
});

// ---- monitor

test("monitor: a healthy pair is OK", async () => {
  const node = fakeNode();
  const result = await runMonitor(gate, {}, node.request, monitorDeps(node));
  assert.equal(result.level, OK, JSON.stringify(result.checks.filter((c) => c.level)));
  assert.equal(result.facts.pairs[PAIR].fee.minted, 7n);
  assert.equal(result.facts.pairs[PAIR].fee.pending, 3n);
});

test("monitor: gate refusal and Safe drift are CRIT", async () => {
  const node = fakeNode();
  const refused = await runMonitor(gate, {}, node.request, { ...monitorDeps(node), evaluateGate: async () => { throw new Error("finality gate: refused"); } });
  assert.deepEqual(levelOf(refused, "finality_gate"), [CRIT]);
  const drift = await runMonitor(gate, {}, node.request, { ...monitorDeps(node), verifySafe: async () => { throw new Error("owners differ"); } });
  assert.deepEqual(levelOf(drift, "safe_pinned"), [CRIT, CRIT]);
  assert.equal(drift.level, CRIT);
});

test("monitor: changed pair code is CRIT", async () => {
  const node = fakeNode({ pairCode: "0x6666" });
  const result = await runMonitor(gate, {}, node.request, monitorDeps(node));
  assert.deepEqual(levelOf(result, "contract_code"), [CRIT]);
});

test("monitor: a node failure is UNKNOWN, not CRIT", async () => {
  const result = await runMonitor(gate, {}, async () => { throw new RpcError("down"); }, {});
  assert.equal(result.level, UNKNOWN);
});

test("monitor: a wrong chain is CRIT", async () => {
  const node = fakeNode();
  const wrong = async (m, p) => (m === "eth_chainId" ? "0x1" : node.request(m, p));
  assert.equal((await runMonitor(gate, {}, wrong, monitorDeps(node))).level, CRIT);
});

test("monitor: blocking excess is WARN at latest and CRIT once finalized", async () => {
  const atLatest = fakeNode({ balances: ABOVE_CAP, finalizedBalances: [500_000_000n, 5n * 10n ** 18n] });
  const a = await runMonitor(gate, {}, atLatest.request, monitorDeps(atLatest));
  assert.equal(a.level, WARN, JSON.stringify(a.checks.filter((c) => c.level)));
  const atFinalized = fakeNode({ balances: ABOVE_CAP, finalizedBalances: ABOVE_CAP });
  assert.equal((await runMonitor(gate, {}, atFinalized.request, monitorDeps(atFinalized))).level, CRIT);
});

test("monitor: dust stays OK; a stale head and a missing finalized block alarm", async () => {
  const dust = fakeNode({ balances: [500_000_001n, 5n * 10n ** 18n] });
  assert.equal((await runMonitor(gate, {}, dust.request, monitorDeps(dust))).level, OK);
  const old = fakeNode();
  const staleHead = await runMonitor(gate, {}, old.request, { ...monitorDeps(old), now: old.chain.now + 3000n });
  assert.deepEqual(levelOf(staleHead, "l2_head_age"), [CRIT]);
  const none = fakeNode({ noFinalized: true });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, none.request, monitorDeps(none)), "l2_finalized_age"), [CRIT]);
});

test("monitor: reserves against caps", async () => {
  const high = fakeNode({ reserves: [850_000_000n, 5n * 10n ** 18n], balances: [850_000_000n, 5n * 10n ** 18n] });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, high.request, monitorDeps(high)), `reserve_cap[${PAIR}:${T0}`), [WARN]);
  const full = fakeNode({ reserves: [CAP0, 5n * 10n ** 18n], balances: [CAP0, 5n * 10n ** 18n] });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, full.request, monitorDeps(full)), `reserve_cap[${PAIR}:${T0}`), [WARN]);
  const over = fakeNode({ reserves: [CAP0 + 1n, 5n * 10n ** 18n], balances: [CAP0 + 1n, 5n * 10n ** 18n] });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, over.request, monitorDeps(over)), `reserve_cap[${PAIR}:${T0}`), [CRIT]);
});

test("monitor: pre-seed states", async () => {
  const preseed = (reserves, balances, options = {}) => {
    const node = fakeNode({ totalSupply: 0n, kLast: 0n, reserves, balances });
    return runMonitor(gate, options, node.request, monitorDeps(node));
  };
  assert.deepEqual(levelOf(await preseed([0n, 0n], [0n, 0n]), "preseed"), [OK]);
  assert.deepEqual(levelOf(await preseed([0n, 0n], [0n, 0n], { expectSeeded: true }), "preseed"), [WARN]);
  assert.deepEqual(levelOf(await preseed([0n, 0n], [1n, 0n]), "preseed"), [WARN]);
  assert.deepEqual(levelOf(await preseed([1n, 1n], [1n, 1n]), "preseed"), [CRIT]);
  const bricked = await preseed([CAP0, CAP1], [CAP0, CAP1]);
  assert.match(bricked.checks.find((c) => c.name.startsWith("preseed")).detail, /DEX-09/);
});

test("monitor: stranded LP shares are CRIT, a leftover allowance WARN, extra pairs WARN, pause WARN", async () => {
  const lp = fakeNode({ lpInPair: 5n });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, lp.request, monitorDeps(lp)), "lp_in_pair"), [CRIT]);
  const allowance = fakeNode({ allowance: 5n });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, allowance.request, monitorDeps(allowance)), "safe_allowance"), [WARN]);
  const pairs = fakeNode({ pairCount: 2n });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, pairs.request, monitorDeps(pairs)), "pair_count"), [WARN]);
  const paused = fakeNode({ paused: true });
  assert.deepEqual(levelOf(await runMonitor(gate, {}, paused.request, monitorDeps(paused)), "bridge_token"), [WARN]);
});

test("monitor: reference price bands", async () => {
  // Pool: 500 bUSDC / 5 WBLCH = 100 per BLCH. token0 is the quote here.
  const node = fakeNode();
  const at = async (refPrice) => levelOf(await runMonitor(gate, { refPrice }, node.request, monitorDeps(node)), "reference_price");
  assert.deepEqual(await at("100"), [OK]);
  assert.deepEqual(await at("108"), [WARN]);
  assert.deepEqual(await at("150"), [CRIT]);
});

test("monitor: a dump shows at latest before it is finalized", async () => {
  const dumped = [CAP0, 10n ** 17n];
  const node = fakeNode({ reserves: dumped, balances: dumped, finalizedReserves: [500_000_000n, 5n * 10n ** 18n], finalizedBalances: [500_000_000n, 5n * 10n ** 18n] });
  const result = await runMonitor(gate, { refPrice: "100" }, node.request, monitorDeps(node));
  assert.deepEqual(levelOf(result, `reserve_cap[${PAIR}:${T0}`), [WARN]);
  assert.deepEqual(levelOf(result, "reference_price"), [CRIT]);
  assert.deepEqual(levelOf(result, "price_drift"), [CRIT]);
});

// ---- keeper

test("keeper: nothing to do on a clean pair and on dust", async () => {
  for (const balances of [[500_000_000n, 5n * 10n ** 18n], [500_000_001n, 5n * 10n ** 18n]]) {
    const node = fakeNode({ balances });
    const outcome = await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(node));
    assert.equal(outcome.action, "nothing-to-do");
    assert.equal(outcome.level, OK);
    assert.equal(node.chain.sent.length, 0);
  }
});

test("keeper: a dry run reports and sends nothing", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const outcome = await runKeeper(gate, keeperOptions({ execute: false }), emptyKeeperState(), keeperDeps(node));
  assert.equal(outcome.action, "would-skim");
  assert.equal(node.chain.sent.length, 0);
});

test("keeper: it sends skim(Safe) to the pinned pair, and saves state before publishing", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  let savedBeforeSend = false;
  const request = async (m, p) => {
    if (m === "eth_sendRawTransaction") savedBeforeSend = state.txs.length === 1 && state.txs[0].status === "pending";
    return node.request(m, p);
  };
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node), request });
  assert.equal(outcome.action, "sent");
  assert.equal(savedBeforeSend, true);
  const tx = viem.parseTransaction(node.chain.sent[0]);
  assert.equal(tx.to, PAIR);
  const decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  assert.equal(decoded.functionName, "skim");
  assert.equal(decoded.args[0].toLowerCase(), SAFE);
  assert.equal(tx.gas, 96_000n);
});

test("keeper: one transaction in flight, then a cooldown", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const second = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(second.action, "wait-in-flight");
  node.chain.receipts[state.txs[0].hash] = {
    status: "0x1", blockNumber: "0x9", gasUsed: "0x10000", effectiveGasPrice: "0x3b9aca00",
    logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }],
  };
  const third = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_200));
  assert.equal(third.action, "cooldown");
  assert.equal(state.txs[0].status, "effective");
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: it does not act on a receipt until latest has reached that block", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  node.chain.receipts[state.txs[0].hash] = { status: "0x1", blockNumber: "0xff", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] };
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100))).action, "wait-in-flight");
});

test("keeper: griefing by front-running its skim backs off exponentially", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  // The skim landed after someone else's: no Transfer moved a value.
  node.chain.receipts[state.txs[0].hash] = { status: "0x1", blockNumber: "0x9", gasUsed: "0x10000", effectiveGasPrice: "0x1", logs: [] };
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(outcome.action, "backoff");
  assert.equal(outcome.level, WARN);
  assert.equal(state.consecutiveWasted, 1);
  assert.equal(state.nextAllowedAt, 1_000_100 + 3600);
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: under sustained griefing it stops at the count and the budget", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  const mined = (hash) => { node.chain.receipts[hash] = { status: "0x1", blockNumber: "0x9", gasUsed: "0x10000", effectiveGasPrice: "0x3b9aca00", logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] }; };
  let now = 1_000_000;
  const actions = [];
  for (let i = 0; i < 12; i++) {
    const outcome = await runKeeper(gate, keeperOptions({ maxTx: 3 }), state, keeperDeps(node, now));
    actions.push(outcome.action);
    if (outcome.hash) { mined(outcome.hash); node.chain.nonce += 1n; }
    now += DEFAULTS.cooldownSeconds + 1;
  }
  assert.equal(node.chain.sent.length, 3);
  assert.equal(actions.at(-1), "tx-count-exhausted");

  const small = fakeNode({ balances: ABOVE_CAP });
  // One worst case is 96,000 gas x 3 gwei = 288,000 gwei. This budget fits one.
  const budgetState = emptyKeeperState();
  const options = keeperOptions({ budgetWei: 300_000_000_000_000n, cooldownSeconds: 0 });
  assert.equal((await runKeeper(gate, options, budgetState, keeperDeps(small, now))).action, "sent");
  budgetState.txs[0].status = "expired";
  const refused = await runKeeper(gate, options, budgetState, keeperDeps(small, now + 1));
  assert.equal(refused.action, "budget-exhausted");
  assert.equal(refused.level, WARN);
  assert.equal(small.chain.sent.length, 1);
  // It recovers when the spend leaves the 24 h window.
  assert.equal((await runKeeper(gate, options, budgetState, keeperDeps(small, now + 86_401))).action, "sent");
});

test("keeper: limits refuse without signing", async () => {
  const cases = [
    [{ baseFee: 30_000_000_000n }, "fee-above-ceiling"],
    [{ estimate: 200_000n }, "gas-limit-exceeded"],
    [{ keeperBalance: 1n }, "keeper-underfunded"],
  ];
  for (const [overrides, action] of cases) {
    const node = fakeNode({ balances: ABOVE_CAP, ...overrides });
    const outcome = await runKeeper(gate, keeperOptions(), emptyKeeperState(), { ...keeperDeps(node), sign: async () => { throw new Error("must not sign"); } });
    assert.equal(outcome.action, action);
    assert.equal(outcome.level, WARN);
  }
});

test("keeper: refuses on a changed pair, a failed simulation, the wrong signer, a dead node", async () => {
  const changed = fakeNode({ balances: ABOVE_CAP, pairCode: "0x6666" });
  assert.equal((await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(changed))).level, CRIT);
  const revert = fakeNode({ balances: ABOVE_CAP, revertSim: true });
  const reverted = await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(revert));
  assert.equal(reverted.action, "simulation-reverted");
  assert.equal(revert.chain.sent.length, 0);
  const wrongSigner = fakeNode({ balances: ABOVE_CAP });
  const other = await runKeeper(gate, keeperOptions({ keeper: KEEPER }), emptyKeeperState(), keeperDeps(wrongSigner));
  assert.equal(other.action, "refused");
  assert.equal(wrongSigner.chain.sent.length, 0);
  const dead = await runKeeper(gate, keeperOptions(), emptyKeeperState(), { ...keeperDeps(fakeNode()), request: async () => { throw new RpcError("down"); } });
  assert.equal(dead.level, UNKNOWN);
});

test("keeper: a transport failure on publish stays in flight and keeps the reservation", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  const request = async (m, p) => {
    if (m === "eth_sendRawTransaction") throw new RpcError("eth_sendRawTransaction at http://x: timeout");
    return node.request(m, p);
  };
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node), request });
  assert.equal(outcome.action, "publish-unconfirmed");
  assert.equal(state.txs[0].status, "pending");
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100))).action, "wait-in-flight");
  assert.equal(node.chain.sent.length, 0);
});

// ---- seed plan

const WAD = 10n ** 18n;
const side = (reserve, cap, balance = reserve) => ({ reserve, balance, cap });
const QUOTE_CAP = 1_000_000_000n;
const WRAP_CAP = 10n * WAD;

test("seed plan: 50% of the tighter cap on either side of a price of 100", () => {
  const low = planOpening({ wrapped: side(0n, WRAP_CAP), quote: side(0n, QUOTE_CAP), totalSupply: 0n, price: 25_000_000n, fractionBps: 5000n });
  assert.equal(low.decision, "proceed");
  assert.equal(low.depositWrapped, 5n * WAD);
  assert.equal(low.depositQuote, 125_000_000n);
  const high = planOpening({ wrapped: side(0n, WRAP_CAP), quote: side(0n, QUOTE_CAP), totalSupply: 0n, price: 400_000_000n, fractionBps: 5000n });
  assert.equal(high.depositQuote, 500_000_000n);
  assert.equal(high.depositWrapped, (5n * WAD) / 4n);
});

test("seed plan: an unsynced donation is skimmed first, a seeded pair refused", () => {
  assert.equal(planOpening({ wrapped: side(0n, WRAP_CAP, 1n), quote: side(0n, QUOTE_CAP), totalSupply: 0n, price: 1n, fractionBps: 5000n }).decision, "skim-first");
  assert.equal(planOpening({ wrapped: side(1n, WRAP_CAP), quote: side(1n, QUOTE_CAP), totalSupply: 1n, price: 1n, fractionBps: 5000n }).decision, "refuse");
});

test("seed plan: a synced donation is compensated so the pool opens at the target", () => {
  for (const [rw, rq] of [[WAD / 10n, 0n], [0n, 1_000_000n], [6n * WAD, 1n], [WAD, 900_000_000n]]) {
    const price = 25_000_000n;
    const plan = planOpening({ wrapped: side(rw, WRAP_CAP), quote: side(rq, QUOTE_CAP), totalSupply: 0n, price, fractionBps: 5000n });
    if (plan.decision !== "proceed") {
      assert.equal(rq, 900_000_000n, `only the oversized quote donation is refused, got ${plan.reason}`);
      continue;
    }
    assert.ok(plan.depositWrapped > 0n && plan.depositQuote > 0n);
    const gap = priceGapBps({ wrapped: { reserve: rw + plan.depositWrapped }, quote: { reserve: rq + plan.depositQuote }, price });
    assert.ok(gap <= 1n, `gap ${gap} bps`);
  }
});

test("seed plan: both reserves at cap is reported as bricked", () => {
  assert.equal(planOpening({ wrapped: side(WRAP_CAP, WRAP_CAP), quote: side(QUOTE_CAP, QUOTE_CAP), totalSupply: 0n, price: 1n, fractionBps: 5000n }).decision, "bricked");
});

// ---- fee redemption

test("fee redemption: minimums account for the pending fee", () => {
  const m = redemptionMinimums({ liquidity: 100n, totalSupply: 900n, pending: 100n, reserve0: 1000n, reserve1: 2000n, slippageBps: 100n });
  assert.deepEqual([m.amount0, m.amount1, m.min0, m.min1], [100n, 200n, 99n, 198n]);
});

test("fee redemption: signatures are checked, deduplicated and sorted for the Safe", async () => {
  const accounts = ["22", "33", "44", "55"].map((b) => privateKeyToAccount(`0x${b.repeat(32)}`));
  const owners = accounts.slice(0, 3).map((a) => a.address.toLowerCase());
  const typed = safeTxTypedData({ chainId: 700770, safe: SAFE, to: ROUTER, data: "0x1234", nonce: 7n });
  const hash = safeTxHash(typed);
  const tx = { safe: SAFE, nonce: "7", to: ROUTER, data: "0x1234", safeTxHash: hash };
  const sigs = await Promise.all(accounts.map((a) => a.signTypedData(typed)));
  const done = await assembleSignatures({ tx, signatures: sigs.slice(0, 3), owners, threshold: 3 });
  assert.deepEqual(done.signers, [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
  await assert.rejects(assembleSignatures({ tx, signatures: sigs.slice(0, 2), owners, threshold: 3 }), /threshold/);
  await assert.rejects(assembleSignatures({ tx, signatures: [sigs[0], sigs[0], sigs[1]], owners, threshold: 3 }), /two signatures/);
  await assert.rejects(assembleSignatures({ tx, signatures: [sigs[0], sigs[1], sigs[3]], owners, threshold: 3 }), /not a Safe owner/);
  const personal = `${sigs[0].slice(0, -2)}1f`;
  await assert.rejects(assembleSignatures({ tx, signatures: [personal], owners, threshold: 1 }), /27\/28/);
});
