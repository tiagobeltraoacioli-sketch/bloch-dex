#!/usr/bin/env node
// A stand-in for one public RPC endpoint in the page rehearsal (rehearse-page.mjs):
//
//   node scripts/multichain/endpoint-proxy.mjs <listen port> <target http://127.0.0.1:PORT>
//
// It forwards JSON-RPC to a loopback fork, so the page reads each chain through TWO endpoints as it does in
// production (multichain/rpc.ts, `agreeingRpc`), and it can be told to misbehave the way a public endpoint does:
//
//   POST /__control {"mode": "ok" | "limit" | "lie" | "silent"}     GET /__control -> {mode, requests, methods}
//
//   ok      forward everything
//   limit   answer every request with HTTP 429 (with the headers a browser needs to read the status)
//   lie     forward, but change the answer of every read pinned to a block hash (the last hex digit of the result)
//   silent  accept the request and close the connection without an answer
//
// Loopback only: it listens on 127.0.0.1 and refuses a target that is not a loopback URL.
import http from "node:http";

const [listen, target] = process.argv.slice(2);
if (!/^\d+$/.test(listen ?? "") || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(target ?? "")) {
  console.error("usage: endpoint-proxy.mjs <listen port> <http://127.0.0.1:PORT>");
  process.exit(2);
}
const MODES = ["ok", "limit", "lie", "silent"];
let mode = "ok";
let requests = 0;
const methods = {};
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
const pinned = (call) => ["eth_call", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount"].includes(call?.method) && typeof call.params?.at(-1)?.blockHash === "string";
const flip = (hex) => (typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex) ? `${hex.slice(0, -1)}${hex.endsWith("1") ? "2" : "1"}` : hex);
const read = (req) => new Promise((resolve) => { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => resolve(body)); });

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  if (req.url === "/__control") {
    if (req.method === "POST") {
      const wanted = JSON.parse((await read(req)) || "{}").mode;
      if (!MODES.includes(wanted)) return res.writeHead(400, CORS).end("unknown mode");
      mode = wanted;
    }
    return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ mode, requests, methods }));
  }
  const body = await read(req);
  requests++;
  try {
    const name = JSON.parse(body).method ?? "batch";
    methods[name] = (methods[name] ?? 0) + 1;
  } catch {
    methods.unreadable = (methods.unreadable ?? 0) + 1;
  }
  if (mode === "limit") return res.writeHead(429, { ...CORS, "content-type": "text/plain", "retry-after": "5" }).end("Too Many Requests");
  if (mode === "silent") return req.socket.destroy();
  try {
    const answer = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
    let text = await answer.text();
    if (mode === "lie") {
      const call = JSON.parse(body);
      const reply = JSON.parse(text);
      if (!Array.isArray(call) && pinned(call) && typeof reply.result === "string") text = JSON.stringify({ ...reply, result: flip(reply.result) });
    }
    res.writeHead(answer.status, { ...CORS, "content-type": "application/json" }).end(text);
  } catch (error) {
    res.writeHead(502, { ...CORS, "content-type": "text/plain" }).end(String(error.message ?? error));
  }
}).listen(Number(listen), "127.0.0.1");
