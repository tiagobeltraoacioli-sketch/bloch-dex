#!/usr/bin/env node
// Permissionless `skim` keeper for DEX-02 (a standing donation above a reserve
// cap blocks swaps and mints on that side until anyone calls skim).
// Runbook: docs/OPS-DEX-MONITOR-KEEPER.md.
//
// One run does one thing at most, and a timer runs it. It is built to stay
// cheap and harmless under griefing:
//   * it only ever calls skim(Bloch Inc Safe) on a pair the gate file pins, with
//     the pair and token code hashes checked first; the recipient is not an
//     option, so a stolen keeper key can only spend the gas budget;
//   * dust below the floor is ignored, so a griefer cannot trigger a transaction
//     without forfeiting at least the floor to the Safe;
//   * every transaction is simulated first, has a gas limit and a fee ceiling,
//     and its worst-case cost is reserved against a rolling 24 h budget and a
//     transaction count BEFORE it is signed; the state file is written before
//     publishing, so a crash cannot double-spend the budget;
//   * one transaction in flight at a time, a cooldown between transactions, and
//     exponential backoff when a skim moved nothing (someone else skimmed first);
//   * it is a dry run unless --execute is given.
//
// Exit status: 0 nothing needed, or sent, or waiting; 1 needs attention (budget,
// fee ceiling, gas limit, funding, backoff); 2 refused (identity, code hash,
// simulation or publication failed); 3 the node could not answer.
//
//   node scripts/ops/dex-skim-keeper.mjs --config finality-gate.mainnet.json
//        --rpc http://127.0.0.1:18955 --keeper 0x… --state /var/lib/…/state.json
//        [--execute] [--budget-wei 10000000000000000] [--max-tx 8]
//        [--max-fee-wei 20000000000] [--max-gas 150000] [--floor-bps 100]
//        [--cooldown-s 1800] [--pending-timeout-s 7200] -- <cast signer arguments>

import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CRIT, CallReverted, IdentityError, OK, READ_ONLY_METHODS, RpcError, UNKNOWN, WARN,
  blockRef, checkIdentity, classifyExcess, codeHash, createRequest, deploymentFromGate, encode, keccak256,
  parseArgs, readBlock, readGate, readPair, recoverTransactionAddress, stringify,
} from "./dex-ops-lib.mjs";

const DAY = 86_400;
export const DEFAULTS = Object.freeze({
  budgetWei: 10_000_000_000_000_000n, // 0.01 BLCH per 24 h: all 8 transactions at a 3 gwei max fee, 4 at the 20 gwei ceiling
  maxTx: 8,
  maxFeeWei: 20_000_000_000n,
  tipWei: 1_000_000_000n,
  maxGas: 150_000n, // measured about 60-95k, depending on cold recipient balances
  floorBps: 100n,
  cooldownSeconds: 1_800, // a little over two L2 blocks at 12-15 min
  pendingTimeoutSeconds: 7_200,
  backoffCapSeconds: 6 * 3_600,
});
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const emptyState = () => ({ schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 });

export function loadState(path) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state.schema !== "postern.dex.skim-keeper.v1") throw new Error("unknown schema");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    // A damaged budget file must stop the keeper, not reset its budget.
    throw new Error(`keeper state ${path} is unreadable: ${error.message}`);
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/// Exclusive lock, so an overlapping timer run cannot share a budget or a nonce.
function acquireLock(path, now) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    if (now - statSync(lock).mtimeMs / 1000 < 600) throw new Error("another keeper run holds the lock");
    rmSync(lock);
    closeSync(openSync(lock, "wx", 0o600));
  }
  return () => rmSync(lock, { force: true });
}

const windowTxs = (state, now) => state.txs.filter((t) => now - t.at < DAY);
const windowSpend = (state, now) => windowTxs(state, now).reduce((sum, t) => sum + BigInt(t.spentWei ?? t.reservedWei), 0n);

/// Settle the transaction in flight. Returns true when it is still in flight.
async function reconcile(state, keeper, deployment, request, now, options) {
  const open = state.txs.find((t) => t.status === "pending");
  if (!open) return false;
  const receipt = await request("eth_getTransactionReceipt", [open.hash]);
  if (receipt) {
    const latest = await readBlock(request, "latest");
    // The settled RPC can serve a receipt before its `latest` view reaches that
    // block; reading reserves now would see the excess again and pay twice.
    if (latest.number < BigInt(receipt.blockNumber)) return true;
    open.spentWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0)).toString();
    const moved = (receipt.logs ?? []).some((log) => log.topics?.[0] === TRANSFER_TOPIC && BigInt(log.data || "0x0") > 0n);
    if (receipt.status !== "0x1" || !moved) {
      open.status = receipt.status === "0x1" ? "wasted" : "reverted";
      state.consecutiveWasted += 1;
      const delay = Math.min(options.cooldownSeconds * 2 ** state.consecutiveWasted, DEFAULTS.backoffCapSeconds);
      state.nextAllowedAt = now + delay;
    } else {
      open.status = "effective";
      state.consecutiveWasted = 0;
    }
    return false;
  }
  const nonce = BigInt(await request("eth_getTransactionCount", [keeper, "latest"]));
  if (nonce > BigInt(open.nonce)) {
    open.status = "replaced"; // The nonce was used by something else. The reservation stands.
    return false;
  }
  if (now - open.at > options.pendingTimeoutSeconds) {
    open.status = "expired"; // Same: the reservation stays charged until it leaves the window.
    return false;
  }
  return true;
}

/// One keeper pass. `deps`: {request, sign(tx) -> rawHex, now}. Writes state
/// through `deps.save` before anything is published.
export async function runKeeper(gate, options, state, deps) {
  const { request, sign, save, now } = deps;
  const deployment = deploymentFromGate(gate);
  const keeper = options.keeper.toLowerCase();
  const result = (level, action, detail = {}) => ({ level, action, ...detail });

  try {
    await checkIdentity(request, deployment);
    const inFlight = await reconcile(state, keeper, deployment, request, now, options);
    save(state);
    if (inFlight) return result(OK, "wait-in-flight", { hash: state.txs.find((t) => t.status === "pending").hash });

    const latest = await readBlock(request, "latest");
    const at = blockRef(latest);
    for (const token of [deployment.wrapped, ...deployment.tokens.map((t) => ({ address: t.token, codeHash: t.codeHash }))]) {
      const observed = await codeHash(request, token.address, at);
      if (observed !== token.codeHash) throw new IdentityError(`token ${token.address} code ${observed} differs from the pin`);
    }

    let target = null;
    const seen = [];
    for (const pair of deployment.pairs) {
      const observed = await codeHash(request, pair.address, at);
      if (observed !== pair.codeHash) throw new IdentityError(`pair ${pair.address} code ${observed} differs from the pin`);
      const pairState = await readPair(request, pair, at);
      const kinds = pairState.sides.map((side) => classifyExcess(side, options.floorBps));
      seen.push({ pair: pair.address, kinds, excess: pairState.sides.map((s) => s.balance - s.reserve) });
      if (kinds.includes("negative")) throw new IdentityError(`pair ${pair.address} holds less than its reserves`);
      if (!target && kinds.some((k) => k === "material" || k === "blocking")) target = pair;
    }
    if (!target) return result(OK, "nothing-to-do", { seen });

    const blocked = (action, detail) => result(WARN, action, { pair: target.address, seen, ...detail });
    if (now < state.nextAllowedAt) return blocked("backoff", { until: state.nextAllowedAt, consecutiveWasted: state.consecutiveWasted });
    const last = windowTxs(state, now).at(-1);
    if (last && now - last.at < options.cooldownSeconds) return result(OK, "cooldown", { pair: target.address, seen, until: last.at + options.cooldownSeconds });
    if (windowTxs(state, now).length >= options.maxTx) return blocked("tx-count-exhausted", { maxTx: options.maxTx });

    // The recipient is fixed: donations go to the Bloch Inc Safe, never to the
    // keeper, so running or attacking a keeper pays nobody.
    const data = encode("skim", [deployment.feeTo]);
    const txCall = { from: keeper, to: target.address, data };
    await request("eth_call", [txCall, at]);
    const estimate = BigInt(await request("eth_estimateGas", [txCall]));
    const gasLimit = (estimate * 12n) / 10n;
    if (gasLimit > options.maxGas) return blocked("gas-limit-exceeded", { estimate, maxGas: options.maxGas });

    if (latest.baseFee + options.tipWei > options.maxFeeWei) return blocked("fee-above-ceiling", { baseFee: latest.baseFee, maxFeeWei: options.maxFeeWei });
    const wanted = latest.baseFee * 2n + options.tipWei;
    const maxFee = wanted < options.maxFeeWei ? wanted : options.maxFeeWei;
    const worstCase = gasLimit * maxFee;
    const spent = windowSpend(state, now);
    if (spent + worstCase > options.budgetWei) return blocked("budget-exhausted", { spentWei: spent, worstCaseWei: worstCase, budgetWei: options.budgetWei });
    const funds = BigInt(await request("eth_getBalance", [keeper, "latest"]));
    if (funds < worstCase) return blocked("keeper-underfunded", { balanceWei: funds, worstCaseWei: worstCase });

    const plan = { pair: target.address, to: deployment.feeTo, gasLimit, maxFee, worstCaseWei: worstCase, spentWei: spent, budgetWei: options.budgetWei, seen };
    if (!options.execute) return result(OK, "would-skim", plan);

    const nonce = BigInt(await request("eth_getTransactionCount", [keeper, "pending"]));
    const raw = await sign({ chainId: deployment.chainId, nonce, gasLimit, maxFee, tip: options.tipWei, to: target.address, data });
    const signer = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
    if (signer !== keeper) throw new IdentityError(`the signer is ${signer}, not the configured keeper ${keeper}`);
    const hash = keccak256(raw);
    const entry = { at: now, hash, nonce: nonce.toString(), pair: target.address, reservedWei: worstCase.toString(), status: "pending" };
    state.txs = [...windowTxs(state, now), entry];
    save(state); // Before publishing: a crash after this point cannot overspend.
    try {
      await request("eth_sendRawTransaction", [raw]);
    } catch (error) {
      if (error instanceof RpcError && /eth_sendRawTransaction at /.test(error.message)) {
        // Transport failure: it may have arrived. Stay in flight; reconcile decides.
        return result(WARN, "publish-unconfirmed", { hash, detail: error.message });
      }
      entry.status = "refused";
      entry.spentWei = "0";
      state.nextAllowedAt = now + options.cooldownSeconds;
      save(state);
      return result(CRIT, "publish-refused", { hash, detail: error.message });
    }
    return result(OK, "sent", { hash, ...plan });
  } catch (error) {
    if (error instanceof RpcError) return result(UNKNOWN, "rpc-failed", { detail: error.message });
    if (error instanceof CallReverted) return result(CRIT, "simulation-reverted", { detail: error.message });
    if (error instanceof IdentityError) return result(CRIT, "refused", { detail: error.message });
    throw error;
  }
}

/// Sign offline with `cast mktx`, like scripts/staging/sign-and-publish.sh, so
/// any cast signer works (keystore, hardware wallet). The kit never sees a key.
function castSigner(signerArgs) {
  const run = promisify(execFile);
  return async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) => {
    const { stdout } = await run("cast", [
      "mktx", "--chain", String(chainId), "--nonce", nonce.toString(), "--gas-limit", gasLimit.toString(),
      "--gas-price", maxFee.toString(), "--priority-gas-price", tip.toString(), ...signerArgs, to, data,
    ]);
    return stdout.trim();
  };
}

function bigOption(args, name, fallback) {
  return args[name] === undefined ? fallback : BigInt(args[name]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let release = () => {};
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["execute"] });
    if (!args.config || !args.rpc || !args.keeper || !args.state) {
      console.error("usage: dex-skim-keeper.mjs --config <gate.json> --rpc <url> --keeper <address> --state <file> [--execute] [limits] -- <cast signer args>");
      process.exit(UNKNOWN);
    }
    if (args.execute && args.rest.length === 0) throw new Error("--execute needs signer arguments after --");
    const options = {
      keeper: args.keeper,
      execute: Boolean(args.execute),
      budgetWei: bigOption(args, "budget-wei", DEFAULTS.budgetWei),
      maxTx: Number(args["max-tx"] ?? DEFAULTS.maxTx),
      maxFeeWei: bigOption(args, "max-fee-wei", DEFAULTS.maxFeeWei),
      tipWei: bigOption(args, "tip-wei", DEFAULTS.tipWei),
      maxGas: bigOption(args, "max-gas", DEFAULTS.maxGas),
      floorBps: bigOption(args, "floor-bps", DEFAULTS.floorBps),
      cooldownSeconds: Number(args["cooldown-s"] ?? DEFAULTS.cooldownSeconds),
      pendingTimeoutSeconds: Number(args["pending-timeout-s"] ?? DEFAULTS.pendingTimeoutSeconds),
    };
    const now = Math.floor(Date.now() / 1000);
    release = acquireLock(args.state, now);
    const allowed = args.execute ? [...READ_ONLY_METHODS, "eth_sendRawTransaction"] : READ_ONLY_METHODS;
    const outcome = await runKeeper(readGate(args.config), options, loadState(args.state), {
      request: createRequest(args.rpc, { allowed }),
      sign: castSigner(args.rest),
      save: (state) => saveState(args.state, state),
      now,
    });
    console.log(stringify(outcome));
    release();
    process.exit(outcome.level);
  } catch (error) {
    release();
    console.error(`keeper: ${error.message}`);
    process.exit(CRIT);
  }
}
