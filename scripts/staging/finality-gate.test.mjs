import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyDepositorHistory, evaluateFinalityGate, GATE_DOMAIN } from "./finality-gate.mjs";

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

// ------------------------------------------------------------------------ //
// Schema 2 (mainnet): code hashes, fee state, bindings and every cap.        //
// ------------------------------------------------------------------------ //

import { createRequire } from "node:module";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, toFunctionSelector } = requireFromFrontend("viem");

const V2 = {
  depositor: `0x${"f1d0".repeat(10)}`,
  deployer: addr("d"),
  wrapped: addr("1"),
  asset: addr("2"),
  gsmh: addr("6"),
  factory: addr("f"),
  router: addr("3"),
  lens: addr("4"),
  pair: addr("e"),
  gsmhPair: addr("c"),
  blochInc: addr("7"),
  singleton: addr("8"),
  handler: addr("9"),
};
const OWNERS = [addr("a"), addr("b"), addr("5"), addr("0").replace(/0$/, "3"), addr("d").replace(/d$/, "e")];
const CODE = {
  [V2.wrapped]: "0x01",
  [V2.asset]: "0x02",
  [V2.gsmh]: "0x06",
  [V2.factory]: "0x0f",
  [V2.router]: "0x03",
  [V2.lens]: "0x04",
  [V2.pair]: "0x0e",
  [V2.gsmhPair]: "0x0e",
  [V2.blochInc]: "0x0b",
  [V2.singleton]: "0x5a",
  [V2.handler]: "0x5b",
};
const INIT_HASH = hash("1");
const sel = (signature) => toFunctionSelector(signature);
const pad = (a) => a.slice(2).padStart(64, "0");
const BUSDC_CAP = 1_000_000_000n; // 1,000 bUSDC (6 decimals)
const BUSDC_BUCKET = 10_000_000_000n; // 10,000 bUSDC
const GSMH_CAP = 100_000_000_000n; // 1,000 wGSMH (8 decimals)
const GSMH_BUCKET = 1_000_000_000_000n; // 10,000 wGSMH

function configV2(change = () => {}) {
  const contract = (address) => ({ address, codeHash: keccak256(CODE[address]) });
  const c = {
    schemaVersion: 2,
    domain: GATE_DOMAIN,
    chain: { id: 700770, genesisHash: hash("9") },
    deployment: {
      deployer: V2.deployer,
      firstDepositor: V2.depositor,
      contracts: {
        wrappedNative: contract(V2.wrapped),
        factory: contract(V2.factory),
        router: contract(V2.router),
        lens: contract(V2.lens),
      },
      pairInitCodeHash: INIT_HASH,
      feeTo: V2.blochInc,
      roles: {
        blochInc: {
          ...contract(V2.blochInc),
          safe: {
            version: "1.4.1",
            singleton: contract(V2.singleton),
            fallbackHandler: contract(V2.handler),
            threshold: 3,
            owners: [...OWNERS],
          },
        },
      },
      reserveCaps: [
        { token: V2.wrapped, cap: CAP.toString() },
        { token: V2.gsmh, cap: GSMH_CAP.toString() },
        { token: V2.asset, cap: BUSDC_CAP.toString() },
      ],
      tokens: [
        { token: V2.gsmh, symbol: "wGSMH", codeHash: keccak256(CODE[V2.gsmh]), bridgeBucketCapacity: GSMH_BUCKET.toString() },
        { token: V2.asset, symbol: "bUSDC", codeHash: keccak256(CODE[V2.asset]), bridgeBucketCapacity: BUSDC_BUCKET.toString() },
      ],
      pairs: [
        { address: V2.gsmhPair, token0: V2.wrapped, token1: V2.gsmh, codeHash: keccak256(CODE[V2.gsmhPair]) },
        { address: V2.pair, token0: V2.wrapped, token1: V2.asset, codeHash: keccak256(CODE[V2.pair]) },
      ],
      transactions: [TX],
    },
    limits: { maxWrappedReserveCap: "10000000000000000000" },
  };
  change(c);
  return c;
}

function rpcV2(change = {}) {
  const state = {
    chainId: hex(700770),
    genesis: { number: "0x0", hash: hash("9") },
    finalized: { number: hex(300), hash: hash("b") },
    receipt: { transactionHash: TX, status: "0x1", from: V2.deployer, blockNumber: hex(300), blockHash: hash("b") },
    code: { ...CODE },
    initHash: INIT_HASH,
    feeTo: V2.blochInc,
    firstDepositor: V2.depositor,
    totalSupply: 0n,
    depositorNonce: "0x0",
    caps: { [V2.wrapped]: CAP, [V2.asset]: BUSDC_CAP, [V2.gsmh]: GSMH_CAP },
    buckets: { [V2.asset]: BUSDC_BUCKET, [V2.gsmh]: GSMH_BUCKET },
    routerFactory: V2.factory,
    routerWrapped: V2.wrapped,
    lensFactory: V2.factory,
    pairFactory: V2.factory,
    token0: V2.wrapped,
    token1: V2.asset,
    registered: V2.pair,
    pairCaps: [CAP, BUSDC_CAP],
    safeSingleton: V2.singleton,
    safeHandler: V2.handler,
    safeGuard: addr("0"),
    safeThreshold: 3n,
    safeOwners: [...OWNERS].reverse(),
    safeModules: [],
    safeModuleNext: 1n,
    safeVersion: "1.4.1",
    ...change,
  };
  return async (method, params) => {
    switch (method) {
      case "eth_chainId":
        return state.chainId;
      case "eth_getBlockByNumber":
        if (params[0] === "0x0") return state.genesis;
        if (params[0] === "finalized") return state.finalized;
        return Number(BigInt(params[0])) === 300 ? { number: params[0], hash: hash("b") } : null;
      case "bloch_finality":
        return { finalized: state.finalized };
      case "eth_getTransactionReceipt":
        return params[0] === TX ? state.receipt : null;
      case "eth_getTransactionCount":
        assert.equal(params[0], state.firstDepositor);
        assert.deepEqual(params[1], { blockHash: state.finalized.hash, requireCanonical: true });
        return state.depositorNonce;
      case "eth_getCode":
        assert.deepEqual(params[1], { blockHash: state.finalized.hash, requireCanonical: true });
        return state.code[params[0]] ?? "0x";
      case "eth_getStorageAt": {
        assert.equal(params[0], V2.blochInc);
        assert.deepEqual(params[2], { blockHash: state.finalized.hash, requireCanonical: true });
        const slot = {
          "0x0": state.safeSingleton,
          "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5": state.safeHandler,
          "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8": state.safeGuard,
        }[params[1]];
        if (slot === undefined) throw new Error(`unexpected slot ${params[1]}`);
        return `0x${pad(slot)}`;
      }
      case "eth_call": {
        assert.deepEqual(params[1], { blockHash: state.finalized.hash, requireCanonical: true });
        const { to, data } = params[0];
        if (to === V2.blochInc) {
          const text = Buffer.from(state.safeVersion).toString("hex").padEnd(64, "0");
          const safeReply = {
            [sel("getThreshold()")]: `0x${word(state.safeThreshold)}`,
            [sel("getOwners()")]: `0x${word(32)}${word(state.safeOwners.length)}${state.safeOwners.map(pad).join("")}`,
            [`${sel("getModulesPaginated(address,uint256)")}${pad(addr("0").replace(/0$/, "1"))}${word(10)}`]:
              `0x${word(64)}${word(state.safeModuleNext)}${word(state.safeModules.length)}${state.safeModules.map(pad).join("")}`,
            [sel("VERSION()")]: `0x${word(32)}${word(state.safeVersion.length)}${text}`,
          }[data];
          if (safeReply === undefined) throw new Error(`unexpected Safe call ${data}`);
          return safeReply;
        }
        const reply = {
          [`${V2.factory}${sel("INIT_CODE_PAIR_HASH()")}`]: `0x${state.initHash.slice(2)}`,
          [`${V2.factory}${sel("feeTo()")}`]: `0x${pad(state.feeTo)}`,
          [`${V2.factory}${sel("firstDepositor()")}`]: `0x${pad(state.firstDepositor)}`,
          [`${V2.pair}${sel("totalSupply()")}`]: `0x${word(state.totalSupply)}`,
          [`${V2.gsmhPair}${sel("totalSupply()")}`]: `0x${word(state.totalSupply)}`,
          [`${V2.factory}0xbb75fd60${pad(V2.wrapped)}`]: `0x${word(state.caps[V2.wrapped])}`,
          [`${V2.factory}0xbb75fd60${pad(V2.asset)}`]: `0x${word(state.caps[V2.asset])}`,
          [`${V2.factory}0xbb75fd60${pad(V2.gsmh)}`]: `0x${word(state.caps[V2.gsmh])}`,
          [`${V2.factory}0xe6a43905${pad(V2.wrapped)}${pad(V2.asset)}`]: `0x${pad(state.registered)}`,
          [`${V2.factory}0xe6a43905${pad(V2.wrapped)}${pad(V2.gsmh)}`]: `0x${pad(V2.gsmhPair)}`,
          [`${V2.asset}${sel("bucketCapacity()")}`]: `0x${word(state.buckets[V2.asset])}`,
          [`${V2.gsmh}${sel("bucketCapacity()")}`]: `0x${word(state.buckets[V2.gsmh])}`,
          [`${V2.router}${sel("factory()")}`]: `0x${pad(state.routerFactory)}`,
          [`${V2.router}${sel("WBLCH()")}`]: `0x${pad(state.routerWrapped)}`,
          [`${V2.lens}${sel("factory()")}`]: `0x${pad(state.lensFactory)}`,
          [`${V2.pair}${sel("factory()")}`]: `0x${pad(state.pairFactory)}`,
          [`${V2.pair}0x0dfe1681`]: `0x${pad(state.token0)}`,
          [`${V2.pair}0xd21220a7`]: `0x${pad(state.token1)}`,
          [`${V2.pair}0xd3dc9b31`]: `0x${word(state.pairCaps[0])}${word(state.pairCaps[1])}`,
          [`${V2.gsmhPair}${sel("factory()")}`]: `0x${pad(V2.factory)}`,
          [`${V2.gsmhPair}0x0dfe1681`]: `0x${pad(V2.wrapped)}`,
          [`${V2.gsmhPair}0xd21220a7`]: `0x${pad(V2.gsmh)}`,
          [`${V2.gsmhPair}0xd3dc9b31`]: `0x${word(CAP)}${word(GSMH_CAP)}`,
        }[`${to}${data}`];
        if (reply === undefined) throw new Error(`unexpected call ${to} ${data}`);
        return reply;
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

for (const scenario of [
  { name: "schema 1", config: () => config(), rpc: () => rpc().request, height: 214 },
  { name: "schema 2", config: () => configV2(), rpc: () => rpcV2(), height: 300 },
]) {
  const wrap = (mutate) => {
    const base = scenario.rpc();
    let stateRead = false;
    return async (method, params) => {
      if (method === "eth_call" || method === "eth_getCode") stateRead = true;
      const changed = mutate(method, params, stateRead);
      return changed === undefined ? base(method, params) : changed;
    };
  };
  for (const [name, mutate, expected] of [
    ["same-height finalized disagreement", (m) => m === "bloch_finality" ? { finalized: { number: hex(scenario.height), hash: hash("c") } } : undefined, /conflicts/],
    ["higher reported checkpoint outside the canonical chain", (m, p) => {
      if (m === "bloch_finality") return { finalized: { number: hex(scenario.height + 1), hash: hash("c") } };
      if (m === "eth_getBlockByNumber" && p[0] === hex(scenario.height + 1)) return { number: p[0], hash: hash("d") };
    }, /canonical/],
    ["wrong number in a canonical block response", (m, p) => m === "eth_getBlockByNumber" && p[0] === hex(scenario.height) ? { number: hex(scenario.height - 1), hash: hash("b") } : undefined, /canonical/],
    ["chain change during state reads", (m, _p, read) => read && m === "eth_chainId" ? "0x1" : undefined, /chain ID changed/],
    ["genesis change during state reads", (m, p, read) => read && m === "eth_getBlockByNumber" && p[0] === "0x0" ? { number: "0x0", hash: hash("c") } : undefined, /genesis changed/],
    ["finality regression during state reads", (m, p, read) => {
      if (!read) return;
      if (m === "eth_getBlockByNumber" && p[0] === "finalized") return { number: hex(scenario.height - 1), hash: hash("c") };
      if (m === "eth_getBlockByNumber" && p[0] === hex(scenario.height - 1)) return { number: p[0], hash: hash("c") };
    }, /regressed/],
    ["finalized checkpoint rewrite during state reads", (m, p, read) => {
      if (!read) return;
      if (m === "eth_getBlockByNumber" && ["finalized", hex(scenario.height)].includes(p[0])) return { number: hex(scenario.height), hash: hash("c") };
      if (m === "bloch_finality") return { finalized: { number: hex(scenario.height), hash: hash("c") } };
    }, /changed|canonical/],
    ["opening canonical checkpoint disappears during state reads", (m, p, read) => read && m === "eth_getBlockByNumber" && p[0] === hex(scenario.height) ? null : undefined, /unavailable/],
    ["reported finalized checkpoint regresses independently", (m, p, read) => {
      if (!read && m === "bloch_finality") return { finalized: { number: hex(scenario.height + 1), hash: hash("c") } };
      if (m === "eth_getBlockByNumber" && p[0] === hex(scenario.height + 1)) return { number: p[0], hash: hash("c") };
    }, /regressed/],
    ["an older opening checkpoint rewrites when finality advances", (m, p, read) => {
      if (!read) return;
      if (m === "eth_getBlockByNumber" && ["finalized", hex(scenario.height + 1)].includes(p[0])) return { number: hex(scenario.height + 1), hash: hash("c") };
      if (m === "bloch_finality") return { finalized: { number: hex(scenario.height + 1), hash: hash("c") } };
      if (m === "eth_getBlockByNumber" && p[0] === hex(scenario.height)) return { number: p[0], hash: hash("d") };
    }, /canonical/],
  ]) {
    test(`${scenario.name} refuses ${name}`, async () => {
      await assert.rejects(evaluateFinalityGate(scenario.config(), wrap(mutate)), expected);
    });
  }
  test(`${scenario.name} keeps the checked snapshot when finality advances`, async () => {
    let closingObserved = false;
    const request = wrap((method, params, read) => {
      if (!read) return;
      if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
        closingObserved = true;
        return { number: hex(scenario.height + 1), hash: hash("c") };
      }
      if (method === "bloch_finality") return { finalized: { number: hex(scenario.height + 1), hash: hash("c") } };
      if (method === "eth_getBlockByNumber" && params[0] === hex(scenario.height + 1)) return { number: params[0], hash: hash("c") };
    });
    const report = await evaluateFinalityGate(scenario.config(), request);
    assert.deepEqual(report.finalized, { number: String(scenario.height), hash: hash("b") });
    assert.equal(closingObserved, true);
  });
  test(`${scenario.name} accepts a later consistent bloch_finality checkpoint`, async () => {
    const request = wrap((method, params) => {
      if (method === "bloch_finality") return { finalized: { number: hex(scenario.height + 1), hash: hash("c") } };
      if (method === "eth_getBlockByNumber" && params[0] === hex(scenario.height + 1)) return { number: params[0], hash: hash("c") };
    });
    const report = await evaluateFinalityGate(scenario.config(), request);
    assert.deepEqual(report.finalized, { number: String(scenario.height), hash: hash("b") });
  });
}

test("schema 2 enables liquidity only for the exact planned deployment", async () => {
  const report = await evaluateFinalityGate(configV2(), rpcV2());
  assert.equal(report.decision, "liquidity-enabled");
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.pairs.map((p) => p.address), [V2.gsmhPair, V2.pair]);
  assert.equal(report.wrappedReserveCap, CAP.toString());
  assert.equal(report.feeTo, V2.blochInc);
  assert.deepEqual(report.blochIncSafe, { address: V2.blochInc, threshold: 3, owners: OWNERS, singleton: V2.singleton });
});

test("schema 2 pins the Bloch Inc Safe at the finalized block", async () => {
  for (const [change, pattern] of [
    [{ safeSingleton: addr("6") }, /singleton differs/],
    [{ safeHandler: addr("6") }, /fallback handler differs/],
    [{ safeGuard: addr("6") }, /has a guard/],
    [{ code: { ...CODE, [V2.singleton]: "0x5c" } }, /singleton runtime code differs/],
    [{ code: { ...CODE, [V2.handler]: "0x" } }, /fallback handler runtime code differs/],
    [{ safeThreshold: 2n }, /threshold differs/],
    [{ safeThreshold: 5n }, /threshold differs/],
    [{ safeOwners: [...OWNERS.slice(0, 4), addr("6")] }, /owners differ/],
    [{ safeOwners: [...OWNERS, addr("6")] }, /owners differ/],
    [{ safeOwners: Array(OWNERS.length).fill(OWNERS[0]) }, /owners differ/],
    [{ safeModules: [addr("6")] }, /enabled module/],
    [{ safeModuleNext: 2n }, /module page is incomplete/],
    [{ safeVersion: "1.3.0" }, /not version 1.4.1/],
  ]) {
    await assert.rejects(evaluateFinalityGate(configV2(), rpcV2(change)), pattern, Object.keys(change).join(","));
  }
});

test("schema 2 allows a used depositor key once the pair is seeded", async () => {
  const report = await evaluateFinalityGate(configV2(), rpcV2({ totalSupply: 5n, depositorNonce: "0x2" }));
  assert.equal(report.decision, "liquidity-enabled");
});

test("schema 2 requires the Safe pin on the mainnet only", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error("no RPC expected");
  };
  for (const change of [
    (c) => { delete c.deployment.roles.blochInc.safe; },
    (c) => { c.deployment.roles.blochInc.safe.threshold = 0; },
    (c) => { c.deployment.roles.blochInc.safe.threshold = 6; },
    (c) => { c.deployment.roles.blochInc.safe.owners.push(OWNERS[0]); },
    (c) => { c.deployment.roles.blochInc.safe.owners = []; },
    (c) => { c.deployment.roles.blochInc.safe.version = "1.3.0"; },
    (c) => { c.deployment.roles.blochInc.safe.guard = addr("0"); },
    (c) => { c.deployment.roles.blochInc.safe.singleton.codeHash = keccak256("0x"); },
  ]) {
    await assert.rejects(evaluateFinalityGate(configV2(change), request), /finality gate/, String(change));
  }
  assert.equal(calls, 0);
  // A development-chain rehearsal may use a non-Safe stand-in.
  const devnet = configV2((c) => {
    c.chain.id = 700771;
    delete c.deployment.roles.blochInc.safe;
  });
  const report = await evaluateFinalityGate(devnet, rpcV2({ chainId: hex(700771) }));
  assert.equal(report.decision, "liquidity-enabled");
  assert.equal(report.blochIncSafe, undefined);
});

test("schema 2 refuses drift in code, fee recipient, bridges, bindings, caps, pairs or sender", async () => {
  for (const [change, pattern] of [
    [{ chainId: hex(700771) }, /chain ID/],
    [{ receipt: { transactionHash: TX, status: "0x1", from: addr("8"), blockNumber: hex(300), blockHash: hash("b") } }, /not sent by the deployer/],
    [{ receipt: { transactionHash: TX, status: "0x1", blockNumber: hex(300), blockHash: hash("b") } }, /not sent by the deployer/],
    [{ receipt: { transactionHash: TX, status: "0x1", from: V2.deployer, blockNumber: hex(301), blockHash: hash("c") } }, /not finalized/],
    [{ code: { ...CODE, [V2.router]: "0x33" } }, /router runtime code/],
    [{ code: { ...CODE, [V2.asset]: "0x22" } }, /token bUSDC runtime code/],
    [{ code: { ...CODE, [V2.gsmh]: "0x" } }, /token wGSMH runtime code/],
    [{ code: { ...CODE, [V2.pair]: "0x" } }, /runtime code/],
    [{ code: { ...CODE, [V2.blochInc]: "0x" } }, /Bloch Inc multisig runtime code/],
    [{ code: { ...CODE, [V2.blochInc]: "0x0c" } }, /Bloch Inc multisig runtime code/],
    [{ initHash: hash("2") }, /init-code hash/],
    [{ firstDepositor: addr("0") }, /first-deposit rule is off/],
    [{ firstDepositor: addr("8") }, /first depositor differs/],
    [{ depositorNonce: "0x1" }, /not single-purpose/],
    [{ feeTo: addr("0") }, /protocol fee is off/],
    [{ feeTo: addr("8") }, /not Bloch Inc/],
    [{ buckets: { [V2.asset]: BUSDC_BUCKET - 1n, [V2.gsmh]: GSMH_BUCKET } }, /bUSDC bridge bucket capacity differs/],
    [{ buckets: { [V2.asset]: BUSDC_BUCKET, [V2.gsmh]: GSMH_BUCKET * 2n } }, /wGSMH bridge bucket capacity differs/],
    [{ caps: { [V2.wrapped]: CAP, [V2.asset]: 1n, [V2.gsmh]: GSMH_CAP } }, /cap for/],
    [{ caps: { [V2.wrapped]: CAP + 1n, [V2.asset]: BUSDC_CAP, [V2.gsmh]: GSMH_CAP } }, /cap for/],
    [{ routerFactory: addr("8") }, /router serves another factory/],
    [{ routerWrapped: addr("8") }, /router wraps another token/],
    [{ lensFactory: addr("8") }, /lens reads another factory/],
    [{ pairFactory: addr("8") }, /another factory/],
    [{ token1: addr("8") }, /token1 differs/],
    [{ registered: addr("8") }, /does not register/],
    [{ pairCaps: [CAP, 0n] }, /caps differ/],
  ]) {
    await assert.rejects(evaluateFinalityGate(configV2(), rpcV2(change)), pattern, Object.keys(change).join(","));
  }
});

test("schema 2 configuration is validated before any RPC request", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error("no RPC expected");
  };
  for (const change of [
    (c) => { c.deployment.contracts.lens.codeHash = keccak256("0x"); },
    (c) => { c.deployment.contracts.collector = c.deployment.contracts.lens; },
    (c) => { delete c.deployment.contracts.router; },
    (c) => { c.deployment.firstDepositor = addr("0"); },
    (c) => { delete c.deployment.firstDepositor; },
    (c) => { c.deployment.feeTo = addr("8"); },
    (c) => { c.deployment.roles.blochInc.codeHash = keccak256("0x"); },
    (c) => { c.deployment.roles = { feeToSetter: addr("8"), treasury: V2.blochInc }; },
    (c) => { c.deployment.tokens[1].bridgeBucketCapacity = (BUSDC_CAP * 10n - 1n).toString(); },
    (c) => { delete c.deployment.tokens[0].bridgeBucketCapacity; },
    (c) => { c.deployment.reserveCaps = [{ token: V2.asset, cap: "1" }]; c.deployment.tokens = []; },
    (c) => { c.deployment.reserveCaps[0].cap = (CAP * 11n).toString(); },
    (c) => { c.deployment.tokens = []; },
    (c) => { c.deployment.pairs = []; },
    (c) => { c.deployment.pairs[1].token0 = V2.asset; c.deployment.pairs[1].token1 = V2.wrapped; },
    (c) => { c.deployment.pairs = [{ address: V2.pair, token0: V2.wrapped, token1: addr("9"), codeHash: hash("3") }]; },
    (c) => { c.deployment.deployer = V2.deployer.toUpperCase(); },
    (c) => { c.deployment.transactions = [TX, TX]; },
    (c) => { c.deployment.signatures = []; },
    (c) => { c.schemaVersion = 3; },
  ]) {
    await assert.rejects(evaluateFinalityGate(configV2(change), request), /finality gate/, String(change));
  }
  assert.equal(calls, 0);
});

test("N1: a depositor history passes only with every nonce a planned approve or seed", async () => {
  const depositor = V2.depositor;
  const router = V2.router;
  const token = V2.asset;
  const approve = (spender) => `${sel("approve(address,uint256)")}${pad(spender)}${"0".repeat(63)}1`;
  const seed = (t) => `${sel("addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)")}${pad(t)}${"0".repeat(320)}`;
  const check = (txs, count = BigInt(txs.length)) =>
    verifyDepositorHistory({ depositor, count, transactions: txs.map((_, i) => hash(String(i + 1))), router, tokens: [token] }, async (method, [h]) => {
      const tx = txs[Number(h.slice(-1)) - 1];
      return method === "eth_getTransactionByHash" ? tx : tx.mined === false ? null : { status: "0x0" };
    });
  const tx = (nonce, to, input, from = depositor) => ({ nonce: `0x${nonce.toString(16)}`, to, input, from });
  assert.equal(await check([tx(0, token, approve(router)), tx(1, router, seed(token)), tx(2, router, seed(token))]), 3);
  await assert.rejects(check([tx(0, token, approve(addr("8")))]), /not a planned approve or seed/);
  await assert.rejects(check([tx(0, addr("8"), approve(router))]), /not a planned approve or seed/);
  await assert.rejects(check([tx(0, router, seed(addr("8")))]), /not a planned approve or seed/);
  await assert.rejects(check([tx(0, router, "0x12345678")]), /not a planned approve or seed/);
  await assert.rejects(check([tx(0, token, approve(router), addr("8"))]), /not sent by the first depositor/);
  await assert.rejects(check([{ ...tx(0, token, approve(router)), mined: false }]), /not mined/);
  await assert.rejects(check([tx(0, token, approve(router))], 2n), /nonce 1 is not listed/);
  await assert.rejects(check([tx(1, router, seed(token))], 2n), /nonce 0 is not listed/);
});

test("N1: the gate accepts a used key only with a checked history", async () => {
  const seedInput = `${sel("addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)")}${pad(V2.asset)}`;
  const H = hash("7");
  const inner = rpcV2({ depositorNonce: "0x1" });
  const wrap = (input) => async (method, params) => {
    if (method === "eth_getTransactionByHash") return { from: V2.depositor, nonce: "0x0", to: V2.router, input };
    if (method === "eth_getTransactionReceipt" && params[0] === H) return { status: "0x0", transactionHash: H };
    return inner(method, params);
  };
  await assert.rejects(evaluateFinalityGate(configV2(), inner), /not single-purpose/);
  const listed = configV2((c) => { c.deployment.depositorTransactions = [H]; });
  assert.equal((await evaluateFinalityGate(listed, wrap(seedInput))).decision, "liquidity-enabled");
  await assert.rejects(evaluateFinalityGate(listed, wrap("0x12345678")), /not a planned approve or seed/);
});

// ---- agent 227: the bridge token against its own deployment record (agent 180 L-3) ----
const { planAndRecord, testPin, tokenCode, tokenRpc, tokenViews } = await import("./bridge-token-identity.fixture.mjs");

function bridgeCase({ planChange = () => {}, viewOverrides = {} } = {}) {
  const code = tokenCode();
  const { plan, record } = planAndRecord({ token: V2.asset, genesisHash: hash("9"), blockNumber: 300, blockHash: hash("b"), bucket: Number(BUSDC_BUCKET), code });
  planChange(plan, record);
  const inner = rpcV2({ code: { ...CODE, [V2.asset]: code } });
  const token = tokenRpc({ token: V2.asset, code, views: tokenViews(plan.expected, viewOverrides) });
  const request = async (method, params) => token(method, params) ?? inner(method, params);
  const config = configV2((c) => (c.deployment.tokens[1].codeHash = keccak256(code)));
  return { config, request, bridgeTokens: [{ plan, record }] };
}

test("L-3: the schema-2 gate checks the bridged token against the bridge deployment record", async () => {
  const { config, request, bridgeTokens } = bridgeCase();
  const report = await evaluateFinalityGate(config, request, { bridgeTokens, bridgePin: testPin() });
  assert.equal(report.decision, "liquidity-enabled");
  assert.equal(report.bridgeTokens.length, 1);
  assert.equal(report.bridgeTokens[0].address, V2.asset);
  assert.equal(report.bridgeTokens[0].threshold, 5);
  assert.equal(report.bridgeTokens[0].largeMintThreshold, "0");
  // without records the gate behaves as before (the mainnet wrapper requires them)
  assert.equal((await evaluateFinalityGate(config, request)).bridgeTokens, undefined);
});

test("L-3: a look-alike bUSDC (other signers, same code) or T > 0 closes the gate", async () => {
  const lookAlike = bridgeCase({ viewOverrides: { signers: [addr("6"), addr("7"), addr("8"), addr("9"), addr("a"), addr("b"), addr("c")] } });
  await assert.rejects(evaluateFinalityGate(lookAlike.config, lookAlike.request, { bridgeTokens: lookAlike.bridgeTokens, bridgePin: testPin() }), /signers\(\) differ/);
  const otherGuardians = bridgeCase({ viewOverrides: { guardians: [addr("6"), addr("7"), addr("8")] } });
  await assert.rejects(evaluateFinalityGate(otherGuardians.config, otherGuardians.request, { bridgeTokens: otherGuardians.bridgeTokens, bridgePin: testPin() }), /guardians\(\) differ/);
  const t = bridgeCase({ planChange: (p) => (p.expected.largeMintThreshold = 1) });
  await assert.rejects(evaluateFinalityGate(t.config, t.request, { bridgeTokens: t.bridgeTokens, bridgePin: testPin() }), /must be 0/);
  const s1 = bridgeCase();
  await assert.rejects(evaluateFinalityGate(config(), rpc().request, { bridgeTokens: s1.bridgeTokens }), /need a schema-2 gate/);
  const twice = bridgeCase();
  await assert.rejects(evaluateFinalityGate(twice.config, twice.request, { bridgeTokens: [...twice.bridgeTokens, ...twice.bridgeTokens], bridgePin: testPin() }), /listed twice/);
});
