#!/usr/bin/env node
// The chain's market price of the native coin in the listed token, read on that chain (docs/MULTICHAIN-DEPLOY.md,
// "Opening price"). Read-only: eth_call, eth_getCode and block reads. Nothing is signed or sent.
//
//   node scripts/multichain/market.mjs <chain> [--pair WETH/USDC] [--native AMOUNT | --token AMOUNT] [--json]
//                                              [--rpc http://127.0.0.1:PORT --rehearsal]
//
// A pool opened away from the market is traded back to it at the depositor's cost. So the opening price is not typed
// by hand: first-deposit.mjs takes it from here and refuses amounts that are more than `maxDeviationBps` (0.5%) away.
//
// The market is read from TWO INDEPENDENT ON-CHAIN REFERENCES, both configured per chain in
// deployments/<chain>/chain.json `openingPrice.references`, each address taken from its publisher's own page:
//   chainlink  two Chainlink data feeds (aggregated from exchanges by an oracle network, off this chain's pools):
//              NATIVE / USD divided by TOKEN / USD. Each answer must be positive and not older than the feed's
//              heartbeat plus STALE_GRACE_SECONDS at the pinned block.
//   v3-twap    the time-weighted average price, over `windowSeconds`, of an established concentrated-liquidity
//              pool of the wrapped native token and the listed token (`observe`): a price that one transaction,
//              or one block, cannot set. The pool must be the one its publisher's factory names for the two tokens
//              and the fee tier, and must hold liquidity.
// Every read is pinned to ONE block hash and asked of every endpoint given (the two reviewed endpoints); an answer
// counts only when all give the same bytes. The two references must agree with each other within
// `referencesAgreeBps`; when they do not (a feed that lags a fast move, a pool being pushed, a token that left its
// peg), there is no market price and the caller refuses. The market price is the mean of the two.
//
// Exit status: 0 the market was read, 1 it could not be established, 2 usage or configuration.
import { createRequire } from "node:module";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { EMPTY_CODE_HASH, MultichainError, loadChain, loadShared, lower, refuse, retrying } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, parseUnits, formatUnits } = requireFromFrontend("viem");

export const STALE_GRACE_SECONDS = 600;
const E18 = 10n ** 18n;
const ABI = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function getPool(address,address,uint24) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function balanceOf(address) view returns (uint256)",
]);

const absDiff = (a, b) => (a > b ? a - b : b - a);
/** How far `value` is from `reference`, in basis points of the reference, rounded up. Pure. */
export const deviationBps = (value, reference) => (reference === 0n ? 10n ** 9n : (absDiff(value, reference) * 10_000n + reference - 1n) / reference);

/**
 * Token base units per one whole native coin from two Chainlink answers (NATIVE / USD and TOKEN / USD). Pure, exact.
 * `base` and `quote`: { answer, decimals } (bigint, number).
 */
export function chainlinkPrice({ base, quote, tokenDecimals }) {
  refuse(base.answer > 0n && quote.answer > 0n, "a Chainlink answer is not above zero");
  return (base.answer * 10n ** BigInt(quote.decimals) * 10n ** BigInt(tokenDecimals)) / (quote.answer * 10n ** BigInt(base.decimals));
}

/**
 * Token base units per one whole native coin from a v3 pool's two cumulative ticks `windowSeconds` apart. Pure.
 * The mean tick is rounded toward negative infinity, as the publisher's own oracle library does; the price of
 * token1 in token0 base units is 1.0001^tick (a double holds it to 15 digits; the bands here are 1e-3).
 */
export function twapPrice({ tickCumulatives, windowSeconds, wrappedIs0 }) {
  const delta = tickCumulatives[1] - tickCumulatives[0];
  const window = BigInt(windowSeconds);
  let tick = delta / window;
  if (delta < 0n && delta % window !== 0n) tick -= 1n;
  refuse(tick > -887272n && tick < 887272n, "the pool's mean tick is out of range");
  // raw = token1 base units per token0 base unit.
  const raw = Math.exp(Number(tick) * Math.log(1.0001));
  const tokenPerWei = wrappedIs0 ? raw : 1 / raw;
  const price = BigInt(Math.round(tokenPerWei * 1e18));
  refuse(price > 0n, "the pool's mean price rounds to zero");
  return { price, tick: Number(tick) };
}

/** The market from the references' prices: their mean, when they agree within `agreeBps` of the lower one. Pure. */
export function combine(prices, agreeBps) {
  refuse(prices.length === 2 && prices.every((p) => typeof p === "bigint" && p > 0n), "the market needs two references");
  const [low, high] = prices[0] < prices[1] ? prices : [prices[1], prices[0]];
  const spreadBps = deviationBps(high, low);
  return { agree: spreadBps <= BigInt(agreeBps), spreadBps: Number(spreadBps), market: (low + high) / 2n };
}

/** The other side of a deposit at `price` (token base units per whole native coin). Pure; rounds down. */
export const tokenFor = (nativeWei, price) => (nativeWei * price) / E18;
export const nativeFor = (tokenUnits, price) => (tokenUnits * E18) / price;
/** The price of two amounts, in the market's unit. Pure. */
export const priceOf = (nativeWei, tokenUnits) => (tokenUnits * E18) / nativeWei;

/**
 * Read the market at one block. `requests`: one JSON-RPC function per endpoint (all must give the same answer to
 * every read); `at`: { number, hash, timestamp } of the pinned block (hex strings as the endpoint gave them).
 * Returns { ok, problems, references: [{ kind, name, price, ... }], market, spreadBps, block }. Never throws for
 * a reference that cannot be read: it is a problem, and `ok` is false.
 */
export async function readMarket({ chain, token, requests, at }) {
  const config = chain.openingPrice;
  const problems = [];
  const pin = { blockHash: at.hash, requireCanonical: true };
  const now = BigInt(at.timestamp);
  const agreed = async (method, params) => {
    const answers = await Promise.all(requests.map((r) => r(method, params)));
    refuse(answers.every((a) => JSON.stringify(a) === JSON.stringify(answers[0])), `the endpoints give different answers to ${method} at the pinned block`);
    return answers[0];
  };
  const call = async (to, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await agreed("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, pin]) });
  const codeHash = async (address) => {
    const code = await agreed("eth_getCode", [address, pin]);
    return code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
  };
  const references = [];
  for (const ref of config.references) {
    const entry = { kind: ref.kind, name: ref.name };
    try {
      if (ref.kind === "chainlink") {
        const side = async (feed, label) => {
          refuse((await codeHash(feed.proxy)) === feed.codeHash, `the ${label} feed ${feed.proxy} does not hold the pinned code`);
          refuse((await call(feed.proxy, "description")) === feed.description, `the ${label} feed does not describe itself as ${feed.description}`);
          refuse(Number(await call(feed.proxy, "decimals")) === feed.decimals, `the ${label} feed's decimals are not ${feed.decimals}`);
          const [, answer, , updatedAt] = await call(feed.proxy, "latestRoundData");
          refuse(answer > 0n, `the ${label} feed's answer is not above zero`);
          const age = now - updatedAt;
          refuse(age <= BigInt(feed.heartbeatSeconds + STALE_GRACE_SECONDS), `the ${label} feed's answer is ${age} s old at the pinned block (heartbeat ${feed.heartbeatSeconds} s plus ${STALE_GRACE_SECONDS} s): stale`);
          return { answer, decimals: feed.decimals, ageSeconds: Number(age) };
        };
        const base = await side(ref.base, ref.base.description);
        const quote = await side(ref.quote, ref.quote.description);
        entry.price = chainlinkPrice({ base, quote, tokenDecimals: token.decimals });
        entry.detail = { [ref.base.description]: formatUnits(base.answer, base.decimals), [ref.quote.description]: formatUnits(quote.answer, quote.decimals), ageSeconds: [base.ageSeconds, quote.ageSeconds] };
      } else {
        const wrapped = chain.wrappedNative.address;
        refuse((await codeHash(ref.factory)) === ref.factoryCodeHash, `the factory ${ref.factory} does not hold the pinned code`);
        refuse(lower(await call(ref.factory, "getPool", [wrapped, token.address, ref.fee])) === lower(ref.pool), `the pool ${ref.pool} is not the one the factory ${ref.factory} names for ${chain.wrappedNative.symbol}, ${token.symbol} and fee ${ref.fee}`);
        refuse((await codeHash(ref.pool)) === ref.poolCodeHash, `the pool ${ref.pool} does not hold the pinned code`);
        const [token0, token1] = [await call(ref.pool, "token0"), await call(ref.pool, "token1")];
        const wrappedIs0 = lower(token0) === lower(wrapped);
        refuse((wrappedIs0 ? lower(token1) === lower(token.address) : lower(token0) === lower(token.address) && lower(token1) === lower(wrapped)), "the pool's tokens are not the wrapped native token and the listed token");
        const liquidity = await call(ref.pool, "liquidity");
        refuse(liquidity > 0n, "the pool has no liquidity in range");
        const held = await call(wrapped, "balanceOf", [ref.pool]);
        refuse(held >= parseUnits(ref.minimumWrapped, 18), `the pool holds ${formatUnits(held, 18)} ${chain.wrappedNative.symbol}, less than the ${ref.minimumWrapped} that make it a reference`);
        const [tickCumulatives] = await call(ref.pool, "observe", [[ref.windowSeconds, 0]]);
        const twap = twapPrice({ tickCumulatives, windowSeconds: ref.windowSeconds, wrappedIs0 });
        entry.price = twap.price;
        entry.detail = { pool: ref.pool, meanTick: twap.tick, windowSeconds: ref.windowSeconds, wrappedHeld: formatUnits(held, 18) };
      }
    } catch (error) {
      entry.problem = String(error?.message ?? error).replace(/^multichain: /, "").slice(0, 300);
      problems.push(`${ref.name}: ${entry.problem}`);
    }
    references.push(entry);
  }
  const out = { ok: false, problems, references, block: { number: Number(BigInt(at.number)), hash: at.hash, timestamp: Number(now) }, maxDeviationBps: config.maxDeviationBps, referencesAgreeBps: config.referencesAgreeBps };
  if (problems.length === 0) {
    const combined = combine(references.map((r) => r.price), config.referencesAgreeBps);
    out.spreadBps = combined.spreadBps;
    if (!combined.agree) problems.push(`the two references differ by ${(combined.spreadBps / 100).toFixed(2)}%, more than the ${config.referencesAgreeBps / 100}% within which they must agree: there is no market price now; try again later`);
    else {
      out.market = combined.market;
      out.ok = true;
    }
  }
  return out;
}

/** A market as it is written into a file: bigints as decimal strings. */
export const marketRecord = (m) => JSON.parse(JSON.stringify(m, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

/** One block every endpoint has: the first endpoint's head, which the others must hold with the same hash. */
export async function pinnedBlock(requests) {
  const head = await requests[0]("eth_getBlockByNumber", ["latest", false]);
  for (const other of requests.slice(1)) {
    let same = null;
    for (let i = 0; i < 10 && same === null; i++) {
      same = (await other("eth_getBlockByNumber", [head.number, false]).catch(() => null))?.hash ?? null;
      if (same === null) await new Promise((r) => setTimeout(r, 1500));
    }
    refuse(same === head.hash, "the reviewed endpoints do not have the same block at the head's height");
  }
  return head;
}

/** The token of a planned pair that is not the wrapped native token. */
export function listedTokenOf(chain, pairName) {
  const [a, b] = pairName.split("/");
  const w = chain.wrappedNative.symbol;
  refuse(a === w || b === w, `the pair must contain ${w}`);
  const token = chain.tokens.find((t) => t.symbol === (a === w ? b : a));
  refuse(token, `${pairName} names a token that is not listed`);
  return token;
}

export async function main(argv, print = console.log) {
  const usage = "usage: market.mjs <chain> [--pair A/B] [--native AMOUNT | --token AMOUNT] [--json] [--rpc URL --rehearsal]";
  const [key, ...rest] = argv;
  refuse(key && !key.startsWith("--"), usage);
  const o = { rehearsal: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--rehearsal") o.rehearsal = true;
    else if (rest[i] === "--json") o.json = true;
    else if (["--pair", "--native", "--token", "--rpc"].includes(rest[i])) {
      refuse(rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"), `${rest[i]} needs a value`);
      o[rest[i].slice(2)] = rest[++i];
    } else refuse(false, `unknown option ${rest[i]}\n${usage}`);
  }
  refuse(!o.rpc || o.rehearsal, "--rpc replaces the chain's reviewed endpoints and is for a rehearsal only: add --rehearsal");
  refuse(!o.rehearsal || /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(o.rpc ?? ""), "--rehearsal needs --rpc http://127.0.0.1:PORT (a loopback fork)");
  refuse(!(o.native && o.token), "give one side: --native or --token");
  const shared = loadShared();
  refuse(shared.chains.includes(key), `${key} is not in deployments/multichain.json chains`);
  const chain = loadChain(key);
  const pairName = o.pair ?? `${chain.initialPairs[0].tokenA}/${chain.initialPairs[0].tokenB}`;
  const token = listedTokenOf(chain, pairName);
  // The first two reviewed endpoints (a third is listed on three chains for the page's sake).
  const requests = (o.rehearsal ? [o.rpc] : chain.rpc.slice(0, 2)).map((url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 })));
  const at = await pinnedBlock(requests);
  const market = await readMarket({ chain, token, requests, at });
  const coin = chain.nativeCurrency.symbol;
  const text = (p) => `${formatUnits(p, token.decimals)} ${token.symbol}`;
  const result = { schema: "postern.dex.multichain-market.v1", chain: key, pair: pairName, endpoints: requests.length, ...marketRecord(market) };
  if (market.ok && (o.native || o.token)) {
    const native = o.native ? parseUnits(o.native, 18) : nativeFor(parseUnits(o.token, token.decimals), market.market);
    const amount = o.token ? parseUnits(o.token, token.decimals) : tokenFor(native, market.market);
    result.amounts = { native: native.toString(), token: amount.toString(), nativeText: formatUnits(native, 18), tokenText: formatUnits(amount, token.decimals) };
  }
  if (o.json) print(JSON.stringify(result, null, 2));
  else {
    print(`${chain.chain.name}, block ${market.block.number} (${at.hash}), read from ${requests.length} endpoint${requests.length === 1 ? "" : "s"} that gave the same answers`);
    for (const r of market.references) print(`${r.problem ? "FAIL" : "ok  "} ${r.name}: ${r.problem ?? `1 ${coin} = ${text(r.price)}  ${JSON.stringify(r.detail)}`}`);
    if (market.ok) {
      print(`market: 1 ${coin} = ${text(market.market)} (the two references are ${(market.spreadBps / 100).toFixed(2)}% apart; they must agree within ${market.referencesAgreeBps / 100}%)`);
      if (result.amounts) print(`at that price: ${result.amounts.nativeText} ${coin} + ${result.amounts.tokenText} ${token.symbol}`);
    } else print(`NO MARKET PRICE: ${market.problems.join("; ")}`);
  }
  return market.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof MultichainError ? error.message : error);
      process.exit(2);
    },
  );
}
