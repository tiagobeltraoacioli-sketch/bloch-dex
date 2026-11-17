#!/usr/bin/env node
// Fork rehearsal of the multichain package for one chain (docs/MULTICHAIN-DEPLOY.md, "Fork rehearsals").
//
//   node scripts/multichain/rehearse-fork.mjs <chain> --port PORT --out DIR [--fork-url URL] [--hold FILE]
//
// --hold FILE: the page rehearsal's mode (rehearse-page.mjs). The LP does not leave, DIR/ready is written when
// everything above held, and the fork stays up, with its liquidity, while FILE exists.
//
// It starts `anvil --fork-url <the chain's first reviewed endpoint>` on loopback, runs the owner's command exactly as
// documented (scripts/multichain/deploy.sh <chain> broadcast, with a throwaway key and the reference plan), passes
// the post gate at the fork's finalized block, and then plays the whole flow with throwaway accounts and the chain's
// real wrapped native token and listed token:
//   - review R328-1, on a snapshot of the fork that is reverted afterwards: the depositing account calls a hostile
//     contract (test/mocks/OriginOpener.sol), which opens the planned pool at the attacker's price inside that
//     transaction (the pair accepts the transaction origin). Every tool must then refuse: prepare says STOP, the
//     post gate fails without and with that transaction as the opening, verify fails, add prints nothing, and no
//     frontend record can be written;
//   - reviews R328-2 and R328-3, on a second snapshot: one base unit at the pair's address does not block prepare;
//     1% of a side does, with the skim command; the same donation made AFTER prepare joins the opening pool as a
//     gift, and verify and the gate prove the opening and state the gift and the price it moved;
//   - review R309-MC-1: someone else creates the pair, sends dust and tries the first mint, directly and through
//     the router (every form must fail);
//   - the owner's first deposit exactly as scripts/multichain/first-deposit.mjs prints it (the reference plan's
//     first depositor is an address nobody holds a key for; it is impersonated on the fork), verify, the post gate
//     again with the opening proven, swaps both ways with the native coin and with the wrapped token, protocol fee
//     accrual to the owner's fee address, redemption of that fee by the fee address (impersonated), a
//     permissionless skim, a later deposit as `first-deposit.mjs add` prints it (and its refusal at a price that
//     is not the pool's), and the removal of the liquidity.
// In hold mode nobody interferes: the first deposit creates the pair itself, in one transaction.
// Every step records its gas and amounts in DIR/evidence.json. Nothing leaves loopback except the fork's read
// requests to the public endpoint. Exit status 0 only when every check held.
//
// This shows that the unchanged bytecode deploys and works against the chain's real state and real tokens under
// anvil's EVM. It does not show the chain client's own differences (Arbitrum's block.number and blockhash, L1 data
// fees, Linea's prover limits): scripts/multichain/simulate-chain.mjs reads those from the real nodes.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REFERENCE_FIRST_DEPOSITOR, ROOT, loadArtifacts, loadChain, loadShared, lower, planChain, refuse } from "./lib.mjs";

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
// Seen 2026-11-16: both reviewed BNB Smart Chain endpoints drop a block's state within a minute or two (the chain
// makes more than two blocks a second), so its rehearsal forks from another public endpoint that keeps it; that
// endpoint is a fork source only and is not in the page's endpoint list. Ethereum's first endpoint answered anvil's
// block 0 request from a history-pruned backend; its second is used.
const FORK_SOURCE = { "bnb-smart-chain": "https://bsc-mainnet.public.blastapi.io", ethereum: chain.rpc[1] };
const forkUrl = opt["fork-url"] ?? FORK_SOURCE[key] ?? chain.rpc[0];
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
  "function mint(address) returns (uint256)",
  "function createPair(address,address) returns (address)",
  "function claim()",
  "function getPair(address,address) view returns (address)",
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
  what: "anvil fork on loopback; throwaway keys; reference plan (first deposits by the reference depositing account only, an address nobody holds a key for; no reserve caps; no pair created at deployment); the depositing account and the fee address are impersonated",
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

// The port must be free: a node left there by an earlier run would be rehearsed instead of a new fork.
if (await rpc("eth_chainId").then(() => true, () => false)) {
  console.error(`something already answers on ${url}; stop it first`);
  process.exit(2);
}
// The fork source is a shared, rate-limited public endpoint (anvil reads one EIP-2935 slot from it for every block
// it mines): a refused request is asked again, up to 20 times, starting 1.5 s apart, instead of ending the run.
const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--host", "127.0.0.1", "--silent", "--retries", "20", "--fork-retry-backoff", "1500", "--timeout", "60000"], { stdio: ["ignore", "ignore", "inherit"] });
// The fork never outlives this process.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => (anvil.kill("SIGTERM"), process.exit(143)));
process.on("exit", () => anvil.kill("SIGTERM"));
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
  // Under the Prague rules every block first stores its parent's hash in the EIP-2935 history contract, in slot
  // (number - 1) mod 8191. On a fork anvil must read that slot's old value from the public endpoint before it
  // writes it: one remote request per mined block, in the middle of whatever is being timed, and the place where
  // a rate limit ended earlier runs. The slots of the blocks this rehearsal can mine are therefore written
  // locally first (to zero; each is overwritten when its block is mined, and nothing here reads them before).
  // The contract's code and behaviour are untouched; the DEX does not use it.
  {
    const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
    const count = opt.hold ? 6000 : 1500;
    const slots = Array.from({ length: count }, (_, i) => (BigInt(forkBlock.number) + BigInt(i)) % 8191n);
    for (let i = 0; i < slots.length; i += 100)
      await Promise.all(slots.slice(i, i + 100).map((slot) => rpc("anvil_setStorageAt", [HISTORY, `0x${slot.toString(16).padStart(64, "0")}`, `0x${"0".repeat(64)}`])));
    evidence.localHistorySlots = count;
  }
  evidence.forkBlock = { number: Number(BigInt(forkBlock.number)), hash: forkBlock.hash, timestamp: Number(BigInt(forkBlock.timestamp)), baseFeePerGas: forkBlock.baseFeePerGas ? BigInt(forkBlock.baseFeePerGas) : null };

  const account = () => privateKeyToAccount(generatePrivateKey());
  const deployerKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const [lp, trader, stranger, attacker] = [account(), account(), account(), account()];
  for (const a of [deployer, lp, trader, stranger, attacker]) await rpc("anvil_setBalance", [a.address, hex(1000n * 10n ** 18n)]);

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
  /** A transaction that must be mined and revert with `reason` (the gas limit is stated: an estimate would fail). */
  async function sendExpectingRevert(from, { to, data = "0x", value = 0n }, label, reason) {
    const raw = await from.signTransaction({ type: "legacy", chainId: chain.chain.chainId, nonce: Number(BigInt(await rpc("eth_getTransactionCount", [from.address, "pending"]))), to, data, value, gas: 3_000_000n, gasPrice: (await gasPrice()) * 2n + 1n });
    const hash = await rpc("eth_sendRawTransaction", [raw]);
    let receipt = null;
    for (let i = 0; i < 100 && !receipt; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) await delay(100);
    }
    refuse(receipt, `no receipt for ${label}`);
    const why = await rpc("eth_call", [{ from: from.address, to, data, value: hex(value) }, hex(BigInt(receipt.blockNumber) - 1n)]).then(() => "the replayed call succeeds", (error) => error.message);
    evidence.steps.push({ step: label, hash, status: receipt.status, gasUsed: BigInt(receipt.gasUsed), revert: why, expectedRevert: reason });
    save();
    return receipt.status === "0x0" && why.includes(reason) ? true : `status ${receipt.status}, ${why}`;
  }

  // ---- 1. the owner's command, as documented ----
  const run = spawnSync("bash", ["scripts/multichain/deploy.sh", key, "broadcast", "--rehearsal-rpc", url, "--reference", "--", "--private-key", deployerKey], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
  writeFileSync(join(opt.out, "deploy.log"), `${run.stdout}\n${run.stderr}`.replaceAll(deployerKey, "<throwaway key>"));
  check("scripts/multichain/deploy.sh broadcast exits 0 on the fork", run.status === 0, run.status === 0 ? undefined : `${run.stdout}\n${run.stderr}`.slice(-600));
  if (run.status !== 0) throw new Error("the deployment failed");
  const broadcast = JSON.parse(readFileSync(join(ROOT, "broadcast/DeployMultichain.s.sol", String(chain.chain.chainId), "run-latest.json"), "utf8"));
  const names = ["factory (CREATE2)", "router (CREATE2)", "lens (CREATE2)"];
  for (const [i, receipt] of broadcast.receipts.entries()) {
    const tx = broadcast.transactions[i]?.transaction ?? {};
    evidence.deployment.push({ step: names[i] ?? `transaction ${i}`, hash: receipt.transactionHash, to: receipt.to, gasUsed: BigInt(receipt.gasUsed), status: receipt.status, calldataBytes: tx.input ? (tx.input.length - 2) / 2 : null, input: tx.input ?? null });
  }
  check("the deployment is three transactions (no pair is created), all successful, sent by the throwaway key", evidence.deployment.length === 3 && evidence.deployment.every((d) => d.status === "0x1") && broadcast.receipts.every((r) => lower(r.from) === lower(deployer.address)), evidence.deployment.map((d) => d.status));
  evidence.deploymentGas = evidence.deployment.reduce((n, d) => n + d.gasUsed, 0n);
  for (const d of evidence.deployment) delete d.input;

  // ---- 2. the post gate at the fork's finalized block ----
  // anvil's `finalized` block is 64 blocks behind its head: FINALIZE blocks put everything before them under it.
  // (Each mined block costs one read of the public fork source; no more are mined than needed.)
  const FINALIZE = 70;
  await rpc("anvil_mine", [hex(FINALIZE)]);
  const runGate = (file, log, extra = []) => {
    const gate = spawnSync("node", ["scripts/multichain/gate.mjs", key, "post", "--reference", "--rpc", url, "--rehearsal", "--out", join(opt.out, file), ...extra], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(join(opt.out, log), `${gate.stdout}\n${gate.stderr}`);
    const written = existsSync(join(opt.out, file)) ? JSON.parse(readFileSync(join(opt.out, file), "utf8")) : null;
    return { ok: gate.status === 0, status: gate.status, text: `${gate.stdout}\n${gate.stderr}`, detail: gate.status === 0 ? undefined : gate.stdout.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 600), report: gate.status === 0 ? written : null, written };
  };
  const deployedGate = runGate("gate-report-deployed.json", "gate-deployed.log");
  check("the post gate passes at the fork's finalized block, with the planned pair not created", deployedGate.ok && deployedGate.report.pairs.every((p) => p.state === "absent"), deployedGate.detail ?? deployedGate.report?.pairs.map((p) => p.state));

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
  await rpc("anvil_impersonateAccount", [shared.feeTo.address]);
  const state = async () => {
    const [r0, r1] = await read(pair, "getReserves");
    const wrappedIs0 = lower(plan.pairs[0].token0) === lower(wrapped.address);
    return { reserveNative: wrappedIs0 ? r0 : r1, reserveToken: wrappedIs0 ? r1 : r0, totalSupply: await read(pair, "totalSupply"), feeToLp: await read(pair, "balanceOf", [shared.feeTo.address]) };
  };

  // 3a. the opening of the pool (reviews R309-MC-1, R328-1, R328-2, R328-3)
  const depositor = plan.arguments.firstDepositor;
  refuse(lower(depositor) === lower(REFERENCE_FIRST_DEPOSITOR) && lower(depositor) !== lower(shared.feeTo.address), "the reference plan's first depositor is the reference address, not the fee address");
  await rpc("anvil_impersonateAccount", [depositor]);
  evidence.depositor = depositor;
  evidence.depositorNativeBefore = await nativeOf(depositor);
  await rpc("anvil_setBalance", [depositor, hex(1000n * 10n ** 18n)]);
  await fund(depositor, SEED_TOKEN);
  await fund(attacker.address, 10_000n * unit);
  const pairName = `${wrapped.symbol}/${token.symbol}`;
  /** scripts/multichain/first-deposit.mjs, as the owner runs it; `name` names the files it leaves in DIR. */
  const tool = (mode, name, { native = "10", amount = "30000", extra = [] } = {}) => {
    const out = join(opt.out, `${name}.json`);
    const run = spawnSync("node", ["scripts/multichain/first-deposit.mjs", key, mode, "--pair", pairName, "--native", native, "--token", amount, "--reference", "--rpc", url, "--rehearsal", "--out", out, ...extra], { cwd: ROOT, encoding: "utf8" });
    const text = `${run.stdout}\n${run.stderr}`;
    writeFileSync(join(opt.out, `${name}.log`), text);
    return { status: run.status, text, result: run.status !== 2 && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
  };
  const deployedReport = join(opt.out, "gate-report-deployed.json");
  const gateReport = ["--gate-report", deployedReport, "--to", lp.address];
  const depositorAccount = { address: depositor, sign: false };
  const dustNative = 10n ** 12n;
  if (!opt.hold) {
    // ---- review R328-1, on a snapshot: a contract the depositing account calls opens the pool in its name.
    let snapshot = await rpc("evm_snapshot");
    {
      const artifact = JSON.parse(readFileSync(join(ROOT, "out/OriginOpener.sol/OriginOpener.json"), "utf8"));
      const init = `${artifact.bytecode.object}${encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [factory, wrapped.address, token.address]).slice(2)}`;
      const deployed = await send(attacker, { data: init }, "R328-1: the attacker deploys a contract that looks harmless (test/mocks/OriginOpener.sol)");
      const hostile = (await rpc("eth_getTransactionReceipt", [deployed.hash])).contractAddress;
      // 1 native = 2 token: 0.000001 native against 0.000002 token (at least two base units).
      const falseToken = (2n * unit) / 1_000_000n > 1n ? (2n * unit) / 1_000_000n : 2n;
      await send(attacker, { to: hostile, value: dustNative }, "R328-1: the attacker gives it dust of the native coin");
      await send(attacker, { to: token.address, data: call("transfer", [hostile, falseToken]) }, `R328-1: and dust of ${token.symbol} (1 ${chain.nativeCurrency.symbol} = 2 ${token.symbol})`);
      check("R328-1: the attacker's own call of that contract cannot open the pool (BDEX: FIRST_DEPOSITOR)", await sendExpectingRevert(attacker, { to: hostile, data: call("claim", []) }, "R328-1: the attacker calls the contract itself", "FIRST_DEPOSITOR"));
      const claim = await send(depositorAccount, { to: hostile, data: call("claim", []) }, "R328-1: the depositing account calls that contract once; inside the call the pair is created and opened");
      const opened = await state();
      check("R328-1: the pair accepted the first mint by transaction origin: the pool is open at the attacker's price", opened.totalSupply > 0n && opened.reserveNative === dustNative && opened.reserveToken === falseToken, opened);
      const stop = tool("prepare", "r328-1-prepare", { extra: gateReport });
      check("R328-1: first-deposit.mjs prepare says STOP on the pool it did not open, and prints nothing to send", stop.status === 1 && /STOP\. This pool is already open/.test(stop.text) && !/cast send .*addLiquidityBLCH/.test(stop.text), stop.text.slice(-400));
      await rpc("anvil_mine", [hex(FINALIZE)]);
      const noProof = runGate("r328-1-gate-no-opening.json", "r328-1-gate-no-opening.log");
      check("R328-1: the post gate FAILS on the open pool without its opening transaction", noProof.status === 1 && noProof.written?.pairs[0]?.state === "open" && noProof.written.pairs[0].opening?.proven === false && /STOP: someone else opened it/.test(noProof.text), noProof.text.slice(-400));
      const wrongProof = runGate("r328-1-gate-hostile-opening.json", "r328-1-gate-hostile-opening.log", ["--opening", `${pairName}=${claim.hash}`]);
      check("R328-1: the post gate FAILS with the hostile transaction named as the opening (it was not sent to the router)", wrongProof.status === 1 && wrongProof.written?.pairs[0]?.opening?.proven === false && /opened through another contract/.test(JSON.stringify(wrongProof.written.pairs[0].opening.problems)), wrongProof.text.slice(-400));
      const noVerify = tool("verify", "r328-1-verify", { extra: ["--tx", claim.hash] });
      check("R328-1: first-deposit.mjs verify FAILS on the hostile transaction", noVerify.status === 1 && /The opening is NOT proven/.test(noVerify.text), noVerify.text.slice(-400));
      // `add`, the tool the first edition pointed the owner to: with the report of the failed gate, and with an
      // older passed report, it prints no transaction.
      const addFailedGate = tool("add", "r328-1-add-failed-gate", { extra: ["--gate-report", join(opt.out, "r328-1-gate-hostile-opening.json")] });
      const addOldGate = tool("add", "r328-1-add-older-gate", { extra: ["--gate-report", deployedReport] });
      check("R328-1: first-deposit.mjs add prints nothing for that pool (at its price 10 native would be paired with a 1,500th of the owner's tokens)", addFailedGate.status === 1 && addOldGate.status === 1 && ![addFailedGate, addOldGate].some((r) => /cast send/.test(r.text) || r.result?.transactions?.length) && /pool's price is not the price of the amounts given/.test(addOldGate.text), addOldGate.text.slice(-500));
      const noRecord = spawnSync("node", ["scripts/multichain/frontend-files.mjs", key, "--gate-report", join(opt.out, "r328-1-gate-hostile-opening.json"), "--out", join(opt.out, "r328-1-files"), "--rpc", url, "--rehearsal"], { cwd: ROOT, encoding: "utf8" });
      check("R328-1: no frontend record can be written from that gate report", noRecord.status === 2 && /not a passed post gate/.test(noRecord.stderr) && !existsSync(join(opt.out, "r328-1-files", key, "frontend.record.json")), `${noRecord.status} ${noRecord.stderr}`.slice(0, 300));
    }
    refuse((await rpc("evm_revert", [snapshot])) === true, "the fork could not be reverted to its snapshot");
    check("the fork is back before the hostile opening: no pair", /^0x0{40}$/.test(await read(factory, "getPair", [wrapped.address, token.address])));

    // ---- reviews R328-2 and R328-3, on a second snapshot: tokens sent to the pair's address.
    snapshot = await rpc("evm_snapshot");
    {
      await send(attacker, { to: factory, data: call("createPair", [wrapped.address, token.address]) }, "R328-3: someone creates the pair");
      await send(attacker, { to: token.address, data: call("transfer", [pair, 1n]) }, `R328-3: and sends one base unit of ${token.symbol} to it`);
      const oneUnit = tool("prepare", "r328-3-prepare-one-unit", { extra: gateReport });
      check("R328-3: one base unit at the pair's address does not block prepare; it is reported as a gift to the pool", oneUnit.status === 0 && oneUnit.result?.transactions.length === 2 && oneUnit.result.gift?.token === "1" && oneUnit.result.pair.state === "donated", oneUnit.text.slice(-400));
      // 1% of one side: refused, with the command that takes it out.
      const onePercent = SEED_TOKEN / 100n;
      await send(attacker, { to: token.address, data: call("transfer", [pair, onePercent - 1n]) }, `R328-2: someone sends 1% of the ${token.symbol} side to the pair`);
      const tooMuch = tool("prepare", "r328-2-prepare-one-percent", { extra: gateReport });
      check("R328-2: prepare refuses a donation above 0.1% of a side and prints the skim command", tooMuch.status === 1 && /Take them out first/.test(tooMuch.text) && /skim\(address\)/.test(tooMuch.text), tooMuch.text.slice(-500));
      // The same donation in front of the deposit (after prepare read the chain): the deposit printed while only
      // one unit sat there is sent now. Minimums equal to the amounts do not see the donation.
      let frontRun;
      for (const t of oneUnit.result.transactions) frontRun = await send(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, `R328-2: the first depositor's ${t.step}, mined after the donation`);
      const after = await state();
      check("R328-2: the deposit goes in; the pool opens with the deposit plus the donation, all of it owned by the depositor's shares", after.reserveNative === SEED_NATIVE && after.reserveToken === SEED_TOKEN + onePercent && (await read(pair, "balanceOf", [lp.address])) === after.totalSupply - 1000n, after);
      const gifted = tool("verify", "r328-2-verify", { extra: ["--tx", frontRun.hash] });
      check("R328-2: verify PROVES the opening and states the gift and the price it moved (1%), without telling the owner to withdraw", gifted.status === 0 && gifted.result?.opening?.proven === true && gifted.result.opening.gift.token === onePercent.toString() && gifted.result.opening.priceShiftBps === 100 && /do NOT withdraw/.test(gifted.text), gifted.text.slice(-600));
      await rpc("anvil_mine", [hex(FINALIZE)]);
      const giftGate = runGate("r328-2-gate.json", "r328-2-gate.log", ["--opening", `${pairName}=${frontRun.hash}`]);
      check("R328-2: the post gate passes with the opening proven and reports the gift", giftGate.ok && giftGate.report.pairs[0].opening.proven === true && giftGate.report.pairs[0].opening.gift.token === onePercent.toString() && giftGate.report.pairs[0].opening.priceShiftBps === 100, giftGate.detail);
    }
    refuse((await rpc("evm_revert", [snapshot])) === true, "the fork could not be reverted to its snapshot");

    // ---- review R309-MC-1. Anyone may create the pair; nobody but the first depositor can open it.
    const dustToken = unit / 1000n > 0n ? unit / 1000n : 1n;
    await send(attacker, { to: factory, data: call("createPair", [wrapped.address, token.address]) }, "attacker creates the pair (createPair is permissionless)");
    check("the attacker's createPair made the pair at the planned address", lower(await read(factory, "getPair", [wrapped.address, token.address])) === lower(pair));
    await send(attacker, { to: wrapped.address, data: call("deposit", []), value: dustNative }, "attacker wraps dust");
    await send(attacker, { to: wrapped.address, data: call("transfer", [pair, dustNative]) }, `attacker sends dust ${wrapped.symbol} to the pair`);
    await send(attacker, { to: token.address, data: call("transfer", [pair, dustToken]) }, `attacker sends dust ${token.symbol} to the pair (a false price)`);
    check("R309-MC-1: the attacker's first mint reverts with BDEX: FIRST_DEPOSITOR", await sendExpectingRevert(attacker, { to: pair, data: call("mint", [attacker.address]) }, "attacker calls mint on the empty pair", "FIRST_DEPOSITOR"));
    await send(attacker, { to: token.address, data: call("approve", [router, 2n ** 256n - 1n]) }, `attacker approves ${token.symbol} to the router`);
    check("R309-MC-1: the attacker's first deposit through the router reverts with BDEX: FIRST_DEPOSITOR", await sendExpectingRevert(attacker, { to: router, data: call("addLiquidityBLCH", [token.address, dustToken, 0n, 0n, attacker.address, deadline]), value: dustNative }, "attacker calls addLiquidityBLCH with dust and no minimums", "FIRST_DEPOSITOR"));
    check("the pair has no shares after the attack", (await read(pair, "totalSupply")) === 0n);
    const dusted = tool("prepare", "first-deposit-dust", { extra: gateReport });
    check("first-deposit.mjs prepare reports the attacker's dust at the pair as a gift below 0.1% and still prints the deposit", dusted.status === 0 && dusted.result?.pair.state === "donated" && dusted.result.gift?.native === dustNative.toString() && dusted.result.gift.token === dustToken.toString(), dusted.text.slice(-300));
    // The rehearsal takes the dust out, so that the figures below are those of the deposit alone.
    await send(lp, { to: pair, data: call("skim", [lp.address]) }, "the dust is skimmed out (anyone may)");
  }
  const prepared = tool("prepare", "first-deposit-prepare", { extra: gateReport });
  check(`first-deposit.mjs prepare passes and prints the two transactions (the pair is ${opt.hold ? "not created yet" : "empty"})`, prepared.status === 0 && prepared.result?.transactions.length === 2 && prepared.result.pair.state === (opt.hold ? "absent" : "empty"), prepared.text.slice(-400));
  if (prepared.status !== 0) throw new Error("first-deposit.mjs prepare failed");
  let opening;
  for (const t of prepared.result.transactions) opening = await send(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, t.step === "approve" ? `first depositor approves exactly 30,000 ${token.symbol} to the router` : `first deposit: 10 ${chain.nativeCurrency.symbol} + 30,000 ${token.symbol}, minimums equal to the amounts${opt.hold ? "; the same transaction creates the pair" : ""} (addLiquidityBLCH)`);
  let s = await state();
  check("the first deposit set the reserves to exactly the intended amounts and locked the minimum liquidity", s.reserveNative === SEED_NATIVE && s.reserveToken === SEED_TOKEN && s.totalSupply > 1000n && s.feeToLp === 0n, s);
  if (!opt.hold) {
    // The second half of the reviewer's attack: 600 token no longer buys the native side (0.2 native at this price).
    // It also moves the reserves before verify runs: verify reads the opening from its transaction, not from them.
    const before = await nativeOf(attacker.address);
    const swap = await send(attacker, { to: router, data: call("swapExactTokensForBLCH", [600n * unit, 0n, [token.address, wrapped.address], attacker.address, deadline]) }, `attacker swaps 600 ${token.symbol} for the native coin`);
    const taken = (await nativeOf(attacker.address)) - before + swap.feeWei;
    evidence.attack = { tokenIn: `600 ${token.symbol}`, nativeOut: formatUnits(taken, 18), reviewerResultWithOpenFirstDeposits: "more than 9.6 of 10" };
    check("R309-MC-1: the attacker's 600 token buy less than 0.2 native (the reviewer's attack took more than 9.6 of 10)", taken < 2n * 10n ** 17n && taken > 19n * 10n ** 16n, formatUnits(taken, 18));
  }
  const verified = tool("verify", "first-deposit-verify", { extra: ["--tx", opening.hash] });
  check(`first-deposit.mjs verify proves the opening from its transaction${opt.hold ? "" : " (after a swap has already moved the reserves)"}: sent by the first depositor to the router, strict minimums, exactly the deposited amounts joined`, verified.status === 0 && verified.result?.opening?.proven === true && verified.result.opening.joined.native === SEED_NATIVE.toString() && verified.result.opening.joined.token === SEED_TOKEN.toString() && verified.result.opening.priceShiftBps === 0, verified.text.slice(-400));
  await rpc("anvil_mine", [hex(FINALIZE)]);
  if (!opt.hold) {
    const unproven = runGate("gate-report-no-opening.json", "gate-no-opening.log");
    check("the post gate does not pass an open pool without its opening transaction, even the owner's", unproven.status === 1 && unproven.written?.pairs[0]?.opening?.proven === false, unproven.text.slice(-300));
  }
  const openGate = runGate("gate-report.json", "gate.log", ["--opening", `${pairName}=${opening.hash}`]);
  check("the post gate passes again and reports the pair open, with its opening proven", openGate.ok && openGate.report.pairs.every((p) => p.state === "open" && p.opening?.proven === true && p.opening.transaction === opening.hash), openGate.detail ?? openGate.report?.pairs.map((p) => p.state));
  if (!opt.hold) {
    const again = runGate("gate-report.json", "gate-again.log");
    check("a later run of the post gate takes the opening transaction from the report it replaces and proves it again", again.ok && again.report.pairs[0].opening?.transaction === opening.hash && again.report.pairs[0].opening.proven === true, again.detail);
  }
  await rpc("anvil_setBalance", [depositor, hex(evidence.depositorNativeBefore)]);

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
  check("the anchored swap variant works under anvil's BLOCKHASH (see simulate-chain.mjs for the real nodes)", anchored === true, anchored);

  // 3d. protocol fee: accrues as LP shares of the fee address at the next liquidity event
  const before = await state();
  check("swaps alone mint nothing to the fee address (the fee is settled lazily)", before.feeToLp === 0n, before.feeToLp);
  // A deposit into the OPEN pool by an account that is not the first depositor: the restriction is on the first
  // deposit only.
  await send(lp, { to: token.address, data: call("approve", [router, 2n ** 256n - 1n]) }, `LP approves ${token.symbol} to the router`);
  await send(lp, { to: router, data: call("addLiquidityBLCH", [token.address, 3_000n * unit, 0n, 0n, lp.address, deadline]), value: 10n ** 18n }, "another account adds liquidity to the open pool (a liquidity event settles the protocol fee)");
  s = await state();
  const feeShareNative = (s.feeToLp * s.reserveNative) / s.totalSupply;
  const feeShareToken = (s.feeToLp * s.reserveToken) / s.totalSupply;
  evidence.protocolFee = { feeTo: shared.feeTo.address, lpShares: s.feeToLp, worthNative: feeShareNative, worthToken: feeShareToken, native: `${formatUnits(feeShareNative, 18)} ${chain.nativeCurrency.symbol}`, token: `${formatUnits(feeShareToken, token.decimals)} ${token.symbol}` };
  check("the owner's fee address holds LP shares minted by the protocol fee", s.feeToLp > 0n, evidence.protocolFee);

  // 3e. the fee address redeems its shares itself: approve the router, removeLiquidityBLCH (impersonated on the fork)
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

  if (opt.hold) {
    // The page rehearsal trades against this pool: the LP stays, and the fork stays up while the hold file exists.
    evidence.held = true;
    const bad = evidence.checks.filter((c) => !c.ok).length;
    evidence.result = bad === 0 ? "PASS" : "FAIL";
    save();
    writeFileSync(join(opt.out, "ready"), `${evidence.result}\n`);
    console.log(`fork rehearsal ${key}: ${evidence.result}, holding the fork on ${url} while ${opt.hold} exists`);
    while (existsSync(opt.hold)) await delay(1000);
    throw Object.assign(new Error("hold ended"), { held: true });
  }
  // 3g. a later deposit by the owner, as `first-deposit.mjs add` prints it (the pool's price moved with the swaps)
  await rpc("anvil_setBalance", [depositor, hex(100n * 10n ** 18n)]);
  await fund(depositor, 10_000n * unit);
  s = await state();
  const fair = (10n ** 18n * s.reserveToken) / s.reserveNative;
  const reportArgs = ["--gate-report", join(opt.out, "gate-report.json"), "--to", lp.address];
  // The owner's amounts 5% away from the pool's price: nothing is printed.
  const away = tool("add", "first-deposit-add-refused", { native: "1", amount: formatUnits((fair * 105n) / 100n, token.decimals), extra: reportArgs });
  check("first-deposit.mjs add refuses when the pool's price is 5% away from the owner's amounts", away.status === 1 && /pool's price is not the price of the amounts given/.test(away.text) && !away.result?.transactions?.length, away.text.slice(-400));
  const added = tool("add", "first-deposit-add", { native: "1", amount: formatUnits(fair, token.decimals), extra: reportArgs });
  check("first-deposit.mjs add prints a later deposit at the owner's amounts when they are the pool's price", added.status === 0 && added.result?.transactions.length === 2, added.text.slice(-400));
  if (added.status !== 0) throw new Error("first-deposit.mjs add failed");
  const sharesBefore = await read(pair, "balanceOf", [lp.address]);
  for (const t of added.result.transactions) await send(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, t.step === "approve" ? `later deposit: approval of ${formatUnits(fair, token.decimals)} ${token.symbol}` : `later deposit: 1 ${chain.nativeCurrency.symbol} + ${formatUnits(fair, token.decimals)} ${token.symbol}, minimums 0.5% below (addLiquidityBLCH)`);
  const grown = await state();
  // The router takes the token amount and the native coin that matches it at the pool's price: 1 native less the
  // rounding of one token base unit (it returns the rest).
  const [nativeIn, tokenIn] = [grown.reserveNative - s.reserveNative, grown.reserveToken - s.reserveToken];
  check("the later deposit added the token amount at the pool's price and the native coin that matches it (1, less the rounding of a token unit), and minted shares", tokenIn === fair && nativeIn <= 10n ** 18n && 10n ** 18n - nativeIn <= 10n ** 12n && (await read(pair, "balanceOf", [lp.address])) > sharesBefore, { before: s, after: grown, fair });
  await rpc("anvil_setBalance", [depositor, hex(evidence.depositorNativeBefore)]);

  // 3h. the LP leaves
  const lpShares = await read(pair, "balanceOf", [lp.address]);
  await send(lp, { to: pair, data: call("approve", [router, lpShares]) }, "LP approves its LP shares to the router");
  await send(lp, { to: router, data: call("removeLiquidityBLCH", [token.address, lpShares, 0n, 0n, lp.address, deadline]) }, "LP removes all its liquidity (removeLiquidityBLCH)");
  s = await state();
  check("after the LP left only the locked minimum liquidity and the fee settled on that exit remain", (await read(pair, "balanceOf", [lp.address])) === 0n && s.totalSupply >= 1000n && s.totalSupply < 10n ** 12n + s.feeToLp + 1000n, s);
  evidence.afterExit = s;
  void factory;
} catch (error) {
  if (!error.held) {
    failed = true;
    evidence.error = String(error.stack ?? error).slice(0, 1500);
    console.error(error);
    if (opt.hold) writeFileSync(join(opt.out, "ready"), "FAIL\n");
  }
} finally {
  anvil.kill("SIGTERM");
}
const bad = evidence.checks.filter((c) => !c.ok).length;
evidence.result = !failed && bad === 0 ? "PASS" : "FAIL";
save();
console.log(`fork rehearsal ${key}: ${evidence.result}; deployment gas ${evidence.deploymentGas ?? "?"}; ${evidence.checks.length} checks, ${bad} failed; ${join(opt.out, "evidence.json")}`);
process.exit(evidence.result === "PASS" ? 0 : 1);
