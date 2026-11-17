// The multichain kit's own tests (no RPC): configuration, plan, gate configuration, opcode set, command refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  CHAIN_DEPENDENT_OPCODES, FEE_PROOF_DOMAIN, PENDING, POST_PARIS_OPCODES, REFERENCE_FIRST_DEPOSITOR, addressesInDeployments, feeDelegationOn, REFERENCE_FIRST_DEPOSITOR_PREIMAGE, ROOT, ZERO_ADDRESS, checksummed, choicesFor, forgeEnvironment, loadArtifacts, loadChain, loadShared, lower,
  opcodesOf, pendingChoices, planChain, retrying, validateChain, validateRule, validateShared,
} from "./lib.mjs";
import { DONATION_BPS, MAX_TOLERANCE_BPS, MIN_OPENING_SHARES, addTransactions, giftWithinTolerance, hasStrictMinimums, openingAmounts, openingTransactions } from "./first-deposit.mjs";
import { checkDepositor, checkRecord, endpointVerdict, offlineProblems } from "./check-depositor.mjs";
import { chainIdsOf, feeProofMessage, loadFeeProof, signingPage, verifyFeeProof, verifySignature } from "./fee-proof.mjs";
import { STALE_GRACE_SECONDS, chainlinkPrice, combine, deviationBps, nativeFor, priceOf, readMarket, tokenFor, twapPrice } from "./market.mjs";
import { evaluateGate, gateConfig } from "./gate.mjs";
import { frontendNetwork, frontendRecord } from "./frontend-files.mjs";
import { LOCKED_SHARES, MINT_TOPIC, TRANSFER_TOPIC, openingFromReceipt, priceShiftBps, readOpening } from "./opening.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
/** An owner's depositing account for tests where the choices are made: a dedicated key, not the fee address. */
// A depositing account of the tests' own. Built at run time so that its address is written in no file: since review
// R369-5, check-depositor refuses an address that appears in any tracked file, and the earlier fixture
// (0x…0a11ce) is written in simulate-chain.mjs and test/AssetDeployment.t.sol as a stranger's account.
const OWNER_DEPOSITOR = viem.getAddress(`0x${"0".repeat(34)}${"de9051"}`);

const clone = (v) => JSON.parse(JSON.stringify(v));
// The committed configuration carries the owner's choices (the depositing account, no caps). Most tests below are
// about the rules themselves and use the same files WITH THOSE CHOICES OPEN (`shared`, `chains`: the reference
// rehearsal view); the tests of the committed choices use `committed` and `committedChains`.
const committed = loadShared();
const committedChains = committed.chains.map((key) => loadChain(key));
const shared = (() => {
  const open = clone(committed);
  open.firstDepositor = PENDING;
  delete open.firstDepositorCheck;
  return validateShared(open);
})();
const artifacts = loadArtifacts();
const chains = committedChains.map((chain) => validateChain({ ...clone(chain), reserveCaps: PENDING }, chain.chain.key));
const plans = chains.map((chain) => planChain(shared, chain, artifacts, { reference: true }));

test("the six chains are configured, each with its own chain id and genesis, and none is a Bloch L2 chain", () => {
  assert.deepEqual([...shared.chains].sort(), ["arbitrum-one", "base", "bnb-smart-chain", "ethereum", "linea", "op-mainnet"]);
  assert.deepEqual(chains.map((c) => c.chain.chainId).sort((a, b) => a - b), [1, 10, 56, 8453, 42161, 59144]);
  assert.equal(new Set(chains.map((c) => c.chain.genesisHash)).size, 6);
  for (const id of [700770, 700771, 31337]) {
    const bad = clone(chains[0]);
    bad.chain.chainId = id;
    assert.throws(() => validateChain(bad, bad.chain.key), /Bloch L2|local chain/);
  }
});

test("the fee recipient is the owner's address on every chain, EIP-55 exact, and never the zero address", () => {
  assert.equal(shared.feeTo.address, "0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544");
  for (const plan of plans) assert.equal(plan.arguments.feeTo, shared.feeTo.address);
  assert.throws(() => checksummed("0x775a993f09bd80aecf8f8c2ade0c84158e3a0544", "feeTo"), /EIP-55/);
  const zero = clone(shared);
  zero.feeTo.address = ZERO_ADDRESS;
  assert.throws(() => validateShared(zero), /zero address/);
});

test("every Bloch-L2-only rule is stated off, and a file that turns one on is refused", () => {
  assert.deepEqual(shared.l2Only, { bridgeTokenPin: false, safePin: false, newSlotFee: false, creditRule: false, idleChainRule: false });
  for (const rule of Object.keys(shared.l2Only)) {
    const on = clone(shared);
    on.l2Only[rule] = true;
    assert.throws(() => validateShared(on), /l2Only/);
  }
});

test("while owner choices are open (TBD-owner) a plan for a real deployment is refused", () => {
  for (const chain of chains) {
    assert.deepEqual(pendingChoices(shared, chain), ["deployments/multichain.json: firstDepositor", `deployments/${chain.chain.key}/chain.json: reserveCaps`]);
    assert.throws(() => planChain(shared, chain, artifacts), /owner choices are still open/);
    assert.equal(chain.openingPrice.rule, "market");
  }
  assert.ok(plans.every((p) => p.reference === true));
  // With the choices made the plan is no longer a reference plan.
  const decided = { ...clone(shared), firstDepositor: OWNER_DEPOSITOR };
  const chain = { ...clone(chains[0]), reserveCaps: [] };
  assert.equal(planChain(decided, chain, artifacts).reference, false);
  assert.equal(choicesFor(decided, chain).firstDepositor, OWNER_DEPOSITOR);
});

test("the pair init code hash is the release candidate's and the compiler settings are pinned", () => {
  for (const plan of plans) assert.equal(plan.pair.initCodeHash, "0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683");
  const other = clone(shared);
  other.source.compiler.evmVersion = "cancun";
  assert.throws(() => validateShared(other), /release candidate/);
  const toml = readFileSync(join(ROOT, "foundry.toml"), "utf8");
  for (const line of ['solc_version = "0.8.24"', 'evm_version = "paris"', "optimizer_runs = 200", 'bytecode_hash = "none"']) assert.ok(toml.includes(line), line);
});

test("with equal constructor arguments the factory and the lens have one address on all six chains; the router follows the wrapped native token", () => {
  assert.equal(new Set(plans.map((p) => p.contracts.factory.address)).size, 1);
  assert.equal(new Set(plans.map((p) => p.contracts.lens.address)).size, 1);
  const routerOf = Object.fromEntries(plans.map((p) => [p.chain.key, p.contracts.router.address]));
  assert.equal(routerOf["op-mainnet"], routerOf.base, "OP Mainnet and Base share the WETH predeploy address");
  assert.equal(new Set(Object.values(routerOf)).size, 5);
  // A cap names a token address, which differs per chain: the factory address then differs too.
  const capped = (chain) => planChain({ ...clone(shared), firstDepositor: OWNER_DEPOSITOR }, { ...clone(chain), reserveCaps: [{ token: chain.tokens[0].symbol, cap: "1000000" }] }, artifacts);
  assert.notEqual(capped(chains[0]).contracts.factory.address, capped(chains[2]).contracts.factory.address);
  assert.notEqual(capped(chains[0]).contracts.factory.address, plans[0].contracts.factory.address);
});

test("the plan's addresses are CREATE2 addresses of the deterministic deployer with the fixed salt, as the forge script computes them", () => {
  const script = readFileSync(join(ROOT, "script/DeployMultichain.s.sol"), "utf8");
  assert.ok(script.includes(`CREATE2_DEPLOYER = ${shared.create2.deployer}`));
  assert.ok(script.includes(`SALT = ${shared.create2.salt}`));
  assert.ok(script.includes(shared.create2.deployerCodeHash));
  assert.ok(script.includes(`PAIR_INIT_CODE_HASH = ${shared.source.pairInitCodeHash}`));
  for (const plan of plans)
    for (const c of Object.values(plan.contracts)) {
      assert.equal(lower(c.transaction.to), lower(shared.create2.deployer));
      assert.ok(c.transaction.data.startsWith(shared.create2.salt));
      assert.ok(c.runtimeBytes <= 24_576, `${c.name} runtime is within EIP-170`);
      assert.ok(c.initCodeBytes <= 49_152, `${c.name} init code is within EIP-3860`);
    }
});

test("the forge environment carries the plan and creates no pair (the first deposit creates it)", () => {
  const chain = chains.find((c) => c.chain.key === "base");
  const plan = plans.find((p) => p.chain.key === "base");
  const env = forgeEnvironment(plan, chain);
  assert.equal(env.MC_CHAIN_ID, "8453");
  assert.equal(env.MC_FEE_TO, shared.feeTo.address);
  assert.equal(env.MC_WRAPPED, "0x4200000000000000000000000000000000000006");
  assert.equal(env.MC_PAIR_TOKENS, undefined);
  assert.equal(env.MC_FIRST_DEPOSITOR, REFERENCE_FIRST_DEPOSITOR);
  assert.equal(forgeEnvironment(plan, chain, { createPairs: true }).MC_PAIR_TOKENS, chain.tokens[0].address);
  assert.equal(env.MC_CAP_TOKENS, undefined);
});

test("the deployed code uses no opcode newer than the Paris target, and only these chain-dependent ones", () => {
  const used = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    for (const code of [artifact.deployedBytecode, artifact.bytecode]) {
      const ops = opcodesOf(code);
      for (const [op, label] of Object.entries(POST_PARIS_OPCODES)) assert.ok(!ops.has(Number(op)), `${name} contains ${label}`);
    }
    used[name] = Object.entries(CHAIN_DEPENDENT_OPCODES).filter(([op]) => opcodesOf(artifact.deployedBytecode).has(Number(op))).map(([, label]) => label).sort();
  }
  // TIMESTAMP: deadlines, the price accumulators, the lens's quote time. CHAINID: the LP token's permit domain.
  // ORIGIN: the pair's first-deposit rule (msg.sender or tx.origin is the first depositor, so the router can be
  // used). NUMBER and BLOCKHASH: the router's anchored swaps (not usable with L2 block hashes on Arbitrum One) and
  // the lens's block number. The factory's runtime embeds the pair's creation code, hence the same set.
  assert.deepEqual(used, { factory: ["CHAINID", "ORIGIN", "TIMESTAMP"], router: ["BLOCKHASH", "NUMBER", "TIMESTAMP"], lens: ["NUMBER", "TIMESTAMP"], pair: ["CHAINID", "ORIGIN", "TIMESTAMP"] });
});

test("the committed gate configuration of each chain is the generated one", () => {
  for (const chain of committedChains) {
    const file = JSON.parse(readFileSync(join(ROOT, "deployments", chain.chain.key, "gate.json"), "utf8"));
    assert.deepEqual(file, JSON.parse(JSON.stringify(gateConfig(committed, chain))));
    assert.equal(file.readAt, "finalized");
    assert.ok(Object.values(file.l2Only).every((v) => v === false));
  }
});

test("each chain lists two https endpoints, the wrapped native token and one token, each with a source", () => {
  for (const chain of chains) {
    assert.ok(chain.rpc.length >= 2 && chain.rpc.every((u) => u.startsWith("https://")));
    assert.equal(chain.tokens.length, 1);
    for (const t of [chain.wrappedNative, ...chain.tokens]) {
      assert.ok(t.source.length > 10 && t.kind.length > 5);
      // The address was compared with the issuer's or the chain's own page, fetched on the date stated.
      assert.equal(t.sourceChecked.url, t.source);
      assert.match(t.sourceChecked.fetched, /^2026-\d\d-\d\d$/);
      assert.ok(t.sourceChecked.found.length > 10);
    }
  }
  const bnb = chains.find((c) => c.chain.key === "bnb-smart-chain");
  assert.match(bnb.tokens[0].kind, /NOT Circle-issued/);
  assert.equal(bnb.tokens[0].decimals, 18);
});

test("the commands refuse what must never happen", () => {
  const run = (...args) => spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: "utf8" });
  const broadcastReference = run("bash", "scripts/multichain/deploy.sh", "base", "broadcast", "--reference");
  assert.equal(broadcastReference.status, 2);
  assert.match(broadcastReference.stderr, /never broadcast to a public chain/);
  const notLoopback = run("bash", "scripts/multichain/deploy.sh", "base", "broadcast", "--rehearsal-rpc", "https://mainnet.base.org", "--reference");
  assert.equal(notLoopback.status, 2);
  assert.match(notLoopback.stderr, /loopback/);
  const ownFlags = run("bash", "scripts/multichain/deploy.sh", "base", "dry-run", "--reference", "--", "--broadcast");
  assert.equal(ownFlags.status, 2);
  const gateRpc = run("node", "scripts/multichain/gate.mjs", "base", "post", "--rpc", "https://example.org");
  assert.equal(gateRpc.status, 2);
  assert.match(gateRpc.stderr, /rehearsal/);
  const unknown = run("node", "scripts/multichain/plan.mjs", "bloch-l2");
  assert.equal(unknown.status, 2);
  // The deposit tool has no option for other minimums, needs the gate report, and refuses a reference plan
  // outside a rehearsal.
  const deposit = (...a) => run("node", "scripts/multichain/first-deposit.mjs", "base", ...a);
  const loose = deposit("prepare", "--pair", "WETH/USDC", "--native", "10", "--token", "30000", "--gate-report", "x.json", "--min-token", "0");
  assert.equal(loose.status, 2);
  assert.match(loose.stderr, /no option for other minimums/);
  const noReport = deposit("prepare", "--pair", "WETH/USDC", "--native", "10", "--token", "30000");
  assert.equal(noReport.status, 2);
  assert.match(noReport.stderr, /--gate-report FILE is required/);
  // prepare needs the amount of one side; verify and add need both.
  const noAmount = deposit("prepare", "--pair", "WETH/USDC", "--gate-report", "x.json");
  assert.equal(noAmount.status, 2);
  assert.match(noAmount.stderr, /usage:/);
  const oneSideVerify = deposit("verify", "--pair", "WETH/USDC", "--native", "10", "--tx", `0x${"00".repeat(32)}`);
  assert.equal(oneSideVerify.status, 2);
  assert.match(oneSideVerify.stderr, /--token AMOUNT is required/);
  // check-depositor takes an address, never a key; fee-proof refuses a signature that is not one, offline.
  const key = run("node", "scripts/multichain/check-depositor.mjs", `0x${"11".repeat(32)}`);
  assert.equal(key.status, 2);
  assert.match(key.stderr, /Never give this tool, or any tool, the key/);
  const badSignature = run("node", "scripts/multichain/fee-proof.mjs", "record", "--signature", `0x${"00".repeat(65)}`);
  assert.equal(badSignature.status, 1);
  assert.match(badSignature.stdout, /nothing was written/);
  assert.equal(run("node", "scripts/multichain/market.mjs", "base", "--rpc", "https://example.org").status, 2);
});

test("R309-MC-4: a tool started through a symbolic link runs; it does not do nothing and exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-link-"));
  try {
    symlinkSync(ROOT, join(dir, "repo"), "dir");
    for (const [tool, args] of [["gate.mjs", ["base"]], ["frontend-files.mjs", []], ["first-deposit.mjs", ["base"]]]) {
      const run = spawnSync("node", [join(dir, "repo/scripts/multichain", tool), ...args], { encoding: "utf8" });
      assert.equal(run.status, 2, tool);
      assert.match(run.stderr, /usage:/, tool);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R309-MC-1, R328-1: no plan has open first deposits, and none has the fee address as its depositing account", () => {
  const zero = { ...clone(shared), firstDepositor: ZERO_ADDRESS };
  assert.throws(() => validateShared(zero), /first deposits would be open to anyone/);
  for (const chain of chains) {
    assert.throws(() => planChain(zero, { ...clone(chain), reserveCaps: [] }, artifacts), /first deposits would be open/);
    assert.throws(() => planChain(zero, chain, artifacts, { reference: true }), /first deposits would be open/);
  }
  // The reference plan's depositing account is an address nobody holds a key for, derived from a fixed text.
  assert.equal(REFERENCE_FIRST_DEPOSITOR, viem.getAddress(`0x${viem.keccak256(viem.stringToHex(REFERENCE_FIRST_DEPOSITOR_PREIMAGE)).slice(26)}`));
  for (const plan of plans) {
    assert.equal(plan.arguments.firstDepositor, REFERENCE_FIRST_DEPOSITOR);
    assert.notEqual(lower(plan.arguments.firstDepositor), ZERO_ADDRESS);
    assert.notEqual(lower(plan.arguments.firstDepositor), lower(shared.feeTo.address));
  }
  // Review R328-1: the pair accepts a first mint by transaction origin, so the depositing account is a dedicated
  // key: the fee address (a wallet in use) is refused by the configuration, by a caller's own object, and by the
  // forge script; the reference address cannot be chosen for a real plan.
  const feeAsDepositor = { ...clone(shared), firstDepositor: shared.feeTo.address };
  assert.throws(() => validateShared(feeAsDepositor), /firstDepositor is the fee address/);
  assert.throws(() => planChain(feeAsDepositor, { ...clone(chains[0]), reserveCaps: [] }, artifacts), /firstDepositor is the fee address/);
  assert.throws(() => validateShared({ ...clone(shared), firstDepositor: REFERENCE_FIRST_DEPOSITOR }), /nobody holds its key/);
  assert.ok(readFileSync(join(ROOT, "script/DeployMultichain.s.sol"), "utf8").includes('require(firstDepositor != feeTo, "MC: FIRST_DEPOSITOR_IS_FEE_TO")'));
  assert.throws(() => validateShared({ ...clone(shared), firstDepositor: shared.create2.deployer }), /not an account/);
  const script = readFileSync(join(ROOT, "script/DeployMultichain.s.sol"), "utf8");
  assert.ok(script.includes('require(firstDepositor != address(0), "MC: FIRST_DEPOSITOR")'));
});

test("R309-MC-1: the first deposit's minimums equal its amounts, and a later deposit's are at most 1% below", async () => {
  const require = (await import("node:module")).createRequire(new URL("../../frontend/package.json", import.meta.url));
  const { decodeFunctionData, parseAbi } = require("viem");
  const abi = parseAbi(["function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)", "function approve(address,uint256) returns (bool)"]);
  const chain = chains.find((c) => c.chain.key === "base");
  const plan = plans.find((p) => p.chain.key === "base");
  const base = { router: plan.contracts.router.address, token: chain.tokens[0].address, to: shared.feeTo.address, deadline: 2_000_000_000n };
  const [approve, deposit] = openingTransactions({ ...base, native: 10n ** 19n, tokenAmount: 30_000_000_000n });
  assert.deepEqual(decodeFunctionData({ abi, data: approve.data }).args, [base.router, 30_000_000_000n]);
  const args = decodeFunctionData({ abi, data: deposit.data }).args;
  assert.deepEqual(args, [base.token, 30_000_000_000n, 30_000_000_000n, 10n ** 19n, base.to, 2_000_000_000n]);
  assert.equal(deposit.value, 10n ** 19n);
  assert.equal(lower(deposit.to), lower(base.router));
  assert.equal(hasStrictMinimums(deposit.data, deposit.value), true);
  // The reviewer's step 5 ("the minimums as the owner chooses": 0 and 0) is not a strict deposit.
  const { encodeFunctionData } = require("viem");
  const looseData = encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [base.token, 30_000_000_000n, 0n, 0n, base.to, 2_000_000_000n] });
  assert.equal(hasStrictMinimums(looseData, 10n ** 19n), false);
  assert.equal(hasStrictMinimums(deposit.data, 1n), false);
  assert.throws(() => openingTransactions({ ...base, native: 0n, tokenAmount: 1n }), /above zero/);
  // A later deposit: the owner states both amounts; 1 native at a pool of 10 : 30,000 is 3,000 token; minimums 0.5% below.
  const later = { ...base, native: 10n ** 18n, expectedToken: 3_000_000_000n, reserveNative: 10n ** 19n, reserveToken: 30_000_000_000n, toleranceBps: 50 };
  const [, add] = addTransactions(later);
  assert.deepEqual(decodeFunctionData({ abi, data: add.data }).args.slice(1, 4), [3_000_000_000n, 2_985_000_000n, 995n * 10n ** 15n]);
  assert.equal(MAX_TOLERANCE_BPS, 100);
  assert.throws(() => addTransactions({ ...later, toleranceBps: 101 }), /tolerance/);
  assert.throws(() => addTransactions({ ...later, reserveNative: 0n, reserveToken: 0n }), /not open/);
  // Review R328-1: the pool's own price is not trusted. The reviewer's pool (1 native = 2 token, opened by a
  // contract the depositing account called): 10 native would be paired with 20 token. Refused, as is a pool 5%
  // away from the owner's amounts; without the owner's token amount nothing is printed at all.
  const hostile = { ...base, native: 10n ** 19n, expectedToken: 30_000_000_000n, reserveNative: 10n ** 12n, reserveToken: 2n, toleranceBps: 50 };
  assert.throws(() => addTransactions(hostile), /the pool's price is not the price of the amounts given/);
  assert.throws(() => addTransactions({ ...later, reserveToken: 31_500_000_000n }), /pool's price is not/);
  assert.throws(() => addTransactions({ ...later, reserveToken: 28_500_000_000n }), /pool's price is not/);
  assert.throws(() => addTransactions({ ...later, expectedToken: undefined }), /--token/);
  // Inside the tolerance the deposit follows the pool: 0.4% above the owner's amount.
  const [, near] = addTransactions({ ...later, reserveToken: 30_120_000_000n });
  assert.deepEqual(decodeFunctionData({ abi, data: near.data }).args.slice(1, 3), [3_012_000_000n, 2_996_940_000n]);
  // Review R328-3: what sits at the pair's address before the first deposit is tolerated up to 0.1% of a side.
  const opening = { native: 10n ** 19n, token: 30_000_000_000n };
  assert.equal(DONATION_BPS, 10n);
  assert.equal(giftWithinTolerance({ native: 0n, token: 1n }, opening), true);
  assert.equal(giftWithinTolerance({ native: 10n ** 16n, token: 30_000_000n }, opening), true);
  assert.equal(giftWithinTolerance({ native: 0n, token: 30_000_001n }, opening), false);
  assert.equal(giftWithinTolerance({ native: 10n ** 16n + 1n, token: 0n }, opening), false);
});

/** A first deposit as first-deposit.mjs prints it, and the receipt the pair gives it. Overridable field by field. */
function openingFixture({ pair, router, depositor, token, wrappedIs0, native = 10n ** 19n, tokenAmount = 30_000_000_000n, gift = { native: 0n, token: 0n }, over = {} }) {
  const abi = viem.parseAbi(["function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)"]);
  const word = (n) => n.toString(16).padStart(64, "0");
  const topic = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  const zero = `0x${"0".repeat(64)}`;
  const joined = { native: native + gift.native, token: tokenAmount + gift.token };
  const [amount0, amount1] = wrappedIs0 ? [joined.native, joined.token] : [joined.token, joined.native];
  const hash = `0x${"0e".repeat(32)}`;
  const tx = { hash, from: depositor, to: router, value: `0x${native.toString(16)}`, input: viem.encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [token, tokenAmount, tokenAmount, native, depositor, 2_000_000_000n] }), ...over.tx };
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockNumber: "0x60",
    blockHash: `0x${"ab".repeat(32)}`,
    logs: [
      { address: pair, topics: [TRANSFER_TOPIC, zero, zero], data: `0x${word(LOCKED_SHARES)}` },
      { address: pair, topics: [TRANSFER_TOPIC, zero, topic(depositor)], data: `0x${word(10n ** 12n)}` },
      { address: pair, topics: [MINT_TOPIC, topic(router)], data: `0x${word(amount0)}${word(amount1)}` },
    ],
    ...over.receipt,
  };
  return { hash, tx, receipt };
}

test("R328-1: an opening is proven only by the pair's first mint, sent by the first depositor straight to the router with strict minimums", async () => {
  const chain = chains.find((c) => c.chain.key === "base");
  const plan = plans.find((p) => p.chain.key === "base");
  const pair = plan.pairs[0];
  const wrappedIs0 = lower(pair.token0) === lower(chain.wrappedNative.address);
  const facts = { pair: pair.address, router: plan.contracts.router.address, depositor: plan.arguments.firstDepositor, token: chain.tokens[0].address, wrappedIs0 };
  const good = openingFixture(facts);
  const proof = openingFromReceipt({ ...good, ...facts });
  assert.deepEqual([proof.proven, proof.problems], [true, []]);
  assert.deepEqual([proof.deposited, proof.joined, proof.gift], [{ native: 10n ** 19n, token: 30_000_000_000n }, { native: 10n ** 19n, token: 30_000_000_000n }, { native: 0n, token: 0n }]);
  assert.equal(priceShiftBps(proof), 0n);
  const refused = (over, pattern) => {
    const p = openingFromReceipt({ ...openingFixture({ ...facts, over }), ...facts });
    assert.equal(p.proven, false);
    assert.match(p.problems.join("; "), pattern);
  };
  // The reviewer's scenario: the depositing account called another contract, which made the first mint. The
  // transaction's origin is the depositor, so the pair accepted it; it was not sent to the router.
  const HOSTILE = "0x00000000000000000000000000000000000bad00";
  refused({ tx: { to: HOSTILE, input: "0x4e71d92d" } }, /not to the router.*opened through another contract; it is not the router's addLiquidityBLCH/);
  refused({ tx: { from: HOSTILE } }, /not by the first depositor/);
  refused({ receipt: { status: "0x0" } }, /did not succeed/);
  // The call of review R309-MC-1's step 5: minimums of the owner's choosing.
  const abi = viem.parseAbi(["function addLiquidityBLCH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountBLCHMin,address to,uint256 deadline) payable returns (uint256,uint256,uint256)"]);
  refused({ tx: { input: viem.encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [facts.token, 30_000_000_000n, 0n, 0n, facts.depositor, 2_000_000_000n] }) } }, /minimums are not equal/);
  refused({ tx: { input: viem.encodeFunctionData({ abi, functionName: "addLiquidityBLCH", args: [HOSTILE, 30_000_000_000n, 30_000_000_000n, 10n ** 19n, facts.depositor, 2_000_000_000n] }) } }, /deposits the token/);
  // A later deposit (no lock of the minimum liquidity) is not the opening, whoever sent it.
  refused({ receipt: { logs: good.receipt.logs.slice(1) } }, /not the pair's first mint/);
  // The lock and the Mint must be the planned pair's own logs.
  refused({ receipt: { logs: good.receipt.logs.map((l) => ({ ...l, address: HOSTILE })) } }, /not the pair's first mint.*exactly one Mint/);
  // Review R328-2: tokens at the pair's address before the deposit join the pool; the proof states them.
  const gifted = openingFromReceipt({ ...openingFixture({ ...facts, gift: { native: 0n, token: 300_000_000n } }), ...facts });
  assert.equal(gifted.proven, true);
  assert.deepEqual(gifted.gift, { native: 0n, token: 300_000_000n });
  assert.equal(priceShiftBps(gifted), 100n);
  // Against a chain: the block must be the chain's, on every endpoint, and not above the finalized block.
  const node = (blockHash = good.receipt.blockHash) => async (method) => (method === "eth_getTransactionByHash" ? good.tx : method === "eth_getTransactionReceipt" ? good.receipt : { number: "0x60", hash: blockHash });
  assert.equal((await readOpening({ request: node(), others: [node()], hash: good.hash, finalizedNumber: 100, ...facts })).proven, true);
  assert.match((await readOpening({ request: node(), others: [node(`0x${"cd".repeat(32)}`)], hash: good.hash, ...facts })).problems.join(), /another endpoint has a different block/);
  assert.match((await readOpening({ request: node(`0x${"cd".repeat(32)}`), hash: good.hash, ...facts })).problems.join(), /not the chain's block/);
  assert.match((await readOpening({ request: node(), hash: good.hash, finalizedNumber: 50, ...facts })).problems.join(), /above the finalized block 50: wait/);
  assert.match((await readOpening({ request: async () => null, hash: good.hash, ...facts })).problems.join(), /not found/);
  assert.equal((await readOpening({ request: node(), hash: "0x12", ...facts })).proven, false);
});

test("R309-MC-2: every chain states its confirmation rule, what was measured and the residual risk; the network file carries the rule and the deadline", () => {
  const rules = Object.fromEntries(chains.map((c) => [c.chain.key, [c.confirmation.settle, c.confirmation.strict]]));
  assert.deepEqual(rules, {
    "op-mainnet": [{ depth: 5 }, { tag: "finalized" }],
    base: [{ depth: 50 }, { tag: "finalized" }],
    "arbitrum-one": [{ depth: 32 }, { tag: "finalized" }],
    linea: [{ depth: 1 }, { depth: 300 }],
    "bnb-smart-chain": [{ tag: "finalized" }, { tag: "finalized" }],
    ethereum: [{ depth: 2 }, { tag: "finalized" }],
  });
  for (const chain of chains) {
    assert.ok(chain.confirmation.residualRisk.length > 40);
    assert.match(chain.confirmation.measured.at, /^2026-/);
    const file = frontendNetwork(shared, chain);
    assert.deepEqual(file.confirmation, { settle: chain.confirmation.settle, strict: chain.confirmation.strict, ...(chain.confirmation.reverted ? { reverted: chain.confirmation.reverted } : {}), blockSeconds: chain.confirmation.measured.blockSeconds });
    // Review R328-3P-3: the rule that settles a reverted swap lies between the two, and says why it is enough.
    if (chain.chain.key !== "bnb-smart-chain") assert.ok(chain.confirmation.reverted && chain.confirmation.revertedWhy.length >= 40, chain.chain.key);
    const early = clone(chain);
    early.confirmation.reverted = { depth: 1 };
    if (chain.chain.key === "ethereum") assert.throws(() => validateChain(early, early.chain.key), /between confirmation.settle and confirmation.strict/);
    assert.deepEqual(file.swap, { deadlineMinutes: 20 });
    // A settle depth is seconds, not minutes: at most 30 s at the measured block time.
    if ("depth" in chain.confirmation.settle) assert.ok(chain.confirmation.settle.depth * chain.confirmation.measured.blockSeconds <= 30, chain.chain.key);
    const none = clone(chain);
    delete none.confirmation;
    assert.throws(() => validateChain(none, none.chain.key), /confirmation rule is required/);
    const weak = clone(chain);
    weak.confirmation.settle = { depth: 50 };
    weak.confirmation.strict = { depth: 10 };
    assert.throws(() => validateChain(weak, weak.chain.key), /weaker/);
    const slow = clone(chain);
    slow.swap.deadlineMinutes = 90;
    assert.throws(() => validateChain(slow, slow.chain.key), /deadlineMinutes/);
  }
  assert.throws(() => validateRule({ tag: "latest" }, "x"), /finalized or safe/);
  assert.throws(() => validateRule({ depth: 0 }, "x"), /whole number of blocks/);
  assert.throws(() => validateRule({ depth: 1, tag: "safe" }, "x"), /must be/);
});

test("the committed frontend files of each chain are the generated ones, and no chain is recorded as deployed", () => {
  for (const chain of committedChains) {
    const dir = join(ROOT, "deployments", chain.chain.key);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "frontend.network.json"), "utf8")), JSON.parse(JSON.stringify(frontendNetwork(shared, chain))));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "frontend.record.json"), "utf8")), frontendRecord(shared, chain));
    assert.equal(frontendRecord(shared, chain).status, "not-deployed");
  }
});

test("the gate passes a correct chain, reports an EIP-7702 fee address, and fails on a wrong genesis, wrong code or a contract as fee address", async () => {
  const require = (await import("node:module")).createRequire(new URL("../../frontend/package.json", import.meta.url));
  const { keccak256, encodeFunctionResult, parseAbi, toFunctionSelector, toHex } = require("viem");
  const chain = JSON.parse(JSON.stringify(chains.find((c) => c.chain.key === "base")));
  const local = JSON.parse(JSON.stringify(shared));
  // Stand-in runtime codes; their hashes become the pins of this test's copy of the configuration.
  const code = (label) => toHex(`code:${label}`);
  local.create2.deployerCodeHash = keccak256(code("deployer"));
  chain.wrappedNative.codeHash = keccak256(code("wrapped"));
  chain.tokens[0].codeHash = keccak256(code("token"));
  chain.multicall3.codeHash = keccak256(code("multicall"));
  const plan = planChain(local, chain, artifacts, { reference: true });
  const abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)"]);
  const names = Object.fromEntries(abi.map((f) => [toFunctionSelector(f), f.name]));
  const world = (over = {}) => {
    const o = { genesis: chain.chain.genesisHash, feeCode: "0x", tokenCode: code("token"), ...over };
    const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.wrappedNative.address), code("wrapped")], [lower(chain.tokens[0].address), o.tokenCode], [lower(chain.multicall3.address), code("multicall")], [lower(local.feeTo.address), o.feeCode]]);
    if (o.depositorCode) codes.set(lower(plan.arguments.firstDepositor), o.depositorCode);
    return async (method, params) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: o.genesis } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
      if (method === "eth_getCode") return codes.get(lower(params[0])) ?? "0x";
      if (method === "eth_getTransactionCount") return o.depositorNonce ?? "0x0";
      if (method === "eth_call") {
        const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === lower(params[0].to));
        const fn = names[params[0].data.slice(0, 10)];
        if (fn === "getChainId") return encodeFunctionResult({ abi, functionName: fn, result: 8453n });
        return encodeFunctionResult({ abi, functionName: fn, result: fn === "decimals" ? token.decimals : token[fn] });
      }
      throw new Error(`unexpected ${method}`);
    };
  };
  // A public-chain pre gate needs the owner's proof of control of the fee address; here it is given as valid (its
  // own test is below).
  const gate = (request, feeProof = { valid: true, problems: [] }) => evaluateGate({ shared: local, chain, plan, phase: "pre", request, feeProof });
  const pass = await gate(world());
  assert.equal(pass.decision, "pass", JSON.stringify(pass.failed));
  assert.equal(pass.feeTo.code, "none");
  assert.equal(pass.finalized.number, 100);
  // An EIP-7702 delegation to a delegate nobody identified fails the gate (decision of 2026-11-17).
  const delegated = await gate(world({ feeCode: `0xef0100${"63".repeat(20)}` }));
  assert.equal(delegated.decision, "fail");
  assert.match(delegated.failed.join(), /identified delegate/);
  assert.deepEqual([delegated.feeTo.code, delegated.feeTo.delegate, delegated.feeTo.delegateName], ["EIP-7702 delegation", `0x${"63".repeat(20)}`, null]);
  // Without the owner's proof of control the pre gate of a public chain fails; a rehearsal does not need it.
  const noProof = await gate(world(), null);
  assert.equal(noProof.decision, "fail");
  assert.match(noProof.failed.join(), /signed proof of control of the fee address/);
  assert.equal(noProof.feeTo.proofOfControl, "missing or not valid");
  const rehearsed = await evaluateGate({ shared: local, chain, plan, phase: "pre", request: world(), rehearsal: true });
  assert.equal(rehearsed.decision, "pass", JSON.stringify(rehearsed.failed));
  assert.equal(rehearsed.feeTo.proofOfControl, "not required (rehearsal)");
  const contractFee = await gate(world({ feeCode: "0x6080604052" }));
  assert.equal(contractFee.decision, "fail");
  assert.match(contractFee.failed.join(), /externally owned account/);
  // Review R328-1: the depositing account is a plain, new key account. Code at it, an EIP-7702 delegation (which
  // the fee address may carry) or earlier transactions on the chain fail the pre gate.
  assert.deepEqual(pass.firstDepositor, { address: plan.arguments.firstDepositor, code: "none", transactions: 0 });
  const delegatedDepositor = await gate(world({ depositorCode: `0xef0100${"63".repeat(20)}` }));
  assert.equal(delegatedDepositor.decision, "fail");
  assert.match(delegatedDepositor.failed.join(), /depositing account has no code and no EIP-7702 delegation/);
  assert.equal(delegatedDepositor.firstDepositor.code, "EIP-7702 delegation");
  const usedDepositor = await gate(world({ depositorNonce: "0x7" }));
  assert.equal(usedDepositor.decision, "fail");
  assert.match(usedDepositor.failed.join(), /never sent a transaction on this chain/);
  assert.equal(usedDepositor.firstDepositor.transactions, 7);
  const otherChain = await gate(world({ genesis: `0x${"11".repeat(32)}` }));
  assert.match(otherChain.failed.join(), /pinned genesis/);
  const otherToken = await gate(world({ tokenCode: code("another token") }));
  assert.match(otherToken.failed.join(), /USDC at .* holds the pinned code/);
  // The post gate fails while nothing is deployed.
  const post = await evaluateGate({ shared: local, chain, plan, phase: "post", request: world() });
  assert.equal(post.decision, "fail");
  assert.match(post.failed.join(), /factory .* holds the planned code at the finalized block/);
  assert.deepEqual(post.waiting, []);
  assert.throws(() => frontendRecord(local, chain, post), /not a passed post gate/);
});

test("the post gate reports each pair's state; the record needs every pair open; 'not finalized yet' is reported as WAIT", async () => {
  const require = (await import("node:module")).createRequire(new URL("../../frontend/package.json", import.meta.url));
  const { keccak256, encodeFunctionResult, decodeFunctionData, parseAbi, toHex } = require("viem");
  const chain = clone(chains.find((c) => c.chain.key === "base"));
  const local = clone(shared);
  const code = (label) => toHex(`code:${label}`);
  local.create2.deployerCodeHash = keccak256(code("deployer"));
  chain.wrappedNative.codeHash = keccak256(code("wrapped"));
  chain.tokens[0].codeHash = keccak256(code("token"));
  chain.multicall3.codeHash = keccak256(code("multicall"));
  const plan = planChain(local, chain, artifacts, { reference: true });
  const pair = plan.pairs[0];
  const abi = parseAbi([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)",
    "function feeTo() view returns (address)", "function firstDepositor() view returns (address)", "function reserveCap(address) view returns (uint256)", "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
    "function getPair(address,address) view returns (address)", "function factory() view returns (address)", "function WBLCH() view returns (address)", "function token0() view returns (address)",
    "function token1() view returns (address)", "function reserveCaps() view returns (uint112,uint112)", "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint112,uint112,uint32)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  // Runtime codes whose hashes are the plan's: the gate compares hashes, so the test serves the linked runtimes.
  const { linkImmutables } = await import("./lib.mjs");
  const word = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const runtime = {
    [lower(plan.contracts.factory.address)]: linkImmutables(artifacts.factory, [word(local.feeTo.address), word(plan.arguments.firstDepositor)], "factory"),
    [lower(plan.contracts.router.address)]: linkImmutables(artifacts.router, [word(plan.contracts.factory.address), word(chain.wrappedNative.address)], "router"),
    [lower(plan.contracts.lens.address)]: linkImmutables(artifacts.lens, [word(plan.contracts.factory.address)], "lens"),
  };
  const wrappedIs0 = lower(pair.token0) === lower(chain.wrappedNative.address);
  const facts = { pair: pair.address, router: plan.contracts.router.address, depositor: plan.arguments.firstDepositor, token: chain.tokens[0].address, wrappedIs0 };
  const opened = openingFixture(facts);
  // state: "absent" | "empty" | "donated" | "open"; finalizedHasCode: false = deployed but not finalized yet;
  // opening: the transaction and receipt the node has for the opening hash.
  const world = ({ state = "absent", finalizedHasCode = true, opening = opened } = {}) => {
    const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.wrappedNative.address), code("wrapped")], [lower(chain.tokens[0].address), code("token")], [lower(chain.multicall3.address), code("multicall")]]);
    const created = state !== "absent";
    return async (method, params) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
      if (method === "eth_getTransactionCount") return "0x2";
      if (method === "eth_getTransactionByHash") return params[0] === opening.hash ? opening.tx : null;
      if (method === "eth_getTransactionReceipt") return params[0] === opening.hash ? opening.receipt : null;
      if (method === "eth_getCode") {
        const address = lower(params[0]);
        if (runtime[address]) return finalizedHasCode || params[1] === "latest" ? runtime[address] : "0x";
        if (address === lower(pair.address)) return created ? artifacts.pair.deployedBytecode : "0x";
        return codes.get(address) ?? "0x";
      }
      if (method === "eth_call") {
        const to = lower(params[0].to);
        const { functionName: fn, args } = decodeFunctionData({ abi, data: params[0].data });
        const out = (result) => encodeFunctionResult({ abi, functionName: fn, result });
        const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === to);
        if (fn === "balanceOf") return out(state === "donated" ? 5n : state === "open" ? 1000n : 0n);
        if (token) return out(fn === "decimals" ? token.decimals : token[fn]);
        if (fn === "getChainId") return out(8453n);
        if (fn === "feeTo") return out(local.feeTo.address);
        if (fn === "firstDepositor") return out(plan.arguments.firstDepositor);
        if (fn === "reserveCap") return out(0n);
        if (fn === "INIT_CODE_PAIR_HASH") return out(plan.pair.initCodeHash);
        if (fn === "getPair") return out(created ? pair.address : ZERO_ADDRESS);
        if (fn === "factory") return out(plan.contracts.factory.address);
        if (fn === "WBLCH") return out(chain.wrappedNative.address);
        if (fn === "token0") return out(pair.token0);
        if (fn === "token1") return out(pair.token1);
        if (fn === "reserveCaps") return out([0n, 0n]);
        if (fn === "totalSupply") return out(state === "open" ? 10n ** 12n : 0n);
        if (fn === "getReserves") return out(state === "open" ? [1000n, 1000n, 1] : [0n, 0n, 0]);
        void args;
      }
      throw new Error(`unexpected ${method}`);
    };
  };
  const name = `${pair.tokenA}/${pair.tokenB}`;
  const gate = (options, openings = { [name]: opened.hash }) => evaluateGate({ shared: local, chain, plan, phase: "post", request: world(options), rehearsal: true, openings });
  for (const state of ["absent", "empty", "donated", "open"]) {
    const report = await gate({ state });
    assert.equal(report.decision, "pass", `${state}: ${JSON.stringify(report.failed)}`);
    assert.equal(report.pairs[0].state, state);
    assert.equal(report.pairs[0].created, state !== "absent");
    if (state === "open") {
      assert.deepEqual([report.pairs[0].totalSupply, report.pairs[0].reserves], ["1000000000000", ["1000", "1000"]]);
      const record = frontendRecord(local, chain, report, { rehearsal: true });
      assert.equal(record.status, "deployed");
      assert.equal(record.firstDepositor, lower(REFERENCE_FIRST_DEPOSITOR));
      assert.equal(record.pairs.length, 1);
      // The proof of the opening is in the report, with what joined the pool.
      assert.deepEqual([report.pairs[0].opening.proven, report.pairs[0].opening.transaction, report.pairs[0].opening.joined, report.pairs[0].opening.priceShiftBps], [true, opened.hash, { native: "10000000000000000000", token: "30000000000" }, 0]);
    } else assert.throws(() => frontendRecord(local, chain, report, { rehearsal: true }), state === "absent" ? /does not show every planned pair created/ : /not open yet/);
  }
  // Review R328-1: "open" is not "opened by the owner". An open pool without its opening transaction fails the
  // gate, and so does the reviewer's pool: opened inside a transaction the depositing account sent to another
  // contract (the pair accepts the origin). No record can be written from either report.
  const unproven = await gate({ state: "open" }, {});
  assert.equal(unproven.decision, "fail");
  assert.match(unproven.failed.join(), /its opening is proven by its transaction.*STOP: someone else opened it/);
  assert.equal(unproven.pairs[0].opening.proven, false);
  assert.throws(() => frontendRecord(local, chain, unproven, { rehearsal: true }), /not a passed post gate/);
  const hostile = openingFixture({ ...facts, over: { tx: { to: "0x00000000000000000000000000000000000bad00", input: "0x4e71d92d" } } });
  const stolen = await gate({ state: "open", opening: hostile });
  assert.equal(stolen.decision, "fail");
  assert.match(stolen.failed.join(), /was opened by the first depositor's own deposit, sent straight to the router/);
  assert.match(stolen.pairs[0].opening.problems.join(), /opened through another contract/);
  // A hash the node does not know proves nothing; and a report edited to "pass" still needs the proof.
  assert.equal((await gate({ state: "open" }, { [name]: `0x${"77".repeat(32)}` })).decision, "fail");
  const edited = clone(await gate({ state: "open" }));
  edited.pairs[0].opening.proven = false;
  assert.throws(() => frontendRecord(local, chain, edited, { rehearsal: true }), /does not prove who opened each pool/);
  // A gift at the opening (review R328-2) is reported, with the price it moved; the gate still passes.
  const gifted = await gate({ state: "open", opening: openingFixture({ ...facts, gift: { native: 0n, token: 300_000_000n } }) });
  assert.equal(gifted.decision, "pass");
  assert.deepEqual([gifted.pairs[0].opening.gift, gifted.pairs[0].opening.priceShiftBps], [{ native: "0", token: "300000000" }, 100]);
  // Review R309-MC-5: deployed, not finalized yet: the gate fails and says WAIT for the three contracts.
  const early = await gate({ finalizedHasCode: false });
  assert.equal(early.decision, "fail");
  assert.deepEqual(early.waiting, ["factory", "router", "lens"]);
});

test("a public endpoint that fails once is asked again; a revert is the chain's answer", async () => {
  let calls = 0;
  const flaky = retrying(async () => {
    if (++calls < 3) throw new Error("fetch failed");
    return "0x1";
  }, { delayMs: 1 });
  assert.equal(await flaky("eth_chainId", []), "0x1");
  assert.equal(calls, 3);
  calls = 0;
  const down = retrying(async () => { calls++; throw new Error("HTTP 429"); }, { delayMs: 1 });
  await assert.rejects(() => down("eth_chainId", []), /429/);
  assert.equal(calls, 3);
  calls = 0;
  const reverting = retrying(async () => { calls++; throw new Error("execution reverted: BDEX: K"); }, { delayMs: 1 });
  await assert.rejects(() => reverting("eth_call", []), /BDEX: K/);
  assert.equal(calls, 1);
});

// ---- the owner's choices as committed, and the tools of the decisions of 2026-11-17 ----

test("the committed choices: the owner's depositing account as check-depositor recorded it, no caps on any chain, a real plan", () => {
  assert.equal(committed.firstDepositor, "0x1ec3fe62f416cA8984b0AB415F144a29eE5CC8f3");
  assert.equal(committed.firstDepositorCheck.address, committed.firstDepositor);
  assert.deepEqual(Object.keys(committed.firstDepositorCheck.chains), committed.chains);
  for (const reads of Object.values(committed.firstDepositorCheck.chains)) {
    assert.ok(reads.length >= 2, "two endpoints per chain");
    for (const r of reads) assert.deepEqual([r.nonce, r.code], [0, "none"]);
  }
  for (const chain of committedChains) {
    assert.deepEqual(chain.reserveCaps, []);
    assert.match(chain.reserveCapsReason, /bridge/);
    assert.deepEqual(pendingChoices(committed, chain), []);
    const plan = planChain(committed, chain, artifacts);
    assert.equal(plan.reference, false);
    assert.equal(plan.arguments.firstDepositor, committed.firstDepositor);
    assert.deepEqual(plan.arguments.reserveCaps, []);
    assert.equal(forgeEnvironment(plan, chain).MC_FIRST_DEPOSITOR, committed.firstDepositor);
    assert.equal(gateConfig(committed, chain).ownerChoices.firstDepositor, committed.firstDepositor);
  }
  // One file, and no hand edit: another address than the recorded one, or an address without a record, is refused
  // by everything that loads the file (plan, deploy script inputs, gate, first-deposit).
  const edited = { ...clone(committed), firstDepositor: OWNER_DEPOSITOR };
  assert.throws(() => validateShared(edited), /is not the address check-depositor.mjs recorded/);
  const unrecorded = clone(edited);
  delete unrecorded.firstDepositorCheck;
  assert.throws(() => validateShared(unrecorded), /has no firstDepositorCheck record/);
  const orphan = { ...clone(committed), firstDepositor: PENDING };
  assert.throws(() => validateShared(orphan), /firstDepositor is open/);
});

test("check-depositor: only an address with no code, nonce 0 and no delegation on two endpoints of every chain, used nowhere in the repository", async () => {
  assert.deepEqual(endpointVerdict({ chainId: 10, expectedChainId: 10, code: "0x", nonce: 0, pendingNonce: 0 }), []);
  assert.match(endpointVerdict({ chainId: 10, expectedChainId: 10, code: "0x", nonce: 3, pendingNonce: 3 }).join(), /already sent 3 transactions/);
  assert.match(endpointVerdict({ chainId: 10, expectedChainId: 10, code: "0x", nonce: 0, pendingNonce: 1 }).join(), /pending transaction/);
  assert.match(endpointVerdict({ chainId: 10, expectedChainId: 10, code: `0xef0100${"63".repeat(20)}`, nonce: 0, pendingNonce: 0 }).join(), /EIP-7702 delegation/);
  assert.match(endpointVerdict({ chainId: 10, expectedChainId: 10, code: "0x6080", nonce: 0, pendingNonce: 0 }).join(), /contract code/);
  assert.match(endpointVerdict({ chainId: 1, expectedChainId: 10, code: "0x", nonce: 0, pendingNonce: 0 }).join(), /chain 1, not 10/);
  // What the address must not be: the fee address, a token, a feed, a pool, a delegate, a planned address.
  assert.deepEqual(offlineProblems(OWNER_DEPOSITOR, shared), []);
  assert.match(offlineProblems(shared.feeTo.address, shared).join(), /it is the fee address/);
  assert.match(offlineProblems(ZERO_ADDRESS, shared).join(), /zero address/);
  assert.match(offlineProblems(REFERENCE_FIRST_DEPOSITOR, shared).join(), /nobody holds its key/);
  for (const used of [chains[0].tokens[0].address, chains[0].wrappedNative.address, chains[0].openingPrice.references[0].base.proxy, chains[0].openingPrice.references[1].pool, chains[0].multicall3.address, shared.feeTo.delegation.accepted[0].delegate])
    assert.match(offlineProblems(viem.getAddress(used), shared).join(), /appears in the repository's deployments|delegate contract/, used);
  assert.match(offlineProblems(OWNER_DEPOSITOR, shared, { planned: [{ address: OWNER_DEPOSITOR, what: "the factory of base" }] }).join(), /plan would deploy the factory of base/);
  // The depositing account itself, where the file names it as such, is not "an address in use".
  assert.equal(addressesInDeployments().has(lower(committed.firstDepositor)), false);
  assert.ok(addressesInDeployments().has(lower(shared.feeTo.address)));
  // The chains: fake endpoints.
  const world = (over = {}) => (url) => async (method, params) => {
    const o = typeof over === "function" ? over(url) : over;
    if (o.down) throw new Error("connection refused");
    const chain = chains.find((c) => c.rpc.includes(url));
    if (method === "eth_chainId") return `0x${chain.chain.chainId.toString(16)}`;
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getCode") return o.code ?? "0x";
    if (method === "eth_getTransactionCount") return params[1] === "pending" ? (o.pending ?? o.nonce ?? "0x0") : (o.nonce ?? "0x0");
    if (method === "eth_getBalance") return o.balance ?? "0x0";
    throw new Error(`unexpected ${method}`);
  };
  const fit = await checkDepositor(OWNER_DEPOSITOR, shared, { transportFor: world(), artifacts });
  assert.equal(fit.fit, true, fit.problems.join());
  assert.equal(fit.planned.length, 6 * 4);
  const record = checkRecord(fit, "2026-11-17T00:00:00Z");
  assert.deepEqual([record.address, Object.keys(record.chains).length, record.chains.linea.length], [OWNER_DEPOSITOR, 6, 3]);
  // A balance is reported, not refused (the account is funded before its deposit).
  assert.equal((await checkDepositor(OWNER_DEPOSITOR, shared, { transportFor: world({ balance: "0x5" }), artifacts })).fit, true);
  const lineaOnly = (over) => (url) => (/linea\.build/.test(url) ? over : {});
  for (const [over, why] of [[{ nonce: "0x1" }, /linea: .*already sent 1 transaction/], [{ pending: "0x1" }, /pending transaction/], [{ code: `0xef0100${"63".repeat(20)}` }, /EIP-7702 delegation/], [{ code: "0x60" }, /contract code/]]) {
    const result = await checkDepositor(OWNER_DEPOSITOR, shared, { transportFor: world(lineaOnly(over)), artifacts });
    assert.equal(result.fit, false);
    assert.match(result.problems.join(), why);
  }
  // One endpoint of a two-endpoint chain down: one answer is not enough.
  const oneDown = await checkDepositor(OWNER_DEPOSITOR, shared, { transportFor: world((url) => (/mainnet\.optimism\.io/.test(url) ? { down: true } : {})), artifacts });
  assert.equal(oneDown.fit, false);
  assert.match(oneDown.problems.join(), /op-mainnet: only 1 endpoint answered; two are needed/);
  await assert.rejects(() => checkDepositor(OWNER_DEPOSITOR.toLowerCase(), shared, { transportFor: world() }), /EIP-55/);
});

test("fee address proof: one EIP-191 message, verified offline and strictly; the pre gate of a public chain needs it", async () => {
  const { privateKeyToAccount, generatePrivateKey } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem/accounts");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const ids = chainIdsOf(committed);
  assert.deepEqual(ids, [10, 8453, 42161, 59144, 56, 1]);
  // The text is fixed: domain, address, the six chain ids, the purpose; one line of printable ASCII.
  const text = feeProofMessage(committed.feeTo.address, ids);
  assert.equal(text, `PosternDEX fee address proof (${FEE_PROOF_DOMAIN}). I control the address 0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544 and name it as the protocol fee recipient (feeTo) of the PosternDEX factory on the chains with ids 10, 8453, 42161, 59144, 56, 1. This message is not a transaction and authorizes no transfer and no approval.`);
  assert.match(text, /^[\x20-\x7e]+$/);
  // A throwaway key stands in for the fee address in a copy of the configuration.
  const account = privateKeyToAccount(generatePrivateKey());
  const local = clone(committed);
  local.feeTo.address = account.address;
  const message = feeProofMessage(account.address, ids);
  const signature = await account.signMessage({ message });
  const proof = { schemaVersion: 1, domain: FEE_PROOF_DOMAIN, address: account.address, chainIds: ids, message, signature };
  const good = await verifyFeeProof(local, ids, proof);
  assert.deepEqual([good.valid, good.signer], [true, account.address]);
  // The same proof is not a proof for the real fee address, for other chains, or for another text.
  assert.equal((await verifyFeeProof(committed, ids, proof)).valid, false);
  assert.match((await verifyFeeProof(local, [10, 1], proof)).problems.join(), /other chain ids/);
  assert.match((await verifyFeeProof(local, ids, { ...proof, message: `${message} ` })).problems.join(), /not the text/);
  assert.equal((await verifyFeeProof(local, ids, null)).valid, false);
  // Someone else's signature of the right text.
  const other = privateKeyToAccount(generatePrivateKey());
  const wrong = await verifySignature({ address: account.address, message, signature: await other.signMessage({ message }) });
  assert.equal(wrong.valid, false);
  assert.match(wrong.problems.join(), /not by the fee address/);
  // Strict form: 65 bytes, low s, v 27 or 28.
  const [r, sHex, v] = [signature.slice(2, 66), signature.slice(66, 130), Number.parseInt(signature.slice(130), 16)];
  const highS = `0x${r}${(N - BigInt(`0x${sHex}`)).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
  assert.match((await verifySignature({ address: account.address, message, signature: highS })).problems.join(), /upper half/);
  assert.match((await verifySignature({ address: account.address, message, signature: `0x${r}${sHex}${(v - 27).toString(16).padStart(2, "0")}` })).problems.join(), /v is [01], not 27 or 28/);
  assert.match((await verifySignature({ address: account.address, message, signature: `0x${r}${sHex}` })).problems.join(), /64 bytes, not 65/);
  assert.match((await verifySignature({ address: account.address, message, signature: `${signature}00` })).problems.join(), /66 bytes, not 65/);
  assert.match((await verifySignature({ address: account.address, message, signature: `0x${"00".repeat(32)}${sHex}1b` })).problems.join(), /r is out of range/);
  assert.match((await verifySignature({ address: account.address, message, signature: `0x${r}${"ff".repeat(32)}1b` })).problems.join(), /s is out of range/);
  assert.equal((await verifySignature({ address: account.address, message, signature: signature.toUpperCase() })).valid, false);
  assert.equal((await verifySignature({ address: account.address, message, signature: undefined })).valid, false);
  // The file on disk: absent in the repository until the owner signs; a valid one in a copy of the tree is accepted.
  const dir = mkdtempSync(join(tmpdir(), "mc-proof-"));
  try {
    cpSync(join(ROOT, "deployments"), join(dir, "deployments"), { recursive: true });
    rmSync(join(dir, "deployments/fee-address-proof.json"), { force: true });
    assert.match((await loadFeeProof(local, dir)).problems.join(), /does not exist/);
    writeFileSync(join(dir, "deployments/fee-address-proof.json"), JSON.stringify(proof));
    assert.equal((await loadFeeProof(local, dir)).valid, true);
    writeFileSync(join(dir, "deployments/fee-address-proof.json"), "{");
    assert.match((await loadFeeProof(local, dir)).problems.join(), /not JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // If the owner's proof is committed, it must be valid for the committed fee address.
  if (existsSync(join(ROOT, "deployments/fee-address-proof.json"))) assert.equal((await loadFeeProof(committed)).valid, true);
  // The signing page: self-contained (it may load nothing and connect nowhere), asks personal_sign of exactly the
  // message's bytes by the fee address, and no transaction.
  const page = signingPage(committed.feeTo.address, text);
  assert.ok(page.includes(`0x${Buffer.from(text, "utf8").toString("hex")}`));
  assert.match(page, /default-src 'none'/);
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(page), "no outside URL");
  assert.ok(page.includes('"personal_sign"') && !/eth_sendTransaction|eth_signTypedData|fetch\(|XMLHttpRequest/.test(page));
  // The tool takes no decision from a subprocess: it starts none.
  const source = readFileSync(join(ROOT, "scripts/multichain/fee-proof.mjs"), "utf8");
  assert.ok(!/child_process|spawn|exec\(/.test(source));
});

test("EIP-7702 at the fee address: accepted only to the identified delegate with its recorded code; another designator than the recorded one is a warning", async () => {
  const known = committed.feeTo.delegation.accepted[0];
  assert.equal(known.delegate, "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B");
  assert.match(known.name, /MetaMask EIP7702StatelessDeleGator/);
  assert.deepEqual(Object.keys(known.codeHash).sort(), [...committed.chains].sort());
  assert.match(known.sourceChecked.found, /EIP7702StatelessDeleGatorImpl: 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B/);
  const designator = `0xef0100${known.delegate.slice(2).toLowerCase()}`;
  assert.equal(committed.feeTo.delegation.recorded.base, designator);
  for (const key of committed.chains.filter((k) => k !== "base")) assert.equal(committed.feeTo.delegation.recorded[key], null);
  // Base as recorded: accepted, no warning.
  assert.deepEqual((({ kind, accepted, changed, name }) => [kind, accepted, changed, name])(feeDelegationOn(committed, "base", designator, known.codeHash.base)), ["delegation", true, false, known.name]);
  // The delegation cleared on Base, or newly set on another chain: accepted, but it differs from the record.
  assert.deepEqual((({ kind, accepted, changed }) => [kind, accepted, changed])(feeDelegationOn(committed, "base", "0x")), ["none", true, true]);
  assert.deepEqual((({ kind, accepted, changed }) => [kind, accepted, changed])(feeDelegationOn(committed, "op-mainnet", designator, known.codeHash["op-mainnet"])), ["delegation", true, true]);
  assert.deepEqual((({ kind, accepted, changed }) => [kind, accepted, changed])(feeDelegationOn(committed, "op-mainnet", "0x")), ["none", true, false]);
  // Refused: an unidentified delegate; the identified address with other code; a contract.
  assert.match(feeDelegationOn(committed, "base", `0xef0100${"63".repeat(20)}`, known.codeHash.base).problem, /not an identified delegate/);
  assert.match(feeDelegationOn(committed, "base", designator, known.codeHash.ethereum).problem, /does not hold the code recorded/);
  assert.match(feeDelegationOn(committed, "base", "0x6080604052").problem, /contract code/);
  // The same through the gate (a rehearsal run, so that the proof of control is not the subject).
  const { keccak256, encodeFunctionResult, parseAbi, toFunctionSelector, toHex } = viem;
  const chain = clone(committedChains.find((c) => c.chain.key === "base"));
  const local = clone(committed);
  const code = (label) => toHex(`code:${label}`);
  local.create2.deployerCodeHash = keccak256(code("deployer"));
  chain.wrappedNative.codeHash = keccak256(code("wrapped"));
  chain.tokens[0].codeHash = keccak256(code("token"));
  chain.multicall3.codeHash = keccak256(code("multicall"));
  local.feeTo.delegation.accepted[0].codeHash.base = keccak256(code("delegator"));
  const plan = planChain(local, chain, artifacts);
  const abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)"]);
  const names = Object.fromEntries(abi.map((f) => [toFunctionSelector(f), f.name]));
  const world = ({ feeCode, delegateCode = code("delegator") }) => async (method, params) => {
    const codes = new Map([[lower(local.create2.deployer), code("deployer")], [lower(chain.wrappedNative.address), code("wrapped")], [lower(chain.tokens[0].address), code("token")], [lower(chain.multicall3.address), code("multicall")], [lower(local.feeTo.address), feeCode], [lower(known.delegate), delegateCode]]);
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: chain.chain.genesisHash } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
    if (method === "eth_getCode") return codes.get(lower(params[0])) ?? "0x";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_call") {
      const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === lower(params[0].to));
      const fn = names[params[0].data.slice(0, 10)];
      return encodeFunctionResult({ abi, functionName: fn, result: fn === "getChainId" ? 8453n : fn === "decimals" ? token.decimals : token[fn] });
    }
    throw new Error(`unexpected ${method}`);
  };
  const gate = (over) => evaluateGate({ shared: local, chain, plan, phase: "pre", request: world(over), rehearsal: true });
  const asRecorded = await gate({ feeCode: designator });
  assert.equal(asRecorded.decision, "pass", JSON.stringify(asRecorded.failed));
  assert.deepEqual([asRecorded.feeTo.designator, asRecorded.feeTo.delegateName, asRecorded.feeTo.differsFromRecorded, asRecorded.warnings.length], [designator, known.name, false, 0]);
  const cleared = await gate({ feeCode: "0x" });
  assert.equal(cleared.decision, "pass");
  assert.equal(cleared.warnings.length, 1);
  assert.match(cleared.warnings[0], /designator on Base is none .*records 0xef0100/);
  const unknown = await gate({ feeCode: `0xef0100${"77".repeat(20)}` });
  assert.equal(unknown.decision, "fail");
  assert.match(JSON.stringify(unknown.checks.filter((c) => !c.ok)), /not an identified delegate/);
  const swapped = await gate({ feeCode: designator, delegateCode: code("something else") });
  assert.equal(swapped.decision, "fail");
  assert.match(JSON.stringify(swapped.checks.filter((c) => !c.ok)), /does not hold the code recorded/);
});

test("opening price: the market from two agreeing references; one amount in, the other computed; 0.5% and the minimum enforced", async () => {
  // Chainlink: NATIVE / USD over TOKEN / USD, exact, in token base units per whole native coin.
  assert.equal(chainlinkPrice({ base: { answer: 182_000_000_000n, decimals: 8 }, quote: { answer: 100_000_000n, decimals: 8 }, tokenDecimals: 6 }), 1_820_000_000n);
  assert.equal(chainlinkPrice({ base: { answer: 182_000_000_000n, decimals: 8 }, quote: { answer: 99_980_000n, decimals: 8 }, tokenDecimals: 6 }), 1_820_364_072n);
  assert.equal(chainlinkPrice({ base: { answer: 59_200_000_000n, decimals: 8 }, quote: { answer: 100_000_000n, decimals: 8 }, tokenDecimals: 18 }), 592n * 10n ** 18n);
  assert.throws(() => chainlinkPrice({ base: { answer: 0n, decimals: 8 }, quote: { answer: 1n, decimals: 8 }, tokenDecimals: 6 }), /not above zero/);
  // A v3 pool's mean tick: token1 per token0 = 1.0001^tick, either token order; the mean rounds toward minus infinity.
  const up = twapPrice({ tickCumulatives: [0n, 201_260n * 300n], windowSeconds: 300, wrappedIs0: false });
  assert.equal(up.tick, 201260);
  assert.ok(up.price > 1_818_000_000n && up.price < 1_820_000_000n, String(up.price));
  const down = twapPrice({ tickCumulatives: [0n, -201_260n * 300n], windowSeconds: 300, wrappedIs0: true });
  assert.equal(down.price, up.price);
  assert.equal(twapPrice({ tickCumulatives: [0n, -201_260n * 300n - 1n], windowSeconds: 300, wrappedIs0: true }).tick, -201261);
  assert.equal(twapPrice({ tickCumulatives: [0n, 201_260n * 300n + 299n], windowSeconds: 300, wrappedIs0: false }).tick, 201260);
  // The two must agree; the market is their mean.
  assert.deepEqual(combine([1000n, 1010n], 100), { agree: true, spreadBps: 100, market: 1005n });
  assert.equal(combine([1011n, 1000n], 100).agree, false);
  assert.throws(() => combine([1000n], 100), /two references/);
  assert.equal(deviationBps(1005n, 1000n), 50n);
  assert.equal(deviationBps(1006n, 1000n), 60n);
  // The other side of a deposit, and the checks on what the owner gives.
  const market = 1_819_668_740n;
  const E18 = 10n ** 18n;
  assert.equal(tokenFor(10n * E18, market), 18_196_687_400n);
  assert.equal(priceOf(10n * E18, 18_196_687_400n), market);
  assert.ok(market - priceOf(nativeFor(18_196_687_400n, market), 18_196_687_400n) <= 1n);
  const rule = { market, maxDeviationBps: 50, minimumNative: E18 / 10n };
  assert.deepEqual(openingAmounts({ given: { native: 10n * E18 }, ...rule }), { native: 10n * E18, token: 18_196_687_400n, computed: "token", priceBps: 0 });
  const fromToken = openingAmounts({ given: { token: 18_196_687_400n }, ...rule });
  assert.deepEqual([fromToken.computed, fromToken.priceBps <= 1, fromToken.native > 9_999_999_999n * 10n ** 8n], ["native", true, true]);
  assert.equal(openingAmounts({ given: { native: 10n * E18, token: 18_270_000_000n }, ...rule }).priceBps, 41);
  assert.throws(() => openingAmounts({ given: { native: 10n * E18, token: 30_000_000_000n }, ...rule }), /from the chain's market price, more than the 0.5% allowed/);
  assert.throws(() => openingAmounts({ given: { native: 10n * E18, token: 18_300_000_000n }, ...rule }), /0.5% allowed/);
  assert.throws(() => openingAmounts({ given: { native: 10n * E18, token: 18_090_000_000n }, ...rule }), /0.5% allowed/);
  assert.throws(() => openingAmounts({ given: { native: E18 / 100n }, ...rule }), /below this chain's minimum/);
  assert.throws(() => openingAmounts({ given: {}, ...rule }), /one side/);
  assert.throws(() => openingAmounts({ given: { native: E18 }, ...rule, market: undefined }), /no market price/);
  assert.throws(() => openingAmounts({ given: { native: 10n ** 9n }, market: 10n, maxDeviationBps: 50, minimumNative: 1n }), /too small|10\^12/);
  assert.equal(MIN_OPENING_SHARES, 10n ** 12n);
  // Every chain states its rule, two references with their publisher's page, and a minimum with its reason.
  for (const chain of committedChains) {
    const o = chain.openingPrice;
    assert.deepEqual([o.rule, o.maxDeviationBps, o.referencesAgreeBps, o.references.map((r) => r.kind)], ["market", 50, 100, ["chainlink", "v3-twap"]]);
    assert.ok(Number(o.minimumNative) > 0 && o.minimumReason.length > 60);
    for (const r of o.references) {
      assert.match(r.source, /^https:\/\/(docs\.chain\.link|developers\.uniswap\.org|developer\.pancakeswap\.finance)\//);
      assert.match(r.sourceChecked.fetched, /^2026-11-\d\d$/);
    }
    for (const bad of [{ maxDeviationBps: 51 }, { referencesAgreeBps: 500 }, { rule: "owner" }, { minimumNative: "0" }, { references: [o.references[0]] }])
      assert.throws(() => validateChain({ ...clone(chain), openingPrice: { ...clone(o), ...bad } }, chain.chain.key), /openingPrice/);
  }
  // readMarket against a stand-in chain: every read pinned to the block hash and asked of both endpoints.
  const { encodeFunctionResult, decodeFunctionData, parseAbi, keccak256, toHex } = viem;
  const abi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)", "function getPool(address,address,uint24) view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function liquidity() view returns (uint128)", "function observe(uint32[]) view returns (int56[],uint160[])", "function balanceOf(address) view returns (uint256)"]);
  const chain = clone(committedChains.find((c) => c.chain.key === "op-mainnet"));
  const [feeds, pool] = chain.openingPrice.references;
  const code = (label) => toHex(`code:${label}`);
  feeds.base.codeHash = feeds.quote.codeHash = keccak256(code("feed"));
  pool.factoryCodeHash = keccak256(code("factory"));
  pool.poolCodeHash = keccak256(code("pool"));
  const now = 1_794_880_000n;
  const at = { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${now.toString(16)}` };
  const pins = [];
  const endpoint = (over = {}) => async (method, params) => {
    const o = { ethUsd: 182_000_000_000n, usdcUsd: 100_000_000n, age: 60n, tick: 201_260n, pool: pool.pool, held: 1000n * E18, liquidity: 5n, ...over };
    pins.push(params[1]);
    const to = lower(params[0].to ?? params[0]);
    if (method === "eth_getCode") return to === lower(pool.factory) ? code("factory") : to === lower(pool.pool) ? code("pool") : code("feed");
    const { functionName, args } = decodeFunctionData({ abi, data: params[0].data });
    const out = (result) => encodeFunctionResult({ abi, functionName, result });
    if (functionName === "latestRoundData") return out([1n, to === lower(feeds.base.proxy) ? o.ethUsd : o.usdcUsd, 0n, now - o.age, 1n]);
    if (functionName === "decimals") return out(8);
    if (functionName === "description") return out(to === lower(feeds.base.proxy) ? "ETH / USD" : "USDC / USD");
    if (functionName === "getPool") return out(o.pool);
    // On OP Mainnet USDC (0x0b2C…) sorts before WETH (0x4200…): the wrapped token is token1.
    if (functionName === "token0") return out(chain.tokens[0].address);
    if (functionName === "token1") return out(chain.wrappedNative.address);
    if (functionName === "liquidity") return out(o.liquidity);
    if (functionName === "balanceOf") return out(o.held);
    if (functionName === "observe") return out([[0n, o.tick * BigInt(args[0][0])], [0n, 0n]]);
    throw new Error(`unexpected ${functionName}`);
  };
  const read = (a = {}, b = a) => readMarket({ chain, token: chain.tokens[0], requests: [endpoint(a), endpoint(b)], at });
  const ok = await read();
  assert.equal(ok.ok, true, ok.problems.join());
  assert.deepEqual(ok.references.map((r) => r.kind), ["chainlink", "v3-twap"]);
  assert.equal(ok.references[0].price, 1_820_000_000n);
  assert.equal(ok.market, (ok.references[0].price + ok.references[1].price) / 2n);
  assert.ok(ok.spreadBps <= 10);
  assert.ok(pins.length > 20 && pins.every((p) => p.blockHash === at.hash && p.requireCanonical === true), "every read is pinned to the block hash");
  // References more than 1% apart (a feed that lags, a pool being pushed): no market.
  const apart = await read({ ethUsd: 185_000_000_000n });
  assert.equal(apart.ok, false);
  assert.match(apart.problems.join(), /differ by 1\.\d\d%, more than the 1%/);
  assert.equal(apart.market, undefined);
  // One endpoint answers differently: nothing is used.
  assert.match((await read({}, { ethUsd: 181_000_000_000n })).problems.join(), /endpoints give different answers/);
  // A stale feed, a pool that is not the factory's, a drained pool.
  assert.match((await read({ age: BigInt(feeds.base.heartbeatSeconds + STALE_GRACE_SECONDS + 1) })).problems.join(), /stale/);
  assert.match((await read({ pool: chain.tokens[0].address })).problems.join(), /is not the one the factory/);
  assert.match((await read({ held: E18 })).problems.join(), /less than the 250 that make it a reference/);
  assert.match((await read({ liquidity: 0n })).problems.join(), /no liquidity/);
  assert.match((await read({ usdcUsd: 0n })).problems.join(), /not above zero/);
});

test("BNB Smart Chain's Binance-Peg token is listed under a truthful label, never as plain USDC", () => {
  const bnb = committedChains.find((c) => c.chain.key === "bnb-smart-chain");
  const token = bnb.tokens[0];
  assert.deepEqual([token.symbol, token.label, token.decimals], ["USDC", "USDC (Binance-Peg)", 18]);
  assert.match(token.note, /issued by Binance.*not by Circle/);
  assert.ok(!token.note.includes("\n") && token.note.length <= 160);
  const network = frontendNetwork(committed, bnb);
  assert.deepEqual([network.tokens[0].label, network.tokens[0].note], [token.label, token.note]);
  // No other chain's token carries a label: there the symbol says what the token is (Circle's USDC).
  for (const chain of committedChains.filter((c) => c !== bnb)) {
    assert.equal(chain.tokens[0].label, undefined);
    assert.equal("label" in frontendNetwork(committed, chain).tokens[0], false);
    assert.match(chain.tokens[0].kind, /^Circle-issued/);
  }
  // A label goes with a note and begins with the contract's own symbol.
  const bad = (over) => () => validateChain({ ...clone(bnb), tokens: [{ ...clone(token), ...over }] }, "bnb-smart-chain");
  assert.throws(bad({ note: undefined }), /label and note go together/);
  assert.throws(bad({ label: "Dollar (Binance-Peg)" }), /beginning with the symbol/);
  assert.throws(bad({ note: "short" }), /one line/);
});

test("licensing: no unfilled template, the GPL governs the contracts, the frontend ships its third-party notices", () => {
  const read = (path) => readFileSync(join(ROOT, path), "utf8");
  const license = read("LICENSE");
  assert.ok(!/<year>|<copyright holders>/.test(license), "the MIT template's placeholders are gone");
  assert.match(license, /contracts\/ {2}script\/ {2}test\/ +GPL-3\.0-or-later/);
  assert.match(license, /where that line and this file differ, this file governs/);
  assert.match(license, /Copyright \(c\) 2026 TBD-owner/);
  assert.match(read("LICENSES/GPL-3.0-or-later.txt"), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(read("NOTICE"), /Uniswap V2 Core[\s\S]*GPL-3\.0-or-later[\s\S]*Uniswap V2 Periphery/);
  for (const path of ["script/LICENSE", "test/LICENSE"]) assert.match(read(path), /GPL-3\.0-or-later/);
  for (const path of ["frontend/LICENSE", "scripts/LICENSE"]) assert.match(read(path), /MIT License/);
  assert.equal(JSON.parse(read("frontend/package.json")).license, "MIT");
  const notices = read("frontend/public/THIRD-PARTY-NOTICES.txt");
  assert.match(notices, /Portions \(c\) 2025 Reown, Inc\. All Rights Reserved/);
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(notices, /@fontsource-variable\/inter \d+\.\d+\.\d+ {2}-- {2}OFL-1\.1/);
  const check = spawnSync("node", ["frontend/scripts/third-party-notices.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
