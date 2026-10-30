#!/usr/bin/env node
// Bloch L2 mainnet DEX deployment driver. One reviewed JSON configuration in,
// one deterministic plan out; dry run by default.
//
//   validate --config C [--rehearsal]
//   plan     --config C [--rehearsal] [--out-dir out] [--write P]
//   run      --config C --plan P --rpc URL [--rehearsal] [--out-dir out]
//            [--broadcast --confirm <configSha256>] [-- <forge signer args>]
//   record   --config C --plan P --rpc URL (--broadcast-file F | --tx-hashes H)
//            [--rehearsal] [--out-dir out] --write G
//   pending  --config C                    list every TBD-owner/null field
//   preflight --config C --plan P --rpc URL [--rehearsal]   read-only checks only
//   txs      --config C --plan P --write T [--rehearsal]    unsigned transactions
//
// `txs` + scripts/staging/sign-and-publish.sh is the raw-transaction path
// (`cast mktx` offline, `cast publish`), for RPCs whose `pending` view a
// forge broadcast cannot rely on; `record --tx-hashes` then verifies it.
//
// `run` without --broadcast is a forge simulation against the RPC (dry run).
// `record` verifies the broadcast on chain (sender, nonces, init code,
// created addresses, status) and writes the schema-2 finality gate config.

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { BUCKET_CAPACITY_SELECTOR, createJsonRpcRequest, GATE_DOMAIN, verifySafe } from "./finality-gate.mjs";
import {
  BRIDGE_BUCKET_DIVISOR,
  EMPTY_CODE_HASH,
  configSha256,
  dexTransactions,
  forgeEnvironment,
  gateConfigFromPlan,
  loadArtifacts,
  pendingFields,
  planDeployment,
  stableJson,
  validateDeployConfig,
} from "./dex-deploy-config.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256 } = requireFromFrontend("viem");

const USAGE = `Usage:
  node scripts/staging/deploy-dex.mjs validate --config <c.json> [--rehearsal]
  node scripts/staging/deploy-dex.mjs plan --config <c.json> [--rehearsal] [--out-dir out] [--write <plan.json>]
  node scripts/staging/deploy-dex.mjs run --config <c.json> --plan <plan.json> --rpc <url> [--rehearsal]
      [--broadcast --confirm <configSha256>] [-- <forge signer args>]
  node scripts/staging/deploy-dex.mjs record --config <c.json> --plan <plan.json> --rpc <url>
      (--broadcast-file <run-latest.json> | --tx-hashes <hashes.txt>) --write <gate.json> [--rehearsal]
  node scripts/staging/deploy-dex.mjs pending --config <c.json>
  node scripts/staging/deploy-dex.mjs preflight --config <c.json> --plan <plan.json> --rpc <url> [--rehearsal]
  node scripts/staging/deploy-dex.mjs txs --config <c.json> --plan <plan.json> --write <txs.json> [--rehearsal]`;

function refuse(condition, message) {
  if (!condition) throw new Error(`deploy-dex: ${message}`);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const separator = rest.indexOf("--");
  const own = separator === -1 ? rest : rest.slice(0, separator);
  const forgeArgs = separator === -1 ? [] : rest.slice(separator + 1);
  const flags = new Set(["--rehearsal", "--broadcast"]);
  const options = { command, forgeArgs, rehearsal: false, broadcast: false, outDir: "out" };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (flags.has(arg)) {
      options[arg === "--rehearsal" ? "rehearsal" : "broadcast"] = true;
      continue;
    }
    const key = { "--config": "config", "--plan": "plan", "--rpc": "rpc", "--write": "write", "--confirm": "confirm",
      "--out-dir": "outDir", "--broadcast-file": "broadcastFile", "--tx-hashes": "txHashes" }[arg];
    refuse(key && i + 1 < own.length, `unknown or incomplete argument ${arg}`);
    refuse(options[key] === undefined || key === "outDir", `${arg} given twice`);
    options[key] = own[++i];
  }
  refuse(["validate", "plan", "run", "record", "pending", "preflight", "txs"].includes(command), "unknown command");
  refuse(options.config, "--config is required");
  refuse(!options.broadcast || command === "run", "--broadcast only applies to run");
  refuse(forgeArgs.length === 0 || command === "run", "forge arguments only apply to run");
  for (const arg of forgeArgs) {
    refuse(!/^--(broadcast|rpc-url|fork-url|sender|slow|resume|unlocked|skip-simulation)/.test(arg), `forge argument ${arg} is controlled by this driver`);
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function currentPlan(options) {
  const config = validateDeployConfig(await readJson(options.config), { rehearsal: options.rehearsal });
  const plan = planDeployment(config, await loadArtifacts(options.outDir), { rehearsal: options.rehearsal });
  if (options.plan) {
    const committed = await readJson(options.plan);
    refuse(stableJson(committed) === stableJson(plan), "the committed plan differs from the plan derived from this config and build");
  }
  return { config, plan };
}

function codeHashOf(code) {
  refuse(typeof code === "string" && /^0x(?:[0-9a-f]{2})*$/.test(code), "eth_getCode returned malformed code");
  return code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
}

/// Read-only checks against the target RPC before forge is started.
export async function preflight(plan, request) {
  refuse(BigInt(await request("eth_chainId", [])) === BigInt(plan.chain.id), "RPC chain ID does not match the plan");
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  refuse(genesis?.hash === plan.chain.genesisHash, "RPC genesis hash does not match the pinned value");
  const latest = BigInt(await request("eth_getTransactionCount", [plan.deployer, "latest"]));
  const pending = BigInt(await request("eth_getTransactionCount", [plan.deployer, "pending"]));
  refuse(latest === BigInt(plan.startNonce) && pending === latest, `deployer nonce is ${latest}/${pending}, plan needs ${plan.startNonce}`);
  const created = Object.entries(plan.contracts).filter(([key]) => key !== "wrappedNative" || plan.deployWrapped);
  for (const [key, { address }] of [...created, ...plan.pairs.map((p, i) => [`pair ${i}`, p])]) {
    refuse((await request("eth_getCode", [address, "latest"])) === "0x", `${key} address ${address} is already occupied`);
  }
  if (!plan.deployWrapped) {
    const { address, codeHash } = plan.contracts.wrappedNative;
    refuse(codeHashOf(await request("eth_getCode", [address, "latest"])) === codeHash, "wrapped native code hash differs");
  }
  const caps = new Map(plan.reserveCaps.map(({ token, cap }) => [token, BigInt(cap)]));
  for (const { token, symbol, codeHash, bridgeBucketCapacity } of plan.externalTokens) {
    refuse(codeHashOf(await request("eth_getCode", [token, "latest"])) === codeHash, `${symbol} code hash differs`);
    const result = await request("eth_call", [{ to: token, data: BUCKET_CAPACITY_SELECTOR }, "latest"]);
    refuse(typeof result === "string" && /^0x[0-9a-f]{64}$/.test(result), `${symbol} bucketCapacity() is unavailable`);
    refuse(BigInt(result) === BigInt(bridgeBucketCapacity), `${symbol} bridge bucket capacity differs from the config`);
    refuse(caps.get(token) * BRIDGE_BUCKET_DIVISOR <= BigInt(result), `${symbol} cap exceeds 1/${BRIDGE_BUCKET_DIVISOR} of its bridge bucket`);
  }
  for (const [name, { address, codeHash, safe }] of Object.entries(plan.roles)) {
    const observed = codeHashOf(await request("eth_getCode", [address, "latest"]));
    refuse(observed !== EMPTY_CODE_HASH && observed === codeHash, `${name} code hash differs (it must be the reviewed multisig)`);
    if (safe) await verifySafe(safe, address, request, "latest");
  }
  return { nonce: latest.toString() };
}

/// Verify broadcast transactions on chain and order them by nonce.
export async function verifyBroadcast(plan, hashes, request) {
  refuse(Array.isArray(hashes) && hashes.length === plan.steps.length, `expected ${plan.steps.length} transactions, found ${hashes?.length}`);
  const seen = [];
  for (const hash of hashes) {
    const tx = await request("eth_getTransactionByHash", [hash]);
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(tx && receipt && tx.hash === hash && receipt.transactionHash === hash, `transaction ${hash} is unknown`);
    refuse(tx.from?.toLowerCase() === plan.deployer, `transaction ${hash} was not sent by the deployer`);
    refuse(receipt.status === "0x1", `transaction ${hash} reverted`);
    const nonce = Number(BigInt(tx.nonce));
    const step = plan.steps.find((s) => s.nonce === nonce);
    refuse(step && !seen.some((s) => s.nonce === nonce), `transaction ${hash} has unplanned nonce ${nonce}`);
    if (step.action === "createPair") {
      refuse(tx.to?.toLowerCase() === plan.contracts.factory.address, `createPair ${hash} did not call the factory`);
    } else {
      refuse(tx.to === null || tx.to === undefined, `${step.action} ${hash} is not a contract creation`);
      refuse(keccak256(tx.input) === step.initCodeHash, `${step.action} ${hash} init code differs from the plan`);
      refuse(receipt.contractAddress?.toLowerCase() === step.address, `${step.action} ${hash} created the wrong address`);
    }
    seen.push({ nonce, hash });
  }
  return seen.sort((a, b) => a.nonce - b.nonce).map((s) => s.hash);
}

function runForge(plan, options) {
  const args = ["script", "script/DeployMainnet.s.sol:DeployMainnet", "--rpc-url", options.rpc, "-vv"];
  if (options.broadcast) args.push("--broadcast", "--slow");
  args.push(...options.forgeArgs);
  const result = spawnSync("forge", args, { stdio: "inherit", env: { ...process.env, ...forgeEnvironment(plan) } });
  refuse(result.status === 0, `forge exited with ${result.status ?? result.signal}`);
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "pending") {
    return { pending: pendingFields(await readJson(options.config)) };
  }
  if (options.command === "validate") {
    const config = validateDeployConfig(await readJson(options.config), { rehearsal: options.rehearsal });
    return { decision: "config-valid", configSha256: configSha256(config) };
  }
  const { config, plan } = await currentPlan(options);
  if (options.command === "plan") {
    if (options.write) await writeFile(options.write, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    return plan;
  }
  if (options.command === "txs") {
    refuse(options.plan && options.write, "--plan and --write are required");
    const txs = dexTransactions(config, await loadArtifacts(options.outDir), plan);
    await writeFile(options.write, `${JSON.stringify(txs, null, 2)}\n`, { flag: "wx" });
    return { decision: "transactions-written", file: options.write, count: txs.transactions.length, configSha256: plan.configSha256 };
  }
  refuse(options.plan && options.rpc, "--plan and --rpc are required");
  const request = createJsonRpcRequest(options.rpc);
  if (options.command === "preflight") {
    return { decision: "preflight-ok", configSha256: plan.configSha256, ...(await preflight(plan, request)) };
  }
  if (options.command === "run") {
    refuse(!options.broadcast || options.confirm === plan.configSha256, `--broadcast needs --confirm ${plan.configSha256}`);
    const checked = await preflight(plan, request);
    runForge(plan, options);
    return { decision: options.broadcast ? "broadcast" : "dry-run", configSha256: plan.configSha256, ...checked };
  }
  refuse(Boolean(options.broadcastFile) !== Boolean(options.txHashes) && options.write, "one of --broadcast-file or --tx-hashes, and --write, are required");
  // forge's transactions[] can mislabel hashes in a batch; receipts[] are the
  // chain's own, and every one is re-verified against the chain anyway.
  const hashes = options.broadcastFile
    ? ((await readJson(options.broadcastFile)).receipts ?? []).map((r) => r.transactionHash)
    : (await readFile(options.txHashes, "utf8")).split(/\s+/).filter(Boolean);
  const ordered = await verifyBroadcast(plan, hashes, request);
  const gate = gateConfigFromPlan(plan, ordered, GATE_DOMAIN);
  await writeFile(options.write, `${JSON.stringify(gate, null, 2)}\n`, { flag: "wx" });
  return { decision: "recorded", configSha256: plan.configSha256, gate: options.write };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (/unknown command|required|unknown or incomplete/.test(String(error?.message))) console.error(USAGE);
    process.exitCode = 1;
  }
}
