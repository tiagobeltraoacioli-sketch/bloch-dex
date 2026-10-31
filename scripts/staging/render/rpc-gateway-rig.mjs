// Rehearsal rig ONLY, on loopback: stands in for the public RPC gateway (it
// answers CORS preflights and sends `Access-Control-Allow-Origin: *` as the
// production gateway does) and for the test wallet's signer (eth_sendTransaction
// is signed with a throwaway key by `cast mktx` and published).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const [upstream, port, key] = process.argv.slice(2);
if (!upstream?.startsWith("http://127.0.0.1:") || !port || !key) {
  console.error("usage: rpc-gateway-rig.mjs http://127.0.0.1:<rpc-port> <listen-port> <throwaway-key>");
  process.exit(2);
}
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const cast = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();

function send(tx) {
  const nonce = cast("nonce", tx.from, "--block", "latest", "--rpc-url", upstream);
  const args = ["mktx", "--chain", "700770", "--nonce", nonce, "--gas-limit", String(BigInt(tx.gas ?? "0x7a120")),
    "--gas-price", "5000000000", "--priority-gas-price", "1000000000", "--value", String(BigInt(tx.value ?? "0x0")),
    "--private-key", key, tx.to, tx.data ?? "0x"];
  const raw = cast(...args);
  cast("publish", "--rpc-url", upstream, raw);
  return cast("keccak", raw);
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let reply;
  const message = JSON.parse(raw);
  if (message.method === "eth_sendTransaction") {
    try {
      reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: send(message.params[0]) });
    } catch (error) {
      reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error.stderr ?? error) } });
    }
  } else {
    const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    reply = await r.text();
  }
  res.writeHead(200, { "content-type": "application/json", ...cors });
  res.end(reply);
}).listen(Number(port), "127.0.0.1");
