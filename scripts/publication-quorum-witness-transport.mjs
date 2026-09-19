#!/usr/bin/env node
import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { checkServerIdentity } from "node:tls";
import {
  canonicalJson,
  canonicalSha256,
  readJson,
  readPrivateKey,
  writeNewJson,
} from "./live-auth/envelope.mjs";
import {
  authorizeCustodyRequest,
  validateCustodyConfig,
} from "./publication-quorum-witness-custody.mjs";
import {
  validateWitnessConfig,
  verifyWitnessReceipt,
} from "./publication-quorum-witness.mjs";

const HEX = /^[0-9a-f]{64}$/;
const PATH = /^\/[A-Za-z0-9/_-]{1,127}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_CONFIG = 64_000;

function fail(message) {
  throw new Error(`publication quorum transport: ${message}`);
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${field} fields are invalid`);
}

function integerRange(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${field} is outside its allowed range`);
  return value;
}

function absolutePath(value, field) {
  if (typeof value !== "string" || !isAbsolute(value))
    fail(`${field} must be an explicit absolute path`);
  return value;
}

function fingerprint(value, field) {
  if (typeof value !== "string") fail(`${field} is invalid`);
  const normalized = value.replaceAll(":", "").toLowerCase();
  if (!HEX.test(normalized)) fail(`${field} is invalid`);
  return normalized;
}

function endpoint(value, field) {
  exactKeys(
    value,
    ["host", "port", "path", "timeoutMs", "maxBodyBytes"],
    field,
  );
  if (
    typeof value.host !== "string" ||
    isIP(value.host) === 0 ||
    value.host === "0.0.0.0" ||
    value.host === "::" ||
    typeof value.path !== "string" ||
    !PATH.test(value.path)
  )
    fail(`${field} host or path is invalid`);
  integerRange(value.port, 1, 65_535, `${field} port`);
  integerRange(value.timeoutMs, 500, 30_000, `${field} timeout`);
  integerRange(value.maxBodyBytes, 1_024, 262_144, `${field} body limit`);
  return value;
}

export function validateServerConfig(config) {
  exactKeys(
    config,
    [
      "schemaVersion",
      "endpoint",
      "maxConnections",
      "clientCertificateSha256",
      "tlsCertificatePath",
      "tlsPrivateKeyPath",
      "clientCaCertificatePath",
      "custodyStorePath",
      "custodyConfigPath",
      "witnessPrivateKeyPath",
    ],
    "server config",
  );
  if (config.schemaVersion !== 1) fail("server config schema is unsupported");
  endpoint(config.endpoint, "server endpoint");
  integerRange(config.maxConnections, 1, 64, "maximum connections");
  fingerprint(config.clientCertificateSha256, "client certificate fingerprint");
  for (const [key, label] of [
    ["tlsCertificatePath", "TLS certificate"],
    ["tlsPrivateKeyPath", "TLS private key"],
    ["clientCaCertificatePath", "client CA certificate"],
    ["custodyStorePath", "custody store"],
    ["custodyConfigPath", "custody config"],
    ["witnessPrivateKeyPath", "witness private key"],
  ])
    absolutePath(config[key], label);
  return config;
}

export function validateClientConfig(config) {
  exactKeys(
    config,
    [
      "schemaVersion",
      "endpoint",
      "serverCertificateSha256",
      "serverCaCertificatePath",
      "tlsCertificatePath",
      "tlsPrivateKeyPath",
    ],
    "client config",
  );
  if (config.schemaVersion !== 1) fail("client config schema is unsupported");
  endpoint(config.endpoint, "client endpoint");
  fingerprint(config.serverCertificateSha256, "server certificate fingerprint");
  for (const [key, label] of [
    ["serverCaCertificatePath", "server CA certificate"],
    ["tlsCertificatePath", "TLS certificate"],
    ["tlsPrivateKeyPath", "TLS private key"],
  ])
    absolutePath(config[key], label);
  return config;
}

async function readFileSecure(path, maximum, privateFile, field) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail(`${field} must be owned by the current user`);
    if (privateFile && (before.mode & 0o077) !== 0)
      fail(`${field} must not grant group or other permissions`);
    if (before.size < 1 || before.size > maximum) fail(`${field} size is invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      bytes.length !== after.size
    )
      fail(`${field} changed while it was being read`);
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function requestId(expectedHeadSha256, authenticatedRequest) {
  return canonicalSha256({
    schemaVersion: 1,
    expectedHeadSha256,
    authenticatedRequest,
  });
}

function requestBody(value) {
  exactKeys(
    value,
    ["schemaVersion", "requestId", "expectedHeadSha256", "authenticatedRequest"],
    "transport request",
  );
  if (
    value.schemaVersion !== 1 ||
    !HEX.test(value.requestId) ||
    (value.expectedHeadSha256 !== "genesis" &&
      !HEX.test(value.expectedHeadSha256)) ||
    value.requestId !==
      requestId(value.expectedHeadSha256, value.authenticatedRequest)
  )
    fail("transport request identity is invalid");
  return value;
}

function contentLength(value, maximum, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    fail(`${field} is missing or non-canonical`);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 2 || length > maximum)
    fail(`${field} is outside the configured bound`);
  return length;
}

async function readRequestBody(request, maximum, timeoutMs) {
  if (request.headers["content-type"] !== "application/json")
    fail("content type must be application/json");
  const declaredLength = contentLength(
    request.headers["content-length"],
    maximum,
    "content length",
  );
  const chunks = [];
  let received = 0;
  request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
  for await (const chunk of request) {
    received += chunk.length;
    if (received > declaredLength || received > maximum)
      fail("request body exceeds its declared or configured bound");
    chunks.push(chunk);
  }
  if (received !== declaredLength) fail("request body is truncated");
  const text = Buffer.concat(chunks).toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("request body is not valid JSON");
  }
  if (`${canonicalJson(value)}\n` !== text)
    fail("request body is not canonical JSON");
  return requestBody(value);
}

function send(response, statusCode, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(bytes);
}

export async function createCustodyServer(configInput) {
  const config = validateServerConfig(configInput);
  const [certificate, tlsKey, clientCa, custodyConfig, witnessPrivateKey] =
    await Promise.all([
      readFileSecure(config.tlsCertificatePath, 64_000, false, "TLS certificate"),
      readFileSecure(config.tlsPrivateKeyPath, 64_000, true, "TLS private key"),
      readFileSecure(
        config.clientCaCertificatePath,
        64_000,
        false,
        "client CA certificate",
      ),
      readJson(config.custodyConfigPath, MAX_CONFIG).then(validateCustodyConfig),
      readPrivateKey(config.witnessPrivateKeyPath),
    ]);
  const pinnedClient = fingerprint(
    config.clientCertificateSha256,
    "client certificate fingerprint",
  );
  const server = createServer(
    {
      cert: certificate,
      key: tlsKey,
      ca: clientCa,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      handshakeTimeout: config.endpoint.timeoutMs,
    },
    async (request, response) => {
      let parsedRequestId = null;
      try {
        if (
          request.method !== "POST" ||
          request.url !== config.endpoint.path ||
          !request.socket.authorized
        )
          fail("request method, path, or TLS authorization is invalid");
        const peer = request.socket.getPeerCertificate(true);
        if (
          !peer?.raw ||
          fingerprint(new X509Certificate(peer.raw).fingerprint256, "client certificate") !==
            pinnedClient
        )
          fail("client certificate pin does not match");
        const body = await readRequestBody(
          request,
          config.endpoint.maxBodyBytes,
          config.endpoint.timeoutMs,
        );
        parsedRequestId = body.requestId;
        const result = await authorizeCustodyRequest({
          store: config.custodyStorePath,
          config: custodyConfig,
          witnessPrivateKey,
          authenticatedRequest: body.authenticatedRequest,
          expectedHead: body.expectedHeadSha256,
        });
        send(response, 200, {
          schemaVersion: 1,
          status: "authorized",
          requestId: body.requestId,
          receiptSha256: result.receiptSha256,
          checkpointSha256: result.state.checkpointSha256,
          witnessSequence: result.state.witnessSequence,
          receipt: result.receipt,
        });
      } catch (error) {
        if (!response.headersSent)
          send(response, 409, {
            schemaVersion: 1,
            status: "rejected",
            requestId: parsedRequestId,
            error: String(error.message).slice(0, 512),
          });
        else response.destroy();
      }
    },
  );
  server.maxConnections = config.maxConnections;
  server.requestTimeout = config.endpoint.timeoutMs;
  server.headersTimeout = config.endpoint.timeoutMs;
  server.keepAliveTimeout = 1;
  return server;
}

async function sendOnce(config, body) {
  const bytes = Buffer.from(`${canonicalJson(body)}\n`);
  if (bytes.length > config.endpoint.maxBodyBytes)
    fail("transport request exceeds configured body limit");
  const [ca, certificate, tlsKey] = await Promise.all([
    readFileSecure(config.serverCaCertificatePath, 64_000, false, "server CA"),
    readFileSecure(config.tlsCertificatePath, 64_000, false, "client certificate"),
    readFileSecure(config.tlsPrivateKeyPath, 64_000, true, "client TLS key"),
  ]);
  const pin = fingerprint(
    config.serverCertificateSha256,
    "server certificate fingerprint",
  );
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const rejectAmbiguous = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(
        `transport outcome may be ambiguous (${error.message}); do not retry, inspect custody head`,
      ));
    };
    const request = httpsRequest({
      host: config.endpoint.host,
      port: config.endpoint.port,
      path: config.endpoint.path,
      method: "POST",
      ca,
      cert: certificate,
      key: tlsKey,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": bytes.length,
        connection: "close",
      },
      checkServerIdentity(host, certificateValue) {
        const hostnameError = checkServerIdentity(host, certificateValue);
        if (hostnameError) return hostnameError;
        const actual = fingerprint(
          new X509Certificate(certificateValue.raw).fingerprint256,
          "server certificate",
        );
        return actual === pin ? undefined : new Error("server certificate pin mismatch");
      },
      timeout: config.endpoint.timeoutMs,
    }, (response) => {
      const chunks = [];
      let received = 0;
      let declaredLength;
      try {
        if (response.headers["content-type"] !== "application/json")
          fail("response content type is invalid");
        declaredLength = contentLength(
          response.headers["content-length"],
          config.endpoint.maxBodyBytes,
          "response content length",
        );
      } catch {
        response.resume();
        rejectAmbiguous(new Error("response headers are invalid or unbounded"));
        return;
      }
      response.on("data", (chunk) => {
        received += chunk.length;
        if (
          received > declaredLength ||
          received > config.endpoint.maxBodyBytes
        ) {
          response.destroy(new Error("response exceeds configured body limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", rejectAmbiguous);
      response.on("end", () => {
        if (settled) return;
        if (received !== declaredLength) {
          rejectAmbiguous(new Error("response body is truncated"));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          rejectAmbiguous(new Error("response is not valid JSON"));
          return;
        }
        if (`${canonicalJson(value)}\n` !== text) {
          rejectAmbiguous(new Error("response body is not canonical JSON"));
          return;
        }
        settled = true;
        if (response.statusCode !== 200) {
          rejectPromise(new Error(
            `transport outcome may be ambiguous (HTTP ${response.statusCode}: ${String(value?.error ?? "unknown error").slice(0, 512)}); do not retry, inspect custody head`,
          ));
          return;
        }
        resolvePromise(value);
      });
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", rejectAmbiguous);
    request.end(bytes);
  });
}

function usage() {
  console.error(`Usage:
  node scripts/publication-quorum-witness-transport.mjs serve --config <server.json>
  node scripts/publication-quorum-witness-transport.mjs request --config <client.json> --witness-config <witness.json> --operations-store <private-directory> --authenticated-request <envelope.json> --expected-head-sha256 <genesis-or-sha256> --output <receipt.json>`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "serve") {
    if (args.length !== 2 || args[0] !== "--config" || !args[1])
      fail("serve requires exactly --config");
    const config = validateServerConfig(await readJson(args[1], MAX_CONFIG));
    const server = await createCustodyServer(config);
    server.listen(config.endpoint.port, config.endpoint.host, () => {
      console.log(canonicalJson({
        listening: true,
        host: config.endpoint.host,
        port: config.endpoint.port,
        path: config.endpoint.path,
      }));
    });
    return;
  }
  if (command === "request") {
    const names = [
      "--config", "--witness-config", "--authenticated-request",
      "--operations-store", "--expected-head-sha256", "--output",
    ];
    if (args.length !== names.length * 2) fail("request arguments are incomplete");
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!names.includes(args[index]) || Object.hasOwn(values, args[index]))
        fail("unexpected or duplicated request argument");
      values[args[index]] = args[index + 1];
    }
    if (names.some((name) => !values[name])) fail("request argument is missing");
    try {
      await lstat(values["--output"]);
      fail("receipt output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const config = validateClientConfig(await readJson(values["--config"], MAX_CONFIG));
    const witness = validateWitnessConfig(
      await readJson(values["--witness-config"], MAX_CONFIG),
    );
    const authenticatedRequest = await readJson(
      values["--authenticated-request"],
      config.endpoint.maxBodyBytes,
    );
    const expectedHeadSha256 = values["--expected-head-sha256"];
    if (expectedHeadSha256 !== "genesis" && !HEX.test(expectedHeadSha256))
      fail("expected head hash is invalid");
    const body = {
      schemaVersion: 1,
      requestId: requestId(expectedHeadSha256, authenticatedRequest),
      expectedHeadSha256,
      authenticatedRequest,
    };
    const {
      beginTransportRequest,
      buildClientPreflight,
      commitTransportRequest,
    } = await import("./publication-quorum-transport-operations.mjs");
    const manifest = await buildClientPreflight(config, witness);
    const manifestSha256 = canonicalSha256(manifest);
    await beginTransportRequest(
      values["--operations-store"],
      manifestSha256,
      expectedHeadSha256,
      body.requestId,
    );
    const response = await sendOnce(config, body);
    try {
      exactKeys(
        response,
        [
          "schemaVersion", "status", "requestId", "receiptSha256",
          "checkpointSha256", "witnessSequence", "receipt",
        ],
        "transport response",
      );
      if (
        response.schemaVersion !== 1 ||
        response.status !== "authorized" ||
        response.requestId !== body.requestId ||
        !HEX.test(response.receiptSha256) ||
        !HEX.test(response.checkpointSha256) ||
        !Number.isSafeInteger(response.witnessSequence) ||
        response.witnessSequence < 1 ||
        canonicalSha256(response.receipt) !== response.receiptSha256
      )
        fail("transport response identity is invalid");
      const payload = verifyWitnessReceipt(witness, response.receipt);
      if (
        canonicalJson(payload) !==
          canonicalJson(authenticatedRequest?.payload) ||
        payload.nextCheckpointSha256 !== response.checkpointSha256 ||
        payload.witnessSequence !== response.witnessSequence
      )
        fail("transport receipt does not authorize the authenticated request");
      await writeNewJson(values["--output"], response.receipt, 0o444);
      await commitTransportRequest(
        values["--operations-store"],
        body.requestId,
        response.receiptSha256,
      );
    } catch (error) {
      error.message = `${error.message}; custody may have advanced, do not retry, inspect custody head and export the durable receipt`;
      throw error;
    }
    console.log(canonicalJson({
      authorized: true,
      requestId: body.requestId,
      receiptSha256: response.receiptSha256,
      checkpointSha256: response.checkpointSha256,
      witnessSequence: response.witnessSequence,
    }));
    return;
  }
  usage();
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
