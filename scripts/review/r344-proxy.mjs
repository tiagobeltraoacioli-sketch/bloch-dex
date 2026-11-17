#!/usr/bin/env node
// Review 344: scripts/multichain/endpoint-proxy.mjs with two more modes, for the states the line's rehearsal never
// produces, and a time-stamped request log.
//
//   node scripts/review/r344-proxy.mjs <listen port> <target http://127.0.0.1:PORT>
//   POST /__control {"mode": "ok" | "limit" | "lie" | "silent" | "stale" | "behind", "lag": N}
//   GET  /__control -> {mode, requests, methods, log: [[ms, method, pinnedHash|null], ...]}
//
//   stale   refuse every read pinned to a block hash the way a public endpoint without old state does (HTTP 403,
//           "Archive requests require a personal token": review R328-4/R328-5), forward everything else
//   behind  answer `latest` (eth_getBlockByNumber) and eth_blockNumber with the block `lag` blocks below the head
//
// Loopback only.
import http from "node:http";

const [listen, target] = process.argv.slice(2);
if (!/^\d+$/.test(listen ?? "") || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(target ?? "")) {
  console.error("usage: r344-proxy.mjs <listen port> <http://127.0.0.1:PORT>");
  process.exit(2);
}
const MODES = ["ok", "limit", "lie", "silent", "stale", "behind"];
let mode = "ok";
let lag = 5;
let requests = 0;
const methods = {};
const log = [];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
const pinnedHash = (call) => (["eth_call", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount"].includes(call?.method) && typeof call.params?.at(-1)?.blockHash === "string" ? call.params.at(-1).blockHash : null);
const flip = (hex) => (typeof hex === "string" && /^0x[0-9a-f]+$/i.test(hex) ? `${hex.slice(0, -1)}${hex.endsWith("1") ? "2" : "1"}` : hex);
const read = (req) => new Promise((resolve) => { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => resolve(body)); });
const forward = async (body) => {
  const answer = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: answer.status, text: await answer.text() };
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  if (req.url === "/__control") {
    if (req.method === "POST") {
      const wanted = JSON.parse((await read(req)) || "{}");
      if (!MODES.includes(wanted.mode)) return res.writeHead(400, CORS).end("unknown mode");
      mode = wanted.mode;
      if (Number.isInteger(wanted.lag)) lag = wanted.lag;
    }
    return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ mode, requests, methods, log }));
  }
  const body = await read(req);
  requests++;
  let call = null;
  try {
    call = JSON.parse(body);
    const name = call.method ?? "batch";
    methods[name] = (methods[name] ?? 0) + 1;
    if (log.length < 20000) log.push([Date.now(), name, pinnedHash(call)]);
  } catch {
    methods.unreadable = (methods.unreadable ?? 0) + 1;
  }
  if (mode === "limit") return res.writeHead(429, { ...CORS, "content-type": "text/plain", "retry-after": "5" }).end("Too Many Requests");
  if (mode === "silent") return req.socket.destroy();
  if (mode === "stale" && call && pinnedHash(call)) return res.writeHead(403, { ...CORS, "content-type": "text/plain" }).end("Archive requests require a personal token");
  try {
    let sent = body;
    if (mode === "behind" && call && !Array.isArray(call)) {
      const head = BigInt(JSON.parse((await forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }))).text).result);
      const old = `0x${(head - BigInt(lag)).toString(16)}`;
      if (call.method === "eth_blockNumber") return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: old }));
      if (call.method === "eth_getBlockByNumber" && call.params?.[0] === "latest") sent = JSON.stringify({ ...call, params: [old, ...call.params.slice(1)] });
    }
    const answer = await forward(sent);
    let text = answer.text;
    if (mode === "lie") {
      const reply = JSON.parse(text);
      if (call && !Array.isArray(call) && pinnedHash(call) && typeof reply.result === "string") text = JSON.stringify({ ...reply, result: flip(reply.result) });
    }
    res.writeHead(answer.status, { ...CORS, "content-type": "application/json" }).end(text);
  } catch (error) {
    res.writeHead(502, { ...CORS, "content-type": "text/plain" }).end(String(error.message ?? error));
  }
}).listen(Number(listen), "127.0.0.1");
