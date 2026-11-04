// Anvil-only regression using the package harness's throwaway issuer key.
// The node accepts a self-transfer, then the publisher loses the response.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { publishRecorded } from "../staging/publish-recorded.mjs";

const [url, work] = process.argv.slice(2);
assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const request = createRpcTransport(url);
assert.match(await request("web3_clientVersion", []), /anvil/i);
assert.equal(BigInt(await request("eth_chainId", [])), 700770n);
const { privateKeyToAccount } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem/accounts");
const account = privateKeyToAccount(JSON.parse(readFileSync(join(work, "keys.json")))[2].private_key);
const from = account.address.toLowerCase();
const nonce = BigInt(await request("eth_getTransactionCount", [from, "latest"]));
const raw = await account.signTransaction({
  type: "eip1559", chainId: 700770, nonce: Number(nonce), to: from, value: 0n,
  gas: 21000n, maxFeePerGas: 5000000000n, maxPriorityFeePerGas: 1000000000n,
});
const options = {
  raw, journalPath: join(work, "evidence", "response-lost.journal.json"), chainId: "700770", from,
  genesisHash: (await request("eth_getBlockByNumber", ["0x0", false])).hash,
  configSha256: `0x${"12".repeat(32)}`, label: "rehearsal self-transfer",
};
let sends = 0;
const lostResponse = async (method, params) => {
  if (method !== "eth_sendRawTransaction") return request(method, params);
  const saved = JSON.parse(readFileSync(options.journalPath)).attempts[0];
  assert.equal(saved.status, "publish-pending");
  assert.equal(saved.nonce, nonce.toString());
  assert.equal(statSync(options.journalPath).mode & 0o777, 0o600);
  sends++;
  await request(method, params);
  throw new Error("rehearsal: response lost after the node accepted the transaction");
};
const result = await publishRecorded(options, lostResponse);
assert.equal(result.decision, "publish-unconfirmed");
const receipt = await request("eth_getTransactionReceipt", [result.hash]);
assert.equal(receipt.transactionHash, result.hash);
assert.equal(receipt.status, "0x1");
assert.equal(BigInt(await request("eth_getTransactionCount", [from, "latest"])), nonce + 1n);
await assert.rejects(publishRecorded(options, async () => assert.fail("a recorded uncertain publication must not be sent again")), /unresolved publication/);
assert.equal(sends, 1);
console.log(JSON.stringify({ decision: "publication-journal-rehearsed", hash: result.hash, nonce: nonce.toString(), receiptBlock: receipt.blockNumber, journalStatus: result.decision, resubmissions: 0 }, null, 2));
