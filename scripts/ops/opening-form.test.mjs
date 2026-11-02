// node --test scripts/ops/opening-form.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkForm, seedAmounts } from "./opening-form.mjs";
import { planOpening } from "./dex-seed-plan.mjs";

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

test("exit policy: the floor in shares, or 0 with full-exit", () => {
  const keep = check(filled()).values;
  assert.equal(keep.floorShares, keep.seed.shares / 10n);
  const f = filled(); f.seederExit = { policy: "full-exit", floorBps: 0 };
  assert.equal(check(f).values.floorShares, 0n);
  const bad = filled(); bad.seederExit = { policy: "full-exit", floorBps: 1000 };
  assert.ok(check(bad).problems.some((p) => p.includes("floorBps must be 0")));
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

test("fraction above 8000 bps is refused, as by the planner", () => {
  const f = filled(); f.seed.fractionBps = 9000;
  assert.ok(check(f).problems.some((p) => p.includes("fractionBps")));
});
