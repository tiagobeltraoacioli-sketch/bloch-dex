#!/usr/bin/env node
// The multichain deployment and flow, executed by the chain's own node software, read-only
// (docs/MULTICHAIN-DEPLOY.md, "Simulation on the real nodes").
//
//   node scripts/multichain/simulate-chain.mjs <chain> --out FILE [--balance-slot N]
//
// One `eth_simulateV1` request to a reviewed public endpoint of the chain: a sequence of calls on top of the latest
// block, with state overrides for throwaway balances. Nothing is signed, nothing is sent, nothing changes on the
// chain. The node executes, in order, the three CREATE2 deployments through the deterministic deployer, createPair,
// a first deposit, swaps both ways with the native coin and the wrapped token, a second deposit (which settles the
// protocol fee), the fee address redeeming its LP shares, a skim, the LP's exit, and one anchored swap that names
// the chain's real latest block. Unlike the anvil fork rehearsal, this is the chain's real EVM (Nitro on Arbitrum
// One, the OP Stack's op-geth or op-reth, Linea's besu, BNB Smart Chain's geth fork), so opcode and precompile
// differences show here. What it cannot show: transactions really signed and included, fees really charged, and
// behaviour over time.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { loadArtifacts, loadChain, loadShared, lower, planChain } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, parseAbi, formatUnits } = requireFromFrontend("viem");

const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!key || !opt.out) {
  console.error("usage: simulate-chain.mjs <chain> --out FILE [--balance-slot N]");
  process.exit(2);
}
const shared = loadShared();
const chain = loadChain(key);
const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function skim(address)",
  "function feeTo() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function createPair(address,address) returns (address)",
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
  "function removeLiquidityBLCH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) returns (uint256,uint256)",
  "function swapExactBLCHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactBLCHForTokensAnchored(uint256 amountOutMin,address[] path,address to,uint256 deadline,uint256 anchorNumber,bytes32 anchorHash) payable returns (uint256[])",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const data = (functionName, args = []) => encodeFunctionData({ abi: ABI, functionName, args });
const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);

// Throwaway addresses: no key exists for them; the simulation gives them balances by state override.
const LP = "0x00000000000000000000000000000000000a11ce";
const TRADER = "0x0000000000000000000000000000000000000b0b";
const STRANGER = "0x00000000000000000000000000000000000ca401";
const SENDER = "0x000000000000000000000000000000000000d0e5";
const FEE = shared.feeTo.address;
const wrapped = chain.wrappedNative;
const token = chain.tokens[0];
const unit = 10n ** BigInt(token.decimals);
const { factory, router, lens } = plan.contracts;
const pair = plan.pairs[0];

async function simulateWith(request, slot, latest) {
  const word = (n) => `0x${n.toString(16).padStart(64, "0")}`;
  const slotOf = (holder) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
  const stateOverrides = {
    [LP]: { balance: hex(1000n * 10n ** 18n) },
    [TRADER]: { balance: hex(1000n * 10n ** 18n) },
    [STRANGER]: { balance: hex(10n ** 18n) },
    [SENDER]: { balance: hex(10n ** 18n) },
    [FEE]: { balance: hex(10n ** 18n) },
    [token.address]: { stateDiff: { [slotOf(LP)]: word(100_000n * unit), [slotOf(TRADER)]: word(10_000n * unit), [slotOf(STRANGER)]: word(100n * unit) } },
  };
  const deadline = BigInt(latest.timestamp) + 86_400n;
  const steps = [];
  const add = (block, name, from, to, input, value = 0n, expect = "success") => steps.push({ block, name, expect, call: { from, to, input, value: hex(value) } });
  // Block 1: deployment and the first trades.
  add(0, "token balance of the LP after the override (must be 100,000)", LP, token.address, data("balanceOf", [LP]));
  add(0, "deploy factory through the CREATE2 deployer", SENDER, shared.create2.deployer, factory.transaction.data);
  add(0, "deploy router through the CREATE2 deployer", SENDER, shared.create2.deployer, router.transaction.data);
  add(0, "deploy lens through the CREATE2 deployer", SENDER, shared.create2.deployer, lens.transaction.data);
  add(0, "factory.feeTo()", SENDER, factory.address, data("feeTo"));
  add(0, `createPair(${wrapped.symbol}, ${token.symbol})`, SENDER, factory.address, data("createPair", [wrapped.address, token.address]));
  add(0, `LP approves ${token.symbol}`, LP, token.address, data("approve", [router.address, 2n ** 256n - 1n]));
  add(0, "first deposit (addLiquidityBLCH: 10 native + 30,000 token)", LP, router.address, data("addLiquidityBLCH", [token.address, 30_000n * unit, 0n, 0n, LP, deadline]), 10n * 10n ** 18n);
  add(0, "swap 1 native for the token (swapExactBLCHForTokens)", TRADER, router.address, data("swapExactBLCHForTokens", [0n, [wrapped.address, token.address], TRADER, deadline]), 10n ** 18n);
  add(0, `trader approves ${token.symbol}`, TRADER, token.address, data("approve", [router.address, 2n ** 256n - 1n]));
  add(0, "swap 3,000 token for native (swapExactTokensForBLCH: unwrap and native payout)", TRADER, router.address, data("swapExactTokensForBLCH", [3_000n * unit, 0n, [token.address, wrapped.address], TRADER, deadline]));
  add(0, "trader wraps 1 native (deposit)", TRADER, wrapped.address, data("deposit"), 10n ** 18n);
  add(0, `trader approves ${wrapped.symbol}`, TRADER, wrapped.address, data("approve", [router.address, 2n ** 256n - 1n]));
  add(0, "swap 1 wrapped for the token (swapExactTokensForTokens)", TRADER, router.address, data("swapExactTokensForTokens", [10n ** 18n, 0n, [wrapped.address, token.address], TRADER, deadline]));
  add(0, "swap 2,000 token for wrapped (swapExactTokensForTokens)", TRADER, router.address, data("swapExactTokensForTokens", [2_000n * unit, 0n, [token.address, wrapped.address], TRADER, deadline]));
  add(0, "fee address LP shares before a liquidity event (must be 0)", SENDER, pair.address, data("balanceOf", [FEE]));
  // Block 2: the protocol fee, its redemption, skim, exit, and the anchored variant.
  add(1, "second deposit (settles the protocol fee)", LP, router.address, data("addLiquidityBLCH", [token.address, 3_000n * unit, 0n, 0n, LP, deadline]), 10n ** 18n);
  add(1, "fee address LP shares after the liquidity event", SENDER, pair.address, data("balanceOf", [FEE]));
  add(1, "anchored swap naming the chain's real latest block (number and hash as the RPC reports them)", TRADER, router.address, data("swapExactBLCHForTokensAnchored", [0n, [wrapped.address, token.address], TRADER, deadline, BigInt(latest.number), latest.hash]), 10n ** 17n, "chain-dependent");
  add(1, "pair.getReserves()", SENDER, pair.address, data("getReserves"));
  add(1, "pair.totalSupply()", SENDER, pair.address, data("totalSupply"));
  add(1, "fee address token balance before redeeming", SENDER, token.address, data("balanceOf", [FEE]));
  add(1, "fee address approves its LP shares to the router", FEE, pair.address, data("approve", [router.address, 2n ** 256n - 1n]));
  steps.push({ block: 1, name: "fee address redeems its LP shares (removeLiquidityBLCH to itself)", expect: "success", feeRedeem: true, call: { from: FEE, to: router.address, value: "0x0" } });
  add(1, "fee address token balance after redeeming", SENDER, token.address, data("balanceOf", [FEE]));
  add(1, `a stranger sends 5 ${token.symbol} to the pair`, STRANGER, token.address, data("transfer", [pair.address, 5n * unit]));
  add(1, "anyone skims the excess to an address of their choice", TRADER, pair.address, data("skim", [TRADER]));
  add(1, "LP shares of the LP", SENDER, pair.address, data("balanceOf", [LP]));
  add(1, "LP approves its LP shares", LP, pair.address, data("approve", [router.address, 2n ** 256n - 1n]));
  steps.push({ block: 1, name: "LP removes all its liquidity (removeLiquidityBLCH)", expect: "success", lpExit: true, call: { from: LP, to: router.address, value: "0x0" } });

  // The two removals need the LP share amounts, which only exist inside the simulation: a first pass reads them.
  const run = async (fill) => {
    const blocks = [0, 1].map((b) => ({
      ...(b === 0 ? { stateOverrides } : { blockOverrides: { time: hex(BigInt(latest.timestamp) + 600n) } }),
      calls: steps.filter((s) => s.block === b).map((s) => (s.feeRedeem ? { ...s.call, input: fill.fee } : s.lpExit ? { ...s.call, input: fill.lp } : s.call)),
    }));
    if (blocks[0].stateOverrides && !blocks[0].blockOverrides) blocks[0].blockOverrides = { time: hex(BigInt(latest.timestamp) + 12n) };
    const result = await request("eth_simulateV1", [{ blockStateCalls: blocks, validation: false, traceTransfers: false }, latest.number]);
    const calls = result.flatMap((b) => b.calls);
    return steps.map((s, i) => ({ ...s, result: calls[i] }));
  };
  const share = (r, name) => {
    const found = r.find((s) => s.name === name)?.result;
    return found && found.status === "0x1" ? BigInt(found.returnData) : 0n;
  };
  const first = await run({ fee: data("removeLiquidityBLCH", [token.address, 1n, 0n, 0n, FEE, deadline]), lp: data("removeLiquidityBLCH", [token.address, 1n, 0n, 0n, LP, deadline]) });
  const feeShares = share(first, "fee address LP shares after the liquidity event");
  const lpShares = share(first, "LP shares of the LP");
  if (feeShares === 0n || lpShares === 0n) return { steps: first, feeShares, lpShares, deadline };
  const second = await run({ fee: data("removeLiquidityBLCH", [token.address, feeShares, 0n, 0n, FEE, deadline]), lp: data("removeLiquidityBLCH", [token.address, lpShares, 0n, 0n, LP, deadline]) });
  return { steps: second, feeShares, lpShares, deadline };
}

const out = { schema: "postern.dex.multichain-simulation.v1", chain: plan.chain, method: "eth_simulateV1 (read-only; state overrides for throwaway balances; nothing signed or sent)", addresses: { factory: factory.address, router: router.address, lens: lens.address, pair: pair.address }, feeTo: FEE, attempts: [] };
let done = null;
for (const url of chain.rpc) {
  const request = createRpcTransport(url, { timeoutMs: 90_000 });
  try {
    const latest = await request("eth_getBlockByNumber", ["latest", false]);
    const version = await request("web3_clientVersion", []).catch(() => null);
    // The balance mapping's slot of the listed token: given, or found by trying (0 to 60) in a one-call simulation.
    let slot = opt["balance-slot"] !== undefined ? Number(opt["balance-slot"]) : null;
    for (let s = 0; slot === null && s <= 60; s++) {
      const k = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [LP, BigInt(s)]));
      const r = await request("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: { [token.address]: { stateDiff: { [k]: `0x${(12345n).toString(16).padStart(64, "0")}` } } }, calls: [{ from: SENDER, to: token.address, input: data("balanceOf", [LP]) }] }], validation: false }, latest.number]);
      if (r[0].calls[0].status === "0x1" && BigInt(r[0].calls[0].returnData) === 12345n) slot = s;
    }
    if (slot === null) throw new Error("no balance slot found for the listed token");
    const sim = await simulateWith(request, slot, latest);
    done = { url, clientVersion: version, latest: { number: Number(BigInt(latest.number)), hash: latest.hash, timestamp: Number(BigInt(latest.timestamp)) }, tokenBalanceSlot: slot, ...sim };
    out.attempts.push({ url, ok: true });
    break;
  } catch (error) {
    out.attempts.push({ url, ok: false, error: String(error.message ?? error).slice(0, 300) });
  }
}
if (!done) {
  out.result = "NOT RUN";
  writeFileSync(opt.out, `${JSON.stringify(out, big, 2)}\n`);
  console.error(`simulation ${key}: no endpoint served it: ${JSON.stringify(out.attempts)}`);
  process.exit(1);
}
const ok = (s) => s.result?.status === "0x1";
const value = (name) => {
  const s = done.steps.find((x) => x.name === name);
  return s && ok(s) ? BigInt(s.result.returnData) : null;
};
const addr = (name) => {
  const s = done.steps.find((x) => x.name === name);
  return s && ok(s) ? `0x${s.result.returnData.slice(-40)}` : null;
};
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, ok: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` (${JSON.stringify(detail, big)})`}`);
};
const required = done.steps.filter((s) => s.expect === "success");
check("every required step succeeds on the chain's own node", required.every(ok), required.filter((s) => !ok(s)).map((s) => ({ step: s.name, error: s.result?.error ?? s.result })).slice(0, 4));
check("the token balance override took (100,000 units)", value("token balance of the LP after the override (must be 100,000)") === 100_000n * unit);
check("the node's CREATE2 returns the planned factory, router and lens addresses", ["factory", "router", "lens"].every((n) => lower(addr(`deploy ${n} through the CREATE2 deployer`) ?? "") === lower(plan.contracts[n].address)));
check("factory.feeTo() is the owner's fee address", lower(addr("factory.feeTo()") ?? "") === lower(FEE));
check("createPair returns the planned pair address", lower(addr(`createPair(${wrapped.symbol}, ${token.symbol})`) ?? "") === lower(pair.address));
check("swaps alone mint nothing to the fee address", value("fee address LP shares before a liquidity event (must be 0)") === 0n);
check("the liquidity event mints LP shares to the fee address", (done.feeShares ?? 0n) > 0n, done.feeShares);
const tokenBefore = value("fee address token balance before redeeming");
const tokenAfter = value("fee address token balance after redeeming");
check("the fee address redeems its shares for the token (and the native coin, paid by the router's unwrap)", tokenBefore !== null && tokenAfter !== null && tokenAfter > tokenBefore, { tokenBefore, tokenAfter });
const reserves = done.steps.find((s) => s.name === "pair.getReserves()");
const supply = value("pair.totalSupply()");
let fee = null;
if (reserves && ok(reserves) && supply) {
  const [r0, r1] = decodeFunctionResult({ abi: ABI, functionName: "getReserves", data: reserves.result.returnData });
  const wrappedIs0 = lower(pair.token0) === lower(wrapped.address);
  const native = (done.feeShares * (wrappedIs0 ? r0 : r1)) / supply;
  const tok = (done.feeShares * (wrappedIs0 ? r1 : r0)) / supply;
  fee = { lpShares: done.feeShares, native: `${formatUnits(native, 18)} ${chain.nativeCurrency.symbol}`, token: `${formatUnits(tok, token.decimals)} ${token.symbol}`, redeemedToken: tokenAfter !== null && tokenBefore !== null ? `${formatUnits(tokenAfter - tokenBefore, token.decimals)} ${token.symbol}` : null };
}
const anchored = done.steps.find((s) => s.expect === "chain-dependent");
out.anchoredSwap = { works: ok(anchored), error: ok(anchored) ? null : (anchored.result?.error ?? null) };
console.log(`info anchored swap naming the RPC's latest block: ${out.anchoredSwap.works ? "executes" : `reverts (${JSON.stringify(out.anchoredSwap.error).slice(0, 120)})`}`);
Object.assign(out, {
  endpoint: done.url,
  clientVersion: done.clientVersion,
  latest: done.latest,
  tokenBalanceSlot: done.tokenBalanceSlot,
  protocolFee: fee,
  steps: done.steps.map((s) => ({ block: s.block + 1, step: s.name, status: s.result?.status ?? null, gasUsed: s.result?.gasUsed ? BigInt(s.result.gasUsed) : null, error: s.result?.error ?? undefined })),
  checks,
  result: checks.every((c) => c.ok) ? "PASS" : "FAIL",
});
writeFileSync(opt.out, `${JSON.stringify(out, big, 2)}\n`);
console.log(`simulation ${key} on ${done.url} (${done.clientVersion ?? "client not named"}): ${out.result}; protocol fee ${fee ? `${fee.native} + ${fee.token}` : "?"}; ${opt.out}`);
process.exit(out.result === "PASS" ? 0 : 1);
