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
//   preflight --config C --plan P --rpc URL [--rpc2 URL2] [--rehearsal]   read-only checks only
//            (--rpc2, a second endpoint run by another operator, is required on the mainnet when Bloch Inc
//            is the owner's plain fee address: its "no code, no EIP-7702 delegation" is read from both at
//            one block hash; `run` takes it too)
//   txs      --config C --plan P --write T [--rehearsal]    unsigned transactions
//   check-pair --plan P --rpc URL   is the planned pair, created by anyone, identical?
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
import { BUCKET_CAPACITY_SELECTOR, createJsonRpcRequest, GATE_DOMAIN, OWNER_FEE_EOA, verifySafe } from "./finality-gate.mjs";
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
import { isMain } from "./is-main.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, stringToHex } = requireFromFrontend("viem");

const USAGE = `Usage:
  node scripts/staging/deploy-dex.mjs validate --config <c.json> [--rehearsal]
  node scripts/staging/deploy-dex.mjs plan --config <c.json> [--rehearsal] [--out-dir out] [--write <plan.json>]
  node scripts/staging/deploy-dex.mjs run --config <c.json> --plan <plan.json> --rpc <url> [--rehearsal]
      [--broadcast --confirm <configSha256>] [-- <forge signer args>]
  node scripts/staging/deploy-dex.mjs record --config <c.json> --plan <plan.json> --rpc <url>
      (--broadcast-file <run-latest.json> | --tx-hashes <hashes.txt>) --write <gate.json> [--rehearsal]
  node scripts/staging/deploy-dex.mjs pending --config <c.json>
  node scripts/staging/deploy-dex.mjs preflight --config <c.json> --plan <plan.json> --rpc <url> [--rehearsal]
  node scripts/staging/deploy-dex.mjs txs --config <c.json> --plan <plan.json> --write <txs.json> [--rehearsal]
  node scripts/staging/deploy-dex.mjs check-pair --plan <plan.json> --rpc <url>`;

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
    const key = { "--config": "config", "--plan": "plan", "--rpc": "rpc", "--rpc2": "rpc2", "--write": "write", "--confirm": "confirm",
      "--out-dir": "outDir", "--broadcast-file": "broadcastFile", "--tx-hashes": "txHashes" }[arg];
    refuse(key && i + 1 < own.length, `unknown or incomplete argument ${arg}`);
    refuse(options[key] === undefined || key === "outDir", `${arg} given twice`);
    options[key] = own[++i];
  }
  refuse(["validate", "plan", "run", "record", "pending", "preflight", "txs", "check-pair"].includes(command), "unknown command");
  refuse(options.config || command === "check-pair", "--config is required");
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

/// Owner decision 2026-11-17: Bloch Inc may be the owner's plain fee address. The fee recipient is fixed in
/// the factory forever, so "no code and no EIP-7702 delegation" is read from TWO endpoints at ONE block:
/// the first endpoint's head block is fetched by hash from both (same number and hash), then both return
/// the account's code at that block hash, which must be exactly empty ("0x"). A delegation designator
/// (0xef0100 || delegate) is code and is refused by name. Returns the block the check was made at.
export async function checkOwnerFeeEoa(address, requests) {
  refuse(address === OWNER_FEE_EOA, `${address} is not the owner's pinned fee address`);
  refuse(Array.isArray(requests) && requests.length >= 2, "the owner's fee address must be read from two endpoints (--rpc and --rpc2)");
  const head = await requests[0]("eth_getBlockByNumber", ["latest", false]);
  refuse(head && /^0x[0-9a-f]{64}$/.test(head.hash), "the first endpoint returned no head block");
  for (const [index, request] of requests.entries()) {
    const seen = await request("eth_getBlockByHash", [head.hash, false]);
    refuse(seen?.hash === head.hash && seen.number === head.number, `endpoint ${index + 1} does not know block ${head.hash}`);
    const code = await request("eth_getCode", [address, { blockHash: head.hash, requireCanonical: true }]);
    refuse(typeof code === "string", `endpoint ${index + 1} returned no code reading for Bloch Inc`);
    refuse(!code.toLowerCase().startsWith("0xef0100"), `Bloch Inc ${address} is EIP-7702 delegated (endpoint ${index + 1}): refused`);
    refuse(code === "0x", `Bloch Inc ${address} has code (endpoint ${index + 1}): the owner's fee address must be a plain account`);
  }
  return { block: { number: BigInt(head.number).toString(), hash: head.hash } };
}

/// Read-only checks against the target RPC before forge is started. `second` is the request function of a
/// second endpoint; it is required on the mainnet when Bloch Inc is the owner's plain fee address.
export async function preflight(plan, request, { second = null } = {}) {
  refuse(BigInt(await request("eth_chainId", [])) === BigInt(plan.chain.id), "RPC chain ID does not match the plan");
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  refuse(genesis?.hash === plan.chain.genesisHash, "RPC genesis hash does not match the pinned value");
  const latest = BigInt(await request("eth_getTransactionCount", [plan.deployer, "latest"]));
  const pending = BigInt(await request("eth_getTransactionCount", [plan.deployer, "pending"]));
  refuse(latest === BigInt(plan.startNonce) && pending === latest, `deployer nonce is ${latest}/${pending}, plan needs ${plan.startNonce}`);
  refuse(plan.firstDepositor && !/^0x0{40}$/.test(plan.firstDepositor), "the plan has no first depositor");
  refuse((await request("eth_getCode", [plan.firstDepositor, "latest"])) === "0x", "the first depositor must be an EOA");
  refuse(BigInt(await request("eth_getTransactionCount", [plan.firstDepositor, "latest"])) === 0n, "the first depositor has already sent a transaction; use a fresh key");
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
  let ownerFeeEoa = null;
  for (const [name, { address, codeHash, safe }] of Object.entries(plan.roles)) {
    if (name === "blochInc" && address === OWNER_FEE_EOA && codeHash === EMPTY_CODE_HASH && !safe) {
      // A second endpoint is required on the mainnet; a rehearsal may run with one (stated in the result).
      if (second) {
        refuse(BigInt(await second("eth_chainId", [])) === BigInt(plan.chain.id), "the second RPC's chain ID does not match the plan");
        refuse((await second("eth_getBlockByNumber", ["0x0", false]))?.hash === plan.chain.genesisHash, "the second RPC's genesis hash does not match the pinned value");
      }
      refuse(second || plan.chain.rehearsal === true, "Bloch Inc is the owner's plain fee address: pass --rpc2 (a second endpoint) on the mainnet");
      ownerFeeEoa = await checkOwnerFeeEoa(address, second ? [request, second] : [request, request]);
      ownerFeeEoa.endpoints = second ? 2 : 1;
      continue;
    }
    const observed = codeHashOf(await request("eth_getCode", [address, "latest"]));
    refuse(observed !== EMPTY_CODE_HASH && observed === codeHash, `${name} code hash differs (it must be the reviewed multisig)`);
    if (safe) await verifySafe(safe, address, request, "latest");
  }
  return { nonce: latest.toString(), ...(ownerFeeEoa ? { ownerFeeEoa } : {}) };
}

/// Verify broadcast transactions on chain and order them by nonce.
const selector = (signature) => keccak256(stringToHex(signature)).slice(0, 10);
const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, "0");
const lastAddress = (word) => `0x${word.slice(-40)}`.toLowerCase();

/// A third party can call createPair before the planned step. The result is only
/// acceptable if it is the planned pair: registered by the planned factory at the
/// planned address, with the planned init code hash, code, tokens and caps. Its
/// reserves and shares are returned, because a pair created by someone else may
/// also hold a deposit: `dex-seed-plan.mjs` handles that case.
export async function verifyExistingPair(plan, step, request) {
  const factory = plan.contracts.factory.address;
  const planned = plan.pairs.find((p) => p.address === step.address);
  refuse(planned, `no planned pair at ${step.address}`);
  const call = async (to, signature, args = "") => {
    const result = await request("eth_call", [{ to, data: `${selector(signature)}${args}` }, "latest"]);
    refuse(typeof result === "string" && result.length >= 66, `${signature} failed on ${to}`);
    return result;
  };
  const { token0, token1 } = planned;
  const registered = await call(factory, "getPair(address,address)", addressWord(token0) + addressWord(token1));
  refuse(lastAddress(registered) === step.address, `the factory registers ${lastAddress(registered)}, not the planned pair ${step.address}`);
  const initCode = (await call(factory, "INIT_CODE_PAIR_HASH()")).toLowerCase();
  refuse(initCode === plan.pairInitCodeHash, "the factory's pair init code hash differs from the plan");
  const code = await request("eth_getCode", [step.address, "latest"]);
  refuse(typeof code === "string" && code.length > 2 && keccak256(code) === plan.pairCodeHash, "the pair's runtime code differs from the plan");
  refuse(lastAddress(await call(factory, "firstDepositor()")) === plan.firstDepositor, "the factory's first depositor differs from the plan");
  refuse(lastAddress(await call(step.address, "factory()")) === factory, "the pair belongs to another factory");
  refuse(lastAddress(await call(step.address, "token0()")) === token0, "the pair's token0 differs from the plan");
  refuse(lastAddress(await call(step.address, "token1()")) === token1, "the pair's token1 differs from the plan");
  const capOf = (token) => BigInt(plan.reserveCaps.find((c) => c.token === token)?.cap ?? 0);
  const caps = (await call(step.address, "reserveCaps()")).slice(2);
  refuse(
    BigInt(`0x${caps.slice(0, 64)}`) === capOf(token0) && BigInt(`0x${caps.slice(64, 128)}`) === capOf(token1),
    "the pair's caps differ from the plan",
  );
  const reserves = (await call(step.address, "getReserves()")).slice(2);
  return {
    decision: "existing-pair-identical",
    pair: step.address,
    reserve0: BigInt(`0x${reserves.slice(0, 64)}`).toString(),
    reserve1: BigInt(`0x${reserves.slice(64, 128)}`).toString(),
    totalSupply: BigInt(await call(step.address, "totalSupply()")).toString(),
  };
}

/// `onExisting(hash, state)` is told about each planned createPair that reverted
/// because the identical pair already exists.
export async function verifyBroadcast(plan, hashes, request, onExisting = () => {}) {
  refuse(Array.isArray(hashes) && hashes.length === plan.steps.length, `expected ${plan.steps.length} transactions, found ${hashes?.length}`);
  const seen = [];
  for (const hash of hashes) {
    const tx = await request("eth_getTransactionByHash", [hash]);
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    refuse(tx && receipt && tx.hash === hash && receipt.transactionHash === hash, `transaction ${hash} is unknown`);
    refuse(tx.from?.toLowerCase() === plan.deployer, `transaction ${hash} was not sent by the deployer`);
    const nonce = Number(BigInt(tx.nonce));
    const step = plan.steps.find((s) => s.nonce === nonce);
    refuse(step && !seen.some((s) => s.nonce === nonce), `transaction ${hash} has unplanned nonce ${nonce}`);
    refuse(receipt.status === "0x1" || step.action === "createPair", `transaction ${hash} reverted`);
    if (step.action === "createPair") {
      refuse(tx.to?.toLowerCase() === plan.contracts.factory.address, `createPair ${hash} did not call the factory`);
      if (receipt.status !== "0x1") onExisting(hash, await verifyExistingPair(plan, step, request));
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
  if (options.command === "check-pair") {
    refuse(options.plan && options.rpc, "--plan and --rpc are required");
    const plan = await readJson(options.plan);
    const request = createJsonRpcRequest(options.rpc);
    const states = [];
    for (const step of plan.steps.filter((s) => s.action === "createPair")) states.push(await verifyExistingPair(plan, step, request));
    return { decision: "existing-pair-identical", pairs: states };
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
  refuse(!options.rpc2 || options.rpc2 !== options.rpc, "--rpc2 must be a different endpoint from --rpc");
  const second = options.rpc2 ? createJsonRpcRequest(options.rpc2) : null;
  if (options.command === "preflight") {
    return { decision: "preflight-ok", configSha256: plan.configSha256, ...(await preflight(plan, request, { second })) };
  }
  if (options.command === "run") {
    refuse(!options.broadcast || options.confirm === plan.configSha256, `--broadcast needs --confirm ${plan.configSha256}`);
    const checked = await preflight(plan, request, { second });
    runForge(plan, options);
    return { decision: options.broadcast ? "broadcast" : "dry-run", configSha256: plan.configSha256, ...checked };
  }
  refuse(Boolean(options.broadcastFile) !== Boolean(options.txHashes) && options.write, "one of --broadcast-file or --tx-hashes, and --write, are required");
  // forge's transactions[] can mislabel hashes in a batch; receipts[] are the
  // chain's own, and every one is re-verified against the chain anyway.
  const hashes = options.broadcastFile
    ? ((await readJson(options.broadcastFile)).receipts ?? []).map((r) => r.transactionHash)
    : (await readFile(options.txHashes, "utf8")).split(/\s+/).filter(Boolean);
  const existing = [];
  const ordered = await verifyBroadcast(plan, hashes, request, (hash) => existing.push(hash));
  const gate = gateConfigFromPlan(plan, ordered, GATE_DOMAIN, existing);
  await writeFile(options.write, `${JSON.stringify(gate, null, 2)}\n`, { flag: "wx" });
  return { decision: "recorded", configSha256: plan.configSha256, gate: options.write, createPairFrontRun: existing.length > 0 };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (/unknown command|required|unknown or incomplete/.test(String(error?.message))) console.error(USAGE);
    process.exitCode = 1;
  }
}
