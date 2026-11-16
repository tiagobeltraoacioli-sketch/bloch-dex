#!/usr/bin/env node
// The owner's deposits on a public chain (docs/MULTICHAIN-DEPLOY.md, "Opening a pool"). Read-only: it checks the
// chain and prints the exact transactions; it signs and sends nothing. Review R309-MC-1: a pool is opened only
// through this path.
//
//   node scripts/multichain/first-deposit.mjs <chain> prepare --pair WETH/USDC --native 10 --token 30000 --gate-report FILE [--to ADDRESS] [--out FILE]
//   node scripts/multichain/first-deposit.mjs <chain> verify  --pair WETH/USDC --native 10 --token 30000 [--tx HASH]
//   node scripts/multichain/first-deposit.mjs <chain> add     --pair WETH/USDC --native 1 --tolerance-bps 50 --gate-report FILE [--to ADDRESS] [--out FILE]
//   every mode: [--reference] [--rpc http://127.0.0.1:PORT --rehearsal]
//
// What makes the opening safe against anyone else, on a chain with a public mempool:
//   1. The factory's `firstDepositor` is the owner's depositing account (never the zero address: lib.mjs refuses
//      it). The pair refuses a first mint whose sender and transaction origin are both someone else, so nobody can
//      open the pool at another price, before, between or after the owner's transactions.
//   2. The deployment creates no pair. The first deposit goes through the router, which creates the pair and
//      deposits in ONE transaction; when someone created the (empty) pair first, the same call just deposits.
//   3. The minimums of the first deposit EQUAL the amounts. This tool prints no other minimums and has no option
//      for them: if the pool were not empty, the transaction would revert instead of depositing at another price.
//   4. `prepare` refuses while tokens sit at the pair's address without shares (a donation would shift the opening
//      price; anyone, the owner included, removes it with skim), and `verify` reads the opened pool back.
// `add` is for a pool that is already open: amounts follow the pool's current price, with minimums at most 1%
// (default 0.5%) below them.
//
// Exit status: 0 the checks held (prepare, add: the transactions were printed; verify: the pool is as intended),
// 1 a check failed (nothing to send), 2 usage or configuration.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import {
  EIP7702_PREFIX, EMPTY_CODE_HASH, GATE_DOMAIN, MultichainError, ZERO_ADDRESS, checksummed, loadArtifacts, loadChain, loadShared, lower, planChain, refuse,
} from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionData, decodeFunctionResult, parseAbi, parseUnits, formatUnits } = requireFromFrontend("viem");

export const ABI = parseAbi([
  "function firstDepositor() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function skim(address)",
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
]);
export const DEADLINE_SECONDS = 20 * 60;
export const MAX_TOLERANCE_BPS = 100;
/** A donation the opened pool may hold above the deposited amounts before `verify` fails: 0.1% of either side. */
export const DONATION_BPS = 10n;

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

/** True when a deposit call carries minimums equal to its amounts (what `verify --tx` requires). */
export function hasStrictMinimums(data, value) {
  try {
    const { functionName, args } = decodeFunctionData({ abi: ABI, data });
    return functionName === "addLiquidityBLCH" && args[2] === args[1] && args[3] === BigInt(value);
  } catch {
    return false;
  }
}

/** A later deposit into an open pool: the token amount at the pool's price, minimums `toleranceBps` below. Pure. */
export function addTransactions({ router, token, native, reserveNative, reserveToken, toleranceBps, to, deadline }) {
  refuse(Number.isInteger(toleranceBps) && toleranceBps >= 0 && toleranceBps <= MAX_TOLERANCE_BPS, `--tolerance-bps is a whole number from 0 to ${MAX_TOLERANCE_BPS}`);
  refuse(native > 0n && reserveNative > 0n && reserveToken > 0n, "the pool is not open, or the amount is zero");
  const tokenAmount = (native * reserveToken) / reserveNative;
  refuse(tokenAmount > 0n, "the amount is too small for this pool");
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
  const usage = "usage: first-deposit.mjs <chain> prepare|verify|add --pair A/B --native AMOUNT [--token AMOUNT] [--gate-report FILE] [--to ADDRESS] [--tx HASH] [--tolerance-bps N] [--out FILE] [--reference] [--rpc URL --rehearsal]";
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
  refuse(o.pair && o.native, usage);
  refuse(!o.rpc || o.rehearsal, "--rpc replaces the chain's reviewed endpoints and is for a rehearsal only: add --rehearsal");
  refuse(!o.rehearsal || /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(o.rpc ?? ""), "--rehearsal needs --rpc http://127.0.0.1:PORT (a loopback fork)");
  refuse(o.mode === "verify" || o["gate-report"], "--gate-report FILE is required: the report of a passed `gate.mjs <chain> post`, so that money goes only into the verified contracts");
  refuse(o.mode === "add" ? o.token === undefined : o.token !== undefined, o.mode === "add" ? "add takes --native only: the token amount follows the pool's price" : "--token AMOUNT is required");
  refuse(o.mode !== "add" || o["tolerance-bps"] === undefined || /^[0-9]{1,3}$/.test(o["tolerance-bps"]), "--tolerance-bps is a whole number");
  return o;
}

export async function main(argv, print = console.log) {
  const o = parseArgs(argv);
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
  const native = decimal(o.native, 18, "--native");
  const tokenAmount = o.mode === "add" ? null : decimal(o.token, token.decimals, "--token");
  const to = o.to ? checksummed(o.to, "--to") : depositor;
  refuse(lower(to) !== ZERO_ADDRESS && lower(to) !== lower(planned.address), "--to must be an account that will hold the LP shares");
  const { router, factory } = plan.contracts;

  const urls = o.rehearsal ? [o.rpc] : chain.rpc;
  const [request, ...others] = urls.map((url) => createRpcTransport(url, { timeoutMs: 30_000 }));
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
  const call = async (target, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await request("eth_call", [{ to: target, data: encodeFunctionData({ abi: ABI, functionName, args }) }, at]) });
  const codeAt = async (address) => codeHashOf(await request("eth_getCode", [address, at]));

  if (o["gate-report"]) {
    const report = JSON.parse(readFileSync(o["gate-report"], "utf8"));
    check(
      "the gate report is a passed post gate of this chain and this plan",
      report.domain === GATE_DOMAIN && report.phase === "post" && report.decision === "pass" && report.failed?.length === 0 && report.chain?.chainId === chain.chain.chainId &&
        report.chain?.genesisHash === chain.chain.genesisHash && lower(report.plan?.contracts?.factory?.address ?? "") === lower(factory.address) &&
        lower(report.plan?.contracts?.router?.address ?? "") === lower(router.address) && Boolean(report.rehearsal) === o.rehearsal && Boolean(report.referencePlan) === plan.reference,
    );
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

  if (o.mode === "verify") {
    const r = side(reserves);
    check("the pool is open", state === "open");
    const within = (got, want) => got >= want && (got - want) * 10_000n <= want * DONATION_BPS;
    check(`the native reserve is the deposited ${nativeText(native)} (at most 0.1% above it)`, within(r.native, native), nativeText(r.native));
    check(`the ${token.symbol} reserve is the deposited ${amountText(tokenAmount, token)} (at most 0.1% above it)`, within(r.token, tokenAmount), amountText(r.token, token));
    if (r.native > native || r.token > tokenAmount) print(`note: the pool holds ${nativeText(r.native - native)} and ${amountText(r.token > tokenAmount ? r.token - tokenAmount : 0n, token)} more than the deposit: tokens someone sent to the pair before it opened (a gift to the pool).`);
    if (o.tx) {
      refuse(/^0x[0-9a-f]{64}$/.test(o.tx), "--tx is a transaction hash");
      const tx = await request("eth_getTransactionByHash", [o.tx]);
      const receipt = await request("eth_getTransactionReceipt", [o.tx]);
      check("the deposit transaction is included and succeeded", tx && receipt?.status === "0x1");
      if (tx) {
        check("it was sent by the depositing account to the router", lower(tx.from) === lower(depositor) && lower(tx.to ?? "") === lower(router.address));
        check("its minimums equal its amounts", hasStrictMinimums(tx.input, tx.value));
      }
    }
    result.reserves = { native: r.native.toString(), token: r.token.toString() };
    result.price = `1 ${chain.nativeCurrency.symbol} = ${r.native > 0n ? formatUnits((r.token * 10n ** 18n) / r.native, token.decimals) : "?"} ${token.symbol}`;
    if (state === "open") print(`opening price: ${result.price}`);
  } else {
    // The depositing account: an ordinary key account (its own transactions carry it as origin), funded.
    const code = await request("eth_getCode", [depositor, at]);
    const delegated = code.toLowerCase().startsWith(EIP7702_PREFIX) && code.length === 2 + 46;
    check("the depositing account is an externally owned account (no code, or an EIP-7702 delegation)", code === "0x" || delegated, code.slice(0, 60));
    let transactions;
    if (o.mode === "prepare") {
      check("the pool is not open yet", state !== "open", "use `add` for a pool that is already open");
      const skim = `${created ? "" : `cast send ${factory.address} "createPair(address,address)" ${token0} ${token1}; then `}cast send ${planned.address} "skim(address)" ${depositor}`;
      check("no tokens sit at the pair's address", balances.every((x) => x === 0n), `${balances.join(" / ")}: someone sent tokens there, which would shift the opening price. Take them out first (anyone may send these): ${skim}; then run prepare again`);
      transactions = openingTransactions({ router: router.address, token: token.address, native, tokenAmount, to, deadline });
    } else {
      check("the pool is open", state === "open", "use `prepare` for the first deposit");
      const r = side(reserves);
      transactions = state === "open" ? addTransactions({ router: router.address, token: token.address, native, reserveNative: r.native, reserveToken: r.token, toleranceBps: Number(o["tolerance-bps"] ?? 50), to, deadline }) : [];
    }
    const need = transactions.length ? BigInt(transactions[0].args[1]) : 0n;
    const have = await call(token.address, "balanceOf", [depositor]);
    check(`the depositing account holds the ${token.symbol} to deposit (${amountText(need, token)})`, have >= need, amountText(have, token));
    const coin = BigInt(await request("eth_getBalance", [depositor, at]));
    check(`the depositing account holds the native coin to deposit (${nativeText(native)}) and something for gas`, coin > native, nativeText(coin));
    result.transactions = transactions.map((t) => ({ ...t, value: t.value.toString() }));
    result.deadline = deadline.toString();
    if (checks.every((c) => c.ok)) {
      print("");
      print(`Send these two transactions FROM ${depositor} (the factory's first depositor; no other account can open a pool).`);
      print(`Add your signer option (--ledger, --trezor or --account NAME) and --rpc-url. The deposit is valid for ${DEADLINE_SECONDS / 60} minutes; after that run this command again.`);
      for (const t of transactions) print(`cast send ${t.to} "${t.signature}" ${t.args.join(" ")}${t.value > 0n ? ` --value ${t.value}` : ""} --from ${depositor}`);
      print("");
      print(o.mode === "prepare"
        ? `The deposit is ${nativeText(native)} + ${amountText(tokenAmount, token)}, and its minimums are those same amounts: it opens the pool at exactly that price or reverts. Then: node scripts/multichain/first-deposit.mjs ${o.key} verify --pair ${o.pair} --native ${o.native} --token ${o.token} --tx <hash of the deposit>`
        : `The deposit is ${nativeText(native)} + ${amountText(need, token)} at the pool's current price; it reverts if the price moves more than ${Number(o["tolerance-bps"] ?? 50) / 100}% first.`);
    }
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  result.checks = checks;
  result.decision = failed.length === 0 ? "pass" : "fail";
  if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`);
  print(`multichain ${o.mode} ${o.key} ${o.pair}: ${result.decision.toUpperCase()}${failed.length ? `; nothing to send (${failed.length} check${failed.length === 1 ? "" : "s"} failed)` : ""}`);
  return failed.length === 0 ? 0 : 1;
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
