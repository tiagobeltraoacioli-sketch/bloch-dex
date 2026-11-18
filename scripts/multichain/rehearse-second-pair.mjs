#!/usr/bin/env node
// Fork rehearsal of a chain's SECOND pool, opened after its first (round 20; docs/MULTICHAIN-DEPLOY.md section 8,
// "A second pool on a chain", and section 11).
//
//   node scripts/multichain/rehearse-second-pair.mjs <chain> --port PORT --out DIR [--fork-url URL]
//
// It starts `anvil --fork-url <endpoint>` on loopback and uses the tools EXACTLY AS THE OWNER DOES: every pool is
// opened by running `first-deposit.mjs prepare`, sending the `cast send` lines it prints as they are (with
// `--unlocked --rpc-url <the fork>` in place of the owner's signer option; the depositing account is impersonated,
// no key of the owner's is used or needed), then `verify`, the post gate with `--opening`, and `frontend-files.mjs`.
// On a chain where the owner has deployed, the fork holds the owner's own factory, router and lens and they are
// used as they are; elsewhere the documented `deploy.sh` deploys them first.
// What it shows, with the chain's REAL tokens and the chain's real price references:
//   1. the first pool (USDC) opens, the gate proves it, and the page's record lists it ALONE, with the second
//      planned pair named as not open (pairs open one at a time);
//   2. the second pool (USDT) opens through the same commands with `--pair <WRAPPED>/<SECOND>`, priced by its own
//      two references; the gate then proves both openings (the first from the report it replaces) and the record
//      lists both;
//   3. a token whose approve needs zero first (Tether on Ethereum): with an allowance left by an earlier prepare,
//      the plain approve that the old recovery text told the owner to send REVERTS, and the tool prints
//      approve 0, approve, deposit; with the allowance already exact it prints the deposit alone;
//   4. a token with transfer-fee parameters, pause and blacklist (Tether on Ethereum), switched by its real owner
//      (impersonated): `prepare`, `add`, the gate and verify-chain all refuse while a fee is on, the token is
//      paused, or the pair is blacklisted, and pass again when it is off;
//   5. trades through both pools as the page routes them (native to token, token to native, token to token through
//      the wrapped token), and a later deposit as `first-deposit.mjs add` prints it;
//   6. the token's real behaviour, call by call, next to the same calls on the local stand-in the forge tests use
//      (test/mocks/TetherLegacyToken.sol), deployed on the same fork: the two lists must be equal.
// Every step is written to DIR/evidence.json. Nothing leaves loopback except the fork's read requests to the public
// endpoint and the tools' read-only identity checks. Exit status 0 only when every check held.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, chainSymbolOf, loadArtifacts, loadChain, loadShared, lower, openingPriceFor, planChain, readJson, refuse } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, formatUnits, parseUnits } = requireFromFrontend("viem");
const { privateKeyToAccount, generatePrivateKey } = requireFromFrontend("viem/accounts");

const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!key || !opt.port || !opt.out) {
  console.error("usage: rehearse-second-pair.mjs <chain> --port PORT --out DIR [--fork-url URL]");
  process.exit(2);
}
const shared = loadShared();
const chain = loadChain(key);
refuse(chain.initialPairs.length >= 2, `${key} plans one pair: there is no second pool to rehearse`);
const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
const port = Number(opt.port);
const url = `http://127.0.0.1:${port}`;
// The fork sources of rehearse-fork.mjs, for its reasons (BNB Smart Chain's reviewed endpoints drop a block's state
// within minutes; Ethereum's first endpoint answers block 0 from a history-pruned backend).
const FORK_SOURCE = { "bnb-smart-chain": "https://bsc-mainnet.public.blastapi.io", ethereum: chain.rpc[1] };
const forkUrl = opt["fork-url"] ?? FORK_SOURCE[key] ?? chain.rpc[0];
mkdirSync(opt.out, { recursive: true });

const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
  "function transfer(address,uint256)",
  "function transferFrom(address,address,uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function setParams(uint256,uint256)",
  "function pause()",
  "function unpause()",
  "function addBlackList(address)",
  "function removeBlackList(address)",
  "function destroyBlackFunds(address)",
  "function deprecate(address)",
  "function issue(uint256)",
  "function mint(address,uint256)",
  "function swapExactBLCHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])",
  "function swapExactTokensForBLCH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpcError: body.error });
  return body.result;
}
const data = (functionName, args = []) => encodeFunctionData({ abi: ABI, functionName, args });
const read = async (to, functionName, args = []) => decodeFunctionResult({ abi: ABI, functionName, data: await rpc("eth_call", [{ to, data: data(functionName, args) }, "latest"]) });
const text = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

const evidence = {
  schema: "postern.dex.multichain-second-pair-rehearsal.v1",
  chain: plan.chain,
  forkOf: forkUrl,
  what: "anvil fork on loopback; the tools as the owner runs them; the printed `cast send` lines sent as they are with --unlocked (the depositing account, the token's owner and the token holders are impersonated on the fork: no key is used); the chain's real tokens and real price references",
  anvil: spawnSync("anvil", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
  pairs: plan.pairs.map((p) => ({ name: `${p.tokenA}/${p.tokenB}`, address: p.address })),
  steps: [],
  checks: [],
};
const save = () => writeFileSync(join(opt.out, "evidence.json"), `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
const check = (name, ok, detail) => {
  evidence.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${text(detail).slice(0, 700)})`}`);
  save();
  return Boolean(ok);
};

if (await rpc("eth_chainId").then(() => true, () => false)) {
  console.error(`something already answers on ${url}; stop it first`);
  process.exit(2);
}
const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--host", "127.0.0.1", "--silent", "--retries", "20", "--fork-retry-backoff", "1500", "--timeout", "60000"], { stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(join(opt.out, "anvil.pid"), `${anvil.pid}\n`);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => (anvil.kill("SIGTERM"), process.exit(143)));
process.on("exit", () => anvil.kill("SIGTERM"));

/** Run a tool of the kit as the owner does, against the fork. Returns { status, out, lines }. */
function tool(log, script, args) {
  const run = spawnSync("node", [`scripts/multichain/${script}`, ...args], { cwd: ROOT, encoding: "utf8" });
  const out = `${run.stdout}\n${run.stderr}`;
  writeFileSync(join(opt.out, `${log}.log`), `$ node scripts/multichain/${script} ${args.join(" ")}\n${out}`);
  return { status: run.status, out, lines: run.stdout.split("\n") };
}
const REHEARSAL = ["--rpc", url, "--rehearsal"];
const failedChecks = (run) => run.lines.filter((l) => l.startsWith("FAIL")).join(" | ").slice(0, 900);
const castLines = (run) => run.lines.filter((l) => l.startsWith("cast send "));
/** Send one printed line as it is, adding only what stands for the owner's signer option and --rpc-url. */
function sendPrinted(line, label, { expectFailure = false } = {}) {
  const run = spawnSync("bash", ["-c", `${line} --unlocked --rpc-url ${url} --json`], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
  let receipt = null;
  try {
    receipt = JSON.parse(run.stdout);
  } catch {
    receipt = null;
  }
  const entry = { step: label, line, exit: run.status, hash: receipt?.transactionHash ?? null, status: receipt?.status ?? null, gasUsed: receipt?.gasUsed ? BigInt(receipt.gasUsed) : null, ...(run.status === 0 ? {} : { error: `${run.stderr}`.trim().split("\n").slice(-2).join(" ").slice(0, 300) }) };
  evidence.steps.push(entry);
  save();
  refuse(expectFailure || (run.status === 0 && receipt?.status === "0x1"), `${label} failed: ${entry.error ?? text(receipt)}`);
  return entry;
}
// One gas price for the whole run, three times the fork's first suggestion. (Asking the node before every
// transaction and paying a multiple of its answer feeds on itself: anvil's suggestion follows what recent
// transactions paid, and the price doubled with each of this script's hundred or so transactions.)
let fixedGasPrice = null;
const gasPrice = async () => (fixedGasPrice ??= BigInt(await rpc("eth_gasPrice")) * 3n);
/** A transaction of an impersonated account (a holder, a trader, the token's owner). Returns { ok, gasUsed, hash }. */
async function sendAs(from, { to, data: input = "0x", value = 0n }, label, { mayRevert = false } = {}) {
  let hash;
  try {
    hash = await rpc("eth_sendTransaction", [{ from, to, data: input, value: hex(value), gas: hex(900_000n), gasPrice: hex(await gasPrice()) }]);
  } catch (error) {
    const why = `${error.message.slice(0, 200)} (gas price ${await gasPrice()}, balance of the sender ${BigInt(await rpc("eth_getBalance", [from, "latest"]))})`;
    refuse(mayRevert, `${label}: ${why}`);
    evidence.steps.push({ step: label, sent: false, error: why });
    return { ok: false };
  }
  let receipt = null;
  for (let i = 0; i < 100 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) await delay(100);
  }
  refuse(receipt, `no receipt for ${label}`);
  const ok = receipt.status === "0x1";
  evidence.steps.push({ step: label, hash, status: receipt.status, gasUsed: BigInt(receipt.gasUsed) });
  save();
  refuse(ok || mayRevert, `${label} reverted`);
  return { ok, gasUsed: BigInt(receipt.gasUsed), hash };
}
const impersonate = async (address) => {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, hex(1000n * 10n ** 18n)]);
};
// anvil's `finalized` block is 64 blocks behind its head.
const finalize = () => rpc("anvil_mine", [hex(70)]);

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
  evidence.forkBlock = { number: Number(BigInt(forkBlock.number)), hash: forkBlock.hash, timestamp: Number(BigInt(forkBlock.timestamp)) };
  {
    // As rehearse-fork.mjs: the EIP-2935 history slots of the blocks this rehearsal mines are written locally
    // first, so that mining does not read the public fork source once per block.
    const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
    const slots = Array.from({ length: 2500 }, (_, i) => (BigInt(forkBlock.number) + BigInt(i)) % 8191n);
    for (let i = 0; i < slots.length; i += 100)
      await Promise.all(slots.slice(i, i + 100).map((slot) => rpc("anvil_setStorageAt", [HISTORY, `0x${slot.toString(16).padStart(64, "0")}`, `0x${"0".repeat(64)}`])));
  }
  const depositor = plan.arguments.firstDepositor;
  const { factory, router } = plan.contracts;
  const wrapped = chain.wrappedNative;
  const coin = chain.nativeCurrency.symbol;
  const report = join(opt.out, "gate-report.json");
  const account = () => privateKeyToAccount(generatePrivateKey()).address;
  const [trader, spender, recipient] = [account(), account(), account()];
  for (const a of [depositor, trader, spender, recipient]) await impersonate(a);

  // ---- 0. the deployment: the owner's, where the chain has it; else the documented command ----
  const codeHash = async (address) => keccak256(await rpc("eth_getCode", [address, "latest"]));
  const present = [];
  for (const c of Object.values(plan.contracts)) if ((await rpc("eth_getCode", [c.address, "latest"])) !== "0x") present.push(c);
  evidence.deployment = present.length === 3 ? "the owner's deployment, already on the chain: used as it is" : "deployed by scripts/multichain/deploy.sh on the fork";
  if (present.length === 3) {
    const same = [];
    for (const c of present) same.push((await codeHash(c.address)) === c.runtimeCodeHash);
    check("the factory, the router and the lens are already on the chain (the owner's deployment) and hold exactly the planned code", same.every(Boolean), same);
  } else {
    refuse(present.length === 0, "the chain holds some of the planned contracts and not others: finish the deployment first");
    const deployerKey = generatePrivateKey();
    await rpc("anvil_setBalance", [privateKeyToAccount(deployerKey).address, hex(1000n * 10n ** 18n)]);
    const run = spawnSync("bash", ["scripts/multichain/deploy.sh", key, "broadcast", "--rehearsal-rpc", url, "--reference", "--", "--private-key", deployerKey], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
    writeFileSync(join(opt.out, "deploy.log"), `${run.stdout}\n${run.stderr}`.replaceAll(deployerKey, "<throwaway key>"));
    check("scripts/multichain/deploy.sh broadcast exits 0 on the fork", run.status === 0, `${run.stdout}\n${run.stderr}`.slice(-400));
  }
  const pairStateOnChain = async (p) => ((await rpc("eth_getCode", [p.address, "latest"])) === "0x" ? "absent" : (await read(p.address, "totalSupply")) > 0n ? "open" : "created");
  for (const p of plan.pairs) refuse((await pairStateOnChain(p)) === "absent", `the pair ${p.tokenA}/${p.tokenB} already exists on the forked chain: this rehearsal opens both pools itself and needs a fork from before the first opening (--fork-url of an archive endpoint and anvil's --fork-block-number are not wired here)`);

  await finalize();
  const gate = (log, extra = []) => {
    const run = tool(log, "gate.mjs", [key, "post", ...REHEARSAL, "--out", report, ...extra]);
    return { ...run, report: existsSync(report) ? readJson(report) : null };
  };
  const first = gate("gate-0-deployed");
  check("the post gate passes on the fork with both planned pairs not created", first.status === 0 && first.report.pairs.length === plan.pairs.length && first.report.pairs.every((p) => p.state === "absent"), failedChecks(first) || first.report?.pairs.map((p) => p.state));
  const verified = tool("verify-chain-0", "verify-chain.mjs", [key, ...REHEARSAL]);
  check("verify-chain.mjs: every listed token, its fee parameters and switches, and both pairs' price references hold on the fork", verified.status === 0, failedChecks(verified));
  // No record can be written while no pool is open.
  const early = tool("frontend-files-0", "frontend-files.mjs", [key, "--gate-report", report, "--out", join(opt.out, "page-0"), ...REHEARSAL]);
  check("no page record can be written while no pool is open", early.status !== 0 && /does not show every planned pair created/.test(early.out), early.out.slice(-200));

  // ---- 1 and 2. the pools, one after the other, each by the owner's commands ----
  const opened = [];
  /** The holder a rehearsal takes a token from: the pair's own reference pool, which holds it. */
  const holderOf = (token) => openingPriceFor(chain, token).references[1].pool;
  const fundToken = async (token, to, amount) => {
    const holder = holderOf(token);
    await impersonate(holder);
    await sendAs(holder, { to: token.address, data: data("transfer", [to, amount]) }, `the reference pool of ${token.symbol} hands ${formatUnits(amount, token.decimals)} to ${to === depositor ? "the depositing account" : to}`);
  };
  const prepareArgs = (pairName, native) => [key, "prepare", "--pair", pairName, "--native", native, "--gate-report", report, ...REHEARSAL];
  for (const [index, planned] of plan.pairs.entries()) {
    const token = chain.tokens.find((t) => t.symbol === (planned.tokenA === wrapped.symbol ? planned.tokenB : planned.tokenA));
    const pairName = `${planned.tokenA}/${planned.tokenB}`;
    const rule = openingPriceFor(chain, token);
    const zeroFirst = token.behaviour?.approveZeroFirst === true;
    // Twice the pair's stated minimum (whole-number arithmetic: the amounts are typed as decimal text).
    const times = (amount, numerator, denominator = 1n) => formatUnits((parseUnits(amount, 18) * numerator) / denominator, 18);
    const native = times(rule.minimumNative, 2n);
    const market = tool(`market-${index}`, "market.mjs", [key, "--pair", pairName, "--native", times(native, 2n), "--json", ...REHEARSAL]);
    const quoted = market.status === 0 ? JSON.parse(market.lines.join("\n")) : null;
    if (!check(`market.mjs --pair ${pairName}: the pair's own two references agree on the fork`, market.status === 0 && quoted.ok === true && quoted.pair === pairName && quoted.references.length === 2, market.out.slice(-300))) throw new Error("no market price");
    evidence[`market:${pairName}`] = { price: quoted.market, spreadBps: quoted.spreadBps, references: quoted.references.map((r) => ({ name: r.name, price: r.price })) };
    await fundToken(token, depositor, BigInt(quoted.amounts.token) * 2n);

    if (index > 0) {
      // The second pool is not open: `add` prints nothing for it, and the first pool is not touched by its commands.
      const tooEarly = tool(`add-${index}-before-opening`, "first-deposit.mjs", [key, "add", "--pair", pairName, "--native", native, "--token", formatUnits(BigInt(quoted.amounts.token) / 2n, token.decimals), "--gate-report", report, ...REHEARSAL]);
      check(`add --pair ${pairName} prints nothing while that pool is not open`, tooEarly.status === 1 && castLines(tooEarly).length === 0 && /shows this pool open, with its opening proven/.test(tooEarly.out), failedChecks(tooEarly));
    }
    if (token.behaviour?.transferFee) {
      // What a code hash does not show: the token's real owner switches a fee on, then pauses, before the opening.
      const owner = await read(token.address, "owner");
      await impersonate(owner);
      const snapshot = await rpc("evm_snapshot");
      await sendAs(owner, { to: token.address, data: data("setParams", [10n, 10n]) }, `${token.symbol}'s owner switches the transfer fee on: setParams(10, 10)`);
      const withFee = tool(`prepare-${index}-fee-on`, "first-deposit.mjs", prepareArgs(pairName, native));
      check(`with ${token.symbol}'s transfer fee switched on, prepare prints nothing to send`, withFee.status === 1 && castLines(withFee).length === 0 && /basisPointsRate\(\) is 10, not zero/.test(withFee.out) && /maximumFee\(\) is 10000000, not zero/.test(withFee.out), failedChecks(withFee) || withFee.out.slice(-300));
      await finalize();
      const gateFee = gate(`gate-${index}-fee-on`);
      check(`with the fee on, the post gate fails on ${token.symbol}`, gateFee.status === 1 && new RegExp(`FAIL ${token.symbol} takes no fee on transfer`).test(gateFee.out), failedChecks(gateFee));
      const verifyFee = tool(`verify-chain-${index}-fee-on`, "verify-chain.mjs", [key, ...REHEARSAL]);
      check("with the fee on, verify-chain.mjs fails", verifyFee.status === 1 && /takes no fee on transfer and none of its declared switches is on/.test(failedChecks(verifyFee)), failedChecks(verifyFee));
      await rpc("evm_revert", [snapshot]);
      const snapshot2 = await rpc("evm_snapshot");
      await sendAs(owner, { to: token.address, data: data("pause") }, `${token.symbol}'s owner pauses the token`);
      const paused = tool(`prepare-${index}-paused`, "first-deposit.mjs", prepareArgs(pairName, native));
      check(`with ${token.symbol} paused, prepare prints nothing to send`, paused.status === 1 && castLines(paused).length === 0 && /paused\(\) is true/.test(paused.out), failedChecks(paused));
      await rpc("evm_revert", [snapshot2]);
      const snapshot3 = await rpc("evm_snapshot");
      await sendAs(owner, { to: token.address, data: data("addBlackList", [planned.address]) }, `${token.symbol}'s owner blacklists the planned pair's address`);
      const listed = tool(`prepare-${index}-blacklisted`, "first-deposit.mjs", prepareArgs(pairName, native));
      check(`with the planned pair's address on ${token.symbol}'s blacklist, prepare prints nothing to send`, listed.status === 1 && castLines(listed).length === 0 && /the pair 0x[0-9a-fA-F]{40} is on the issuer's blocklist/.test(listed.out), failedChecks(listed));
      await rpc("evm_revert", [snapshot3]);
      // The report at --out is the passing one again for what follows.
      await finalize();
      const again = gate(`gate-${index}-fee-off-again`, index > 0 ? ["--opening", `${opened[0].pairName}=${opened[0].hash}`] : []);
      check("with the fee off again the post gate passes", again.status === 0, failedChecks(again));
    }

    let prepared = tool(`prepare-${index}`, "first-deposit.mjs", [...prepareArgs(pairName, native), "--out", join(opt.out, `prepare-${index}.json`)]);
    let lines = castLines(prepared);
    check(`prepare --pair ${pairName} passes and prints one approve and the deposit`, prepared.status === 0 && lines.length === 2 && / "approve\(address,uint256\)" /.test(lines[0]) && / "addLiquidityBLCH\(/.test(lines[1]) && lines.every((l) => l.endsWith(`--from ${depositor} --chain ${chain.chain.chainId}`)), failedChecks(prepared) || lines);
    if (prepared.status !== 0) throw new Error(`prepare ${pairName} failed`);
    if (zeroFirst) {
      // An earlier run's approve was sent and its deposit was not; the owner then prepares another amount.
      sendPrinted(lines[0], `${pairName}: the approve of a first prepare is sent; its deposit is not`);
      const stale = await read(token.address, "allowance", [depositor, router.address]);
      const larger = times(native, 3n, 2n);
      prepared = tool(`prepare-${index}-stale-allowance`, "first-deposit.mjs", [...prepareArgs(pairName, larger), "--out", join(opt.out, `prepare-${index}.json`)]);
      lines = castLines(prepared);
      check(`with an allowance of ${formatUnits(stale, token.decimals)} ${token.symbol} left, prepare for another amount prints approve 0, approve, deposit, and says why`, prepared.status === 0 && lines.length === 3 && new RegExp(`"approve\\(address,uint256\\)" ${router.address} 0 --from`).test(lines[0]) && / "approve\(address,uint256\)" /.test(lines[1]) && !/ 0 --from/.test(lines[1]) && / "addLiquidityBLCH\(/.test(lines[2]) && /the first line sets it to zero and the second sets the new amount/.test(prepared.out) && /Send these three transactions/.test(prepared.out), failedChecks(prepared) || lines);
      // The recovery the documents described before round 20 ("the new approve replaces the old allowance").
      const direct = sendPrinted(lines[1], `${pairName}: the new approve sent WITHOUT the reset (the old recovery text)`, { expectFailure: true });
      check(`${token.symbol} refuses the plain new approve over the old allowance: without the reset the owner is stuck`, direct.exit !== 0 && (await read(token.address, "allowance", [depositor, router.address])) === stale, direct);
      sendPrinted(lines[0], `${pairName}: approve 0 as printed`);
      sendPrinted(lines[1], `${pairName}: the exact approve as printed`);
      // With the allowance now exactly the amount, the same command prints the deposit alone.
      const exact = tool(`prepare-${index}-exact-allowance`, "first-deposit.mjs", prepareArgs(pairName, larger));
      const only = castLines(exact);
      check("with the allowance already exactly the amount, prepare prints the deposit alone", exact.status === 0 && only.length === 1 && / "addLiquidityBLCH\(/.test(only[0]) && /no approve is printed/.test(exact.out) && /Send this one transaction FROM/.test(exact.out), failedChecks(exact) || only);
      lines = [lines[2]];
    } else sendPrinted(lines[0], `${pairName}: the approve as printed`);
    const amounts = readJson(join(opt.out, `prepare-${index}.json`)).amounts;
    const deposit = sendPrinted(lines.at(-1), `${pairName}: the deposit as printed (creates the pair and opens the pool)`);
    const verify = tool(`verify-${index}`, "first-deposit.mjs", [key, "verify", "--pair", pairName, "--native", amounts.nativeText, "--token", amounts.tokenText, "--tx", deposit.hash, ...REHEARSAL]);
    check(`verify --pair ${pairName} proves the opening from the deposit transaction`, verify.status === 0 && /multichain verify .*: PASS/.test(verify.out), failedChecks(verify));
    await finalize();
    // The option names only the pair just opened; an earlier pair's hash comes from the report at --out.
    const proven = gate(`gate-${index + 1}-opened`, ["--opening", `${pairName}=${deposit.hash}`]);
    const states = proven.report?.pairs.map((p) => `${p.tokenA}/${p.tokenB}:${p.state}:${p.opening?.proven === true}`);
    const expected = plan.pairs.map((p, i) => `${p.tokenA}/${p.tokenB}:${i <= index ? "open:true" : "absent:false"}`);
    check(`the post gate passes with ${index + 1} of ${plan.pairs.length} pools open and each opening proven`, proven.status === 0 && text(states) === text(expected), failedChecks(proven) || states);
    opened.push({ pairName, token, planned, hash: deposit.hash, amounts });
    const pageDir = join(opt.out, `page-${index + 1}`);
    const files = tool(`frontend-files-${index + 1}`, "frontend-files.mjs", [key, "--gate-report", report, "--out", pageDir, ...REHEARSAL]);
    const record = files.status === 0 ? readJson(join(pageDir, key, "frontend.record.json")) : null;
    const network = files.status === 0 ? readJson(join(pageDir, key, "frontend.network.json")) : null;
    const listedPairs = record?.pairs.map((p) => p.address);
    const wantPairs = plan.pairs.slice(0, index + 1).map((p) => lower(p.address));
    const wantNotOpen = plan.pairs.slice(index + 1).map((p) => ({ address: lower(p.address), state: "absent" }));
    check(
      index + 1 < plan.pairs.length ? "the page's record lists the open pool alone and names the other planned pair as not open: the chain is live with one pool" : "the page's record lists both pools and names nothing as not open",
      record?.status === "deployed" && text(listedPairs) === text(wantPairs) && text((record.notOpen ?? []).map((p) => ({ address: p.address, state: p.state }))) === text(wantNotOpen) && ("notOpen" in record) === (wantNotOpen.length > 0),
      files.out.slice(-300) || record,
    );
    check("the page's network file names every listed token by its contract's own symbol", text(network?.tokens.map((t) => t.symbol)) === text(chain.tokens.map(chainSymbolOf)), network?.tokens.map((t) => t.symbol));
  }

  // ---- 5. trades through both pools, and a later deposit ----
  const [firstPool, secondPool] = opened;
  const second = secondPool.token;
  const usdc = firstPool.token;
  const deadline = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp) + 86_400n;
  const tradeNative = parseUnits(openingPriceFor(chain, second).minimumNative, 18) / 10n;
  const before = await read(second.address, "balanceOf", [trader]);
  await sendAs(trader, { to: router.address, value: tradeNative, data: data("swapExactBLCHForTokens", [1n, [wrapped.address, second.address], trader, deadline]) }, `a trader buys ${second.symbol} with ${formatUnits(tradeNative, 18)} ${coin}`);
  const bought = (await read(second.address, "balanceOf", [trader])) - before;
  const fair = (tradeNative * BigInt(secondPool.amounts.token)) / BigInt(secondPool.amounts.native);
  check(`buying ${second.symbol} with the native coin pays out within 1% to 12% under the opening price (fee and price impact)`, bought * 100n > fair * 88n && bought * 100n < fair * 100n, { bought, fair });
  // Sell half back for the native coin, with an exact approval, as the page does.
  const half = bought / 2n;
  await sendAs(trader, { to: second.address, data: data("approve", [router.address, half]) }, `the trader approves exactly ${formatUnits(half, second.decimals)} ${second.symbol}`);
  const nativeBefore = BigInt(await rpc("eth_getBalance", [trader, "latest"]));
  const sold = await sendAs(trader, { to: router.address, data: data("swapExactTokensForBLCH", [half, 1n, [second.address, wrapped.address], trader, deadline]) }, `the trader sells ${second.symbol} for the native coin`);
  check(`selling ${second.symbol} for the native coin pays out more than the sale's gas and consumes the exact allowance`, sold.ok && BigInt(await rpc("eth_getBalance", [trader, "latest"])) > nativeBefore && (await read(second.address, "allowance", [trader, router.address])) === 0n);
  // Token to token through the wrapped token (two pools), as the page routes it.
  const rest2 = bought - half;
  await sendAs(trader, { to: second.address, data: data("approve", [router.address, rest2]) }, `the trader approves exactly ${formatUnits(rest2, second.decimals)} ${second.symbol} again (the allowance was back at zero)`);
  const usdcBefore = await read(usdc.address, "balanceOf", [trader]);
  await sendAs(trader, { to: router.address, data: data("swapExactTokensForTokens", [rest2, 1n, [second.address, wrapped.address, usdc.address], trader, deadline]) }, `the trader swaps ${second.symbol} for ${usdc.symbol} through ${wrapped.symbol} (two pools)`);
  const gotUsdc = (await read(usdc.address, "balanceOf", [trader])) - usdcBefore;
  const par = (rest2 * 10n ** BigInt(usdc.decimals)) / 10n ** BigInt(second.decimals);
  check(`a two-pool swap ${second.symbol} to ${usdc.symbol} pays out between 80% and 100% of par (two fees and the price impact of small pools)`, gotUsdc * 100n > par * 80n && gotUsdc < par, { gotUsdc, par });
  if (second.behaviour?.approveZeroFirst) {
    // The page's case: an allowance left from an earlier quote, then a larger amount.
    await fundToken(second, trader, 50n * 10n ** BigInt(second.decimals));
    await sendAs(trader, { to: second.address, data: data("approve", [router.address, 10n ** BigInt(second.decimals)]) }, "the trader approves 1 unit for a quote and does not swap");
    const refused = await sendAs(trader, { to: second.address, data: data("approve", [router.address, 5n * 10n ** BigInt(second.decimals)]) }, "the trader's wallet sends the exact approval of a larger quote over it", { mayRevert: true });
    const reset = await sendAs(trader, { to: second.address, data: data("approve", [router.address, 0n]) }, "the page's reset: approve(router, 0)");
    const exact = await sendAs(trader, { to: second.address, data: data("approve", [router.address, 5n * 10n ** BigInt(second.decimals)]) }, "then the exact approval");
    check(`a user's approval over a non-zero allowance of ${second.symbol} reverts; after the page's reset to zero the exact approval goes through`, refused.ok === false && reset.ok && exact.ok && reset.gasUsed < 100_000n && exact.gasUsed < 100_000n, { refused, reset, exact });
  }
  // A later deposit into the second pool, as `add` prints it. The amounts are the pool's own price now.
  await finalize();
  const forAdd = gate("gate-3-before-add");
  const [r0, r1] = await read(secondPool.planned.address, "getReserves");
  const wrappedIs0 = lower(secondPool.planned.token0) === lower(wrapped.address);
  const [reserveNative, reserveToken] = wrappedIs0 ? [r0, r1] : [r1, r0];
  const addNative = openingPriceFor(chain, second).minimumNative;
  const addToken = formatUnits((parseUnits(addNative, 18) * reserveToken) / reserveNative, second.decimals);
  const addArgs = [key, "add", "--pair", secondPool.pairName, "--native", addNative, "--token", addToken, "--gate-report", report, ...REHEARSAL];
  const add = tool("add-second-pool", "first-deposit.mjs", addArgs);
  const addLines = castLines(add);
  check(`add --pair ${secondPool.pairName} prints one approve and the deposit for a pool the gate proved`, forAdd.status === 0 && add.status === 0 && addLines.length === 2, failedChecks(add) || failedChecks(forAdd));
  if (add.status === 0) {
    const supplyBefore = await read(secondPool.planned.address, "totalSupply");
    for (const [i, line] of addLines.entries()) sendPrinted(line, `add ${secondPool.pairName}: line ${i + 1} as printed`);
    check("the later deposit minted LP shares", (await read(secondPool.planned.address, "totalSupply")) > supplyBefore);
  }
  if (second.behaviour?.transferFee) {
    const owner = await read(second.address, "owner");
    const snapshot = await rpc("evm_snapshot");
    await sendAs(owner, { to: second.address, data: data("setParams", [10n, 10n]) }, `${second.symbol}'s owner switches the fee on AFTER the pool is open`);
    const addFee = tool("add-second-pool-fee-on", "first-deposit.mjs", addArgs);
    check("with the fee on, add prints nothing to send", addFee.status === 1 && castLines(addFee).length === 0 && /not zero: the issuer has switched on a fee/.test(addFee.out), failedChecks(addFee));
    // What the frozen contracts do then: selling the token through the plain router call reverts.
    await fundToken(second, trader, 20n * 10n ** BigInt(second.decimals));
    const allowanceNow = await read(second.address, "allowance", [trader, router.address]);
    if (allowanceNow > 0n) await sendAs(trader, { to: second.address, data: data("approve", [router.address, 0n]) }, "the trader resets the allowance");
    await sendAs(trader, { to: second.address, data: data("approve", [router.address, 10n * 10n ** BigInt(second.decimals)]) }, "the trader approves 10 units");
    const sell = await sendAs(trader, { to: router.address, data: data("swapExactTokensForBLCH", [10n * 10n ** BigInt(second.decimals), 1n, [second.address, wrapped.address], trader, deadline]) }, "the trader sells the token with the fee on", { mayRevert: true });
    check("with the fee on, a sale of the token through the router reverts (the pair is paid short): such a token cannot be listed", sell.ok === false, sell);
    await rpc("evm_revert", [snapshot]);
  }

  // ---- 6. the token's behaviour next to the forge tests' stand-in ----
  const tetherLike = second.behaviour?.returnsNoValue === true;
  const artifact = readJson(join(ROOT, "out/TetherLegacyToken.sol", `${tetherLike ? "TetherLegacyToken" : "PlainUsdtLikeToken"}.json`));
  const issuer = account();
  await impersonate(issuer);
  const creation = tetherLike ? artifact.bytecode.object : `${artifact.bytecode.object}${second.decimals.toString(16).padStart(64, "0")}`;
  const deployHash = await rpc("eth_sendTransaction", [{ from: issuer, data: creation, gas: hex(4_000_000n), gasPrice: hex(await gasPrice()) }]);
  let deployed = null;
  for (let i = 0; i < 100 && !deployed; i++) {
    deployed = await rpc("eth_getTransactionReceipt", [deployHash]);
    if (!deployed) await delay(100);
  }
  const standIn = deployed.contractAddress;
  const unit = 10n ** BigInt(second.decimals);
  /** The same calls, in the same order, against `token`; each outcome as a short text. */
  async function observe(token, { holder, owner }) {
    const out = [];
    const dry = async (from, fn, args) => rpc("eth_call", [{ from, to: token, data: data(fn, args) }, "latest"]).then((d) => `returns ${(d.length - 2) / 2} bytes${d.length > 2 ? ` (${BigInt(d)})` : ""}`, () => "reverts");
    const sent = async (from, fn, args) => ((await sendAs(from, { to: token, data: data(fn, args) }, `observe ${fn}`, { mayRevert: true })).ok ? "ok" : "reverts");
    const view = (fn, args) => read(token, fn, args);
    const note = (label, value) => out.push(`${label}: ${value}`);
    for (const a of [holder, owner]) await impersonate(a);
    note("call transfer(recipient, 1)", await dry(holder, "transfer", [recipient, 1n]));
    note("call approve(spender, 5)", await dry(holder, "approve", [spender, 5n]));
    note("send approve(spender, 5)", await sent(holder, "approve", [spender, 5n]));
    note("call approve(spender, 7) over 5", await dry(holder, "approve", [spender, 7n]));
    note("call approve(spender, 5) over 5", await dry(holder, "approve", [spender, 5n]));
    note("call transferFrom(holder, recipient, 3) by the spender", await dry(spender, "transferFrom", [holder, recipient, 3n]));
    const b0 = await view("balanceOf", [recipient]);
    note("send transferFrom(holder, recipient, 3)", await sent(spender, "transferFrom", [holder, recipient, 3n]));
    note("recipient received", (await view("balanceOf", [recipient])) - b0);
    note("allowance left", await view("allowance", [holder, spender]));
    note("send approve(spender, 0)", await sent(holder, "approve", [spender, 0n]));
    note("send approve(spender, 7) from zero", await sent(holder, "approve", [spender, 7n]));
    note("send approve(spender, 0) again", await sent(holder, "approve", [spender, 0n]));
    if (!tetherLike) return out;
    const MAX = 2n ** 256n - 1n;
    note("send approve(spender, 2^256 - 1)", await sent(holder, "approve", [spender, MAX]));
    note("send transferFrom(holder, recipient, 4)", await sent(spender, "transferFrom", [holder, recipient, 4n]));
    note("an allowance of 2^256 - 1 is not reduced", (await view("allowance", [holder, spender])) === MAX);
    note("send approve(spender, 0) from the maximum", await sent(holder, "approve", [spender, 0n]));
    // The fee: 0.10%, at most 10 whole tokens, credited to the owner.
    note("owner setParams(10, 10)", await sent(owner, "setParams", [10n, 10n]));
    for (const whole of [2_000n, 20_000n]) {
      const [r, o] = [await view("balanceOf", [recipient]), await view("balanceOf", [owner])];
      note(`send transfer(recipient, ${whole} tokens) with the fee on`, await sent(holder, "transfer", [recipient, whole * unit]));
      note(`recipient received of ${whole}`, formatUnits((await view("balanceOf", [recipient])) - r, second.decimals));
      note(`owner received of ${whole}`, formatUnits((await view("balanceOf", [owner])) - o, second.decimals));
    }
    note("owner setParams(20, 10)", await sent(owner, "setParams", [20n, 10n]));
    note("owner setParams(10, 50)", await sent(owner, "setParams", [10n, 50n]));
    note("owner setParams(0, 0)", await sent(owner, "setParams", [0n, 0n]));
    // Pause: transfers stop, approve stays open.
    note("owner pause()", await sent(owner, "pause"));
    note("call transfer while paused", await dry(holder, "transfer", [recipient, 1n]));
    note("send approve(spender, 9) while paused", await sent(holder, "approve", [spender, 9n]));
    note("call transferFrom while paused", await dry(spender, "transferFrom", [holder, recipient, 1n]));
    note("owner unpause()", await sent(owner, "unpause"));
    // Blacklist: the holder cannot send, can still receive; a blacklisted balance can be destroyed.
    note("owner addBlackList(holder)", await sent(owner, "addBlackList", [holder]));
    note("call transfer by the blacklisted holder", await dry(holder, "transfer", [recipient, 1n]));
    note("call transferFrom of the blacklisted holder", await dry(spender, "transferFrom", [holder, recipient, 1n]));
    note("send transfer TO the blacklisted holder", await sent(recipient, "transfer", [holder, 1n]));
    note("owner removeBlackList(holder)", await sent(owner, "removeBlackList", [holder]));
    note("owner addBlackList(recipient)", await sent(owner, "addBlackList", [recipient]));
    note("owner destroyBlackFunds(recipient)", await sent(owner, "destroyBlackFunds", [recipient]));
    note("recipient balance after destruction", await view("balanceOf", [recipient]));
    note("owner removeBlackList(recipient)", await sent(owner, "removeBlackList", [recipient]));
    note("send approve(spender, 0) at the end", await sent(holder, "approve", [spender, 0n]));
    // Deprecation: every call is answered by another contract (an empty stand-in here).
    const next = readJson(join(ROOT, "out/TetherLegacyToken.sol/UpgradedTetherStandIn.json"));
    const nextHash = await rpc("eth_sendTransaction", [{ from: issuer, data: next.bytecode.object, gas: hex(2_000_000n), gasPrice: hex(await gasPrice()) }]);
    let nextReceipt = null;
    for (let i = 0; i < 100 && !nextReceipt; i++) {
      nextReceipt = await rpc("eth_getTransactionReceipt", [nextHash]);
      if (!nextReceipt) await delay(100);
    }
    const snapshot = await rpc("evm_snapshot");
    note("owner deprecate(another contract)", await sent(owner, "deprecate", [nextReceipt.contractAddress]));
    note("balanceOf(holder) after deprecation is the other contract's", await view("balanceOf", [holder]));
    note("call transfer after deprecation (the other contract has no balance for the holder)", await dry(holder, "transfer", [recipient, 1n]));
    await rpc("evm_revert", [snapshot]);
    return out;
  }
  // The real token: a holder of the fork with a real balance; its real owner (Tether-like only).
  const realHolder = account();
  await impersonate(realHolder);
  await fundToken(second, realHolder, 30_000n * unit);
  const realOwner = tetherLike ? await read(second.address, "owner") : realHolder;
  const snapshotReal = await rpc("evm_snapshot");
  const real = await observe(second.address, { holder: realHolder, owner: realOwner });
  await rpc("evm_revert", [snapshotReal]);
  // The stand-in: the same balance from its issuer.
  const mockHolder = account();
  await impersonate(mockHolder);
  if (tetherLike) {
    await sendAs(issuer, { to: standIn, data: data("issue", [1_000_000n * unit]) }, "stand-in: issue");
    await sendAs(issuer, { to: standIn, data: data("transfer", [mockHolder, 30_000n * unit]) }, "stand-in: fund the holder");
  } else await sendAs(issuer, { to: standIn, data: data("mint", [mockHolder, 30_000n * unit]) }, "stand-in: mint to the holder");
  const mock = await observe(standIn, { holder: mockHolder, owner: issuer });
  evidence.behaviour = { token: second.address, standIn: `${tetherLike ? "TetherLegacyToken" : "PlainUsdtLikeToken"} (test/mocks/TetherLegacyToken.sol)`, observations: real.map((line, i) => ({ real: line, standIn: mock[i] })) };
  const different = real.map((line, i) => (line === mock[i] ? null : { real: line, standIn: mock[i] })).filter(Boolean);
  check(`the real ${second.symbol} and the forge tests' stand-in answer ${real.length} calls alike, one by one`, real.length === mock.length && different.length === 0, different);
  const declared = second.behaviour;
  const noValue = real[0].endsWith("returns 0 bytes");
  const zeroFirstSeen = real.find((l) => l.startsWith("call approve(spender, 7) over 5")).endsWith("reverts");
  check(`what the chain file declares of ${second.symbol} is what the token does: returnsNoValue ${declared.returnsNoValue}, approveZeroFirst ${declared.approveZeroFirst}`, noValue === declared.returnsNoValue && zeroFirstSeen === declared.approveZeroFirst, { noValue, zeroFirstSeen });
} catch (error) {
  failed = true;
  evidence.error = String(error.stack ?? error).slice(0, 1500);
  console.error(error);
} finally {
  anvil.kill("SIGTERM");
}
const bad = evidence.checks.filter((c) => !c.ok).length;
evidence.result = !failed && bad === 0 ? "PASS" : "FAIL";
save();
console.log(`second-pair rehearsal ${key}: ${evidence.result}; ${evidence.checks.length} checks, ${bad} failed; ${join(opt.out, "evidence.json")}`);
process.exit(evidence.result === "PASS" ? 0 : 1);
