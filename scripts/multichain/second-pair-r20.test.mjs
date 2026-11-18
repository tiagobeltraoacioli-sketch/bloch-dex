// Round 20 (agent 409): a second listed token (USDT) with its own pool on each chain where it could be proven.
//   node --test scripts/multichain/second-pair-r20.test.mjs
//
// What must hold, each with the behaviour it replaces stated where one existed:
//   A. Nothing already deployed moves: the planned factory, router, lens and first pair of every chain are the
//      addresses of `ba1455b`, and so are the factory's constructor arguments.
//   B. Every planned pair has its own two price references, under one validation; a pair is never priced by
//      another pair's references.
//   C. What a token's code hash does not show is read: transfer-fee parameters, pause and deprecation switches.
//   D. Tether's approve on Ethereum: the printed sequence works from whatever allowance stands.
//   E. Pairs open one at a time: the page's record lists exactly the pairs that are open and proven.
//   F. F409-1: a market price is two agreeing endpoints of the reviewed ones, not "the first two".
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT, ZERO_ADDRESS, chainSymbolOf, linkImmutables, loadArtifacts, loadChain, loadShared, lower, openingPriceFor, planChain, retrying, validateChain } from "./lib.mjs";
import { openingTransactions, addTransactions, withApprovals } from "./first-deposit.mjs";
import { evaluateGate, gateConfig } from "./gate.mjs";
import { frontendNetwork, frontendRecord } from "./frontend-files.mjs";
import { readMarket } from "./market.mjs";
import { MINT_TOPIC, TRANSFER_TOPIC, ROUTER_DEPOSIT_ABI } from "./opening.mjs";
import { approvalSteps, blocklistState, readGetter, tokenBehaviourState } from "./token-behaviour.mjs";
import { behaviourMismatch, functionsIn, pushedSelectors, verifyChain } from "./verify-chain.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { keccak256, encodeFunctionData, encodeFunctionResult, decodeFunctionData, parseAbi, toFunctionSelector, toHex, encodeAbiParameters } = viem;
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha256 = (path) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");

const committed = loadShared();
const committedChains = committed.chains.map((key) => loadChain(key));
const artifacts = loadArtifacts();
const chainOf = (key) => committedChains.find((c) => c.chain.key === key);
const SECOND = { "op-mainnet": "USDT", "arbitrum-one": "USDT0", "bnb-smart-chain": "USDT", ethereum: "USDT" };
const NO_SECOND = ["base", "linea"];

// ---------------------------------------------------------------------------------------------------------------
// A. Nothing already deployed moves.
// ---------------------------------------------------------------------------------------------------------------

/** The plan of `ba1455b` (docs/MULTICHAIN-DEPLOY.md section 3 at that commit; the owner deployed these on five chains). */
const PLAN_AT_BA1455B = {
  factory: "0x47D4ae3D6d8e2d8261Ee7beEF510a217Bf4a4C50",
  lens: "0x5709FF514a909aD0D994eC73D6128F38bF4F1Ca6",
  router: {
    "op-mainnet": "0xc1D01eF14c0Cfe961f548398f9b12CfDC71172C9", base: "0xc1D01eF14c0Cfe961f548398f9b12CfDC71172C9", "arbitrum-one": "0xFf5f74c4Ca90Ae6024a29175c6d9d92CbD51C5E1",
    linea: "0xf6046184F7267f0872BaB182C661f1C85695cAE2", "bnb-smart-chain": "0x605E6b76402FF050BddC903Ea2326451272f7e32", ethereum: "0x8A1DdC0BAE18A038D4E5Bb088eeDcdE10b61db53",
  },
  firstPair: {
    "op-mainnet": "0xf948448d0d253B26EAFDf33Ffe45b5C85577E99E", base: "0x1807A84b90C535F8AF4d76634C6bD792A80B496F", "arbitrum-one": "0x5D1885394A404b3e4f32432b68dacf3c19EDedE2",
    linea: "0xe99683328159b896F596cCF742b446e32b1E8205", "bnb-smart-chain": "0x7CC3289655f5aA3147Dd8538b089Ee760c2c8851", ethereum: "0x03DCe4f378e64B4620ba8b9791b1d45245505Cd8",
  },
};

test("A: the planned factory, router, lens and first pair of every chain are those of ba1455b; the factory's constructor arguments are unchanged", () => {
  // The owner's depositing account is immutable in the deployed factories: only that key opens any pool.
  assert.equal(committed.firstDepositor, "0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3");
  assert.equal(committed.feeTo.address, "0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544");
  const factoryArguments = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address[]" }, { type: "uint256[]" }], [committed.feeTo.address, committed.firstDepositor, [], []]);
  for (const chain of committedChains) {
    const key = chain.chain.key;
    const plan = planChain(committed, chain, artifacts);
    assert.equal(plan.reference, false, key);
    assert.equal(plan.contracts.factory.address, PLAN_AT_BA1455B.factory, key);
    assert.equal(plan.contracts.lens.address, PLAN_AT_BA1455B.lens, key);
    assert.equal(plan.contracts.router.address, PLAN_AT_BA1455B.router[key], key);
    assert.equal(plan.pairs[0].address, PLAN_AT_BA1455B.firstPair[key], key);
    assert.equal(plan.pairs[0].tokenB, "USDC", key);
    assert.equal(plan.contracts.factory.constructorArguments, factoryArguments, `${key}: fee address, depositing account, no caps`);
    assert.deepEqual(chain.reserveCaps, [], key);
    // A second pair is one more CREATE2 address of the SAME factory; it changes no other address.
    assert.equal(plan.pairs.length, SECOND[key] ? 2 : 1, key);
    if (SECOND[key]) {
      assert.deepEqual([plan.pairs[1].tokenA, plan.pairs[1].tokenB], [chain.wrappedNative.symbol, SECOND[key]]);
      assert.notEqual(plan.pairs[1].address, plan.pairs[0].address);
    }
  }
});

// sha256 of each file at ba1455b (`git show ba1455b:<path> | shasum -a 256`), so that the test holds in any checkout.
const BYTES_AT_BA1455B = {
  "deployments/base/chain.json": "dc148e8a0264fb0e4caeb3e302805377d7baa4cfa21b53957f92d95457639b15",
  "deployments/base/gate.json": "48f077cc7afd63e8eec9b07366b666528d8cf45b7126d958b9fb5e62e53dd623",
  "deployments/base/frontend.network.json": "e1e3bd544c0c74312c1a7a666667dc072413b5d7022c3d621fee2c5c6aa5eeee",
  "deployments/linea/chain.json": "c41ad09b669d39c77923b8c91831ac9b3ee6362ad983b019a73d5242fbf71ef7",
  "deployments/linea/gate.json": "f07bca0cf41e87de6da6fb4add1988d930681dc00a4dedf79d5158044c473a22",
  "deployments/linea/frontend.network.json": "3a949292f1d282fca27f7e0d34407f1cfd527a303d8fa13c0409fad271fb8b59",
};

test("A: a chain without a second token keeps the generated files it had, byte for byte", () => {
  for (const key of NO_SECOND) {
    const chain = chainOf(key);
    assert.equal(chain.tokens.length, 1);
    assert.equal(chain.initialPairs.length, 1);
    const gate = JSON.parse(readFileSync(join(ROOT, "deployments", key, "gate.json"), "utf8"));
    assert.equal(gate.ownerChoices.openingPrices, undefined, `${key}: no later pair, no new key`);
    assert.deepEqual(Object.keys(gate.pins.tokens[0]), ["address", "symbol", "decimals", "codeHash"]);
    assert.deepEqual(Object.keys(gate.ownerChoices), ["firstDepositor", "reserveCaps", "openingPrice"]);
  }
  for (const [path, expected] of Object.entries(BYTES_AT_BA1455B)) assert.equal(sha256(path), expected, path);
});
// ---------------------------------------------------------------------------------------------------------------
// B. One opening price rule per planned pair.
// ---------------------------------------------------------------------------------------------------------------

test("B: every planned pair has its own rule, two references of its own, the same limits; the first pair's rule is where it always was", () => {
  for (const chain of committedChains) {
    const key = chain.chain.key;
    const first = openingPriceFor(chain, chain.tokens[0]);
    assert.equal(first, chain.openingPrice, `${key}: the first pair's rule is chain.openingPrice`);
    assert.equal(openingPriceFor(chain, "USDC"), chain.openingPrice);
    assert.equal(chain.initialPairs[0].openingPrice, undefined);
    assert.throws(() => openingPriceFor(chain, "DAI"), /is not a planned pair/);
    if (!SECOND[key]) continue;
    const token = chain.tokens[1];
    const rule = openingPriceFor(chain, token);
    assert.equal(rule, chain.initialPairs[1].openingPrice);
    assert.notEqual(rule, first);
    // The same rule and the same limits as the first pair; nothing was widened to fit a second token.
    assert.deepEqual([rule.rule, rule.maxDeviationBps, rule.referencesAgreeBps, rule.references.map((r) => r.kind)], ["market", 50, 100, ["chainlink", "v3-twap"]]);
    assert.equal(rule.minimumNative, first.minimumNative, `${key}: the same floor as the first pair`);
    assert.ok(rule.minimumReason.length > 60);
    const [feeds, pool] = rule.references;
    // The native coin's feed is shared; the quote feed and the pool are this pair's own.
    assert.deepEqual(feeds.base, first.references[0].base);
    assert.equal(feeds.quote.description, "USDT / USD");
    assert.notEqual(lower(feeds.quote.proxy), lower(first.references[0].quote.proxy));
    assert.notEqual(lower(pool.pool), lower(first.references[1].pool));
    // The pool is one of the SAME publisher's factory already pinned for the chain.
    assert.deepEqual([pool.factory, pool.factoryCodeHash], [first.references[1].factory, first.references[1].factoryCodeHash]);
    for (const r of rule.references) {
      assert.match(r.source, /^https:\/\/(docs\.chain\.link|developers\.uniswap\.org|developer\.pancakeswap\.finance)\//);
      assert.equal(r.sourceChecked.fetched, "2026-11-18");
      assert.ok(r.sourceChecked.found.length > 40);
    }
    // Only Arbitrum One's token has no feed of its own; the reference says which asset stands for it and why.
    assert.equal(feeds.quoteStandsFor !== undefined, key === "arbitrum-one");
  }
  assert.deepEqual(chainOf("arbitrum-one").initialPairs[1].openingPrice.references[0].quoteStandsFor.asset, "USDT");
});

test("B: a later pair without its own rule, a copied rule, a token/token pair, a pair planned twice and a rule in two places are all refused; the limits stand", () => {
  const eth = chainOf("ethereum");
  const edit = (change) => {
    const c = clone(eth);
    change(c);
    return () => validateChain(c, "ethereum");
  };
  assert.doesNotThrow(edit(() => {}));
  assert.throws(edit((c) => delete c.initialPairs[1].openingPrice), /initialPairs\[1\]\.openingPrice/);
  assert.throws(edit((c) => (c.initialPairs[0].openingPrice = clone(c.openingPrice))), /written in one place only/);
  // The first pair's references copied to the second: the feed is another asset's, and no reference is shared.
  assert.throws(edit((c) => (c.initialPairs[1].openingPrice = clone(c.openingPrice))), /not the USD feed of USDT/);
  assert.throws(edit((c) => (c.initialPairs[1].openingPrice.references[1].pool = c.openingPrice.references[1].pool)), /same reference pool/);
  assert.throws(edit((c) => {
    c.initialPairs[1].openingPrice.references[0].quote = clone(c.openingPrice.references[0].quote);
    c.initialPairs[1].openingPrice.references[0].quote.description = "USDT / USD";
  }), /same quote feed/);
  // A feed of another asset needs the statement of what it stands for, and the statement must name that feed.
  assert.throws(edit((c) => (c.initialPairs[1].openingPrice.references[0].quote.description = "DAI / USD")), /needs quoteStandsFor/);
  assert.throws(edit((c) => (c.initialPairs[1].openingPrice.references[0].quoteStandsFor = { asset: "USDT", reason: "x".repeat(50) })), /quoteStandsFor/);
  assert.throws(edit((c) => {
    c.initialPairs[1].openingPrice.references[0].quote.description = "DAI / USD";
    c.initialPairs[1].openingPrice.references[0].quoteStandsFor = { asset: "DAI", reason: "too short" };
  }), /quoteStandsFor/);
  const arb = clone(chainOf("arbitrum-one"));
  delete arb.initialPairs[1].openingPrice.references[0].quoteStandsFor;
  assert.throws(() => validateChain(arb, "arbitrum-one"), /not the USD feed of USDT0/);
  // The same validation as the first pair's rule, field for field.
  for (const bad of [{ maxDeviationBps: 51 }, { referencesAgreeBps: 500 }, { rule: "owner" }, { minimumNative: "0" }])
    assert.throws(edit((c) => Object.assign(c.initialPairs[1].openingPrice, bad)), /initialPairs\[1\]\.openingPrice/);
  assert.throws(edit((c) => c.initialPairs[1].openingPrice.references.pop()), /initialPairs\[1\]\.openingPrice\.references/);
  assert.throws(edit((c) => (c.initialPairs[1].openingPrice.references[1].poolCodeHash = "0x00")), /factoryCodeHash and poolCodeHash/);
  // Only wrapped-native/token pairs, each planned once.
  assert.throws(edit((c) => (c.initialPairs[1].tokenA = "USDC")), /must be the wrapped native token WETH with one listed token/);
  assert.throws(edit((c) => c.initialPairs.push(clone(c.initialPairs[1]))), /planned twice/);
  // The limits of round 19 stand: at most four planned pairs and eight listed tokens.
  assert.throws(edit((c) => (c.initialPairs = Array.from({ length: 5 }, () => clone(c.initialPairs[1])))), /initialPairs/);
  assert.throws(edit((c) => (c.tokens = Array.from({ length: 9 }, (_, i) => ({ ...clone(c.tokens[0]), symbol: `T${i}X`, address: viem.getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`) })))), /tokens/);
});

/** A stand-in chain for readMarket: two feeds and one pool per pair, each answering only for its own pair. */
function marketWorld(chain) {
  const abi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)", "function getPool(address,address,uint24) view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function liquidity() view returns (uint128)", "function observe(uint32[]) view returns (int56[],uint160[])", "function balanceOf(address) view returns (uint256)"]);
  const code = (label) => toHex(`code:${label}`);
  const rules = chain.initialPairs.map((p, i) => (i === 0 ? chain.openingPrice : p.openingPrice));
  for (const rule of rules) {
    rule.references[0].base.codeHash = rule.references[0].quote.codeHash = keccak256(code("feed"));
    rule.references[1].factoryCodeHash = keccak256(code("factory"));
    rule.references[1].poolCodeHash = keccak256(code("pool"));
  }
  const now = 1_795_040_000n;
  const at = { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${now.toString(16)}` };
  // Per token: its USD answer (8 decimals) and its pool's mean tick, as the tick of TOKEN base units per wei (the
  // pool reports it with that sign when the wrapped token is its token0, and negated otherwise). The native coin
  // is 1,820 USD against a token of 6 decimals (1.82e-9 units per wei: tick -201,260) and 580 USD against one of
  // 18 decimals (BNB Smart Chain; 580 units per wei: tick +63,632).
  const sixDecimals = chain.tokens[0].decimals === 6;
  const nativeUsd = sixDecimals ? 182_000_000_000n : 58_000_000_000n;
  const facts = new Map(chain.tokens.map((t, i) => [lower(t.address), { usd: i === 0 ? 100_000_000n : 99_900_000n, tick: (sixDecimals ? -201_260n : 63_632n) + (i === 0 ? 0n : 10n), rule: rules[i], token: t }]));
  const asked = [];
  const endpoint = (over = {}) => async (method, params) => {
    if (over.refuse) throw new Error(`${method} returned HTTP 403`);
    const to = lower(params[0].to ?? params[0]);
    asked.push(to);
    const factory = lower(rules[0].references[1].factory);
    const poolOf = [...facts.values()].find((f) => lower(f.rule.references[1].pool) === to);
    const quoteOf = [...facts.values()].find((f) => lower(f.rule.references[0].quote.proxy) === to);
    if (method === "eth_getCode") return to === factory ? code("factory") : poolOf ? code("pool") : code("feed");
    const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
    const out = (result) => encodeFunctionResult({ abi, functionName, result });
    if (functionName === "latestRoundData") return out([1n, quoteOf ? (over.usd ?? quoteOf.usd) : nativeUsd, 0n, now - 60n, 1n]);
    if (functionName === "decimals") return out(8);
    if (functionName === "description") return out(quoteOf ? quoteOf.rule.references[0].quote.description : rules[0].references[0].base.description);
    if (functionName === "getPool") return out(facts.get(lower(args[0]) === lower(chain.wrappedNative.address) ? lower(args[1]) : lower(args[0]))?.rule.references[1].pool ?? ZERO_ADDRESS);
    const sorted = (f) => [f.token.address, chain.wrappedNative.address].sort((x, y) => (lower(x) < lower(y) ? -1 : 1));
    if (functionName === "token0") return out(sorted(poolOf)[0]);
    if (functionName === "token1") return out(sorted(poolOf)[1]);
    if (functionName === "liquidity") return out(5n);
    if (functionName === "balanceOf") return out(100_000n * 10n ** 18n);
    if (functionName === "observe") {
      const wrappedIs0 = lower(sorted(poolOf)[0]) === lower(chain.wrappedNative.address);
      return out([[0n, (wrappedIs0 ? poolOf.tick : -poolOf.tick) * BigInt(args[0][0])], [0n, 0n]]);
    }
    throw new Error(`unexpected ${functionName}`);
  };
  return { at, endpoint, asked, rules };
}

test("B: the market of a pair is read from that pair's own feed and pool, never from another pair's", async () => {
  const chain = clone(chainOf("ethereum"));
  const world = marketWorld(chain);
  const [usdc, usdt] = chain.tokens;
  const first = await readMarket({ chain, token: usdc, requests: [world.endpoint(), world.endpoint()], at: world.at });
  assert.equal(first.ok, true, first.problems.join());
  assert.equal(first.references[0].price, 1_820_000_000n);
  world.asked.length = 0;
  const second = await readMarket({ chain, token: usdt, requests: [world.endpoint(), world.endpoint()], at: world.at });
  assert.equal(second.ok, true, second.problems.join());
  // 1820 USD over 0.999 USD: the USDT feed's answer, not the USDC feed's.
  assert.equal(second.references[0].price, (182_000_000_000n * 10n ** 8n * 10n ** 6n) / (99_900_000n * 10n ** 8n));
  assert.deepEqual(second.references.map((r) => r.name), ["Chainlink ETH / USD over USDT / USD", "Uniswap v3 WETH/USDT 0.05% pool, 5-minute mean"]);
  // Nothing of the first pair was read for the second.
  const firstOnly = [world.rules[0].references[0].quote.proxy, world.rules[0].references[1].pool].map(lower);
  assert.ok(world.asked.length > 10 && world.asked.every((a) => !firstOnly.includes(a)), "the USDC feed and the USDC pool are not asked for the USDT market");
  // A rule that names another pair's pool is refused by the chain itself: the factory does not name it for this token.
  const crossed = clone(chain);
  crossed.initialPairs[1].openingPrice.references[1].pool = chain.openingPrice.references[1].pool;
  const bad = await readMarket({ chain: crossed, token: crossed.tokens[1], requests: [world.endpoint(), world.endpoint()], at: world.at });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /is not the one the factory .* names for WETH, USDT and fee 500/);
  // The token off its peg by more than the band: the two references part and there is no price.
  const offPeg = await readMarket({ chain, token: usdt, requests: [world.endpoint({ usd: 97_000_000n }), world.endpoint({ usd: 97_000_000n })], at: world.at });
  assert.equal(offPeg.ok, false);
  assert.match(offPeg.problems.join(), /more than the 1% within which they must agree/);
  // A token without a planned pair has no market at all.
  await assert.rejects(() => readMarket({ chain, token: { ...usdt, symbol: "DAI" }, requests: [world.endpoint()], at: world.at }), /is not a planned pair/);
});

// ---------------------------------------------------------------------------------------------------------------
// F. F409-1: two agreeing endpoints of the reviewed ones.
// ---------------------------------------------------------------------------------------------------------------

test("F409-1: a market price needs two endpoints that answer and agree; an endpoint that refuses is not counted, one that differs stops everything", async () => {
  const chain = clone(chainOf("bnb-smart-chain"));
  const world = marketWorld(chain);
  const token = chain.tokens[1];
  const read = (...endpoints) => readMarket({ chain, token, requests: endpoints, at: world.at });
  const [good, refusing] = [world.endpoint(), world.endpoint({ refuse: true })];
  // BNB Smart Chain as it is today: the second of four reviewed endpoints refuses eth_call (HTTP 403).
  const today = await read(good, refusing, good, good);
  assert.equal(today.ok, true, today.problems.join());
  // Before round 20 the first two endpoints were asked and both had to answer: that case still gives no price
  // when they are ALL there is (a chain with two reviewed endpoints is exactly as strict as it was).
  const twoOnly = await read(good, refusing);
  assert.equal(twoOnly.ok, false);
  assert.match(twoOnly.problems.join(), /1 endpoint answered, 2 must agree/);
  // One endpoint's word is never a price, however many refuse.
  assert.equal((await read(good, refusing, refusing, refusing)).ok, false);
  // An endpoint that answers DIFFERENTLY is a disagreement even when two others agree: nothing is decided.
  const lying = await read(good, refusing, good, world.endpoint({ usd: 99_000_000n }));
  assert.equal(lying.ok, false);
  assert.match(lying.problems.join(), /DISAGREEMENT: the endpoints give different answers/);
  // A loopback rehearsal gives one endpoint and is read from it.
  assert.equal((await read(good)).ok, true);
});

test("F409-1: an endpoint that refuses a method by policy is still asked every time, without the pauses; anything else is retried as before", async () => {
  let calls = 0;
  let refuse = true;
  const endpoint = retrying(async (method) => {
    calls++;
    if (refuse) throw new Error(`${method} returned HTTP 403`);
    return "0x1";
  }, { delayMs: 1 });
  await assert.rejects(() => endpoint("eth_call", []), /HTTP 403/);
  assert.equal(calls, 3, "the first refusal is tried three times");
  await assert.rejects(() => endpoint("eth_call", []), /HTTP 403/);
  await assert.rejects(() => endpoint("eth_call", []), /HTTP 403/);
  assert.equal(calls, 5, "each later call asks once");
  // Another method of the same endpoint is not prejudged.
  await assert.rejects(() => endpoint("eth_getCode", []), /HTTP 403/);
  assert.equal(calls, 8);
  // The endpoint serves the method again: its answer is used at once, and a later failure is retried in full.
  refuse = false;
  assert.equal(await endpoint("eth_call", []), "0x1");
  refuse = true;
  calls = 0;
  await assert.rejects(() => endpoint("eth_call", []), /HTTP 403/);
  assert.equal(calls, 3);
  // A rate limit or a dropped connection never shortens the tries.
  calls = 0;
  const limited = retrying(async () => { calls++; throw new Error("eth_call returned HTTP 429"); }, { delayMs: 1 });
  await assert.rejects(() => limited("eth_call", []), /429/);
  await assert.rejects(() => limited("eth_call", []), /429/);
  assert.equal(calls, 6);
});

// ---------------------------------------------------------------------------------------------------------------
// C. What the code hash does not show.
// ---------------------------------------------------------------------------------------------------------------

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const revert = () => { throw new Error("execution reverted"); };
/** `getters`: name -> bigint | "revert" | "empty" | "junk" | "down". */
const getterCall = (getters) => async (_to, data) => {
  const name = Object.keys(getters).find((g) => toFunctionSelector(`${g}()`) === data.slice(0, 10)) ?? Object.keys(getters).find((g) => /\(/.test(g) && toFunctionSelector(g) === data.slice(0, 10));
  const value = name === undefined ? "revert" : getters[name];
  if (value === "revert") return revert();
  if (value === "empty") return "0x";
  if (value === "junk") return "0x1234";
  if (value === "down") throw new Error("multichain: eth_call at block 0xab: 1 endpoint answered, 2 must agree (3 failed: try again later)");
  return word(value);
};

test("C: the committed tokens state their behaviour from their code: only Tether's contract on Ethereum returns no value, needs zero first and has fee parameters", () => {
  for (const chain of committedChains) {
    assert.equal(chain.tokens[0].behaviour, undefined, `${chain.chain.key}: USDC is listed as it was`);
    assert.equal(chain.wrappedNative.behaviour, undefined);
  }
  const eth = chainOf("ethereum").tokens[1];
  assert.deepEqual([eth.address, eth.symbol, eth.name, eth.decimals, eth.label], ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "Tether USD", 6, undefined]);
  assert.deepEqual([eth.behaviour.returnsNoValue, eth.behaviour.approveZeroFirst, eth.behaviour.transferFee, eth.behaviour.switches, eth.behaviour.blocklist], [true, true, { parameters: ["basisPointsRate", "maximumFee"] }, ["paused", "deprecated"], "isBlackListed"]);
  assert.match(eth.kind, /^Tether-issued/);
  assert.equal(eth.source, "https://tether.to/en/supported-protocols/");
  const op = chainOf("op-mainnet").tokens[1];
  assert.deepEqual([op.symbol, op.label, op.decimals], ["USDT", "USDT (bridged)", 6]);
  assert.match(op.kind, /^NOT Tether-issued here: Tether USD bridged from Ethereum/);
  assert.match(op.note, /Tether does not issue it here/);
  const arb = chainOf("arbitrum-one").tokens[1];
  assert.deepEqual([arb.symbol, arb.chainSymbol, arb.name, arb.label, arb.decimals, chainSymbolOf(arb)], ["USDT0", "USD₮0", "USD₮0", "USD₮0", 6, "USD₮0"]);
  assert.match(arb.note, /not the USDT contract of Ethereum/);
  assert.equal(arb.behaviour.blocklist, "isBlocked");
  const bnb = chainOf("bnb-smart-chain").tokens[1];
  assert.deepEqual([bnb.symbol, bnb.label, bnb.decimals], ["USDT", "USDT (Binance-Peg)", 18]);
  assert.match(bnb.kind, /^NOT Tether-issued: Binance-Peg/);
  assert.match(bnb.note, /issued by Binance.*not by Tether.*18 decimals/);
  for (const token of [op, arb, bnb]) assert.deepEqual([token.behaviour.returnsNoValue, token.behaviour.approveZeroFirst, token.behaviour.transferFee, token.behaviour.switches], [false, false, null, []], token.label);
  for (const key of Object.keys(SECOND)) {
    const token = chainOf(key).tokens[1];
    // Every address was compared with a page of the issuer or of the chain, fetched on the date stated.
    assert.equal(token.sourceChecked.url, token.source);
    assert.equal(token.sourceChecked.fetched, "2026-11-18");
    assert.ok(token.sourceChecked.found.length > 40 && token.behaviour.issuerPowers.length >= 40 && token.behaviour.checked.how.length >= 40);
    // A token that is not the issuer's own is never shown under its bare symbol.
    assert.equal(token.label === undefined, key === "ethereum", key);
    assert.equal(/^NOT |^USD₮0/.test(token.kind), key !== "ethereum", key);
  }
  // The page's network file: the contract's own symbol, the label, and the approve mode of the one token that needs it.
  const network = (key) => frontendNetwork(committed, chainOf(key)).tokens[1];
  assert.deepEqual([network("ethereum").symbol, network("ethereum").label, network("ethereum").approve], ["USDT", undefined, "zero-first"]);
  assert.deepEqual([network("arbitrum-one").symbol, network("arbitrum-one").label, network("arbitrum-one").approve], ["USD₮0", "USD₮0", undefined]);
  assert.deepEqual([network("op-mainnet").label, network("bnb-smart-chain").label, network("bnb-smart-chain").decimals], ["USDT (bridged)", "USDT (Binance-Peg)", 18]);
  for (const key of committed.chains) assert.equal(frontendNetwork(committed, chainOf(key)).tokens[0].approve, undefined);
});

test("C: a behaviour block and a chain symbol are validated strictly", () => {
  const edit = (key, change) => {
    const c = clone(chainOf(key));
    change(c.tokens[1], c);
    return () => validateChain(c, key);
  };
  assert.throws(edit("ethereum", (t) => delete t.behaviour.approveZeroFirst), /returnsNoValue and approveZeroFirst are stated/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.transferFee = { parameters: ["feeRate"] })), /transferFee is null/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.transferFee = { parameters: [] })), /transferFee is null/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.switches = ["frozen"])), /switches is a list of paused, deprecated/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.blocklist = "banned")), /blocklist is null or one of/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.issuerPowers = "none")), /issuerPowers/);
  assert.throws(edit("ethereum", (t) => delete t.behaviour.checked), /checked/);
  assert.throws(edit("ethereum", (t) => (t.behaviour.feeOnTransfer = false)), /unknown field/);
  // The contract's own symbol, when it is not the key, comes with a label that begins with it.
  assert.throws(edit("arbitrum-one", (t) => (t.chainSymbol = "USDT0")), /given only when it differs from symbol/);
  assert.throws(edit("arbitrum-one", (t) => (t.chainSymbol = "USD T0")), /chainSymbol/);
  assert.throws(edit("arbitrum-one", (t) => { delete t.label; delete t.note; }), /needs a label and a note/);
  assert.throws(edit("arbitrum-one", (t) => (t.label = "USDT0")), /label/);
  assert.throws(edit("op-mainnet", (t) => (t.label = "Tether")), /label/);
  // The key stays plain: the owner types it on a command line.
  assert.throws(edit("arbitrum-one", (t, c) => { t.symbol = "USD₮0"; c.initialPairs[1].tokenB = "USD₮0"; }), /symbol/);
});

test("C: a fee parameter that is not zero, an undeclared or missing one, a switch that is on and an answer that cannot be read all fail; absent is not zero", async () => {
  const tether = chainOf("ethereum").tokens[1];
  const plain = chainOf("op-mainnet").tokens[1];
  const off = { basisPointsRate: 0n, maximumFee: 0n, paused: 0n, deprecated: 0n };
  const ok = await tokenBehaviourState(getterCall(off), tether);
  assert.deepEqual([ok.ok, ok.read], [true, { basisPointsRate: "0", maximumFee: "0", paused: "0", deprecated: "0" }]);
  const expectProblem = async (getters, token, pattern) => {
    const r = await tokenBehaviourState(getterCall(getters), token);
    assert.equal(r.ok, false, Object.keys(getters).join());
    assert.match(r.problems.join(" | "), pattern);
  };
  // The issuer switches the fee on: 10 basis points, capped at 10 USDT.
  await expectProblem({ ...off, basisPointsRate: 10n, maximumFee: 10_000_000n }, tether, /basisPointsRate\(\) is 10, not zero: the issuer has switched on a fee on every transfer.*maximumFee\(\) is 10000000, not zero/);
  await expectProblem({ ...off, maximumFee: 1n }, tether, /maximumFee\(\) is 1, not zero/);
  await expectProblem({ ...off, paused: 1n }, tether, /paused\(\) is true: the issuer has stopped every transfer/);
  await expectProblem({ ...off, deprecated: 1n }, tether, /deprecated\(\) is true: the issuer has replaced this contract/);
  // The reviewed token answers these getters; one that does not is not that token.
  await expectProblem({ ...off, basisPointsRate: "revert" }, tether, /declares the fee parameter basisPointsRate\(\) and the contract does not answer it/);
  await expectProblem({ ...off, paused: "revert" }, tether, /declares the switch paused\(\) and the contract does not answer it/);
  // A token that declares none and answers one (an upgrade of a proxy added it, or the review missed it).
  await expectProblem({ basisPointsRate: 0n }, plain, /answers basisPointsRate\(\) \(0\), a transfer-fee parameter its configuration does not declare/);
  await expectProblem({ maximumFee: 5n }, chainOf("ethereum").tokens[0], /maximumFee\(\) \(5\).*does not declare/);
  // Unreadable is not absent, and a malformed answer is not zero.
  await expectProblem({ ...off, maximumFee: "down" }, tether, /maximumFee\(\) could not be read/);
  await expectProblem({ ...off, basisPointsRate: "junk" }, tether, /basisPointsRate\(\) answered 0x1234, not one word/);
  // Absent: a revert, or nothing at all (a wrapper's fallback).
  for (const absent of ["revert", "empty"]) {
    const r = await tokenBehaviourState(getterCall({ basisPointsRate: absent, maximumFee: absent }), plain);
    assert.deepEqual([r.ok, r.read], [true, { basisPointsRate: "absent", maximumFee: "absent" }]);
  }
  assert.deepEqual(await readGetter(getterCall({ paused: 1n }), ZERO_ADDRESS, "paused"), { present: true, value: 1n });
  // The issuer's blocklist, for the addresses a deposit touches.
  const blocked = (flag) => async () => word(flag);
  const names = { "the pair": `0x${"11".repeat(20)}`, "the router": `0x${"22".repeat(20)}` };
  assert.deepEqual(await blocklistState(blocked(0), tether, names), { ok: true, problems: [], read: { "the pair": false, "the router": false } });
  const listed = await blocklistState(blocked(1), tether, names);
  assert.equal(listed.ok, false);
  assert.match(listed.problems.join(), /the pair 0x1111.* is on the issuer's blocklist of USDT \(isBlackListed\)/);
  assert.equal((await blocklistState(async () => revert(), tether, names)).ok, false, "a blocklist that cannot be read is not a clean one");
  assert.deepEqual(await blocklistState(blocked(1), plain, names), { ok: true, problems: [], read: {} }, "a token without a declared blocklist is asked nothing");
});

/** A stand-in node for the gate with every planned pair of `chain`; `pairStates` and `getters` by token symbol. */
function gateWorld({ chain, local, plan, pairStates = {}, openings = {}, getters = {}, blocked = false, finalizedHasCode = true }) {
  const abi = parseAbi([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)",
    "function feeTo() view returns (address)", "function firstDepositor() view returns (address)", "function reserveCap(address) view returns (uint256)", "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
    "function getPair(address,address) view returns (address)", "function factory() view returns (address)", "function WBLCH() view returns (address)", "function token0() view returns (address)",
    "function token1() view returns (address)", "function reserveCaps() view returns (uint112,uint112)", "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint112,uint112,uint32)",
    "function balanceOf(address) view returns (uint256)", "function isBlackListed(address) view returns (bool)", "function isBlocked(address) view returns (bool)",
  ]);
  const code = (label) => toHex(`code:${label}`);
  const padded = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const runtime = {
    [lower(plan.contracts.factory.address)]: linkImmutables(artifacts.factory, [padded(local.feeTo.address), padded(plan.arguments.firstDepositor)], "factory"),
    [lower(plan.contracts.router.address)]: linkImmutables(artifacts.router, [padded(plan.contracts.factory.address), padded(chain.wrappedNative.address)], "router"),
    [lower(plan.contracts.lens.address)]: linkImmutables(artifacts.lens, [padded(plan.contracts.factory.address)], "lens"),
  };
  const tokens = [chain.wrappedNative, ...chain.tokens];
  const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.multicall3.address), code("multicall")], ...tokens.map((t) => [lower(t.address), code(`token:${t.symbol}`)])]);
  const pairs = new Map(plan.pairs.map((p) => [lower(p.address), { ...p, name: `${p.tokenA}/${p.tokenB}`, state: pairStates[`${p.tokenA}/${p.tokenB}`] ?? "absent" }]));
  const receipts = new Map(Object.values(openings).map((o) => [o.hash, o]));
  return async (method, params) => {
    if (method === "eth_chainId") return `0x${chain.chain.chainId.toString(16)}`;
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
    if (method === "eth_getTransactionCount") return "0x2";
    if (method === "eth_getTransactionByHash") return receipts.get(params[0])?.tx ?? null;
    if (method === "eth_getTransactionReceipt") return receipts.get(params[0])?.receipt ?? null;
    if (method === "eth_getCode") {
      const address = lower(params[0]);
      if (runtime[address]) return finalizedHasCode || params[1] === "latest" ? runtime[address] : "0x";
      if (pairs.has(address)) return pairs.get(address).state === "absent" ? "0x" : artifacts.pair.deployedBytecode;
      return codes.get(address) ?? "0x";
    }
    if (method === "eth_call") {
      const to = lower(params[0].to);
      const token = tokens.find((t) => lower(t.address) === to);
      const selector = params[0].data.slice(0, 10);
      // The token's own getters first (fee parameters, switches), then the functions every contract here has.
      if (token) {
        const own = getters[token.symbol] ?? {};
        const name = Object.keys(own).find((g) => toFunctionSelector(`${g}()`) === selector);
        if (name) return own[name] === "revert" ? revert() : word(own[name]);
      }
      if (!abi.some((f) => toFunctionSelector(f) === selector)) return revert();
      const { functionName: fn, args } = decodeFunctionData({ abi, data: params[0].data });
      const out = (result) => encodeFunctionResult({ abi, functionName: fn, result });
      const pair = pairs.get(to);
      if (fn === "isBlackListed" || fn === "isBlocked") return token?.behaviour?.blocklist === fn ? out(blocked) : revert();
      if (fn === "balanceOf") {
        const holder = pairs.get(lower(args[0]));
        return out(holder?.state === "donated" ? 5n : holder?.state === "open" ? 1000n : 0n);
      }
      if (token) return out(fn === "decimals" ? token.decimals : fn === "symbol" ? chainSymbolOf(token) : token[fn]);
      if (fn === "getChainId") return out(BigInt(chain.chain.chainId));
      if (fn === "feeTo") return out(local.feeTo.address);
      if (fn === "firstDepositor") return out(plan.arguments.firstDepositor);
      if (fn === "reserveCap") return out(0n);
      if (fn === "INIT_CODE_PAIR_HASH") return out(plan.pair.initCodeHash);
      if (fn === "getPair") {
        const wanted = [...pairs.values()].find((p) => lower(p.token0) === lower(args[0]) && lower(p.token1) === lower(args[1]));
        return out(wanted && wanted.state !== "absent" ? wanted.address : ZERO_ADDRESS);
      }
      if (fn === "factory") return out(plan.contracts.factory.address);
      if (fn === "WBLCH") return out(chain.wrappedNative.address);
      if (fn === "token0") return out(pair.token0);
      if (fn === "token1") return out(pair.token1);
      if (fn === "reserveCaps") return out([0n, 0n]);
      if (fn === "totalSupply") return out(pair.state === "open" ? 10n ** 12n : 0n);
      if (fn === "getReserves") return out(pair.state === "open" ? [1000n, 1000n, 1] : [0n, 0n, 0]);
    }
    throw new Error(`unexpected ${method}`);
  };
}
/** The committed configuration of `key` with stand-in code hashes (the gate compares hashes). */
function pinnedLocal(key) {
  const chain = clone(chainOf(key));
  const local = clone(committed);
  const code = (label) => toHex(`code:${label}`);
  local.create2.deployerCodeHash = keccak256(code("deployer"));
  chain.multicall3.codeHash = keccak256(code("multicall"));
  for (const t of [chain.wrappedNative, ...chain.tokens]) t.codeHash = keccak256(code(`token:${t.symbol}`));
  return { chain, local, plan: planChain(local, chain, artifacts) };
}
const TETHER_OFF = { USDT: { basisPointsRate: 0n, maximumFee: 0n, paused: 0n, deprecated: 0n } };
/** The opening transaction of `pair` as a node serves it: sent by the depositor straight to the router, strict. */
function openingOf({ plan, chain, pair, digit }) {
  const token = chain.tokens.find((t) => [lower(pair.token0), lower(pair.token1)].includes(lower(t.address)));
  const wrappedIs0 = lower(pair.token0) === lower(chain.wrappedNative.address);
  const [native, amount] = [10n ** 19n, 30_000n * 10n ** BigInt(token.decimals)];
  const hash = `0x${digit.repeat(64)}`;
  const topic = (address) => `0x${"0".repeat(24)}${lower(address).slice(2)}`;
  const data = (a, b) => `0x${a.toString(16).padStart(64, "0")}${b.toString(16).padStart(64, "0")}`;
  const tx = { hash, from: plan.arguments.firstDepositor, to: plan.contracts.router.address, value: `0x${native.toString(16)}`, blockNumber: "0x60", blockHash: `0x${"ab".repeat(32)}`, input: encodeFunctionData({ abi: ROUTER_DEPOSIT_ABI, functionName: "addLiquidityBLCH", args: [token.address, amount, amount, native, plan.arguments.firstDepositor, 2_000_000_000n] }) };
  const receipt = { transactionHash: hash, status: "0x1", from: tx.from, to: tx.to, blockNumber: tx.blockNumber, blockHash: tx.blockHash, logs: [
    { address: pair.address, topics: [TRANSFER_TOPIC, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`], data: `0x${(1000n).toString(16).padStart(64, "0")}`, logIndex: "0x0" },
    { address: pair.address, topics: [MINT_TOPIC, topic(plan.contracts.router.address)], data: wrappedIs0 ? data(native, amount) : data(amount, native), logIndex: "0x1" },
  ] };
  return { hash, tx, receipt };
}

test("C: the gate fails while a listed token's fee is switched on, its pause or deprecation is on, or its declaration does not fit its code; it passes when all is off", async () => {
  const { chain, local, plan } = pinnedLocal("ethereum");
  const gate = (getters, phase = "pre") => evaluateGate({ shared: local, chain, plan, phase, request: gateWorld({ chain, local, plan, getters }), rehearsal: true });
  const pass = await gate(TETHER_OFF);
  assert.equal(pass.decision, "pass", JSON.stringify(pass.failed));
  assert.deepEqual(pass.tokenStates, { WETH: { basisPointsRate: "absent", maximumFee: "absent" }, USDC: { basisPointsRate: "absent", maximumFee: "absent" }, USDT: { basisPointsRate: "0", maximumFee: "0", paused: "0", deprecated: "0" } });
  const NAME = /USDT takes no fee on transfer: it has no fee parameter, or its declared ones are zero; none of its declared switches is on/;
  for (const [over, why] of [
    [{ basisPointsRate: 10n }, /basisPointsRate\(\) is 10, not zero/],
    [{ maximumFee: 49_000_000n }, /maximumFee\(\) is 49000000, not zero/],
    [{ paused: 1n }, /paused\(\) is true/],
    [{ deprecated: 1n }, /deprecated\(\) is true/],
    [{ maximumFee: "revert" }, /does not answer it: this is not the token that was reviewed/],
  ]) {
    for (const phase of ["pre", "post"]) {
      const report = await gate({ USDT: { ...TETHER_OFF.USDT, ...over } }, phase);
      assert.equal(report.decision, "fail");
      assert.ok(report.failed.some((f) => NAME.test(f)), `${phase}: ${JSON.stringify(report.failed)}`);
      assert.match(JSON.stringify(report.checks.find((c) => NAME.test(c.name)).detail), why);
    }
  }
  // A token that declares nothing (USDC, the wrapper) and answers a fee getter fails the gate as well.
  const grown = await gate({ ...TETHER_OFF, USDC: { basisPointsRate: 0n } });
  assert.equal(grown.decision, "fail");
  assert.match(JSON.stringify(grown.checks.find((c) => /^USDC takes no fee/.test(c.name)).detail), /does not declare/);
  // The contract's own symbol is what is pinned: Arbitrum One's "USD₮0" under the key USDT0.
  const arb = pinnedLocal("arbitrum-one");
  const arbGate = await evaluateGate({ shared: arb.local, chain: arb.chain, plan: arb.plan, phase: "pre", request: gateWorld(arb), rehearsal: true });
  assert.equal(arbGate.decision, "pass", JSON.stringify(arbGate.failed));
  arb.chain.tokens[1].chainSymbol = "USDT0x";
  const wrongSymbol = await evaluateGate({ shared: arb.local, chain: arb.chain, plan: arb.plan, phase: "pre", request: gateWorld({ ...arb, chain: clone(chainOfPinned(arb.chain)) }), rehearsal: true });
  assert.match(wrongSymbol.failed.join(), /USDT0 answers the listed name, symbol and decimals/);
  // The committed gate configuration names the behaviour and the later pair's rule.
  const config = gateConfig(committed, chainOf("ethereum"));
  assert.deepEqual(config.pins.tokens[1].behaviour, { returnsNoValue: true, approveZeroFirst: true, transferFee: { parameters: ["basisPointsRate", "maximumFee"] }, switches: ["paused", "deprecated"], blocklist: "isBlackListed" });
  assert.deepEqual(Object.keys(config.ownerChoices.openingPrices), ["WETH/USDT"]);
  assert.deepEqual(config.ownerChoices.openingPrice, chainOf("ethereum").openingPrice);
  assert.deepEqual(gateConfig(committed, chainOf("arbitrum-one")).pins.tokens[1].chainSymbol, "USD₮0");
});
/** The node of the test above answers with the configuration it was built from: a copy whose symbol is the real one. */
function chainOfPinned(chain) {
  const real = clone(chain);
  real.tokens[1].chainSymbol = "USD₮0";
  return real;
}

// ---------------------------------------------------------------------------------------------------------------
// D. Tether's approve.
// ---------------------------------------------------------------------------------------------------------------

test("D: the approve sequence follows the allowance that stands; the deposit is never changed and no other token is touched", () => {
  const steps = (zeroFirst, allowance, amount) => approvalSteps({ zeroFirst, allowance, amount }).map((s) => `${s.step}:${s.amount}`);
  // A token that needs zero first (Tether on Ethereum).
  assert.deepEqual(steps(true, 0n, 500n), ["approve:500"]);
  assert.deepEqual(steps(true, 500n, 500n), [], "the allowance already is the amount: a second approve would revert, none is sent");
  assert.deepEqual(steps(true, 499n, 500n), ["approve-zero:0", "approve:500"]);
  assert.deepEqual(steps(true, 2n ** 256n - 1n, 500n), ["approve-zero:0", "approve:500"]);
  // Every other token: the one approve it always got, whatever stands.
  for (const allowance of [0n, 499n, 500n, 10n ** 30n]) assert.deepEqual(steps(false, allowance, 500n), ["approve:500"]);

  const router = "0x8A1DdC0BAE18A038D4E5Bb088eeDcdE10b61db53";
  const token = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const to = "0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3";
  const opening = openingTransactions({ router, token, native: 10n ** 18n, tokenAmount: 1_764_000_000n, to, deadline: 1_795_041_200n });
  const approveData = (amount) => encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [router, amount] });
  const stale = withApprovals({ transactions: opening, router, zeroFirst: true, allowance: 1_700_000_000n });
  assert.deepEqual(stale.map((t) => [t.step, t.to, t.args.join(" ")]), [["approve-zero", token, `${router} 0`], ["approve", token, `${router} 1764000000`], ["deposit", router, opening[1].args.join(" ")]]);
  assert.deepEqual([stale[0].data, stale[1].data], [approveData(0n), approveData(1_764_000_000n)]);
  assert.equal(stale[2], opening[1], "the deposit is the same object: amounts and minimums untouched");
  assert.deepEqual(withApprovals({ transactions: opening, router, zeroFirst: true, allowance: 1_764_000_000n }).map((t) => t.step), ["deposit"]);
  assert.deepEqual(withApprovals({ transactions: opening, router, zeroFirst: true, allowance: 0n }), opening);
  // A token without the flag: byte for byte what was printed before round 20, whatever the allowance.
  for (const allowance of [0n, 5n, 1_764_000_000n]) assert.deepEqual(withApprovals({ transactions: opening, router, zeroFirst: false, allowance }), opening);
  // A later deposit (add) is treated the same way.
  const later = addTransactions({ router, token, native: 10n ** 18n, expectedToken: 1_764_000_000n, reserveNative: 10n ** 19n, reserveToken: 17_640_000_000n, toleranceBps: 50, to, deadline: 1_795_041_200n });
  assert.deepEqual(withApprovals({ transactions: later, router, zeroFirst: true, allowance: 7n }).map((t) => t.step), ["approve-zero", "approve", "deposit"]);
  assert.throws(() => withApprovals({ transactions: [opening[1]], router, zeroFirst: true, allowance: 0n }), /one approve and one deposit/);
  // The tool says so to the owner, and never tells him to approve by hand.
  const source = readFileSync(join(ROOT, "scripts/multichain/first-deposit.mjs"), "utf8");
  assert.match(source, /Do not send an approve by hand/);
  assert.match(source, /the first line sets it to zero and the second sets the new amount/);
});

// ---------------------------------------------------------------------------------------------------------------
// E. Pairs open one at a time.
// ---------------------------------------------------------------------------------------------------------------

test("E: the record lists exactly the pairs the gate reports open with their opening proven; a planned pair that is not open is named, never listed", async () => {
  const { chain, local, plan } = pinnedLocal("ethereum");
  const [usdc, usdt] = plan.pairs;
  const names = ["WETH/USDC", "WETH/USDT"];
  const opened = { [names[0]]: openingOf({ plan, chain, pair: usdc, digit: "1" }), [names[1]]: openingOf({ plan, chain, pair: usdt, digit: "2" }) };
  const gate = (pairStates, hashes = names) => evaluateGate({ shared: local, chain, plan, phase: "post", request: gateWorld({ chain, local, plan, getters: TETHER_OFF, pairStates, openings: opened }), rehearsal: true, openings: Object.fromEntries(hashes.map((n) => [n, opened[n].hash])) });
  const record = (report) => frontendRecord(local, chain, report, { rehearsal: true });

  // 1. Nothing open: the refusals of before round 20, word for word.
  const [nothing, bothEmpty, oneDonated] = [await gate({}), await gate({ [names[0]]: "empty", [names[1]]: "empty" }), await gate({ [names[0]]: "donated" })];
  for (const report of [nothing, bothEmpty, oneDonated]) assert.equal(report.decision, "pass", JSON.stringify(report.failed));
  assert.throws(() => record(nothing), /does not show every planned pair created/);
  assert.throws(() => record(bothEmpty), /a planned pair that is not open yet/);
  assert.throws(() => record(oneDonated), /does not show every planned pair created/);

  // 2. The first pool open and proven, the second in each of its three unopened states: the chain is live with
  //    one pair, and the other is named with its state.
  for (const state of ["absent", "empty", "donated"]) {
    const report = await gate({ [names[0]]: "open", ...(state === "absent" ? {} : { [names[1]]: state }) });
    assert.equal(report.decision, "pass", JSON.stringify(report.failed));
    assert.deepEqual(report.pairs.map((p) => p.state), ["open", state]);
    const r = record(report);
    assert.equal(r.status, "deployed");
    assert.deepEqual(r.pairs, [{ address: lower(usdc.address), token0: lower(usdc.token0), token1: lower(usdc.token1) }]);
    assert.deepEqual(r.notOpen, [{ address: lower(usdt.address), token0: lower(usdt.token0), token1: lower(usdt.token1), state }]);
  }

  // 3. Both open and proven: both listed, and the record has no `notOpen` key at all.
  const both = await gate({ [names[0]]: "open", [names[1]]: "open" });
  assert.equal(both.decision, "pass", JSON.stringify(both.failed));
  const full = record(both);
  assert.deepEqual(full.pairs.map((p) => p.address), [lower(usdc.address), lower(usdt.address)]);
  assert.equal("notOpen" in full, false);
  assert.deepEqual(both.pairs.map((p) => p.opening.transaction), [opened[names[0]].hash, opened[names[1]].hash]);

  // 4. The second pool open but NOT proven: the gate fails, and no record is written, not even for the first pair.
  const unproven = await gate({ [names[0]]: "open", [names[1]]: "open" }, [names[0]]);
  assert.equal(unproven.decision, "fail");
  assert.match(unproven.failed.join(), /pair WETH\/USDT is open: its opening is proven by its transaction/);
  assert.throws(() => record(unproven), /not a passed post gate/);
  // The same report edited to "pass": still no record, because an open pair is not proven.
  const edited = clone(unproven);
  Object.assign(edited, { decision: "pass", failed: [] });
  assert.throws(() => record(edited), /does not prove who opened each pool/);
  // And the first pair's opening hash given for the second proves nothing.
  const crossed = await evaluateGate({ shared: local, chain, plan, phase: "post", request: gateWorld({ chain, local, plan, getters: TETHER_OFF, pairStates: { [names[0]]: "open", [names[1]]: "open" }, openings: opened }), rehearsal: true, openings: { [names[0]]: opened[names[0]].hash, [names[1]]: opened[names[0]].hash } });
  assert.equal(crossed.decision, "fail");
  assert.match(JSON.stringify(crossed.pairs[1].opening.problems), /it deposits the token .* not|no lock of the minimum liquidity/);

  // 5. A report with a state this tool does not know writes nothing.
  const odd = clone(await gate({ [names[0]]: "open" }));
  odd.pairs[1].state = "closing";
  assert.throws(() => record(odd), /a state this tool does not know/);

  // 6. The token's issuer blocks the pair's address: the post gate says so (the pool could not pay the token out).
  const blockedReport = await evaluateGate({ shared: local, chain, plan, phase: "post", request: gateWorld({ chain, local, plan, getters: TETHER_OFF, blocked: true }), rehearsal: true });
  assert.equal(blockedReport.decision, "fail");
  assert.match(blockedReport.failed.join(), /the issuer's blocklist of USDT names neither the pair WETH\/USDT nor the router/);
});

test("E: a chain with one planned pair writes the record it always wrote", async () => {
  const { chain, local, plan } = pinnedLocal("base");
  const pair = plan.pairs[0];
  const opened = { "WETH/USDC": openingOf({ plan, chain, pair, digit: "3" }) };
  const report = await evaluateGate({ shared: local, chain, plan, phase: "post", request: gateWorld({ chain, local, plan, pairStates: { "WETH/USDC": "open" }, openings: opened }), rehearsal: true, openings: { "WETH/USDC": opened["WETH/USDC"].hash } });
  assert.equal(report.decision, "pass", JSON.stringify(report.failed));
  const record = frontendRecord(local, chain, report, { rehearsal: true });
  // Exactly the keys of a record of round 19.
  assert.deepEqual(Object.keys(record), ["schemaVersion", "domain", "key", "chainId", "status", "rehearsal", "genesisHash", "finalized", "feeTo", "firstDepositor", "factory", "router", "lens", "wrappedNative", "reserveCaps", "pairCodeHash", "pairs"]);
  assert.deepEqual(record.pairs, [{ address: lower(pair.address), token0: lower(pair.token0), token1: lower(pair.token1) }]);
});

// ---------------------------------------------------------------------------------------------------------------
// verify-chain.mjs
// ---------------------------------------------------------------------------------------------------------------

test("verify-chain: the functions a runtime dispatches on are found by walking its code, and compared with the token's declaration", async () => {
  const push4 = (signature) => `63${toFunctionSelector(signature).slice(2)}`;
  // PUSH4 basisPointsRate; PUSH32 whose data holds maximumFee's selector (data, not code); PUSH4 isBlackListed.
  const codeOf = (...parts) => `0x${parts.join("")}`;
  const tether = codeOf(push4("basisPointsRate()"), `7f${toFunctionSelector("maximumFee()").slice(2)}${"00".repeat(28)}`, push4("isBlackListed(address)"), push4("paused()"), push4("deprecated()"), push4("maximumFee()"));
  assert.ok(pushedSelectors(tether).has(toFunctionSelector("basisPointsRate()")));
  assert.equal(pushedSelectors(codeOf(`7f63${toFunctionSelector("maximumFee()").slice(2)}${"00".repeat(27)}`)).size, 0, "bytes inside push data are not instructions");
  const found = functionsIn(tether);
  assert.deepEqual([found.transferFee, found.switches, found.blocklist], [["basisPointsRate()", "maximumFee()"], ["paused()", "deprecated()"], ["isBlackListed(address)"]]);
  const eth = chainOf("ethereum");
  assert.deepEqual(behaviourMismatch(eth.tokens[1], found), []);
  // The same code under a declaration that leaves the fee out, or names another blocklist.
  const silent = clone(eth.tokens[1]);
  silent.behaviour.transferFee = null;
  assert.match(behaviourMismatch(silent, found).join(), /the code has basisPointsRate\(\) and the configuration does not declare it/);
  assert.match(behaviourMismatch({ ...silent, behaviour: { ...eth.tokens[1].behaviour, blocklist: "isBlocked" } }, found).join(), /blocklist getter is isBlackListed and the configuration says isBlocked/);
  // A token without a behaviour block (USDC) whose code has a fee getter is a mismatch too.
  assert.match(behaviourMismatch(eth.tokens[0], found).join(), /the code has basisPointsRate\(\)/);
  assert.deepEqual(behaviourMismatch(eth.tokens[0], functionsIn("0x00")), []);

  // Against a stand-in chain: every listed fact holds, and a token whose fee is on fails the verification.
  const { chain, local, plan } = pinnedLocal("ethereum");
  const market = marketWorld(chain);
  const node = (getters) => {
    const state = gateWorld({ chain, local, plan, getters });
    const prices = market.endpoint();
    const tokenCode = new Map(chain.tokens.map((t) => [lower(t.address), toHex(`code:token:${t.symbol}`)]));
    return async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] !== "0x0") return market.at;
      if (method === "eth_getStorageAt") return word(0);
      const to = lower(params[0]?.to ?? params[0] ?? "");
      const known = [chain.wrappedNative, ...chain.tokens].some((t) => lower(t.address) === to) || to === lower(chain.multicall3.address);
      // The market's balanceOf of the wrapped token is the pool's depth, a price read.
      if (method === "eth_call" && to === lower(chain.wrappedNative.address) && params[0].data.startsWith("0x70a08231")) return prices(method, params);
      if (method === "eth_getCode" && tokenCode.has(to)) return tokenCode.get(to);
      return known || method !== "eth_call" && method !== "eth_getCode" ? state(method, params) : prices(method, params);
    };
  };
  const good = await verifyChain({ chain, requests: [node(TETHER_OFF), node(TETHER_OFF)] });
  // The stand-in token code has no dispatch at all, so the declaration check is the one expected failure; every
  // read fact holds, for both pairs.
  assert.deepEqual(good.failed, ["USDT: its configuration describes the fee parameters, switches and blocklist its code has"]);
  assert.deepEqual(good.markets.map((m) => [m.pair, m.ok]), [["WETH/USDC", true], ["WETH/USDT", true]]);
  assert.deepEqual(good.tokens.map((t) => [t.key, t.symbol, t.decimals]), [["WETH", "WETH", 18], ["USDC", "USDC", 6], ["USDT", "USDT", 6]]);
  const feeOn = await verifyChain({ chain, requests: [node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } }), node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } })] });
  assert.ok(feeOn.failed.includes("USDT takes no fee on transfer and none of its declared switches is on"));
  // Two endpoints that disagree on a token's fee state decide nothing: the read is refused, not averaged.
  const split = await verifyChain({ chain, requests: [node(TETHER_OFF), node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } })] });
  assert.equal(split.decision, "fail");
  assert.match(JSON.stringify(split.checks.find((c) => c.name === "USDT takes no fee on transfer and none of its declared switches is on").detail), /basisPointsRate\(\) could not be read: DISAGREEMENT/);
});

