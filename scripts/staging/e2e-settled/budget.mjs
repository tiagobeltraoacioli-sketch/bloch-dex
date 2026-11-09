#!/usr/bin/env node
// Measured budget of an e2e-settled flow, from chain state only (no key, read-only RPC methods).
//
//   node budget.mjs --rpc http://127.0.0.1:PORT --token 0x… --accounts '{"issuer":"0x…",…}' [--source LABEL] [--funded-wei WEI]
//
// For every named account it replays the token's Transfer logs in chain order and reports what came in, what went
// out, the final balance, the lowest balance after its first credit, and its PEAK NEED: the largest amount by which
// its mints (bridge credits) so far exceeded its balance. The account the bridge credited (the issuer) needs exactly
// that much bridged to run the same flow, however many deposits carried it: that is the measured bUSDC budget.
// It also reports each account's transaction count and native balance, and the chain head (the flow's block count).
import { pathToFileURL } from "node:url";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const quantity = (value, field) => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) throw new Error(`${field} is not a quantity`);
  return BigInt(value);
};
const topicAddress = (topic) => {
  if (typeof topic !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(topic)) throw new Error("Transfer topic is not an address");
  return `0x${topic.slice(26)}`;
};

/// `request(method, params)` is a JSON-RPC client. `accounts` maps a label to an address.
export async function measureBudget(request, { token, accounts, source = null, fundedWei = null, logRange = 2000n }) {
  token = token.toLowerCase();
  if (!ADDRESS.test(token)) throw new Error("token is not an address");
  const labels = new Map();
  for (const [label, address] of Object.entries(accounts)) {
    const a = String(address).toLowerCase();
    if (!ADDRESS.test(a)) throw new Error(`account ${label} is not an address`);
    if (labels.has(a)) throw new Error(`account ${label} repeats ${labels.get(a)}`);
    labels.set(a, label);
  }
  const head = quantity(await request("eth_blockNumber", []), "eth_blockNumber");
  const logs = [];
  for (let from = 0n; from <= head; from += logRange) {
    const to = from + logRange - 1n < head ? from + logRange - 1n : head;
    const part = await request("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    if (!Array.isArray(part)) throw new Error("eth_getLogs returned no list");
    logs.push(...part);
  }
  const keyed = logs.map((log) => {
    if (String(log.address).toLowerCase() !== token || log.topics?.[0] !== TRANSFER || log.topics.length !== 3 || log.removed === true) throw new Error("unexpected log in the Transfer scan");
    if (typeof log.data !== "string" || !/^0x[0-9a-f]{64}$/.test(log.data)) throw new Error("Transfer amount is not one word");
    return { block: quantity(log.blockNumber, "log blockNumber"), index: quantity(log.logIndex, "logIndex"), from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), amount: BigInt(log.data) };
  }).sort((a, b) => (a.block === b.block ? Number(a.index - b.index) : Number(a.block - b.block)));
  const book = new Map([...labels.keys()].map((a) => [a, { in: 0n, out: 0n, balance: 0n, lowest: null, transfers: 0, minted: 0n, peakNeed: 0n }]));
  let minted = 0n;
  for (const t of keyed) {
    if (/^0x0{40}$/.test(t.from)) minted += t.amount;
    for (const [side, sign] of [[t.from, -1n], [t.to, 1n]]) {
      const entry = book.get(side);
      if (!entry) continue;
      entry.balance += sign * t.amount;
      if (sign > 0n) entry.in += t.amount; else entry.out += t.amount;
      entry.transfers += 1;
      if (entry.balance < 0n) throw new Error(`the Transfer log is incomplete: ${labels.get(side)} went negative`);
      // The low-water mark counts from the first credit: before it the account simply held nothing.
      if (entry.in > 0n && (entry.lowest === null || entry.balance < entry.lowest)) entry.lowest = entry.balance;
      if (sign > 0n && /^0x0{40}$/.test(t.from)) entry.minted += t.amount;
      if (entry.minted - entry.balance > entry.peakNeed) entry.peakNeed = entry.minted - entry.balance;
    }
  }
  const result = { head: head.toString(), token, transferLogs: keyed.length, mintedUnits: minted.toString(), accounts: {} };
  for (const [address, label] of labels) {
    const entry = book.get(address);
    const onChain = BigInt(await request("eth_call", [{ to: token, data: `0x70a08231${address.slice(2).padStart(64, "0")}` }, "latest"]));
    if (onChain !== entry.balance) throw new Error(`${label}: replayed balance ${entry.balance} differs from balanceOf ${onChain}`);
    result.accounts[label] = {
      address,
      tokenInUnits: entry.in.toString(), tokenOutUnits: entry.out.toString(), tokenBalanceUnits: entry.balance.toString(),
      tokenLowestUnits: entry.lowest === null ? null : entry.lowest.toString(), tokenTransfers: entry.transfers,
      tokenMintedUnits: entry.minted.toString(), tokenPeakNeedUnits: entry.peakNeed.toString(),
      transactions: quantity(await request("eth_getTransactionCount", [address, "latest"]), "nonce").toString(),
      nativeWei: quantity(await request("eth_getBalance", [address, "latest"]), "balance").toString(),
    };
    if (fundedWei !== null) result.accounts[label].nativeNetOutWei = (BigInt(fundedWei) - BigInt(result.accounts[label].nativeWei)).toString();
  }
  if (source !== null) {
    // The flow's single source of the token: the account the bridge credited.
    const a = result.accounts[source];
    if (!a || BigInt(a.tokenMintedUnits) === 0n) throw new Error(`the bridge credited nothing to ${source}`);
    result.budget = { source, creditedUnits: a.tokenMintedUnits, lowestUnits: a.tokenLowestUnits, neededUnits: a.tokenPeakNeedUnits };
  }
  return result;
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (!["--rpc", "--token", "--accounts", "--source", "--funded-wei"].includes(name) || process.argv[i + 1] === undefined) throw new Error("usage: budget.mjs --rpc URL --token ADDRESS --accounts JSON [--source LABEL] [--funded-wei WEI]");
    args[name] = process.argv[i + 1];
  }
  if (!args["--rpc"] || !args["--token"] || !args["--accounts"]) throw new Error("usage: budget.mjs --rpc URL --token ADDRESS --accounts JSON [--source LABEL] [--funded-wei WEI]");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(args["--rpc"])) throw new Error("the rehearsal RPC must be on loopback");
  let id = 0;
  const request = async (method, params) => {
    const response = await fetch(args["--rpc"], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const report = await measureBudget(request, { token: args["--token"], accounts: JSON.parse(args["--accounts"]), source: args["--source"] ?? null, fundedWei: args["--funded-wei"] ?? null });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`budget: ${error.message}`); process.exitCode = 1; });
}
