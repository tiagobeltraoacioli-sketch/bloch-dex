#!/usr/bin/env node
// Storage footprint of the DEX, per action, read from anvil's state dump: non-zero slots of
// the pair, the router, WBLCH, bUSDC and the factory. Same contracts as the RC; bUSDC is the
// real BridgedStablecoinV2. Anvil is enough: slot counts do not depend on ordering or finality.
//   ANVIL=… BUSDC_ARTIFACT=… node footprint.mjs WORK PORT
import { readFileSync } from "node:fs";
import { Net, World, BLCH, ROOT, USD, DEADLINE, artifact, big, data, viem } from "./net.mjs";

const [work, port] = process.argv.slice(2);
const net = new Net("anvil", work, Number(port));
const names = ["deployer", "signer", "guardian", "depositor", "griefer", "keeper", "safe", "swapper", "swapper2", "sellerMax", "sellerExact", "lp", "holder", "wrapper"];
const A = Object.fromEntries(names.map((n) => [n, net.actor(n)]));
const raw = JSON.parse(readFileSync(process.env.BUSDC_ARTIFACT, "utf8"));
await net.start(Object.values(A), process.env);
process.on("exit", () => net.stop());
const w = new World(net, A, { abi: raw.abi, bytecode: raw.bytecode.object });
await w.deploy();
await net.rpc("anvil_setBlockGasLimit", ["0x3938700"]);

const targets = () => ({ pair: w.pair, router: w.router, WBLCH: w.w, bUSDC: w.q, factory: w.factory, lens: w.lens });
let last = await net.storage();
const count = (dump) => Object.fromEntries(Object.entries(targets()).map(([n, a]) => [n, Object.keys(dump[a] ?? {}).length]));
const results = [];
async function step(label, fn) {
  const r = await fn();
  const now = await net.storage();
  const [c0, c1] = [count(last), count(now)];
  const delta = Object.fromEntries(Object.keys(c1).filter((k) => c1[k] !== c0[k]).map((k) => [k, c1[k] - c0[k]]));
  const gas = (Array.isArray(r) ? r : r ? [r] : []).reduce((n, t) => n + (t.gas ?? 0), 0);
  const rec = { label, delta, net: Object.values(delta).reduce((a, b) => a + b, 0), total: c1, gas };
  results.push(rec);
  console.log(big(rec));
  last = now;
  return r;
}
await step("baseline after deployment", async () => {});
await step("seed 5 W + 500 Q (fund, approve, addLiquidity, Safe has no LP yet)", async () => {
  await w.seed(5n * BLCH, 500n * USD);
});
const swapBLCH = (a, v) => a.send(w.router, data("swapExactBLCHForTokens", [0n, [w.w, w.q], a.address, DEADLINE]), { value: v });
await step("new user: swap BLCH to bUSDC", async () => net.must(await swapBLCH(A.swapper, BLCH / 10n)));
await step("same user: another swap BLCH to bUSDC", async () => net.must(await swapBLCH(A.swapper, BLCH / 10n)));
await step("second new user: swap BLCH to bUSDC", async () => net.must(await swapBLCH(A.swapper2, BLCH / 100n)));
await step("user sells part of its bUSDC to BLCH, exact approve (mainnet UI path)", async () => {
  const bal = await net.read(w.q, "balanceOf", [A.swapper.address]);
  const amt = bal / 2n;
  return net.must([await A.swapper.send(w.q, data("approve", [w.router, amt])), await A.swapper.send(w.router, data("swapExactTokensForBLCH", [amt, 0n, [w.q, w.w], A.swapper.address, DEADLINE]))]);
});
await step("user sells all its bUSDC, exact approve", async () => {
  const bal = await net.read(w.q, "balanceOf", [A.swapper.address]);
  return net.must([await A.swapper.send(w.q, data("approve", [w.router, bal])), await A.swapper.send(w.router, data("swapExactTokensForBLCH", [bal, 0n, [w.q, w.w], A.swapper.address, DEADLINE]))]);
});
await step("bridge deposit: first mint to a new holder", async () => w.mintQ(A.sellerExact.address, 100n * USD));
await step("bridge deposit: second mint to the same holder", async () => w.mintQ(A.sellerExact.address, 100n * USD));
await step("holder: swap some bUSDC, unlimited approve (other wallets)", async () => {
  return net.must([await A.sellerExact.send(w.q, data("approve", [w.router, (1n << 256n) - 1n])), await A.sellerExact.send(w.router, data("swapExactTokensForBLCH", [10n * USD, 0n, [w.q, w.w], A.sellerExact.address, DEADLINE]))]);
});
await step("holder: bridge burn of everything", async () => {
  const bal = await net.read(w.q, "balanceOf", [A.sellerExact.address]);
  return net.must(await A.sellerExact.send(w.q, data("burn", [bal, A.sellerExact.address])));
});
await step("wrap BLCH (WBLCH.deposit), new holder", async () => net.must(await A.wrapper.send(w.w, data("deposit"), { value: BLCH })));
await step("transfer WBLCH to a fresh address", async () => net.must(await A.wrapper.send(w.w, data("transfer", ["0x00000000000000000000000000000000000d00d1", 1n]))));
await step("new LP: addLiquidity (protocol fee mints to the Safe on first growth)", async () => {
  await w.fund(A.lp, BLCH, 100n * USD);
  return net.must(await A.lp.send(w.router, data("addLiquidity", [w.w, w.q, BLCH / 10n, 10n * USD, 0n, 0n, A.lp.address, DEADLINE]), { gas: 800_000n }));
});
await step("LP: approve router, remove all", async () => {
  const lp = await net.read(w.pair, "balanceOf", [A.lp.address]);
  return net.must([await A.lp.send(w.pair, data("approve", [w.router, lp])), await A.lp.send(w.router, data("removeLiquidity", [w.w, w.q, lp, 0n, 0n, A.lp.address, DEADLINE]), { gas: 800_000n })]);
});
await step("griefer: one approve to a fresh spender, bUSDC, needs no balance", async () => net.must(await A.griefer.send(w.q, data("approve", ["0x00000000000000000000000000000000000d00d2", 1n]))));
await step("griefer: one approve, WBLCH", async () => net.must(await A.griefer.send(w.w, data("approve", ["0x00000000000000000000000000000000000d00d2", 1n]))));
await step("griefer: one approve, pair LP token", async () => net.must(await A.griefer.send(w.pair, data("approve", ["0x00000000000000000000000000000000000d00d2", 1n]))));
const f = artifact("SlotFiller");
const filler = (await net.must(await A.griefer.send(null, viem.encodeDeployData({ abi: f.abi, bytecode: f.bytecode }), { gas: 3_000_000n }))).contract.toLowerCase();
for (const [name, token] of [["bUSDC", w.q], ["WBLCH", w.w], ["pair", w.pair]]) {
  await step(`griefer: 500 approves in one transaction, ${name}`, async () => net.must(await A.griefer.send(filler, data("fillApprove", [token, 500n]), { gas: 20_000_000n })));
}
await step("griefer: createPair with a new throwaway token (factory, new pair)", async () => {
  const t = await w.create(A.griefer, "WBLCH", []);
  return net.must(await A.griefer.send(w.factory, data("createPair", [t, w.q]), { gas: 6_000_000n }));
});
// The read-only tool, from logs and calls only, against the state dump.
{
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const gate = join(work, "gate.json");
  await w.gate(gate);
  const state = join(work, "footprint-state.json");
  let tool;
  try {
    tool = execFileSync(process.execPath, [join(ROOT, "scripts/ops/dex-storage-footprint.mjs"), "--config", gate, "--rpc", net.url, "--state", state, "--json"]).toString();
  } catch (e) {
    tool = e.stdout.toString() || e.stderr.toString();
  }
  const r = JSON.parse(tool);
  const c = count(last);
  console.log(big({ crossCheck: true, tool: { status: r.status, total: r.total, perContract: r.perContract, capacitySlots: r.capacitySlots, height: r.height }, dump: { pair: c.pair, WBLCH: c.WBLCH, bUSDC: c.bUSDC, sum: c.pair + c.WBLCH + c.bUSDC } }));
}
console.log(big({ done: true, finalTotals: count(last) }));
process.exit(0);
