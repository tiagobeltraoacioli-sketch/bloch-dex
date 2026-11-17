// Regression tests of the fixes of review 369 (agents/369-dex-owner-tools-review-r18.md, round 18) to the owner-run
// multichain tools. Each restates one of the reviewer's demonstrations (scripts/multichain/review/
// r369-owner-tools.test.mjs on codex/dex-owner-tools-review-r18-20261117, which asserted the defect) as the
// property the fix must hold; the fixtures are the reviewer's. No RPC, no key, nothing signed.
//   node --test scripts/multichain/owner-tools-r369.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING, PUBLIC_DEVELOPMENT_ACCOUNTS, ROOT, lower, loadArtifacts, loadChain, loadShared, pinnedStateReader, planChain, validateChain, validateShared } from "./lib.mjs";
import { evaluateGate } from "./gate.mjs";
import { offlineProblems } from "./check-depositor.mjs";
import { LOCKED_SHARES, MINT_TOPIC, TRANSFER_TOPIC, readOpening } from "./opening.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const clone = (v) => JSON.parse(JSON.stringify(v));
const committed = loadShared();
const open = (() => {
  const s = clone(committed);
  s.firstDepositor = PENDING;
  delete s.firstDepositorCheck;
  return validateShared(s);
})();
const artifacts = loadArtifacts();
const base = validateChain({ ...clone(loadChain("base")), reserveCaps: PENDING }, "base");
const BLOCK = `0x${"ab".repeat(32)}`;

/** A stand-in chain for the gate (reviewer 369's fixture): records every method and block parameter it is asked. */
function gateWorld(local, chain, plan, over = {}) {
  const { keccak256, encodeFunctionResult, parseAbi, toFunctionSelector, toHex } = viem;
  const code = (label) => toHex(`code:${label}`);
  const abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)"]);
  const names = Object.fromEntries(abi.map((f) => [toFunctionSelector(f), f.name]));
  const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.wrappedNative.address), code("wrapped")], [lower(chain.tokens[0].address), code("token")], [lower(chain.multicall3.address), code("multicall")], [lower(local.feeTo.address), over.feeCode ?? "0x"]]);
  if (over.depositorCode) codes.set(lower(plan.arguments.firstDepositor), over.depositorCode);
  const asked = [];
  const request = async (method, params) => {
    asked.push({ method, block: params?.[params.length - 1] });
    if (over.down && method !== "eth_chainId" && method !== "eth_getBlockByNumber") throw new Error("HTTP 403: archive requests require a personal token");
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: BLOCK, timestamp: "0x1" };
    if (method === "eth_getCode") return codes.get(lower(params[0])) ?? "0x";
    if (method === "eth_getTransactionCount") return over.depositorNonce ?? "0x0";
    if (method === "eth_call") {
      const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === lower(params[0].to));
      const fn = names[params[0].data.slice(0, 10)];
      if (fn === "getChainId") return encodeFunctionResult({ abi, functionName: fn, result: 8453n });
      return encodeFunctionResult({ abi, functionName: fn, result: fn === "decimals" ? token.decimals : token[fn] });
    }
    throw new Error(`unexpected ${method}`);
  };
  request.asked = asked;
  return { request, pins: { deployer: keccak256(code("deployer")), wrapped: keccak256(code("wrapped")), token: keccak256(code("token")), multicall: keccak256(code("multicall")) } };
}

function pinnedSetup() {
  const local = clone(open);
  const chain = clone(base);
  const probe = gateWorld(local, chain, planChain(local, chain, artifacts, { reference: true }));
  local.create2.deployerCodeHash = probe.pins.deployer;
  chain.wrappedNative.codeHash = probe.pins.wrapped;
  chain.tokens[0].codeHash = probe.pins.token;
  chain.multicall3.codeHash = probe.pins.multicall;
  return { local, chain, plan: planChain(local, chain, artifacts, { reference: true }) };
}

test("pinnedStateReader: a state read is sent to every endpoint at the block HASH, used only when two answered alike; a disagreement or a single answer decides nothing; an agreed revert is the chain's answer", async () => {
  const seen = [];
  const endpoint = (answer) => async (method, params) => {
    seen.push(params[params.length - 1]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const read = pinnedStateReader([endpoint("0x01"), endpoint("0x01")], BLOCK);
  assert.equal(await read("eth_getCode", ["0x0000000000000000000000000000000000000001", "latest"]), "0x01");
  assert.deepEqual(seen, [{ blockHash: BLOCK, requireCanonical: true }, { blockHash: BLOCK, requireCanonical: true }], "the tag the caller named is replaced by the pinned hash on every endpoint");
  await assert.rejects(pinnedStateReader([endpoint("0x01"), endpoint("0x02")], BLOCK)("eth_getCode", ["0x00", "latest"]), /DISAGREEMENT/);
  await assert.rejects(pinnedStateReader([endpoint("0x01"), endpoint(new Error("HTTP 403"))], BLOCK)("eth_getCode", ["0x00", "latest"]), /1 endpoint answered, 2 must agree/);
  // A third endpoint stands in for one that cannot answer (pruned state, rate limit) ...
  assert.equal(await pinnedStateReader([endpoint("0x01"), endpoint(new Error("HTTP 429")), endpoint("0x01")], BLOCK)("eth_getCode", ["0x00", "latest"]), "0x01");
  // ... but never outvotes one that answers differently.
  await assert.rejects(pinnedStateReader([endpoint("0x01"), endpoint("0x01"), endpoint("0x02")], BLOCK)("eth_getCode", ["0x00", "latest"]), /DISAGREEMENT/);
  await assert.rejects(pinnedStateReader([endpoint(new Error("execution reverted")), endpoint(new Error("execution reverted: X"))], BLOCK)("eth_call", [{}, "latest"]), /execution reverted/);
  await assert.rejects(pinnedStateReader([endpoint(new Error("execution reverted")), endpoint("0x01")], BLOCK)("eth_call", [{}, "latest"]), /DISAGREEMENT/);
  await assert.rejects(pinnedStateReader([endpoint("0x01")], BLOCK)("eth_getBlockByNumber", ["latest", false]), /not a state read/);
  // One endpoint is accepted only when only one is given (a loopback rehearsal).
  assert.equal(await pinnedStateReader([endpoint("0x01")], BLOCK)("eth_getCode", ["0x00", "latest"]), "0x01");
});

test("R369-1 fixed: a lying FIRST endpoint no longer passes the pre gate; the second endpoint is asked every state read, at the finalized hash", async () => {
  const { local, chain, plan } = pinnedSetup();
  const liar = gateWorld(local, chain, plan).request;
  const truth = gateWorld(local, chain, plan, { depositorCode: `0xef0100${"66".repeat(20)}`, depositorNonce: "0x3", feeCode: `0xef0100${"77".repeat(20)}` }).request;
  const run = evaluateGate({ shared: local, chain, plan, phase: "pre", request: liar, others: [truth], feeProof: { valid: true, problems: [] } }).then(
    (report) => ({ report }),
    (error) => ({ error }),
  );
  const outcome = await run;
  if (outcome.report) assert.equal(outcome.report.decision, "fail", "the gate must not pass on the liar's word");
  else assert.match(String(outcome.error.message), /DISAGREEMENT/);
  const methods = new Set(truth.asked.map((a) => a.method));
  for (const m of ["eth_getCode", "eth_call"]) assert.ok(methods.has(m), `the second endpoint is asked ${m}`);
  for (const a of truth.asked.filter((x) => x.method === "eth_getCode" || x.method === "eth_call" || x.method === "eth_getTransactionCount"))
    assert.deepEqual(a.block, { blockHash: BLOCK, requireCanonical: true }, `${a.method} is read at the finalized block's hash`);
  // Two truthful endpoints pass, and the report says how the state was read.
  const ok = await evaluateGate({ shared: local, chain, plan, phase: "pre", request: gateWorld(local, chain, plan).request, others: [gateWorld(local, chain, plan).request], feeProof: { valid: true, problems: [] } });
  assert.equal(ok.decision, "pass", JSON.stringify(ok.failed));
  assert.equal(ok.stateReads.endpoints, 2);
  assert.equal(ok.stateReads.agreeing, 2);
  assert.ok(ok.stateReads.reads > 0);
  // A second endpoint that cannot serve the state (pruned) is not a pass on one endpoint's word.
  const pruned = await evaluateGate({ shared: local, chain, plan, phase: "pre", request: gateWorld(local, chain, plan).request, others: [gateWorld(local, chain, plan, { down: true }).request], feeProof: { valid: true, problems: [] } }).then(
    (report) => report.decision,
    (error) => String(error.message),
  );
  assert.notEqual(pruned, "pass");
});

function openingFixture({ pair, router, depositor, token, wrappedIs0, native = 10n ** 19n, tokenAmount = 30_000_000_000n, over = {} }) {
  const abi = viem.parseAbi(["function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)"]);
  const word = (n) => n.toString(16).padStart(64, "0");
  const topic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const zero = `0x${"0".repeat(64)}`;
  const [amount0, amount1] = wrappedIs0 ? [native, tokenAmount] : [tokenAmount, native];
  const hash = `0x${"0e".repeat(32)}`;
  const tx = { hash, from: depositor, to: router, value: `0x${native.toString(16)}`, input: viem.encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [token, tokenAmount, tokenAmount, native, depositor, 2_000_000_000n] }), ...over.tx };
  const receipt = {
    transactionHash: hash, status: "0x1", blockNumber: "0x60", blockHash: BLOCK,
    logs: [
      { address: pair, topics: [TRANSFER_TOPIC, zero, zero], data: `0x${word(LOCKED_SHARES)}` },
      { address: pair, topics: [MINT_TOPIC, topic(router)], data: `0x${word(amount0)}${word(amount1)}` },
    ],
    ...over.receipt,
  };
  return { hash, tx, receipt };
}

const openingFacts = () => {
  const plan = planChain(open, base, artifacts, { reference: true });
  const pair = plan.pairs[0];
  return { pair: pair.address, router: plan.contracts.router.address, depositor: plan.arguments.firstDepositor, token: base.tokens[0].address, wrappedIs0: lower(pair.token0) === lower(base.wrappedNative.address) };
};

test("R369-2 fixed: an opening is proven only when a second endpoint serves the same transaction and receipt", async () => {
  const facts = openingFacts();
  const fake = openingFixture(facts);
  const serving = (fixture) => async (method) => (method === "eth_getTransactionByHash" ? fixture.tx : method === "eth_getTransactionReceipt" ? fixture.receipt : { number: "0x60", hash: BLOCK });
  // The reviewer's case: the second endpoint has the block and has never seen the transaction.
  const blockOnly = async (method) => (method === "eth_getBlockByNumber" ? { number: "0x60", hash: BLOCK, transactions: [] } : null);
  const lone = await readOpening({ request: serving(fake), others: [blockOnly], hash: fake.hash, finalizedNumber: 100, ...facts });
  assert.equal(lone.proven, false);
  assert.match(lone.problems.join("; "), /one endpoint's word is not a proof/);
  // A second endpoint with another receipt under the same hash (another status) fails the proof.
  const other = openingFixture({ ...facts, over: { receipt: { status: "0x0" } } });
  const differs = await readOpening({ request: serving(fake), others: [serving(other)], hash: fake.hash, finalizedNumber: 100, ...facts });
  assert.equal(differs.proven, false);
  assert.match(differs.problems.join("; "), /different transaction or receipt/);
  // Two endpoints that serve the same transaction and receipt prove it; one that has not caught up is not counted.
  assert.equal((await readOpening({ request: serving(fake), others: [serving(fake)], hash: fake.hash, finalizedNumber: 100, ...facts })).proven, true);
  assert.equal((await readOpening({ request: serving(fake), others: [blockOnly, serving(fake)], hash: fake.hash, finalizedNumber: 100, ...facts })).proven, true);
});

test("R369-3 fixed: prepare tells the owner to send with cast only, never through a batching or smart-account wallet", () => {
  const source = readFileSync(join(ROOT, "scripts/multichain/first-deposit.mjs"), "utf8");
  assert.match(source, /Never import this key into a browser wallet, never accept "switch to smart account", and never send the two as one batched transaction/);
  const doc = readFileSync(join(ROOT, "docs/MULTICHAIN-DEPLOY.md"), "utf8");
  assert.match(doc, /Send them with `cast send`, one at\s+a time, exactly as printed/);
});

test("R369-5 fixed: check-depositor refuses the public development accounts and an address written in any tracked file of the repository", () => {
  assert.equal(PUBLIC_DEVELOPMENT_ACCOUNTS.length, 20);
  for (const a of PUBLIC_DEVELOPMENT_ACCOUNTS) assert.match(offlineProblems(viem.getAddress(a), open).join(), /public development mnemonic/, a);
  // The reviewer's case: anvil's account 0, written in scripts/staging/rehearse-deploy-anvil.sh.
  assert.match(offlineProblems("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", open).join(), /appears in files of the repository \(.*scripts\/staging/);
  // In a repository of its own: an address in a tracked document is refused; the recorded depositor is judged on
  // deployments/ only (it is written in the documents on purpose).
  const dir = mkdtempSync(join(tmpdir(), "r369-5-"));
  try {
    mkdirSync(join(dir, "deployments"));
    copyFileSync(join(ROOT, "deployments/multichain.json"), join(dir, "deployments/multichain.json"));
    const stranger = viem.getAddress("0x00000000000000000000000000000000000b0b00");
    writeFileSync(join(dir, "NOTES.md"), `a test account ${stranger} and the depositor ${committed.firstDepositor}\n`);
    assert.equal(spawnSync("git", ["-C", dir, "init", "-q"]).status, 0);
    assert.equal(spawnSync("git", ["-C", dir, "add", "-A"]).status, 0);
    assert.match(offlineProblems(stranger, open, { root: dir }).join(), /appears in files of the repository \(NOTES\.md\)/);
    assert.doesNotMatch(offlineProblems(committed.firstDepositor, open, { root: dir }).join(), /appears in files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The committed depositor stays fit offline.
  assert.deepEqual(offlineProblems(committed.firstDepositor, open), []);
});

test("R369-6 fixed: deploy.sh removes every MC_* variable of the caller's shell before it reads the plan's", () => {
  const script = readFileSync(join(ROOT, "scripts/multichain/deploy.sh"), "utf8");
  const unset = script.split("\n").find((l) => l.includes("compgen -e") && l.includes("unset"));
  assert.ok(unset, "the unset line is in deploy.sh");
  const at = script.indexOf(unset);
  assert.ok(at > script.indexOf("plan.mjs \"$CHAIN\" $REFERENCE --env") && at < script.indexOf(". \"$ENV_FILE\""), "it runs after the plan is written and before the plan's file is sourced");
  const run = spawnSync("bash", ["-c", `${unset}\nenv | grep '^MC_' || true`], { encoding: "utf8", env: { ...process.env, MC_PAIR_TOKENS: "0x1,0x2", MC_CAPS: "1", MC_CAP_TOKENS: "0x3", MC_RPC_URL: "http://127.0.0.1:1" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "", "no MC_* variable survives");
});

test("R369-7 fixed: a public-chain broadcast shows chain id, target, the three addresses and their constructor values, and sends only after the owner types the chain's key", () => {
  const script = readFileSync(join(ROOT, "scripts/multichain/deploy.sh"), "utf8");
  const ask = script.indexOf('read -r -p "Type the chain\'s key');
  const forge = script.indexOf("forge script script/DeployMultichain.s.sol");
  assert.ok(ask > 0 && ask < forge, "the question comes before forge signs anything");
  for (const shown of ["$MC_CHAIN_ID", "0x4e59b44847b379578588920cA78FbF26c0B4956C", "$MC_EXPECT_FACTORY", "$MC_EXPECT_ROUTER", "$MC_EXPECT_LENS", "$MC_FEE_TO", "$MC_FIRST_DEPOSITOR"])
    assert.ok(script.slice(0, ask).includes(shown), `${shown} is shown before the question`);
  assert.match(script, /\[ "\$TYPED" = "\$CHAIN" \] \|\| \{ echo "stopped; nothing was sent" >&2; exit 1; \}/);
  assert.match(script, /\[ -t 0 \] \|\| \{ echo "broadcast to a public chain needs a terminal/);
  assert.match(script, /if \[ "\$MODE" = broadcast \] && \[ -z "\$REHEARSAL_RPC" \]; then/, "only a public-chain broadcast asks; a loopback rehearsal runs unattended");
});
