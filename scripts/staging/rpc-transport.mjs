// Shared JSON-RPC transport for deployment checks and operations. Callers keep
// their method allowlists and classify valid RPC errors at their own boundary.
export const MAX_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

export class JsonRpcResponseError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}`);
    this.rpcError = error;
  }
}

function requireResponse(condition, message) {
  if (!condition) throw new Error(message);
}

/** How much of the body of an HTTP error answer is kept on the error (`httpBody`), for callers that classify it. */
export const MAX_HTTP_ERROR_BODY_BYTES = 1024;
/**
 * The first bytes of an HTTP error answer's body, as text; "" when it cannot be read. Never throws and never
 * reads more than MAX_HTTP_ERROR_BODY_BYTES (review R414-4: a caller must be able to tell an endpoint that refuses
 * a METHOD from one that refuses one request, and only the body says which).
 */
async function errorBodyExcerpt(response, signal) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) return "";
    const chunks = [];
    let length = 0;
    try {
      while (length < MAX_HTTP_ERROR_BODY_BYTES) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks, length).subarray(0, MAX_HTTP_ERROR_BODY_BYTES));
  } catch {
    return "";
  }
}

async function readBody(response, method, signal) {
  requireResponse(response.body?.getReader, `${method} response body is unavailable`);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      requireResponse(length <= MAX_RPC_RESPONSE_BYTES, `${method} response exceeds ${MAX_RPC_RESPONSE_BYTES} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createRpcTransport(url, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  requireResponse(typeof fetchImpl === "function", "RPC fetch is unavailable");
  requireResponse(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, "RPC timeout must be 1 to 120000 milliseconds");
  let nextId = 0;
  return async (method, params) => {
    requireResponse(nextId < Number.MAX_SAFE_INTEGER, "RPC request ID range is exhausted");
    const requestId = ++nextId;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${method} timed out after ${timeoutMs} milliseconds`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const exchange = async () => {
      const response = await fetchImpl(url, {
        method: "POST", redirect: "error", credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        // The message is what it always was; the status and the first bytes of the body are added as properties.
        const error = new Error(`${method} returned HTTP ${response.status}`);
        error.httpStatus = response.status;
        error.httpBody = await errorBodyExcerpt(response, controller.signal);
        throw error;
      }
      try {
        requireResponse(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""), `${method} returned a non-JSON content type`);
        const size = response.headers.get("content-length");
        requireResponse(size === null || (/^[0-9]+$/.test(size) && Number(size) <= MAX_RPC_RESPONSE_BYTES), `${method} response has invalid or excessive content-length`);
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      const bytes = await readBody(response, method, controller.signal);
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new Error(`${method} returned invalid UTF-8 JSON`); }
      requireResponse(body && typeof body === "object" && !Array.isArray(body) && body.jsonrpc === "2.0" && body.id === requestId &&
        Object.hasOwn(body, "result") !== Object.hasOwn(body, "error"), `${method} returned an invalid JSON-RPC envelope or response ID`);
      if (Object.hasOwn(body, "error")) {
        const error = body.error;
        requireResponse(error && typeof error === "object" && !Array.isArray(error) && Number.isSafeInteger(error.code) &&
          typeof error.message === "string", `${method} returned a malformed JSON-RPC error`);
        throw new JsonRpcResponseError(method, error);
      }
      return body.result;
    };
    try { return await Promise.race([exchange(), timeout]); }
    finally { clearTimeout(timer); controller.abort(); }
  };
}
