#!/usr/bin/env node
// The page's new-slot fee against a real settled RPC (docs/MAINNET-700770-PACKAGE.md, "New-slot fee on a real
// settled RPC"). Loopback only, throwaway keys only. It prices each call with the page's own module
// (frontend/src/mainnet/newslotfee.ts, loaded as is; Node 24 strips the types), records what the RPC answers to
// eth_createAccessList, and, when the RPC enforces the admission rule, compares the page's figure with the node's
// decision: wallet-default fees must be refused with the node's quote, the quote less 1 wei per gas must be refused,
// and the page's fees must be admitted at the first request.
//
//   node scripts/staging/newslot-rpc-check.mjs --rpc http://127.0.0.1:PORT --gate <gate.json>
//        --funder-key-file <file holding one 0x private key of a throwaway account with BLCH and bUSDC>
//        --out <result.json> [--price-wei 200000000000000] [--margin-bps 1000] [--quote-method <name>]
//        [--finalize "<command that marks the head finalized>"]
//        [--policy-file <the RPC's sequencer policy file>]
// When the RPC applies the per-sender credit rule (candidate 1b55ce1: the quote carries uncovered_max_gas), the
// credit cases run too: the page's calls from wallets without credit at the gas limits of 1 to 4 hops, a call
// above the limit (needs-credit) and above the cap, as quote, as page text and as eth_sendRawTransaction refusal,
// and a plain transfer. With --policy-file the check then writes that sender's credit into the file, standing for
// the settler's ledger (this rig has no settler), and the refused call must pass.
// When the RPC serves bloch_admissionQuote the page's module uses it (source "quote" in the result); --quote-method
// only adds the raw answer of that method to each case.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { creditRefusalText, newSlotFeeNote, priceNewSlots, transientSlots } from "../../frontend/src/mainnet/newslotfee.ts";

const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { encodeFunctionData, parseAbi, keccak256 } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const args = Object.fromEntries(process.argv.slice(2).reduce((out, v, i, all) => (i % 2 === 0 ? [...out, [v.replace(/^--/, ""), all[i + 1]]] : out), []));
for (const k of ["rpc", "gate", "funder-key-file", "out"]) if (!args[k]) { console.error(`--${k} is required`); process.exit(2); }
if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(args.rpc)) { console.error("--rpc must be a loopback URL"); process.exit(2); }
const policy = { enabled: true, freshSlotPriceWei: BigInt(args["price-wei"] ?? "200000000000000"), marginBps: Number(args["margin-bps"] ?? 1000) };
const gate = JSON.parse(readFileSync(args.gate, "utf8"));
const d = gate.deployment;
const A = { router: d.contracts.router.address, wrapped: d.contracts.wrappedNative.address, token: d.tokens[0].token, pair: d.pairs[0].address };
const chainId = gate.chain.id;
const ABI = parseAbi([
  "function approve(address,uint256)", "function transfer(address,uint256)", "function skim(address)",
  "function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForBLCH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
let id = 0;
async function raw(method, params) {
  const response = await fetch(args.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return response.json();
}
const rpc = async (method, params) => {
  const body = await raw(method, params);
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpcError: body.error });
  return body.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (v) => (typeof v === "bigint" ? v.toString() : v);
const result = { schema: "postern.dex.newslot-rpc-check.v1", rpc: args.rpc, chainId, policy: { ...policy, freshSlotPriceWei: policy.freshSlotPriceWei.toString() }, addresses: A, cases: [], accessListProbes: [] };
const save = () => writeFileSync(args.out, `${JSON.stringify(result, (_, v) => big(v), 2)}\n`);

// Does this RPC serve the node's own quote (bloch_admissionQuote)? Then the page uses it, and falls back otherwise.
const quoteProbe = await raw("bloch_admissionQuote", [{ from: `0x${"11".repeat(20)}`, to: A.token, data: "0x", value: "0x0", gas: "0x186a0" }]);
const quoteServed = quoteProbe.result?.kind === "sequencer-admission-quote" || (quoteProbe.error && quoteProbe.error.code !== -32601 && !/no sequencer admission policy|not found/i.test(quoteProbe.error.message ?? ""));
result.quoteMethod = { served: Boolean(quoteServed), probe: quoteProbe.result ?? quoteProbe.error };
console.log(`bloch_admissionQuote: ${quoteServed ? "served" : "not served (the page prices with the access list)"}`);
const funder = privateKeyToAccount(readFileSync(args["funder-key-file"], "utf8").trim());
const fresh = () => privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const nonceOf = async (a, tag = "latest") => BigInt(await rpc("eth_getTransactionCount", [a, tag]));
const baseFee = async () => BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
const deadline = async () => BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) + 86_400n;

async function sign(account, call, fees) {
  return account.signTransaction({ type: "eip1559", chainId, nonce: Number(await nonceOf(account.address)), to: call.to, data: call.data, value: call.value, gas: call.gas, ...fees });
}
/// Publish; returns { admitted: hash } or { refused: error }.
async function publish(rawTx) {
  const body = await raw("eth_sendRawTransaction", [rawTx]);
  return body.error ? { refused: body.error } : { admitted: body.result };
}
async function mined(hash) {
  for (let i = 0; i < 240; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await sleep(500);
  }
  throw new Error(`no receipt for ${hash}`);
}
/// A transaction of the rig's own funder: generous fees, waits for inclusion.
async function fund(call) {
  const base = await baseFee();
  const tip = 20_000_000_000n;
  const out = await publish(await sign(funder, call, { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * base + tip }));
  if (!out.admitted) throw new Error(`the funder's transaction was refused: ${JSON.stringify(out.refused)}`);
  const receipt = await mined(out.admitted);
  if (receipt.status !== "0x1") throw new Error(`the funder's transaction reverted: ${out.admitted}`);
}
const quantities = (data) => Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, typeof v === "string" && /^0x[0-9a-f]+$/.test(v) && v.length < 40 ? BigInt(v).toString() : v]));

/// One call of `account`, as the page would send it.
async function runCase(name, account, call) {
  const entry = { name, from: account.address, to: call.to, gasLimit: call.gas };
  result.cases.push(entry);
  entry.createAccessList = (await raw("eth_createAccessList", [{ from: call.from, to: call.to, data: call.data, value: hex(call.value), gas: hex(call.gas) }, "latest"])).result ?? null;
  const fee = await priceNewSlots(rpc, call, policy, transientSlots({ wrapped: A.wrapped, router: A.router }));
  entry.page = fee ?? { possibleNewSlots: 0n, note: "no possible new slot: the wallet picks the fee" };
  if (args["quote-method"]) entry.quote = await raw(args["quote-method"], [{ from: call.from, to: call.to, data: call.data, value: hex(call.value), gas: hex(call.gas) }]);
  const base = await baseFee();
  const publishedTip = BigInt(await rpc("eth_maxPriorityFeePerGas", []));
  // 1. What a wallet sends by itself: the RPC's published tip.
  const walletFees = { maxPriorityFeePerGas: publishedTip, maxFeePerGas: 2n * base + publishedTip };
  const first = await publish(await sign(account, call, walletFees));
  entry.walletDefault = first.admitted ? { admitted: true } : { admitted: false, code: first.refused.code, message: first.refused.message, kind: first.refused.data?.kind ?? null, node: quantities(first.refused.data) };
  let hash = first.admitted;
  if (!hash) {
    const required = first.refused.data?.requiredPriorityFeePerGas ? BigInt(first.refused.data.requiredPriorityFeePerGas) : null;
    if (required !== null && required > 1n) {
      // 2. One wei per gas below the node's own requirement: refused.
      const below = await publish(await sign(account, call, { maxPriorityFeePerGas: required - 1n, maxFeePerGas: 2n * base + required }));
      entry.oneWeiBelow = below.admitted ? { admitted: true } : { admitted: false, kind: below.refused.data?.kind ?? null };
      if (below.admitted) hash = below.admitted;
    }
    if (!hash) {
      if (!fee) throw new Error(`${name}: refused with the wallet's fees, and the page priced no new slot`);
      // 3. The page's fees, at the first request with them.
      const paged = await publish(await sign(account, call, { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas }));
      entry.pageFees = paged.admitted ? { admitted: true } : { admitted: false, message: paged.refused.message, kind: paged.refused.data?.kind ?? null, node: quantities(paged.refused.data) };
      if (required !== null) {
        entry.nodeRequiredTip = required;
        entry.pageOverNodeRatio = Number((fee.maxPriorityFeePerGas * 10_000n) / required) / 10_000;
        entry.nodeFreshSlots = BigInt(first.refused.data.chargedFreshSlots ?? first.refused.data.freshSlots);
        entry.slotsMatch = entry.nodeFreshSlots === fee.possibleNewSlots;
      }
      hash = paged.admitted;
    }
  }
  if (hash) {
    const receipt = await mined(hash);
    entry.mined = { status: receipt.status, gasUsed: BigInt(receipt.gasUsed), effectiveGasPrice: BigInt(receipt.effectiveGasPrice) };
    if (fee) entry.pageGasLowerBoundHolds = fee.gasUsed <= BigInt(receipt.gasUsed);
  }
  save();
  console.log(`${name}: page (${fee?.source ?? (quoteServed ? "quote" : "access-list")}) slots ${fee?.possibleNewSlots ?? 0n}, tip ${fee?.maxPriorityFeePerGas ?? "wallet"}; wallet-default ${entry.walletDefault.admitted ? "admitted" : `refused (${entry.walletDefault.kind ?? entry.walletDefault.message})`}${entry.pageFees ? `; page fees ${entry.pageFees.admitted ? "admitted" : "REFUSED"}; node tip ${entry.nodeRequiredTip ?? "?"}, ratio ${entry.pageOverNodeRatio ?? "?"}` : ""}`);
  return entry;
}

/// What eth_createAccessList answers for accounts that cannot pay.
async function probe(name, call, extra = {}) {
  const body = await raw("eth_createAccessList", [{ from: call.from, to: call.to, data: call.data, value: hex(call.value), gas: hex(call.gas), ...extra }, "latest"]);
  let page;
  try {
    const fee = await priceNewSlots(rpc, call, policy, transientSlots({ wrapped: A.wrapped, router: A.router }));
    page = fee ? { possibleNewSlots: fee.possibleNewSlots, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : { possibleNewSlots: 0n };
  } catch (error) {
    page = { refusedToPrice: error.message };
  }
  result.accessListProbes.push({ name, balance: BigInt(await rpc("eth_getBalance", [call.from, "latest"])), reply: body.result ?? { rpcError: body.error }, page });
  console.log(`probe ${name}: ${JSON.stringify(body.result ?? body.error).slice(0, 160)} | page: ${JSON.stringify(page, (_, v) => big(v))}`);
  save();
}

const approve = (from, amount) => ({ from, to: A.token, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [A.router, amount] }), value: 0n, gas: 100_000n });
const user = fresh(), native = fresh(), poor = fresh(), empty = fresh();
console.log(`funder ${funder.address}; throwaway users ${user.address} ${native.address}`);
// Funding: BLCH and bUSDC for the first user, BLCH only for the second, a few thousand gwei for the poor one.
await fund({ to: user.address, data: "0x", value: 2n * 10n ** 18n, gas: 100_000n });
await fund({ to: A.token, data: encodeFunctionData({ abi: ABI, functionName: "transfer", args: [user.address, 50_000_000n] }), value: 0n, gas: 150_000n });
await fund({ to: native.address, data: "0x", value: 2n * 10n ** 18n, gas: 100_000n });
// Enough for the approve at the page's suggested fee (about 100,000 gas x 15 gwei), far below a node gas cap x price.
await fund({ to: poor.address, data: "0x", value: 2n * 10n ** 15n, gas: 100_000n });
if (args.finalize) execSync(args.finalize, { stdio: "ignore" });

await probe("zero-balance account, first approve", approve(empty.address, 10_000_000n));
await probe("zero-balance account, with fee fields", approve(empty.address, 10_000_000n), { maxFeePerGas: hex(20n * 10n ** 9n), maxPriorityFeePerGas: hex(10n ** 9n) });
await probe("low-balance account (0.002 BLCH), first approve", approve(poor.address, 10_000_000n));
await probe("low-balance account, native swap worth more than its balance", { from: poor.address, to: A.router, data: encodeFunctionData({ abi: ABI, functionName: "swapExactBLCHForTokens", args: [0n, [A.wrapped, A.token], poor.address, await deadline()] }), value: 10n ** 17n, gas: 250_000n });

await runCase("first approve of bUSDC by a fresh account", user, approve(user.address, 10_000_000n));
await runCase("swap bUSDC for BLCH after the approve", user, { from: user.address, to: A.router, data: encodeFunctionData({ abi: ABI, functionName: "swapExactTokensForBLCH", args: [10_000_000n, 0n, [A.token, A.wrapped], user.address, await deadline()] }), value: 0n, gas: 250_000n });
await runCase("first approve by a low-balance account (0.002 BLCH)", poor, approve(poor.address, 1_000_000n));
const nativeSwap = async () => ({ from: native.address, to: A.router, data: encodeFunctionData({ abi: ABI, functionName: "swapExactBLCHForTokens", args: [0n, [A.wrapped, A.token], native.address, await deadline()] }), value: 10n ** 16n, gas: 250_000n });
await runCase("first native swap BLCH for bUSDC (the account never held bUSDC)", native, await nativeSwap());
await runCase("the same native swap again", native, await nativeSwap());
// A skim to the caller: a donation of 1 bUSDC from the funder first, so there is something to skim.
await fund({ to: A.token, data: encodeFunctionData({ abi: ABI, functionName: "transfer", args: [A.pair, 1_000_000n] }), value: 0n, gas: 150_000n });
await runCase("skim of a donation to the caller", native, { from: native.address, to: A.pair, data: encodeFunctionData({ abi: ABI, functionName: "skim", args: [native.address] }), value: 0n, gas: 200_000n });

// ---- the per-sender credit rule (only when this RPC applies it) ----
const quoteOf = async (call) => (await raw("bloch_admissionQuote", [{ from: call.from, to: call.to, data: call.data, value: hex(call.value), gas: hex(call.gas) }])).result ?? null;
const creditProbe = quoteServed ? await quoteOf(approve(user.address, 1n)) : null;
const creditRule = typeof creditProbe?.uncovered_max_gas === "number";
result.creditRule = { applied: creditRule, uncoveredMaxGas: creditProbe?.uncovered_max_gas ?? null, maxTxGas: creditProbe?.max_tx_gas ?? null, checks: [] };
const FEE_ADVICE = /raise|increase the (fee|tip)|higher (fee|tip) (will|would|helps)|try a higher|retry (at|with) a higher/i;
const creditBad = [];
if (creditRule) {
  const expect = (name, ok, detail) => {
    result.creditRule.checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) creditBad.push(name);
    console.log(`credit: ${ok ? "ok  " : "FAIL"} ${name}`);
    save();
  };
  const pageFor = (call) => priceNewSlots(rpc, call, policy, transientSlots({ wrapped: A.wrapped, router: A.router })).then((fee) => ({ fee }), (error) => ({ refused: error.message }));
  const swapOf = async (account, gas) => ({ from: account.address, to: A.router, data: encodeFunctionData({ abi: ABI, functionName: "swapExactBLCHForTokens", args: [0n, [A.wrapped, A.token], account.address, await deadline()] }), value: 10n ** 15n, gas });
  const feesFor = async (fee) => {
    const base = await baseFee();
    const tip = fee?.maxPriorityFeePerGas ?? BigInt(await rpc("eth_maxPriorityFeePerGas", []));
    return { maxPriorityFeePerGas: tip, maxFeePerGas: (fee?.maxFeePerGas ?? 2n * base + tip) };
  };
  // 1. The page's router calls from wallets that never paid: the gas limits of 1, 2, 3 and 4 hops (the rig has
  //    one pool, so the route is one hop; the rule looks at the gas limit only).
  for (const hops of [1n, 2n, 3n, 4n]) {
    const wallet = fresh();
    await fund({ to: wallet.address, data: "0x", value: 10n ** 18n, gas: 100_000n });
    const call = await swapOf(wallet, 250_000n * hops);
    const quote = await quoteOf(call);
    const page = await pageFor(call);
    const sent = page.fee === undefined ? { refused: { message: "not sent: the page refused" } } : await publish(await sign(wallet, call, await feesFor(page.fee)));
    const receipt = sent.admitted ? await mined(sent.admitted) : null;
    expect(`a fresh wallet's first swap at the ${hops}-hop gas limit (${250_000n * hops}) is executable, admitted with the page's fees and mined`,
      quote?.executable === true && quote.covered === false && sent.admitted && receipt?.status === "0x1",
      { quote, page: page.fee ? { tip: page.fee.maxPriorityFeePerGas, source: page.fee.source, firstTransferTip: page.fee.firstTransferTip ?? null, note: newSlotFeeNote(page.fee) } : page, sent: sent.admitted ?? sent.refused, gasUsed: receipt ? BigInt(receipt.gasUsed) : null });
  }
  // 2. Above the limit of a wallet without credit, and above the cap for anybody.
  const above = fresh();
  await fund({ to: above.address, data: "0x", value: 10n ** 18n, gas: 100_000n });
  const overLimit = BigInt(creditProbe.uncovered_max_gas) + 250_000n;
  const overCap = BigInt(creditProbe.max_tx_gas) + 1_000_000n;
  for (const [gas, reason] of [[overLimit, "needs-credit"], [overCap, "gas-limit-above-cap"]]) {
    const call = await swapOf(above, gas);
    const quote = await quoteOf(call);
    const page = await pageFor(call);
    expect(`gas limit ${gas}: the quote says ${reason}`, quote?.executable === false && quote.not_executable_reason === reason, quote);
    expect(`gas limit ${gas}: the page sends nothing, says a higher fee does not help, and gives no fee advice`,
      typeof page.refused === "string" && /A higher fee does not help/.test(page.refused) && /Nothing was sent\.$/.test(page.refused) && !FEE_ADVICE.test(page.refused.replaceAll("A higher fee does not help", "")), page);
    const sent = await publish(await sign(above, call, await feesFor(null)));
    const said = sent.refused ? creditRefusalText(sent.refused.data?.kind, sent.refused.data ?? {}) : null;
    expect(`gas limit ${gas}: eth_sendRawTransaction refuses with sequencer-${reason}, and the page has a text for it`,
      sent.refused?.data?.kind === `sequencer-${reason}` && typeof said === "string" && !FEE_ADVICE.test(said.replaceAll("A higher fee does not help", "")), { refusal: sent.refused ?? sent.admitted, pageText: said });
  }
  expect("nothing of the refused calls was queued", (await nonceOf(above.address, "pending")) === 0n, (await nonceOf(above.address, "pending")).toString());
  // 3. The remedy the page names: one plain transfer, never refused by the credit rule.
  const needs = await quoteOf(await swapOf(above, overLimit));
  const pageSaid = (await pageFor(await swapOf(above, overLimit))).refused ?? "";
  const named = /one plain transfer with a priority fee of (\d+) wei per gas/.exec(pageSaid);
  expect("the page names the priority fee of the plain transfer", Boolean(named), pageSaid);
  if (named) {
    const tip = BigInt(named[1]);
    const base = await baseFee();
    const transfer = await publish(await sign(above, { to: above.address, data: "0x", value: 0n, gas: 21_000n }, { maxPriorityFeePerGas: tip, maxFeePerGas: 2n * base + tip }));
    const receipt = transfer.admitted ? await mined(transfer.admitted) : null;
    const paid = receipt ? BigInt(receipt.gasUsed) * (BigInt(receipt.effectiveGasPrice) - BigInt((await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])).baseFeePerGas)) : 0n;
    expect("the plain transfer of the wallet without credit is admitted and mined at that fee", receipt?.status === "0x1", { transfer: transfer.admitted ?? transfer.refused, tip, tipsPaidWei: paid });
    expect("the tips it paid are at least the credit the quote said the call needs", paid >= BigInt(needs?.credit_needed_wei ?? "0") && paid > 0n, { paid, needed: needs?.credit_needed_wei });
    if (args["policy-file"] && receipt?.status === "0x1") {
      // The settler's ledger, written by hand: this rig has no settler. Credit = the tips the transfer paid.
      const file = JSON.parse(readFileSync(args["policy-file"], "utf8"));
      file.admission.credit = { ...file.admission.credit, [above.address.toLowerCase()]: paid.toString() };
      writeFileSync(`${args["policy-file"]}.tmp`, JSON.stringify(file));
      renameSync(`${args["policy-file"]}.tmp`, args["policy-file"]);
      let quote = null;
      const call = await swapOf(above, overLimit);
      for (let i = 0; i < 60 && quote?.executable !== true; i++) { await sleep(1000); quote = await quoteOf(call); }
      // The transfer's own high tip can lift the tip this RPC publishes (it follows recent blocks) above the 15 gwei
      // the page accepts; ordinary transfers of the funder bring it back. Recorded, because a user meets the same wait.
      const publishedAfterTransfer = BigInt(await rpc("eth_maxPriorityFeePerGas", []));
      let ordinaryTransfers = 0;
      const calm = async () => {
        for (let i = 0; i < 40 && BigInt(await rpc("eth_maxPriorityFeePerGas", [])) > 2n * 10n ** 9n; i++) {
          const base = await baseFee();
          const out = await publish(await sign(funder, { to: funder.address, data: "0x", value: 0n, gas: 21_000n }, { maxPriorityFeePerGas: 10n ** 9n, maxFeePerGas: 2n * base + 10n ** 9n }));
          if (out.admitted) await mined(out.admitted);
          ordinaryTransfers++;
        }
      };
      await calm();
      result.creditRule.publishedTipAfterTransfer = { wei: publishedAfterTransfer, afterOrdinaryTransfers: BigInt(await rpc("eth_maxPriorityFeePerGas", [])) };
      // The tip this RPC publishes moved with the traffic of this check, and the credit needed is gas limit x the
      // tip of the call: when the page says the credit is short of its own tip, the user follows the text again
      // (at most three more transfers), and the ledger gets what each transfer paid.
      let page = await pageFor(call);
      const moreTransfers = [];
      for (let round = 0; round < 3 && page.fee === undefined; round++) {
        const again = /one plain transfer with a priority fee of (\d+) wei per gas/.exec(page.refused ?? "");
        if (!again) break;
        const t = BigInt(again[1]);
        const b = await baseFee();
        const out = await publish(await sign(above, { to: above.address, data: "0x", value: 0n, gas: 21_000n }, { maxPriorityFeePerGas: t, maxFeePerGas: 2n * b + t }));
        if (!out.admitted) break;
        const r = await mined(out.admitted);
        const more = BigInt(r.gasUsed) * (BigInt(r.effectiveGasPrice) - BigInt((await rpc("eth_getBlockByNumber", [r.blockNumber, false])).baseFeePerGas));
        moreTransfers.push({ tip: t, tipsPaidWei: more, pageSaid: page.refused });
        const ledger = JSON.parse(readFileSync(args["policy-file"], "utf8"));
        const key = above.address.toLowerCase();
        ledger.admission.credit[key] = (BigInt(ledger.admission.credit[key]) + more).toString();
        writeFileSync(`${args["policy-file"]}.tmp`, JSON.stringify(ledger));
        renameSync(`${args["policy-file"]}.tmp`, args["policy-file"]);
        for (let i = 0; i < 60 && (await quoteOf(call))?.credit_wei !== ledger.admission.credit[key]; i++) await sleep(1000);
        await calm();
        page = await pageFor(call);
      }
      result.creditRule.transfersAfterTheTipMoved = moreTransfers;
      result.creditRule.ordinaryTransfersOfTheFunder = ordinaryTransfers;
      const sent = page.fee === undefined ? { refused: { message: page.refused } } : await publish(await sign(above, call, await feesFor(page.fee)));
      const after = sent.admitted ? await mined(sent.admitted) : null;
      expect("with that credit in the sequencer's ledger (written by the check: MODELLED settler) the same call is executable, admitted with the page's fees and mined",
        quote?.executable === true && sent.admitted && after?.status === "0x1", { quote, page: page.fee ? { tip: page.fee.maxPriorityFeePerGas, source: page.fee.source } : page, sent: sent.admitted ?? sent.refused });
    }
  }
} else console.log("credit rule: not applied by this RPC (no uncovered_max_gas in the quote); the credit cases were not run");
result.creditRule.failed = creditBad;

const enforced = result.cases.some((c) => c.walletDefault.kind === "sequencer-fee-underpriced");
result.admissionRuleEnforced = enforced;
const bad = result.cases.filter((c) => (c.pageFees && !c.pageFees.admitted) || c.oneWeiBelow?.admitted || c.pageGasLowerBoundHolds === false || (c.walletDefault.admitted === false && !c.pageFees));
result.summary = { cases: result.cases.length, admissionRuleEnforced: enforced, quoteServed: Boolean(quoteServed), sources: result.cases.map((c) => c.page.source ?? "none"), pageFeesRefused: bad.length, creditRuleApplied: creditRule, creditChecks: result.creditRule.checks.length, creditChecksFailed: creditBad.length, result: bad.length + creditBad.length === 0 ? "PASS" : "FAIL" };
save();
console.log(`new-slot RPC check: ${result.summary.result}; admission rule ${enforced ? "enforced" : "NOT enforced by this RPC"}; ${args.out}`);
void keccak256;
process.exit(bad.length + creditBad.length === 0 ? 0 : 1);
