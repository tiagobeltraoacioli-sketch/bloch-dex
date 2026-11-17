#!/usr/bin/env node
// Review r17 (agent 328): the SAME three attacks as r328-fork-attack.mjs, against agent 326's fixes
// (codex/dex-multichain-r17-20261117 at 663129b or later: opening.mjs, gate --opening, add --token). This file is
// kept on the review branch and is run from a checkout of that tip. Expectations here are those of the FIX:
// every attack must be stopped by the tools. Throwaway keys, the reference plan (its first depositor is an
// address without a key, impersonated on the fork); nothing leaves loopback but the fork's reads.
//
//   node scripts/review/r328-fork-attack-tip.mjs <chain> --port PORT --out DIR --pid-file FILE [--fork-url URL]
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
if (!key || !opt.port || !opt.out || !opt["pid-file"] || !opt["hostile-artifact"]) {
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
  "function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)",
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

const evidence = { schema: "review.r328.fork-attack-tip.v1", chain: plan.chain, forkOf: forkUrl, checks: [], outputs: {} };
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
  const gate = (name, extra = []) => {
    const file = join(opt.out, `${name}.json`);
    const r = tool("scripts/multichain/gate.mjs", [key, "post", "--reference", "--rpc", url, "--rehearsal", "--out", file, ...extra], name);
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
  const fails = (text) => text.split("\n").filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 500);
  refuse(lower(depositor) !== lower(shared.feeTo.address), "at this tip the reference depositor is not the fee address");

  // ---- A (R328-3): one base unit must no longer block prepare; a gift above 0.1% still must ----
  await must(attacker, { to: token.address, data: call("transfer", [pair, 1n]) }, "attacker sends one base unit to the pair's address");
  const a1 = firstDeposit("prepare", "A1-prepare", ["--gate-report", deployed.file]);
  check("A: one base unit at the pair's address: prepare PASSES and says what sits there", a1.status === 0 && /sit at the pair's address/.test(a1.text), a1.text.split("\n").filter((l) => l.startsWith("note")).join(" ").slice(0, 300));
  await must(attacker, { to: token.address, data: call("transfer", [pair, 31n * unit]) }, "attacker sends 31 token units (more than 0.1%)");
  const a2 = firstDeposit("prepare", "A2-prepare", ["--gate-report", deployed.file]);
  check("A: more than 0.1% of a side at the pair's address: prepare FAILS with the skim command", a2.status === 1 && /skim\(address\)/.test(a2.text), fails(a2.text));
  await must(helper, { to: factory, data: call("createPair", [wrapped.address, token.address]) }, "createPair");
  await must(helper, { to: pair, data: call("skim", [helper.address]) }, "skim");

  // ---- B (R328-2): a donation between prepare and the deposit ----
  const b1 = firstDeposit("prepare", "B1-prepare", ["--gate-report", deployed.file]);
  check("B: prepare passes and prints the two transactions", b1.status === 0 && b1.result?.transactions.length === 2);
  await must(attacker, { to: token.address, data: call("transfer", [pair, 31n * unit]) }, "attacker sends 31 token units in front of the deposit");
  let deposit;
  for (const t of b1.result.transactions) deposit = await send(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, `printed ${t.step}`);
  let r = await reserves();
  check("B: the printed deposit succeeds with the gift in the pool (10 / 30,031)", deposit.ok && r.native === 10n * 10n ** 18n && r.token === 30_031n * unit);
  const b2 = firstDeposit("verify", "B2-verify", ["--tx", deposit.hash]);
  check("B: verify PROVES the opening, reports the gift and the price it moved, and says do NOT withdraw", b2.status === 0 && /gift/.test(b2.text) && /do NOT withdraw/.test(b2.text), b2.text.split("\n").filter((l) => /note|That is|opening price/.test(l)).join(" ").slice(0, 500));
  await rpc("anvil_mine", [hex(70)]);
  const noHash = gate("B3-gate-no-opening");
  check("B: the post gate WITHOUT --opening fails on the open pool (not proven)", noHash.status === 1, fails(noHash.text).slice(0, 300));
  const proven = gate("B4-gate-opening", ["--opening", `${pairName}=${deposit.hash}`]);
  check("B: the post gate with the opening transaction passes and records the opening as proven", proven.status === 0 && proven.report.pairs.every((p) => p.state === "open" && p.opening?.proven === true), fails(proven.text));
  const recordB = tool("scripts/multichain/frontend-files.mjs", [key, "--gate-report", proven.file, "--out", join(opt.out, "page-B"), "--rpc", url, "--rehearsal"], "B5-frontend-files");
  check("B: frontend-files.mjs writes the record from the proven report", recordB.status === 0);
  const recordNo = tool("scripts/multichain/frontend-files.mjs", [key, "--gate-report", noHash.file, "--out", join(opt.out, "page-B-no"), "--rpc", url, "--rehearsal"], "B6-frontend-files-unproven");
  check("B: frontend-files.mjs refuses the unproven report", recordNo.status !== 0, recordNo.text.trim().split("\n").slice(-1)[0].slice(0, 200));
  // a later deposit into the proven pool: at the owner's price it passes; at another price it is refused
  const b7 = firstDeposit("add", "B7-add-market", ["--gate-report", proven.file], ["--native", "1", "--token", "3003.1"]);
  check("B: add at the pool's price (1 native = 3,003.1) passes", b7.status === 0, fails(b7.text));
  const b8 = firstDeposit("add", "B8-add-off", ["--gate-report", proven.file], ["--native", "1", "--token", "2900"]);
  check("B: add with amounts 3.4% away from the pool's price is refused", b8.status === 1, fails(b8.text).slice(0, 300));
  // a later, ordinary deposit of the depositor is not accepted as "the opening"
  let later;
  if (b7.status === 0) for (const t of b7.result.transactions) later = await must(depositorAccount, { to: t.to, data: t.data, value: BigInt(t.value) }, `printed add ${t.step}`);
  await rpc("anvil_mine", [hex(70)]);
  if (later) {
    const wrongHash = gate("B9-gate-wrong-opening", ["--opening", `${pairName}=${later.hash}`]);
    check("B: a later deposit's hash given as the opening is refused (not the first mint)", wrongHash.status === 1, fails(wrongHash.text).slice(0, 300));
  }

  // ---- C (R328-1): the depositing account's origin ----
  refuse(await rpc("evm_revert", [snapshot]), "revert to the snapshot");
  const snapshotC = await rpc("evm_snapshot");
  const artifact = JSON.parse(readFileSync(opt["hostile-artifact"], "utf8"));
  const deployHostile = async (tokenDust) => {
    const creation = `${artifact.bytecode.object}${encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [factory, wrapped.address, token.address, tokenDust]).slice(2)}`;
    const hostile = (await must(attacker, { to: null, data: creation }, "attacker deploys the hostile contract")).contractAddress;
    await must(attacker, { to: hostile, value: 10n ** 12n }, "attacker funds it with 1e12 wei");
    await must(attacker, { to: token.address, data: call("transfer", [hostile, tokenDust]) }, "attacker funds it with the token dust");
    return hostile;
  };
  for (const [label, tokenDust, priceWord] of [["C", (2n * unit) / 10n ** 6n, "1 native = 2"], ["D", (3000n * unit) / 10n ** 6n, "1 native = 3,000 (the market price: the price check of add cannot see it)"]]) {
    if (label === "D") refuse(await rpc("evm_revert", [snapshotC]), "revert to the snapshot");
    const hostile = await deployHostile(tokenDust);
    const claim = await send(depositorAccount, { to: hostile, data: call("claim", []) }, "the depositing account calls the hostile contract once");
    check(`${label}: the frozen pair still lets a contract called by the depositing account open the pool (${priceWord})`, claim.ok && (await read(pair, "totalSupply")) > 0n);
    const c1 = firstDeposit("prepare", `${label}1-prepare`, ["--gate-report", deployed.file]);
    check(`${label}: prepare says STOP and does not point at add`, c1.status === 1 && /STOP/.test(c1.text) && !/use `add` for a pool that is already open/.test(c1.text), fails(c1.text).slice(0, 300));
    await rpc("anvil_mine", [hex(70)]);
    const g1 = gate(`${label}2-gate-no-opening`);
    check(`${label}: the post gate fails on the hostile pool without an opening`, g1.status === 1, fails(g1.text).slice(0, 200));
    const g2 = gate(`${label}3-gate-hostile-opening`, ["--opening", `${pairName}=${claim.hash}`]);
    check(`${label}: the post gate fails with the hostile transaction given as the opening`, g2.status === 1 && g2.report?.pairs.every((p) => p.opening?.proven !== true), (g2.report?.pairs[0]?.opening?.problems ?? []).join("; ").slice(0, 300));
    const rec = tool("scripts/multichain/frontend-files.mjs", [key, "--gate-report", g2.file, "--out", join(opt.out, `page-${label}`), "--rpc", url, "--rehearsal"], `${label}4-frontend-files`);
    check(`${label}: frontend-files.mjs writes no record for the hostile pool`, rec.status !== 0 && !existsSync(join(opt.out, `page-${label}`, key, "frontend.record.json")));
    const add1 = firstDeposit("add", `${label}5-add-failed-report`, ["--gate-report", g2.file], ["--native", "10", "--token", "30000"]);
    check(`${label}: add refuses with the failed gate report`, add1.status === 1, fails(add1.text).slice(0, 300));
    const add2 = firstDeposit("add", `${label}6-add-old-report`, ["--gate-report", deployed.file], ["--native", "10", "--token", "30000"]);
    check(`${label}: add refuses with the earlier passed report (pair absent there, nothing proven)`, add2.status === 1, fails(add2.text).slice(0, 300));
    const v = firstDeposit("verify", `${label}7-verify-hostile`, ["--tx", claim.hash]);
    check(`${label}: verify of the hostile transaction fails`, v.status === 1, fails(v.text).slice(0, 300));
    // The strict deposit itself still reverts on the hostile pool (unchanged protection).
    await must(depositorAccount, { to: token.address, data: call("approve", [router, 30_000n * unit]) }, "depositor approves");
    const strict = await send(depositorAccount, { to: router, data: call("addLiquidityBLCH", [token.address, 30_000n * unit, 30_000n * unit, 10n * 10n ** 18n, depositor, deadline]), value: 10n * 10n ** 18n }, "a strict first deposit into the hostile pool");
    if (label === "C") check("C: a strict first deposit into the hostile pool reverts", !strict.ok);
    else {
      // First run of this script expected a revert here too. Wrong: at EXACTLY the owner's price the router's quote
      // equals the desired amounts, so minimums equal to the amounts are met and the deposit goes in as a second
      // deposit, at the owner's own price (no loss). What matters is that it is then not accepted as the opening.
      check("D: at exactly the owner's price a strict deposit into the hostile pool is ACCEPTED (a second deposit at the owner's price)", strict.ok);
      const v2 = firstDeposit("verify", "D8-verify-second-deposit", ["--tx", strict.hash]);
      check("D: verify of that deposit fails: it is not the pair's first mint", v2.status === 1, fails(v2.text).slice(0, 300));
      await rpc("anvil_mine", [hex(70)]);
      const g3 = gate("D9-gate-second-deposit", ["--opening", `${pairName}=${strict.hash}`]);
      check("D: the post gate does not accept that deposit as the opening", g3.status === 1 && g3.report?.pairs.every((p) => p.opening?.proven !== true), (g3.report?.pairs[0]?.opening?.problems ?? []).join("; ").slice(0, 200));
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  save();
}
const bad = evidence.checks.filter((c) => !c.ok).length;
console.log(`r328 fork attack (tip) ${key}: ${failed || bad ? "NOT ALL STOPPED" : "ALL ATTACKS STOPPED BY THE TOOLS"}; ${evidence.checks.length} checks, ${bad} not as expected`);
process.exit(failed || bad ? 1 : 0);
