#!/usr/bin/env node
// Read-only count of the non-zero storage slots of the contracts a swap touches: the pairs,
// WBLCH and the listed tokens. It exists because the settlement guest loads the complete
// storage of every account a block touches, about 12.5k instructions per slot, and nothing
// else reports the count. Runbook: docs/OPS-DEX-MONITOR-KEEPER.md.
//
// It scans Transfer, Approval and bridge mint logs, keeps the candidates in a state file and
// re-reads each slot that a new log may have changed. So one run scans only new blocks. Slots
// are counted for the listed contracts, not the system accounts, and a swap's cost also holds
// the L2 height's share, which `capacity` subtracts.
//
// Exit status: 0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN.
//
//   node scripts/ops/dex-storage-footprint.mjs --config finality-gate.mainnet.json
//        --rpc http://127.0.0.1:18955 --state /var/lib/…/footprint.json
//        [--warn-bps 3750] [--crit-bps 6250] [--log-range 2000] [--json]

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { CRIT, LEVEL_NAMES, OK, RpcError, UNKNOWN, WARN, ZERO_ADDRESS, createRequest, decodeFunctionResult, deploymentFromGate, encodeFunctionData, keccak256, parseAbi, parseArgs, readBlock, stringify } from "./dex-ops-lib.mjs";
import { isMain } from "../staging/is-main.mjs";

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function pendingMints(bytes32) view returns (address, uint64, uint64)",
]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
// Slots with no log of their own, read from a state dump at the RC after the seed and swaps.
// pair: factory, token0, token1, reserves, two price accumulators, kLast, lock, caps, supply,
// and the locked shares of address(0). token: BridgedStablecoinV2 with 1 signer, 1 guardian.
const FIXED = Object.freeze({ pair: 11, wrapped: 1, token: 12 });

// Measured guest cost: agent 82, on settlement_v3_mainnet. A proof exists up to 107M instructions.
export const COST = Object.freeze({ provenInstructions: 107_000_000n, emptyAt0: 1_100_000n, perHeight: 27_300n, perSlot: 12_500n, swapExtra: 2_000_000n });

/// Slots a block can touch in total at this L2 height and stay inside the proven class.
export function capacity(height) {
  const used = COST.emptyAt0 + COST.perHeight * height + COST.swapExtra;
  return used >= COST.provenInstructions ? 0n : (COST.provenInstructions - used) / COST.perSlot;
}

const emptyContract = () => ({ holders: {}, allowances: {}, permitters: {}, replay: 0, pending: {} });
const emptyState = () => ({ schema: "postern.dex.storage-footprint.v1", scannedTo: 0, history: [], contracts: {} });
const addressOf = (topic) => `0x${topic.slice(-40)}`.toLowerCase();

async function read(request, to, functionName, args, at) {
  const out = await request("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, at]);
  return decodeFunctionResult({ abi: ABI, functionName, data: out });
}

/// One pass. Returns {level, action, …}. `events` are the keccak hashes of the bridge's events.
export async function runFootprint(gate, options, state, deps) {
  const { request, save, now } = deps;
  const deployment = deploymentFromGate(gate);
  const listed = [
    ...deployment.pairs.map((p) => ({ address: p.address.toLowerCase(), kind: "pair", permits: true })),
    { address: deployment.wrapped.address.toLowerCase(), kind: "wrapped", permits: false },
    ...deployment.tokens.map((t) => ({ address: t.token.toLowerCase(), kind: "token", permits: false })),
  ];
  const latest = await readBlock(request, "latest");
  const at = `0x${latest.number.toString(16)}`;
  const range = BigInt(options.logRange ?? 2000);
  for (const c of listed) state.contracts[c.address] ??= emptyContract();
  let from = BigInt(state.scannedTo) + 1n;
  while (from <= latest.number) {
    const to = from + range - 1n < latest.number ? from + range - 1n : latest.number;
    const logs = await request("eth_getLogs", [{ address: listed.map((c) => c.address), fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    const dirtyHolders = new Map();
    const dirtyAllowances = new Map();
    const dirtyPermits = new Map();
    for (const log of logs) {
      const address = log.address.toLowerCase();
      const contract = state.contracts[address];
      if (!contract) continue;
      const [topic] = log.topics;
      if (topic === TRANSFER) {
        for (const who of [addressOf(log.topics[1]), addressOf(log.topics[2])]) {
          if (who !== ZERO_ADDRESS) dirtyHolders.set(`${address}:${who}`, [address, who]);
        }
        // transferFrom spends an allowance with no Approval log.
        const owner = addressOf(log.topics[1]);
        for (const key of Object.keys(contract.allowances)) {
          if (key.startsWith(`${owner}:`)) dirtyAllowances.set(`${address}:${key}`, [address, owner, key.split(":")[1]]);
        }
      } else if (topic === APPROVAL) {
        const [owner, spender] = [addressOf(log.topics[1]), addressOf(log.topics[2])];
        dirtyAllowances.set(`${address}:${owner}:${spender}`, [address, owner, spender]);
        dirtyPermits.set(`${address}:${owner}`, [address, owner]);
      } else if (deps.events?.mintExecuted === topic) {
        // One `minted` entry per deposit, forever. A queued mint pays this at MintQueued.
        if (!contract.pending[log.topics[1]]) contract.replay += 1;
        delete contract.pending[log.topics[1]];
      } else if (deps.events?.mintQueued === topic) {
        contract.replay += 1;
        contract.pending[log.topics[1]] = true;
      }
    }
    for (const [address, who] of dirtyHolders.values()) {
      const contract = state.contracts[address];
      if ((await read(request, address, "balanceOf", [who], at)) !== 0n) contract.holders[who] = true;
      else delete contract.holders[who];
    }
    for (const [address, owner, spender] of dirtyAllowances.values()) {
      const contract = state.contracts[address];
      const key = `${owner}:${spender}`;
      if ((await read(request, address, "allowance", [owner, spender], at)) !== 0n) contract.allowances[key] = true;
      else delete contract.allowances[key];
    }
    for (const [address, owner] of dirtyPermits.values()) {
      const c = listed.find((x) => x.address === address);
      if (c?.permits && (await read(request, address, "nonces", [owner], at)) !== 0n) state.contracts[address].permitters[owner] = true;
    }
    state.scannedTo = Number(to);
    save(state);
    from = to + 1n;
  }
  const count = (c, address) => {
    const s = state.contracts[address];
    return FIXED[c.kind] + Object.keys(s.holders).length + Object.keys(s.allowances).length + Object.keys(s.permitters).length + s.replay + Object.keys(s.pending).length * 2;
  };
  const per = Object.fromEntries(listed.map((c) => [c.address, count(c, c.address)]));
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  const cap = capacity(latest.number);
  const used = cap === 0n ? 10_000n : (BigInt(total) * 10_000n) / cap;
  state.history = [...state.history.filter((h) => now - h.at < 7 * 86_400), { at: now, total, height: Number(latest.number) }];
  const day = state.history.find((h) => now - h.at <= 86_400) ?? state.history[0];
  const growth24h = total - day.total;
  const level = used >= BigInt(options.critBps ?? 6250) ? CRIT : used >= BigInt(options.warnBps ?? 3750) ? WARN : OK;
  save(state);
  return { level, height: latest.number, total, perContract: per, capacitySlots: cap, usedBps: used, growth24h, note: "Count of listed contracts against the proven class at this height. Swaps touch all of them in one block" };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["json"], options: ["config", "rpc", "state", "crit-bps", "warn-bps", "log-range"] });
    if (!args.config || !args.rpc || !args.state) {
      console.error("usage: dex-storage-footprint.mjs --config <gate.json> --rpc <url> --state <file> [--warn-bps B] [--crit-bps B] [--log-range N] [--json]");
      process.exit(UNKNOWN);
    }
    let state;
    try {
      state = JSON.parse(readFileSync(args.state, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = emptyState();
    }
    const save = (s) => {
      mkdirSync(dirname(args.state), { recursive: true });
      writeFileSync(`${args.state}.tmp`, JSON.stringify(s));
      renameSync(`${args.state}.tmp`, args.state);
    };
    const toBytes = (text) => new TextEncoder().encode(text);
    const events = {
      mintExecuted: keccak256(toBytes("MintExecuted(bytes32,address,uint64)")),
      mintQueued: keccak256(toBytes("MintQueued(bytes32,address,uint64,uint256)")),
    };
    const request = createRequest(args.rpc, { allowed: ["eth_call", "eth_getBlockByNumber", "eth_getLogs"] });
    const result = await runFootprint(JSON.parse(readFileSync(args.config, "utf8")), { warnBps: args["warn-bps"], critBps: args["crit-bps"], logRange: args["log-range"] }, state, { request, save, now: Math.floor(Date.now() / 1000), events });
    if (args.json) console.log(stringify({ status: LEVEL_NAMES[result.level], ...result }));
    else console.log(`${LEVEL_NAMES[result.level]} dex-storage-footprint: ${result.total} slots of ${result.capacitySlots} at height ${result.height} (${result.usedBps} bps), +${result.growth24h} in 24 h`);
    process.exit(result.level);
  } catch (error) {
    console.error(`UNKNOWN dex-storage-footprint: ${error.message}`);
    process.exit(error instanceof RpcError ? UNKNOWN : CRIT);
  }
}
