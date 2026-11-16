#!/usr/bin/env node
// Fork rehearsal of the multichain package for one chain (docs/MULTICHAIN-DEPLOY.md, "Fork rehearsals").
//
//   node scripts/multichain/rehearse-fork.mjs <chain> --port PORT --out DIR [--fork-url URL]
//
// It starts `anvil --fork-url <the chain's first reviewed endpoint>` on loopback, runs the owner's command exactly as
// documented (scripts/multichain/deploy.sh <chain> broadcast, with a throwaway key and the reference plan), passes
// the post gate at the fork's finalized block, and then plays the whole flow with throwaway accounts and the chain's
// real wrapped native token and listed token: first deposit, swaps both ways with the native coin and with the
// wrapped token, protocol fee accrual to the owner's fee address, redemption of that fee by the fee address (it is
// impersonated on the fork: no key of it exists here), a permissionless skim, and the removal of the liquidity.
// Every step records its gas and amounts in DIR/evidence.json. Nothing leaves loopback except the fork's read
// requests to the public endpoint. Exit status 0 only when every check held.
//
// This shows that the unchanged bytecode deploys and works against the chain's real state and real tokens under
// anvil's EVM. It does not show the chain client's own differences (Arbitrum's block.number and blockhash, L1 data
// fees, Linea's prover limits): scripts/multichain/probe-chain.mjs reads those from the real nodes.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, loadArtifacts, loadChain, loadShared, lower, planChain, refuse } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, parseAbi, formatUnits } = requireFromFrontend("viem");
const { privateKeyToAccount, generatePrivateKey } = requireFromFrontend("viem/accounts");

const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!key || !opt.port || !opt.out) {
  console.error("usage: rehearse-fork.mjs <chain> --port PORT --out DIR [--fork-url URL]");
  process.exit(2);
}
const shared = loadShared();
const chain = loadChain(key);
const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
const port = Number(opt.port);
const url = `http://127.0.0.1:${port}`;
// The fork source must keep the state of the fork block for the length of the rehearsal and serve what anvil asks.
// Two reviewed first endpoints do not (seen 2026-11-16): BNB Smart Chain's keeps state for under 200 blocks, and
// Ethereum's answered anvil's block 0 request from a history-pruned backend. Their second endpoints are used.
const FORK_SOURCE = { "bnb-smart-chain": 1, ethereum: 1 };
const forkUrl = opt["fork-url"] ?? chain.rpc[FORK_SOURCE[key] ?? 0];
mkdirSync(opt.out, { recursive: true });

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function kLast() view returns (uint256)",
  "function skim(address)",
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
  "function removeLiquidityBLCH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) returns (uint256,uint256)",
  "function swapExactBLCHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactBLCHForTokensAnchored(uint256 amountOutMin,address[] path,address to,uint256 deadline,uint256 anchorNumber,bytes32 anchorHash) payable returns (uint256[])",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpcError: body.error });
  return body.result;
}
const read = async (to, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await rpc("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, "latest"]) });
const nativeOf = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));

const evidence = {
  schema: "postern.dex.multichain-fork-rehearsal.v1",
  chain: plan.chain,
  forkOf: forkUrl,
  what: "anvil fork on loopback; throwaway keys; reference plan (first deposits open, no reserve caps); the fee address is impersonated",
  anvil: spawnSync("anvil", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
  feeTo: shared.feeTo.address,
  addresses: Object.fromEntries(Object.values(plan.contracts).map((c) => [c.name, c.address])),
  deployment: [],
  steps: [],
  checks: [],
};
const save = () => writeFileSync(join(opt.out, "evidence.json"), `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
const check = (name, ok, detail) => {
  evidence.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))})`}`);
  save();
};

const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--host", "127.0.0.1", "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
let failed = false;
try {
  for (let i = 0; ; i++) {
    try {
      refuse(Number(BigInt(await rpc("eth_chainId"))) === chain.chain.chainId, "the fork is not the chain");
      break;
    } catch (error) {
      if (i > 120) throw error;
      await delay(500);
    }
  }
  const forkBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  evidence.forkBlock = { number: Number(BigInt(forkBlock.number)), hash: forkBlock.hash, timestamp: Number(BigInt(forkBlock.timestamp)), baseFeePerGas: forkBlock.baseFeePerGas ? BigInt(forkBlock.baseFeePerGas) : null };

  const account = () => privateKeyToAccount(generatePrivateKey());
  const deployerKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const [lp, trader, stranger] = [account(), account(), account()];
  for (const a of [deployer, lp, trader, stranger]) await rpc("anvil_setBalance", [a.address, hex(1000n * 10n ** 18n)]);

  const gasPrice = async () => BigInt(await rpc("eth_gasPrice"));
  async function send(from, { to, data = "0x", value = 0n }, label, extra = {}) {
    const price = (await gasPrice()) * 2n + 1n;
    let hash;
    // The gas limit is always stated: the estimate plus a fifth, plus 60,000. The estimate runs at the latest
    // block's timestamp; when the pair was last touched in that same second the estimate has no elapsed time, and
    // the transaction, one block later, also writes the two price accumulators for the first time (2 x 22,100 gas).
    // Seen here: with the bare estimate plus a fifth, a swap right after the first deposit ran out of gas in some
    // runs. The page states its own gas limits (250,000 per hop) and does not depend on an estimate.
    const gas = (BigInt(await rpc("eth_estimateGas", [{ from: from.address, to, data, value: hex(value) }])) * 12n) / 10n + 60_000n;
    if (from.sign === false) {
      hash = await rpc("eth_sendTransaction", [{ from: from.address, to, data, value: hex(value), gas: hex(gas), gasPrice: hex(price) }]);
    } else {
      const raw = await from.signTransaction({ type: "legacy", chainId: chain.chain.chainId, nonce: Number(BigInt(await rpc("eth_getTransactionCount", [from.address, "pending"]))), to, data, value, gas, gasPrice: price });
      hash = await rpc("eth_sendRawTransaction", [raw]);
    }
    let receipt = null;
    for (let i = 0; i < 100 && !receipt; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) await delay(100);
    }
    refuse(receipt, `no receipt for ${label}`);
    const entry = { step: label, hash, status: receipt.status, gasUsed: BigInt(receipt.gasUsed), gasLimit: gas, feeWei: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), ...extra };
    evidence.steps.push(entry);
    if (receipt.status !== "0x1") {
      // Replay as a call on the block before, for the revert reason.
      const why = await rpc("eth_call", [{ from: from.address, to, data, value: hex(value) }, hex(BigInt(receipt.blockNumber) - 1n)]).then(() => "the replayed call succeeds", (error) => error.message);
      entry.revert = why;
      save();
      refuse(false, `${label} reverted: ${why}`);
    }
    save();
    return entry;
  }

  // ---- 1. the owner's command, as documented ----
  const run = spawnSync("bash", ["scripts/multichain/deploy.sh", key, "broadcast", "--rehearsal-rpc", url, "--reference", "--", "--private-key", deployerKey], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
  writeFileSync(join(opt.out, "deploy.log"), `${run.stdout}\n${run.stderr}`.replaceAll(deployerKey, "<throwaway key>"));
  check("scripts/multichain/deploy.sh broadcast exits 0 on the fork", run.status === 0, run.status === 0 ? undefined : `${run.stdout}\n${run.stderr}`.slice(-600));
  if (run.status !== 0) throw new Error("the deployment failed");
  const broadcast = JSON.parse(readFileSync(join(ROOT, "broadcast/DeployMultichain.s.sol", String(chain.chain.chainId), "run-latest.json"), "utf8"));
  const names = ["factory (CREATE2)", "router (CREATE2)", "lens (CREATE2)", ...plan.pairs.map((p) => `createPair ${p.tokenA}/${p.tokenB}`)];
  for (const [i, receipt] of broadcast.receipts.entries()) {
    const tx = broadcast.transactions[i]?.transaction ?? {};
    evidence.deployment.push({ step: names[i] ?? `transaction ${i}`, hash: receipt.transactionHash, to: receipt.to, gasUsed: BigInt(receipt.gasUsed), status: receipt.status, calldataBytes: tx.input ? (tx.input.length - 2) / 2 : null, input: tx.input ?? null });
  }
  check("the deployment is the planned number of transactions, all successful, sent by the throwaway key", evidence.deployment.length === 3 + plan.pairs.length && evidence.deployment.every((d) => d.status === "0x1") && broadcast.receipts.every((r) => lower(r.from) === lower(deployer.address)), evidence.deployment.map((d) => d.status));
  evidence.deploymentGas = evidence.deployment.reduce((n, d) => n + d.gasUsed, 0n);
  for (const d of evidence.deployment) delete d.input;

  // ---- 2. the post gate at the fork's finalized block ----
  await rpc("anvil_mine", [hex(200)]);
  const gate = spawnSync("node", ["scripts/multichain/gate.mjs", key, "post", "--reference", "--rpc", url, "--rehearsal", "--out", join(opt.out, "gate-report.json")], { cwd: ROOT, encoding: "utf8" });
  writeFileSync(join(opt.out, "gate.log"), `${gate.stdout}\n${gate.stderr}`);
  check("the post gate passes at the fork's finalized block", gate.status === 0, gate.status === 0 ? undefined : gate.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 600));

  // ---- 3. the flow ----
  const { factory, router } = evidence.addresses;
  const wrapped = chain.wrappedNative;
  const token = chain.tokens[0];
  const pair = plan.pairs[0].address;
  const unit = 10n ** BigInt(token.decimals);
  const deadline = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) + 86_400n;
  // Rehearsal figures only (an opening price is the owner's choice): 10 native against 30,000 token units.
  const SEED_NATIVE = 10n * 10n ** 18n;
  const SEED_TOKEN = 30_000n * unit;
  evidence.rehearsalFigures = { seedNative: SEED_NATIVE, seedToken: SEED_TOKEN, note: "not a price recommendation" };

  /** Give `holder` a token balance by writing the balance mapping's slot (found by trying slots). */
  async function fund(holder, amount) {
    for (let slot = 0n; slot < 80n; slot++) {
      for (const k of [keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot])), keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder]))]) {
        const before = await rpc("eth_getStorageAt", [token.address, k, "latest"]);
        await rpc("anvil_setStorageAt", [token.address, k, `0x${amount.toString(16).padStart(64, "0")}`]);
        if ((await read(token.address, "balanceOf", [holder])) === amount) return Number(slot);
        await rpc("anvil_setStorageAt", [token.address, k, before]);
      }
    }
    throw new Error(`no balance slot found for ${token.symbol}`);
  }
  evidence.tokenBalanceSlot = await fund(lp.address, 100_000n * unit);
  await fund(trader.address, 10_000n * unit);
  await fund(stranger.address, 100n * unit);
  const call = (functionName, args) => encodeFunctionData({ abi: ABI, functionName, args });
  const feeAccount = { address: shared.feeTo.address, sign: false };
  const state = async () => {
    const [r0, r1] = await read(pair, "getReserves");
    const wrappedIs0 = lower(plan.pairs[0].token0) === lower(wrapped.address);
    return { reserveNative: wrappedIs0 ? r0 : r1, reserveToken: wrappedIs0 ? r1 : r0, totalSupply: await read(pair, "totalSupply"), feeToLp: await read(pair, "balanceOf", [shared.feeTo.address]) };
  };

  // 3a. first deposit, through the router, with the native coin
  await send(lp, { to: token.address, data: call("approve", [router, 2n ** 256n - 1n]) }, `LP approves ${token.symbol} to the router`);
  await send(lp, { to: router, data: call("addLiquidityBLCH", [token.address, SEED_TOKEN, 0n, 0n, lp.address, deadline]), value: SEED_NATIVE }, `first deposit: 10 ${chain.nativeCurrency.symbol} + 30,000 ${token.symbol} (addLiquidityBLCH)`);
  let s = await state();
  check("the first deposit set the reserves and locked the minimum liquidity", s.reserveNative === SEED_NATIVE && s.reserveToken === SEED_TOKEN && s.totalSupply > 1000n && s.feeToLp === 0n, s);

  // 3b. swaps: native in, native out, wrapped token in, wrapped token out
  const tokenBefore = await read(token.address, "balanceOf", [trader.address]);
  await send(trader, { to: router, data: call("swapExactBLCHForTokens", [0n, [wrapped.address, token.address], trader.address, deadline]), value: 10n ** 18n }, `swap 1 ${chain.nativeCurrency.symbol} for ${token.symbol} (swapExactBLCHForTokens)`);
  const got = (await read(token.address, "balanceOf", [trader.address])) - tokenBefore;
  check(`the trader received ${token.symbol} for the native coin`, got > 0n, formatUnits(got, token.decimals));
  await send(trader, { to: token.address, data: call("approve", [router, 2n ** 256n - 1n]) }, `trader approves ${token.symbol} to the router`);
  const nativeBefore = await nativeOf(trader.address);
  const out = await send(trader, { to: router, data: call("swapExactTokensForBLCH", [3_000n * unit, 0n, [token.address, wrapped.address], trader.address, deadline]) }, `swap 3,000 ${token.symbol} for ${chain.nativeCurrency.symbol} (swapExactTokensForBLCH: the router unwraps and pays the native coin)`);
  const nativeGot = (await nativeOf(trader.address)) - nativeBefore + out.feeWei;
  check("the trader received the native coin (the wrapped token's withdraw pays the router, the router pays the trader)", nativeGot > 0n, formatUnits(nativeGot, 18));
  await send(trader, { to: wrapped.address, data: call("deposit", []), value: 10n ** 18n }, `trader wraps 1 ${chain.nativeCurrency.symbol} (deposit)`);
  await send(trader, { to: wrapped.address, data: call("approve", [router, 2n ** 256n - 1n]) }, `trader approves ${wrapped.symbol} to the router`);
  await send(trader, { to: router, data: call("swapExactTokensForTokens", [10n ** 18n, 0n, [wrapped.address, token.address], trader.address, deadline]) }, `swap 1 ${wrapped.symbol} for ${token.symbol} (swapExactTokensForTokens)`);
  const wrappedBefore = await read(wrapped.address, "balanceOf", [trader.address]);
  await send(trader, { to: router, data: call("swapExactTokensForTokens", [2_000n * unit, 0n, [token.address, wrapped.address], trader.address, deadline]) }, `swap 2,000 ${token.symbol} for ${wrapped.symbol} (swapExactTokensForTokens)`);
  check(`the trader received ${wrapped.symbol}`, (await read(wrapped.address, "balanceOf", [trader.address])) > wrappedBefore);

  // 3c. the anchored variant (a recent block of this fork as the anchor)
  const anchor = await rpc("eth_getBlockByNumber", ["latest", false]);
  await rpc("anvil_mine", ["0x1"]);
  const anchored = await send(trader, { to: router, data: call("swapExactBLCHForTokensAnchored", [0n, [wrapped.address, token.address], trader.address, deadline, BigInt(anchor.number), anchor.hash]), value: 10n ** 17n }, "anchored swap with a recent block of the fork as the anchor").then(() => true, (error) => String(error.message).slice(0, 160));
  check("the anchored swap variant works under anvil's BLOCKHASH (see probe-chain.mjs for the real nodes)", anchored === true, anchored);

  // 3d. protocol fee: accrues as LP shares of the fee address at the next liquidity event
  const before = await state();
  check("swaps alone mint nothing to the fee address (the fee is settled lazily)", before.feeToLp === 0n, before.feeToLp);
  await send(lp, { to: router, data: call("addLiquidityBLCH", [token.address, 3_000n * unit, 0n, 0n, lp.address, deadline]), value: 10n ** 18n }, "LP adds liquidity again (a liquidity event settles the protocol fee)");
  s = await state();
  const feeShareNative = (s.feeToLp * s.reserveNative) / s.totalSupply;
  const feeShareToken = (s.feeToLp * s.reserveToken) / s.totalSupply;
  evidence.protocolFee = { feeTo: shared.feeTo.address, lpShares: s.feeToLp, worthNative: feeShareNative, worthToken: feeShareToken, native: `${formatUnits(feeShareNative, 18)} ${chain.nativeCurrency.symbol}`, token: `${formatUnits(feeShareToken, token.decimals)} ${token.symbol}` };
  check("the owner's fee address holds LP shares minted by the protocol fee", s.feeToLp > 0n, evidence.protocolFee);

  // 3e. the fee address redeems its shares itself: approve the router, removeLiquidityBLCH (impersonated on the fork)
  await rpc("anvil_impersonateAccount", [shared.feeTo.address]);
  if ((await nativeOf(shared.feeTo.address)) < 10n ** 17n) {
    await rpc("anvil_setBalance", [shared.feeTo.address, hex(10n ** 18n)]);
    evidence.feeToGasNote = "the fee address held too little native coin on this chain to pay gas; the fork gave it 1 for the rehearsal";
  }
  const feeNative0 = await nativeOf(shared.feeTo.address);
  const feeToken0 = await read(token.address, "balanceOf", [shared.feeTo.address]);
  const a1 = await send(feeAccount, { to: pair, data: call("approve", [router, s.feeToLp]) }, "fee address approves its LP shares to the router");
  const a2 = await send(feeAccount, { to: router, data: call("removeLiquidityBLCH", [token.address, s.feeToLp, 0n, 0n, shared.feeTo.address, deadline]) }, "fee address redeems its LP shares (removeLiquidityBLCH): native coin and token arrive at the fee address");
  const redeemedToken = (await read(token.address, "balanceOf", [shared.feeTo.address])) - feeToken0;
  // The native coin that arrived: the balance change plus the gas the fee address paid for its two transactions.
  const redeemedNative = (await nativeOf(shared.feeTo.address)) - feeNative0 + a1.feeWei + a2.feeWei;
  evidence.protocolFee.redeemed = { native: `${formatUnits(redeemedNative, 18)} ${chain.nativeCurrency.symbol}`, token: `${formatUnits(redeemedToken, token.decimals)} ${token.symbol}`, nativeWei: redeemedNative, tokenUnits: redeemedToken, gas: a1.gasUsed + a2.gasUsed };
  check("the fee address received the token and the native coin of its shares", redeemedToken > 0n && redeemedNative > 0n && (await read(pair, "balanceOf", [shared.feeTo.address])) === 0n, evidence.protocolFee.redeemed);
  await rpc("anvil_stopImpersonatingAccount", [shared.feeTo.address]);

  // 3f. skim is permissionless: a token sent to the pair by mistake goes to whoever calls skim first
  await send(stranger, { to: token.address, data: call("transfer", [pair, 5n * unit]) }, `someone sends 5 ${token.symbol} to the pair by mistake`);
  const strangerBefore = await read(token.address, "balanceOf", [trader.address]);
  await send(trader, { to: pair, data: call("skim", [trader.address]) }, "anyone calls skim(to): the excess goes to the address the caller names");
  check("a third party's skim took the excess (no keeper can reserve it for the fee address on a public chain)", (await read(token.address, "balanceOf", [trader.address])) - strangerBefore === 5n * unit);

  // 3g. the LP leaves
  const lpShares = await read(pair, "balanceOf", [lp.address]);
  await send(lp, { to: pair, data: call("approve", [router, lpShares]) }, "LP approves its LP shares to the router");
  await send(lp, { to: router, data: call("removeLiquidityBLCH", [token.address, lpShares, 0n, 0n, lp.address, deadline]) }, "LP removes all its liquidity (removeLiquidityBLCH)");
  s = await state();
  check("after the LP left only the locked minimum liquidity and the fee settled on that exit remain", (await read(pair, "balanceOf", [lp.address])) === 0n && s.totalSupply >= 1000n && s.totalSupply < 10n ** 12n + s.feeToLp + 1000n, s);
  evidence.afterExit = s;
  void factory;
} catch (error) {
  failed = true;
  evidence.error = String(error.stack ?? error).slice(0, 1500);
  console.error(error);
} finally {
  anvil.kill("SIGTERM");
}
const bad = evidence.checks.filter((c) => !c.ok).length;
evidence.result = !failed && bad === 0 ? "PASS" : "FAIL";
save();
console.log(`fork rehearsal ${key}: ${evidence.result}; deployment gas ${evidence.deploymentGas ?? "?"}; ${evidence.checks.length} checks, ${bad} failed; ${join(opt.out, "evidence.json")}`);
process.exit(evidence.result === "PASS" ? 0 : 1);
