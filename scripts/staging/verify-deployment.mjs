#!/usr/bin/env node
// Post-deployment verification of the Bloch L2 mainnet package: the Bloch Inc
// Safe (bootstrap-key deployment of the official v1.4.1 contracts) and the
// DEX (WBLCH, factory, router, lens, pilot pairs). Read-only; it trusts the
// RPC it is given, so run it against a node you operate.
//
//   node scripts/staging/verify-deployment.mjs --safe-plan S --dex-plan D --rpc URL
//        --infra-plan I [--at latest|finalized] [--out-dir out] [--infra-hashes F]
//        [--safe-hashes F] [--dex-hashes F] [--expect-empty]
//
// Checks: chain ID and genesis; runtime code hash of every contract against
// the plans; the constructor immutables read back from the deployed runtime
// (factory feeTo; router factory and WBLCH; lens factory) and through their
// getters; the factory's pair init-code hash, caps, pair count and registry;
// each pair's tokens and caps; each bridged token's code and bucket capacity;
// the Safe proxy's singleton, fallback handler, guard, modules, owners,
// threshold and VERSION; the proxy factory's proxy creation code; that the
// DEX plan's fee recipient is exactly the planned Safe; Multicall3 and the
// CREATE2 deployer against the canonical code and in a working call; and, with the
// transaction hash files, that every transaction came from the planned key
// with the planned nonce, succeeded and created the planned address.

import { verifyExistingPair } from "./deploy-dex.mjs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createJsonRpcRequest, verifySafe } from "./finality-gate.mjs";
import { BRIDGE_BUCKET_DIVISOR, EMPTY_CODE_HASH, loadArtifacts, stableJson } from "./dex-deploy-config.mjs";
import { verifyInfra } from "./infra-deploy-config.mjs";
import { isMain } from "./is-main.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, parseAbi, encodeFunctionData, decodeFunctionResult } = requireFromFrontend("viem");

const ABI = parseAbi([
  "function feeTo() view returns (address)",
  "function firstDepositor() view returns (address)",
  "function factory() view returns (address)",
  "function WBLCH() view returns (address)",
  "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
  "function reserveCap(address) view returns (uint256)",
  "function allPairsLength() view returns (uint256)",
  "function getPair(address,address) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function reserveCaps() view returns (uint256,uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function bucketCapacity() view returns (uint256)",
  "function proxyCreationCode() view returns (bytes)",
  "function nonce() view returns (uint256)",
]);

export const VERIFY_DOMAIN = "postern.dex.deployment-verification.v1";

function refuse(condition, message) {
  if (!condition) throw new Error(`verify: ${message}`);
}

function codeHashOf(code) {
  refuse(typeof code === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(code), "eth_getCode returned malformed code");
  return code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
}

/// Read the word at each immutable reference of a deployed runtime, in the
/// same (AST id) order the planner links them.
export function readImmutables(runtime, immutableReferences) {
  const hex = runtime.slice(2);
  return Object.keys(immutableReferences)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => {
      const words = immutableReferences[id].map(({ start, length }) => {
        refuse(length === 32 && (start + 32) * 2 <= hex.length, `immutable ${id} is outside the runtime`);
        return `0x${hex.slice(start * 2, (start + 32) * 2)}`;
      });
      refuse(words.every((w) => w === words[0]), `immutable ${id} has inconsistent copies`);
      return words[0];
    });
}

const asWord = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

export async function verifyDeployment({ safePlan, dexPlan, infraPlan, artifacts, request, at = "latest", safeHashes, dexHashes, infraHashes, expectEmpty = false }) {
  const report = { domain: VERIFY_DOMAIN, at, checks: [] };
  const ok = (name, detail) => report.checks.push(detail === undefined ? name : `${name}: ${detail}`);
  let block = at;
  if (at === "finalized" || at === "latest") {
    const header = await request("eth_getBlockByNumber", [at, false]);
    refuse(header && typeof header.hash === "string", `no ${at} block`);
    block = { blockHash: header.hash, requireCanonical: true };
    report.block = { number: BigInt(header.number).toString(), hash: header.hash };
  }
  const call = async (to, functionName, args = []) => {
    const data = encodeFunctionData({ abi: ABI, functionName, args });
    const result = await request("eth_call", [{ to, data }, block]);
    refuse(typeof result === "string" && result !== "0x", `${functionName} on ${to} failed`);
    return decodeFunctionResult({ abi: ABI, functionName, data: result });
  };
  const lower = (v) => String(v).toLowerCase();
  const code = async (address) => request("eth_getCode", [address, block]);
  const expectCode = async (name, { address, codeHash }) => {
    const observed = codeHashOf(await code(address));
    refuse(observed !== EMPTY_CODE_HASH, `${name} ${address} has no code`);
    refuse(observed === codeHash, `${name} ${address} runtime code hash ${observed} differs from the plan ${codeHash}`);
    ok(`${name} code`, `${address} ${codeHash}`);
  };

  const chainId = BigInt(await request("eth_chainId", []));
  const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
  for (const plan of [safePlan, dexPlan, ...(infraPlan ? [infraPlan] : [])]) {
    refuse(chainId === BigInt(plan.chain.id), `RPC chain ID ${chainId} differs from the plan`);
    refuse(genesis?.hash === plan.chain.genesisHash, `RPC genesis ${genesis?.hash} differs from the plan's ${plan.chain.genesisHash}`);
  }
  report.chainId = Number(chainId);
  report.genesisHash = genesis.hash;
  ok("chain", `${chainId} genesis ${genesis.hash}`);

  // Chain utility contracts.
  if (infraPlan) await verifyInfra(infraPlan, request, block, ok);

  // The fee recipient pinned in the DEX plan is exactly the planned Safe.
  refuse(stableJson(dexPlan.roles.blochInc) === stableJson(safePlan.blochInc), "the DEX plan's Bloch Inc pin differs from the Safe plan");
  refuse(dexPlan.feeTo === safePlan.contracts.proxy.address, "the DEX fee recipient is not the planned Safe");
  ok("fee recipient = planned Safe", dexPlan.feeTo);

  // Safe.
  for (const key of ["singleton", "proxyFactory", "fallbackHandler", "proxy"]) await expectCode(`safe ${key}`, safePlan.contracts[key]);
  const creation = await call(safePlan.contracts.proxyFactory.address, "proxyCreationCode");
  refuse(keccak256(creation) === safePlan.proxyCreationCodeHash, "the proxy factory's proxy creation code differs");
  ok("safe proxyCreationCode", safePlan.proxyCreationCodeHash);
  const safe = await verifySafe(safePlan.blochInc.safe, safePlan.contracts.proxy.address, request, block);
  ok("safe singleton/handler/guard/modules/threshold/owners/VERSION", `${safe.threshold} of ${safe.owners.length}`);
  report.safe = { address: safe.address, threshold: safe.threshold, owners: safe.owners, nonce: (await call(safe.address, "nonce")).toString() };

  // DEX contracts and immutables.
  const { contracts } = dexPlan;
  for (const key of ["wrappedNative", "factory", "router", "lens"]) await expectCode(key, contracts[key]);
  const immutables = {
    factory: [dexPlan.feeTo, dexPlan.firstDepositor],
    router: [contracts.factory.address, contracts.wrappedNative.address],
    lens: [contracts.factory.address],
  };
  for (const [key, expected] of Object.entries(immutables)) {
    const words = readImmutables(await code(contracts[key].address), artifacts[key].immutableReferences);
    refuse(stableJson(words) === stableJson(expected.map(asWord)), `${key} immutables ${words.join(",")} differ from ${expected.join(",")}`);
    ok(`${key} immutables`, expected.join(","));
  }
  const factory = contracts.factory.address;
  refuse(lower(await call(factory, "feeTo")) === dexPlan.feeTo, "factory.feeTo() is not Bloch Inc");
  const firstDepositor = lower(await call(factory, "firstDepositor"));
  refuse(!/^0x0{40}$/.test(firstDepositor), "factory.firstDepositor() is zero: the first-deposit rule is off");
  refuse(firstDepositor === dexPlan.firstDepositor, "factory.firstDepositor() differs from the plan");
  ok("firstDepositor", firstDepositor);
  refuse(lower(await call(contracts.router.address, "factory")) === factory, "router.factory() differs");
  refuse(lower(await call(contracts.router.address, "WBLCH")) === contracts.wrappedNative.address, "router.WBLCH() differs");
  refuse(lower(await call(contracts.lens.address, "factory")) === factory, "lens.factory() differs");
  ok("getters feeTo/factory/WBLCH");
  refuse(lower(await call(factory, "INIT_CODE_PAIR_HASH")) === dexPlan.pairInitCodeHash, "INIT_CODE_PAIR_HASH differs");
  ok("INIT_CODE_PAIR_HASH", dexPlan.pairInitCodeHash);
  const caps = new Map();
  for (const { token, cap } of dexPlan.reserveCaps) {
    const observed = await call(factory, "reserveCap", [token]);
    refuse(observed === BigInt(cap), `reserveCap(${token}) = ${observed}, plan ${cap}`);
    caps.set(token, observed);
    ok("reserveCap", `${token} ${cap}`);
  }
  refuse((await call(factory, "allPairsLength")) === BigInt(dexPlan.pairs.length), "allPairsLength differs from the plan");
  for (const pair of dexPlan.pairs) {
    await expectCode("pair", pair);
    refuse(lower(await call(pair.address, "factory")) === factory, `pair ${pair.address} factory differs`);
    refuse(lower(await call(pair.address, "token0")) === pair.token0, `pair ${pair.address} token0 differs`);
    refuse(lower(await call(pair.address, "token1")) === pair.token1, `pair ${pair.address} token1 differs`);
    refuse(lower(await call(factory, "getPair", [pair.token0, pair.token1])) === pair.address, `pair ${pair.address} is not registered`);
    const [cap0, cap1] = await call(pair.address, "reserveCaps");
    refuse(cap0 === (caps.get(pair.token0) ?? 0n) && cap1 === (caps.get(pair.token1) ?? 0n), `pair ${pair.address} caps differ`);
    const [r0, r1] = await call(pair.address, "getReserves");
    const supply = await call(pair.address, "totalSupply");
    if (expectEmpty) refuse(r0 === 0n && r1 === 0n && supply === 0n, `pair ${pair.address} is not empty`);
    ok("pair", `${pair.address} ${pair.token0}/${pair.token1} caps ${cap0}/${cap1} reserves ${r0}/${r1}`);
  }
  for (const { token, symbol, codeHash, bridgeBucketCapacity } of dexPlan.externalTokens) {
    await expectCode(`token ${symbol}`, { address: token, codeHash });
    const bucket = await call(token, "bucketCapacity");
    refuse(bucket === BigInt(bridgeBucketCapacity), `${symbol} bucketCapacity ${bucket} differs from ${bridgeBucketCapacity}`);
    refuse(caps.get(token) * BRIDGE_BUCKET_DIVISOR <= bucket, `${symbol} cap exceeds 1/${BRIDGE_BUCKET_DIVISOR} of its bucket`);
    ok(`token ${symbol} bucket`, `${bucket} >= 10 x ${caps.get(token)}`);
  }

  // Keys: nonces consumed exactly as planned; transactions as planned.
  const keys = [["bootstrap", safePlan, safePlan.bootstrap], ["deployer", dexPlan, dexPlan.deployer]];
  if (infraPlan) keys.push(["infra deployer", infraPlan, infraPlan.deployer]);
  for (const [name, plan, from] of keys) {
    const nonce = BigInt(await request("eth_getTransactionCount", [from, block]));
    refuse(nonce === BigInt(plan.finalNonce), `${name} nonce ${nonce}, plan ends at ${plan.finalNonce}`);
    const balance = BigInt(await request("eth_getBalance", [from, block]));
    report[`${name}Balance`] = balance.toString();
    ok(`${name} nonce`, `${from} ${nonce}`);
  }
  const recorded = [["safe", safePlan, safePlan.bootstrap, safeHashes], ["dex", dexPlan, dexPlan.deployer, dexHashes]];
  if (infraPlan) recorded.push(["infra", infraPlan, infraPlan.deployer, infraHashes]);
  for (const [name, plan, from, hashes] of recorded) {
    if (!hashes) continue;
    refuse(hashes.length === plan.steps.length, `${name}: ${hashes.length} transaction hashes, plan has ${plan.steps.length}`);
    for (const [i, hash] of hashes.entries()) {
      const step = plan.steps[i];
      const tx = await request("eth_getTransactionByHash", [hash]);
      const receipt = await request("eth_getTransactionReceipt", [hash]);
      refuse(tx && receipt, `${name} transaction ${hash} is missing`);
      // A reverted createPair is fine only if the identical pair already exists.
      if (receipt.status !== "0x1") {
        refuse(name === "dex" && step.action === "createPair", `${name} transaction ${hash} reverted`);
        ok("createPair front-run, pair identical", JSON.stringify(await verifyExistingPair(dexPlan, step, request)));
      }
      refuse(lower(tx.from) === from && BigInt(tx.nonce) === BigInt(step.nonce), `${name} transaction ${hash} sender or nonce differs`);
      if (tx.to === null || tx.to === undefined) {
        refuse(keccak256(tx.input) === step.initCodeHash, `${name} ${step.action} init code differs`);
        refuse(lower(receipt.contractAddress) === step.address, `${name} ${step.action} created the wrong address`);
      } else {
        refuse(lower(tx.to) === (step.to ?? dexPlan.contracts.factory.address), `${name} ${step.action} called the wrong contract`);
        if (step.dataHash) refuse(keccak256(tx.input) === step.dataHash, `${name} ${step.action} calldata differs`);
      }
    }
    ok(`${name} transactions`, `${hashes.length} as planned`);
  }
  report.decision = "deployment-verified";
  return report;
}

function parse(argv) {
  const keys = { "--safe-plan": "safePlan", "--dex-plan": "dexPlan", "--infra-plan": "infraPlan", "--rpc": "rpc", "--at": "at", "--out-dir": "outDir",
    "--safe-hashes": "safeHashes", "--dex-hashes": "dexHashes", "--infra-hashes": "infraHashes" };
  const options = { at: "latest", outDir: "out", expectEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect-empty") { options.expectEmpty = true; continue; }
    const key = keys[argv[i]];
    refuse(key && i + 1 < argv.length, `unknown or incomplete argument ${argv[i]}`);
    options[key] = argv[++i];
  }
  refuse(options.safePlan && options.dexPlan && options.infraPlan && options.rpc, "--safe-plan, --dex-plan, --infra-plan and --rpc are required");
  refuse(["latest", "finalized"].includes(options.at), "--at must be latest or finalized");
  return options;
}

export async function readHashes(path) {
  if (!path) return undefined;
  const hashes = (await readFile(path, "utf8")).split(/\s+/).filter(Boolean);
  hashes.forEach((h) => refuse(/^0x[0-9a-f]{64}$/.test(h), `bad transaction hash ${h} in ${path}`));
  return hashes;
}

if (isMain(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    const report = await verifyDeployment({
      safePlan: JSON.parse(await readFile(o.safePlan, "utf8")),
      dexPlan: JSON.parse(await readFile(o.dexPlan, "utf8")),
      infraPlan: JSON.parse(await readFile(o.infraPlan, "utf8")),
      artifacts: await loadArtifacts(o.outDir),
      request: createJsonRpcRequest(o.rpc),
      at: o.at,
      safeHashes: await readHashes(o.safeHashes),
      dexHashes: await readHashes(o.dexHashes),
      infraHashes: await readHashes(o.infraHashes),
      expectEmpty: o.expectEmpty,
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
