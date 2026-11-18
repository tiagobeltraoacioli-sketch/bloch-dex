// Review demonstrations of agent 402 (round 19, sixth pass) at 400's `8f2f190`. Each test asserts the behaviour as
// it is; when a finding is fixed its test is restated to assert the refusal (not deleted).
//   node --test scripts/staging/r402-part2.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEPLOY_DOMAIN, EMPTY_CODE_HASH, OWNER_FEE_EOA, planDeployment, validateDeployConfig } from "./dex-deploy-config.mjs";
import { loopbackEndpoint } from "./deploy-dex.mjs";

const pins = JSON.parse(readFileSync(new URL("../../deployments/mainnet/700770/pins.json", import.meta.url), "utf8"));
const hash = (c) => `0x${c.repeat(64)}`;
const addr = (c) => `0x${c.repeat(40)}`;
const runtime = (byte, refs) => ({ bytecode: `0x60${byte}${"00".repeat(8)}`, deployedBytecode: `0x${byte.repeat(128)}`, immutableReferences: Object.fromEntries(refs.map((id, i) => [String(id), [{ start: 2 + i * 32, length: 32 }]])) });
const artifacts = { wrappedNative: runtime("01", []), factory: runtime("02", [3, 4]), router: runtime("03", [11, 7]), lens: runtime("04", [5]), pair: runtime("06", []) };

test("R402-9: a rehearsal-flagged configuration may carry chain 700770 AND the pinned mainnet genesis; with a loopback forwarder (ssh -L, a local proxy) the one-endpoint path then reads the real mainnet", async () => {
  const config = {
    schemaVersion: 1,
    domain: DEPLOY_DOMAIN,
    network: { name: "anything-local", chainId: pins.l2.chainId, genesisHash: pins.l2.genesisHash, rehearsal: true },
    source: { revision: "a".repeat(40), compiler: { solc: "0.8.24", evmVersion: "paris", optimizer: true, optimizerRuns: 200, bytecodeHash: "none" } },
    deployer: { address: addr("d"), startNonce: 0 },
    firstDepositor: addr("9"),
    blochInc: { address: OWNER_FEE_EOA, codeHash: EMPTY_CODE_HASH },
    wrappedNative: { deploy: true },
    fees: { feeTo: "blochInc" },
    reserveCaps: [{ token: "WBLCH", cap: "1000000000000000000" }, { symbol: "bUSDC", token: addr("a"), codeHash: hash("c"), bridgeBucketCapacity: "100000000", cap: "10000000" }],
    initialPairs: [{ tokenA: "WBLCH", tokenB: "bUSDC" }],
    gate: { maxWrappedReserveCap: "10000000000000000000" },
  };
  assert.equal(validateDeployConfig(structuredClone(config), { rehearsal: true }).network.genesisHash, pins.l2.genesisHash);
  const plan = planDeployment(structuredClone(config), artifacts, { rehearsal: true });
  assert.deepEqual(plan.chain, { id: 700770, genesisHash: pins.l2.genesisHash, rehearsal: true });
  // The loopback rule speaks about the first hop only: a forwarder's URL is loopback by every rule of the tool.
  assert.deepEqual(await loopbackEndpoint("http://127.0.0.1:8545"), { loopback: true, url: "http://127.0.0.1:8545" });
});

test("R402-10: with NODE_USE_ENV_PROXY=1 and HTTP_PROXY set, the request for a loopback URL is handed to the proxy (Node 24)", async () => {
  let viaProxy = 0;
  let direct = 0;
  const answer = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xab162" })); };
  const proxy = createServer((req, res) => { viaProxy += 1; answer(res); });
  // Node's fetch asks the proxy for a tunnel (CONNECT 127.0.0.1:PORT): the proxy, not this machine, decides which
  // host that name means. This stand-in proxy refuses the tunnel after counting it.
  proxy.on("connect", (req, socket) => { viaProxy += 1; socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  const node = createServer((req, res) => { direct += 1; answer(res); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  await new Promise((r) => node.listen(0, "127.0.0.1", r));
  try {
    const script = `import { createRpcTransport } from ${JSON.stringify(new URL("./rpc-transport.mjs", import.meta.url).href)}; console.log(await createRpcTransport(process.argv[1], { timeoutMs: 5000 })("eth_chainId", []));`;
    const run = (env) => new Promise((resolve) => {
      // Asynchronous spawn: the two servers live in this process and must keep answering.
      import("node:child_process").then(({ spawn }) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, `http://127.0.0.1:${node.address().port}`], { env: { PATH: "/usr/bin:/bin", ...env } });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.on("close", () => resolve(out.trim()));
      });
    });
    assert.equal(await run({}), "0xab162");
    assert.deepEqual([direct, viaProxy], [1, 0]);
    await run({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` });
    assert.deepEqual([direct, viaProxy], [1, 1], "the second request went to the proxy, not to the loopback endpoint that was checked");
  } finally {
    for (const s of [proxy, node]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  }
});

test("R402-11: the planned owner transactions are printed as cast send lines without --chain", () => {
  const text = readFileSync(fileURLToPath(new URL("../ops/dex-fee-redeem.mjs", import.meta.url)), "utf8");
  const line = text.split("\n").find((l) => l.includes("command: `cast send"));
  assert.ok(line && !line.includes("--chain"));
});
