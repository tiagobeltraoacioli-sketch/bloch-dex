// node --test scripts/ops/r20-network-facts.test.mjs
// Round 20 (agent 440, 2026-11-19): the L2 mainnet is live in its deposit-only release, and two facts of it are
// recorded in deployments/mainnet/frontend.network.json: the public explorer and the genesis hash. The opening
// form's `site` block is what `opening-form.mjs apply` writes over that file's RPC, status and explorer
// (docs/OWNER-OPENING-FORM.md, item 8), so the committed form must say the same, or the opening would silently
// take the explorer out again; and the genesis hash, which the form does not carry, must be the pinned one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const committed = (path) => JSON.parse(readFileSync(new URL(`../../deployments/mainnet/${path}`, import.meta.url), "utf8"));
const network = committed("frontend.network.json");
const template = committed("opening-form.json");
const pins = committed("700770/pins.json");
const GENESIS = "0x632e45ae778da371a88dc1ae430193aa77eabb67a11de18e84fea7d20d11f468";
const a = (n) => `0x${n.toString(16).padStart(40, "0")}`;

test("the network file records the live L2's genesis hash (the pinned one) and its public explorer; the RPC stays a placeholder and the record not deployed", () => {
  assert.equal(network.genesisHash, GENESIS);
  assert.equal(pins.l2.genesisHash, GENESIS);
  assert.equal(committed("dex-mainnet.config.json").network.genesisHash, GENESIS);
  assert.deepEqual(network.explorer, { url: "https://blochl1.com/l2" });
  // `rpc.status: "live"` is the page's switch for its own use of the RPC ("Add or switch to Bloch L2", the L2
  // site's "Guarded launch"); it is set with the deployment, by the opening form (`site.rpcStatus`).
  assert.deepEqual(network.rpc, { url: "https://l2rpc.blochl1.com", status: "placeholder" });
  assert.equal(committed("dex-mainnet.record.json").status, "not-deployed");
  assert.equal(committed("l2-phase.json").userTransactions, "not-enabled");
});

test("the committed opening form's site block says what the committed network file says", () => {
  assert.deepEqual(template.site, {
    rpcUrl: network.rpc.url,
    rpcStatus: network.rpc.status,
    explorerUrl: network.explorer.url,
    depositUrl: network.bridges[0].depositUrl,
    withdrawUrl: network.bridges[0].withdrawUrl,
    docsUrl: network.bridges[0].docsUrl,
  });
});

test("opening-form.mjs apply keeps the recorded facts: the network file it writes differs from the committed one by the owner's bridge status only", () => {
  const directory = mkdtempSync(join(tmpdir(), "postern-r20-network-facts-"));
  try {
    const form = structuredClone(template);
    Object.assign(form, { openingPrice: "100", firstDepositor: a(0xd1), lpRecipient: a(0x1b) });
    form.seederExit = { policy: "keep-floor", floorBps: 1000 };
    Object.assign(form.keeper, { address: a(0xee), keystore: "/etc/k.json", passwordFile: "/etc/k.pw" });
    form.bridgeStatus = { ethRpcUrl: "https://eth.example.org", vault: a(0x7a), vaultCodeHash: `0x${"7c".repeat(32)}` };
    form.fromEarlierSteps = { dexDeployer: a(0xde), safeOwners: [1, 2, 3, 4, 5].map((i) => a(0x100 + i)), busdcToken: a(0x05d), busdcCodeHash: `0x${"ab".repeat(32)}`, busdcBucketCapacity: "10000000000" };
    const blochInc = {
      address: a(0x5afe), codeHash: "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
      safe: {
        version: "1.4.1",
        singleton: { address: a(0x51), codeHash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff" },
        fallbackHandler: { address: a(0x52), codeHash: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9" }, threshold: 3, owners: [1, 2, 3, 4, 5].map((i) => a(0x100 + i)) },
    };
    writeFileSync(join(directory, "form.json"), JSON.stringify(form));
    writeFileSync(join(directory, "safe.json"), JSON.stringify(blochInc));
    const out = join(directory, "out");
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("./opening-form.mjs", import.meta.url)), "apply", "--form", join(directory, "form.json"), "--bloch-inc", join(directory, "safe.json"), "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const written = JSON.parse(readFileSync(join(out, "frontend.network.json"), "utf8"));
    assert.equal(written.genesisHash, GENESIS);
    assert.deepEqual(written.explorer, { url: "https://blochl1.com/l2" });
    assert.deepEqual(written.rpc, network.rpc);
    const { status, ...bridge } = written.bridges[0];
    assert.deepEqual(status, { ethRpcUrl: "https://eth.example.org", vault: a(0x7a), token: a(0x05d), vaultCodeHash: `0x${"7c".repeat(32)}` });
    assert.deepEqual({ ...written, bridges: [bridge] }, network);
    // The owner's own values still win where the form carries them: no explorer, when the owner says so.
    form.site.explorerUrl = null;
    writeFileSync(join(directory, "form.json"), JSON.stringify(form));
    const second = spawnSync(process.execPath, [fileURLToPath(new URL("./opening-form.mjs", import.meta.url)), "apply", "--form", join(directory, "form.json"), "--bloch-inc", join(directory, "safe.json"), "--out", join(directory, "out2")], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "out2/frontend.network.json"), "utf8")).explorer, { url: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
