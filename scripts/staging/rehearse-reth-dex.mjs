#!/usr/bin/env node
// Real DEX bytecode on an isolated Bloch Reth developer process. This is
// synthetic issuance and local canonical execution, with no L1 or finality.
// Starts its own loopback-only process; no endpoint or private key is accepted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRpcTransport } from "./rpc-transport.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(ROOT, "frontend/package.json"));
const { encodeDeployData, encodeFunctionData, decodeFunctionResult, keccak256, toHex, zeroAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const account = privateKeyToAccount("0x" + "07".repeat(32)); // Public test fixture, never a funded real account.
const CHAIN_ID = 700771;
const DOMAIN = "0x" + "d3".repeat(32);
// The Pair creation code hash every deployment document pins (docs/AUDIT-PACKAGE-DEX.md section 1).
const PAIR_INIT_CODE_HASH = "0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683";
// A protocol fee recipient that is not the sender, so fee shares are told apart from the sender's (review R309-I1).
const FEE_TO = "0x00000000000000000000000000000000000fee70";
const MAX_FEE = 2_000_000_000n;
const TIP = 100_000_000n;
const args = process.argv.slice(2);
assert.equal(args.length, 4, "usage: rehearse-reth-dex.mjs --binary /path/bloch-evm-dev --out /new/evidence-directory");
assert.equal(args[0], "--binary");
assert.equal(args[2], "--out");
const binary = resolve(args[1]);
const out = resolve(args[3]);
mkdirSync(out, { mode: 0o700 }); // An existing directory is never reused or erased.
const database = join(out, "synthetic-db");
const evidence = {
  schema: "postern.dex.reth-rehearsal.v1", synthetic: true, l1Verified: false, finalized: false,
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  artifacts: {}, transactions: [], assertions: [],
};
let child;
let output = "";
let rpc;

function artifact(source, name) {
  const a = JSON.parse(readFileSync(join(ROOT, "out", `${source}.sol`, `${name}.json`), "utf8"));
  const metadata = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
  assert.ok(metadata.compiler.version.startsWith("0.8.24+"), "compile with the repository's pinned solc");
  assert.equal(metadata.settings.evmVersion, "paris");
  assert.deepEqual(metadata.settings.optimizer, { enabled: true, runs: 200 });
  for (const [path, sourceInfo] of Object.entries(metadata.sources)) {
    assert.equal(keccak256(toHex(readFileSync(join(ROOT, path)))), sourceInfo.keccak256,
      `artifact source changed: ${path}; rebuild with forge`);
  }
  assert.match(a.bytecode.object, /^0x[0-9a-f]+$/i);
  evidence.artifacts[name] = { creationKeccak256: keccak256(a.bytecode.object), compiler: metadata.compiler.version };
  return a;
}

async function start(init) {
  const argv = ["--synthetic-dev", "--data-dir", database, "--port", "0", "--block-interval-ms", "300"];
  if (init) argv.push("--init", "--fund", account.address);
  child = spawn(binary, argv, { stdio: ["ignore", "pipe", "pipe"] });
  const process = child;
  const endpoint = await new Promise((resolve, reject) => {
    let current = "";
    const timer = setTimeout(() => reject(new Error("synthetic RPC startup timed out")), 30_000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    process.on("error", (error) => finish(error));
    process.on("exit", (code) => finish(new Error(`synthetic RPC exited during startup: ${code}`)));
    const read = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 8 * 1024 * 1024) output = output.slice(-8 * 1024 * 1024);
      current = (current + text).slice(-16384);
      const match = /SYNTHETIC DEV ONLY: HTTP=(http:\/\/127\.0\.0\.1:\d+)/.exec(current);
      if (match) finish(null, match[1]);
    };
    process.stdout.on("data", read);
    process.stderr.on("data", read);
  });
  rpc = createRpcTransport(endpoint, { timeoutMs: 10_000 });
  const identity = await rpc("bloch_chainIdentity", []);
  assert.equal(identity.format, "bloch-chain-identity-v1");
  assert.equal(identity.headerFormat, "bloch-node-header-v2-fixed-width");
  assert.equal(BigInt(identity.chainId), BigInt(CHAIN_ID));
  assert.equal(identity.domain, DOMAIN);
  assert.equal(BigInt(await rpc("eth_chainId", [])), BigInt(CHAIN_ID));
  if (evidence.identity) assert.deepEqual(identity, evidence.identity);
  else evidence.identity = identity;
}

async function stop() {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, "synthetic RPC exited unexpectedly");
    return;
  }
  const process = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill("SIGKILL"); reject(new Error("synthetic RPC shutdown timed out")); }, 20_000);
    process.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`synthetic RPC shutdown exit: ${code}`));
    });
    process.kill("SIGINT");
  });
}

async function receipt(hash) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      assert.equal(r.transactionHash, hash);
      assert.equal(r.from.toLowerCase(), account.address.toLowerCase());
      assert.equal((await rpc("eth_getBlockByNumber", [r.blockNumber, false])).hash, r.blockHash);
      assert.ok(BigInt(r.gasUsed) > 0n);
      assert.ok(BigInt(r.effectiveGasPrice) >= TIP);
      return r;
    }
    await delay(100);
  }
  throw new Error(`no receipt for ${hash}; no transaction was resent`);
}

async function send(label, { to, data, value = 0n, gas = 5_000_000n }, expectedStatus = "0x1") {
  const head = await rpc("eth_getBlockByNumber", ["latest", false]);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [account.address, { blockHash: head.hash, requireCanonical: true }]));
  assert.ok(nonce <= BigInt(Number.MAX_SAFE_INTEGER));
  const raw = await account.signTransaction({ type: "eip1559", chainId: CHAIN_ID, nonce: Number(nonce),
    ...(to ? { to } : {}), data, value, gas, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP });
  const hash = keccak256(raw);
  const record = { label, hash, nonce: nonce.toString(), state: "before-send" };
  evidence.transactions.push(record);
  writeFileSync(join(out, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  assert.equal(await rpc("eth_sendRawTransaction", [raw]), hash);
  const r = await receipt(hash);
  Object.assign(record, { state: "included", receipt: r });
  assert.equal(r.status, expectedStatus, `${label} receipt status`);
  console.log(`${label}: ${hash}, gas ${BigInt(r.gasUsed)}`);
  return r;
}

const encode = (a, functionName, args = []) => encodeFunctionData({ abi: a.abi, functionName, args });
async function read(address, a, functionName, args = []) {
  const data = await rpc("eth_call", [{ to: address, data: encode(a, functionName, args) }, "latest"]);
  return decodeFunctionResult({ abi: a.abi, functionName, data });
}
async function deploy(name, a, args = []) {
  return (await send(`deploy ${name}`, { data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }), gas: 8_000_000n })).contractAddress;
}
async function invoke(label, address, a, functionName, args = [], value = 0n, status = "0x1") {
  return send(label, { to: address, data: encode(a, functionName, args), value }, status);
}

try {
  const tokenA = artifact("TestBase", "TestToken");
  const wrappedA = artifact("WBLCH", "WBLCH");
  const factoryA = artifact("UniswapV2Factory", "UniswapV2Factory");
  const routerA = artifact("BDexRouter", "BDexRouter");
  const pairA = artifact("UniswapV2Pair", "UniswapV2Pair");
  // The rehearsal runs the build the mainnet package pins, not merely some build.
  assert.equal(keccak256(pairA.bytecode.object), PAIR_INIT_CODE_HASH, "the compiled Pair is not the pinned build");
  await start(true);
  const token = await deploy("TestToken", tokenA);
  const wrapped = await deploy("WBLCH", wrappedA);
  // Protocol fee ON, as on mainnet (the recipient there is the Bloch Inc Safe).
  const factory = await deploy("Factory", factoryA, [FEE_TO, account.address, [wrapped, token], [10n ** 17n, 1000n * 10n ** 18n]]);
  const router = await deploy("Router", routerA, [factory, wrapped]);
  assert.equal((await read(factory, factoryA, "feeTo")).toLowerCase(), FEE_TO);
  assert.equal(await read(factory, factoryA, "INIT_CODE_PAIR_HASH"), PAIR_INIT_CODE_HASH, "the factory derives pairs from another Pair build");
  await invoke("mint synthetic test token", token, tokenA, "mint", [account.address, 1000n * 10n ** 18n]);
  await invoke("approve router", token, tokenA, "approve", [router, 1000n * 10n ** 18n]);
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const deadline = BigInt(latest.timestamp) + 10_000n;
  await invoke("add liquidity with native wrapping", router, routerA, "addLiquidityBLCH",
    [token, 100n * 10n ** 18n, 100n * 10n ** 18n, 10n ** 16n, account.address, deadline], 10n ** 16n);
  const pair = (await read(factory, factoryA, "getPair", [token, wrapped])).toLowerCase();
  assert.notEqual(pair, zeroAddress);
  const initial = await read(pair, pairA, "getReserves");
  const product = initial[0] * initial[1];
  const balanceBefore = await read(token, tokenA, "balanceOf", [account.address]);
  const anchor = await rpc("eth_getBlockByNumber", ["latest", false]);
  await invoke("anchored native-to-token swap", router, routerA, "swapExactBLCHForTokensAnchored",
    [1n, [wrapped, token], account.address, deadline, BigInt(anchor.number), anchor.hash], 10n ** 15n);
  assert.ok(await read(token, tokenA, "balanceOf", [account.address]) > balanceBefore);
  const afterSwap = await read(pair, pairA, "getReserves");
  assert.ok(afterSwap[0] * afterSwap[1] >= product, "swap preserves the constant-product lower bound");
  await invoke("wrong anchor reverts", router, routerA, "swapExactBLCHForTokensAnchored",
    [1n, [wrapped, token], account.address, deadline, BigInt(anchor.number), "0x" + "ee".repeat(32)], 10n ** 15n, "0x0");
  const afterRevert = await read(pair, pairA, "getReserves");
  assert.deepEqual(afterRevert, afterSwap, "reverted swap leaves reserves unchanged");
  // Reserve cap: the wrapped side is capped at 0.1; a swap that would lift its reserve above the cap reverts.
  await invoke("swap above the wrapped reserve cap reverts", router, routerA, "swapExactBLCHForTokensAnchored",
    [1n, [wrapped, token], account.address, deadline, BigInt(anchor.number), anchor.hash], 2n * 10n ** 17n, "0x0");
  assert.deepEqual(await read(pair, pairA, "getReserves"), afterSwap, "a swap refused by the cap leaves reserves unchanged");
  assert.equal(await read(pair, pairA, "balanceOf", [FEE_TO]), 0n, "no fee share exists before a liquidity event");
  const donated = 10n ** 18n;
  const recipientBeforeDonation = await read(token, tokenA, "balanceOf", [account.address]);
  const pairBeforeDonation = await read(token, tokenA, "balanceOf", [pair]);
  await invoke("donate synthetic token", token, tokenA, "transfer", [pair, donated]);
  assert.equal(await read(token, tokenA, "balanceOf", [pair]), pairBeforeDonation + donated,
    "the donation reaches the pair as token excess");
  assert.equal(await read(token, tokenA, "balanceOf", [account.address]), recipientBeforeDonation - donated);
  await invoke("skim excess", pair, pairA, "skim", [account.address]);
  assert.equal(await read(token, tokenA, "balanceOf", [pair]), pairBeforeDonation,
    "skim removes exactly the donated excess from the pair");
  assert.equal(await read(token, tokenA, "balanceOf", [account.address]), recipientBeforeDonation,
    "skim returns exactly the donated excess to the recipient");
  assert.deepEqual(await read(pair, pairA, "getReserves"), afterSwap);
  const liquidity = await read(pair, pairA, "balanceOf", [account.address]);
  await invoke("approve LP removal", pair, pairA, "approve", [router, liquidity / 2n]);
  const nativeBefore = BigInt(await rpc("eth_getBalance", [account.address, "latest"]));
  const supplyBefore = await read(wrapped, wrappedA, "totalSupply");
  const tokensBefore = await read(token, tokenA, "balanceOf", [account.address]);
  const removal = await invoke("remove liquidity and unwrap", router, routerA, "removeLiquidityBLCH",
    [token, liquidity / 2n, 1n, 1n, account.address, deadline]);
  const returnedNative = BigInt(await rpc("eth_getBalance", [account.address, "latest"])) - nativeBefore +
    BigInt(removal.gasUsed) * BigInt(removal.effectiveGasPrice);
  assert.ok(returnedNative > 0n);
  assert.equal(supplyBefore - await read(wrapped, wrappedA, "totalSupply"), returnedNative,
    "burned wrapped supply reaches the recipient as native currency after gas");
  assert.ok(await read(token, tokenA, "balanceOf", [account.address]) > tokensBefore);
  assert.equal(await read(pair, pairA, "balanceOf", [account.address]), liquidity - liquidity / 2n);
  // Revenue path: the swap's fee grew k, and this liquidity event minted the protocol's share to feeTo.
  const feeShares = await read(pair, pairA, "balanceOf", [FEE_TO]);
  assert.ok(feeShares > 0n, "the protocol fee share was minted to feeTo on the liquidity event after a swap");
  const supplyAfter = await read(pair, pairA, "totalSupply");
  assert.ok(feeShares * 1000n < supplyAfter, "the fee share is a small fraction of the supply");
  evidence.protocolFee = { feeTo: FEE_TO, shares: feeShares.toString(), totalSupply: supplyAfter.toString() };
  const remaining = await read(pair, pairA, "getReserves");
  assert.ok(remaining[0] > 0n && remaining[1] > 0n);
  assert.ok(remaining[0] < afterSwap[0] && remaining[1] < afterSwap[1]);
  const codeHashes = {};
  for (const address of [token, wrapped, factory, router, pair]) codeHashes[address] = keccak256(await rpc("eth_getCode", [address, "latest"]));
  evidence.contracts = { token, wrapped, factory, router, pair, codeHashes };
  evidence.assertions.push("deployments", "approve", "native-wrapping", "anchored-swap", "wrong-anchor-reverts",
    "constant-product", "skim", "skim-exact-excess-returned", "liquidity-removal", "native-unwrapping",
    "pinned-pair-init-code-hash", "reserve-cap-refusal", "protocol-fee-shares-minted-to-feeTo");
  await stop();
  await start(false);
  assert.deepEqual(await read(pair, pairA, "getReserves"), remaining, "reopen preserves reserves");
  for (const [address, hash] of Object.entries(codeHashes)) assert.equal(keccak256(await rpc("eth_getCode", [address, "latest"])), hash);
  for (const tx of evidence.transactions) assert.deepEqual(await receipt(tx.hash), tx.receipt, "reopen preserves canonical receipt");
  evidence.assertions.push("database-reopen-preserves-code-state-and-receipts");
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try { await stop(); }
  catch (error) { evidence.passed = false; evidence.shutdownFailure = String(error); process.exitCode = 1; }
  writeFileSync(join(out, "server.log"), output, { mode: 0o600 });
  writeFileSync(join(out, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, transactions: evidence.transactions.length, assertions: evidence.assertions, out }));
  if (evidence.failure) console.error(evidence.failure);
}
