// Review r15, second pass (agent 309), findings R309-2P-8 to 2P-15 in the ops tools, as regression tests: the
// reviewer's demonstrations (scripts/review-r15b/passD-*.test.mjs, commit e4d9ebd on codex/dex-review-r15b-20261110)
// with the assertions turned to the corrected behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CRIT, OK, WARN, parseArgs } from "./dex-ops-lib.mjs";
import { KEEPER_MAX_AGE_SECONDS, checkKeeperState, gateMode, monitorArguments } from "./dex-monitor.mjs";
import { DEFAULTS, requireSigner, runKeeper } from "./dex-skim-keeper.mjs";
import { planRemoval, removalFloor, seedFloorShares } from "./dex-seed-plan.mjs";
import { checkForm } from "./opening-form.mjs";
import { account, gate, mulberry32, signer, simNode } from "./keeper-sim.mjs";

const KEEPER_OPTIONS = ["config", "rpc", "keeper", "state", "budget-wei", "max-tx", "max-fee-wei", "tip-wei", "max-tip-wei", "soft-share-bps",
  "hard-reserve-bps", "max-gas", "floor-bps", "ceiling-floor-wei", "cooldown-s", "pending-timeout-s", "rebroadcast-s", "replace-after-s",
  "max-replacements", "max-clock-skew-s", "eth-rpc", "bridge-vault", "bridge-vault-code-hash", "bridge-token"];
const keeperArgs = (argv) => parseArgs(argv, { flags: ["execute"], options: KEEPER_OPTIONS });
const base = ["--config", "g.json", "--rpc", "http://127.0.0.1:9", "--keeper", `0x${"1".repeat(40)}`, "--state", "s.json"];
const cli = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const PINNED = JSON.parse(readFileSync(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8")).l2.genesisHash;

// ---- R309-2P-8: stray words and swallowed options

test("R309-2P-8: a word that is not an option is refused: -execute, execute, a pasted long dash, a single-hyphen limit", () => {
  for (const typo of ["-execute", "execute", "—execute", "–execute"]) {
    assert.throws(() => keeperArgs([...base, "--budget-wei", "50000000000000000", typo, "--", "--keystore", "/k"]), /unexpected argument/, typo);
  }
  assert.throws(() => keeperArgs([...base, "-max-tx", "12"]), /unexpected argument -max-tx/);
  // After the bare `--` the signer arguments stay free-form.
  assert.deepEqual(keeperArgs([...base, "--execute", "--", "-k", "x", "plain"]).rest, ["-k", "x", "plain"]);
  // A flag twice is refused like an option twice.
  assert.throws(() => keeperArgs([...base, "--execute", "--execute"]), /--execute is given twice/);
});

test("R309-2P-8: a sub-command is the first word and one of the tool's own; anywhere else it is refused", () => {
  const spec = { commands: ["plan", "remove"], options: ["config"] };
  assert.deepEqual(parseArgs(["plan", "--config", "g"], spec)._, ["plan"]);
  assert.throws(() => parseArgs(["--config", "g", "plan"], spec), /unexpected argument plan/);
  assert.throws(() => parseArgs(["plan", "remove", "--config", "g"], spec), /unexpected argument remove/);
  assert.throws(() => parseArgs(["plam", "--config", "g"], spec), /unexpected argument plam \(commands: plan, remove\)/);
  assert.throws(() => parseArgs(["--config", "g"], spec), /the first argument must be one of: plan, remove/);
});

test("R309-2P-8: a value that begins with -- is refused: the next option is not swallowed", () => {
  assert.throws(() => keeperArgs([...base, "--bridge-token", "--execute", "--", "--keystore", "/k"]), /--bridge-token needs a value, but the next word is "--execute"/);
  assert.throws(() => monitorArguments(["--config", "g", "--rpc", "r", "--rehearsal", "--ref-price", "--expect-seeded"]), /--ref-price needs a value/);
});

test("R309-2P-8 (command line): every ops tool stops at a stray word before it reads a file or a node", () => {
  const dir = mkdtempSync(join(tmpdir(), "r15b-args-"));
  try {
    const absent = join(dir, "absent-gate.json");
    const runs = [
      ["dex-skim-keeper.mjs", ["--config", absent, "--rpc", "http://127.0.0.1:9", "--keeper", `0x${"1".repeat(40)}`, "--state", join(dir, "state.json"), "-max-tx", "12", "execute"]],
      ["dex-skim-keeper.mjs", ["--config", absent, "--rpc", "http://127.0.0.1:9", "--keeper", `0x${"1".repeat(40)}`, "--state", join(dir, "state.json"), "execute"]],
      ["dex-monitor.mjs", ["--config", absent, "--rpc", "http://127.0.0.1:9", "--rehearsal", "json"]],
      ["dex-seed-plan.mjs", ["plan", "--config", absent, "--rpc", "http://127.0.0.1:9", "--price", "100", "-to", "0x1"]],
      ["dex-seed-plan.mjs", ["--config", absent, "plan"]],
      ["dex-fee-redeem.mjs", ["plan", "--config", absent, "--rpc", "http://127.0.0.1:9", "out"]],
      ["opening-form.mjs", ["check", "--form", absent, "apply"]],
      ["dex-storage-footprint.mjs", ["--config", absent, "--rpc", "http://127.0.0.1:9", "--state", join(dir, "s.json"), "json"]],
    ];
    for (const [tool, argv] of runs) {
      const run = spawnSync(process.execPath, [cli(tool), ...argv], { encoding: "utf8" });
      assert.notEqual(run.status, 0, `${tool} ${argv.join(" ")}`);
      assert.match(run.stderr, /unexpected argument|the first argument must be one of/, `${tool}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /absent-gate\.json|ENOENT/, tool);
      assert.equal(run.stdout, "", tool);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- R309-2P-9: signer arguments

test("R309-2P-9 (command line): an empty signer argument after -- stops the keeper at start", () => {
  const dir = mkdtempSync(join(tmpdir(), "r15b-signer-"));
  try {
    for (const execute of [["--execute"], []]) {
      const run = spawnSync(process.execPath, [cli("dex-skim-keeper.mjs"), "--config", join(dir, "absent-gate.json"), "--rpc", "http://127.0.0.1:9", "--keeper", `0x${"1".repeat(40)}`,
        "--state", join(dir, "state.json"), ...execute, "--", "--keystore", "", "--password-file", ""], { encoding: "utf8" });
      assert.equal(run.status, CRIT, run.stderr);
      assert.match(run.stderr, /a signer argument after -- is empty/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R309-2P-9: the signer must open, without a prompt, to the configured keeper address", async () => {
  const keeper = `0x${"ab".repeat(20)}`;
  const answers = (stdout) => async (command, argv) => { assert.equal(command, "cast"); assert.deepEqual(argv.slice(0, 2), ["wallet", "address"]); return { stdout }; };
  assert.equal(await requireSigner(["--keystore", "/k"], keeper, answers(`0x${"AB".repeat(20)}\n`)), `0x${"AB".repeat(20)}`);
  await assert.rejects(requireSigner(["--keystore", "/k"], keeper, answers(`0x${"cd".repeat(20)}\n`)), /the signer after -- is 0x(cd){20}, not the configured --keeper/);
  await assert.rejects(requireSigner(["--keystore", "/k"], keeper, answers("Enter keystore password:")), /do not resolve to an address/);
  // cast's own failure: the last line of its stderr is shown, never the command line with the signer arguments.
  const failing = async () => { throw Object.assign(new Error("Command failed: cast wallet address --keystore /secret/path"), { stderr: "Error: \nNo such file or directory (os error 2)\n", code: 1 }); };
  await assert.rejects(requireSigner(["--keystore", "/secret/path"], keeper, failing), (error) => {
    assert.match(error.message, /do not open a signer \(cast wallet address: No such file or directory/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  const hanging = async () => { throw Object.assign(new Error("killed"), { killed: true, stderr: "" }); };
  await assert.rejects(requireSigner(["--ledger"], keeper, hanging), /no answer in 30 s; it may be waiting for a prompt/);
});

// ---- R309-2P-10, 2P-11: the liveness stamp

const options = (extra = {}) => ({
  keeper: account.address, execute: true, budgetWei: DEFAULTS.budgetWei, maxTx: DEFAULTS.maxTx, maxFeeWei: DEFAULTS.maxFeeWei,
  tipWei: DEFAULTS.tipWei, maxGas: DEFAULTS.maxGas, floorBps: DEFAULTS.floorBps, cooldownSeconds: DEFAULTS.cooldownSeconds,
  pendingTimeoutSeconds: DEFAULTS.pendingTimeoutSeconds, maxTipWei: DEFAULTS.maxTipWei, softShareBps: DEFAULTS.softShareBps,
  hardReserveBps: DEFAULTS.hardReserveBps, maxClockSkewSeconds: DEFAULTS.maxClockSkewSeconds, ...extra,
});
const emptyState = () => ({ schema: "postern.dex.skim-keeper.v1", txs: [], consecutiveWasted: 0, nextAllowedAt: 0 });
async function pass(node, state, now, extra) {
  const saved = [];
  const outcome = await runKeeper(gate, options(extra), state, { request: node.request, sign: signer, now, save: (s) => saved.push(JSON.stringify(s)), random: () => 0n });
  return { outcome, state: JSON.parse(saved.at(-1) ?? JSON.stringify(state)) };
}
function monitor(state, now) {
  const dir = mkdtempSync(join(tmpdir(), "r15b-monitor-"));
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify(state));
    const rows = [];
    checkKeeperState(path, BigInt(now), (name, level, detail) => rows.push({ name, level, detail }), { maxTx: 48, budgetWei: DEFAULTS.budgetWei });
    assert.equal(rows.length, 1);
    return rows[0];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("R309-2P-10: a pass stopped by the clock guard does not stamp, and a stamp from the future is CRIT in the monitor", async () => {
  const node = simNode(mulberry32(1));
  const t0 = node.chain.time + 300;
  node.mineBlock(t0);
  // A good pass first, then one pass with the host clock a day ahead (an NTP step), then the keeper stops.
  const good = await pass(node, emptyState(), t0);
  assert.equal(good.state.lastPass.at, t0);
  const skewed = await pass(node, good.state, t0 + 86_400);
  assert.equal(skewed.outcome.action, "clock-or-head-stale");
  assert.equal(skewed.state.lastPass.at, t0, "the stamp of the last usable pass stands");
  // Six hours later, true time: the keeper is dead and the monitor says so.
  const row = monitor(skewed.state, t0 + 6 * 3600);
  assert.equal(row.level, CRIT);
  assert.match(row.detail, /it is not running/);
  // A keeper that never had a usable pass has no stamp at all: attention, not OK.
  const never = await pass(node, emptyState(), t0 + 86_400);
  assert.equal(never.state.lastPass, undefined);
  assert.equal(monitor(never.state, t0 + 60).level, WARN);
  // A stamp written by the first-pass keeper (stamped with the bad clock) is refused by the monitor as invalid.
  const old = monitor({ ...emptyState(), lastPass: { at: t0 + 86_400, action: "clock-or-head-stale", level: 1, execute: true } }, t0 + 6 * 3600);
  assert.equal(old.level, CRIT);
  assert.match(old.detail, /in the future of this host's clock: the stamp is invalid/);
});

test("R309-2P-11: a keeper without --execute stamps a dry run, and keeper_budget is not OK while nothing can be published", async () => {
  const node = simNode(mulberry32(2));
  let now = node.chain.time, state = emptyState();
  for (let i = 0; i < 4; i++) {
    now += 300;
    node.mineBlock(now);
    const r = await pass(node, state, now, { execute: false });
    assert.equal(r.outcome.action, "would-skim");
    assert.equal(r.state.lastPass.execute, false);
    state = r.state;
  }
  assert.equal(node.chain.handed.length, 0, "nothing was ever published");
  const row = monitor(state, now + 60);
  assert.equal(row.level, WARN);
  assert.match(row.detail, /last pass 60 s ago: would-skim \(DRY RUN: the keeper runs without --execute and publishes nothing\)/);
  // The same keeper with --execute is OK again at its next pass.
  now += 300;
  node.mineBlock(now);
  const live = await pass(node, state, now);
  assert.equal(live.state.lastPass.execute, true);
});

test("R309-C3 still holds: a stamp older than 900 s is CRIT, a missing file WARN, a missing stamp WARN", () => {
  const now = 2_000_000_000;
  const stamp = (at) => ({ ...emptyState(), lastPass: { at, action: "nothing-to-do", level: 0, execute: true } });
  assert.equal(monitor(stamp(now - KEEPER_MAX_AGE_SECONDS - 1), now).level, CRIT);
  assert.equal(monitor(stamp(now - KEEPER_MAX_AGE_SECONDS), now).level, OK);
  assert.equal(monitor(emptyState(), now).level, WARN);
  const rows = [];
  checkKeeperState("/nonexistent/r15b/state.json", BigInt(now), (name, level) => rows.push(level), { maxTx: 48, budgetWei: 1n });
  assert.deepEqual(rows, [WARN]);
});

// ---- R309-2P-13: --rehearsal and the pinned genesis

test("R309-2P-13: --rehearsal is refused for the pinned mainnet genesis; the private rehearsal's second flag puts a WARN row into every report", () => {
  const mainnet = { chain: { id: 700770, genesisHash: PINNED } };
  const elsewhere = { chain: { id: 700770, genesisHash: `0x${"9".repeat(64)}` } };
  const args = (...extra) => monitorArguments(["--config", "g.json", "--rpc", "http://127.0.0.1:18955", ...extra]);
  assert.throws(() => gateMode(args("--rehearsal", "--json"), mainnet), /this gate file is for the pinned mainnet genesis: run without --rehearsal/);
  const both = gateMode(args("--rehearsal", "--rehearsal-on-pinned-genesis"), mainnet);
  assert.equal(both.level, WARN);
  assert.match(both.detail, /REHEARSAL MODE on the pinned mainnet genesis/);
  assert.equal(gateMode(args("--rehearsal"), elsewhere).level, OK);
  assert.throws(() => args("--rehearsal-on-pinned-genesis"), /--rehearsal-on-pinned-genesis goes with --rehearsal/);
  // Without --rehearsal the whole mainnet command line is required, as before (R309-C2).
  assert.throws(() => args("--json"), /--safe-plan, --bridge-plan and --bridge-record are required/);
});

test("R309-2P-13 (command line): the monitor with --rehearsal on a pinned-genesis gate file exits UNKNOWN before it contacts a node", () => {
  const dir = mkdtempSync(join(tmpdir(), "r15b-mode-"));
  try {
    const file = join(dir, "gate.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, domain: "postern.dex.finality-gate.v1", chain: { id: 700770, genesisHash: PINNED }, deployment: {} }));
    const run = spawnSync(process.execPath, [cli("dex-monitor.mjs"), "--config", file, "--rpc", "http://127.0.0.1:9", "--rehearsal"], { encoding: "utf8" });
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /UNKNOWN dex-monitor: .*pinned mainnet genesis/s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- R309-2P-14: the removal floor

test("R309-2P-14: a fraction stated below the real seed is refused at the first removal; the floor never follows the holding down", () => {
  const WAD = 10n ** 18n;
  const caps = { wrappedCap: 10n * WAD, quoteCap: 1_000_000_000n, price: 100_000_000n };
  const trueSeed = seedFloorShares({ ...caps, fractionBps: 5000n }).seedShares; // the real seed: 50% of the cap
  const stated = seedFloorShares({ ...caps, fractionBps: 5n }).seedShares; // typed 5 instead of 5000
  const refused = removalFloor({ seedShares: stated, held: trueSeed });
  assert.match(refused.refused, /the fraction stated is below the real seed/);
  assert.equal(refused.floorShares, undefined);
  // With the absolute floor (10% of the real seed, the monitor's --lp-min-shares) three removals in a row stop at it.
  const absolute = trueSeed / 10n;
  let held = trueSeed;
  for (let i = 0; i < 3; i++) {
    const floor = removalFloor({ seedShares: stated, held, floorShares: absolute });
    if (floor.refused) break;
    const shares = held - floor.floorShares;
    if (shares === 0n) break;
    assert.equal(planRemoval({ held, shares, floorShares: floor.floorShares }).decision, "remove");
    held -= shares;
  }
  assert.equal(held, absolute, "10% of the seed is left, not 0.1%");
  // With the true fraction the second removal is refused, as before.
  const left = removalFloor({ seedShares: trueSeed, held: trueSeed }).floorShares;
  assert.equal(planRemoval({ held: left, shares: 1n, floorShares: removalFloor({ seedShares: trueSeed, held: left }).floorShares }).decision, "refuse-floor");
});

// ---- R309-2P-15: the opening form

const committed = JSON.parse(readFileSync(new URL("../../deployments/mainnet/dex-mainnet.config.json", import.meta.url), "utf8"));
const template = JSON.parse(readFileSync(new URL("../../deployments/mainnet/opening-form.json", import.meta.url), "utf8"));
const a = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const H = `0x${"ab".repeat(32)}`;
const blochInc = {
  address: a(0x5afe), codeHash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  safe: {
    version: "1.4.1",
    singleton: { address: a(0x51), codeHash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff" },
    fallbackHandler: { address: a(0x52), codeHash: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9" }, threshold: 3, owners: [1, 2, 3, 4, 5].map((i) => a(0x100 + i)) },
};
function filled(extra = {}) {
  const f = structuredClone(template);
  Object.assign(f, { openingPrice: "100", firstDepositor: a(0xd1), lpRecipient: a(0x1b), ...extra });
  f.seederExit = { policy: "keep-floor", floorBps: 1000 };
  Object.assign(f.keeper, { address: a(0xee), keystore: "/etc/k.json", passwordFile: "/etc/k.pw" });
  f.bridgeStatus = { ethRpcUrl: "https://eth.example.org", vault: a(0x7a), vaultCodeHash: `0x${"7c".repeat(32)}` };
  f.fromEarlierSteps = { dexDeployer: a(0xde), safeOwners: [1, 2, 3, 4, 5].map((i) => a(0x100 + i)), busdcToken: a(0x05d), busdcCodeHash: H, busdcBucketCapacity: "10000000000" };
  return f;
}
const check = (form) => checkForm(form, { blochInc, committedConfig: committed });

test("R309-2P-15: the LP recipient may not be the DEX deployer key", () => {
  assert.deepEqual(check(filled()).problems, []);
  const r = check(filled({ lpRecipient: a(0xde) }));
  assert.match(r.problems.join("\n"), /lpRecipient equals fromEarlierSteps\.dexDeployer: each key has one role/);
  // The neighbouring pairs are refused as before.
  assert.match(check(filled({ lpRecipient: a(0xee) })).problems.join("\n"), /keeper\.address must be its own hot key/);
});

test("R309-2P-15: the documents present the generic gate as the tool of rehearsal chains only", () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  for (const doc of ["docs/MAINNET-READINESS.md", "docs/PAIR-SUPPORT.md"]) {
    const text = read(doc);
    for (const line of text.split("\n").filter((l) => l.includes("check-finality-gate.mjs"))) {
      assert.match(line, /rehearsal|refuses/i, `${doc}: ${line}`);
    }
  }
});
void OK;
