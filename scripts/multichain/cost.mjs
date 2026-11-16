#!/usr/bin/env node
// What the deployment costs on one chain, in the chain's native coin (docs/MULTICHAIN-DEPLOY.md, "Cost").
// Read-only: gas prices and the rollups' own data-fee oracles are read from a reviewed public endpoint.
//
//   node scripts/multichain/cost.mjs <chain> --evidence <fork rehearsal DIR> [--out FILE]
//
// Execution gas per step is the fork rehearsal's receipts (the same bytecode and calldata the owner sends). The
// price is the node's eth_gasPrice at the time of the run, stated in the output; a real deployment pays the price
// of its own hour. Rollup data fees:
//   OP Stack (OP Mainnet, Base)  GasPriceOracle 0x4200…000F getL1Fee(serialized transaction)
//   Arbitrum One                 NodeInterface 0x…00C8 gasEstimateL1Component(to, false, data): gas units added to
//                                the transaction's gas, paid at the L2 gas price
//   Linea                        linea_estimateGas: the price per gas that covers the data (its priority fee part)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { loadArtifacts, loadChain, loadShared, planChain } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { encodeFunctionData, decodeFunctionResult, parseAbi, serializeTransaction, formatUnits, concat } = requireFromFrontend("viem");

const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!key || !opt.evidence) {
  console.error("usage: cost.mjs <chain> --evidence DIR [--out FILE]");
  process.exit(2);
}
const shared = loadShared();
const chain = loadChain(key);
const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
const evidence = JSON.parse(readFileSync(join(opt.evidence, "evidence.json"), "utf8"));
const ORACLE = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)", "function createPair(address,address) returns (address)"]);
const OP_ORACLE = "0x420000000000000000000000000000000000000F";
const ARB_NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);

let request = null;
let endpoint = null;
for (const url of chain.rpc) {
  try {
    const r = createRpcTransport(url, { timeoutMs: 45_000 });
    await r("eth_chainId", []);
    request = r;
    endpoint = url;
    break;
  } catch {
    /* next endpoint */
  }
}
if (!request) throw new Error("no endpoint answered");
const gasPrice = BigInt(await request("eth_gasPrice", []));
const latest = await request("eth_getBlockByNumber", ["latest", false]);
const baseFee = latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : null;

const transactions = [
  ...Object.values(plan.contracts).map((c) => ({ to: c.transaction.to, data: c.transaction.data })),
  ...plan.pairs.map((p) => ({ to: plan.contracts.factory.address, data: encodeFunctionData({ abi: ORACLE, functionName: "createPair", args: [p.token0, p.token1] }) })),
];
if (transactions.length !== evidence.deployment.length) throw new Error("the fork evidence has another number of deployment transactions than the plan");
const stack = chain.chain.stack;
const steps = [];
for (const [i, tx] of transactions.entries()) {
  const gasUsed = BigInt(evidence.deployment[i].gasUsed);
  const step = { step: evidence.deployment[i].step, calldataBytes: (tx.data.length - 2) / 2, executionGas: gasUsed, dataFeeWei: 0n, extraGas: 0n };
  if (stack.startsWith("OP Stack")) {
    // The serialized transaction as it goes to L1: the unsigned EIP-1559 body plus 67 bytes standing for the signature.
    const body = serializeTransaction({ type: "eip1559", chainId: chain.chain.chainId, nonce: 1, to: tx.to, data: tx.data, gas: gasUsed, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice, value: 0n });
    const serialized = concat([body, `0x${"ab".repeat(67)}`]);
    const out = await request("eth_call", [{ to: OP_ORACLE, data: encodeFunctionData({ abi: ORACLE, functionName: "getL1Fee", args: [serialized] }) }, "latest"]);
    step.dataFeeWei = decodeFunctionResult({ abi: ORACLE, functionName: "getL1Fee", data: out });
  } else if (stack.startsWith("Arbitrum")) {
    const out = await request("eth_call", [{ to: ARB_NODE_INTERFACE, data: encodeFunctionData({ abi: ORACLE, functionName: "gasEstimateL1Component", args: [tx.to, false, tx.data] }) }, "latest"]);
    const [l1Gas] = decodeFunctionResult({ abi: ORACLE, functionName: "gasEstimateL1Component", data: out });
    step.extraGas = BigInt(l1Gas);
  }
  steps.push(step);
}
let pricePerGas = gasPrice;
let priceNote = "eth_gasPrice";
if (stack.includes("Linea")) {
  // Linea prices the data into the priority fee; ask for the factory deployment.
  try {
    const quote = await request("linea_estimateGas", [{ from: chain.wrappedNative.address, to: transactions[0].to, data: transactions[0].data, value: "0x0" }]);
    pricePerGas = BigInt(quote.baseFeePerGas) + BigInt(quote.priorityFeePerGas);
    priceNote = `linea_estimateGas for the factory deployment: base fee ${BigInt(quote.baseFeePerGas)} + priority fee ${BigInt(quote.priorityFeePerGas)} wei`;
  } catch (error) {
    priceNote = `eth_gasPrice (linea_estimateGas failed: ${String(error.message).slice(0, 120)})`;
  }
}
for (const s of steps) s.costWei = (s.executionGas + s.extraGas) * pricePerGas + s.dataFeeWei;
const totalGas = steps.reduce((n, s) => n + s.executionGas + s.extraGas, 0n);
const totalWei = steps.reduce((n, s) => n + s.costWei, 0n);
const symbol = chain.nativeCurrency.symbol;
const out = {
  schema: "postern.dex.multichain-cost.v1",
  chain: plan.chain,
  endpoint,
  at: { block: Number(BigInt(latest.number)), timestamp: Number(BigInt(latest.timestamp)), time: new Date(Number(BigInt(latest.timestamp)) * 1000).toISOString() },
  gasPriceWei: gasPrice,
  baseFeeWei: baseFee,
  pricePerGasUsedWei: pricePerGas,
  priceNote,
  steps: steps.map((s) => ({ ...s, cost: `${formatUnits(s.costWei, 18)} ${symbol}` })),
  totalGas,
  totalWei,
  total: `${formatUnits(totalWei, 18)} ${symbol}`,
  atOtherPrices: [1n, 5n, 20n, 50n].map((gwei) => ({ gwei: Number(gwei), cost: `${formatUnits(totalGas * gwei * 10n ** 9n, 18)} ${symbol}`, note: "execution gas only" })),
};
if (opt.out) writeFileSync(opt.out, `${JSON.stringify(out, big, 2)}\n`);
for (const s of out.steps) console.log(`${s.step.padEnd(24)} gas ${String(s.executionGas).padStart(9)}${s.extraGas ? ` + ${s.extraGas} (L1 data)` : ""}${s.dataFeeWei ? ` + data fee ${formatUnits(s.dataFeeWei, 18)} ${symbol}` : ""}  = ${s.cost}`);
console.log(`cost ${key}: ${out.total} for ${totalGas} gas at ${formatUnits(pricePerGas, 9)} gwei (${priceNote}; block ${out.at.block}, ${out.at.time})`);

