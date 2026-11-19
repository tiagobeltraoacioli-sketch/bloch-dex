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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PROXY_SLOTS, ROOT, ZERO_ADDRESS, chainSymbolOf, linkImmutables, loadArtifacts, loadChain, loadShared, lower, marketQuorum, openingPriceFor, pinnedStateReader, planChain, refusesMethod, retrying, validateChain } from "./lib.mjs";
import { openingTransactions, addTransactions, withApprovals } from "./first-deposit.mjs";
import { droppedOpenings, evaluateGate, gateConfig, provenOpenings, writeGateReport } from "./gate.mjs";
import { frontendNetwork, frontendRecord } from "./frontend-files.mjs";
import { TRY_AGAIN, answeredLine, marketRecord, readMarket } from "./market.mjs";
import { MINT_TOPIC, TRANSFER_TOPIC, ROUTER_DEPOSIT_ABI } from "./opening.mjs";
import { approvalSteps, blocklistState, proxyState, readGetter, tokenBehaviourState } from "./token-behaviour.mjs";
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

// Restated in the follow-up of round 20 (reviews R414-5, R414-7; coordinator's decision): USDC now records its
// proxy's implementation and its pause and blacklist getters on every chain, so base's and linea's chain.json and
// gate.json are no longer byte-equal to ba1455b. The property kept, as strictly as it can be stated: the page's
// network file IS byte-equal, and the chain file and the gate file equal those of ba1455b once exactly the two new
// fields of the one token (`behaviour`, `proxy`) are taken out (sha256 of the canonical JSON of the rest).
const NETWORK_BYTES_AT_BA1455B = {
  "deployments/base/frontend.network.json": "e1e3bd544c0c74312c1a7a666667dc072413b5d7022c3d621fee2c5c6aa5eeee",
  "deployments/linea/frontend.network.json": "3a949292f1d282fca27f7e0d34407f1cfd527a303d8fa13c0409fad271fb8b59",
};
// sha256 of JSON with sorted keys and no spaces, of each file at ba1455b.
const CANONICAL_AT_BA1455B = {
  "deployments/base/chain.json": "356160213b6d3ebdd91bd6bf34964a1f1224c48fd031dd9bf8dd05ad9c4b9b83",
  "deployments/base/gate.json": "83df44e14083f71433db7647c71010bbab7bc77bdd553e9e64fab731be4c09b8",
  "deployments/linea/chain.json": "4fa435d2ed710d7f91f7fb6f2458c4d0174d4b12b04121f27c2cc29d21d21c2d",
  "deployments/linea/gate.json": "19c06c2663a538ed48a820d4c5cfbcb60796bcf00d6102a34b3a04781b2d5ea7",
};
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value));

test("A: a chain without a second token keeps what it had: the network file byte for byte, the chain and gate files but for USDC's two new fields", () => {
  for (const key of NO_SECOND) {
    const chain = chainOf(key);
    assert.equal(chain.tokens.length, 1);
    assert.equal(chain.initialPairs.length, 1);
    const gate = JSON.parse(readFileSync(join(ROOT, "deployments", key, "gate.json"), "utf8"));
    assert.equal(gate.ownerChoices.openingPrices, undefined, `${key}: no later pair, no new key`);
    assert.deepEqual(Object.keys(gate.pins.tokens[0]), ["address", "symbol", "decimals", "codeHash", "behaviour", "proxy"]);
    assert.deepEqual(Object.keys(gate.ownerChoices), ["firstDepositor", "reserveCaps", "openingPrice"]);
  }
  for (const [path, expected] of Object.entries(NETWORK_BYTES_AT_BA1455B)) assert.equal(sha256(path), expected, path);
  for (const [path, expected] of Object.entries(CANONICAL_AT_BA1455B)) {
    const file = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    const token = path.endsWith("chain.json") ? file.tokens[0] : file.pins.tokens[0];
    assert.ok(token.behaviour && token.proxy, `${path}: USDC carries the two new fields`);
    delete token.behaviour;
    delete token.proxy;
    assert.equal(createHash("sha256").update(canonical(file)).digest("hex"), expected, `${path}: nothing else changed since ba1455b`);
  }
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

// (The test of `retrying` that stood here is restated with the refusals' bodies under "R414-4" below.)

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
  // Restated in the follow-up (review R414-7): USDC carried no behaviour block; it now states the pause and the
  // blacklist Circle's contract has (read like USDT's), and nothing else differs from a plain token. Binance's
  // token on BNB Smart Chain has neither.
  for (const chain of committedChains) {
    const usdc = chain.tokens[0].behaviour;
    const circle = chain.chain.key !== "bnb-smart-chain";
    assert.deepEqual([usdc.returnsNoValue, usdc.approveZeroFirst, usdc.transferFee, usdc.switches, usdc.blocklist], [false, false, null, circle ? ["paused"] : [], circle ? "isBlacklisted" : null], chain.chain.key);
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
function gateWorld({ chain, local, plan, pairStates = {}, openings = {}, getters = {}, blocked = false, finalizedHasCode = true, upgraded = {}, extraSlots = {}, failing = () => false }) {
  const abi = parseAbi([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)",
    "function feeTo() view returns (address)", "function firstDepositor() view returns (address)", "function reserveCap(address) view returns (uint256)", "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
    "function getPair(address,address) view returns (address)", "function factory() view returns (address)", "function WBLCH() view returns (address)", "function token0() view returns (address)",
    "function token1() view returns (address)", "function reserveCaps() view returns (uint112,uint112)", "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint112,uint112,uint32)",
    "function balanceOf(address) view returns (uint256)", "function isBlackListed(address) view returns (bool)", "function isBlocked(address) view returns (bool)", "function isBlacklisted(address) view returns (bool)",
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
  // A proxy's implementation: the address its recorded slot holds, with a stand-in code (`upgraded`: symbol ->
  // { implementation?, code? } replaces what the node answers, as after an upgrade by the issuer).
  const proxied = new Map(tokens.filter((t) => t.proxy).map((t) => [lower(t.address), { token: t, implementation: upgraded[t.symbol]?.implementation ?? t.proxy.implementation, code: upgraded[t.symbol]?.code ?? code(`impl:${t.symbol}`) }]));
  for (const p of proxied.values()) codes.set(lower(p.implementation), p.code);
  for (const [symbol, slot] of Object.entries(extraSlots)) proxied.set(`extra:${symbol}`, { extra: true, token: tokens.find((t) => t.symbol === symbol), slot });
  const receipts = new Map(Object.values(openings).map((o) => [o.hash, o]));
  return async (method, params) => {
    if (method === "eth_chainId") return `0x${chain.chain.chainId.toString(16)}`;
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
    // `failing(method, params)`: an endpoint that does not answer this read (pruned state, a refusal).
    if (failing(method, params)) throw new Error("missing trie node");
    if (method === "eth_getTransactionCount") return "0x2";
    if (method === "eth_getStorageAt") {
      const p = proxied.get(lower(params[0]));
      const extra = [...proxied.values()].find((x) => x.extra && lower(x.token.address) === lower(params[0]) && PROXY_SLOTS[x.slot] === params[1]);
      if (extra) return `0x${"0".repeat(24)}${"ee".repeat(20)}`;
      return p && PROXY_SLOTS[p.token.proxy.slot] === params[1] ? `0x${"0".repeat(24)}${lower(p.implementation).slice(2)}` : `0x${"0".repeat(64)}`;
    }
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
        // Every declared switch reads false and every declared fee parameter zero unless the test says otherwise.
        const own = { ...Object.fromEntries([...(token.behaviour?.switches ?? []), ...(token.behaviour?.transferFee?.parameters ?? [])].map((g) => [g, 0n])), ...(getters[token.symbol] ?? {}) };
        const name = Object.keys(own).find((g) => toFunctionSelector(`${g}()`) === selector);
        if (name) return own[name] === "revert" ? revert() : word(own[name]);
      }
      if (!abi.some((f) => toFunctionSelector(f) === selector)) return revert();
      const { functionName: fn, args } = decodeFunctionData({ abi, data: params[0].data });
      const out = (result) => encodeFunctionResult({ abi, functionName: fn, result });
      const pair = pairs.get(to);
      if (fn === "isBlackListed" || fn === "isBlocked" || fn === "isBlacklisted") return token?.behaviour?.blocklist === fn ? out(typeof blocked === "function" ? blocked(token, args[0]) : blocked) : revert();
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
  for (const t of [chain.wrappedNative, ...chain.tokens]) {
    t.codeHash = keccak256(code(`token:${t.symbol}`));
    if (t.proxy) t.proxy.implementationCodeHash = keccak256(code(`impl:${t.symbol}`));
  }
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
  assert.deepEqual(pass.tokenStates, { WETH: { basisPointsRate: "absent", maximumFee: "absent" }, USDC: { basisPointsRate: "absent", maximumFee: "absent", paused: "0", implementation: chain.tokens[0].proxy.implementation, implementationCodeHash: chain.tokens[0].proxy.implementationCodeHash }, USDT: { basisPointsRate: "0", maximumFee: "0", paused: "0", deprecated: "0" } });
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
  // A token without a behaviour block (the wrapped native token) against code without any of these functions.
  assert.deepEqual(behaviourMismatch(eth.wrappedNative, functionsIn("0x00")), []);
  // USDC's declaration (pause, isBlacklisted) against the functions Circle's implementation dispatches on.
  const circle = codeOf(push4("paused()"), push4("pause()"), push4("isBlacklisted(address)"), push4("blacklist(address)"));
  assert.deepEqual(behaviourMismatch(eth.tokens[0], functionsIn(circle)), []);
  assert.match(behaviourMismatch(eth.tokens[0], functionsIn("0x00")).join(), /does not have paused\(\) and the configuration declares it.*blocklist getter is none and the configuration says isBlacklisted/);

  // Against a stand-in chain: every listed fact holds, and a token whose fee is on fails the verification.
  const { chain, local, plan } = pinnedLocal("ethereum");
  const market = marketWorld(chain);
  const node = (getters) => {
    const state = gateWorld({ chain, local, plan, getters });
    const prices = market.endpoint();
    const tokenCode = new Map(chain.tokens.map((t) => [lower(t.address), toHex(`code:token:${t.symbol}`)]));
    return async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] !== "0x0") return market.at;
      const to = lower(params[0]?.to ?? params[0] ?? "");
      const known = [chain.wrappedNative, ...chain.tokens].some((t) => lower(t.address) === to || lower(t.proxy?.implementation ?? "") === to) || to === lower(chain.multicall3.address);
      // The market's balanceOf of the wrapped token is the pool's depth, a price read.
      if (method === "eth_call" && to === lower(chain.wrappedNative.address) && params[0].data.startsWith("0x70a08231")) return prices(method, params);
      if (method === "eth_getCode" && tokenCode.has(to)) return tokenCode.get(to);
      return known || method !== "eth_call" && method !== "eth_getCode" ? state(method, params) : prices(method, params);
    };
  };
  const good = await verifyChain({ chain, requests: [node(TETHER_OFF), node(TETHER_OFF)] });
  // The stand-in token code has no dispatch at all, so the declaration check is the one expected failure; every
  // read fact holds, for both pairs.
  assert.deepEqual(good.failed, ["USDC: its configuration describes the fee parameters, switches and blocklist its code has", "USDT: its configuration describes the fee parameters, switches and blocklist its code has"]);
  assert.deepEqual(good.tokens[1].proxy, { kind: "zeppelinos", implementation: chain.tokens[0].proxy.implementation, implementationCodeHash: chain.tokens[0].proxy.implementationCodeHash, implementationBytes: 14, admin: null });
  assert.deepEqual(good.markets.map((m) => [m.pair, m.ok]), [["WETH/USDC", true], ["WETH/USDT", true]]);
  assert.deepEqual(good.tokens.map((t) => [t.key, t.symbol, t.decimals]), [["WETH", "WETH", 18], ["USDC", "USDC", 6], ["USDT", "USDT", 6]]);
  // An endpoint that keeps the state of a block for a short while only (BNB Smart Chain's dataseed: "missing trie
  // node" after about a minute), beside one that refuses eth_call altogether: four endpoints, three must answer a
  // market read. The short-lived one answers exactly as many state reads as the two markets need and no more. The
  // markets are read first, so they are answered by three; read after the other checks they found two and said
  // TRY AGAIN on every run (seen on the real chain, 2026-11-19).
  const stateRead = (method) => method === "eth_call" || method === "eth_getCode" || method === "eth_getStorageAt";
  let marketReads = 0;
  const counting = node(TETHER_OFF);
  const counted = (method, params) => ((marketReads += stateRead(method) ? 1 : 0), counting(method, params));
  for (const token of chain.tokens) await readMarket({ chain, token, requests: [counted, node(TETHER_OFF)], at: market.at });
  assert.ok(marketReads > 0);
  const shortLived = () => {
    const inner = node(TETHER_OFF);
    let served = 0;
    return async (method, params) => {
      if (stateRead(method) && ++served > marketReads) throw new Error(`${method}: missing trie node`);
      return inner(method, params);
    };
  };
  const refusing = () => {
    const inner = node(TETHER_OFF);
    return async (method, params) => {
      if (method === "eth_call") throw new Error("eth_call returned HTTP 403");
      return inner(method, params);
    };
  };
  const aged = await verifyChain({ chain, requests: [node(TETHER_OFF), refusing(), node(TETHER_OFF), shortLived()], names: ["one", "refusing", "three", "short-lived"] });
  assert.deepEqual(aged.markets.map((m) => [m.pair, m.ok, m.tryAgain, m.answered.fewestAnswered, m.answered.mustAnswer]), [["WETH/USDC", true, false, 3, 3], ["WETH/USDT", true, false, 3, 3]]);
  assert.deepEqual(aged.failed, good.failed);
  const feeOn = await verifyChain({ chain, requests: [node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } }), node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } })] });
  assert.ok(feeOn.failed.includes("USDT takes no fee on transfer and none of its declared switches is on"));
  // Two endpoints that disagree on a token's fee state decide nothing: the read is refused, not averaged.
  const split = await verifyChain({ chain, requests: [node(TETHER_OFF), node({ USDT: { ...TETHER_OFF.USDT, basisPointsRate: 5n } })] });
  assert.equal(split.decision, "fail");
  assert.match(JSON.stringify(split.checks.find((c) => c.name === "USDT takes no fee on transfer and none of its declared switches is on").detail), /basisPointsRate\(\) could not be read: DISAGREEMENT/);
});


// ---------------------------------------------------------------------------------------------------------------
// The owner's steps for a second pool (docs/OWNER-DEPLOY-NOW.md section 8B, docs/MULTICHAIN-DEPLOY.md section 8).
// ---------------------------------------------------------------------------------------------------------------

test("the owner's steps for a second pool: one command per block, no comment, no angle bracket, the right chain, pair, token, amount and endpoint", () => {
  const guide = readFileSync(join(ROOT, "docs/OWNER-DEPLOY-NOW.md"), "utf8");
  const blocks = {};
  for (const m of guide.matchAll(/<!-- second-pool: (\S+) (\S+) -->\n```\n([\s\S]*?)\n```/g)) {
    assert.equal(blocks[`${m[1]} ${m[2]}`], undefined, `${m[1]} ${m[2]} appears twice`);
    blocks[`${m[1]} ${m[2]}`] = m[3];
  }
  const ORDER = ["op-mainnet", "arbitrum-one", "bnb-smart-chain", "ethereum"];
  const STEPS = ["verify-chain", "post-gate-two-pairs", "market", "depositor-native", "depositor-token", "prepare", "verify", "post-gate-open", "frontend-record", "record-add", "record-commit"];
  const ONCE = ["cd", "fetch", "origin-main", "rebase", "own-commits", "forge-build", "kit-tests"];
  assert.deepEqual(Object.keys(blocks), [...ONCE.map((s) => `once ${s}`), ...ORDER.flatMap((k) => STEPS.map((s) => `${k} ${s}`))]);
  assert.deepEqual(ORDER, committed.chains.filter((k) => SECOND[k]), "the four chains with a second token, in the document's order");
  // The owner's shell reads `#` as text and `<` `>` as redirections: none in any block, and one line each.
  for (const [name, command] of Object.entries(blocks)) {
    assert.ok(!command.includes("\n"), `${name}: one command`);
    assert.ok(!/(^|\s)#/.test(command) && !/[<>]/.test(command), `${name}: no comment and no angle bracket`);
    assert.ok(!/--private-key|--mnemonic|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(command), `${name}: no key`);
    assert.ok(!/^cast send /.test(command), `${name}: the lines to sign are printed by the tool, never written in the guide`);
  }
  // No block of a section before 8B was touched by this round: the dry-run driver's blocks are counted by its own test.
  assert.equal(blocks["once kit-tests"], "node --test scripts/multichain/second-pair-r20.test.mjs");
  assert.equal(blocks["once rebase"], "git rebase origin/main");
  // Review R414-2: after the rebase the copy is compared with the reviewed commit AS IT IS ON DISK (a tracked file
  // changed and not committed is in that list; `origin/main HEAD` compared two commits and missed it), no block
  // hides such a change, and the guide says what replaces section 2.1's check and what to do when the rebase refuses.
  assert.equal(blocks["once own-commits"], "git diff --stat origin/main");
  for (const command of Object.values(blocks)) assert.ok(!/autostash|git stash|git checkout|git restore|git reset|git clean/.test(command), command);
  const once = guide.slice(guide.indexOf("### 8B.0"), guide.indexOf("### 8B.1"));
  assert.match(once, /your copy as it is on disk\*\*: your own commits and anything changed and not committed/);
  assert.match(once, /`scripts\/multichain\/reviewed-commit\.sh` no longer applies to this copy/);
  assert.match(once, /prints `PASS`, which proves nothing/);
  assert.match(once, /cannot rebase: You have unstaged changes.*stop here\.\*\* Do not add `--autostash`, do not `git stash`/s);
  assert.match(guide, /\*\*If a tool says `TRY AGAIN`\.\*\* This is not a fault\./);
  assert.match(guide, /\*\*If the post gate says `NOT WRITTEN`\.\*\*/);
  assert.match(guide, /A line that starts `THE ISSUER UPGRADED`/);
  for (const key of ORDER) {
    const chain = chainOf(key);
    const token = chain.tokens[1];
    const pair = `${chain.wrappedNative.symbol}/${token.symbol}`;
    const minimum = openingPriceFor(chain, token).minimumNative;
    const b = (step) => blocks[`${key} ${step}`];
    assert.equal(b("verify-chain"), `node scripts/multichain/verify-chain.mjs ${key}`);
    assert.equal(b("post-gate-two-pairs"), `node scripts/multichain/gate.mjs ${key} post --out deployments/${key}/gate-report.json`);
    assert.equal(b("market"), `node scripts/multichain/market.mjs ${key} --pair ${pair} --native ${minimum}`);
    assert.equal(b("prepare"), `node scripts/multichain/first-deposit.mjs ${key} prepare --pair ${pair} --native ${minimum} --gate-report deployments/${key}/gate-report.json`);
    assert.equal(b("verify"), `node scripts/multichain/first-deposit.mjs ${key} verify --pair ${pair} --native ${minimum} --token TOKEN_AMOUNT --tx DEPOSIT_HASH`);
    assert.equal(b("post-gate-open"), `node scripts/multichain/gate.mjs ${key} post --opening ${pair}=DEPOSIT_HASH --out deployments/${key}/gate-report.json`);
    assert.equal(b("frontend-record"), `node scripts/multichain/frontend-files.mjs ${key} --gate-report deployments/${key}/gate-report.json`);
    assert.equal(b("depositor-native"), `cast balance ${committed.firstDepositor} --ether --rpc-url ${chain.rpc[0]}`);
    assert.equal(b("depositor-token"), `cast call ${token.address} "balanceOf(address)(uint256)" ${committed.firstDepositor} --rpc-url ${chain.rpc[0]}`);
    // The pair's name is typable (the key, not a symbol of another script) and never another chain's.
    assert.match(pair, /^[A-Z]{3,5}\/[A-Z0-9]{4,5}$/);
    for (const other of committed.chains.filter((k) => k !== key)) for (const step of STEPS) assert.ok(!b(step).includes(` ${other} `) && !b(step).includes(`deployments/${other}/`), `${key} ${step} names ${other}`);
  }
  // The guide says what the tokens are and what to do with Tether's approve; Base and Linea get no second pool.
  assert.match(guide, /\*\*Base and Linea do not\*\*/);
  assert.match(guide, /\*\*Never send an `approve` of USDT yourself\*\*/);
  for (const shown of ["USDT (bridged)", "USD₮0", "USDT (Binance-Peg)"]) assert.ok(guide.includes(shown), shown);
  // The technical document's own blocks of that subsection obey the same rule.
  const doc = readFileSync(join(ROOT, "docs/MULTICHAIN-DEPLOY.md"), "utf8");
  const section = doc.slice(doc.indexOf("**A second pool on a chain (USDT).**"), doc.indexOf("If the sender through the reviewed public endpoint is a problem"));
  const commands = [...section.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(commands.length, 7);
  for (const command of commands) assert.ok(!command.includes("\n") && !/(^|\s)#/.test(command) && !/[<>]/.test(command) && / ethereum /.test(`${command} `), command);
  // The recovery text that was wrong for Tether's contract is gone, and its correction is there.
  assert.match(doc, /do not send another `approve` yourself/);
  assert.match(doc, /Tokens with a transfer fee or a rebasing balance are not supported and must not be\s+listed/);
});

// ===============================================================================================================
// Follow-up of round 20: the findings of review 414 (agents/414-dex-usdt-review-r20.md).
// ===============================================================================================================

test("R414-1: a market read needs all but one of the reviewed endpoints (never fewer than two); the reviewer's two cases are refused, three of four pass", async () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(marketQuorum), [1, 2, 2, 3, 4]);
  const chain = clone(chainOf("bnb-smart-chain"));
  const world = marketWorld(chain);
  const token = chain.tokens[1];
  const names = chain.rpc.map((u) => new URL(u).host);
  const read = (...endpoints) => readMarket({ chain, token, requests: endpoints, at: world.at, names });
  const honest = world.endpoint();
  const liar = world.endpoint({ usd: 90_000_000n });
  const refusing = world.endpoint({ refuse: true });
  const pruned = async () => { throw new Error("missing trie node"); };
  // The reviewer's demonstration (probes/r414-1-demo.mjs): two endpoints wrong alike, the two others silent. With
  // "any two" these were accepted; now nothing is decided, and the answer is "try again", not a price.
  for (const set of [[liar, refusing, liar, pruned], [refusing, pruned, liar, liar]]) {
    const r = await read(...set);
    assert.equal(r.ok, false);
    assert.equal(r.market, undefined);
    assert.equal(r.tryAgain, true);
    assert.deepEqual([r.answered.reviewed, r.answered.mustAnswer, r.answered.fewestAnswered], [4, 3, 2]);
    assert.match(r.problems.join(), /2 endpoints answered, 3 must agree/);
  }
  // BNB Smart Chain as it is: one of four refuses eth_call for ever. Three answer and agree: a price.
  const today = await read(honest, refusing, honest, honest);
  assert.equal(today.ok, true, today.problems.join());
  assert.equal(today.tryAgain, false);
  assert.deepEqual([today.answered.mustAnswer, today.answered.fewestAnswered, today.answered.reads], [3, 3, 16]);
  // The read says who did not answer, by name, on how many reads and why; and so does the record of it.
  assert.deepEqual(today.answered.notAnswering, [{ endpoint: "api.zan.top", reads: 16, why: "eth_call returned HTTP 403" }]);
  assert.equal(answeredLine(today), "endpoints: every one of the 16 reads was answered by at least 3 of the 4 reviewed endpoints (3 must answer, and all that answer must agree); not answering: api.zan.top (16 of 16 reads: eth_call returned HTTP 403)");
  assert.deepEqual(marketRecord(today).answered, today.answered);
  // As measured on the chain: its fourth endpoint drops a read ("missing trie node") while the second refuses.
  let calls = 0;
  const flaky = async (method, params) => {
    if (method === "eth_call" && ++calls === 5) throw new Error("missing trie node");
    return honest(method, params);
  };
  const dropped = await read(honest, refusing, honest, flaky);
  assert.deepEqual([dropped.ok, dropped.tryAgain, dropped.answered.fewestAnswered], [false, true, 2]);
  assert.deepEqual(dropped.answered.notAnswering.map((s) => [s.endpoint, s.reads]), [["api.zan.top", dropped.answered.reads], ["bsc-dataseed.bnbchain.org", 1]]);
  // What the rule does not do, stated: three endpoints wrong alike with the fourth silent are three agreeing
  // answers. Every read is then decided by them (no DISAGREEMENT, no "try again"); here the lie is in one feed
  // only, so the two references part and there is still no price.
  const three = await read(liar, refusing, liar, liar);
  assert.deepEqual([three.tryAgain, three.answered.fewestAnswered, /DISAGREEMENT/.test(three.problems.join())], [false, 3, false]);
  assert.match(three.problems.join(), /more than the 1% within which they must agree/);
  // Any answer that differs is a disagreement, whoever is silent: that is not "try again", it is a stop.
  const split = await read(honest, refusing, honest, liar);
  assert.deepEqual([split.ok, split.tryAgain], [false, false]);
  assert.match(split.problems.join(), /DISAGREEMENT/);
  // Linea's three: two must answer. Two of three give a price; one of three says try again.
  const linea = clone(chainOf("linea"));
  const lw = marketWorld(linea);
  const lineaRead = (...endpoints) => readMarket({ chain: linea, token: linea.tokens[0], requests: endpoints, at: lw.at });
  const two = await lineaRead(lw.endpoint(), lw.endpoint({ refuse: true }), lw.endpoint());
  assert.deepEqual([two.ok, two.answered.mustAnswer, two.answered.fewestAnswered, two.answered.notAnswering[0].endpoint], [true, 2, 2, "endpoint 2"]);
  assert.deepEqual((({ ok, tryAgain }) => [ok, tryAgain])(await lineaRead(lw.endpoint(), lw.endpoint({ refuse: true }), lw.endpoint({ refuse: true }))), [false, true]);
  // Two endpoints (OP Mainnet, Base, Ethereum): both, as at ba1455b. One endpoint: a loopback rehearsal.
  const eth = clone(chainOf("ethereum"));
  const ew = marketWorld(eth);
  assert.equal((await readMarket({ chain: eth, token: eth.tokens[0], requests: [ew.endpoint(), ew.endpoint({ refuse: true })], at: ew.at })).tryAgain, true);
  assert.equal((await readMarket({ chain: eth, token: eth.tokens[0], requests: [ew.endpoint()], at: ew.at })).ok, true);
  // The words the owner reads, in the tools and in both documents.
  assert.match(TRY_AGAIN, /^TRY AGAIN in a minute: .*not a fault.*Nothing was printed to send\.$/);
  for (const file of ["scripts/multichain/market.mjs", "scripts/multichain/first-deposit.mjs"]) assert.match(readFileSync(join(ROOT, file), "utf8"), /if \(market\.tryAgain\) print\(TRY_AGAIN\)/, file);
  for (const doc of ["docs/OWNER-DEPLOY-NOW.md", "docs/MULTICHAIN-DEPLOY.md"]) assert.match(readFileSync(join(ROOT, doc), "utf8"), /TRY AGAIN/, doc);
});

test("R414-4: a 403 is a refusal of the METHOD only when its body names the method; any other 403 is retried in full", async () => {
  const http = (method, status, body) => Object.assign(new Error(`${method} returned HTTP ${status}`), { httpStatus: status, httpBody: body });
  // The two bodies seen on BNB Smart Chain's first two endpoints (2026-11-19).
  const ZAN = '{"error":{"code":-32012,"message":"Method \\"eth_call\\" is not available for unregistered accounts. Please visit https://zan.top/ and register to unlock more."},"id":1,"jsonrpc":"2.0"}';
  const ARCHIVE = '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}';
  assert.equal(refusesMethod(http("eth_call", 403, ZAN), "eth_call"), true);
  assert.equal(refusesMethod(http("eth_getBlockByNumber", 403, ARCHIVE), "eth_getBlockByNumber"), false, "the reviewer's case: a refusal of block 0, not of the method");
  assert.equal(refusesMethod(http("eth_getCode", 403, ZAN), "eth_getCode"), false, "a body that names another method");
  assert.equal(refusesMethod(http("eth_call", 429, ZAN), "eth_call"), false);
  assert.equal(refusesMethod(new Error("eth_call returned HTTP 403"), "eth_call"), false, "without the body nothing is concluded");
  assert.equal(refusesMethod(http("eth_call", 403, 'Method "eth_callMany" is not available'), "eth_call"), false, "the name as a whole word");
  const counter = (errorFor) => {
    const state = { calls: 0, refuse: true };
    const endpoint = retrying(async (method) => {
      state.calls++;
      if (state.refuse) throw errorFor(method);
      return "0x1";
    }, { delayMs: 1 });
    return { state, endpoint };
  };
  // A method refused by policy: three tries once, then one ask per call; another method is not prejudged; an
  // answer ends the shortcut.
  const zan = counter((m) => http(m, 403, ZAN.replace("eth_call", m)));
  await assert.rejects(() => zan.endpoint("eth_call", []), /HTTP 403/);
  assert.equal(zan.state.calls, 3);
  await assert.rejects(() => zan.endpoint("eth_call", []), /HTTP 403/);
  await assert.rejects(() => zan.endpoint("eth_call", []), /HTTP 403/);
  assert.equal(zan.state.calls, 5, "each later call asks once");
  await assert.rejects(() => zan.endpoint("eth_getCode", []), /HTTP 403/);
  assert.equal(zan.state.calls, 8);
  zan.state.refuse = false;
  assert.equal(await zan.endpoint("eth_call", []), "0x1");
  zan.state.refuse = true;
  zan.state.calls = 0;
  await assert.rejects(() => zan.endpoint("eth_call", []), /HTTP 403/);
  assert.equal(zan.state.calls, 3);
  // The archive refusal: every later eth_getBlockByNumber keeps its three tries (before the fix: one).
  const archive = counter((m) => http(m, 403, ARCHIVE));
  await assert.rejects(() => archive.endpoint("eth_getBlockByNumber", ["0x0", false]), /HTTP 403/);
  await assert.rejects(() => archive.endpoint("eth_getBlockByNumber", ["finalized", false]), /HTTP 403/);
  assert.equal(archive.state.calls, 6);
  // A 403 without a readable body, a rate limit, a dropped connection: never shortened.
  for (const error of [() => new Error("eth_call returned HTTP 403"), (m) => http(m, 429, ZAN), () => new Error("fetch failed")]) {
    const plain = counter(error);
    await assert.rejects(() => plain.endpoint("eth_call", []));
    await assert.rejects(() => plain.endpoint("eth_call", []));
    assert.equal(plain.state.calls, 6);
  }
  // The transport hands the status and the first bytes of the body on, and its message is what it was.
  const { createRpcTransport, MAX_HTTP_ERROR_BODY_BYTES } = await import("../staging/rpc-transport.mjs");
  const transport = createRpcTransport("https://endpoint.invalid", { fetchImpl: async () => new Response(ZAN + " ".repeat(5000), { status: 403, headers: { "content-type": "application/json" } }) });
  const refused = await transport("eth_call", []).then(() => null, (e) => e);
  assert.deepEqual([refused.message, refused.httpStatus, refused.httpBody.startsWith(ZAN), refused.httpBody.length <= MAX_HTTP_ERROR_BODY_BYTES], ["eth_call returned HTTP 403", 403, true, true]);
  assert.equal(refusesMethod(refused, "eth_call"), true);
  const empty = await createRpcTransport("https://endpoint.invalid", { fetchImpl: async () => new Response(null, { status: 502 }) })("eth_call", []).then(() => null, (e) => e);
  assert.deepEqual([empty.message, empty.httpStatus, empty.httpBody], ["eth_call returned HTTP 502", 502, ""]);
});

test("R414-3: a post gate run never loses the first pool's opening hash: the failed-read path, demonstrated, then refused", async () => {
  const { chain, local, plan } = pinnedLocal("bnb-smart-chain");
  const [first, second] = plan.pairs;
  const names = [`${first.tokenA}/${first.tokenB}`, `${second.tokenA}/${second.tokenB}`];
  const opened = { [names[0]]: openingOf({ plan, chain, pair: first, digit: "1" }), [names[1]]: openingOf({ plan, chain, pair: second, digit: "2" }) };
  const gate = ({ states, hashes, failing }) => evaluateGate({ shared: local, chain, plan, phase: "post", request: gateWorld({ chain, local, plan, pairStates: states, openings: opened, failing }), rehearsal: true, openings: Object.fromEntries(hashes.map((n) => [n, opened[n].hash])) });
  // The owner's report after section 5: the first pool open and proven.
  const good = await gate({ states: { [names[0]]: "open" }, hashes: [names[0]] });
  assert.equal(good.decision, "pass", JSON.stringify(good.failed));
  assert.deepEqual(provenOpenings(good, chain, plan), [{ pair: names[0], address: lower(first.address), transaction: opened[names[0]].hash }]);
  // The path the reviewer argued: step U2, and the endpoint does not answer getPair of the FIRST pair (pruned
  // state). The pair is reported as not created (its tokens are seen at the address, its shares are not), with no
  // opening at all: the report has lost the hash.
  const getPair = toFunctionSelector("getPair(address,address)");
  const unread = await gate({ states: { [names[0]]: "open" }, hashes: [names[0]], failing: (method, params) => method === "eth_call" && params[0].data.startsWith(getPair) && params[0].data.includes(lower(first.token0).slice(2)) });
  assert.equal(unread.decision, "fail");
  assert.deepEqual([unread.pairs[0].created, unread.pairs[0].state, unread.pairs[0].opening], [false, "donated", undefined]);
  assert.deepEqual(provenOpenings(unread, chain, plan), []);
  assert.deepEqual(droppedOpenings(good, unread, chain, plan), [{ pair: names[0], address: lower(first.address), transaction: opened[names[0]].hash }]);
  // Before the fix that report was written over the file. Now the file stays, and the run's report lies beside it.
  const dir = mkdtempSync(join(tmpdir(), "r414-3-"));
  const path = join(dir, "gate-report.json");
  assert.deepEqual(writeGateReport(path, good, { chain, plan }), { replaced: true, dropped: [], kept: null });
  const before = readFileSync(path, "utf8");
  const refused = writeGateReport(path, unread, { chain, plan });
  assert.deepEqual([refused.replaced, refused.dropped.map((d) => d.pair), refused.kept], [false, [names[0]], `${path}.not-written.json`]);
  assert.equal(readFileSync(path, "utf8"), before, "the report with the proven opening is untouched");
  assert.equal(JSON.parse(readFileSync(refused.kept, "utf8")).decision, "fail");
  // The next run reads the pool again, carries the hash from the untouched file, and replaces it; the leftover goes.
  const again = await gate({ states: { [names[0]]: "open" }, hashes: [names[0]] });
  assert.equal(writeGateReport(path, again, { chain, plan }).replaced, true);
  assert.equal(existsSync(refused.kept), false);
  // The second pool's opening is added; from then on neither may be dropped.
  const both = await gate({ states: { [names[0]]: "open", [names[1]]: "open" }, hashes: names });
  assert.equal(writeGateReport(path, both, { chain, plan }).replaced, true);
  assert.deepEqual(droppedOpenings(both, again, chain, plan).map((d) => d.pair), [names[1]]);
  assert.equal(writeGateReport(path, again, { chain, plan }).replaced, false);
  // The reviewer's demonstrated case: a report whose opening hash this run does not prove (another transaction).
  const other = clone(both);
  other.pairs[0].opening.transaction = `0x${"9".repeat(64)}`;
  assert.equal(writeGateReport(path, other, { chain, plan }).replaced, false);
  // Reports of another chain or another factory, a file that is not a report, and no file: written as before.
  for (const [name, content] of [["other-chain.json", JSON.stringify({ ...both, chain: { ...both.chain, chainId: 1 } })], ["not-json.json", "{"], ["absent.json", null]]) {
    const p = join(dir, name);
    if (content !== null) writeFileSync(p, content);
    assert.equal(writeGateReport(p, unread, { chain, plan }).replaced, true, name);
  }
  // The tool tells the owner so, and that nothing is lost.
  assert.match(readFileSync(join(ROOT, "scripts/multichain/gate.mjs"), "utf8"), /NOT WRITTEN: the report at .* was left as it is\./);
});

test("R414-5, R414-7: an upgrade behind a listed proxy is seen and refused; a token recorded as plain code must not be a proxy", async () => {
  // What is recorded, per chain: Circle's USDC behind its ZeppelinOS slot on five chains, Binance's USDC and
  // Arbitrum One's USD₮0 and WETH behind EIP-1967; everything else is plain code.
  const recorded = Object.fromEntries(committedChains.map((c) => [c.chain.key, [c.wrappedNative, ...c.tokens].filter((t) => t.proxy).map((t) => `${t.symbol}:${t.proxy.slot}`)]));
  assert.deepEqual(recorded, { "op-mainnet": ["USDC:zeppelinos"], base: ["USDC:zeppelinos"], "arbitrum-one": ["WETH:eip1967", "USDC:zeppelinos", "USDT0:eip1967"], linea: ["USDC:zeppelinos"], "bnb-smart-chain": ["USDC:eip1967"], ethereum: ["USDC:zeppelinos"] });
  const usdt0 = chainOf("arbitrum-one").tokens[1];
  assert.deepEqual([usdt0.proxy.implementation, usdt0.proxy.implementationCodeHash], ["0x3263CD783823d04a6B9819517E0E6840d37cA3F4", "0x1d4c20a1a19a0e182c0d2bffbe433a96bd70a1dbb383b7a2d293976df4042279"]);
  // The pure reader.
  const implCode = toHex("code:impl");
  const token = { address: usdt0.address, symbol: "USDT0", proxy: { slot: "eip1967", implementation: usdt0.proxy.implementation, implementationCodeHash: keccak256(implCode), checked: "2026-11-19" } };
  const padded = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const ZERO_WORD = `0x${"0".repeat(64)}`;
  const reader = ({ eip1967 = token.proxy.implementation, zeppelinos = null, code = implCode, down = false } = {}) => ({
    storage: async (_address, slot) => {
      if (down) throw new Error("multichain: eth_getStorageAt at block 0xab: 1 endpoint answered, 2 must agree");
      const value = slot === PROXY_SLOTS.eip1967 ? eip1967 : zeppelinos;
      return value ? padded(value) : ZERO_WORD;
    },
    code: async () => code,
  });
  assert.deepEqual(await proxyState(reader(), token), { ok: true, problems: [], read: { eip1967: token.proxy.implementation, zeppelinos: null }, implementationCodeHash: keccak256(implCode) });
  const NEW = viem.getAddress(`0x${"ab".repeat(20)}`);
  const moved = await proxyState(reader({ eip1967: NEW }), token);
  assert.equal(moved.ok, false);
  assert.match(moved.problems[0], new RegExp(`^THE ISSUER UPGRADED USDT0: its proxy now points at ${NEW}; the reviewed implementation is ${token.proxy.implementation}\\. Deposit nothing into this token's pools and write no new page record\\.`));
  assert.match((await proxyState(reader({ code: toHex("code:other") }), token)).problems[0], /^THE CODE BEHIND USDT0 CHANGED/);
  assert.match((await proxyState(reader({ eip1967: null }), token)).problems[0], /its proxy now points at nothing/);
  assert.match((await proxyState(reader({ zeppelinos: NEW }), token)).problems.join(), /is a proxy \(zeppelinos slot: implementation .*\) and its configuration records another slot \(eip1967\)/);
  assert.match((await proxyState(reader({ down: true }), token)).problems.join(), /implementation slot of USDT0 could not be read/);
  // A token recorded as plain code: both slots empty, or it is refused.
  const plain = { address: usdt0.address, symbol: "USDT" };
  assert.equal((await proxyState(reader({ eip1967: null }), plain)).ok, true);
  assert.match((await proxyState(reader(), plain)).problems[0], /USDT is a proxy \(eip1967 slot: implementation .*\) and its configuration records no implementation: what stands behind it was not reviewed/);
  // Through the gate, pre and post, on Arbitrum One (WETH, USDC and USD₮0 are all proxies there).
  const arb = pinnedLocal("arbitrum-one");
  const NAME = (symbol) => new RegExp(`^${symbol} is the code that was reviewed: its proxy points at the recorded implementation, which holds its recorded code$`);
  for (const phase of ["pre", "post"]) {
    const gate = (world) => evaluateGate({ shared: arb.local, chain: arb.chain, plan: arb.plan, phase, request: gateWorld({ ...arb, ...world }), rehearsal: true });
    const pass = await gate({});
    assert.equal(pass.decision, "pass", JSON.stringify(pass.failed));
    assert.equal(pass.tokenStates.USDT0.implementation, usdt0.proxy.implementation);
    for (const [symbol, change] of [["USDT0", { implementation: NEW }], ["USDC", { implementation: NEW }], ["WETH", { code: toHex("code:replaced") }], ["USDT0", { code: toHex("code:with-a-fee") }]]) {
      const report = await gate({ upgraded: { [symbol]: change } });
      assert.equal(report.decision, "fail", `${phase} ${symbol}`);
      assert.deepEqual(report.failed.filter((f) => /is the code that was reviewed/.test(f)).length, 1);
      assert.ok(report.failed.some((f) => NAME(symbol).test(f)), JSON.stringify(report.failed));
      assert.match(JSON.stringify(report.checks.find((c) => NAME(symbol).test(c.name)).detail), change.implementation ? /THE ISSUER UPGRADED/ : /THE CODE BEHIND .* CHANGED/);
    }
  }
  // A token listed as plain code that is a proxy after all (Tether's contract with something in a proxy slot).
  const eth = pinnedLocal("ethereum");
  const sneaky = await evaluateGate({ shared: eth.local, chain: eth.chain, plan: eth.plan, phase: "pre", request: gateWorld({ ...eth, extraSlots: { USDT: "eip1967" } }), rehearsal: true });
  assert.ok(sneaky.failed.includes("USDT is the code that was reviewed: not a proxy"), JSON.stringify(sneaky.failed));
  // The configuration is validated: a known slot, a checksummed implementation, a code hash, a date.
  const edit = (change) => {
    const c = clone(chainOf("arbitrum-one"));
    change(c.tokens[1].proxy);
    return () => validateChain(c, "arbitrum-one");
  };
  assert.throws(edit((p) => (p.slot = "transparent")), /proxy\.slot is one of eip1967, zeppelinos/);
  assert.throws(edit((p) => (p.implementation = p.implementation.toLowerCase())), /EIP-55/);
  assert.throws(edit((p) => delete p.implementationCodeHash), /implementationCodeHash/);
  assert.throws(edit((p) => delete p.checked), /checked/);
  assert.throws(edit((p) => (p.beacon = "x")), /proxy: slot, implementation/);
  // The gate's committed pins carry the record.
  assert.deepEqual(gateConfig(committed, chainOf("arbitrum-one")).pins.tokens[1].proxy, { slot: "eip1967", implementation: usdt0.proxy.implementation, implementationCodeHash: usdt0.proxy.implementationCodeHash });
  assert.equal(gateConfig(committed, chainOf("arbitrum-one")).pins.wrappedNative.proxy.slot, "eip1967");
});

test("R414-7: USDC's pause and blacklist are read like USDT's: a paused USDC, or a blacklisted pair or router, fails the gate", async () => {
  const { chain, local, plan } = pinnedLocal("base");
  const pair = plan.pairs[0];
  const gate = (world, phase = "post") => evaluateGate({ shared: local, chain, plan, phase, request: gateWorld({ chain, local, plan, ...world }), rehearsal: true });
  const pass = await gate({});
  assert.equal(pass.decision, "pass", JSON.stringify(pass.failed));
  assert.deepEqual(pass.tokenStates.USDC, { basisPointsRate: "absent", maximumFee: "absent", paused: "0", implementation: chain.tokens[0].proxy.implementation, implementationCodeHash: chain.tokens[0].proxy.implementationCodeHash });
  for (const phase of ["pre", "post"]) {
    const paused = await gate({ getters: { USDC: { paused: 1n } } }, phase);
    assert.equal(paused.decision, "fail");
    assert.match(JSON.stringify(paused.checks.find((c) => /^USDC takes no fee on transfer/.test(c.name)).detail), /paused\(\) is true: the issuer has stopped every transfer/);
    // The reviewed USDC answers paused(); a contract that does not is not that token.
    assert.match(JSON.stringify((await gate({ getters: { USDC: { paused: "revert" } } }, phase)).checks.find((c) => /^USDC takes no fee on transfer/.test(c.name)).detail), /declares the switch paused\(\) and the contract does not answer it/);
  }
  const NAME = "the issuer's blocklist of USDC names neither the pair WETH/USDC nor the router";
  assert.ok(pass.checks.some((c) => c.name === NAME && c.ok));
  for (const blockedAddress of [pair.address, plan.contracts.router.address]) {
    const report = await gate({ blocked: (_token, address) => lower(address) === lower(blockedAddress) });
    assert.equal(report.decision, "fail");
    assert.deepEqual(report.failed, [NAME]);
    assert.match(JSON.stringify(report.checks.find((c) => c.name === NAME).detail), /is on the issuer's blocklist of USDC \(isBlacklisted\)/);
  }
  // Binance's USDC on BNB Smart Chain has neither function: nothing of the kind is asked of it.
  const bnb = pinnedLocal("bnb-smart-chain");
  const bnbGate = await evaluateGate({ shared: bnb.local, chain: bnb.chain, plan: bnb.plan, phase: "post", request: gateWorld(bnb), rehearsal: true });
  assert.equal(bnbGate.decision, "pass", JSON.stringify(bnbGate.failed));
  assert.equal(bnbGate.checks.some((c) => /blocklist of USDC/.test(c.name)), false);
  assert.deepEqual(Object.keys(bnbGate.tokenStates.USDC), ["basisPointsRate", "maximumFee", "implementation", "implementationCodeHash"]);
});
