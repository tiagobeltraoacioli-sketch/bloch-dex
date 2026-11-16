// The multichain kit's own tests (no RPC): configuration, plan, gate configuration, opcode set, command refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAIN_DEPENDENT_OPCODES, POST_PARIS_OPCODES, ROOT, ZERO_ADDRESS, checksummed, choicesFor, forgeEnvironment, loadArtifacts, loadChain, loadShared, lower,
  opcodesOf, pendingChoices, planChain, validateChain, validateShared,
} from "./lib.mjs";
import { evaluateGate, gateConfig } from "./gate.mjs";
import { frontendNetwork, frontendRecord } from "./frontend-files.mjs";

const shared = loadShared();
const artifacts = loadArtifacts();
const chains = shared.chains.map((key) => loadChain(key));
const plans = chains.map((chain) => planChain(shared, chain, artifacts, { reference: true }));
const clone = (v) => JSON.parse(JSON.stringify(v));

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

test("owner choices are open (TBD-owner) and a plan for a real deployment is refused until they are made", () => {
  for (const chain of chains) {
    assert.deepEqual(pendingChoices(shared, chain), ["deployments/multichain.json: firstDepositor", `deployments/${chain.chain.key}/chain.json: reserveCaps`]);
    assert.throws(() => planChain(shared, chain, artifacts), /owner choices are still open/);
    assert.equal(chain.openingPrice, "TBD-owner");
  }
  assert.ok(plans.every((p) => p.reference === true));
  // With the choices made the plan is no longer a reference plan.
  const decided = { ...clone(shared), firstDepositor: shared.feeTo.address };
  const chain = { ...clone(chains[0]), reserveCaps: [] };
  assert.equal(planChain(decided, chain, artifacts).reference, false);
  assert.equal(choicesFor(decided, chain).firstDepositor, shared.feeTo.address);
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
  const capped = (chain) => planChain({ ...clone(shared), firstDepositor: ZERO_ADDRESS }, { ...clone(chain), reserveCaps: [{ token: chain.tokens[0].symbol, cap: "1000000" }] }, artifacts);
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

test("the forge environment carries the plan and creates only pairs of the wrapped native token", () => {
  const chain = chains.find((c) => c.chain.key === "base");
  const plan = plans.find((p) => p.chain.key === "base");
  const env = forgeEnvironment(plan, chain);
  assert.equal(env.MC_CHAIN_ID, "8453");
  assert.equal(env.MC_FEE_TO, shared.feeTo.address);
  assert.equal(env.MC_WRAPPED, "0x4200000000000000000000000000000000000006");
  assert.equal(env.MC_PAIR_TOKENS, chain.tokens[0].address);
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
  for (const chain of chains) {
    const committed = JSON.parse(readFileSync(join(ROOT, "deployments", chain.chain.key, "gate.json"), "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(gateConfig(shared, chain))));
    assert.equal(committed.readAt, "finalized");
    assert.ok(Object.values(committed.l2Only).every((v) => v === false));
  }
});

test("each chain lists two https endpoints, the wrapped native token and one token, each with a source", () => {
  for (const chain of chains) {
    assert.ok(chain.rpc.length >= 2 && chain.rpc.every((u) => u.startsWith("https://")));
    assert.equal(chain.tokens.length, 1);
    for (const t of [chain.wrappedNative, ...chain.tokens]) assert.ok(t.source.length > 10 && t.kind.length > 5);
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
  const gateReference = run("node", "scripts/multichain/gate.mjs", "base", "post", "--reference");
  assert.equal(gateReference.status, 2);
  assert.match(gateReference.stderr, /only in a rehearsal/);
  const unknown = run("node", "scripts/multichain/plan.mjs", "bloch-l2");
  assert.equal(unknown.status, 2);
});

test("the committed frontend files of each chain are the generated ones, and no chain is recorded as deployed", () => {
  for (const chain of chains) {
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
    return async (method, params) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { hash: o.genesis } : { number: "0x64", hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" };
      if (method === "eth_getCode") return codes.get(lower(params[0])) ?? "0x";
      if (method === "eth_call") {
        const token = [chain.wrappedNative, ...chain.tokens].find((t) => lower(t.address) === lower(params[0].to));
        const fn = names[params[0].data.slice(0, 10)];
        if (fn === "getChainId") return encodeFunctionResult({ abi, functionName: fn, result: 8453n });
        return encodeFunctionResult({ abi, functionName: fn, result: fn === "decimals" ? token.decimals : token[fn] });
      }
      throw new Error(`unexpected ${method}`);
    };
  };
  const gate = (request) => evaluateGate({ shared: local, chain, plan, phase: "pre", request });
  const pass = await gate(world());
  assert.equal(pass.decision, "pass", JSON.stringify(pass.failed));
  assert.equal(pass.feeTo.code, "none");
  assert.equal(pass.finalized.number, 100);
  const delegated = await gate(world({ feeCode: `0xef0100${"63".repeat(20)}` }));
  assert.equal(delegated.decision, "pass");
  assert.deepEqual([delegated.feeTo.code, delegated.feeTo.delegate], ["EIP-7702 delegation", `0x${"63".repeat(20)}`]);
  const contractFee = await gate(world({ feeCode: "0x6080604052" }));
  assert.equal(contractFee.decision, "fail");
  assert.match(contractFee.failed.join(), /externally owned account/);
  const otherChain = await gate(world({ genesis: `0x${"11".repeat(32)}` }));
  assert.match(otherChain.failed.join(), /pinned genesis/);
  const otherToken = await gate(world({ tokenCode: code("another token") }));
  assert.match(otherToken.failed.join(), /USDC at .* holds the pinned code/);
  // The post gate fails while nothing is deployed.
  const post = await evaluateGate({ shared: local, chain, plan, phase: "post", request: world() });
  assert.equal(post.decision, "fail");
  assert.match(post.failed.join(), /factory .* holds the planned code at the finalized block/);
  assert.throws(() => frontendRecord(local, chain, post), /not a passed post gate/);
});
