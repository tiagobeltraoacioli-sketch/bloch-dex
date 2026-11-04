import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishRecorded } from "./publish-recorded.mjs";
import { JsonRpcResponseError } from "./rpc-transport.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { privateKeyToAccount } = requireFromFrontend("viem/accounts");
const { keccak256 } = requireFromFrontend("viem");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const genesisHash = `0x${"22".repeat(32)}`;
const configSha256 = `0x${"33".repeat(32)}`;
const target = `0x${"44".repeat(20)}`;
const sign = (nonce = 0, overrides = {}) => account.signTransaction({
  type: "eip1559", chainId: 700770, nonce, to: target, data: "0x12345678", value: 7n,
  gas: 100000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n, ...overrides,
});

async function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), "dex-publish-journal-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  return {
    raw: await sign(), journalPath: join(work, "hashes.txt.journal.json"),
    chainId: "700770", genesisHash, from: account.address.toLowerCase(), configSha256, label: "approve",
  };
}

function node(publish, overrides = {}) {
  const seen = [];
  return {
    seen,
    request: async (method, params) => {
      seen.push(method);
      if (Object.hasOwn(overrides, method)) return overrides[method];
      if (method === "eth_chainId") return "0xab162";
      if (method === "eth_getBlockByNumber") return { hash: genesisHash };
      if (method === "eth_sendRawTransaction") return publish(params[0]);
      throw new Error(`unexpected RPC ${method}`);
    },
  };
}

test("publication persists public signed fields with mode 0600 before the only send", async (t) => {
  const options = await fixture(t);
  const rpc = node((raw) => {
    const journal = JSON.parse(readFileSync(options.journalPath));
    assert.equal(journal.chainId, "700770");
    assert.equal(journal.from, options.from);
    assert.equal(journal.attempts.length, 1);
    const entry = journal.attempts[0];
    assert.equal(entry.status, "publish-pending");
    assert.equal(entry.hash, keccak256(raw));
    assert.equal(entry.nonce, "0");
    assert.equal(entry.to, target);
    assert.equal(entry.data, "0x12345678");
    assert.equal(entry.value, "7");
    assert.equal(entry.gasLimit, "100000");
    assert.equal(entry.maxFeePerGas, "3000000000");
    assert.equal(entry.maxPriorityFeePerGas, "1000000000");
    assert.equal(statSync(options.journalPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(journal).includes(raw), false);
    return keccak256(raw);
  });
  const result = await publishRecorded(options, rpc.request);
  assert.equal(result.decision, "published");
  assert.equal(JSON.parse(readFileSync(options.journalPath)).attempts[0].status, "published");
  assert.equal(existsSync(`${options.journalPath}.lock`), false);
  assert.equal(rpc.seen.filter((method) => method === "eth_sendRawTransaction").length, 1);
  assert.equal(existsSync(options.journalPath.replace(/\.journal\.json$/, "")), false);
});

for (const [name, publish] of [
  ["lost response", () => { throw new Error("connection closed after acceptance"); }],
  ["generic RPC error", () => { throw new JsonRpcResponseError("eth_sendRawTransaction", { code: -32603, message: "internal error" }); }],
  ["nonce too low", () => { throw new JsonRpcResponseError("eth_sendRawTransaction", { code: -32000, message: "nonce too low" }); }],
  ["unrelated success hash", () => `0x${"ff".repeat(32)}`],
]) test(`publication journal preserves ${name} and prevents a new nonce or resubmission`, async (t) => {
  const options = await fixture(t);
  const rpc = node(publish);
  assert.equal((await publishRecorded(options, rpc.request)).decision, "publish-unconfirmed");
  assert.equal(JSON.parse(readFileSync(options.journalPath)).attempts[0].status, "publish-unconfirmed");
  const noRpc = async () => assert.fail("an unresolved journal must stop before RPC");
  await assert.rejects(publishRecorded(options, noRpc), /unresolved publication/);
  await assert.rejects(publishRecorded({ ...options, raw: await sign(1) }, noRpc), /unresolved publication/);
});

test("a durable pending entry after a crash blocks every subsequent publication", async (t) => {
  const options = await fixture(t);
  await publishRecorded(options, node((raw) => keccak256(raw)).request);
  const journal = JSON.parse(readFileSync(options.journalPath));
  journal.attempts[0].status = "publish-pending";
  writeFileSync(options.journalPath, JSON.stringify(journal));
  await assert.rejects(publishRecorded({ ...options, raw: await sign(1) }, async () => assert.fail("must not send")), /unresolved publication/);
});

test("publication accepts only the explicitly signed next nonce and rejects a duplicate", async (t) => {
  const options = await fixture(t);
  const rpc = node((raw) => keccak256(raw));
  await publishRecorded(options, rpc.request);
  await assert.rejects(publishRecorded(options, rpc.request), /already records/);
  await assert.rejects(publishRecorded({ ...options, raw: await sign(2) }, rpc.request), /explicit nonce sequence/);
  await publishRecorded({ ...options, raw: await sign(1), label: "seed" }, rpc.request);
  assert.deepEqual(JSON.parse(readFileSync(options.journalPath)).attempts.map(({ nonce }) => nonce), ["0", "1"]);
  assert.equal(rpc.seen.filter((method) => method === "eth_sendRawTransaction").length, 2);
});

test("publication refuses another sender, chain, journal identity or unavailable journal path before send", async (t) => {
  const options = await fixture(t);
  const noRpc = async () => assert.fail("invalid signed identity must stop before RPC");
  await assert.rejects(publishRecorded({ ...options, from: target }, noRpc), /sender/);
  await assert.rejects(publishRecorded({ ...options, chainId: "1" }, noRpc), /chain/);
  await assert.rejects(publishRecorded({ ...options, journalPath: join(options.journalPath, "missing", "file") }, noRpc), /ENOENT/);
  await publishRecorded(options, node((raw) => keccak256(raw)).request);
  await assert.rejects(publishRecorded({ ...options, configSha256: genesisHash, raw: await sign(1) }, noRpc), /journal identity/);
});

test("publication refuses a different RPC chain or genesis without recording an attempt", async (t) => {
  const options = await fixture(t);
  for (const overrides of [{ eth_chainId: "0x1" }, { eth_getBlockByNumber: { hash: configSha256 } }]) {
    const rpc = node(() => assert.fail("must not send"), overrides);
    await assert.rejects(publishRecorded(options, rpc.request), /RPC (chain ID|genesis)/);
    assert.equal(existsSync(options.journalPath), false);
  }
});

test("exclusive journal lock prevents overlapping publications and remains fail-closed when stale", async (t) => {
  const options = await fixture(t);
  let resolveSend;
  const sent = new Promise((resolve) => { resolveSend = resolve; });
  let reachedSend;
  const ready = new Promise((resolve) => { reachedSend = resolve; });
  const first = publishRecorded(options, node(async (raw) => { reachedSend(); await sent; return keccak256(raw); }).request);
  await ready;
  await assert.rejects(publishRecorded(options, async () => assert.fail("overlapping publication")), /EEXIST/);
  resolveSend();
  await first;
  writeFileSync(`${options.journalPath}.lock`, "", { mode: 0o600 });
  await assert.rejects(publishRecorded({ ...options, raw: await sign(1) }, async () => assert.fail("stale lock")), /EEXIST/);
});

test("structured fee refusal is recorded before stopping, with no signing or retry", async (t) => {
  const options = await fixture(t);
  const rpc = node((raw) => { throw new JsonRpcResponseError("eth_sendRawTransaction", { code: -32000, message: "transaction underpriced for sequencer policy", data: {
    kind: "sequencer-fee-underpriced", scope: "latest-state-next-block", transactionHash: keccak256(raw),
    headHash: genesisHash, headNumber: "0xa", baseFeePerGas: "0x3b9aca00", requiredPriorityFeePerGas: "0x77359400",
    requiredMaxFeePerGas: "0xb2d05e00", effectivePriorityFeePerGas: "0x3b9aca00", gasUsed: "0x13880",
    freshSlots: "0x1", chargedFreshSlots: "0x1", freshSlotPriceWei: "0x5af3107a4000",
  } }); });
  const result = await publishRecorded(options, rpc.request);
  assert.equal(result.decision, "publish-refused");
  assert.equal(result.feeRequirement.requiredMaxFeePerGas, "3000000000");
  assert.equal(JSON.parse(readFileSync(options.journalPath)).attempts[0].status, "publish-refused");
  await assert.rejects(publishRecorded({ ...options, raw: await sign(1) }, async () => assert.fail("must not retry")), /unresolved publication/);
  assert.equal(rpc.seen.filter((method) => method === "eth_sendRawTransaction").length, 1);
});
