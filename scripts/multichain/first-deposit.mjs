#!/usr/bin/env node
// The owner's deposits on a public chain (docs/MULTICHAIN-DEPLOY.md, "Opening a pool"). Read-only: it checks the
// chain and prints the exact transactions; it signs and sends nothing. Reviews R309-MC-1 and R328-1 to R328-3: a
// pool is opened only through this path.
//
//   node scripts/multichain/first-deposit.mjs <chain> prepare --pair WETH/USDC --native 10 --gate-report FILE [--to ADDRESS] [--out FILE]
//                                             (or --token AMOUNT instead of --native: ONE side; the tool computes the other at the market price)
//   node scripts/multichain/first-deposit.mjs <chain> verify  --pair WETH/USDC --native 10 --token 30000 --tx HASH [--out FILE]
//   node scripts/multichain/first-deposit.mjs <chain> add     --pair WETH/USDC --native 1 --token 3000 [--tolerance-bps 50] --gate-report FILE [--to ADDRESS] [--out FILE]
//   every mode: [--reference] [--rpc http://127.0.0.1:PORT --rehearsal]
//
// What protects the opening on a chain with a public mempool, and what does not:
//   1. The factory's `firstDepositor` is the owner's depositing account (never the zero address, never the fee
//      address: lib.mjs refuses both). The pair refuses a first mint whose sender and transaction origin are both
//      someone else, so nobody else can open the pool by a transaction of their own.
//   2. The pair accepts a first mint by transaction ORIGIN. A contract that the depositing account calls could
//      open a pool in its name, at any price (review R328-1). So the depositing account is a dedicated key that
//      sends only what this tool prints; `prepare` refuses an account with code or an EIP-7702 delegation; a pool
//      that is already open when `prepare` runs was NOT opened by this tool and `prepare` says STOP; `verify` and
//      the gate prove the opening from its transaction (opening.mjs); `add` deposits only into a pool the gate
//      proved, and only at the price the owner states.
//   3. The deployment creates no pair. The first deposit goes through the router, which creates the pair and
//      deposits in ONE transaction; when someone created the (empty) pair first, the same call just deposits.
//   4. The minimums of the first deposit EQUAL the amounts. This tool prints no other minimums and has no option
//      for them: if the pool were already open, at any price, the transaction would revert instead of depositing.
//   5. What the minimums do NOT see: tokens sent to the pair's address before the deposit is mined (review
//      R328-2). The router takes the two amounts and the pair counts whatever else sits at its address as part of
//      the first deposit. Such a "gift" belongs to the pool, so to the depositor's shares: it is always a loss
//      for whoever sent it. It moves the opening price by its size. `prepare` accepts a gift of at most 0.1% of
//      either side and says so (one base unit sent again and again must not block the opening, review R328-3),
//      and refuses a larger one with the skim command that takes it out; `verify` reads from the opening
//      transaction what joined the pool and states the opening price.
//   6. The opening PRICE is the chain's market price, not a number typed by hand (decision of 2026-11-17).
//      `prepare` reads the market on that chain from two independent on-chain references at one block that two
//      endpoints agree on (market.mjs: a Chainlink feed pair and an established pool's time-weighted price,
//      configured per chain in chain.json `openingPrice`), and they must agree with each other. The owner gives
//      ONE amount and the tool computes the other. When both amounts are given they are refused if their price
//      is more than 0.5% from the market. No market price (a stale feed, references apart): nothing is printed.
//      The SIZE of the deposit is the owner's; the tool refuses less than the chain's stated minimum.
//      Each planned pair has its own two references (round 20: lib.mjs `openingPriceFor`); a pair is never
//      priced by another pair's.
//   7. What the TOKEN can do (round 20, docs/MULTICHAIN-DEPLOY.md section 2.6). `prepare` and `add` read, at the
//      same block and from the endpoints that must agree: the token's transfer-fee parameters where it has them
//      (Tether on Ethereum: `basisPointsRate`, `maximumFee`), which must be zero; its declared switches (`paused`,
//      `deprecated`), which must be off; its issuer's blocklist for the pair, the router and the depositing
//      account; and the allowance the router already has. A token whose `approve` reverts on a change from one
//      non-zero allowance to another (Tether on Ethereum) gets `approve 0` printed first, or no approve at all
//      when the allowance already is the amount.
// `add` is for a pool that is already open and proven: the owner gives both amounts at the market price; the tool
// refuses when the pool's own price differs from them by more than the tolerance (default 0.5%, at most 1%), and
// the deposit's minimums are that tolerance below its amounts.
//
// Exit status: 0 the checks held (prepare, add: the transactions were printed; verify: the opening is proven),
// 1 a check failed (nothing to send), 2 usage or configuration.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import {
  EMPTY_CODE_HASH, GATE_DOMAIN, MultichainError, ZERO_ADDRESS, checksummed, loadArtifacts, loadChain, loadShared, lower, openingPriceFor, pinnedStateReader, planChain, refuse, retrying,
  ownerToolsCheck,
} from "./lib.mjs";
import { approvalSteps, blocklistState, tokenBehaviourState } from "./token-behaviour.mjs";
import { deviationBps, marketRecord, nativeFor, priceOf, readMarket, tokenFor } from "./market.mjs";
import { decodeDeposit, openingRecord, priceShiftBps, readOpening } from "./opening.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, parseUnits, formatUnits } = requireFromFrontend("viem");

export const ABI = parseAbi([
  "function firstDepositor() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function skim(address)",
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
]);
export const DEADLINE_SECONDS = 20 * 60;
export const MAX_TOLERANCE_BPS = 100;
/**
 * Tokens at the pair's address before the first deposit (a gift to the opening pool) that `prepare` accepts and
 * `verify` reports without a warning: at most 0.1% of either side of the deposit.
 */
export const DONATION_BPS = 10n;
/**
 * The share supply a first deposit must create, sqrt(native x token) in base units: the pair locks 1,000 units for
 * ever, and with at least 10^12 they are at most a billionth of the pool.
 */
export const MIN_OPENING_SHARES = 10n ** 12n;

/**
 * The two amounts of a first deposit from what the owner gave and the market. Pure.
 * `given`: { native?, token? } in base units (one or both); `market`: token base units per whole native coin.
 * Returns { native, token, computed: "token" | "native" | null, priceBps } or throws MultichainError with the reason.
 */
export function openingAmounts({ given, market, maxDeviationBps, minimumNative }) {
  refuse(typeof market === "bigint" && market > 0n, "there is no market price");
  refuse(given.native !== undefined || given.token !== undefined, "give the amount of one side: --native or --token");
  const native = given.native ?? nativeFor(given.token, market);
  const token = given.token ?? tokenFor(native, market);
  refuse(native > 0n && token > 0n, "the amounts are too small");
  const priceBps = Number(deviationBps(priceOf(native, token), market));
  refuse(priceBps <= maxDeviationBps, `the opening price of these amounts is ${(priceBps / 100).toFixed(2)}% from the chain's market price, more than the ${maxDeviationBps / 100}% allowed. Give ONE amount and let the tool compute the other`);
  refuse(native >= minimumNative, `the deposit is below this chain's minimum of ${minimumNative} wei of the native coin (deployments/<chain>/chain.json openingPrice.minimumNative, with the reason)`);
  refuse(native * token >= MIN_OPENING_SHARES * MIN_OPENING_SHARES, "the deposit would create fewer than 10^12 share units: too small");
  return { native, token, computed: given.token === undefined ? "token" : given.native === undefined ? "native" : null, priceBps };
}
/** True when what sits at the pair's address is within DONATION_BPS of the deposit, on both sides. Pure. */
export const giftWithinTolerance = (gift, deposit) => gift.native * 10_000n <= deposit.native * DONATION_BPS && gift.token * 10_000n <= deposit.token * DONATION_BPS;

const codeHashOf = (code) => (code === "0x" ? EMPTY_CODE_HASH : keccak256(code));

/**
 * The transactions of a first deposit, with minimums equal to the amounts. Pure.
 * `native` and `token` are base units (bigint); `deadline` is a unix time.
 */
export function openingTransactions({ router, token, native, tokenAmount, to, deadline }) {
  refuse(native > 0n && tokenAmount > 0n, "both amounts must be above zero");
  return [
    { step: "approve", to: token, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [router, tokenAmount] }), signature: "approve(address,uint256)", args: [router, tokenAmount.toString()] },
    {
      step: "deposit",
      to: router,
      value: native,
      // amountTokenMin = amountTokenDesired and amountBLCHMin = the value sent: a pool that is not empty, or any
      // other price, makes the router revert (BDEX: INSUFFICIENT_A_AMOUNT / INSUFFICIENT_B_AMOUNT).
      data: encodeFunctionData({ abi: ABI, functionName: "addLiquidityBLCH", args: [token, tokenAmount, tokenAmount, native, to, deadline] }),
      signature: "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)",
      args: [token, tokenAmount.toString(), tokenAmount.toString(), native.toString(), to, deadline.toString()],
    },
  ];
}

/** True when a deposit call carries minimums equal to its amounts (what the proof of an opening requires). */
export const hasStrictMinimums = (data, value) => decodeDeposit(data, value)?.strict === true;

/**
 * The transactions as they are printed, given the allowance the router already has (round 20). `transactions` is
 * what `openingTransactions` or `addTransactions` returned: one approve of the exact amount, then the deposit. For
 * a token whose approve reverts on a non-zero to non-zero change (`zeroFirst`: Tether on Ethereum) the approve is
 * replaced by what works from the allowance that stands: nothing when it already is the amount, `approve 0` and
 * then the amount when it is another non-zero value. The deposit is never changed. Pure.
 */
export function withApprovals({ transactions, router, zeroFirst, allowance }) {
  const [approve, ...rest] = transactions;
  refuse(approve?.step === "approve" && rest.length === 1 && rest[0].step === "deposit", "the transactions are one approve and one deposit");
  const amount = BigInt(approve.args[1]);
  const steps = approvalSteps({ zeroFirst, allowance, amount });
  const approvals = steps.map(({ step, amount: value }) => ({ step, to: approve.to, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [router, value] }), signature: "approve(address,uint256)", args: [router, value.toString()] }));
  return [...approvals, ...rest];
}

/**
 * A later deposit into an open pool. The owner states BOTH amounts, at the market price (`expectedToken` for
 * `native`); the pool asks its own token amount for that native amount, and the deposit is refused when the two
 * differ by more than `toleranceBps`: a pool whose price was moved, or was never the owner's, takes nothing
 * (review R328-1). The deposit's minimums are `toleranceBps` below its amounts. Pure.
 */
export function addTransactions({ router, token, native, expectedToken, reserveNative, reserveToken, toleranceBps, to, deadline }) {
  refuse(Number.isInteger(toleranceBps) && toleranceBps >= 0 && toleranceBps <= MAX_TOLERANCE_BPS, `--tolerance-bps is a whole number from 0 to ${MAX_TOLERANCE_BPS}`);
  refuse(native > 0n && reserveNative > 0n && reserveToken > 0n, "the pool is not open, or the amount is zero");
  refuse(typeof expectedToken === "bigint" && expectedToken > 0n, "the token amount the owner expects for the native amount is required (--token)");
  const tokenAmount = (native * reserveToken) / reserveNative;
  refuse(tokenAmount > 0n, "the amount is too small for this pool");
  const away = tokenAmount > expectedToken ? tokenAmount - expectedToken : expectedToken - tokenAmount;
  refuse(
    away * 10_000n <= expectedToken * BigInt(toleranceBps),
    `the pool's price is not the price of the amounts given: for that native amount the pool asks ${tokenAmount} token base units, the amounts say ${expectedToken} (${((Number(away) / Number(expectedToken)) * 100).toFixed(2)}% apart, tolerance ${toleranceBps / 100}%). Nothing to send: the pool's price was moved, or the amounts are not the market's`,
  );
  const floor = (n) => (n * BigInt(10_000 - toleranceBps)) / 10_000n;
  return [
    { step: "approve", to: token, value: 0n, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [router, tokenAmount] }), signature: "approve(address,uint256)", args: [router, tokenAmount.toString()] },
    {
      step: "deposit",
      to: router,
      value: native,
      data: encodeFunctionData({ abi: ABI, functionName: "addLiquidityBLCH", args: [token, tokenAmount, floor(tokenAmount), floor(native), to, deadline] }),
      signature: "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)",
      args: [token, tokenAmount.toString(), floor(tokenAmount).toString(), floor(native).toString(), to, deadline.toString()],
    },
  ];
}

function parseArgs(argv) {
  const usage = "usage: first-deposit.mjs <chain> prepare --pair A/B --native AMOUNT | --token AMOUNT --gate-report FILE [--to ADDRESS] [--out FILE]\n       first-deposit.mjs <chain> verify|add --pair A/B --native AMOUNT --token AMOUNT [--gate-report FILE] [--to ADDRESS] [--tx HASH] [--tolerance-bps N] [--out FILE] [--reference] [--rpc URL --rehearsal]";
  const [key, mode, ...rest] = argv;
  refuse(key && ["prepare", "verify", "add"].includes(mode), usage);
  const o = { key, mode, reference: false, rehearsal: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--reference") o.reference = true;
    else if (rest[i] === "--rehearsal") o.rehearsal = true;
    else if (["--pair", "--native", "--token", "--gate-report", "--to", "--tx", "--tolerance-bps", "--out", "--rpc"].includes(rest[i])) {
      refuse(rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"), `${rest[i]} needs a value`);
      o[rest[i].slice(2)] = rest[++i];
    } else refuse(false, `unknown option ${rest[i]} (there is no option for other minimums)\n${usage}`);
  }
  refuse(o.pair && (o.native || (o.mode === "prepare" && o.token)), usage);
  refuse(!o.rpc || o.rehearsal, "--rpc replaces the chain's reviewed endpoints and is for a rehearsal only: add --rehearsal");
  refuse(!o.rehearsal || /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(o.rpc ?? ""), "--rehearsal needs --rpc http://127.0.0.1:PORT (a loopback fork)");
  refuse(o.mode === "verify" || o["gate-report"], "--gate-report FILE is required: the report of a passed `gate.mjs <chain> post`, so that money goes only into the verified contracts");
  refuse(o.mode === "prepare" || o.token !== undefined, o.mode === "add" ? "--token AMOUNT is required: the token amount you expect for that native amount at the market price. The tool refuses when the pool's own price is not that price" : "--token AMOUNT is required");
  refuse(o.mode !== "verify" || o.tx !== undefined, "--tx HASH is required: the hash of the deposit transaction. The opening is proven from that transaction, not from the pool's reserves, which change with the first swap");
  refuse(o.mode === "verify" || o.tx === undefined, "--tx belongs to verify");
  refuse(o.mode !== "add" || o["tolerance-bps"] === undefined || /^[0-9]{1,3}$/.test(o["tolerance-bps"]), "--tolerance-bps is a whole number");
  return o;
}

/** Review R369-13: how far the head the deposit tool reads at may lie behind another endpoint's head (Linea makes a
 * block only when there is work, up to 82 s apart when measured; the printed deposit's deadline is 20 minutes). */
export const HEAD_AGE_BOUND_SECONDS = 300;

export async function main(argv, print = console.log, toolsCheck = null) {
  const o = parseArgs(argv);
  // Review R402-5: `prepare` prints the lines the depositing key will sign. On a public chain it first runs the
  // owner tools check itself (the command line passes it; a loopback rehearsal has no owner key and skips it).
  if (o.mode === "prepare" && !o.rehearsal && toolsCheck) {
    const tools = toolsCheck();
    if (!tools.ok) print(tools.output.trimEnd());
    refuse(tools.ok, `the owner tools check did not pass on ${tools.directory} (docs/OWNER-DEPLOY-NOW.md, "Your own tools"); nothing was printed to send`);
    print(`owner tools: PASS (${tools.directory})`);
  }
  const shared = loadShared();
  refuse(shared.chains.includes(o.key), `${o.key} is not in deployments/multichain.json chains`);
  const chain = loadChain(o.key);
  const plan = planChain(shared, chain, loadArtifacts(), { reference: o.reference });
  refuse(!plan.reference || o.rehearsal, "a reference plan (owner choices open) is for a rehearsal only");
  const depositor = plan.arguments.firstDepositor;
  refuse(lower(depositor) !== ZERO_ADDRESS, "the plan has open first deposits");
  const [a, b] = o.pair.split("/");
  const planned = plan.pairs.find((p) => (p.tokenA === a && p.tokenB === b) || (p.tokenA === b && p.tokenB === a));
  refuse(planned, `${o.pair} is not a planned pair of ${o.key} (deployments/${o.key}/chain.json initialPairs)`);
  const wrapped = chain.wrappedNative;
  refuse(a === wrapped.symbol || b === wrapped.symbol, `this tool deposits the native coin: the pair must contain ${wrapped.symbol}`);
  const token = chain.tokens.find((t) => t.symbol === (a === wrapped.symbol ? b : a));
  const decimal = (text, decimals, field) => {
    refuse(/^[0-9]+(\.[0-9]+)?$/.test(text), `${field} is a decimal amount, for example 10 or 0.5`);
    refuse((text.split(".")[1] ?? "").length <= decimals, `${field} has more decimals than the token (${decimals})`);
    const value = parseUnits(text, decimals);
    refuse(value > 0n, `${field} must be above zero`);
    return value;
  };
  // prepare: one side is enough, the other comes from the market (below). verify and add: both are given.
  let native = o.native === undefined ? undefined : decimal(o.native, 18, "--native");
  let tokenAmount = o.token === undefined ? undefined : decimal(o.token, token.decimals, "--token");
  const to = o.to ? checksummed(o.to, "--to") : depositor;
  refuse(lower(to) !== ZERO_ADDRESS && lower(to) !== lower(planned.address), "--to must be an account that will hold the LP shares");
  const { router, factory } = plan.contracts;

  const urls = o.rehearsal ? [o.rpc] : chain.rpc;
  const [request, ...others] = urls.map((url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 })));
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    print(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
    return Boolean(ok);
  };
  // One block for every read: the head as the first endpoint has it; the other endpoints must have the same block.
  const head = await request("eth_getBlockByNumber", ["latest", false]);
  const at = head.number;
  check("the endpoint reports the pinned chain id", Number(BigInt(await request("eth_chainId", []))) === chain.chain.chainId);
  for (const other of others) {
    let same = null;
    for (let i = 0; i < 10 && same === null; i++) {
      same = (await other("eth_getBlockByNumber", [at, false]).catch(() => null))?.hash ?? null;
      if (same === null) await new Promise((r) => setTimeout(r, 1500));
    }
    check("the other reviewed endpoint has the same block at that height", same === head.hash, same);
  }
  // Review R369-13: the head is the first endpoint's choice; an old canonical block would pass the check above.
  if (others.length) {
    const heads = await Promise.all(others.map((r) => r("eth_getBlockByNumber", ["latest", false]).then((b) => b?.timestamp ?? null, () => null)));
    const newest = [head.timestamp, ...heads].filter((t) => typeof t === "string").map((t) => Number(BigInt(t))).reduce((a, b) => Math.max(a, b), 0);
    const age = newest - Number(BigInt(head.timestamp));
    check(`the block read at is at most ${HEAD_AGE_BOUND_SECONDS} s behind the newest head of the reviewed endpoints (it is ${age} s)`, age <= HEAD_AGE_BOUND_SECONDS, heads);
  }
  // Every state answer at that block's HASH, from every endpoint; used only when two (one in a loopback rehearsal)
  // answered and all that answered agree (review R369-1). The market read below does the same itself.
  const pinned = pinnedStateReader([request, ...others], head.hash);
  const call = async (target, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await pinned("eth_call", [{ to: target, data: encodeFunctionData({ abi: ABI, functionName, args }) }, "pinned"]) });
  const codeAt = async (address) => codeHashOf(await pinned("eth_getCode", [address, "pinned"]));

  if (o["gate-report"]) {
    const report = JSON.parse(readFileSync(o["gate-report"], "utf8"));
    check(
      "the gate report is a passed post gate of this chain and this plan",
      report.domain === GATE_DOMAIN && report.phase === "post" && report.decision === "pass" && report.failed?.length === 0 && report.chain?.chainId === chain.chain.chainId &&
        report.chain?.genesisHash === chain.chain.genesisHash && lower(report.plan?.contracts?.factory?.address ?? "") === lower(factory.address) &&
        lower(report.plan?.contracts?.router?.address ?? "") === lower(router.address) && Boolean(report.rehearsal) === o.rehearsal && Boolean(report.referencePlan) === plan.reference,
    );
    if (o.mode === "add") {
      // Only into a pool whose opening the gate proved (opened by the first depositor's own strict deposit).
      const entry = (report.pairs ?? []).find((p) => lower(p.address ?? "") === lower(planned.address));
      check("the gate report shows this pool open, with its opening proven", entry?.state === "open" && entry.opening?.proven === true, "run `gate.mjs <chain> post --opening PAIR=HASH` after the first deposit; a pool the gate cannot prove is not the owner's opening");
    }
  }
  check("the factory holds the planned code", (await codeAt(factory.address)) === factory.runtimeCodeHash);
  check("the router holds the planned code", (await codeAt(router.address)) === router.runtimeCodeHash);
  const onChainDepositor = await call(factory.address, "firstDepositor").catch(() => null);
  check(`factory.firstDepositor() is the planned depositing account ${depositor}`, typeof onChainDepositor === "string" && lower(onChainDepositor) === lower(depositor) && lower(onChainDepositor) !== ZERO_ADDRESS, onChainDepositor);
  const [token0, token1] = [planned.token0, planned.token1];
  const wrappedIs0 = lower(token0) === lower(wrapped.address);
  const created = lower(await call(factory.address, "getPair", [token0, token1]).catch(() => ZERO_ADDRESS)) === lower(planned.address);
  const balances = [await call(token0, "balanceOf", [planned.address]), await call(token1, "balanceOf", [planned.address])];
  let supply = 0n;
  let reserves = [0n, 0n];
  if (created) {
    check("the pair holds the release candidate's pair code", (await codeAt(planned.address)) === plan.pair.runtimeCodeHash);
    supply = await call(planned.address, "totalSupply");
    reserves = (await call(planned.address, "getReserves")).slice(0, 2);
  }
  const side = (pair) => (wrappedIs0 ? { native: pair[0], token: pair[1] } : { native: pair[1], token: pair[0] });
  const state = supply > 0n ? "open" : balances.some((x) => x > 0n) ? "donated" : created ? "empty" : "absent";
  print(`pair ${o.pair} ${planned.address}: ${state} at block ${Number(BigInt(at))}`);
  const amountText = (n, t) => `${formatUnits(n, t.decimals)} ${t.symbol}`;
  const nativeText = (n) => `${formatUnits(n, 18)} ${chain.nativeCurrency.symbol}`;
  const deadline = BigInt(head.timestamp) + BigInt(DEADLINE_SECONDS);
  const result = { schema: "postern.dex.multichain-deposit.v1", chain: chain.chain.key, chainId: chain.chain.chainId, mode: o.mode, pair: { name: o.pair, address: planned.address, state }, block: { number: Number(BigInt(at)), hash: head.hash }, depositor, to };

  const price = (pool) => (pool.native > 0n ? formatUnits((pool.token * 10n ** 18n) / pool.native, token.decimals) : "?");
  if (o.mode === "prepare") {
    // The opening price is the chain's market price, read here and now, at the same block as everything else and
    // from the first two reviewed endpoints, which must give the same answers.
    const rule = openingPriceFor(chain, token);
    const market = await readMarket({ chain, token, requests: [request, ...others].slice(0, 2), at: head });
    result.market = marketRecord(market);
    for (const r of market.references) print(`     ${r.name}: ${r.problem ?? `1 ${chain.nativeCurrency.symbol} = ${formatUnits(r.price, token.decimals)} ${token.symbol}`}`);
    check(`the chain's market price is established: two independent on-chain references agree within ${rule.referencesAgreeBps / 100}%`, market.ok, market.problems.join("; "));
    let amounts = null;
    if (market.ok) {
      print(`     market: 1 ${chain.nativeCurrency.symbol} = ${formatUnits(market.market, token.decimals)} ${token.symbol} at block ${market.block.number} (references ${(market.spreadBps / 100).toFixed(2)}% apart)`);
      try {
        amounts = openingAmounts({ given: { native, token: tokenAmount }, market: market.market, maxDeviationBps: rule.maxDeviationBps, minimumNative: parseUnits(rule.minimumNative, 18) });
        check(`the opening price is within ${rule.maxDeviationBps / 100}% of the market, and the deposit is at least the chain's minimum (${rule.minimumNative} ${chain.nativeCurrency.symbol})`, true);
      } catch (error) {
        if (!(error instanceof MultichainError)) throw error;
        check(`the opening price is within ${rule.maxDeviationBps / 100}% of the market, and the deposit is at least the chain's minimum (${rule.minimumNative} ${chain.nativeCurrency.symbol})`, false, error.message.replace(/^multichain: /, ""));
      }
    }
    if (!amounts) {
      // Nothing can be printed without both amounts at a market price.
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      result.checks = checks;
      result.decision = "fail";
      if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`);
      print(`multichain prepare ${o.key} ${o.pair}: FAIL; nothing to send (${failed.length} check${failed.length === 1 ? "" : "s"} failed)`);
      return 1;
    }
    ({ native, token: tokenAmount } = amounts);
    result.amounts = { native: native.toString(), token: tokenAmount.toString(), nativeText: formatUnits(native, 18), tokenText: formatUnits(tokenAmount, token.decimals), computed: amounts.computed, fromMarketBps: amounts.priceBps };
    if (amounts.computed) print(`     computed at the market price: ${amounts.computed === "token" ? amountText(tokenAmount, token) : nativeText(native)} for the ${amounts.computed === "token" ? nativeText(native) : amountText(tokenAmount, token)} given`);
  }
  if (o.mode === "verify") {
    // From the deposit transaction itself, not from the reserves (they change with the first swap).
    refuse(/^0x[0-9a-fA-F]{64}$/.test(o.tx), "--tx is a transaction hash");
    const opening = await readOpening({ request, others, hash: o.tx.toLowerCase(), pair: planned.address, router: router.address, depositor, token: token.address, wrappedIs0 });
    check("the pool is open", state === "open");
    check("the transaction is the pair's first mint, sent by the first depositor straight to the router, with minimums equal to its amounts", opening.proven, opening.problems.join("; "));
    result.opening = openingRecord(opening);
    if (opening.deposited) {
      check(`it deposited the ${nativeText(native)} given`, opening.deposited.native === native, nativeText(opening.deposited.native));
      check(`it deposited the ${amountText(tokenAmount, token)} given`, opening.deposited.token === tokenAmount, amountText(opening.deposited.token, token));
    }
    if (opening.proven) {
      const shift = priceShiftBps(opening);
      result.opening.priceShiftBps = Number(shift);
      result.price = `1 ${chain.nativeCurrency.symbol} = ${price(opening.joined)} ${token.symbol}`;
      print(`opened in block ${opening.blockNumber} with ${nativeText(opening.joined.native)} + ${amountText(opening.joined.token, token)}; LP shares to ${opening.sharesTo}`);
      print(`opening price: ${result.price}`);
      if (opening.gift.native > 0n || opening.gift.token > 0n) {
        print(`note: ${nativeText(opening.gift.native)} and ${amountText(opening.gift.token, token)} of that were not deposited by you: someone had sent them to the pair's address. They joined the pool as a gift (your shares own them; the sender lost them) and moved the opening price by ${(Number(shift) / 100).toFixed(2)}% from ${price(opening.deposited)}.`);
        if (!giftWithinTolerance(opening.gift, opening.deposited))
          print(`      That is more than 0.1%. Nothing is lost and nothing has to be undone: do NOT withdraw. Leave the liquidity in; the market trades the pool back to its price, and the gift stays with the pool. Compare the pool's price with the market before you publish the page.`);
      }
      print(`next, when the chain has finalized that block: node scripts/multichain/gate.mjs ${o.key} post --opening ${o.pair}=${o.tx.toLowerCase()} --out deployments/${o.key}/gate-report.json`);
    }
  } else {
    // The depositing account: a plain key account. Code at the address (a contract, or an EIP-7702 delegation
    // that others may be able to drive) is how someone else's call becomes this account's transaction.
    const code = await pinned("eth_getCode", [depositor, "pinned"]);
    check("the depositing account has no code and no EIP-7702 delegation (a dedicated key account)", code === "0x", `${code.slice(0, 60)}: use an account without code as firstDepositor`);
    let transactions;
    if (o.mode === "prepare") {
      // Open already: this tool did not open it (it prints one first deposit and `verify` follows). The pair
      // accepts a first mint by transaction origin, so a contract the depositing account called can have opened
      // it, at its own price (review R328-1).
      check(
        "the pool is not open yet",
        state !== "open",
        `STOP. This pool is already open, at 1 ${chain.nativeCurrency.symbol} = ${price(side(reserves))} ${token.symbol}. If you opened it with this tool, run verify with the deposit's hash. If you did not, someone opened it in the depositing account's name: deposit nothing, do not use add, and see docs/MULTICHAIN-DEPLOY.md section 10`,
      );
      const gift = side(balances);
      const deposit = { native, token: tokenAmount };
      const tolerated = giftWithinTolerance(gift, deposit);
      // Review R369-10: every printed line pins the chain (the factory has the same address on all six).
      const skim = `${created ? "" : `cast send ${factory.address} "createPair(address,address)" ${token0} ${token1} --chain ${chain.chain.chainId}; then `}cast send ${planned.address} "skim(address)" ${depositor} --chain ${chain.chain.chainId}`;
      check(
        "what sits at the pair's address is at most 0.1% of either side of the deposit",
        state === "open" || tolerated,
        `${nativeText(gift.native)} and ${amountText(gift.token, token)} sit there: someone sent them. They would join the pool as a gift to it and move the opening price. Take them out first (anyone may send these; the tokens go to the address named): ${skim}; then run prepare again`,
      );
      if (state !== "open" && tolerated && (gift.native > 0n || gift.token > 0n)) {
        const joined = { native: native + gift.native, token: tokenAmount + gift.token };
        result.gift = { native: gift.native.toString(), token: gift.token.toString() };
        print(`note: ${nativeText(gift.native)} and ${amountText(gift.token, token)} sit at the pair's address (someone sent them). They join the pool as a gift to it: the pool would open with ${nativeText(joined.native)} + ${amountText(joined.token, token)}, at 1 ${chain.nativeCurrency.symbol} = ${price(joined)} ${token.symbol} instead of ${price(deposit)}.`);
      }
      print(`opening price of these amounts: 1 ${chain.nativeCurrency.symbol} = ${price(deposit)} ${token.symbol}, ${(result.amounts.fromMarketBps / 100).toFixed(2)}% from the market read above. The market moves: send within minutes, and run prepare again if you waited.`);
      transactions = openingTransactions({ router: router.address, token: token.address, native, tokenAmount, to, deadline });
    } else {
      check("the pool is open", state === "open", "use `prepare` for the first deposit");
      const r = side(reserves);
      transactions = [];
      if (state === "open") {
        print(`pool price: 1 ${chain.nativeCurrency.symbol} = ${price(r)} ${token.symbol}; the amounts given say ${price({ native, token: tokenAmount })}`);
        try {
          transactions = addTransactions({ router: router.address, token: token.address, native, expectedToken: tokenAmount, reserveNative: r.native, reserveToken: r.token, toleranceBps: Number(o["tolerance-bps"] ?? 50), to, deadline });
          check("the pool's price is the price of the amounts given, within the tolerance", true);
        } catch (error) {
          if (!(error instanceof MultichainError) || !/pool's price is not/.test(error.message)) throw error;
          check("the pool's price is the price of the amounts given, within the tolerance", false, error.message.replace(/^multichain: /, ""));
        }
      }
    }
    // What the token can do to a deposit (round 20): fee parameters, switches, the issuer's blocklist.
    const ethCall = (target, data) => pinned("eth_call", [{ to: target, data }, "pinned"]);
    const behaviour = await tokenBehaviourState(ethCall, token);
    check(`${token.symbol} takes no fee on transfer and none of its declared switches is on${Object.keys(behaviour.read).length ? ` (${Object.entries(behaviour.read).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`, behaviour.ok, behaviour.problems.join("; "));
    const blocked = await blocklistState(ethCall, token, { "the pair": planned.address, "the router": router.address, "the depositing account": depositor });
    if (token.behaviour?.blocklist) check(`the issuer's blocklist of ${token.symbol} names neither the pair, the router nor the depositing account`, blocked.ok, blocked.problems.join("; "));
    const deposit = transactions.find((t) => t.step === "deposit");
    const need = deposit ? BigInt(deposit.args[1]) : tokenAmount;
    // The allowance the router already holds decides which approve is printed (a token that needs zero first).
    const zeroFirst = token.behaviour?.approveZeroFirst === true;
    const allowance = await call(token.address, "allowance", [depositor, router.address]).catch(() => null);
    check(`the router's allowance of ${token.symbol} from the depositing account can be read`, typeof allowance === "bigint", "allowance() did not answer");
    if (transactions.length && typeof allowance === "bigint") {
      transactions = withApprovals({ transactions, router: router.address, zeroFirst, allowance });
      result.allowance = { before: allowance.toString(), zeroFirst, steps: transactions.filter((t) => t.step !== "deposit").map((t) => t.step) };
    }
    const have = await call(token.address, "balanceOf", [depositor]);
    check(`the depositing account holds the ${token.symbol} to deposit (${amountText(need, token)})`, have >= need, amountText(have, token));
    const coin = BigInt(await pinned("eth_getBalance", [depositor, "pinned"]));
    check(`the depositing account holds the native coin to deposit (${nativeText(native)}) and something for gas`, coin > native, nativeText(coin));
    result.transactions = transactions.map((t) => ({ ...t, value: t.value.toString() }));
    result.deadline = deadline.toString();
    if (checks.every((c) => c.ok)) {
      print("");
      const words = ["no", "one", "two", "three"];
      print(`Send these ${words[transactions.length]} transactions FROM ${depositor} (the factory's first depositor), exactly as printed, in this order, and send nothing else from that account.`);
      if (zeroFirst && allowance > 0n && allowance !== need)
        print(`${token.symbol} refuses to change an allowance that is not zero into another amount (its approve reverts): the router still holds an allowance of ${amountText(allowance, token)} from an earlier run, so the first line sets it to zero and the second sets the new amount. Wait until each is mined before sending the next.`);
      else if (zeroFirst && allowance === need) print(`The router already holds an allowance of exactly ${amountText(allowance, token)} from an earlier run: no approve is printed (${token.symbol} would refuse a second one), only the deposit.`);
      print(`Add your signer option (--keystore FILE for the depositing key's encrypted keystore, or --ledger, --trezor, --account NAME) and --rpc-url. The deposit is valid for ${DEADLINE_SECONDS / 60} minutes; after that run this command again.`);
      // Review R369-3: the opening is proven only for a deposit sent by the depositing account STRAIGHT to the
      // router. A wallet that batches the two transactions (an EIP-7702 "smart account") sends them to the account
      // itself: the pool opens, its opening can never be proven, and the page never lists that pair.
      // One or three lines are printed for a token that needs its allowance set to zero first (round 20).
      const batching = transactions.length === 2
        ? `Never import this key into a browser wallet, never accept "switch to smart account", and never send the two as one batched transaction`
        : `Never import this key into a browser wallet, never accept "switch to smart account", and never send these as one batched transaction`;
      print(`Send them with \`cast send\`, one at a time, exactly as printed. ${batching}: a deposit that does not go straight from ${depositor} to the router ${router.address} opens the pool in a way no tool can prove, and that pair is then lost for this factory.`);
      // --chain: the transaction is signed for this chain id only (EIP-155); another chain's node rejects it
      // (review R369-8: cast itself does not compare the id with the RPC URL's chain).
      for (const t of transactions) print(`cast send ${t.to} "${t.signature}" ${t.args.join(" ")}${t.value > 0n ? ` --value ${t.value}` : ""} --from ${depositor} --chain ${chain.chain.chainId}`);
      print("");
      if (zeroFirst)
        print(`If the deposit is not sent in time, or reverts, the allowance stays where the approve put it. Do not send an approve by hand: ${token.symbol} reverts when a non-zero allowance is changed to another non-zero amount. Run this command again; it reads the allowance and prints the sequence that works (zero first when needed).`);
      print(o.mode === "prepare"
        ? `The deposit is ${nativeText(native)} + ${amountText(tokenAmount, token)}, and its minimums are those same amounts: nobody else can have opened the pool before it (it would revert). Tokens that someone sends to the pair's address before it is mined join the pool as a gift and move the opening price by their size; verify reports it. Then: node scripts/multichain/first-deposit.mjs ${o.key} verify --pair ${o.pair} --native ${formatUnits(native, 18)} --token ${formatUnits(tokenAmount, token.decimals)} --tx <hash of the deposit>`
        : `The deposit is ${nativeText(native)} + ${amountText(need, token)} at the pool's current price; it reverts if the price moves more than ${Number(o["tolerance-bps"] ?? 50) / 100}% first.`);
    }
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  result.checks = checks;
  result.decision = failed.length === 0 ? "pass" : "fail";
  if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`);
  const count = `${failed.length} check${failed.length === 1 ? "" : "s"} failed`;
  if (o.mode === "verify" && failed.length) print("The opening is NOT proven. Do not run the gate for the page's record and do not use add. If this pool was opened by a transaction you did not send through this tool, someone opened it in the depositing account's name: docs/MULTICHAIN-DEPLOY.md section 10.");
  print(`multichain ${o.mode} ${o.key} ${o.pair}: ${result.decision.toUpperCase()}${failed.length ? (o.mode === "verify" ? `; ${count}` : `; nothing to send (${count})`) : ""}`);
  return failed.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2), console.log, ownerToolsCheck).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof MultichainError ? error.message : error);
      process.exit(2);
    },
  );
}
