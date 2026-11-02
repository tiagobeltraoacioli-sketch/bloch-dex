// Unit tests of the DEX operations kit, with a fake node. The end-to-end run on
// a private chain is scripts/ops/rehearse-ops-anvil.sh.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABI, CRIT, CallReverted, OK, RpcError, UNKNOWN, WARN, classifyExcess, closureOf, createRequest, excessFloor, isAtKCeiling, isBricked, isClosedByExcess, keccak256, parseUnits, formatUnits, worst,
} from "./dex-ops-lib.mjs";
import { checkKeeperState, runMonitor } from "./dex-monitor.mjs";
import { withBridgeExit } from "./dex-skim-keeper.mjs";
import { DEFAULTS, nextTip, runKeeper } from "./dex-skim-keeper.mjs";
import { checkNotedTxs, holdsSeed, planOpening, priceGapBps } from "./dex-seed-plan.mjs";
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
      case "pendingSupply": case "nextSlot": case "mintCount": case "verifier": {
        if (!chain.v3) throw new CallReverted("eth_call: execution reverted");
        return chain.v3[fn];
      }
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
  pendingTimeoutSeconds: DEFAULTS.pendingTimeoutSeconds, maxTipWei: DEFAULTS.maxTipWei, softShareBps: DEFAULTS.softShareBps,
  hardReserveBps: DEFAULTS.hardReserveBps, ...extra,
});
const emptyKeeperState = () => ({ schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 });
const signer = async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) =>
  account.signTransaction({ chainId, nonce: Number(nonce), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, to, data, type: "eip1559" });
function keeperDeps(node, now = 1_000_000) {
  const saves = [];
  return { request: node.request, sign: signer, now, save: (s) => saves.push(JSON.stringify(s)), saves, random: () => 0n };
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
  const result = await runMonitor(gate, { expectSeeded: true }, node.request, monitorDeps(node));
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
  assert.equal((await runMonitor(gate, { expectSeeded: true }, dust.request, monitorDeps(dust))).level, OK);
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

test("monitor: BridgedStablecoinV3 queue and switch are reported, a V2 token still reads", async () => {
  const ZERO = `0x${"0".repeat(40)}`;
  const detail = (r) => r.checks.filter((c) => c.name.startsWith("bridge_token")).map((c) => c.detail).join("\n");
  const VERIFIER = `0x${"7".repeat(40)}`;
  const v2 = fakeNode();
  const r2 = await runMonitor(gate, {}, v2.request, monitorDeps(v2));
  assert.deepEqual(levelOf(r2, "bridge_token"), [OK]);
  const open = fakeNode({ v3: { pendingSupply: 3_000_000n, nextSlot: 7n, mintCount: 5n, verifier: ZERO } });
  const r3 = await runMonitor(gate, {}, open.request, monitorDeps(open));
  assert.deepEqual(levelOf(r3, "bridge_token"), [OK]);
  assert.match(detail(r3), /2 deposit slot\(s\) opened and not credited, 3000000 pending, 5 credited; committee mints/);
  const switched = fakeNode({ paused: true, v3: { pendingSupply: 0n, nextSlot: 5n, mintCount: 5n, verifier: VERIFIER } });
  const r4 = await runMonitor(gate, {}, switched.request, monitorDeps(switched));
  assert.deepEqual(levelOf(r4, "bridge_token"), [WARN]);
  assert.match(detail(r4), /no signer can end it early/);
  assert.match(detail(r4), /the committee is retired/);
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
  const price = 25_000_000n;
  assert.equal(planOpening({ wrapped: side(5n * WAD, WRAP_CAP), quote: side(125_000_000n, QUOTE_CAP), totalSupply: 1n, price, fractionBps: 5000n }).decision, "refuse");
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

// Agent 51 review. Both tests fail on the RC: a hostile first mint is invisible
// to the pre-seed monitor run, and the planner has no way forward from it.
test("review51 F1d: the pre-seed monitor must flag LP shares nobody planned", async () => {
  const node = fakeNode({ reserves: [1_000_000n, 1_000_000n], balances: [1_000_000n, 1_000_000n], totalSupply: 1_000_000n, kLast: 10n ** 12n });
  const result = await runMonitor(gate, {}, node.request, monitorDeps(node));
  assert.notEqual(result.level, OK);
});

test("review51 F1d: the planner must offer a recovery from a hostile first mint", () => {
  const side = (reserve, cap) => ({ reserve, balance: reserve, cap });
  const plan = planOpening({ wrapped: side(1_000_000n, 10n ** 19n), quote: side(1_000_000n, 10n ** 9n), totalSupply: 1_000_000n, price: 25_500_000n, fractionBps: 5000n });
  assert.notEqual(plan.decision, "refuse", plan.reason);
});

test("F1: a foreign first mint at the price gets a top-up, and a closed pair is named", () => {
  const price = 25_000_000n;
  const small = planOpening({ wrapped: side(WAD, WRAP_CAP), quote: side(25_000_000n, QUOTE_CAP), totalSupply: 5n, price, fractionBps: 5000n });
  assert.equal(small.decision, "top-up");
  assert.equal(small.depositWrapped, 4n * WAD);
  const closed = planOpening({ wrapped: side(WRAP_CAP, WRAP_CAP), quote: side(QUOTE_CAP, QUOTE_CAP), totalSupply: 5n, price, fractionBps: 5000n });
  assert.equal(closed.decision, "closed");
});

test("F1: a correcting swap reaches the target price", () => {
  const price = 25_000_000n;
  const plan = planOpening({ wrapped: side(WAD, WRAP_CAP), quote: side(100_000_000n, QUOTE_CAP), totalSupply: 5n, price, fractionBps: 5000n });
  assert.equal(plan.decision, "correct-price");
  assert.equal(plan.sellWrapped, true);
  const out = (plan.amountIn * 997n * 100_000_000n) / (WAD * 1000n + plan.amountIn * 997n);
  const after = ((100_000_000n - out) * WAD) / (WAD + plan.amountIn);
  assert.ok(after > (price * 99n) / 100n && after < (price * 101n) / 100n, String(after));
});

test("L3: closed means a swap of 0.1% of a cap reverts both ways, including with one side over its cap", async () => {
  const W = 10n ** 19n;
  const Q = 10n ** 9n;
  const side = (reserve, balance, cap) => ({ reserve, balance, cap });
  // Both balances at the caps.
  assert.equal(isClosedByExcess({ sides: [side(8n * W / 10n, W, W), side(8n * Q / 10n, Q, Q)] }), true);
  // Agent 50's real closure: only the WBLCH side is above its cap.
  assert.equal(isClosedByExcess({ sides: [side(8_618_052_029_873_667_082n, 10_618_052_029_873_667_082n, W), side(742_000_000n, 942_000_000n, Q)] }), true);
  // No excess: a side at its cap only closes that direction.
  assert.equal(isClosedByExcess({ sides: [side(W, W, W), side(64n * Q / 100n, 64n * Q / 100n, Q)] }), false);
  // Over the cap by less than a small swap pays down: selling the other side still runs.
  assert.equal(isClosedByExcess({ sides: [side(5n * W / 10n, W + 1n, W), side(Q / 2n, Q / 2n, Q)] }), false);
  // Room on both sides.
  assert.equal(isClosedByExcess({ sides: [side(W / 2n, W / 2n + 5n, W), side(Q / 2n, Q / 2n, Q)] }), false);
});

test("L3: the monitor reports a closed pair as CRIT at latest and names it", async () => {
  const node = fakeNode({
    reserves: [742_000_000n, 8_618_052_029_873_667_082n],
    balances: [942_000_000n, 10_618_052_029_873_667_082n],
    finalizedReserves: [742_000_000n, 8_618_052_029_873_667_082n],
    finalizedBalances: [742_000_000n, 8_618_052_029_873_667_082n],
  });
  const result = await runMonitor(gate, { expectSeeded: true }, node.request, monitorDeps(node));
  assert.equal(result.level, CRIT);
  const closed = result.checks.find((c) => c.name.startsWith("closed_by_excess"));
  assert.equal(closed.level, CRIT);
  assert.match(closed.detail, /pair closed/);
  assert.match(closed.name, /:latest\]$/);
});

// Agent 96's measured state: WBLCH exactly at its cap after a fall, on a pair seeded at 5 + 500.
const AT_CAP = { reserves: [250_375_564n, CAP1], balances: [250_375_564n, CAP1] };
const SOFT = { ...AT_CAP, balances: [250_375_564n, CAP1 + 40_455_000_000_000_000n], finalizedReserves: AT_CAP.reserves, finalizedBalances: AT_CAP.reserves && AT_CAP.balances };
const HARD = { ...AT_CAP, balances: [250_375_564n, CAP1 + 2n * 10n ** 18n], finalizedReserves: AT_CAP.reserves, finalizedBalances: AT_CAP.balances };

test("closure: a donation of about 1 USD on a side at its cap is soft, one of 1% of the cap is hard", () => {
  const sides = (b0, b1) => ({ sides: [{ token: T0, reserve: AT_CAP.reserves[0], balance: b0, cap: CAP0 }, { token: T1, reserve: CAP1, balance: b1, cap: CAP1 }] });
  assert.equal(closureOf(sides(AT_CAP.balances[0], CAP1)), null);
  const soft = closureOf(sides(250_375_564n, SOFT.balances[1]));
  assert.equal(soft.hard, false);
  assert.deepEqual(soft.minOutput, [0n, 40_455_000_000_000_000n]);
  assert.equal(closureOf(sides(250_375_564n, HARD.balances[1])).hard, true);
});

test("closure: agent 50's real closure stays hard", () => {
  const state = { sides: [{ token: T0, reserve: 742_000_000n, balance: 942_000_000n, cap: CAP0 }, { token: T1, reserve: 8_618_052_029_873_667_082n, balance: 10_618_052_029_873_667_082n, cap: CAP1 }] };
  assert.equal(closureOf(state).hard, true);
});

test("k ceiling: exact, one reserve below, and well below", () => {
  const at = (r0, r1) => ({ sides: [{ reserve: r0, cap: CAP0 }, { reserve: r1, cap: CAP1 }] });
  assert.equal(isAtKCeiling(at(800_000_000n, 8n * 10n ** 18n)), true);
  assert.equal(isAtKCeiling(at(800_000_000n, 8n * 10n ** 18n - 2n)), true);
  assert.equal(isAtKCeiling(at(790_000_000n, 79n * 10n ** 17n)), false);
  assert.equal(isAtKCeiling(at(0n, 0n)), false);
});

test("keeper: a soft closure takes the backoff and a small share; a hard one does not", async () => {
  const node = fakeNode(SOFT);
  const state = emptyKeeperState();
  state.nextAllowedAt = 1_000_500;
  const held = await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  assert.equal(held.action, "backoff");
  assert.equal(held.level, WARN);
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(fakeNode(HARD)))).action, "sent");

  const soft = emptyKeeperState();
  const used = Number((BigInt(DEFAULTS.maxTx) * DEFAULTS.softShareBps) / 10_000n);
  soft.txs = Array.from({ length: used }, (_, i) => ({ at: 990_000, hash: `0x${i}`, nonce: "0", status: "wasted", kind: "soft", spentWei: "1" }));
  const stop = await runKeeper(gate, keeperOptions(), soft, keeperDeps(fakeNode(SOFT)));
  assert.equal(stop.action, "soft-closure-share-used");
  assert.equal(stop.level, WARN);
});

test("keeper: ordinary excess cannot spend the reserve, a hard closure can, and an exhausted hard closure is CRIT", async () => {
  const full = (n) => {
    const state = emptyKeeperState();
    state.txs = Array.from({ length: n }, (_, i) => ({ at: 990_000, hash: `0x${i}`, nonce: "0", status: "effective", kind: "excess", spentWei: "1" }));
    return state;
  };
  const reserved = DEFAULTS.maxTx - Number((BigInt(DEFAULTS.maxTx) * DEFAULTS.hardReserveBps) / 10_000n);
  const ordinary = fakeNode({ balances: [CAP0 / 2n + CAP0 / 10n, 5n * 10n ** 18n] });
  const a = await runKeeper(gate, keeperOptions(), full(reserved), keeperDeps(ordinary));
  assert.equal(a.action, "reserved-for-hard-closure");
  assert.equal(a.level, WARN);
  assert.equal((await runKeeper(gate, keeperOptions(), full(reserved), keeperDeps(fakeNode(HARD)))).action, "sent");
  const out = await runKeeper(gate, keeperOptions(), full(DEFAULTS.maxTx), keeperDeps(fakeNode(HARD)));
  assert.equal(out.action, "tx-count-exhausted");
  assert.equal(out.level, CRIT);
});

test("keeper: the tip varies, climbs with waste and stays under the cap", async () => {
  const options = keeperOptions();
  const top = (wasted) => nextTip({ consecutiveWasted: wasted }, options, (n) => n - 1n);
  assert.equal(nextTip({ consecutiveWasted: 0 }, options, () => 0n), DEFAULTS.tipWei);
  assert.equal(top(0), 2n * DEFAULTS.tipWei);
  assert.equal(top(1), 4n * DEFAULTS.tipWei);
  assert.equal(top(2), DEFAULTS.maxTipWei);
  assert.equal(top(40), DEFAULTS.maxTipWei);
  for (let i = 0; i < 50; i++) {
    const tip = nextTip({ consecutiveWasted: 1 }, options);
    assert.ok(tip >= DEFAULTS.tipWei && tip <= 4n * DEFAULTS.tipWei);
  }
  const node = fakeNode(HARD);
  const state = emptyKeeperState();
  state.consecutiveWasted = 2;
  const sent = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node), random: (n) => n - 1n });
  assert.equal(sent.tip, DEFAULTS.maxTipWei);
  assert.equal(state.txs.at(-1).kind, "hard");
});

test("monitor: a soft closure is WARN with the size that passes, the ceiling is WARN", async () => {
  const node = fakeNode(SOFT);
  const result = await runMonitor(gate, { expectSeeded: true }, node.request, monitorDeps(node));
  const closed = result.checks.find((c) => c.name.startsWith("closed_by_excess"));
  assert.equal(closed.level, WARN);
  assert.match(closed.detail, /small swaps only/);
  const ceil = fakeNode({ reserves: [800_000_000n, 8n * 10n ** 18n], balances: [802_000_000n, 8n * 10n ** 18n] });
  const at = await runMonitor(gate, { expectSeeded: true }, ceil.request, monitorDeps(ceil));
  const check = at.checks.find((c) => c.name.startsWith("k_ceiling"));
  assert.equal(check.level, WARN);
  assert.match(check.detail, /not reaching LPs or the Safe/);
});

test("monitor: keeper budget levels, from the keeper's own state file", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "keeper-")), "state.json");
  const levelOf = (txs) => {
    const checks = [];
    writeFileSync(path, JSON.stringify({ txs }));
    checkKeeperState(path, 1_000_000, (name, level, detail) => checks.push({ name, level, detail }));
    return checks[0];
  };
  const tx = (status) => ({ at: 999_000, status, spentWei: "100" });
  assert.equal(levelOf([tx("effective")]).level, OK);
  const raced = levelOf([tx("wasted"), tx("wasted"), tx("wasted")]);
  assert.equal(raced.level, WARN);
  assert.match(raced.detail, /winning skims/);
  assert.equal(levelOf(Array.from({ length: 48 }, () => tx("effective"))).level, CRIT);
  assert.equal(levelOf([{ at: 1, status: "wasted" }]).level, OK);
  const checks = [];
  checkKeeperState(`${path}.missing`, 1_000_000, (name, level) => checks.push(level));
  assert.equal(checks[0], OK);
  writeFileSync(path, "{broken");
  checkKeeperState(path, 1_000_000, (name, level) => checks.push(level));
  assert.equal(checks[1], CRIT);
});

test("note-tx: an unrecorded approve and seed pass only together, and bad hashes are refused", async () => {
  const depositor = `0x${"9".repeat(40)}`;
  const router = `0x${"7".repeat(40)}`;
  const token = `0x${"6".repeat(40)}`;
  const contract = (address) => ({ address, codeHash: `0x${"1".repeat(64)}` });
  const hashA = `0x${"a".repeat(64)}`;
  const hashB = `0x${"b".repeat(64)}`;
  const pad = (a) => a.slice(2).padStart(64, "0");
  const txs = {
    [hashA]: { from: depositor, nonce: "0x0", to: token, input: `0x095ea7b3${pad(router)}${"0".repeat(64)}` },
    [hashB]: { from: depositor, nonce: "0x1", to: router, input: `${viem.toFunctionSelector("addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)")}${pad(token)}` },
  };
  const request = async (method, params) => {
    if (method === "eth_getTransactionCount") return "0x2";
    if (method === "eth_getTransactionByHash") return txs[params[0]] ?? null;
    if (method === "eth_getTransactionReceipt") return { status: "0x0" };
    throw new Error(`unexpected ${method}`);
  };
  const record = (listed) => ({
    schemaVersion: 2,
    chain: { id: 1, genesisHash: `0x${"2".repeat(64)}` },
    deployment: {
      firstDepositor: depositor,
      contracts: { factory: contract(`0x${"3".repeat(40)}`), router: contract(router), lens: contract(`0x${"4".repeat(40)}`), wrappedNative: contract(`0x${"5".repeat(40)}`) },
      pairInitCodeHash: `0x${"8".repeat(64)}`,
      feeTo: `0x${"c".repeat(40)}`,
      roles: { blochInc: contract(`0x${"c".repeat(40)}`) },
      tokens: [{ token }],
      pairs: [],
      reserveCaps: [],
      ...(listed ? { depositorTransactions: listed } : {}),
    },
  });
  // The deadlock: each hash alone leaves a nonce unlisted.
  await assert.rejects(checkNotedTxs(record(), hashA, request), /nonce 1 is not listed/);
  await assert.rejects(checkNotedTxs(record(), hashB, request), /nonce 0 is not listed/);
  assert.deepEqual((await checkNotedTxs(record(), `${hashA},${hashB}`, request)).listed, [hashA, hashB]);
  assert.deepEqual((await checkNotedTxs(record([hashA]), hashB.toUpperCase().replace("0X", "0x"), request)).listed, [hashA, hashB]);
  await assert.rejects(checkNotedTxs(record(), `${hashA},`, request), /not a transaction hash/);
  await assert.rejects(checkNotedTxs(record(), `${hashA},0x12`, request), /not a transaction hash/);
});

test("N2: the seed is ours only if the recipient holds nearly all the shares", () => {
  assert.equal(holdsSeed({ held: 9_000n, totalSupply: 10_000n }), true);
  assert.equal(holdsSeed({ held: 8_000n, totalSupply: 10_000n }), false);
  assert.equal(holdsSeed({ held: 0n, totalSupply: 10n ** 18n }), false);
  assert.equal(holdsSeed({ held: 0n, totalSupply: 0n }), false);
  assert.equal(holdsSeed({ held: 0n, totalSupply: 1000n }), false);
});

// bUSDC exit status (agent 144): the token's mint chain on the L2 against the vault's deposit chain on Ethereum.
const VAULT = address(0xb01);
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
function fakeBridge({ mintCount = 3n, mintHead = H(3), latestCount, latestHead, deposits = 3n, latestDeposits, heads = [H(0), H(1), H(2), H(3)], paused = false, releasesEnabled = true, mode = 1, ethDown = false } = {}) {
  const l2 = fakeNode();
  const inner = l2.request;
  const l2request = async (method, params) => {
    if (method === "eth_call") {
      const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data });
      const latest = params[1] === "latest";
      if (functionName === "mintCount") return encodeFunctionResult({ abi: ABI, functionName, result: latest && latestCount !== undefined ? latestCount : mintCount });
      if (functionName === "mintHead") return encodeFunctionResult({ abi: ABI, functionName, result: latest && latestHead ? latestHead : mintHead });
    }
    return inner(method, params);
  };
  const eth = async (method, params) => {
    if (ethDown) throw new RpcError("eth: connection refused");
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: "0xE", timestamp: "0x1", baseFeePerGas: "0x1" };
    if (method === "eth_getCode") return "0x6009";
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data });
    const value = { provenanceMode: mode, depositCount: params[1] === "latest" && latestDeposits !== undefined ? latestDeposits : deposits, paused, pausedUntil: 2_000_100_000n, releasesEnabled }[functionName] ?? (functionName === "chainHeadAt" ? heads[Number(args[0])] : undefined);
    if (value === undefined) throw new Error(`fake eth: ${functionName}`);
    return encodeFunctionResult({ abi: ABI, functionName, result: value });
  };
  return { l2: { ...l2, request: l2request }, eth };
}
const exitCheck = async (b, extra = {}) => {
  const r = await runMonitor(gate, { ethRequest: b.eth, bridgeVault: VAULT, ...extra }, b.l2.request, monitorDeps(b.l2));
  return r.checks.filter((c) => c.name === "bridge_exit[bUSDC]");
};

test("monitor: bUSDC exits open, held (CRIT), held at latest only (CRIT), paused (WARN), unreadable (UNKNOWN)", async () => {
  let [c] = await exitCheck(fakeBridge());
  assert.equal(c.level, OK, c.detail);
  assert.match(c.detail, /exits open/);
  [c] = await exitCheck(fakeBridge({ mintHead: H(99) }));
  assert.equal(c.level, CRIT);
  assert.match(c.detail, /EXITS HELD.*including bUSDC LPs take out of the pool/);
  // a forged credit not final yet: the latest token is ahead of every vault deposit
  [c] = await exitCheck(fakeBridge({ latestCount: 4n, latestHead: H(98) }));
  assert.equal(c.level, CRIT);
  assert.match(c.detail, /latest blocks only, not final yet/);
  // a finalized forged credit beyond every vault deposit (even at latest) is final
  [c] = await exitCheck(fakeBridge({ mintCount: 4n, mintHead: H(97), latestCount: 4n, latestHead: H(97) }));
  assert.equal(c.level, CRIT);
  assert.doesNotMatch(c.detail, /not final yet/);
  [c] = await exitCheck(fakeBridge({ paused: true }));
  assert.equal(c.level, WARN);
  assert.match(c.detail, /guardian pause until 2000100000/);
  [c] = await exitCheck(fakeBridge({ releasesEnabled: false }));
  assert.equal(c.level, WARN);
  assert.match(c.detail, /releases disabled/);
  [c] = await exitCheck(fakeBridge({ ethDown: true }));
  assert.equal(c.level, UNKNOWN);
  [c] = await exitCheck(fakeBridge({ mode: 0 }));
  assert.equal(c.level, CRIT);
  [c] = await exitCheck(fakeBridge(), { bridgeVaultCodeHash: hashOf("0x6010") });
  assert.equal(c.level, CRIT);
  assert.match(c.detail, /differs from the pin/);
  // a finalized token ahead of the finalized vault is a lagging Ethereum view, not a hold, while latest matches
  [c] = await exitCheck(fakeBridge({ mintCount: 3n, deposits: 2n, latestDeposits: 3n }));
  assert.equal(c.level, OK);
  // without --eth-rpc nothing is checked (rehearsals and older units)
  const plain = fakeNode();
  const r = await runMonitor(gate, {}, plain.request, monitorDeps(plain));
  assert.equal(r.checks.filter((x) => x.name.startsWith("bridge_exit")).length, 0);
});

test("keeper: bUSDC exit status is reported and never changes the action", async () => {
  const deployment = { tokens: [{ token: T0, symbol: "bUSDC" }] };
  const base = { level: OK, action: "nothing-to-do" };
  const ok = await withBridgeExit(base, fakeBridge().eth, fakeBridge().l2.request, { vault: VAULT }, deployment);
  assert.deepEqual([ok.level, ok.action, ok.bridgeExit], [OK, "nothing-to-do", "normal"]);
  const b = fakeBridge({ mintHead: H(99) });
  const held = await withBridgeExit(base, b.eth, b.l2.request, { vault: VAULT }, deployment);
  assert.deepEqual([held.level, held.action, held.bridgeExit], [WARN, "nothing-to-do", "held"]);
  const d = fakeBridge({ ethDown: true });
  const down = await withBridgeExit(base, d.eth, d.l2.request, { vault: VAULT }, deployment);
  assert.equal(down.level, OK);
  assert.match(down.bridgeExit, /^unknown: /);
});
