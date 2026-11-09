import assert from "node:assert/strict";
import test from "node:test";
import { measureBudget } from "./e2e-settled/budget.mjs";

const TOKEN = `0x${"aa".repeat(20)}`, ISSUER = `0x${"11".repeat(20)}`, PAIR = `0x${"22".repeat(20)}`, USER = `0x${"33".repeat(20)}`, ZERO = `0x${"00".repeat(20)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
const log = (block, index, from, to, amount) => ({ address: TOKEN, topics: [TRANSFER, topic(from), topic(to)], data: `0x${amount.toString(16).padStart(64, "0")}`, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${index.toString(16)}` });

function chain(logs, { head = 5, balances } = {}) {
  const final = new Map();
  for (const l of logs) for (const [a, s] of [[`0x${l.topics[1].slice(26)}`, -1n], [`0x${l.topics[2].slice(26)}`, 1n]]) final.set(a, (final.get(a) ?? 0n) + s * BigInt(l.data));
  return async (method, params) => {
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getLogs") return logs.filter((l) => BigInt(l.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(l.blockNumber) <= BigInt(params[0].toBlock));
    if (method === "eth_call") { const a = `0x${params[0].data.slice(-40)}`; return `0x${((balances?.[a]) ?? final.get(a) ?? 0n).toString(16).padStart(64, "0")}`; }
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    throw new Error(`unexpected ${method}`);
  };
}

test("the budget is the credit minus the source's low-water mark, in chain order", async () => {
  // Logs are returned out of order on purpose: block 3 dips to 100 before block 4 returns 700.
  const logs = [log(4, 0, PAIR, ISSUER, 700n), log(2, 0, ZERO, ISSUER, 1000n), log(3, 1, ISSUER, USER, 400n), log(3, 0, ISSUER, PAIR, 500n)];
  const r = await measureBudget(chain(logs), { token: TOKEN, accounts: { issuer: ISSUER, user: USER }, source: "issuer", fundedWei: "2000000000000000000", logRange: 2n });
  assert.deepEqual(r.budget, { source: "issuer", creditedUnits: "1000", lowestUnits: "100", neededUnits: "900" });
  assert.equal(r.accounts.issuer.tokenBalanceUnits, "800");
  assert.equal(r.accounts.user.tokenLowestUnits, "400");
  assert.equal(r.accounts.issuer.nativeNetOutWei, "1000000000000000000");
  assert.equal(r.mintedUnits, "1000");
  assert.equal(r.transferLogs, 4);
});

test("several bridge credits: the need is the peak of mints minus balance, not the total minus the first credit", async () => {
  const logs = [log(2, 0, ZERO, ISSUER, 1000n), log(2, 1, ZERO, ISSUER, 1000n), log(3, 0, ISSUER, PAIR, 1500n), log(4, 0, PAIR, ISSUER, 1200n), log(5, 0, ISSUER, USER, 100n)];
  const r = await measureBudget(chain(logs), { token: TOKEN, accounts: { issuer: ISSUER }, source: "issuer" });
  assert.deepEqual(r.budget, { source: "issuer", creditedUnits: "2000", lowestUnits: "500", neededUnits: "1500" });
});

test("a replay that does not match balanceOf, a foreign log or a repeated account is refused", async () => {
  const logs = [log(2, 0, ZERO, ISSUER, 1000n)];
  await assert.rejects(measureBudget(chain(logs, { balances: { [ISSUER]: 999n } }), { token: TOKEN, accounts: { issuer: ISSUER } }), /differs from balanceOf/);
  await assert.rejects(measureBudget(chain([{ ...logs[0], address: ISSUER }]), { token: TOKEN, accounts: { issuer: ISSUER } }), /unexpected log/);
  await assert.rejects(measureBudget(chain(logs), { token: TOKEN, accounts: { a: ISSUER, b: ISSUER } }), /repeats/);
  await assert.rejects(measureBudget(chain(logs), { token: TOKEN, accounts: { issuer: ISSUER, user: USER }, source: "user" }), /credited nothing/);
  await assert.rejects(measureBudget(chain([log(2, 0, ISSUER, USER, 5n)]), { token: TOKEN, accounts: { issuer: ISSUER } }), /went negative/);
});
