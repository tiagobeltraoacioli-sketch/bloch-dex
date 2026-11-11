// Regression tests for the round 15 review (agent 309, pass C) of scripts/ops/opening-form.mjs: the reviewer's
// demonstrations (review branch commit 2901e7a), turned around so that each asserts the corrected behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkForm } from "./opening-form.mjs";
import { encode } from "./dex-ops-lib.mjs";

const { isAddress } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");

// ---- fixture: copied from scripts/ops/opening-form.test.mjs
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
const check = (form, opts = {}) => checkForm(form, { blochInc, committedConfig: committed, ...opts });

test("R309-C6: a mistyped mixed-case address (wrong EIP-55 checksum) is refused; lower case and a valid checksum pass", () => {
  const intended = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const mistyped = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe1"; // last character wrong
  assert.equal(isAddress(intended), true);
  assert.equal(isAddress(mistyped), false);
  assert.throws(() => encode("balanceOf", [mistyped]), /invalid/i);
  for (const change of [
    (f) => (f.lpRecipient = mistyped),
    (f) => (f.firstDepositor = mistyped),
    (f) => (f.keeper.address = mistyped),
    (f) => (f.fromEarlierSteps.dexDeployer = mistyped),
    (f) => (f.fromEarlierSteps.busdcToken = mistyped),
    (f) => (f.fromEarlierSteps.safeOwners[0] = mistyped),
    (f) => (f.bridgeStatus.vault = mistyped),
  ]) {
    const form = filled();
    change(form);
    const { problems, values } = check(form);
    assert.ok(problems.some((p) => /wrong EIP-55 checksum/.test(p)), problems.join("; "));
    assert.equal(values, null);
  }
  // The intended address passes with its checksum, in lower case, and in upper case (no checksum claimed).
  for (const good of [intended, intended.toLowerCase(), `0x${intended.slice(2).toUpperCase()}`]) {
    const { problems, values } = check(filled({ lpRecipient: good }));
    assert.deepEqual(problems, []);
    assert.equal(values.lp, intended.toLowerCase());
  }
});

test("R309-C7: one key, one role: the keeper is not the deployer, and no key is a bridge contract", () => {
  const cases = [
    [(f) => (f.keeper.address = f.fromEarlierSteps.dexDeployer), /fromEarlierSteps\.dexDeployer equals keeper\.address/],
    [(f) => (f.lpRecipient = f.fromEarlierSteps.busdcToken), /lpRecipient equals fromEarlierSteps\.busdcToken/],
    [(f) => (f.lpRecipient = f.bridgeStatus.vault), /lpRecipient equals bridgeStatus\.vault/],
    [(f) => (f.keeper.address = f.fromEarlierSteps.busdcToken), /keeper\.address equals fromEarlierSteps\.busdcToken/],
    [(f) => (f.fromEarlierSteps.dexDeployer = f.fromEarlierSteps.safeOwners[2]), /fromEarlierSteps\.dexDeployer equals Safe owner 3/],
    [(f) => (f.fromEarlierSteps.dexDeployer = blochInc.address), /fromEarlierSteps\.dexDeployer equals the Bloch Inc Safe/],
    [(f) => (f.bridgeStatus.vault = f.fromEarlierSteps.busdcToken), /fromEarlierSteps\.busdcToken equals bridgeStatus\.vault/],
    [(f) => (f.firstDepositor = f.bridgeStatus.vault), /firstDepositor equals bridgeStatus\.vault/],
  ];
  for (const [change, pattern] of cases) {
    const form = filled();
    change(form);
    const { problems } = check(form);
    assert.ok(problems.some((p) => pattern.test(p)), `${pattern}: ${problems.join("; ")}`);
  }
  // The clashes the form already named keep their own message, once.
  const form = filled();
  form.keeper.address = form.fromEarlierSteps.safeOwners[0];
  assert.deepEqual(check(form).problems, ["keeper.address must be its own hot key (not the LP recipient, the Safe or a Safe owner)"]);
  assert.deepEqual(check(filled()).problems, []);
});

test("R309-C8: keeper.budgetWei and keeper.maxTx are plain decimals inside bounds around the decided 0.05 BLCH and 48", (context) => {
  for (const [budgetWei, maxTx, pattern] of [
    ["1", 48, /keeper\.budgetWei must be 5000000000000000 to 500000000000000000 wei/],
    ["1000000000000000000000000", 48, /keeper\.budgetWei must be 5000000000000000 to 500000000000000000 wei/],
    ["4999999999999999", 48, /keeper\.budgetWei must be/],
    ["500000000000000001", 48, /keeper\.budgetWei must be/],
    ["50000000000000000", 1_000_000, /keeper\.maxTx must be a whole number from 12 to 288/],
    ["50000000000000000", 11, /keeper\.maxTx must be/],
    ["50000000000000000", 289, /keeper\.maxTx must be/],
    ["50000000000000000", 1e21, /keeper\.maxTx must be/],
    ["50000000000000000", 48.5, /keeper\.maxTx must be/],
    ["50000000000000000", "0x30", /keeper\.maxTx must be/],
    [true, 48, /keeper\.budgetWei must be a positive whole number of wei, in decimal/],
    ["0x1", 48, /keeper\.budgetWei must be a positive whole number of wei, in decimal/],
    [5e16, 48, /keeper\.budgetWei must be a positive whole number of wei, in decimal/], // above 2^53: not an exact number
  ]) {
    const form = filled();
    Object.assign(form.keeper, { budgetWei, maxTx });
    const { problems } = check(form);
    assert.ok(problems.some((p) => pattern.test(p)), `${budgetWei} / ${maxTx}: ${problems.join("; ")}`);
  }
  for (const [budgetWei, maxTx] of [["50000000000000000", 48], ["5000000000000000", 12], ["500000000000000000", 288], ["50000000000000000", "48"]]) {
    const form = filled();
    Object.assign(form.keeper, { budgetWei, maxTx });
    assert.deepEqual(check(form).problems, [], `${budgetWei} / ${maxTx}`);
  }
  // The generated environment: decimal limits, and the vault code hash the units pin.
  const directory = mkdtempSync(join(tmpdir(), "form-r15-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "form.json"), JSON.stringify(filled()));
  writeFileSync(join(directory, "safe.json"), JSON.stringify(blochInc));
  let runs = 0;
  const apply = (form) => {
    writeFileSync(join(directory, "form.json"), JSON.stringify(form));
    const out = `out-${++runs}`;
    return { out, ...spawnSync(process.execPath, [
      fileURLToPath(new URL("./opening-form.mjs", import.meta.url)), "apply", "--form", join(directory, "form.json"),
      "--bloch-inc", join(directory, "safe.json"), "--out", join(directory, out),
    ], { encoding: "utf8" }) };
  };
  const dear = filled();
  Object.assign(dear.keeper, { budgetWei: "1000000000000000000000000", maxTx: 1e21 });
  assert.equal(apply(dear).status, 2);
  const result = apply(filled());
  assert.equal(result.status, 0, result.stderr);
  const { out } = result;
  const environment = readFileSync(join(directory, out, "dex-ops.env"), "utf8");
  assert.match(environment, /^DEX_KEEPER_BUDGET_WEI=50000000000000000$/m);
  assert.match(environment, /^DEX_KEEPER_MAX_TX=48$/m);
  assert.match(environment, /^DEX_BUSDC_VAULT_CODE_HASH=0x(7c){32}$/m);
  // Every variable the two units expand is in the generated file (an unset one would stop the unit).
  for (const unit of ["bloch-dex-monitor.service", "bloch-dex-skim-keeper.service"]) {
    const text = readFileSync(new URL(`./systemd/${unit}`, import.meta.url), "utf8");
    for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) assert.match(environment, new RegExp(`^${name}=.+$`, "m"), `${unit}: ${name}`);
  }
  const commands = readFileSync(join(directory, out, "OPENING-COMMANDS.md"), "utf8");
  assert.match(commands, /without `--ref-price`/);
  assert.match(commands, /dex-skim-keeper\.mjs .*--bridge-vault-code-hash 0x(7c){32}/);
});

test("R309-C8: the vault code hash may be left out in a rehearsal only", () => {
  const form = filled();
  form.bridgeStatus.vaultCodeHash = null;
  assert.ok(check(form).problems.some((p) => /null is accepted in a rehearsal only/.test(p)));
  form.bridgeStatus.ethRpcUrl = "http://127.0.0.1:8545";
  assert.deepEqual(check(form, { rehearsal: true }).problems, []);
});
