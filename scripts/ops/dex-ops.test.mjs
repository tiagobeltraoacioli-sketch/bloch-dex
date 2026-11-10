// Unit tests of the DEX operations kit, with a fake node. The end-to-end run on
// a private chain is scripts/ops/rehearse-ops-anvil.sh.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABI, CRIT, CallReverted, OK, RpcError, UNKNOWN, WARN, classifyExcess, closureOf, createRequest, excessFloor, isAtKCeiling, isBricked, isClosedByExcess, keccak256, parseUnits, formatUnits, worst,
} from "./dex-ops-lib.mjs";
import { checkKeeperState, runMonitor } from "./dex-monitor.mjs";
import { withBridgeExit } from "./dex-skim-keeper.mjs";
import { DEFAULTS, ceilingFloorWei, excessValueWei, nextTip, runKeeper } from "./dex-skim-keeper.mjs";
import { MAX_FRACTION_BPS, REPRICE_DONATION_MAX_BPS, SEEDER_FLOOR_BPS, checkNotedTxs, planRemoval, repriceByDonation, seedFloorShares, holdsSeed, parseFractionBps, planOpening, priceGapBps } from "./dex-seed-plan.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assembleSignatures, redemptionMinimums, safeTxHash, safeTxTypedData } from "./dex-fee-redeem.mjs";
import { createRequire } from "node:module";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { privateKeyToAccount } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem/accounts");
const { encodeFunctionResult, decodeFunctionData } = viem;

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const blockHash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
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
    finalizedNumber: 5n,
    blockTimestamps: {},
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
      case "feeTo": return chain.factoryFeeTo ?? SAFE;
      case "factory": return chain.pairFactory ?? FACTORY;
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
        const number = tag === "finalized" ? chain.finalizedNumber : tag === "latest" ? chain.latestNumber ?? 10n : BigInt(tag);
        return { number: `0x${number.toString(16)}`, hash: blockHash(number), timestamp: `0x${(chain.blockTimestamps[number] ?? now - (tag === "finalized" ? 6000n : 300n)).toString(16)}`, baseFeePerGas: `0x${chain.baseFee.toString(16)}`,
          ...(params[1] === true ? { transactions: chain.blockTxs?.[number] ?? [] } : {}) };
      }
      case "eth_getCode": {
        const [a] = params;
        return { [PAIR]: chain.pairCode, [T0]: CODE.token0, [T1]: CODE.token1, [FACTORY]: CODE.factory, [ROUTER]: CODE.router, [LENS]: CODE.lens, [SAFE]: CODE.safe }[a];
      }
      case "eth_call": {
        const [{ to, data }, at] = params;
        if (chain.revertSim && data.startsWith("0xbc25cf77")) throw new CallReverted("eth_call: execution reverted");
        const { functionName, args } = decodeFunctionData({ abi: ABI, data });
        const blockTag = at?.blockHash === blockHash(chain.finalizedNumber) ? "F" : "L";
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
      case "eth_getTransactionCount": return `0x${(chain.nonceAt ? chain.nonceAt(params[1]) : chain.nonce).toString(16)}`;
      case "eth_getTransactionReceipt": return chain.receipts[params[0]] ?? null;
      case "eth_sendRawTransaction": chain.sent.push(params[0]); if (chain.publish) return chain.publish(params[0]); return keccak256(params[0]);
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
const settledFields = (at) => ({ includedAt: at, includedBlockNumber: "9", includedBlockHash: blockHash(9n) });
function keeperReceipt(node, hash, changes = {}) {
  node.chain.finalizedNumber = 9n;
  node.chain.blockTimestamps[9n] ??= 1_000_100n;
  return {
    transactionHash: hash, from: account.address.toLowerCase(), to: PAIR,
    status: "0x1", blockNumber: "0x9", blockHash: blockHash(9n),
    gasUsed: "0x10000", effectiveGasPrice: "0x3b9aca00", logs: [], ...changes,
  };
}

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
  const revert = createRequest("http://x", { fetchImpl: async (_url, options) => Response.json({ jsonrpc: "2.0", id: JSON.parse(options.body).id, error: { code: 3, message: "execution reverted", data: "0x" } }) });
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

test("monitor: the owner's LP floor (--lp-min-shares) is CRIT below it and absent when unset", async () => {
  // The fake node answers balanceOf(any holder) on the pair with lpInPair.
  const options = { expectSeeded: true, lpRecipient: KEEPER };
  const above = fakeNode({ lpInPair: 10n ** 13n });
  assert.deepEqual(levelOf(await runMonitor(gate, { ...options, lpMinShares: "5000000000000" }, above.request, monitorDeps(above)), "lp_floor"), [OK]);
  const below = fakeNode({ lpInPair: 4_999_999_999_999n });
  const result = await runMonitor(gate, { ...options, lpMinShares: "5000000000000" }, below.request, monitorDeps(below));
  assert.deepEqual(levelOf(result, "lp_floor"), [CRIT]);
  assert.match(result.checks.find((c) => c.name.startsWith("lp_floor")).detail, /A98-5/);
  assert.deepEqual(levelOf(await runMonitor(gate, options, below.request, monitorDeps(below)), "lp_floor"), []);
  assert.deepEqual(levelOf(await runMonitor(gate, { ...options, lpMinShares: "0" }, below.request, monitorDeps(below)), "lp_floor"), []);
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

test("keeper: failure to persist its signed reservation prevents publication", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  let saves = 0, signs = 0;
  await assert.rejects(runKeeper(gate, keeperOptions(), emptyKeeperState(), {
    ...keeperDeps(node),
    sign: async (tx) => { signs++; return signer(tx); },
    save: () => { if (++saves === 2) throw new Error("reservation flush failed"); },
  }), /reservation flush failed/);
  assert.equal(signs, 1);
  assert.equal(node.chain.sent.length, 0);
});

test("keeper: one transaction in flight, then a cooldown", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const second = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(second.action, "wait-in-flight");
  node.chain.receipts[state.txs[0].hash] = keeperReceipt(node, state.txs[0].hash, {
    logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }],
  });
  const third = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_200));
  assert.equal(third.action, "cooldown");
  assert.equal(state.txs[0].status, "effective");
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: it does not act on a receipt until latest has reached that block", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  node.chain.receipts[state.txs[0].hash] = keeperReceipt(node, state.txs[0].hash, { blockNumber: "0xff", blockHash: blockHash(255n) });
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100))).action, "wait-in-flight");
});

test("keeper: griefing by front-running its skim backs off exponentially", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  // The skim landed after someone else's: no Transfer moved a value.
  node.chain.receipts[state.txs[0].hash] = keeperReceipt(node, state.txs[0].hash, { effectiveGasPrice: "0x1" });
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(outcome.action, "backoff");
  assert.equal(outcome.level, WARN);
  assert.equal(state.consecutiveWasted, 1);
  assert.equal(state.nextAllowedAt, 1_000_100 + 3600);
  assert.equal(node.chain.sent.length, 1);
});

for (const [name, changes] of [
  ["another transaction", { transactionHash: blockHash(99n) }],
  ["another sender", { from: SAFE }],
  ["another target", { to: SAFE }],
  ["orphan inclusion", { blockHash: blockHash(99n) }],
  ["missing block hash", { blockHash: undefined }],
  ["malformed status", { status: "success" }],
  ["missing gas price", { effectiveGasPrice: undefined }],
  ["noncanonical gas quantity", { gasUsed: "0x00" }],
  ["negative gas price", { effectiveGasPrice: "-1" }],
  ["cost above the signed reservation", { gasUsed: "0xffffffff" }],
]) test(`keeper: receipt with ${name} cannot release the pending reservation`, async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash, changes);
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(outcome.action, "rpc-failed");
  assert.equal(outcome.level, UNKNOWN);
  assert.equal(state.txs[0].status, "pending");
  assert.equal(state.txs[0].spentWei, undefined);
  assert.equal(node.chain.sent.length, 1);
});

for (const unavailable of [false, true]) test(`keeper: ${unavailable ? "missing" : "lagging"} finality retains a mined transaction's reservation`, async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash);
  node.chain.finalizedNumber = 8n;
  node.chain.noFinalized = unavailable;
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(state.txs[0].status, "pending");
  assert.equal(state.txs[0].spentWei, undefined);
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: a changed finality checkpoint cannot release the receipt reservation", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash);
  node.chain.finalizedNumber = 10n;
  const request = async (method, params) => {
    if (method === "eth_getBlockByNumber" && params[0] === "0xa") return { number: "0xa", hash: blockHash(99n) };
    return node.request(method, params);
  };
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, 1_000_100), request });
  assert.equal(outcome.action, "rpc-failed");
  assert.equal(state.txs[0].status, "pending");
  assert.equal(state.txs[0].spentWei, undefined);
});

for (const status of ["pending", "expired", "replaced", "refused"]) test(`keeper: unresolved ${status} reservation survives timeout and the 24-hour window`, async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  state.txs[0].status = status;
  if (status === "refused") state.txs[0].spentWei = "0"; // Legacy generic-error refusal is not proof.
  // Records written before round 14 hold neither the signed bytes nor the fee cap: they are never
  // re-published. With no skim needed they wait, reservation intact, for ever.
  for (const field of ["raw", "maxFeeWei", "gasLimit", "sinceBlock"]) delete state.txs[0][field];
  const legacyHash = state.txs[0].hash;
  const reserved = BigInt(state.txs[0].reservedWei);
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_086_401));
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(outcome.level, WARN);
  assert.equal(outcome.reason, "pending-timeout");
  assert.equal(outcome.replaceable, true);
  assert.equal(state.txs.length, 1);
  assert.equal(BigInt(state.txs[0].reservedWei), reserved);
  assert.equal(keeperWindowSpend(state, 1_086_401), reserved);
  assert.equal(node.chain.sent.length, 1);

  // K-L6: when a skim is needed again the open entry is replaced AT ITS OWN NONCE (never a second
  // nonce). Its fee cap is unknown, so the replacement carries the operator's fee ceiling, which no
  // transaction of this keeper can exceed, and at least 12.5% more tip than the recorded one.
  node.chain.balances = ABOVE_CAP;
  const legacyTip = BigInt(state.txs[0].tipWei);
  const replaced = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_086_500));
  assert.equal(replaced.action, "replaced");
  assert.equal(replaced.replacesHash, legacyHash);
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].nonce, "0");
  assert.deepEqual(state.txs[0].attempts.map((a) => a.hash), [legacyHash]);
  const replacement = skimOf(node.chain.sent.at(-1));
  assert.equal(replacement.nonce, 0);
  assert.equal(replacement.tx.maxFeePerGas, DEFAULTS.maxFeeWei);
  assert.ok(replacement.tx.maxPriorityFeePerGas * 8n >= legacyTip * 9n && replacement.tx.maxPriorityFeePerGas <= DEFAULTS.maxTipWei);
  // One nonce, one charge: the dearer of the two reservations, never the sum.
  const worst = replacement.tx.gas * replacement.tx.maxFeePerGas;
  assert.equal(BigInt(state.txs[0].reservedWei), worst > reserved ? worst : reserved);
  assert.equal(keeperWindowSpend(state, 1_086_500), BigInt(state.txs[0].reservedWei));
  assertOnlySkimsToSafe(node);
  // If the old transaction is the one that lands after all, the entry settles on it.
  node.chain.receipts[legacyHash] = keeperReceipt(node, legacyHash, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  node.chain.nonce = 1n;
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  const settled = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_086_600));
  assert.equal(settled.action, "nothing-to-do");
  assert.equal(state.txs[0].hash, legacyHash);
  assert.equal(state.txs[0].status, "effective");
});

test("K-L6: a legacy entry without any recorded fee is replaced at the operator's ceilings, and two open legacy entries are never replaced", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  for (const field of ["raw", "maxFeeWei", "tipWei", "gasLimit", "sinceBlock"]) delete state.txs[0][field];
  const two = structuredClone(state);
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_000 + 7_200));
  assert.equal(outcome.action, "replaced");
  const replacement = skimOf(node.chain.sent.at(-1));
  assert.equal(replacement.nonce, 0);
  assert.equal(replacement.tx.maxFeePerGas, DEFAULTS.maxFeeWei);
  assert.equal(replacement.tx.maxPriorityFeePerGas, DEFAULTS.maxTipWei);
  // Not before it is stale.
  const early = structuredClone(two);
  assert.equal((await runKeeper(gate, keeperOptions(), early, keeperDeps(node, 1_000_000 + 7_199))).action, "wait-in-flight");
  // Two unresolved entries: nothing is signed.
  two.txs.push({ ...two.txs[0], hash: blockHash(124n), nonce: "1" });
  const sentBefore = node.chain.sent.length;
  const held = await runKeeper(gate, keeperOptions(), two, { ...keeperDeps(node, 1_000_000 + 90_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(held.action, "wait-in-flight");
  assert.equal(node.chain.sent.length, sentBefore);
});

test("keeper: a used nonce without a canonical receipt cannot open another nonce", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  node.chain.nonce = 1n;
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(outcome.level, WARN);
  assert.equal(outcome.reason, "nonce-used-without-receipt");
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: delayed inclusion charges the current daily budget using its canonical block timestamp", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  const options = keeperOptions({ budgetWei: 300_000_000_000_000n, cooldownSeconds: 0 });
  await runKeeper(gate, options, state, keeperDeps(node));
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  node.chain.blockTimestamps[9n] = 1_086_450n;
  node.chain.nonce = 1n;
  const outcome = await runKeeper(gate, options, state, keeperDeps(node, 1_086_500));
  assert.equal(outcome.action, "budget-exhausted");
  assert.equal(outcome.spentWei, 65_536_000_000_000n);
  assert.equal(state.txs[0].includedAt, 1_086_450);
  assert.equal(state.txs[0].includedBlockHash, blockHash(9n));
  assert.equal(state.txs[0].includedBlockNumber, "9");
  assert.equal(node.chain.sent.length, 1);
  const afterWindow = await runKeeper(gate, options, state, keeperDeps(node, 1_086_450 + 86_401));
  assert.equal(afterWindow.action, "sent");
  assert.equal(node.chain.sent.length, 2);
});

test("keeper: resolving one legacy entry cannot bypass another unresolved nonce", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  state.txs[0].status = "expired";
  state.txs.push({ ...state.txs[0], hash: blockHash(123n), nonce: "1", status: "replaced" });
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash);
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_086_500));
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(outcome.reason, "legacy-history");
  assert.equal(outcome.hash, state.txs[1].hash);
  assert.equal(state.txs[0].includedAt, 1_000_100);
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: a missing canonical inclusion timestamp cannot release an old reservation", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  const hash = state.txs[0].hash;
  node.chain.receipts[hash] = keeperReceipt(node, hash);
  const request = async (method, params) => {
    const result = await node.request(method, params);
    if (method === "eth_getBlockByNumber" && params[0] === "0x9") delete result.timestamp;
    return result;
  };
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, 1_086_500), request });
  assert.equal(outcome.action, "rpc-failed");
  assert.equal(state.txs[0].includedAt, undefined);
  assert.equal(state.txs[0].spentWei, undefined);
  assert.equal(state.txs[0].status, "pending");
  assert.equal(node.chain.sent.length, 1);
});

test("keeper: under sustained griefing it stops at the count and the budget", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  const mined = (hash) => { node.chain.receipts[hash] = keeperReceipt(node, hash, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] }); };
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
  const smallHash = budgetState.txs[0].hash;
  small.chain.receipts[smallHash] = keeperReceipt(small, smallHash, { gasUsed: "0x17700", effectiveGasPrice: "0xb2d05e00", logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  small.chain.blockTimestamps[9n] = BigInt(now);
  small.chain.nonce = 1n;
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

for (const [name, reply] of [
  ["lost response", () => { throw new Error("ECONNRESET"); }],
  ["timeout", () => new Promise(() => {})],
  ["HTTP failure", () => Response.json({ error: "upstream failed" }, { status: 502 })],
  ["truncated body", () => new Response('{"jsonrpc":"2.0",', { headers: { "content-type": "application/json" } })],
  ["wrong response ID", (body) => Response.json({ jsonrpc: "2.0", id: body.id + 1, error: { code: -32000, message: "refused" } })],
  ["malformed error", (body) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: "-32000", message: "refused" } })],
  ["generic node error", (body) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "internal failure after publication" } })],
  ["nonce too low", (body) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "nonce too low" } })],
  ["already known", (body) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "already known" } })],
  ["unrelated result hash", (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: `0x${"99".repeat(32)}` })],
]) test(`keeper: ${name} on publish keeps the reservation and waits for reconciliation`, async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  let published = 0;
  const publish = createRequest("http://unused", {
    allowed: ["eth_sendRawTransaction"], timeoutMs: 15,
    fetchImpl: async (_url, options) => { published++; return reply(JSON.parse(options.body)); },
  });
  const request = async (m, p) => {
    if (m === "eth_sendRawTransaction") return publish(m, p);
    return node.request(m, p);
  };
  const deps = { ...keeperDeps(node), request };
  const outcome = await runKeeper(gate, keeperOptions(), state, deps);
  assert.equal(outcome.action, "publish-unconfirmed");
  assert.equal(outcome.level, WARN);
  assert.equal(published, 1);
  assert.equal(state.txs[0].status, "pending");
  assert.ok(BigInt(state.txs[0].reservedWei) > 0n);
  assert.equal(state.txs[0].spentWei, undefined);
  assert.equal(JSON.parse(deps.saves.at(-1)).txs[0].status, "pending");
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100))).action, "wait-in-flight");
  assert.equal(node.chain.sent.length, 0);
});

// ---- seed plan

for (const valid of [true, false]) test(`keeper: ${valid ? "verified" : "unrelated"} sequencer fee refusal ${valid ? "reports explicit fees without retrying" : "keeps its pending reservation"}`, async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  let signs = 0, publishes = 0;
  const publish = createRequest("http://unused", {
    allowed: ["eth_sendRawTransaction"],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      publishes++;
      return Response.json({ jsonrpc: "2.0", id: body.id, error: {
        code: -32000, message: "transaction underpriced for sequencer policy",
        data: {
          kind: "sequencer-fee-underpriced", scope: "latest-state-next-block",
          transactionHash: valid ? keccak256(body.params[0]) : blockHash(99n),
          headHash: blockHash(10n), headNumber: "0xa", baseFeePerGas: "0x3b9aca00",
          requiredPriorityFeePerGas: "0x77359400", requiredMaxFeePerGas: "0xb2d05e00",
          effectivePriorityFeePerGas: "0x3b9aca00", gasUsed: "0x13880", freshSlots: "0x1",
          chargedFreshSlots: "0x1", freshSlotPriceWei: "0x5af3107a4000",
        },
      } });
    },
  });
  const request = (method, params) => method === "eth_sendRawTransaction" ? publish(method, params) : node.request(method, params);
  const options = keeperOptions();
  const original = { ...options };
  const deps = { ...keeperDeps(node), request, sign: async (tx) => { signs++; return signer(tx); } };
  const outcome = await runKeeper(gate, options, state, deps);
  assert.equal(outcome.action, valid ? "publish-refused" : "publish-unconfirmed");
  // The quote (2 gwei tip) is inside the keeper's ceilings: the next attempt follows by itself.
  assert.equal(outcome.level, WARN);
  if (valid) assert.equal(outcome.retry, "automatic, at the same nonce, after the cooldown");
  // K-L1: the refusal is the node's word. Either way the entry stays open with its reservation.
  assert.equal(state.txs[0].status, "pending");
  assert.equal(state.txs[0].refusedFirst, valid ? true : undefined);
  assert.equal(state.txs[0].spentWei, undefined);
  assert.equal(keeperWindowSpend(state, deps.now), BigInt(state.txs[0].reservedWei));
  if (valid) {
    assert.equal(outcome.feeRequirement.requiredPriorityFeePerGas, "2000000000");
    assert.equal(outcome.feeRequirement.requiredMaxFeePerGas, "3000000000");
    assert.equal(outcome.feeRequirement.transactionHash, state.txs[0].hash);
    assert.equal(state.txs[0].noReplaceBefore, deps.now + options.cooldownSeconds);
    assert.equal(state.nextAllowedAt, 0);
  } else assert.equal(outcome.feeRequirement, undefined);
  assert.equal(signs, 1);
  assert.equal(publishes, 1);
  assert.deepEqual(options, original);
  assert.equal(JSON.parse(deps.saves.at(-1)).txs[0].status, state.txs[0].status);
});

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
  soft.txs = Array.from({ length: used }, (_, i) => ({ at: 990_000, ...settledFields(990_000), hash: `0x${i}`, nonce: "0", status: "wasted", kind: "soft", spentWei: "1" }));
  const stop = await runKeeper(gate, keeperOptions(), soft, keeperDeps(fakeNode(SOFT)));
  assert.equal(stop.action, "soft-closure-share-used");
  assert.equal(stop.level, WARN);
});

test("keeper: ordinary excess cannot spend the reserve, a hard closure can, and an exhausted hard closure is CRIT", async () => {
  const full = (n) => {
    const state = emptyKeeperState();
    state.txs = Array.from({ length: n }, (_, i) => ({ at: 990_000, ...settledFields(990_000), hash: `0x${i}`, nonce: "0", status: "effective", kind: "excess", spentWei: "1" }));
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
  const tx = (status) => ({ at: 999_000, ...settledFields(999_000), status, spentWei: "100" });
  assert.equal(levelOf([tx("effective")]).level, OK);
  const raced = levelOf([tx("wasted"), tx("wasted"), tx("wasted")]);
  assert.equal(raced.level, WARN);
  assert.match(raced.detail, /winning skims/);
  assert.equal(levelOf(Array.from({ length: 48 }, () => tx("effective"))).level, CRIT);
  assert.equal(levelOf([{ at: 1, ...settledFields(1), status: "wasted" }]).level, OK);
  const unresolved = levelOf([{ at: 1, status: "expired", reservedWei: "1234" }]);
  assert.equal(unresolved.level, WARN);
  assert.match(unresolved.detail, /1234 wei spent or reserved/);
  assert.match(unresolved.detail, /1 unresolved/);
  const includedLate = levelOf([{ at: 1, ...settledFields(999_000), status: "effective", spentWei: "5678" }]);
  assert.match(includedLate.detail, /5678 wei spent or reserved/);
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
    const checkpointHash = `0x${"c".repeat(64)}`;
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return params[0] === "0x0"
      ? { number: "0x0", hash: `0x${"2".repeat(64)}`, timestamp: "0x0" }
      : { number: "0xa", hash: checkpointHash, timestamp: "0x1" };
    if (method === "eth_getTransactionCount") {
      assert.deepEqual(params[1], { blockHash: checkpointHash, requireCanonical: true });
      return "0x2";
    }
    const tx = txs[params[0]];
    const inclusion = { blockNumber: "0xa", blockHash: checkpointHash, from: tx?.from, to: tx?.to };
    if (method === "eth_getTransactionByHash") return tx ? { ...inclusion, ...tx, hash: params[0] } : null;
    if (method === "eth_getTransactionReceipt") return tx ? { ...inclusion, transactionHash: params[0], status: "0x0" } : null;
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

test("r10 DEX-4: the seed planner refuses --fraction-bps above 7,000 and says why (k ceiling)", () => {
  assert.equal(MAX_FRACTION_BPS, 7000n);
  assert.equal(parseFractionBps(undefined), 5000n);
  assert.equal(parseFractionBps("1"), 1n);
  assert.equal(parseFractionBps("7000"), 7000n);
  for (const bad of ["7001", "8000", "9000", "10000"]) {
    assert.throws(() => parseFractionBps(bad), (e) => {
      assert.match(e.message, /must be 1 to 7000/);
      assert.match(e.message, /k ceiling/);
      assert.match(e.message, /80% of both caps sits exactly on that k ceiling/);
      assert.match(e.message, /LPs and the Safe earn nothing/);
      return true;
    }, bad);
  }
  for (const bad of ["0", "-1", "7000.5", "7e3", "", "true"]) assert.throws(() => parseFractionBps(bad), /--fraction-bps/, bad);
  // The library function refuses on its own, so no other caller can plan a seed on the ceiling.
  assert.throws(() => planOpening({ wrapped: side(0n, WRAP_CAP), quote: side(0n, QUOTE_CAP), totalSupply: 0n, price: 100_000_000n, fractionBps: 8000n }), /k ceiling/);
  assert.equal(planOpening({ wrapped: side(0n, WRAP_CAP), quote: side(0n, QUOTE_CAP), totalSupply: 0n, price: 100_000_000n, fractionBps: 7000n }).decision, "proceed");
});

test("r10 DEX-4: 7,000 bps keeps k at 76.6% of the ceiling; 8,000 bps sits on it when the caps balance", () => {
  // k / ceiling = (f * cap0) * (f * cap1) / (0.64 * cap0 * cap1) = f^2 / 0.64, in bps.
  const ratioBps = (f) => (f * f * 10_000n) / (6_400n * 10_000n);
  assert.equal(ratioBps(5_000n), 3_906n);
  assert.equal(ratioBps(7_000n), 7_656n);
  assert.equal(ratioBps(8_000n), 10_000n);
});

test("r10 DEX-4: the planner CLI refuses 7,001 and 8,000 before any RPC read, with exit 2", () => {
  const script = fileURLToPath(new URL("./dex-seed-plan.mjs", import.meta.url));
  for (const value of ["7001", "8000"]) {
    const run = spawnSync(process.execPath, [script, "plan", "--config", "/nonexistent/gate.json", "--rpc", "http://127.0.0.1:9", "--price", "100", "--to", address(0xc01), "--fraction-bps", value], { encoding: "utf8" });
    assert.equal(run.status, CRIT, run.stderr);
    assert.match(run.stderr, /must be 1 to 7000/);
    assert.match(run.stderr, /k ceiling/);
  }
});

// ---- keeper at the k ceiling (DEX-4, round 10)

// 800 bUSDC x 8 WBLCH = 64% of 1,000 x 10: exactly the ceiling, pool price 100.
const AT_CEILING = [800_000_000n, 8n * 10n ** 18n];

test("r10 DEX-4: the ceiling floor is the budget's per-transaction share, 0.05 BLCH / 48", () => {
  assert.equal(DEFAULTS.ceilingFloorWei, null);
  assert.equal(ceilingFloorWei(keeperOptions()), 1_041_666_666_666_666n);
  assert.equal(ceilingFloorWei(keeperOptions({ ceilingFloorWei: 5n })), 5n);
  assert.equal(ceilingFloorWei(keeperOptions({ maxTx: 0 })), DEFAULTS.budgetWei);
  // About 1 bps of the 10 WBLCH cap, a hundredth of the ordinary 100 bps floor.
  assert.equal((ceilingFloorWei(keeperOptions()) * 10_000n) / CAP1, 1n);
  // It is above the worst case the keeper can actually pay per skim at the RC limits
  // (95k gas measured, 9 gwei = 1 gwei base + the 8 gwei top tip): each skim returns more
  // than it costs, and 36 non-reserved skims a day stay inside 0.05 BLCH.
  assert.ok(ceilingFloorWei(keeperOptions()) > 95_000n * 9_000_000_000n);
});

test("r10 DEX-4: excess value is priced in wrapped wei at the pool's own price", () => {
  const state = { sides: [
    { token: T0, reserve: 800_000_000n, balance: 800_110_000n, cap: CAP0 },
    { token: T1, reserve: 8n * 10n ** 18n, balance: 8n * 10n ** 18n + 5n, cap: CAP1 },
  ] };
  // 0.11 bUSDC at 100 bUSDC per BLCH = 0.0011 BLCH, plus 5 wei.
  assert.equal(excessValueWei(state, T1), 1_100_000_000_000_005n);
  assert.equal(excessValueWei(state, address(0xdead)), null);
  assert.equal(excessValueWei({ sides: [{ ...state.sides[0], reserve: 0n }, state.sides[1]] }, T1), null);
});

test("r10 DEX-4: at the ceiling the keeper skims fee excess to the Safe from about 0.001 BLCH", async () => {
  const node = fakeNode({ reserves: AT_CEILING, balances: [800_110_000n, 8n * 10n ** 18n] });
  const state = emptyKeeperState();
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  assert.equal(outcome.action, "sent");
  assert.equal(outcome.kCeiling, true);
  assert.equal(outcome.to, SAFE);
  assert.equal(state.txs.at(-1).kind, "ceiling");
  assert.equal(node.chain.sent.length, 1);
  // The same 0.11 bUSDC was dust under the 100 bps floor (1% of the cap is 10 bUSDC).
  assert.equal(outcome.seen[0].kinds[0], "dust");
});

test("r10 DEX-4: below the ceiling floor, or below the ceiling, nothing changes", async () => {
  // 0.10 bUSDC = 0.001 BLCH, under 0.05 / 48.
  const under = fakeNode({ reserves: AT_CEILING, balances: [800_100_000n, 8n * 10n ** 18n] });
  assert.equal((await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(under))).action, "nothing-to-do");
  // The 50% seed is far below the ceiling: 5 bUSDC of excess stays dust as before.
  const seed = fakeNode({ balances: [505_000_000n, 5n * 10n ** 18n] });
  assert.equal((await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(seed))).action, "nothing-to-do");
  // An explicit floor wins over the default.
  const set = fakeNode({ reserves: AT_CEILING, balances: [800_110_000n, 8n * 10n ** 18n] });
  assert.equal((await runKeeper(gate, keeperOptions({ ceilingFloorWei: 2n * 10n ** 15n }), emptyKeeperState(), keeperDeps(set))).action, "nothing-to-do");
});

test("r10 DEX-4: ceiling skims keep the cooldown and never use the count kept for a hard closure", async () => {
  const node = fakeNode({ reserves: AT_CEILING, balances: [800_110_000n, 8n * 10n ** 18n] });
  const state = emptyKeeperState();
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node));
  node.chain.receipts[state.txs[0].hash] = keeperReceipt(node, state.txs[0].hash, { gasUsed: "0x12c00", effectiveGasPrice: "0x77359400", logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01adb0" }] });
  node.chain.nonce = 1n;
  const soon = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, 1_000_100));
  assert.equal(soon.action, "cooldown");
  const full = emptyKeeperState();
  const reserved = Number((BigInt(DEFAULTS.maxTx) * DEFAULTS.hardReserveBps) / 10_000n);
  full.txs = Array.from({ length: DEFAULTS.maxTx - reserved }, (_, i) => ({ at: 990_000 + i, ...settledFields(990_000 + i), hash: `0x${i}`, nonce: String(i), pair: PAIR, reservedWei: "1", spentWei: "1", kind: "ceiling", status: "effective" }));
  const fresh = fakeNode({ reserves: AT_CEILING, balances: [800_110_000n, 8n * 10n ** 18n], nonce: BigInt(DEFAULTS.maxTx) });
  assert.equal((await runKeeper(gate, keeperOptions(), full, keeperDeps(fresh, 1_000_000))).action, "reserved-for-hard-closure");
});

// ---- reopening after a full seeder exit (agent 178, X5)

test("r10 178-X5: after a full exit the planner reprices by a dust donation, not a swap that pays out 0", () => {
  // 178's measured state: 1000 locked shares over 1 bUSDC unit and 1e8 wei WBLCH (pool price 10,000).
  const price = 100_000_000n; // 100 bUSDC per BLCH
  const dust = { wrapped: side(10n ** 8n, WRAP_CAP), quote: side(1n, QUOTE_CAP), totalSupply: 1000n, price, fractionBps: 5000n };
  const plan = planOpening(dust);
  assert.equal(plan.decision, "reprice-by-donation");
  assert.equal(plan.donateWrapped, true);
  // 178's manual route donated 9.9e9 wei and reached P = 100.
  assert.equal(plan.amount, 9_900_000_000n);
  assert.deepEqual(plan.reservesAfter, { wrapped: 10n ** 10n, quote: 1n });
  assert.ok(plan.amount * 10_000n <= WRAP_CAP * REPRICE_DONATION_MAX_BPS);
  // After the donation and sync the next plan is the top-up 178 sent by hand.
  const after = planOpening({ ...dust, wrapped: side(10n ** 10n, WRAP_CAP), quote: side(1n, QUOTE_CAP) });
  assert.equal(after.decision, "top-up");
  assert.equal(priceGapBps({ wrapped: side(10n ** 10n, WRAP_CAP), quote: side(1n, QUOTE_CAP), price }), 0n);
  // Price too low instead: the quote side is donated, rounded up so the price lands at the target.
  const low = repriceByDonation({ wrapped: side(10n ** 8n, WRAP_CAP), quote: side(1n, QUOTE_CAP), price: 10n ** 11n, pool: 10n ** 10n, gap: 9000n });
  assert.equal(low.decision, "reprice-by-donation");
  assert.equal(low.donateWrapped, false);
  assert.equal(low.amount, 9n);
  assert.deepEqual(low.reservesAfter, { wrapped: 10n ** 8n, quote: 10n });
});

test("r10 178-X5: a real pool at a wrong price still gets the correcting swap, and a large donation is refused", () => {
  const price = 100_000_000n;
  const real = planOpening({ wrapped: side(5n * WAD, WRAP_CAP), quote: side(250_000_000n, QUOTE_CAP), totalSupply: 10n ** 12n, price, fractionBps: 5000n });
  assert.equal(real.decision, "correct-price");
  assert.ok(real.amountOutMin > 0n);
  // 1 wei WBLCH over 1 bUSDC unit, target 100 base units per BLCH: the swap pays 0 and the
  // donation needed (1e16 wei) is above 1 bps of the 10 WBLCH cap (1e15), so it is refused.
  const tooBig = planOpening({ wrapped: side(1n, WRAP_CAP), quote: side(1n, QUOTE_CAP), totalSupply: 1000n, price: 100n, fractionBps: 5000n });
  assert.equal(tooBig.decision, "refuse");
  assert.match(tooBig.reason, /above 1 bps of the cap/);
});

// ---- the seeder floor (coordinator decision, round 10)

test("r10 seeder floor: 10% of the seed's shares, the same shares 178 measured at P = 100", () => {
  assert.equal(SEEDER_FLOOR_BPS, 1000n);
  const { seedShares, floorShares } = seedFloorShares({ wrappedCap: WRAP_CAP, quoteCap: QUOTE_CAP, price: 100_000_000n, fractionBps: 5000n });
  assert.equal(seedShares, 49_999_999_999_000n);
  assert.equal(floorShares, 4_999_999_999_900n);
  // P = 200: the bUSDC cap binds (500 bUSDC + 2.5 WBLCH).
  const p200 = seedFloorShares({ wrappedCap: WRAP_CAP, quoteCap: QUOTE_CAP, price: 200_000_000n, fractionBps: 5000n });
  assert.equal(p200.seedShares, isqrtForTest(25n * 10n ** 17n * 500_000_000n) - 1000n);
});
function isqrtForTest(n) { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

test("r10 seeder floor: a removal below the floor is refused unless overridden, with the reason", () => {
  const floorShares = 4_999_999_999_900n;
  const held = 49_999_999_999_000n;
  const ok = planRemoval({ held, shares: held - floorShares, floorShares });
  assert.equal(ok.decision, "remove");
  assert.equal(ok.belowFloor, false);
  assert.equal(ok.leftShares, floorShares);
  const full = planRemoval({ held, shares: held, floorShares });
  assert.equal(full.decision, "refuse-floor");
  assert.match(full.reason, /below the seeder floor/);
  assert.match(full.reason, /k ceiling/);
  assert.match(full.reason, /At most 44999999999100 shares may be removed/);
  assert.match(full.reason, /--allow-below-floor/);
  assert.equal(planRemoval({ held, shares: held - floorShares + 1n, floorShares }).decision, "refuse-floor");
  const forced = planRemoval({ held, shares: held, floorShares, allowBelowFloor: true });
  assert.equal(forced.decision, "remove");
  assert.equal(forced.belowFloor, true);
  assert.match(forced.warning, /^OVERRIDE:/);
  assert.equal(planRemoval({ held, shares: held + 1n, floorShares }).decision, "refuse");
  assert.equal(planRemoval({ held, shares: 0n, floorShares }).decision, "refuse");
  // A recipient already under the floor may not remove anything without the override.
  assert.equal(planRemoval({ held: 10n, shares: 1n, floorShares }).decision, "refuse-floor");
});

// Round 14 (review of round 13, M1/M2): the skim recipient and the signed bytes.
test("keeper refuses a gate file whose feeTo is not its Safe, and a factory that pays another recipient", async () => {
  const other = address(0xbad);
  const edited = { ...gate, deployment: { ...gate.deployment, feeTo: other } };
  let signs = 0;
  const deps = (node) => ({ ...keeperDeps(node), sign: async (tx) => { signs++; return signer(tx); } });
  const a = await runKeeper(edited, keeperOptions(), emptyKeeperState(), deps(fakeNode({ balances: ABOVE_CAP })));
  assert.equal(a.level, CRIT);
  assert.match(a.detail, /is not its Bloch Inc Safe/);
  const b = await runKeeper(gate, keeperOptions(), emptyKeeperState(), deps(fakeNode({ balances: ABOVE_CAP, factoryFeeTo: other })));
  assert.equal(b.level, CRIT);
  assert.match(b.detail, /the factory pays fees to/);
  assert.equal(signs, 0);
});

test("keeper publishes only the planned transaction, whatever the signer returns", async () => {
  const cases = {
    recipient: (tx) => ({ ...tx, to: address(0xbad) }),
    value: (tx) => ({ ...tx, value: 1n }),
    gas: (tx) => ({ ...tx, gas: 5_000_000n }),
    fee: (tx) => ({ ...tx, maxFeePerGas: tx.maxFeePerGas * 100n }),
    tip: (tx) => ({ ...tx, maxPriorityFeePerGas: tx.maxPriorityFeePerGas + 1n }),
    data: (tx) => ({ ...tx, data: "0x" }),
    nonce: (tx) => ({ ...tx, nonce: tx.nonce + 1 }),
    chain: (tx) => ({ ...tx, chainId: 1 }),
  };
  for (const [name, change] of Object.entries(cases)) {
    const node = fakeNode({ balances: ABOVE_CAP });
    const sent = [];
    const request = async (method, params) => { if (method === "eth_sendRawTransaction") sent.push(params[0]); return node.request(method, params); };
    const sign = async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) =>
      account.signTransaction(change({ chainId, nonce: Number(nonce), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, to, data, type: "eip1559" }));
    const deps = keeperDeps(node);
    const outcome = await runKeeper(gate, keeperOptions(), emptyKeeperState(), { ...deps, request, sign });
    assert.equal(outcome.level, CRIT, name);
    assert.match(outcome.detail, /not the planned skim/, name);
    assert.equal(sent.length, 0, name);
    assert.ok(deps.saves.every((s) => JSON.parse(s).txs.length === 0), `${name}: nothing reserved for an unpublished transaction`);
  }
});

// ---- round 14 (agent 307): automatic recovery of a lost keeper transaction.
// Rule under test: one nonce at a time. A recorded transaction that is not in the chain is
// published again unchanged, or replaced AT THE SAME NONCE by another skim(Safe); a new nonce
// is opened only after the old one is settled by finalized data.

import { storedSkim } from "./dex-skim-keeper.mjs";
import { keeperNeedsReconciliation, keeperWindowSpend } from "./keeper-accounting.mjs";
import { mkdtempSync as makeTempDir, writeFileSync as writeTempFile } from "node:fs";
import { tmpdir as tempRoot } from "node:os";
import { join as joinPath } from "node:path";
/// The monitor's keeper_budget check on an in-memory keeper state.
function checkKeeperStateOf(state, now, add) {
  const path = joinPath(makeTempDir(joinPath(tempRoot(), "keeper-")), "state.json");
  writeTempFile(path, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  checkKeeperState(path, now, add);
}
import { JsonRpcResponseError } from "../staging/rpc-transport.mjs";

const T0_SENT = 1_000_000;
const skimOf = (raw) => {
  const tx = viem.parseTransaction(raw);
  const decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  return { tx, to: tx.to.toLowerCase(), fn: decoded.functionName, recipient: decoded.args[0].toLowerCase(), nonce: tx.nonce ?? 0 };
};
/// Every transaction the fake node was ever handed is a skim(Safe) on the pinned pair.
function assertOnlySkimsToSafe(node) {
  for (const raw of node.chain.sent) {
    const s = skimOf(raw);
    assert.equal(s.to, PAIR);
    assert.equal(s.fn, "skim");
    assert.equal(s.recipient, SAFE);
    assert.equal(s.tx.value ?? 0n, 0n);
  }
}
const feeRefusal = (raw, { required = 2_000_000_000n, base = 1_000_000_000n } = {}) => new RpcError("underpriced", { cause: new JsonRpcResponseError("eth_sendRawTransaction", {
  code: -32000, message: "transaction underpriced for sequencer policy",
  data: {
    kind: "sequencer-fee-underpriced", scope: "latest-state-next-block", transactionHash: keccak256(raw),
    headHash: blockHash(10n), headNumber: "0xa", baseFeePerGas: `0x${base.toString(16)}`,
    requiredPriorityFeePerGas: `0x${required.toString(16)}`, requiredMaxFeePerGas: `0x${(required + base).toString(16)}`,
    effectivePriorityFeePerGas: "0x1", gasUsed: "0x186a0", freshSlots: "0x1", chargedFreshSlots: "0x1", freshSlotPriceWei: `0x${(required * 100_000n).toString(16)}`,
  },
}) });
async function sentOnce(overrides = {}) {
  const node = fakeNode({ balances: ABOVE_CAP, ...overrides });
  const state = emptyKeeperState();
  const first = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  assert.equal(first.action, "sent");
  return { node, state };
}

test("recovery: the state keeps the signed bytes, and they are published again unchanged after the interval", async () => {
  const { node, state } = await sentOnce();
  assert.equal(keccak256(state.txs[0].raw), state.txs[0].hash);
  assert.equal(state.txs[0].raw, node.chain.sent[0]);
  const early = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 899));
  assert.equal(early.action, "wait-in-flight");
  assert.equal(early.rebroadcast, undefined);
  assert.equal(node.chain.sent.length, 1);
  const again = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900));
  assert.equal(again.action, "wait-in-flight");
  assert.equal(again.rebroadcast, "accepted");
  assert.equal(again.level, OK);
  assert.deepEqual(node.chain.sent, [state.txs[0].raw, state.txs[0].raw]);
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].broadcasts, 2);
  // Not again before another interval.
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_000));
  assert.equal(node.chain.sent.length, 2);
  // It lands: one settled entry, and the output never carried the signed bytes.
  node.chain.receipts[state.txs[0].hash] = keeperReceipt(node, state.txs[0].hash, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  const done = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_100));
  assert.equal(done.action, "nothing-to-do");
  assert.equal(state.txs[0].status, "effective");
  assert.equal(JSON.stringify(again).includes(state.txs[0].raw), false);
  assertOnlySkimsToSafe(node);
});

test("recovery: a dry run never publishes stored bytes", async () => {
  const { node, state } = await sentOnce();
  const outcome = await runKeeper(gate, keeperOptions({ execute: false }), state, keeperDeps(node, T0_SENT + 5_000));
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(node.chain.sent.length, 1);
});

test("recovery: after a lost publication the next pass publishes the recorded transaction itself", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  node.chain.publish = () => { throw new RpcError("ECONNRESET"); };
  const lost = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  assert.equal(lost.action, "publish-unconfirmed");
  delete node.chain.publish;
  const next = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900));
  assert.equal(next.rebroadcast, "accepted");
  assert.equal(node.chain.sent[1], node.chain.sent[0]);
  assert.equal(new Set(node.chain.sent.map((raw) => skimOf(raw).nonce)).size, 1);
});

test("recovery: a transaction still out of the chain after two hours is replaced at the SAME nonce with higher fees", async () => {
  const { node, state } = await sentOnce();
  const before = { ...state.txs[0] };
  // A node that still counts the lost transaction as queued must not move the replacement to a new nonce.
  node.chain.nonceAt = (tag) => (tag === "pending" ? 1n : 0n);
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 7_200));
  assert.equal(outcome.action, "replaced");
  assert.equal(outcome.replacesHash, before.hash);
  assert.equal(state.txs.length, 1);
  const [entry] = state.txs;
  assert.notEqual(entry.hash, before.hash);
  assert.equal(entry.nonce, before.nonce);
  assert.equal(entry.status, "pending");
  assert.deepEqual(entry.attempts.map((a) => a.hash), [before.hash]);
  const replacement = skimOf(node.chain.sent.at(-1));
  const original = skimOf(before.raw);
  assert.equal(replacement.nonce, original.nonce);
  assert.ok(replacement.tx.maxPriorityFeePerGas * 100n >= original.tx.maxPriorityFeePerGas * 110n);
  assert.ok(replacement.tx.maxFeePerGas * 100n >= original.tx.maxFeePerGas * 110n);
  assert.ok(replacement.tx.maxPriorityFeePerGas <= DEFAULTS.maxTipWei && replacement.tx.maxFeePerGas <= DEFAULTS.maxFeeWei);
  // One nonce, one charge: the reservation is the dearest attempt, not the sum.
  assert.equal(BigInt(entry.reservedWei), replacement.tx.gas * replacement.tx.maxFeePerGas);
  assert.equal(keeperWindowSpend(state, T0_SENT + 7_200), BigInt(entry.reservedWei));
  assert.equal(new Set(node.chain.sent.map((raw) => skimOf(raw).nonce)).size, 1);
  assertOnlySkimsToSafe(node);
});

for (const winner of ["original", "replacement"]) test(`recovery: when the ${winner} of a replaced nonce is mined, the entry settles on it and only then a new nonce opens`, async () => {
  const { node, state } = await sentOnce();
  const originalHash = state.txs[0].hash;
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 7_200));
  const replacementHash = state.txs[0].hash;
  const mined = winner === "original" ? originalHash : replacementHash;
  // Still open: a further pass must not sign a second nonce.
  const waiting = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 7_300));
  assert.equal(waiting.action, "wait-in-flight");
  node.chain.receipts[mined] = keeperReceipt(node, mined, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  node.chain.nonce = 1n;
  node.chain.blockTimestamps[9n] = BigInt(T0_SENT + 7_400);
  const settled = await runKeeper(gate, keeperOptions({ cooldownSeconds: 0 }), state, keeperDeps(node, T0_SENT + 7_500));
  assert.equal(state.txs[0].status, "effective");
  assert.equal(state.txs[0].hash, mined);
  assert.equal(state.txs[0].spentWei, (0x10000n * 0x3b9aca00n).toString());
  assert.equal(keeperNeedsReconciliation(state.txs[0]), false);
  // The fake still shows the excess, so the same pass goes on to a NEW skim: nonce 1, never nonce 0 again.
  assert.equal(settled.action, "sent");
  // Published: the original, its unchanged re-publication, the replacement, then the new nonce.
  assert.deepEqual(node.chain.sent.map((raw) => skimOf(raw).nonce), [0, 0, 0, 1]);
  assert.equal(node.chain.sent[1], node.chain.sent[0]);
  assertOnlySkimsToSafe(node);
});

test("recovery: a replacement never leaves the fee ceilings, the budget or the replacement limit", async () => {
  // Fee ceiling: the original was signed at the cap, so no higher bid exists inside it.
  const capped = await sentOnce({ baseFee: 9_000_000_000n });
  const signs = [];
  const depsOf = (node, now) => ({ ...keeperDeps(node, now), sign: async (tx) => { signs.push(tx); return signer(tx); } });
  const atCap = await runKeeper(gate, keeperOptions(), capped.state, depsOf(capped.node, T0_SENT + 7_200));
  assert.equal(atCap.action, "fee-above-ceiling");
  assert.equal(atCap.level, WARN);
  assert.equal(signs.length, 0);
  assert.equal(capped.node.chain.sent.length, 2); // the original, and its unchanged re-publication
  assert.equal(capped.node.chain.sent[1], capped.node.chain.sent[0]);

  // Budget: the replacement's reservation replaces the old one; it must still fit.
  const tight = await sentOnce();
  const budget = BigInt(tight.state.txs[0].reservedWei);
  const noRoom = await runKeeper(gate, keeperOptions({ budgetWei: budget }), tight.state, depsOf(tight.node, T0_SENT + 7_200));
  assert.equal(noRoom.action, "budget-exhausted");
  assert.equal(signs.length, 0);
  // ...and it is charged once: a budget below the two attempts' sum, above the dearer one, is enough.
  const once = await sentOnce();
  const fits = await runKeeper(gate, keeperOptions({ budgetWei: 2n * BigInt(once.state.txs[0].reservedWei) - 1n }), once.state, keeperDeps(once.node, T0_SENT + 7_200));
  assert.equal(fits.action, "replaced");

  // Limit: four replacements, then it only waits (and says so).
  const many = await sentOnce();
  let now = T0_SENT;
  for (let i = 0; i < 4; i++) {
    now += 7_200;
    assert.equal((await runKeeper(gate, keeperOptions({ maxTipWei: 100_000_000_000n, maxFeeWei: 200_000_000_000n, budgetWei: 10n ** 18n }), many.state, keeperDeps(many.node, now))).action, "replaced");
  }
  now += 7_200;
  const stop = await runKeeper(gate, keeperOptions({ maxTipWei: 100_000_000_000n, maxFeeWei: 200_000_000_000n, budgetWei: 10n ** 18n }), many.state, depsOf(many.node, now));
  assert.equal(stop.action, "wait-in-flight");
  assert.equal(stop.reason, "replacements-exhausted");
  assert.equal(stop.level, WARN);
  assert.equal(signs.length, 0);
  assert.equal(many.state.txs.length, 1);
  assert.equal(new Set(many.node.chain.sent.map((raw) => skimOf(raw).nonce)).size, 1);
});

test("recovery: a lost transaction with nothing left to skim is not replaced; its nonce waits for the next skim", async () => {
  const { node, state } = await sentOnce();
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, T0_SENT + 9_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(outcome.action, "wait-in-flight");
  assert.equal(outcome.replaceable, true);
  assert.equal(state.txs[0].status, "pending");
  assert.ok(BigInt(state.txs[0].reservedWei) > 0n);
});

test("recovery: a node that proves the bytes are not in its spool lets the same nonce be replaced at once, at its quote", async () => {
  const { node, state } = await sentOnce();
  const original = state.txs[0].raw;
  node.chain.publish = (raw) => { if (raw === original) throw feeRefusal(raw, { required: 3_000_000_000n }); return keccak256(raw); };
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900));
  assert.equal(outcome.action, "replaced");
  const replacement = skimOf(node.chain.sent.at(-1));
  assert.equal(replacement.nonce, 0);
  assert.ok(replacement.tx.maxPriorityFeePerGas >= 3_000_000_000n);
  assert.equal(state.txs[0].feeRequirement, undefined);
  assert.equal(state.txs.length, 1);

  // A quote above the tip ceiling is never followed.
  const high = await sentOnce();
  const raw = high.state.txs[0].raw;
  high.node.chain.publish = (r) => { if (r === raw) throw feeRefusal(r, { required: 9_000_000_000n }); return keccak256(r); };
  const refused = await runKeeper(gate, keeperOptions(), high.state, { ...keeperDeps(high.node, T0_SENT + 900), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(refused.action, "fee-above-ceiling");
  assert.equal(refused.requiredTipWei, 9_000_000_000n);
  assert.equal(high.state.txs[0].hash, keccak256(raw));
});

test("K-L1: a refused first publication keeps its nonce and reservation; after the cooldown it is replaced at the SAME nonce at the node's quote", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  node.chain.publish = (raw) => { if (skimOf(raw).tx.maxPriorityFeePerGas < 2_000_000_000n) throw feeRefusal(raw); return keccak256(raw); };
  const refused = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  assert.equal(refused.action, "publish-refused");
  assert.equal(refused.level, WARN);
  const refusedHash = state.txs[0].hash;
  assert.equal(state.txs[0].status, "pending");
  assert.equal(state.txs[0].refusedFirst, true);
  assert.equal(state.txs[0].feeRequirement.requiredPriorityFeePerGas, "2000000000");
  assert.equal(state.feeHint, undefined);
  assert.equal(keeperNeedsReconciliation(state.txs[0]), true);
  // Inside the cooldown nothing is signed and nothing is published again.
  const waiting = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, T0_SENT + 1_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(waiting.action, "wait-in-flight");
  assert.equal(waiting.reason, "refused-not-in-spool");
  assert.equal(waiting.level, OK);
  assert.equal(waiting.rebroadcast, undefined);
  assert.equal(node.chain.sent.length, 1); // the fake counts the refused publication itself
  const retry = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_800));
  assert.equal(retry.action, "replaced");
  assert.equal(retry.replacesHash, refusedHash);
  assert.equal(retry.tip, 2_000_000_000n);
  // One entry, one nonce, one reservation: the refused bytes are an older attempt of the same entry.
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].refusedFirst, undefined);
  assert.deepEqual(state.txs[0].attempts.map((a) => a.hash), [refusedHash]);
  assert.equal(skimOf(node.chain.sent.at(-1)).nonce, 0);
  assert.equal(keeperWindowSpend(state, T0_SENT + 1_800), BigInt(state.txs[0].reservedWei));

  // A quote above the ceilings stays a CRIT for the operator and is never followed.
  const dear = fakeNode({ balances: ABOVE_CAP });
  dear.chain.publish = (raw) => { throw feeRefusal(raw, { required: 50_000_000_000n }); };
  const dearState = emptyKeeperState();
  assert.equal((await runKeeper(gate, keeperOptions(), dearState, keeperDeps(dear, T0_SENT))).level, CRIT);
  // ...and it is not remembered: the next attempt is priced afresh, inside the ceilings, at the same nonce.
  assert.equal(dearState.txs[0].feeRequirement, undefined);
  const firstHash = dearState.txs[0].hash;
  let now = T0_SENT;
  for (let i = 0; i < 6; i++) {
    now += 1_800;
    const again = await runKeeper(gate, keeperOptions(), dearState, keeperDeps(dear, now));
    assert.equal(again.action, "publish-refused");
    assert.equal(again.level, CRIT);
  }
  // Refused replacements are not attempts: still one entry on the first bytes, never exhausted.
  assert.equal(dearState.txs.length, 1);
  assert.equal(dearState.txs[0].hash, firstHash);
  assert.equal(dearState.txs[0].attempts, undefined);
  assert.equal(dearState.txs[0].refusedFirst, true);
  assert.deepEqual([...new Set(dear.chain.sent.map((raw) => skimOf(raw).nonce))], [0]);
  assert.ok(dear.chain.sent.every((raw) => skimOf(raw).tx.maxPriorityFeePerGas <= DEFAULTS.maxTipWei && skimOf(raw).tx.maxFeePerGas <= DEFAULTS.maxFeeWei));
});

test("K-L1: a node that refuses a first publication and mines it anyway gets no second nonce and no free budget", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  // The lying node: answers with its admission refusal, keeps the bytes, and mines them later.
  node.chain.publish = (raw) => { throw feeRefusal(raw); };
  const refused = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  assert.equal(refused.action, "publish-refused");
  const hash = state.txs[0].hash;
  const reserved = BigInt(state.txs[0].reservedWei);
  node.chain.receipts[hash] = keeperReceipt(node, hash, { logs: [{ topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x01" }] });
  node.chain.nonce = 1n;
  node.chain.finalizedNumber = 8n; // the receipt's block (9) is not final yet
  const signs = [];
  const deps = (at) => ({ ...keeperDeps(node, at), sign: async (tx) => { signs.push(tx); return signer(tx); } });
  const before = await runKeeper(gate, keeperOptions(), state, deps(T0_SENT + 1_800));
  // Excess still shows at latest in this fake; the keeper must not sign nonce 1 on the node's word.
  assert.equal(before.action, "wait-in-flight");
  assert.equal(before.reason, "awaiting-finality");
  assert.equal(signs.length, 0);
  assert.equal(keeperWindowSpend(state, T0_SENT + 1_800), reserved);
  node.chain.finalizedNumber = 9n;
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  const after = await runKeeper(gate, keeperOptions(), state, deps(T0_SENT + 3_600));
  assert.equal(after.action, "nothing-to-do");
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].status, "effective");
  // The gas the "refused" transaction really used is charged to the rolling budget.
  assert.ok(BigInt(state.txs[0].spentWei) > 0n);
  assert.equal(keeperWindowSpend(state, T0_SENT + 3_600), BigInt(state.txs[0].spentWei));
  assert.equal(signs.length, 0);
});

test("K-L1: a refused first publication with nothing left to skim waits without a warning and is never published again by itself", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  node.chain.publish = (raw) => { throw feeRefusal(raw); };
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  node.chain.balances = [500_000_000n, 5n * 10n ** 18n];
  delete node.chain.publish;
  for (const later of [1_800, 7_300, 90_000, 200_000]) {
    const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + later));
    assert.equal(outcome.action, "wait-in-flight", String(later));
    assert.equal(outcome.reason, "refused-not-in-spool");
    assert.equal(outcome.replaceable, true);
    assert.equal(outcome.level, OK);
  }
  assert.equal(node.chain.sent.length, 1); // only the refused first publication
  assert.equal(keeperWindowSpend(state, T0_SENT + 200_000), BigInt(state.txs[0].reservedWei));
  const checks = [];
  checkKeeperStateOf(state, T0_SENT + 200_000, (name, level) => checks.push(level));
  assert.deepEqual(checks, [OK]);
  // The day-old quote is forgotten; the next needed skim reuses the nonce.
  assert.equal(state.txs[0].feeRequirement, undefined);
  node.chain.balances = ABOVE_CAP;
  const reuse = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 200_100));
  assert.equal(reuse.action, "replaced");
  assert.equal(skimOf(node.chain.sent.at(-1)).nonce, 0);
  assert.equal(state.txs.length, 1);
});

test("K-L1: the precautionary 12.5% over refused bytes is capped at the operator's ceilings instead of blocking", async () => {
  const node = fakeNode({ balances: ABOVE_CAP, baseFee: 9_500_000_000n });
  const state = emptyKeeperState();
  let refuse = true;
  node.chain.publish = (raw) => { if (refuse) throw feeRefusal(raw, { required: 1_000_000_000n, base: 9_500_000_000n }); return keccak256(raw); };
  await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT));
  // The refused attempt already carried the fee ceiling; 12.5% above it does not exist.
  assert.equal(BigInt(state.txs[0].maxFeeWei), DEFAULTS.maxFeeWei);
  refuse = false;
  const retry = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_800));
  assert.equal(retry.action, "replaced");
  const replacement = skimOf(node.chain.sent.at(-1));
  assert.equal(replacement.nonce, 0);
  assert.equal(replacement.tx.maxFeePerGas, DEFAULTS.maxFeeWei);
  // An entry that WAS accepted keeps the binding rule: no replacement above the ceiling.
  const sent = await sentOnce({ baseFee: 9_500_000_000n });
  const blocked = await runKeeper(gate, keeperOptions(), sent.state, { ...keeperDeps(sent.node, T0_SENT + 7_200), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(blocked.action, "fee-above-ceiling");
});

test("recovery: stored bytes that are not this keeper's skim to the Safe are never published", async () => {
  const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const forge = async (account_, changes) => account_.signTransaction({ chainId: 700770, nonce: 0, gas: 96_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: "eip1559",
    to: PAIR, data: viem.encodeFunctionData({ abi: ABI, functionName: "skim", args: [SAFE] }), ...changes });
  const cases = {
    "another recipient": await forge(account, { data: viem.encodeFunctionData({ abi: ABI, functionName: "skim", args: [account.address] }) }),
    "another contract": await forge(account, { to: T0 }),
    "value attached": await forge(account, { value: 1n }),
    "another nonce": await forge(account, { nonce: 5 }),
    "another chain": await forge(account, { chainId: 1 }),
    "another signer": await forge(other, {}),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const { node, state } = await sentOnce();
    state.txs[0].raw = raw;
    state.txs[0].hash = keccak256(raw);
    const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900));
    assert.equal(outcome.action, "refused", name);
    assert.equal(outcome.level, CRIT, name);
    assert.equal(node.chain.sent.length, 1, name);
  }
  // A hash that does not match the bytes, and a pair the gate does not pin.
  const { node, state } = await sentOnce();
  state.txs[0].hash = blockHash(77n);
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900))).action, "refused");
  const deployment = { chainId: 700770, feeTo: SAFE, pairs: [{ address: PAIR }] };
  await assert.rejects(storedSkim({ hash: keccak256(cases["another recipient"]), raw: cases["another recipient"], pair: PAIR, nonce: "0" }, account.address.toLowerCase(), deployment), /not this keeper's skim/);
  assert.equal(node.chain.sent.length, 1);
});

test("recovery: the factory's fee recipient is checked before stored bytes are published again", async () => {
  const { node, state } = await sentOnce();
  node.chain.factoryFeeTo = address(0xbad);
  const outcome = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900));
  assert.equal(outcome.action, "refused");
  assert.equal(node.chain.sent.length, 1);
});

function foreignConsumer(node, { at = 7n, finalized = 9n } = {}) {
  const hash = blockHash(0xf00n);
  node.chain.finalizedNumber = finalized;
  node.chain.nonceAt = (tag) => (tag === "latest" || tag === "pending" ? 1n : BigInt(tag) >= at ? 1n : 0n);
  node.chain.blockTxs = { [at]: [{ hash, from: account.address, nonce: "0x0" }, { hash: blockHash(0xf01n), from: address(0x99), nonce: "0x0" }] };
  node.chain.blockTimestamps[at] = BigInt(T0_SENT + 50);
  node.chain.receipts[hash] = { transactionHash: hash, from: account.address.toLowerCase(), to: address(0x1234), status: "0x1", blockNumber: `0x${at.toString(16)}`, blockHash: blockHash(at), gasUsed: "0x5208", effectiveGasPrice: "0x77359400", logs: [] };
  return hash;
}

test("recovery: a nonce used by a transaction the keeper did not record is settled from the finalized chain at its real cost", async () => {
  const { node, state } = await sentOnce();
  const reserved = BigInt(state.txs[0].reservedWei);
  const foreign = foreignConsumer(node);
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, T0_SENT + 100), sign: async () => { throw new Error("must not sign in the settling pass"); } });
  assert.equal(outcome.action, "nonce-settled-by-other-transaction");
  assert.equal(outcome.level, WARN);
  assert.equal(outcome.supersededBy, foreign);
  const [entry] = state.txs;
  assert.equal(entry.status, "superseded");
  assert.equal(entry.spentWei, (0x5208n * 0x77359400n).toString());
  assert.equal(entry.includedAt, T0_SENT + 50);
  assert.equal(entry.includedBlockNumber, "7");
  assert.equal(keeperNeedsReconciliation(entry), false);
  assert.ok(keeperWindowSpend(state, T0_SENT + 100) < reserved);
  assert.equal(node.chain.sent.length, 1);
  // The monitor reads the same accounting: nothing unresolved.
  const checks = [];
  const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/keeper-superseded-`);
  (await import("node:fs")).writeFileSync(`${dir}/state.json`, JSON.stringify(state));
  checkKeeperState(`${dir}/state.json`, T0_SENT + 9_000, (name, level, text) => checks.push({ name, level, text }));
  (await import("node:fs")).rmSync(dir, { recursive: true });
  assert.equal(checks[0].level, OK);
  // Next pass: a new nonce, the account's next one.
  const next = await runKeeper(gate, keeperOptions({ cooldownSeconds: 0 }), state, keeperDeps(node, T0_SENT + 200));
  assert.equal(next.action, "sent");
  assert.equal(skimOf(node.chain.sent.at(-1)).nonce, 1);
});

test("recovery: a used nonce is not settled before finality, without the consuming transaction, or from an inconsistent node", async () => {
  // Used at latest only.
  const a = await sentOnce();
  foreignConsumer(a.node, { at: 10n, finalized: 9n });
  a.node.chain.nonceAt = (tag) => (tag === "latest" || tag === "pending" || BigInt(tag) >= 10n ? 1n : 0n);
  const early = await runKeeper(gate, keeperOptions(), a.state, keeperDeps(a.node, T0_SENT + 100));
  assert.equal(early.reason, "nonce-used-without-receipt");
  assert.equal(a.state.txs[0].status, "pending");

  // Finalized, but the block does not show a keeper transaction with that nonce.
  const b = await sentOnce();
  foreignConsumer(b.node);
  b.node.chain.blockTxs = {};
  assert.equal((await runKeeper(gate, keeperOptions(), b.state, keeperDeps(b.node, T0_SENT + 100))).reason, "nonce-used-without-receipt");
  assert.equal(b.state.txs[0].status, "pending");

  // The consuming transaction is the recorded one (receipt index behind): wait for the receipt.
  const c = await sentOnce();
  foreignConsumer(c.node);
  c.node.chain.blockTxs = { [7n]: [{ hash: c.state.txs[0].hash, from: account.address, nonce: "0x0" }] };
  assert.equal((await runKeeper(gate, keeperOptions(), c.state, keeperDeps(c.node, T0_SENT + 100))).reason, "nonce-used-without-receipt");
  assert.equal(c.state.txs[0].status, "pending");

  // Its receipt names another block or sender.
  for (const change of [{ blockHash: blockHash(8n) }, { from: address(0x99) }, { transactionHash: blockHash(1n) }, { gasUsed: "0x0" }]) {
    const d = await sentOnce();
    const foreign = foreignConsumer(d.node);
    Object.assign(d.node.chain.receipts[foreign], change);
    const outcome = await runKeeper(gate, keeperOptions(), d.state, keeperDeps(d.node, T0_SENT + 100));
    assert.equal(outcome.action, "wait-in-flight", JSON.stringify(change));
    assert.equal(d.state.txs[0].status, "pending");
    assert.equal(d.node.chain.sent.length, 1);
  }
});

test("recovery: an earlier open nonce of the account, or two unresolved records, never lead to a replacement", async () => {
  const gap = await sentOnce({ nonce: 3n });
  gap.node.chain.nonceAt = (tag) => (tag === "pending" ? 4n : 2n);
  const waiting = await runKeeper(gate, keeperOptions(), gap.state, { ...keeperDeps(gap.node, T0_SENT + 9_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(waiting.action, "wait-in-flight");
  assert.equal(waiting.reason, "nonce-gap");
  assert.equal(waiting.level, WARN);
  assert.equal(gap.node.chain.sent.length, 1);

  const two = await sentOnce();
  two.state.txs.push({ ...two.state.txs[0], hash: blockHash(0xabcn), nonce: "1" });
  const outcome = await runKeeper(gate, keeperOptions(), two.state, { ...keeperDeps(two.node, T0_SENT + 9_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(outcome.action, "wait-in-flight");
});

// ---- round 14 review findings (independent reviewer, 2026-11-09)

test("review M1: a quote above the ceilings is forgotten after one interval, and the stored bytes are published again", async () => {
  const { node, state } = await sentOnce();
  const raw = state.txs[0].raw;
  let refuse = true;
  node.chain.publish = (r) => { if (refuse) throw feeRefusal(r, { required: 9_000_000_000n }); return keccak256(r); };
  assert.equal((await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 900))).action, "fee-above-ceiling");
  refuse = false; // the price fell back; the old quote must not hold the entry
  const early = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_000));
  assert.equal(early.action, "fee-above-ceiling");
  const later = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, T0_SENT + 1_800));
  assert.equal(later.action, "wait-in-flight");
  assert.equal(later.rebroadcast, "accepted");
  assert.equal(state.txs[0].feeRequirement, undefined);
  assert.equal(node.chain.sent.at(-1), raw);
});

test("review M2: a replacement the node refuses is not an attempt, is spaced, and never exhausts the replacements", async () => {
  const { node, state } = await sentOnce();
  const original = state.txs[0].hash;
  node.chain.publish = (r) => { throw feeRefusal(r, { required: 3_000_000_000n }); };
  let now = T0_SENT + 900;
  const first = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, now));
  assert.equal(first.action, "publish-refused");
  assert.equal(first.level, WARN);
  assert.equal(state.txs[0].hash, original);
  assert.equal(state.txs[0].attempts, undefined);
  const signs = [];
  const soon = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node, now + 60), sign: async (tx) => { signs.push(tx); return signer(tx); } });
  assert.equal(soon.action, "wait-in-flight");
  assert.equal(signs.length, 0);
  for (let i = 0; i < 8; i++) { now += 900; await runKeeper(gate, keeperOptions(), state, keeperDeps(node, now)); }
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0].attempts, undefined);
  // The node accepts again: the keeper still acts, on the same nonce.
  delete node.chain.publish;
  now += 900;
  const done = await runKeeper(gate, keeperOptions(), state, keeperDeps(node, now));
  assert.ok(done.rebroadcast === "accepted" || done.action === "replaced", done.action);
  assert.equal(new Set(node.chain.sent.map((raw) => skimOf(raw).nonce)).size, 1);
  assertOnlySkimsToSafe(node);
});

test("review M3: no new nonce is signed behind other queued transactions of the keeper account", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  node.chain.nonceAt = (tag) => (tag === "pending" ? 1n : 0n);
  const state = emptyKeeperState();
  const outcome = await runKeeper(gate, keeperOptions(), state, { ...keeperDeps(node), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(outcome.action, "keeper-account-has-queued-transactions");
  assert.equal(outcome.level, WARN);
  assert.equal(state.txs.length, 0);
});

test("review M4: a node that reports an old block timestamp cannot empty the budget window", async () => {
  const node = fakeNode({ balances: ABOVE_CAP });
  const state = emptyKeeperState();
  const options = keeperOptions({ maxTx: 2, hardReserveBps: 0n, cooldownSeconds: 0 });
  let now = T0_SENT;
  for (let i = 0; i < 2; i++) {
    assert.equal((await runKeeper(gate, options, state, keeperDeps(node, now))).action, "sent");
    const hash = state.txs.at(-1).hash;
    node.chain.receipts[hash] = keeperReceipt(node, hash);
    node.chain.blockTimestamps[9n] = 1n; // the lie: included in 1970
    node.chain.nonce += 1n;
    now += 300;
  }
  const third = await runKeeper(gate, options, state, keeperDeps(node, now));
  assert.equal(third.action, "tx-count-exhausted");
  assert.equal(state.txs.length, 2);
});

test("review M5: a wall clock far from the chain head stops the pass before the window is touched", async () => {
  const node = fakeNode({ balances: ABOVE_CAP, latestNumber: 10n });
  node.chain.blockTimestamps[10n] = BigInt(T0_SENT);
  const state = emptyKeeperState();
  const options = keeperOptions({ maxClockSkewSeconds: 64_800 });
  assert.equal((await runKeeper(gate, options, state, keeperDeps(node, T0_SENT + 100))).action, "sent");
  const before = JSON.stringify(state);
  for (const now of [T0_SENT + 90_000, T0_SENT - 70_000]) {
    const outcome = await runKeeper(gate, options, state, { ...keeperDeps(node, now), sign: async () => { throw new Error("must not sign"); } });
    assert.equal(outcome.action, "clock-or-head-stale");
  }
  // With nothing open, the stale clock is what stops it, and the history is intact.
  const settled = emptyKeeperState();
  settled.txs.push({ at: T0_SENT, hash: blockHash(5n), nonce: "0", pair: PAIR, reservedWei: "1", spentWei: "1", status: "effective", ...settledFields(T0_SENT) });
  const ahead = await runKeeper(gate, options, settled, { ...keeperDeps(node, T0_SENT + 90_000), sign: async () => { throw new Error("must not sign"); } });
  assert.equal(ahead.action, "clock-or-head-stale");
  assert.equal(ahead.level, WARN);
  assert.equal(settled.txs.length, 1);
  assert.equal(JSON.stringify(state), before);
});

test("review L8: a pinned pair that belongs to another factory is refused", async () => {
  const node = fakeNode({ balances: ABOVE_CAP, pairFactory: address(0xbad) });
  const outcome = await runKeeper(gate, keeperOptions(), emptyKeeperState(), keeperDeps(node));
  assert.equal(outcome.action, "refused");
  assert.match(outcome.detail, /belongs to factory/);
  assert.equal(node.chain.sent.length, 0);
});

test("keeper CLI: ceilings that contradict each other are refused at start, before any file or node is read", () => {
  const cli = fileURLToPath(new URL("./dex-skim-keeper.mjs", import.meta.url));
  const base = [cli, "--config", "/nonexistent/gate.json", "--rpc", "http://127.0.0.1:9", "--keeper", KEEPER, "--state", "/nonexistent/keeper/state.json"];
  for (const [flags, message] of [
    [["--max-fee-wei", "1"], /--max-tip-wei must not exceed --max-fee-wei/],
    [["--max-tip-wei", "30000000000"], /--max-tip-wei must not exceed --max-fee-wei/],
    [["--tip-wei", "9000000000"], /--tip-wei must not exceed --max-tip-wei/],
    [["--budget-wei", "-1"], /must not be negative/],
  ]) {
    const run = spawnSync(process.execPath, [...base, ...flags], { encoding: "utf8" });
    assert.equal(run.status, CRIT, flags.join(" "));
    assert.match(run.stderr, message);
  }
  // A coherent, lowered range gets past the check (and then fails on the missing gate file, not on the ceilings).
  const coherent = spawnSync(process.execPath, [...base, "--max-fee-wei", "1", "--max-tip-wei", "1", "--tip-wei", "1"], { encoding: "utf8" });
  assert.doesNotMatch(coherent.stderr, /must not exceed/);
});
