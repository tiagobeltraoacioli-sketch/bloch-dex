import assert from "node:assert/strict";
import test from "node:test";
import { createJsonRpcRequest } from "./finality-gate.mjs";
import { CallReverted, createRequest, RpcError } from "../ops/dex-ops-lib.mjs";
import { MAX_RPC_RESPONSE_BYTES } from "./rpc-transport.mjs";

const endpoint = "https://rpc.invalid/";
const clients = [["gate", createJsonRpcRequest], ["operations", createRequest]];

for (const [name, create] of clients) {
  test(`${name} RPC keeps concurrent responses bound to their own request ID`, async () => {
    const pending = new Map();
    const request = create(endpoint, { fetchImpl: (_url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      const sent = JSON.parse(options.body);
      return new Promise((resolve) => pending.set(sent.id, resolve));
    } });
    const first = request("eth_chainId", []);
    const second = request("eth_blockNumber", []);
    pending.get(2)(Response.json({ jsonrpc: "2.0", id: 2, result: "second" }));
    pending.get(1)(Response.json({ jsonrpc: "2.0", id: 1, result: "first" }));
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  });

  for (const [caseName, response] of [
    ["wrong ID", { jsonrpc: "2.0", id: 2, result: "0x1" }],
    ["string ID", { jsonrpc: "2.0", id: "1", result: "0x1" }],
    ["null ID", { jsonrpc: "2.0", id: null, result: "0x1" }],
    ["missing ID", { jsonrpc: "2.0", result: "0x1" }],
    ["wrong version", { jsonrpc: "1.0", id: 1, result: "0x1" }],
    ["missing version", { id: 1, result: "0x1" }],
    ["missing result", { jsonrpc: "2.0", id: 1 }],
    ["result and error", { jsonrpc: "2.0", id: 1, result: "0x1", error: null }],
    ["null error", { jsonrpc: "2.0", id: 1, error: null }],
    ["error without code", { jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } }],
    ["error without message", { jsonrpc: "2.0", id: 1, error: { code: 3 } }],
    ["fractional error code", { jsonrpc: "2.0", id: 1, error: { code: 3.5, message: "execution reverted" } }],
    ["batch response to a single request", [{ jsonrpc: "2.0", id: 1, result: "0x1" }]],
    ["null envelope", null],
  ]) {
    test(`${name} RPC rejects response ${caseName}`, async () => {
      const request = create(endpoint, { fetchImpl: async () => Response.json(response) });
      await assert.rejects(request("eth_chainId", []), name === "operations" ? RpcError : /JSON-RPC/);
    });
  }

  test(`${name} RPC accepts an explicitly null result`, async () => {
    const request = create(endpoint, { fetchImpl: async () => Response.json({ jsonrpc: "2.0", id: 1, result: null }) });
    assert.equal(await request("eth_getTransactionReceipt", ["0x00"]), null);
  });

  for (const [caseName, response] of [
    ["non-JSON media type", () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}')],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["invalid UTF-8", () => new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), { headers: { "content-type": "application/json" } })],
    ["HTTP failure", () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }, { status: 503 })],
    ["oversized advertised response", () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }, { headers: { "content-length": String(MAX_RPC_RESPONSE_BYTES + 1) } })],
    ["invalid advertised size", () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }, { headers: { "content-length": "NaN" } })],
  ]) {
    test(`${name} RPC refuses ${caseName}`, async () => {
      const request = create(endpoint, { fetchImpl: async () => response() });
      await assert.rejects(request("eth_chainId", []));
    });
  }

  test(`${name} RPC cancels oversized streamed bodies even with a small declared length`, async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const request = create(endpoint, { fetchImpl: async () => new Response(stream, {
      headers: { "content-type": "application/json", "content-length": "1" },
    }) });
    await assert.rejects(request("eth_chainId", []), /exceeds/);
    assert.equal(cancelled, true);
  });

  test(`${name} RPC bounds both waiting for headers and waiting for body bytes`, async () => {
    let aborted = false;
    const noHeaders = create(endpoint, { timeoutMs: 20, fetchImpl: (_url, { signal }) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise(() => {});
    } });
    await assert.rejects(noHeaders("eth_chainId", []), /timed out/);
    assert.equal(aborted, true);
    let cancelled = false;
    const noBody = create(endpoint, { timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(noBody("eth_chainId", []), /timed out/);
    assert.equal(cancelled, true);
  });

  test(`${name} RPC refuses invalid deadlines before a request`, () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120_001, "1000"]) {
      assert.throws(() => create(endpoint, { timeoutMs }), /timeout/);
    }
  });
}

test("operations RPC reserves CallReverted for an explicit execution error", async () => {
  for (const [error, expected] of [
    [{ code: 3, message: "execution failed", data: "0x" }, CallReverted],
    [{ code: -32000, message: "execution reverted", data: "0x" }, CallReverted],
    [{ code: -32602, message: "invalid params", data: { reason: "block unavailable" } }, RpcError],
    [{ code: -32000, message: "node unavailable", data: "0x" }, RpcError],
  ]) {
    const request = createRequest(endpoint, { fetchImpl: async () => Response.json({ jsonrpc: "2.0", id: 1, error }) });
    await assert.rejects(request("eth_call", []), expected);
  }
});

test("operations RPC retains its method allowlist when the caller mutates the input", async () => {
  const allowed = ["eth_call"];
  let called = false;
  const request = createRequest(endpoint, { allowed, fetchImpl: async () => { called = true; } });
  allowed.push("eth_sendRawTransaction");
  await assert.rejects(request("eth_sendRawTransaction", ["0x"]), /refused/);
  assert.equal(called, false);
});
