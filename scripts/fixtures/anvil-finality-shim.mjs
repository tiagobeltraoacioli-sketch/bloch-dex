// Local rehearsal shim ONLY: forwards JSON-RPC to an anvil node and answers
// `bloch_finality` from anvil's own `finalized` tag, so the finality gate can
// be exercised end to end on a throwaway chain. It is not Bloch finality and
// must never front a real network. Binds to 127.0.0.1.
import { createServer } from "node:http";

const [upstream, port] = process.argv.slice(2);
if (!upstream?.startsWith("http://127.0.0.1:") || !port) {
  console.error("usage: anvil-finality-shim.mjs http://127.0.0.1:<anvil-port> <listen-port>");
  process.exit(2);
}

async function forward(body) {
  const response = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
  return response.text();
}

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const message = JSON.parse(raw);
  let reply;
  if (message.method === "bloch_finality") {
    const finalized = JSON.parse(
      await forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] })),
    ).result;
    reply = JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { finalized: { number: finalized.number, hash: finalized.hash }, trust: "anvil rehearsal shim: not Bloch finality" },
    });
  } else {
    reply = await forward(raw);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(reply);
}).listen(Number(port), "127.0.0.1");
