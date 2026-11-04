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
  f.bridgeStatus = { ethRpcUrl: "https://eth.example.org", vault: a(0x7a), vaultCodeHash: null };
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
