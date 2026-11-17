// Round 19 (agent 400): the monitor, its unit and the fee-redemption planner when Bloch Inc is the owner's plain fee
// address (owner decision of 2026-11-17, constant OWNER_FEE_EOA; rule introduced by 4bf1fa1 for the deployment
// tools). Properties pinned here:
//   - only that exact address, pinned as {address, empty-code hash} with no Safe pin, is judged as a plain account:
//     no code and no EIP-7702 delegation at latest AND at finalized, else CRIT;
//   - every other Bloch Inc (a Safe, or any other plain address) keeps the Safe rules, unchanged;
//   - the command line names one Bloch Inc (--safe-plan or --owner-fee-address) and a mismatch with the gate file is
//     refused in both directions before any node is contacted;
//   - the two monitor units differ only in that one option.
// The fake node is the trimmed fixture of review-r15-monitor-seedplan.test.mjs with a per-block code table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ABI, CRIT, CallReverted, OK, RpcError, UNKNOWN, deploymentFromGate, keccak256 } from "./dex-ops-lib.mjs";
import { OWNER_FEE_PIN, blochIncMode, monitorArguments, runMonitor } from "./dex-monitor.mjs";
import { plan as planRedemption, redeemSigner, refuseAssembleForOwnerAddress } from "./dex-fee-redeem.mjs";
import { OWNER_FEE_EOA } from "../staging/finality-gate.mjs";
import { EMPTY_CODE_HASH } from "../staging/dex-deploy-config.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { encodeFunctionResult, decodeFunctionData, getAddress } = viem;

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const blockHash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const CODE = { pair: "0x6001", token0: "0x6002", token1: "0x6003", factory: "0x6004", router: "0x6005", lens: "0x6006", safe: "0x6007" };
const [T0, T1, PAIR, FACTORY, ROUTER, LENS, SAFE, LP] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => address(0xa00 + n));
const GENESIS = `0x${"ab".repeat(32)}`;
const INIT = `0x${"cd".repeat(32)}`;
const CAP0 = 1_000_000_000n;
const CAP1 = 10n ** 19n;
const LATEST = 10n;
const FINALIZED = 5n;
const DELEGATION = `0xef0100${"63c0c19a282a1b52b07dd5a65b58948a07dae32b"}`;

const gateWith = (blochInc, feeTo = blochInc.address) => ({
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
    feeTo,
    roles: { blochInc },
    reserveCaps: [{ token: T0, cap: String(CAP0) }, { token: T1, cap: String(CAP1) }],
    tokens: [{ token: T0, symbol: "bUSDC", codeHash: keccak256(CODE.token0), bridgeBucketCapacity: "10000000000" }],
    pairs: [{ address: PAIR, token0: T0, token1: T1, codeHash: keccak256(CODE.pair) }],
    transactions: [],
  },
});
const ownerGate = gateWith({ ...OWNER_FEE_PIN });
const safeGate = gateWith({ address: SAFE, codeHash: keccak256(CODE.safe), safe: { threshold: 3, owners: [] } });

/// `ownerCode`: the code the node reports at the owner's address, per block number (default: none at both views).
function fakeNode({ ownerCode = {}, extraCode = {}, held = 7n } = {}) {
  const now = 2_000_000_000n;
  const seen = [];
  const reply = (fn) => {
    switch (fn) {
      case "getReserves": return [500_000_000n, 5n * 10n ** 18n, 1];
      case "reserveCaps": return [CAP0, CAP1];
      case "totalSupply": return 10n ** 13n;
      case "kLast": return 25n * 10n ** 26n;
      case "allPairsLength": return 1n;
      case "INIT_CODE_PAIR_HASH": return INIT;
      case "paused": return false;
      case "pausedUntil": return 0n;
      case "availableToMint": return 1n;
      case "pendingSupply": case "nextSlot": case "mintCount": case "verifier": throw new CallReverted("eth_call: execution reverted");
      case "decimals": return 6;
      case "allowance": return 0n;
      case "position": return { liquidity: held, pendingProtocolLiquidity: 3n, dilutedSupply: 10n, reserveShare0: 1n, reserveShare1: 2n };
      default: throw new Error(`fake: ${fn}`);
    }
  };
  const request = async (method, params) => {
    switch (method) {
      case "eth_chainId": return "0xab162";
      case "eth_getBlockByNumber": {
        const [tag] = params;
        if (tag === "0x0") return { hash: GENESIS };
        const number = tag === "finalized" ? FINALIZED : tag === "latest" ? LATEST : BigInt(tag);
        return { number: `0x${number.toString(16)}`, hash: blockHash(number), timestamp: `0x${(now - (tag === "finalized" ? 6000n : 300n)).toString(16)}`, baseFeePerGas: "0x1" };
      }
      case "eth_getCode": {
        const [a, at] = params;
        seen.push([a, at]);
        if (a === OWNER_FEE_EOA) {
          // The monitor must ask at a block hash with requireCanonical, never at a moving tag.
          assert.equal(at?.requireCanonical, true);
          const key = String(BigInt(at.blockHash));
          const value = Object.hasOwn(ownerCode, key) ? ownerCode[key] : "0x";
          if (value instanceof Error) throw value;
          return value;
        }
        return { [PAIR]: CODE.pair, [T0]: CODE.token0, [T1]: CODE.token1, [FACTORY]: CODE.factory, [ROUTER]: CODE.router, [LENS]: CODE.lens, [SAFE]: CODE.safe, ...extraCode }[a] ?? "0x";
      }
      case "eth_call": {
        const [{ to, data }] = params;
        const { functionName } = decodeFunctionData({ abi: ABI, data });
        const value = functionName === "balanceOf" ? (to === PAIR ? 0n : to === T0 ? 500_000_000n : 5n * 10n ** 18n) : reply(functionName);
        return encodeFunctionResult({ abi: ABI, functionName, result: value });
      }
      default: throw new Error(`fake: ${method}`);
    }
  };
  return { now, request, seen };
}

const deps = (node, extra = {}) => ({
  now: node.now,
  evaluateGate: async () => ({ decision: "liquidity-enabled", finalized: { number: "5" } }),
  verifySafe: async () => { throw new Error("verifySafe must not be called for the owner's plain fee address"); },
  ...extra,
});
const rows = (result, prefix) => result.checks.filter((c) => c.name.startsWith(prefix));
const options = { expectSeeded: true };

test("monitor, owner's fee address: no code at latest and at finalized is OK; no Safe check runs and none is reported", async () => {
  const node = fakeNode();
  const result = await runMonitor(ownerGate, options, node.request, deps(node));
  assert.deepEqual(rows(result, "owner_fee_address").map((c) => [c.name, c.level]), [["owner_fee_address[latest]", OK], ["owner_fee_address[finalized]", OK]]);
  assert.deepEqual(rows(result, "safe_pinned"), []);
  assert.equal(result.level, OK, JSON.stringify(result.checks.filter((c) => c.level)));
  // Both readings were made at the two views' block hashes.
  const asked = node.seen.filter(([a]) => a === OWNER_FEE_EOA).map(([, at]) => at.blockHash);
  assert.deepEqual(asked, [blockHash(LATEST), blockHash(FINALIZED)]);
});

test("monitor, owner's fee address: code or an EIP-7702 delegation at either view is CRIT, named; a node failure is UNKNOWN", async () => {
  for (const [ownerCode, expected, pattern] of [
    [{ [LATEST]: DELEGATION }, [CRIT, OK], /EIP-7702 delegated/],
    [{ [FINALIZED]: DELEGATION }, [OK, CRIT], /EIP-7702 delegated/],
    [{ [LATEST]: DELEGATION.toUpperCase().replace("0X", "0x"), [FINALIZED]: DELEGATION }, [CRIT, CRIT], /EIP-7702 delegated/],
    [{ [LATEST]: "0x6001" }, [CRIT, OK], /has code \(2 bytes\): it must stay a plain account/],
    [{ [LATEST]: "0x00" }, [CRIT, OK], /has code \(1 bytes\)/],
    // Not a code reading at all: the node did not answer the question. UNKNOWN, never OK.
    [{ [LATEST]: null }, [UNKNOWN, OK], /malformed code/],
    [{ [LATEST]: "0x6" }, [UNKNOWN, OK], /malformed code/],
    [{ [LATEST]: "" }, [UNKNOWN, OK], /malformed code/],
    [{ [FINALIZED]: new RpcError("node down") }, [OK, UNKNOWN], /node down/],
  ]) {
    const node = fakeNode({ ownerCode });
    const result = await runMonitor(ownerGate, options, node.request, deps(node));
    const found = rows(result, "owner_fee_address");
    assert.deepEqual(found.map((c) => c.level), expected, JSON.stringify(ownerCode));
    assert.ok(found.some((c) => pattern.test(c.detail)), `${pattern}: ${JSON.stringify(found)}`);
    assert.equal(result.level, Math.max(...expected));
  }
});

test("monitor, owner's fee address: the gate's pin must be exactly {address, empty-code hash} and the fee recipient that address", async () => {
  for (const [gate, pattern] of [
    [gateWith({ ...OWNER_FEE_PIN, safe: { threshold: 3, owners: [] } }), /is not exactly \{address, codeHash: the empty-code hash\}/],
    [gateWith({ ...OWNER_FEE_PIN, codeHash: keccak256(CODE.safe) }), /is not exactly/],
    [gateWith({ ...OWNER_FEE_PIN, address: getAddress(OWNER_FEE_EOA) }, OWNER_FEE_EOA), /is not exactly/],
    [gateWith({ ...OWNER_FEE_PIN }, SAFE), /fee recipient .* is not the owner's fee address/],
  ]) {
    const node = fakeNode();
    const result = await runMonitor(gate, options, node.request, deps(node));
    const found = rows(result, "owner_fee_address");
    assert.deepEqual(found.map((c) => c.level), [CRIT, CRIT], JSON.stringify(gate.deployment.roles));
    assert.ok(found.every((c) => pattern.test(c.detail)), JSON.stringify(found));
  }
});

test("monitor, any other Bloch Inc: the Safe rules are unchanged, and another plain address is never accepted as Bloch Inc", async () => {
  // The Safe gate: safe_pinned at both views through verifySafe, no owner_fee_address row.
  let calls = 0;
  const node = fakeNode();
  const safe = await runMonitor(safeGate, options, node.request, deps(node, { verifySafe: async () => { calls += 1; return {}; } }));
  assert.deepEqual(rows(safe, "safe_pinned").map((c) => c.level), [OK, OK]);
  assert.equal(calls, 2);
  assert.deepEqual(rows(safe, "owner_fee_address"), []);
  const drift = await runMonitor(safeGate, options, node.request, deps(node, { verifySafe: async () => { throw new Error("owners differ"); } }));
  assert.deepEqual(rows(drift, "safe_pinned").map((c) => c.level), [CRIT, CRIT]);
  // Another plain address pinned exactly like the owner's (empty-code hash, no Safe pin): judged as a Safe, CRIT.
  const other = address(0xe0a);
  const plain = await runMonitor(gateWith({ address: other, codeHash: EMPTY_CODE_HASH }), options, node.request, deps(node, { verifySafe: async () => ({}) }));
  assert.deepEqual(rows(plain, "safe_pinned").map((c) => c.level), [CRIT, CRIT]);
  assert.deepEqual(rows(plain, "owner_fee_address"), []);
  // The neighbour of the owner's address (last nibble changed) is not the owner's address.
  const near = `${OWNER_FEE_EOA.slice(0, -1)}5`;
  const neighbour = await runMonitor(gateWith({ address: near, codeHash: EMPTY_CODE_HASH }), options, node.request, deps(node, { verifySafe: async () => ({}) }));
  assert.deepEqual(rows(neighbour, "safe_pinned").map((c) => c.level), [CRIT, CRIT]);
  assert.deepEqual(rows(neighbour, "owner_fee_address"), []);
});

const mainnet = ["--config", "g.json", "--rpc", "http://127.0.0.1:1", "--bridge-plan", "p.json", "--bridge-record", "r.json",
  "--eth-rpc", "http://127.0.0.1:2", "--bridge-vault", address(0x7a), "--bridge-vault-code-hash", `0x${"7c".repeat(32)}`];

test("monitor command line: exactly one of --safe-plan and --owner-fee-address; the address is the pinned one only", () => {
  assert.equal(monitorArguments([...mainnet, "--owner-fee-address", OWNER_FEE_EOA])["owner-fee-address"], OWNER_FEE_EOA);
  assert.equal(monitorArguments([...mainnet, "--safe-plan", "s.json"])["safe-plan"], "s.json");
  // The same 20 bytes in the checksummed spelling are the same address.
  assert.equal(monitorArguments([...mainnet, "--owner-fee-address", getAddress(OWNER_FEE_EOA)])["owner-fee-address"], getAddress(OWNER_FEE_EOA));
  assert.throws(() => monitorArguments(mainnet), /--safe-plan, --bridge-plan and --bridge-record are required \(the mainnet gate\); when Bloch Inc is the owner's plain fee address, --owner-fee-address 0x775a993f09bd80aecf8f8c2ade0c84158e3a0544 replaces --safe-plan/);
  assert.throws(() => monitorArguments([...mainnet, "--safe-plan", "s.json", "--owner-fee-address", OWNER_FEE_EOA]), /exclude each other: one Bloch Inc, never two/);
  for (const other of [address(0xe0a), SAFE, `${OWNER_FEE_EOA.slice(0, -1)}5`, OWNER_FEE_EOA.slice(0, -2), `${OWNER_FEE_EOA}00`, "owner", "0x"]) {
    assert.throws(() => monitorArguments([...mainnet, "--owner-fee-address", other]), /--owner-fee-address must be the owner's pinned fee address 0x775a993f09bd80aecf8f8c2ade0c84158e3a0544/, other);
    // Also in a rehearsal: the option never names another address.
    assert.throws(() => monitorArguments(["--config", "g.json", "--rpc", "http://127.0.0.1:1", "--rehearsal", "--owner-fee-address", other]), /must be the owner's pinned fee address/, other);
  }
  assert.throws(() => monitorArguments([...mainnet, "--owner-fee-address", ""]), /has an empty value/);
  assert.throws(() => monitorArguments([...mainnet, "--owner-fee-address"]), /needs a value/);
  // The owner's-address form still needs the bridge files, the Ethereum RPC, the vault and its code hash (R309-C2).
  const owner = ["--config", "g.json", "--rpc", "http://127.0.0.1:1", "--owner-fee-address", OWNER_FEE_EOA];
  assert.throws(() => monitorArguments(owner), /--safe-plan, --bridge-plan and --bridge-record are required/);
  assert.throws(() => monitorArguments([...owner, "--bridge-plan", "p.json", "--bridge-record", "r.json"]), /--eth-rpc and --bridge-vault are required/);
  assert.throws(() => monitorArguments([...owner, "--bridge-plan", "p.json", "--bridge-record", "r.json", "--eth-rpc", "http://127.0.0.1:2", "--bridge-vault", address(0x7a)]), /--bridge-vault-code-hash is required/);
});

test("monitor command line against the gate file: a mismatch is refused in both directions, before any node is contacted", () => {
  const ownerArgs = { "owner-fee-address": OWNER_FEE_EOA };
  const safeArgs = { "safe-plan": "s.json" };
  assert.match(blochIncMode(ownerArgs, ownerGate).detail, /owner's plain fee address 0x775a993f09bd80aecf8f8c2ade0c84158e3a0544 \(no Safe\)/);
  assert.match(blochIncMode(safeArgs, safeGate).detail, new RegExp(`Bloch Inc is the Safe ${SAFE}`));
  assert.equal(blochIncMode(ownerArgs, ownerGate).level, OK);
  // --owner-fee-address with a gate for anything else.
  assert.throws(() => blochIncMode(ownerArgs, safeGate), /--owner-fee-address is given, but the gate file's Bloch Inc is 0x0+a07, not the owner's plain fee address/);
  assert.throws(() => blochIncMode(ownerArgs, gateWith({ address: address(0xe0a), codeHash: EMPTY_CODE_HASH })), /not the owner's plain fee address/);
  assert.throws(() => blochIncMode(ownerArgs, { deployment: { roles: {} } }), /Bloch Inc is missing/);
  assert.throws(() => blochIncMode(ownerArgs, gateWith({ ...OWNER_FEE_PIN, safe: { threshold: 3, owners: [] } })), /pin is not exactly/);
  assert.throws(() => blochIncMode(ownerArgs, gateWith({ ...OWNER_FEE_PIN, codeHash: keccak256(CODE.safe) })), /pin is not exactly/);
  assert.throws(() => blochIncMode(ownerArgs, gateWith({ ...OWNER_FEE_PIN, address: getAddress(OWNER_FEE_EOA) }, OWNER_FEE_EOA)), /pin is not exactly/);
  assert.throws(() => blochIncMode(ownerArgs, gateWith({ ...OWNER_FEE_PIN }, SAFE)), /fee recipient is 0x0+a07, not 0x775a/);
  // --safe-plan with a gate whose Bloch Inc is the owner's address.
  assert.throws(() => blochIncMode(safeArgs, ownerGate), /--safe-plan is given, but the gate file's Bloch Inc is the owner's plain fee address .*use --owner-fee-address/);
  assert.throws(() => blochIncMode(safeArgs, gateWith({ ...OWNER_FEE_PIN, address: getAddress(OWNER_FEE_EOA) })), /--safe-plan is given/);
  // A rehearsal with neither option: the gate file decides, and the row says which.
  assert.match(blochIncMode({}, ownerGate).detail, /^rehearsal: Bloch Inc is the owner's plain fee address/);
  assert.match(blochIncMode({}, safeGate).detail, /^rehearsal: Bloch Inc is the multisig/);

  // The real command line: exit UNKNOWN (3) with the reason; the RPC URL is a closed port and is never reached.
  const dir = mkdtempSync(join(tmpdir(), "r19-mode-"));
  try {
    const cli = fileURLToPath(new URL("./dex-monitor.mjs", import.meta.url));
    const file = (name, gate) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(gate)); return path; };
    const exit = ["--bridge-plan", join(dir, "absent-plan.json"), "--bridge-record", join(dir, "absent-record.json"), "--eth-rpc", "http://127.0.0.1:9", "--bridge-vault", address(0x7a), "--bridge-vault-code-hash", `0x${"7c".repeat(32)}`];
    for (const [gate, bloch, pattern] of [
      [safeGate, ["--owner-fee-address", OWNER_FEE_EOA], /UNKNOWN dex-monitor: --owner-fee-address is given, but the gate file's Bloch Inc is/],
      [ownerGate, ["--safe-plan", join(dir, "absent-safe.json")], /UNKNOWN dex-monitor: --safe-plan is given, but the gate file's Bloch Inc is the owner's plain fee address/],
      [ownerGate, ["--owner-fee-address", address(0xe0a)], /UNKNOWN dex-monitor: --owner-fee-address must be the owner's pinned fee address/],
    ]) {
      const run = spawnSync(process.execPath, [cli, "--config", file("gate.json", gate), "--rpc", "http://127.0.0.1:9", ...bloch, ...exit, "--json"], { encoding: "utf8" });
      assert.equal(run.status, UNKNOWN, run.stderr);
      assert.match(run.stderr, pattern);
      assert.equal(run.stdout, "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the two monitor units differ only in the Bloch Inc option; the owner's-address unit's command line is complete", () => {
  const read = (name) => readFileSync(new URL(`./systemd/${name}`, import.meta.url), "utf8");
  const safeUnit = read("bloch-dex-monitor.service");
  const ownerUnit = read("bloch-dex-monitor-owner-address.service");
  // Every directive line (not a comment, not Description, not ExecStart) is identical, in the same order.
  const directives = (text) => text.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("Description=") && !line.startsWith("ExecStart="));
  assert.deepEqual(directives(ownerUnit), directives(safeUnit));
  assert.ok(directives(safeUnit).includes("NoNewPrivileges=true") && directives(safeUnit).includes("ProtectSystem=strict") && directives(safeUnit).includes("SuccessExitStatus=0 1 2"));
  const exec = (text) => { const lines = text.split("\n").filter((line) => line.startsWith("ExecStart=")); assert.equal(lines.length, 1); return lines[0]; };
  assert.ok(exec(safeUnit).includes(" --safe-plan ${DEX_SAFE_PLAN} "));
  assert.equal(exec(ownerUnit), exec(safeUnit).replace(" --safe-plan ${DEX_SAFE_PLAN} ", " --owner-fee-address ${DEX_OWNER_FEE_ADDRESS} "));
  assert.ok(!ownerUnit.split("\n").some((line) => !line.startsWith("#") && /safe-plan|DEX_SAFE_PLAN/.test(line)));
  // The comment lines the Safe unit carries (what an empty variable does, where the report goes) are all kept.
  const comments = (text) => text.split("\n").filter((line) => line.startsWith("#"));
  for (const line of comments(safeUnit)) assert.ok(comments(ownerUnit).includes(line), line);

  // With every variable set the command line is accepted; with any one empty, or another address, it is not.
  const words = exec(ownerUnit).match(/dex-monitor\.mjs (.*)$/)[1].split(" ");
  const values = { DEX_GATE: "g.json", DEX_OWNER_FEE_ADDRESS: OWNER_FEE_EOA, DEX_BUSDC_BRIDGE_PLAN: "p.json", DEX_BUSDC_BRIDGE_RECORD: "r.json", DEX_RPC: "http://127.0.0.1:1", DEX_LP_RECIPIENT: LP,
    DEX_LP_MIN_SHARES: "4999999999900", DEX_KEEPER_MAX_TX: "48", DEX_KEEPER_BUDGET_WEI: "50000000000000000", DEX_ETH_RPC: "https://eth.example.org", DEX_BUSDC_VAULT: address(0x7a),
    DEX_BUSDC_VAULT_CODE_HASH: `0x${"7c".repeat(32)}` };
  const expand = (env) => words.map((word) => word.replace(/^\$\{([A-Z0-9_]+)\}$/, (_, name) => { assert.ok(Object.hasOwn(values, name), name); return env[name] ?? ""; }));
  const parsed = monitorArguments(expand(values));
  assert.equal(parsed["owner-fee-address"], OWNER_FEE_EOA);
  assert.equal(parsed["safe-plan"], undefined);
  for (const name of Object.keys(values)) assert.throws(() => monitorArguments(expand({ ...values, [name]: "" })), /has an empty value/, name);
  assert.throws(() => monitorArguments(expand({ ...values, DEX_OWNER_FEE_ADDRESS: SAFE })), /must be the owner's pinned fee address/);
  // The environment example names both forms, the Safe one active and the owner's one as the documented replacement.
  const example = read("dex-monitor.env.example");
  assert.match(example, /^DEX_SAFE_PLAN=\/etc\/bloch-dex-ops\/safe\.plan\.json$/m);
  assert.match(example, new RegExp(`^# DEX_OWNER_FEE_ADDRESS=${OWNER_FEE_EOA}$`, "m"));
  assert.match(example, /bloch-dex-monitor-owner-address\.service/);
});

test("fee redemption: only the owner's exact pin is a plain signer; assemble refuses it by name; every other Bloch Inc keeps the Safe", () => {
  const deployment = (gate) => ({ feeTo: gate.deployment.feeTo, safe: gate.deployment.roles.blochInc });
  assert.equal(redeemSigner(deployment(ownerGate)), "owner-address");
  assert.equal(redeemSigner(deployment(safeGate)), "safe");
  assert.throws(() => refuseAssembleForOwnerAddress(deployment(ownerGate)), /Bloch Inc is the owner's plain fee address 0x775a993f09bd80aecf8f8c2ade0c84158e3a0544: there is no Safe transaction to assemble.*one removeLiquidity.*never a transfer to the pair followed by burn/s);
  assert.doesNotThrow(() => refuseAssembleForOwnerAddress(deployment(safeGate)));
  for (const gate of [
    gateWith({ ...OWNER_FEE_PIN, address: getAddress(OWNER_FEE_EOA) }, OWNER_FEE_EOA),
    gateWith({ ...OWNER_FEE_PIN, safe: { threshold: 3, owners: [] } }),
    gateWith({ ...OWNER_FEE_PIN }, SAFE),
  ]) assert.throws(() => redeemSigner(deployment(gate)), /but not exactly \(lower case, no Safe pin, fee recipient that address\): refused/);
  // Another plain address has no Safe pin: refused, never treated as the owner's.
  assert.throws(() => redeemSigner(deployment(gateWith({ address: address(0xe0a), codeHash: EMPTY_CODE_HASH }))), /has no Safe pin/);
  assert.throws(() => redeemSigner(deployment(gateWith({ address: `${OWNER_FEE_EOA.slice(0, -1)}5`, codeHash: EMPTY_CODE_HASH }))), /has no Safe pin/);
});

test("fee redemption plan for the owner's fee address: approve for the exact shares, then one removeLiquidity to that address; refused when it has code", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "r19-redeem-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const printed = [];
  context.mock.method(console, "log", (line) => printed.push(line));
  const HELD = 1_000_000_000n;
  const node = fakeNode({ held: HELD });
  const out = join(dir, "plan");
  const code = await planRedemption({ rpc: "http://127.0.0.1:18955", out }, deploymentFromGate(ownerGate), node.request);
  assert.equal(code, OK);
  const report = JSON.parse(printed.at(-1));
  assert.equal(report.decision, "send-from-the-owner-address");
  assert.equal(report.signer, OWNER_FEE_EOA);
  assert.equal(report.liquidity, String(HELD));
  assert.equal(report.transactions.length, 2);
  const [approve, remove] = report.transactions.map((t) => JSON.parse(readFileSync(t.tx, "utf8")));
  assert.deepEqual([approve.from, approve.to, approve.value, approve.chainId], [OWNER_FEE_EOA, PAIR, "0", 700770]);
  assert.deepEqual(decodeFunctionData({ abi: ABI, data: approve.data }), { functionName: "approve", args: [getAddress(ROUTER), HELD] });
  assert.deepEqual([remove.from, remove.to], [OWNER_FEE_EOA, ROUTER]);
  const call = decodeFunctionData({ abi: ABI, data: remove.data });
  assert.equal(call.functionName, "removeLiquidity");
  assert.deepEqual(call.args.slice(0, 3), [getAddress(T0), getAddress(T1), HELD]);
  // The recipient is the fee address itself; the minimums are the plan's (1% below the expected amounts, rounded down).
  assert.equal(call.args[5], getAddress(OWNER_FEE_EOA));
  assert.deepEqual([call.args[3], call.args[4]], [BigInt(report.minimum.amount0), BigInt(report.minimum.amount1)]);
  assert.ok(BigInt(report.minimum.amount0) > 0n && BigInt(report.minimum.amount0) <= BigInt(report.expected.amount0));
  assert.ok(BigInt(report.minimum.amount1) > 0n && BigInt(report.minimum.amount1) <= BigInt(report.expected.amount1));
  // Never a transfer to the pair or a bare burn, and no Safe file.
  for (const t of [approve, remove]) assert.ok(!["transfer", "burn"].includes(decodeFunctionData({ abi: ABI, data: t.data }).functionName));
  assert.ok(report.transactions.every((t) => /owner-tx-[12]\.json$/.test(t.tx) && t.command.startsWith(`cast send ${JSON.parse(readFileSync(t.tx, "utf8")).to} 0x`)));
  // The plan read the address's code at the plan's block hash, and refuses a delegation or any code.
  assert.ok(node.seen.some(([a, at]) => a === OWNER_FEE_EOA && at.blockHash === blockHash(LATEST)));
  for (const [bad, pattern] of [[DELEGATION, /has code \(an EIP-7702 delegation\) at block 10: do not sign/], ["0x6001", /has code at block 10: do not sign/], [null, /has code at block 10: do not sign/]]) {
    const delegated = fakeNode({ held: HELD, ownerCode: { [LATEST]: bad } });
    await assert.rejects(planRedemption({ rpc: "http://127.0.0.1:18955", out: join(dir, "refused") }, deploymentFromGate(ownerGate), delegated.request), pattern);
  }
  assert.throws(() => readFileSync(join(dir, "refused", "owner-tx-1.json")), /ENOENT/);
});
