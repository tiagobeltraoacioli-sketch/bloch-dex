// Regression tests for the round 15 review (agent 309, pass C) of scripts/ops/dex-monitor.mjs and
// scripts/ops/dex-seed-plan.mjs: the reviewer's demonstrations (review branch commit 2901e7a), turned around so
// that each asserts the corrected behaviour. R309-C3 is in dex-ops.test.mjs, next to the keeper's own tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ABI, CRIT, CallReverted, OK, UNKNOWN, keccak256, parseArgs } from "./dex-ops-lib.mjs";
import { monitorArguments, runMonitor } from "./dex-monitor.mjs";
import { removalFloor, seedFloorShares } from "./dex-seed-plan.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { encodeFunctionResult, decodeFunctionData } = viem;

// ---- fixture: a trimmed copy of the fake node in scripts/ops/dex-ops.test.mjs
const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const blockHash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const CODE = { pair: "0x6001", token0: "0x6002", token1: "0x6003", factory: "0x6004", router: "0x6005", lens: "0x6006", safe: "0x6007" };
const [T0, T1, PAIR, FACTORY, ROUTER, LENS, SAFE, LP] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => address(0xa00 + n));
const GENESIS = `0x${"ab".repeat(32)}`;
const INIT = `0x${"cd".repeat(32)}`;
const CAP0 = 1_000_000_000n; // 1,000 bUSDC
const CAP1 = 10n ** 19n; // 10 WBLCH

const gate = {
  schemaVersion: 2,
  chain: { id: 700770, genesisHash: GENESIS },
  deployment: {
    contracts: {
      wrappedNative: { address: T1, codeHash: keccak256(CODE.token1) },
      factory: { address: FACTORY, codeHash: keccak256(CODE.factory) },
      router: { address: ROUTER, codeHash: keccak256(CODE.router) },
      lens: { address: LENS, codeHash: keccak256(CODE.lens) },
    },
    pairInitCodeHash: INIT,
    feeTo: SAFE,
    roles: { blochInc: { address: SAFE, codeHash: keccak256(CODE.safe), safe: { threshold: 3, owners: [] } } },
    reserveCaps: [{ token: T0, cap: String(CAP0) }, { token: T1, cap: String(CAP1) }],
    tokens: [{ token: T0, symbol: "bUSDC", codeHash: keccak256(CODE.token0), bridgeBucketCapacity: "10000000000" }],
    pairs: [{ address: PAIR, token0: T0, token1: T1, codeHash: keccak256(CODE.pair) }],
    transactions: [],
  },
};

function fakeNode(overrides = {}) {
  const now = 2_000_000_000n;
  const chain = {
    now, finalizedNumber: 5n, reserves: [500_000_000n, 5n * 10n ** 18n], balances: [500_000_000n, 5n * 10n ** 18n],
    totalSupply: 10n ** 13n, kLast: 25n * 10n ** 26n, lpInPair: 0n, lpHeld: 0n, nullLatest: false, ...overrides,
  };
  const reply = (fn) => {
    switch (fn) {
      case "getReserves": return [chain.reserves[0], chain.reserves[1], 1];
      case "reserveCaps": return [CAP0, CAP1];
      case "totalSupply": return chain.totalSupply;
      case "kLast": return chain.kLast;
      case "allPairsLength": return 1n;
      case "INIT_CODE_PAIR_HASH": return INIT;
      case "paused": return false;
      case "pausedUntil": return 0n;
      case "availableToMint": return 1n;
      case "pendingSupply": case "nextSlot": case "mintCount": case "verifier": throw new CallReverted("eth_call: execution reverted");
      case "decimals": return 6;
      case "allowance": return 0n;
      case "position": return { liquidity: 7n, pendingProtocolLiquidity: 3n, dilutedSupply: 10n, reserveShare0: 1n, reserveShare1: 2n };
      default: throw new Error(`fake: ${fn}`);
    }
  };
  const request = async (method, params) => {
    switch (method) {
      case "eth_chainId": return "0xab162";
      case "eth_getBlockByNumber": {
        const [tag] = params;
        if (tag === "0x0") return { hash: GENESIS };
        if (tag === "latest" && chain.nullLatest) return null;
        const number = tag === "finalized" ? chain.finalizedNumber : tag === "latest" ? 10n : BigInt(tag);
        return { number: `0x${number.toString(16)}`, hash: blockHash(number), timestamp: `0x${(now - (tag === "finalized" ? 6000n : 300n)).toString(16)}`, baseFeePerGas: "0x1" };
      }
      case "eth_getCode": {
        const [a] = params;
        return { [PAIR]: CODE.pair, [T0]: CODE.token0, [T1]: CODE.token1, [FACTORY]: CODE.factory, [ROUTER]: CODE.router, [LENS]: CODE.lens, [SAFE]: CODE.safe }[a];
      }
      case "eth_call": {
        const [{ to, data }] = params;
        const { functionName, args } = decodeFunctionData({ abi: ABI, data });
        let value;
        if (functionName === "balanceOf") {
          // Unlike the original fixture, the pair's own LP balance and a holder's are separate.
          if (to === PAIR) value = args[0].toLowerCase() === PAIR ? chain.lpInPair : chain.lpHeld;
          else value = chain.balances[to === T0 ? 0 : 1];
        } else value = reply(functionName);
        return encodeFunctionResult({ abi: ABI, functionName, result: value });
      }
      default: throw new Error(`fake: ${method}`);
    }
  };
  return { chain, request };
}

const monitorDeps = (node) => ({
  now: node.chain.now,
  evaluateGate: async () => ({ decision: "liquidity-enabled", finalized: { number: "5" } }),
  verifySafe: async () => ({}),
});
const named = (result, prefix) => result.checks.filter((c) => c.name.startsWith(prefix));

/// The fake node behind a loopback JSON-RPC endpoint, for the real command lines.
async function serve(node) {
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", async () => {
      const { id, method, params } = JSON.parse(text);
      let body;
      try { body = { jsonrpc: "2.0", id, result: await node.request(method, params) }; }
      catch (error) { body = { jsonrpc: "2.0", id, error: { code: error instanceof CallReverted ? 3 : -32000, message: error.message } }; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function gateFile(context) {
  const directory = mkdtempSync(join(tmpdir(), "passC-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "gate.json");
  writeFileSync(path, JSON.stringify(gate));
  return path;
}

// ---------------------------------------------------------------- dex-monitor.mjs

test("R309-C1: an empty, negative or non-numeric --lp-min-shares is a configuration error, never \"no floor\"", async () => {
  const options = { expectSeeded: true, lpRecipient: LP };
  const node = fakeNode({ lpHeld: 6n * 10n ** 12n }); // 60% of the shares, below a floor of 9e12
  const armed = await runMonitor(gate, { ...options, lpMinShares: "9000000000000" }, node.request, monitorDeps(node));
  assert.deepEqual(named(armed, "lp_floor").map((c) => c.level), [CRIT]);
  for (const bad of ["", "-1", "9e12", "0x10", " 5", "1.5"]) {
    const result = await runMonitor(gate, { ...options, lpMinShares: bad }, node.request, monitorDeps(node));
    assert.deepEqual(named(result, "lp_floor").map((c) => c.level), [UNKNOWN], JSON.stringify(bad));
    assert.match(named(result, "lp_floor")[0].detail, /NOT being checked/);
    assert.equal(result.level, UNKNOWN);
  }
  // An explicit 0 is the one way to say "no floor".
  const off = await runMonitor(gate, { ...options, lpMinShares: "0" }, node.request, monitorDeps(node));
  assert.deepEqual(named(off, "lp_floor"), []);
  assert.equal(off.level, OK);
});

test("R309-C1/C2 (command line): an empty value, a misspelt option, or half of a pair stops the monitor with UNKNOWN", async (context) => {
  const node = fakeNode({ lpHeld: 6n * 10n ** 12n });
  const rpc = await serve(node);
  context.after(() => rpc.close());
  const base = ["--config", gateFile(context), "--rpc", rpc.url, "--rehearsal", "--json", "--expect-seeded", "--lp-recipient", LP];
  const names = (out) => JSON.parse(out.stdout).checks.map((c) => c.name);

  const control = await run("dex-monitor.mjs", [...base, "--lp-min-shares", "9000000000000"]);
  assert.ok(names(control).some((n) => n.startsWith("lp_floor")), control.stderr);

  const refused = async (args, pattern) => {
    const out = await run("dex-monitor.mjs", args);
    assert.equal(out.status, UNKNOWN, `${args.slice(base.length).join(" ")}: ${out.stdout}${out.stderr}`);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, pattern);
  };
  // What the unit runs when DEX_LP_MIN_SHARES, DEX_ETH_RPC or DEX_BUSDC_VAULT is empty or unset.
  await refused([...base, "--lp-min-shares", "", "--eth-rpc", "", "--bridge-vault", ""], /--lp-min-shares has an empty value/);
  await refused([...base, "--lp-min-shares", "1", "--eth-rpc", ""], /--eth-rpc has an empty value/);
  await refused([...base, "--lp-min-shares", "-1"], /--lp-min-shares must be a non-negative whole number/);
  // The floor is not optional once the pair is expected to be seeded.
  await refused(base, /--expect-seeded needs --lp-min-shares/);
  // A misspelt option is not swallowed with its value.
  await refused([...base, "--lp-min-share", "9000000000000"], /unknown option --lp-min-share/);
  await refused([...base, "--lp-min-shares", "1", "--keeper-sate", "/nonexistent"], /unknown option --keeper-sate/);
  // Half of a pair.
  await refused([...base, "--lp-min-shares", "1", "--bridge-vault", address(0x7a)], /--eth-rpc and --bridge-vault go together/);
  await refused([...base, "--lp-min-shares", "1", "--eth-rpc", "http://127.0.0.1:9"], /--eth-rpc and --bridge-vault go together/);
  await refused([...base, "--lp-min-shares", "1", "--keeper-state", "/nonexistent"], /--keeper-state needs --keeper-max-tx and --keeper-budget-wei/);
  await refused([...base, "--lp-min-shares", "1", "--keeper-budget-wei", "1"], /--keeper-budget-wei needs --keeper-state/);
});

test("R309-C2: without --rehearsal the bridge files, the Ethereum RPC, the vault and its code hash are all required", () => {
  const mainnet = ["--config", "g.json", "--rpc", "http://127.0.0.1:1", "--safe-plan", "s.json", "--bridge-plan", "p.json", "--bridge-record", "r.json"];
  const exit = ["--eth-rpc", "http://127.0.0.1:2", "--bridge-vault", address(0x7a), "--bridge-vault-code-hash", `0x${"7c".repeat(32)}`];
  assert.equal(monitorArguments([...mainnet, ...exit])["bridge-vault"], address(0x7a));
  assert.throws(() => monitorArguments(mainnet), /--eth-rpc and --bridge-vault are required/);
  assert.throws(() => monitorArguments([...mainnet, ...exit.slice(0, 4)]), /--bridge-vault-code-hash is required/);
  assert.throws(() => monitorArguments([...mainnet.slice(0, 6), ...exit]), /--safe-plan, --bridge-plan and --bridge-record are required/);
  assert.throws(() => monitorArguments([...mainnet.slice(0, 8), ...exit]), /--bridge-plan and --bridge-record go together/);
  assert.throws(() => monitorArguments([...mainnet, ...exit.slice(0, 4), "--bridge-vault-code-hash", "0x12"]), /--bridge-vault-code-hash must be a 32-byte hash/);
  assert.throws(() => monitorArguments([...mainnet, ...exit, "--bridge-vault", address(0x7b)]), /--bridge-vault is given twice/);
  assert.throws(() => monitorArguments([...mainnet, ...exit, "stray"]), /unexpected argument stray/);
  // The rehearsal form keeps them optional, but never half given.
  assert.equal(monitorArguments(["--config", "g.json", "--rpc", "http://127.0.0.1:1", "--rehearsal"]).rehearsal, true);
  // The unit's own command line, with every variable set, is accepted; with any one of them empty it is not.
  const unit = readFileSync(new URL("./systemd/bloch-dex-monitor.service", import.meta.url), "utf8").match(/^ExecStart=.*dex-monitor\.mjs (.*)$/m)[1].split(" ");
  const values = { DEX_GATE: "g.json", DEX_SAFE_PLAN: "s.json", DEX_BUSDC_BRIDGE_PLAN: "p.json", DEX_BUSDC_BRIDGE_RECORD: "r.json", DEX_RPC: "http://127.0.0.1:1", DEX_LP_RECIPIENT: LP,
    DEX_LP_MIN_SHARES: "4999999999900", DEX_KEEPER_MAX_TX: "48", DEX_KEEPER_BUDGET_WEI: "50000000000000000", DEX_ETH_RPC: "https://eth.example.org", DEX_BUSDC_VAULT: address(0x7a),
    DEX_BUSDC_VAULT_CODE_HASH: `0x${"7c".repeat(32)}` };
  const expand = (env) => unit.map((word) => word.replace(/^\$\{([A-Z0-9_]+)\}$/, (_, name) => { assert.ok(Object.hasOwn(values, name), name); return env[name] ?? ""; }));
  const parsed = monitorArguments(expand(values));
  assert.equal(parsed["keeper-budget-wei"], "50000000000000000");
  assert.equal(parsed["lp-min-shares"], "4999999999900");
  for (const name of Object.keys(values)) assert.throws(() => monitorArguments(expand({ ...values, [name]: "" })), /has an empty value/, name);
});

test("R309-K1: every ops tool refuses an option outside its own list, an empty value and a repeated option", () => {
  const spec = { flags: ["execute"], options: ["config", "max-fee-wei", "budget-wei"], repeat: ["sig"] };
  assert.throws(() => parseArgs(["--config", "g.json", "--max-fee-wie", "1000000000"], spec), /unknown option --max-fee-wie/);
  assert.throws(() => parseArgs(["--budget_wei", "1"], spec), /unknown option --budget_wei/);
  assert.throws(() => parseArgs(["--config", ""], spec), /--config has an empty value/);
  assert.throws(() => parseArgs(["--config", "a", "--config", "b"], spec), /--config is given twice/);
  assert.throws(() => parseArgs(["--config"], spec), /--config needs a value/);
  // With no list at all nothing is accepted: a tool cannot forget to name its options.
  assert.throws(() => parseArgs(["--config", "g.json"]), /unknown option --config/);
  const ok = parseArgs(["plan", "--config", "g.json", "--execute", "--sig", "a", "--sig", "b", "--", "--keystore", ""], { ...spec, commands: ["plan", "assemble"] });
  assert.deepEqual({ ...ok }, { _: ["plan"], rest: ["--keystore", ""], config: "g.json", execute: true, sig: ["a", "b"] });
});

test("R309-K1 (command line): the keeper stops at a misspelt limit, before any file or node is read", async () => {
  for (const typo of [["--max-fee-wie", "1000000000"], ["--budget_wei", "1"], ["--max-tx", ""]]) {
    const out = await run("dex-skim-keeper.mjs", ["--config", "/nonexistent/gate.json", "--rpc", "http://127.0.0.1:9", "--keeper", address(0xee), "--state", "/nonexistent/state.json", ...typo]);
    assert.equal(out.status, CRIT, out.stderr);
    assert.match(out.stderr, /keeper: (unknown option|--max-tx has an empty value)/);
    assert.equal(out.stdout, "");
  }
  for (const [script, args] of [["dex-seed-plan.mjs", ["plan", "--pirce", "100"]], ["dex-fee-redeem.mjs", ["plan", "--slipage-bps", "1"]], ["dex-storage-footprint.mjs", ["--wran-bps", "1"]], ["opening-form.mjs", ["check", "--from", "f.json"]]]) {
    const out = await run(script, args);
    assert.notEqual(out.status, 0, script);
    assert.match(out.stderr, /unknown option/, script);
  }
});

test("R309-C4: a node that answers null for the latest block is UNKNOWN, not a healthy report with one check", async () => {
  const node = fakeNode({ nullLatest: true });
  const result = await runMonitor(gate, { expectSeeded: true, lpRecipient: LP }, node.request, monitorDeps(node));
  assert.deepEqual(result.checks.map((c) => [c.name, c.level]), [["rpc_identity", OK], ["l2_head", UNKNOWN]]);
  assert.equal(result.level, UNKNOWN);
});

// ---------------------------------------------------------------- dex-seed-plan.mjs

test("R309-C5: `remove` never goes below 10% of the seed position without --allow-below-floor", async (context) => {
  // The seed here was made at 7,000 bps and P = 100: 7 WBLCH + 700 bUSDC, 69,999,999,999,000 shares, floor 6,999,999,999,900.
  const seedShares = 69_999_999_999_000n;
  const real = seedFloorShares({ wrappedCap: CAP1, quoteCap: CAP0, price: 100_000_000n, fractionBps: 7000n });
  assert.equal(real.seedShares, seedShares);
  assert.equal(real.floorShares, 6_999_999_999_900n);
  const node = fakeNode({ reserves: [700_000_000n, 7n * 10n ** 18n], balances: [700_000_000n, 7n * 10n ** 18n], totalSupply: 7n * 10n ** 13n, lpHeld: seedShares });
  const rpc = await serve(node);
  context.after(() => rpc.close());
  const base = ["remove", "--config", gateFile(context), "--rpc", rpc.url, "--price", "100", "--to", LP];
  const plan = async (args) => { const out = await run("dex-seed-plan.mjs", [...base, ...args]); return { out, json: out.stdout ? JSON.parse(out.stdout) : null }; };

  const refused = await plan(["--bps", "10000", "--fraction-bps", "7000"]);
  assert.equal(refused.out.status, 2);
  assert.equal(refused.json.decision, "refuse-floor");

  // 1. A floor given on the command line can only be raised.
  for (const bypass of [["--floor-bps", "0"], ["--floor-shares", "0"], ["--floor-bps", "999"], ["--floor-shares", "6999999999899"]]) {
    const { out, json } = await plan(["--bps", "10000", "--fraction-bps", "7000", ...bypass]);
    assert.equal(out.status, 2, bypass.join(" "));
    assert.equal(json.decision, "refuse-floor");
    assert.match(json.reason, /A floor can only be raised here/);
    assert.equal(json.steps, undefined);
  }
  const negative = await plan(["--bps", "10000", "--fraction-bps", "7000", "--floor-shares", "-1"]);
  assert.notEqual(negative.out.status, 0);
  assert.match(negative.out.stderr, /--floor-shares must be a non-negative whole number/);
  // A higher floor is taken: 20% of the seed leaves at most 80% removable.
  const raised = await plan(["--bps", "9000", "--fraction-bps", "7000", "--floor-bps", "2000"]);
  assert.equal(raised.out.status, 2);
  assert.equal(raised.json.floorShares, "13999999999800");

  // 2. The seed's fraction must be stated; there is no default to understate it with.
  const unstated = await plan(["--shares", "64999999999000"]);
  assert.equal(unstated.out.status, 3);
  assert.match(unstated.out.stderr, /--fraction-bps is required/);
  // Stated too low (5,000 for a 7,000 seed), the floor is taken from what the recipient really holds.
  const low = await plan(["--shares", "64999999999000", "--fraction-bps", "5000"]);
  assert.equal(low.out.status, 2);
  assert.equal(low.json.decision, "refuse-floor");
  // R309-2P-14: a holding above the stated seed is refused outright; the floor never follows the holding down.
  assert.match(low.json.reason, /the fraction stated is below the real seed/);
  assert.equal(low.json.minimumFloorShares, "6999999999900");
  // With the absolute floor (the monitor's number) the planner works whatever fraction is typed.
  const absolute = await plan(["--bps", "5000", "--fraction-bps", "5000", "--floor-shares", "6999999999900"]);
  assert.equal(absolute.out.status, 0, absolute.out.stderr);
  assert.equal(absolute.json.floorShares, "6999999999900");

  // 3. --fraction-bps 1 no longer shrinks the floor to dust.
  const dust = await plan(["--bps", "9999", "--fraction-bps", "1"]);
  assert.equal(dust.out.status, 2);
  assert.equal(dust.json.decision, "refuse-floor");

  // The allowed half, and the deliberate override, still work.
  const half = await plan(["--bps", "5000", "--fraction-bps", "7000"]);
  assert.equal(half.out.status, 0, half.out.stderr);
  assert.equal(half.json.belowFloor, false);
  assert.equal(half.json.steps.length, 2);
  const override = await plan(["--bps", "10000", "--fraction-bps", "7000", "--allow-below-floor"]);
  assert.equal(override.out.status, 1);
  assert.match(override.json.warning, /^OVERRIDE/);
  const lowered = await plan(["--bps", "10000", "--fraction-bps", "7000", "--floor-shares", "0", "--allow-below-floor"]);
  assert.equal(lowered.out.status, 0);
  assert.equal(lowered.json.floorShares, "0");
});

test("R309-C5: the removal floor is 10% of the larger of the seed position and the shares held", () => {
  const seed = 50_000n;
  assert.deepEqual(removalFloor({ seedShares: seed, held: 20_000n }), { seedShares: seed, minimumShares: 5_000n, floorShares: 5_000n });
  assert.match(removalFloor({ seedShares: seed, held: 80_000n }).refused, /the fraction stated is below the real seed, or liquidity was added later/);
  assert.equal(removalFloor({ seedShares: seed, held: 80_000n, floorShares: 8_000n }).floorShares, 8_000n);
  assert.match(removalFloor({ seedShares: seed, held: 80_000n, floorShares: 7_999n }).refused, /below the seeder floor of 8000 shares/);
  assert.equal(removalFloor({ seedShares: seed, held: 80_000n, allowBelowFloor: true }).floorShares, 8_000n);
  assert.equal(removalFloor({ seedShares: seed, held: 20_000n, floorBps: 2_500n }).floorShares, 12_500n);
  assert.equal(removalFloor({ seedShares: seed, held: 20_000n, floorShares: 5_000n }).floorShares, 5_000n);
  assert.match(removalFloor({ seedShares: seed, held: 20_000n, floorShares: 4_999n }).refused, /below the seeder floor of 5000 shares/);
  assert.equal(removalFloor({ seedShares: seed, held: 20_000n, floorShares: 0n, allowBelowFloor: true }).floorShares, 0n);
});
