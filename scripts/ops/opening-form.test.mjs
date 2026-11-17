// node --test scripts/ops/opening-form.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkForm, seedAmounts } from "./opening-form.mjs";
import { MAX_FRACTION_BPS, planOpening, seedFloorShares } from "./dex-seed-plan.mjs";

const committed = JSON.parse(readFileSync(new URL("../../deployments/mainnet/dex-mainnet.config.json", import.meta.url), "utf8"));
const template = JSON.parse(readFileSync(new URL("../../deployments/mainnet/opening-form.json", import.meta.url), "utf8"));
const a = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const H = `0x${"ab".repeat(32)}`;
const VAULT_CODE = `0x${"7c".repeat(32)}`;
const blochInc = {
  // Code hashes are the Safe 1.4.1 runtimes (from a rehearsal's deploy-safe.mjs blochinc); addresses are arbitrary.
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
  f.bridgeStatus = { ethRpcUrl: "https://eth.example.org", vault: a(0x7a), vaultCodeHash: VAULT_CODE };
  f.fromEarlierSteps = { dexDeployer: a(0xde), safeOwners: [1, 2, 3, 4, 5].map((i) => a(0x100 + i)), busdcToken: a(0x05d), busdcCodeHash: H, busdcBucketCapacity: "10000000000" };
  return f;
}
const check = (form, opts = {}) => checkForm(form, { blochInc, committedConfig: committed, ...opts });

test("the committed template is refused field by field", () => {
  const { problems } = checkForm(template, { committedConfig: committed });
  assert.ok(problems.length >= 10);
  assert.ok(problems.some((p) => p.startsWith("openingPrice")));
  assert.ok(problems.some((p) => p.startsWith("seederExit.policy")));
});

test("a filled form passes deploy-dex's own validation, with the cap from the price", () => {
  const { problems, values } = check(filled());
  assert.deepEqual(problems, []);
  assert.equal(values.price, 100_000_000n);
  assert.equal(values.quoteCap, 1_000_000_000n);
  assert.match(values.dexConfigSha256, /^0x[0-9a-f]{64}$/);
  assert.equal(values.dexConfig.firstDepositor, a(0xd1));
  assert.equal(values.dexConfig.openingPrice.quotePerWrapped, "100000000");
});

test("auto cap: 10 x P below 100, the bucket limit above it; a cap outside the band is refused", () => {
  assert.equal(check(filled({ openingPrice: "25.5" })).values.quoteCap, 255_000_000n);
  assert.equal(check(filled({ openingPrice: "400" })).values.quoteCap, 1_000_000_000n);
  const high = check(filled({ openingPrice: "50", busdcCap: "1000" }));
  assert.ok(high.problems.some((p) => /too high for the opening price/.test(p)), high.problems.join("; "));
});

test("the seed and share count equal dex-seed-plan.mjs on an empty pair", () => {
  for (const [p, cap] of [["100", 1_000_000_000n], ["25.5", 255_000_000n], ["400", 1_000_000_000n]]) {
    const price = BigInt(Math.round(Number(p) * 1e6));
    const s = seedAmounts({ wrappedCap: 10n * 10n ** 18n, quoteCap: cap, price, fractionBps: 5000n });
    const side = (c) => ({ reserve: 0n, balance: 0n, cap: c });
    const plan = planOpening({ wrapped: side(10n * 10n ** 18n), quote: side(cap), totalSupply: 0n, price, fractionBps: 5000n });
    assert.equal(s.wrapped, plan.depositWrapped);
    assert.equal(s.quote, plan.depositQuote);
  }
});

test("the depositor must be its own key", () => {
  for (const clash of [{ lpRecipient: a(0xd1) }, { firstDepositor: a(0x101) }, { firstDepositor: a(0x5afe) }, { firstDepositor: a(0xde) }]) {
    const { problems } = check(filled(clash));
    assert.ok(problems.some((p) => p.startsWith("firstDepositor equals")), JSON.stringify(clash));
  }
  const f = filled(); f.keeper.address = a(0xd1);
  assert.ok(check(f).problems.some((p) => p.includes("keeper.address")));
});

test("opening owners are five distinct Safe owners and match the supplied Safe pin", () => {
  for (const owners of [[], [a(0x101)], Array(5).fill(a(0x101)), [1, 2, 3, 4, 6].map((i) => a(0x100 + i))]) {
    const f = filled(); f.fromEarlierSteps.safeOwners = owners;
    assert.ok(check(f).problems.some((p) => /safeOwners/.test(p)), JSON.stringify(owners));
  }
  const reordered = filled(); reordered.fromEarlierSteps.safeOwners.reverse();
  assert.deepEqual(check(reordered).problems, [], "owner order is not authority");
});

test("a substituted owner list cannot hide keeper reuse of an actual Safe owner", () => {
  const f = filled();
  f.keeper.address = blochInc.safe.owners[0];
  f.fromEarlierSteps.safeOwners = [6, 7, 8, 9, 10].map((i) => a(0x100 + i));
  const { problems } = check(f);
  assert.ok(problems.some((p) => /safeOwners/.test(p)));
  assert.ok(problems.some((p) => /keeper.address/.test(p)));
});

test("exit policy: the floor in shares, at least 10%, and no full exit (round 10)", () => {
  const keep = check(filled()).values;
  assert.equal(keep.floorShares, keep.seed.shares / 10n);
  // The form's floor is the planner's floor for the same seed (the remove command and the monitor use one number).
  const planner = seedFloorShares({ wrappedCap: 10n * 10n ** 18n, quoteCap: keep.quoteCap, price: keep.price, fractionBps: keep.fractionBps });
  assert.equal(keep.seed.shares, planner.seedShares);
  assert.equal(keep.floorShares, planner.floorShares);
  const f = filled(); f.seederExit = { policy: "full-exit", floorBps: 0 };
  assert.ok(check(f).problems.some((p) => p.includes("full-exit is not allowed")));
  const low = filled(); low.seederExit = { policy: "keep-floor", floorBps: 999 };
  assert.ok(check(low).problems.some((p) => p.includes("floorBps must be 1000 to 10000")));
  const high = filled(); high.seederExit = { policy: "keep-floor", floorBps: 2000 };
  assert.deepEqual(check(high).problems, []);
  assert.equal(check(high).values.floorShares, keep.seed.shares / 5n);
});

test("page: https only for the Ethereum RPC, loopback only in a rehearsal; the vault is required", () => {
  const f = filled(); f.bridgeStatus.ethRpcUrl = "http://127.0.0.1:8545";
  assert.ok(check(f).problems.some((p) => p.includes("bridgeStatus.ethRpcUrl must be https")));
  assert.deepEqual(check(f, { rehearsal: true }).problems, []);
  const g = filled(); g.bridgeStatus.vault = "TBD-owner";
  assert.ok(check(g).problems.some((p) => p.includes("bridgeStatus.ethRpcUrl and bridgeStatus.vault")));
  const h = filled(); h.bridgeStatus.ethRpcUrl = "https://user:pw@eth.example.org";
  assert.ok(check(h).problems.some((p) => p.includes("without credentials")));
});

test("fraction above 7000 bps is refused, as by the planner (round 10, DEX-4)", () => {
  for (const bad of [7001, 8000, 9000]) {
    const f = filled(); f.seed.fractionBps = bad;
    assert.ok(check(f).problems.some((p) => p.includes("seed.fractionBps must be 1 to 7000")), String(bad));
  }
  const ok = filled(); ok.seed.fractionBps = 7000;
  assert.deepEqual(check(ok).problems, []);
  assert.equal(MAX_FRACTION_BPS, 7000n);
});

test("URLs and keeper paths refuse multiline and invalid environment text", () => {
  for (const suffix of ["\nDEX_KEEPER=changed", "\r", "\t", "\0", "\ufeff", "\ud800", "\uffff"]) {
    const path = filled(); path.keeper.keystore += suffix;
    assert.ok(check(path).problems.some((p) => /keeper.keystore/.test(p)), JSON.stringify(suffix));
    const password = filled(); password.keeper.passwordFile += suffix;
    assert.ok(check(password).problems.some((p) => /keeper.passwordFile/.test(p)), JSON.stringify(suffix));
    const rpc = filled(); rpc.bridgeStatus.ethRpcUrl += suffix;
    assert.ok(check(rpc).problems.some((p) => /bridgeStatus.ethRpcUrl/.test(p)), JSON.stringify(suffix));
    const site = filled(); site.site.rpcUrl += suffix;
    assert.ok(check(site).problems.some((p) => /site.rpcUrl/.test(p)), JSON.stringify(suffix));
  }
});

test("generated environment and commands retain literal paths and URL query arguments", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "dex-opening-output-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const form = filled();
  form.keeper.keystore = "/etc/key files/keeper 'quote' \"double\" $VALUE `printf-executed` \\ key";
  form.keeper.passwordFile = "/etc/key files/pass $(printf-executed)";
  form.bridgeStatus.ethRpcUrl = "https://eth.example.org/rpc?key=one&name='quoted'&dollar=$(printf-executed)&tick=`printf-executed`";
  assert.deepEqual(check(form).problems, []);
  const formPath = join(directory, "form.json");
  const safePath = join(directory, "safe.json");
  const output = join(directory, "output");
  writeFileSync(formPath, JSON.stringify(form));
  writeFileSync(safePath, JSON.stringify(blochInc));
  const result = spawnSync(process.execPath, [
    new URL("./opening-form.mjs", import.meta.url).pathname, "apply", "--form", formPath,
    "--bloch-inc", safePath, "--out", output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The generated subset uses double-quoted POSIX escape rules, also understood
  // by systemd EnvironmentFile; shell expansion must remain inert as well.
  const environment = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\\0" "$DEX_ETH_RPC" "$DEX_KEEPER_KEYSTORE" "$DEX_KEEPER_PASSWORD_FILE"', "opening-test", join(output, "dex-ops.env")], { encoding: "utf8" });
  assert.equal(environment.status, 0, environment.stderr);
  assert.equal(environment.stderr, "");
  assert.deepEqual(environment.stdout.split("\0").slice(0, -1), [form.bridgeStatus.ethRpcUrl, form.keeper.keystore, form.keeper.passwordFile]);
  const commands = readFileSync(join(output, "OPENING-COMMANDS.md"), "utf8");
  for (const line of commands.split("\n").filter((line) => /^node .+--eth-rpc /.test(line))) {
    // Replace node with an argument dumper: no RPC or operation is executed.
    const args = spawnSync("/bin/sh", ["-c", `node() { printf '%s\\0' "$@"; };\n${line}`], { encoding: "utf8" });
    assert.equal(args.status, 0, args.stderr);
    assert.equal(args.stderr, "");
    const words = args.stdout.split("\0").slice(0, -1);
    assert.equal(words[words.indexOf("--eth-rpc") + 1], form.bridgeStatus.ethRpcUrl);
  }
});

// Owner decision of 2026-11-17: Bloch Inc on the Bloch L2 DEX is the owner's plain fee address, no Safe.
const OWNER_FEE_EOA = "0x775a993f09bd80aecf8f8c2ade0c84158e3a0544";
const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const ownerPin = { address: OWNER_FEE_EOA, codeHash: EMPTY_CODE_HASH };
const eoaForm = (change = () => {}) => { const f = filled(); f.fromEarlierSteps.safeOwners = []; change(f); return f; };

test("Bloch Inc as the owner's plain fee address: exactly that pin, no Safe owners, one role per key", (context) => {
  const { problems, values } = check(eoaForm(), { blochInc: ownerPin });
  assert.deepEqual(problems, []);
  assert.equal(values.safe, OWNER_FEE_EOA);
  assert.deepEqual(values.owners, []);
  assert.deepEqual(values.dexConfig.blochInc, ownerPin);
  assert.match(values.dexConfigSha256, /^0x[0-9a-f]{64}$/);
  for (const [form, pin, pattern] of [
    // The five Safe owners make no sense with a plain address: listing them is a contradiction, refused.
    [filled(), ownerPin, /safeOwners must be empty .*owner's plain fee address/],
    // Any other pin than exactly {address, empty code hash}.
    [eoaForm(), { ...ownerPin, codeHash: H }, /--bloch-inc names the owner's plain fee address: it must be exactly \{"address": "0x775a993f09bd80aecf8f8c2ade0c84158e3a0544", "codeHash": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"\}/],
    [eoaForm(), { ...ownerPin, safe: blochInc.safe }, /--bloch-inc names the owner's plain fee address: it must be exactly/],
    // The checksummed spelling is the same address but not the exact pin every other tool requires: refused here too.
    [eoaForm(), { ...ownerPin, address: "0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544" }, /--bloch-inc names the owner's plain fee address: it must be exactly/],
    [eoaForm(), { ...ownerPin, extra: 1 }, /--bloch-inc names the owner's plain fee address: it must be exactly/],
    // A form that lists owners for the owner's pin, or leaves the list out, is a mismatch.
    [eoaForm((f) => { delete f.fromEarlierSteps.safeOwners; }), ownerPin, /safeOwners must be empty .*owner's plain fee address/],
    [eoaForm((f) => { f.fromEarlierSteps.safeOwners = [a(0x101)]; }), ownerPin, /safeOwners must be empty .*owner's plain fee address/],
    // Another plain address is never Bloch Inc: with no owner list the Safe rule refuses it, and with five owners
    // deploy-dex's own validation refuses the empty-code pin (only the owner's address may have no code).
    [eoaForm(), { address: a(0xe0a), codeHash: EMPTY_CODE_HASH }, /safeOwners must list exactly 5 distinct nonzero Safe owners/],
    [filled(), { address: a(0xe0a), codeHash: EMPTY_CODE_HASH }, /safeOwners differs from the owners in --bloch-inc/],
    [filled(), { address: a(0xe0a), codeHash: EMPTY_CODE_HASH, safe: blochInc.safe }, /deploy-dex validate would refuse: deploy config: blochInc must be a multisig contract, not an externally owned account \(the only plain address accepted is the owner.s 0x775a993f09bd80aecf8f8c2ade0c84158e3a0544\)/],
    // The neighbour of the owner's address is not the owner's address.
    [eoaForm(), { address: `${OWNER_FEE_EOA.slice(0, -1)}5`, codeHash: EMPTY_CODE_HASH }, /safeOwners must list exactly 5 distinct nonzero Safe owners/],
    // An empty owner list without the owner's pin is refused.
    [eoaForm(), null, /safeOwners must list exactly 5/],
    // The depositor, the keeper and the deployer must not be the fee address.
    [eoaForm((f) => { f.firstDepositor = OWNER_FEE_EOA; }), ownerPin, /firstDepositor equals Bloch Inc/],
    [eoaForm((f) => { f.keeper.address = OWNER_FEE_EOA; }), ownerPin, /keeper.address must be its own hot key/],
    [eoaForm((f) => { f.fromEarlierSteps.dexDeployer = OWNER_FEE_EOA; }), ownerPin, /each key and contract has one role/],
  ]) {
    const { problems: p } = check(form, { blochInc: pin });
    assert.ok(p.some((x) => pattern.test(x)), `${pattern}: ${JSON.stringify(p)}`);
  }
  // apply: the env names the owner's address (no Safe plan) and the printed commands pass it, never --safe-plan.
  const directory = mkdtempSync(join(tmpdir(), "dex-opening-eoa-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "form.json"), JSON.stringify(eoaForm()));
  writeFileSync(join(directory, "pin.json"), JSON.stringify(ownerPin));
  const result = spawnSync(process.execPath, [new URL("./opening-form.mjs", import.meta.url).pathname, "apply", "--form", join(directory, "form.json"),
    "--bloch-inc", join(directory, "pin.json"), "--out", join(directory, "out")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const env = readFileSync(join(directory, "out/dex-ops.env"), "utf8");
  assert.match(env, new RegExp(`^DEX_OWNER_FEE_ADDRESS=${OWNER_FEE_EOA}$`, "m"));
  assert.doesNotMatch(env, /DEX_SAFE_PLAN/);
  const commands = readFileSync(join(directory, "out/OPENING-COMMANDS.md"), "utf8");
  assert.doesNotMatch(commands, /--safe-plan/);
  assert.match(commands, new RegExp(`dex-monitor\\.mjs .*--owner-fee-address ${OWNER_FEE_EOA}`));
  assert.match(commands, /bloch-dex-monitor-owner-address\.service/);
  assert.match(commands, new RegExp(`check-finality-gate-mainnet\\.mjs --config \\S+ --bridge-plan`));
  // The derived values name which Bloch Inc the files were written for, and the written config carries the exact pin.
  const opening = JSON.parse(readFileSync(join(directory, "out/opening.json"), "utf8"));
  assert.deepEqual(opening.blochInc, { kind: "owner-fee-address", address: OWNER_FEE_EOA });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "out/dex-mainnet.config.json"), "utf8")).blochInc, ownerPin);
  // The Safe path, same command: the Safe plan in the env and in the printed commands, never the owner's option.
  writeFileSync(join(directory, "safe-form.json"), JSON.stringify(filled()));
  writeFileSync(join(directory, "safe-pin.json"), JSON.stringify(blochInc));
  const safeRun = spawnSync(process.execPath, [new URL("./opening-form.mjs", import.meta.url).pathname, "apply", "--form", join(directory, "safe-form.json"),
    "--bloch-inc", join(directory, "safe-pin.json"), "--out", join(directory, "safe-out")], { encoding: "utf8" });
  assert.equal(safeRun.status, 0, safeRun.stderr + safeRun.stdout);
  const safeEnv = readFileSync(join(directory, "safe-out/dex-ops.env"), "utf8");
  assert.match(safeEnv, /^DEX_SAFE_PLAN=\/etc\/bloch-dex-ops\/safe\.plan\.json$/m);
  assert.doesNotMatch(safeEnv, /DEX_OWNER_FEE_ADDRESS/);
  const safeCommands = readFileSync(join(directory, "safe-out/OPENING-COMMANDS.md"), "utf8");
  assert.doesNotMatch(safeCommands, /--owner-fee-address|bloch-dex-monitor-owner-address/);
  assert.match(safeCommands, /dex-monitor\.mjs .*--safe-plan deployments\/mainnet\/700770\/safe\.plan\.json/);
  assert.match(safeCommands, /check-finality-gate-mainnet\.mjs .*--safe-plan deployments\/mainnet\/700770\/safe\.plan\.json/);
  assert.match(safeCommands, /`scripts\/ops\/systemd\/bloch-dex-monitor\.service`/);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "safe-out/opening.json"), "utf8")).blochInc, { kind: "safe", address: blochInc.address });
  // The Safe path still writes the Safe plan.
  assert.match(readFileSync(new URL("./systemd/dex-monitor.env.example", import.meta.url), "utf8"), /^DEX_SAFE_PLAN=/m);
});
