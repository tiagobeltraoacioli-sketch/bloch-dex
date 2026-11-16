// Review r16 (agent 309): independent read-only check of the chain facts in deployments/<chain>/chain.json.
// Usage: node scripts/review-onchain.mjs  (public endpoints, generic client, nothing signed or sent)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { keccak256, decodeAbiParameters } = createRequire(new URL("../frontend/package.json", import.meta.url))("viem");
const shared = JSON.parse(readFileSync(new URL("../deployments/multichain.json", import.meta.url)));
// Endpoints other than the two in the chain file where one is known, then the file's own.
const EXTRA = { "op-mainnet": "https://optimism.drpc.org", base: "https://base.drpc.org", "arbitrum-one": "https://arbitrum.drpc.org", linea: "https://linea.drpc.org", "bnb-smart-chain": "https://bsc-dataseed1.binance.org", ethereum: "https://eth.llamarpc.com" };
const rpc = (url) => async (method, params = []) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const str = (hex) => { try { return decodeAbiParameters([{ type: "string" }], hex)[0]; } catch { return `raw ${hex.slice(0, 20)}`; } };
const FEE = shared.feeTo.address;
for (const key of shared.chains) {
  const c = JSON.parse(readFileSync(new URL(`../deployments/${key}/chain.json`, import.meta.url)));
  for (const url of [EXTRA[key], ...c.rpc]) {
    const q = rpc(url);
    const out = { url };
    try {
      out.chainId = Number(BigInt(await q("eth_chainId")));
      out.chainOk = out.chainId === c.chain.chainId;
      try { const g = await q("eth_getBlockByNumber", ["0x0", false]); out.genesisOk = g ? g.hash === c.chain.genesisHash : "not served"; } catch (e) { out.genesisOk = `error ${e.message.slice(0, 40)}`; }
      out.deployerOk = keccak256(await q("eth_getCode", [shared.create2.deployer, "latest"])) === shared.create2.deployerCodeHash;
      for (const t of [c.wrappedNative, ...c.tokens]) {
        const code = await q("eth_getCode", [t.address, "latest"]);
        const symbol = str(await q("eth_call", [{ to: t.address, data: "0x95d89b41" }, "latest"]));
        const decimals = Number(BigInt(await q("eth_call", [{ to: t.address, data: "0x313ce567" }, "latest"])));
        out[t.symbol] = { codeOk: keccak256(code) === t.codeHash, symbol, decimals, decimalsOk: decimals === t.decimals };
      }
      const feeCode = await q("eth_getCode", [FEE, "latest"]);
      out.feeTo = { code: feeCode.slice(0, 50), nonce: Number(BigInt(await q("eth_getTransactionCount", [FEE, "latest"]))) };
      const [l, f] = [await q("eth_getBlockByNumber", ["latest", false]), await q("eth_getBlockByNumber", ["finalized", false])];
      out.finalityLagSeconds = Number(BigInt(l.timestamp) - BigInt(f.timestamp));
      // The planned reference addresses must be empty today.
    } catch (e) { out.error = e.message.slice(0, 80); }
    console.log(key, JSON.stringify(out));
  }
}
