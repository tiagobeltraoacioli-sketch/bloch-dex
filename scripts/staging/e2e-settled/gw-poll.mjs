// The UI's receipt poll through the real gateway: every 10 s, a 20 s timeout, the same call
// and an Origin header. One JSON line per poll: an "ok" answer, an HTTP error, a JSON-RPC
// error or a timeout (each would show a pending swap as failed in waitForReceipt today).
import { appendFileSync } from "node:fs";
const [url, out] = process.argv.slice(2);
const HASH = "0x" + "ab".repeat(32);
let id = 0;
for (;;) {
  const start = Date.now();
  let outcome = "ok", detail;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://blochdex.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_getTransactionReceipt", params: [HASH] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) { outcome = `http-${r.status}`; detail = (await r.text()).slice(0, 200); }
    else { const b = await r.json(); if (b.error) { outcome = "rpc-error"; detail = b.error; } }
  } catch (e) { outcome = e.name === "TimeoutError" ? "timeout" : "network"; detail = String(e).slice(0, 200); }
  appendFileSync(out, JSON.stringify({ t: new Date(start).toISOString(), outcome, ms: Date.now() - start, detail }) + "\n");
  await new Promise((r) => setTimeout(r, 10_000));
}
