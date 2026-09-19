import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { checkServerIdentity } from "node:tls";
import { canonicalJson, canonicalSha256 } from "./live-auth/envelope.mjs";

const HEX = /^[0-9a-f]{64}$/;
const PATH = /^\/[A-Za-z0-9/_-]{1,127}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_CREDENTIAL_BYTES = 64_000;

function fail(message) {
  throw new Error(`external anchor log mTLS adapter: ${message}`);
}

function exactKeys(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(`${field} fields are invalid`);
}

function range(value, minimum, maximum, field) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${field} is outside its allowed range`);
}

function fingerprint(value, field) {
  if (typeof value !== "string") fail(`${field} is invalid`);
  const normalized = value.replaceAll(":", "").toLowerCase();
  if (!HEX.test(normalized)) fail(`${field} is invalid`);
  return normalized;
}

function absolutePath(value, field) {
  if (typeof value !== "string" || !isAbsolute(value))
    fail(`${field} must be an explicit absolute path`);
}

export function validateExternalAnchorLogConfig(config) {
  exactKeys(config, [
    "schemaVersion", "endpoint", "serverCertificateSha256",
    "serverCaCertificatePath", "tlsCertificatePath", "tlsPrivateKeyPath",
  ], "config");
  if (config.schemaVersion !== 1) fail("config schema is unsupported");
  exactKeys(config.endpoint, ["host", "port", "path", "timeoutMs", "maxBodyBytes"], "endpoint");
  if (typeof config.endpoint.host !== "string" || isIP(config.endpoint.host) === 0 ||
      config.endpoint.host === "0.0.0.0" || config.endpoint.host === "::" ||
      typeof config.endpoint.path !== "string" || !PATH.test(config.endpoint.path))
    fail("endpoint must contain a unicast numeric IP and a bounded absolute path");
  range(config.endpoint.port, 1, 65_535, "endpoint port");
  range(config.endpoint.timeoutMs, 500, 30_000, "endpoint deadline");
  range(config.endpoint.maxBodyBytes, 1_024, 262_144, "endpoint body limit");
  fingerprint(config.serverCertificateSha256, "server certificate fingerprint");
  absolutePath(config.serverCaCertificatePath, "server CA certificate");
  absolutePath(config.tlsCertificatePath, "client certificate");
  absolutePath(config.tlsPrivateKeyPath, "client TLS key");
  return config;
}

async function secureBytes(path, privateFile, field) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      fail(`${field} must be a regular single-link file`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail(`${field} must be owned by the current user`);
    if (privateFile ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0)
      fail(`${field} permissions are unsafe`);
    if (before.size < 1 || before.size > MAX_CREDENTIAL_BYTES)
      fail(`${field} size is invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== 1 || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        after.mode !== before.mode || after.uid !== before.uid || after.gid !== before.gid ||
        bytes.length !== after.size)
      fail(`${field} changed while it was being read`);
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${field} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateQuery(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "streamId", "checkpointSha256", "checkpointGeneration",
  ], "latest-head query");
  if (value.schemaVersion !== 1 || value.kind !== "operations-anchor-log-query" ||
      !HEX.test(value.streamId) || !HEX.test(value.checkpointSha256) ||
      !Number.isSafeInteger(value.checkpointGeneration) || value.checkpointGeneration < 1)
    fail("latest-head query identity is invalid");
  return value;
}

function contentLength(value, maximum) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    fail("response content length is missing or non-canonical");
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 2 || length > maximum)
    fail("response content length is outside the configured bound");
  return length;
}

function validateHead(value, query) {
  exactKeys(value, [
    "schemaVersion", "kind", "streamId", "logSequence", "evidenceSha256", "evidence",
  ], "latest-head response");
  if (value.schemaVersion !== 1 || value.kind !== "operations-anchor-log-head" ||
      value.streamId !== query.streamId ||
      !Number.isSafeInteger(value.logSequence) || value.logSequence < 1 ||
      typeof value.evidenceSha256 !== "string" || !HEX.test(value.evidenceSha256) ||
      canonicalSha256(value.evidence) !== value.evidenceSha256)
    fail("latest-head response identity is invalid");
  return value;
}

function requestOnce(config, credentials, query) {
  const bytes = Buffer.from(`${canonicalJson(query)}\n`);
  if (bytes.length > config.endpoint.maxBodyBytes)
    fail("latest-head query exceeds the configured body limit");
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const reject = (error) => finish(
      rejectPromise,
      new Error(`external anchor latest-head request failed (${String(error?.message ?? error).slice(0, 512)}); no retry was attempted`),
    );
    const deadline = setTimeout(() => {
      request.destroy(new Error("absolute request deadline exceeded"));
    }, config.endpoint.timeoutMs);
    const request = httpsRequest({
      host: config.endpoint.host,
      port: config.endpoint.port,
      path: config.endpoint.path,
      method: "POST",
      ca: credentials.ca,
      cert: credentials.certificate,
      key: credentials.key,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": bytes.length,
        connection: "close",
      },
      checkServerIdentity(host, peer) {
        const identityError = checkServerIdentity(host, peer);
        if (identityError) return identityError;
        const actual = fingerprint(
          new X509Certificate(peer.raw).fingerprint256,
          "server certificate fingerprint",
        );
        return actual === credentials.pin ? undefined : new Error("server certificate pin mismatch");
      },
    }, (response) => {
      const chunks = [];
      let received = 0;
      let declared;
      try {
        if (response.statusCode !== 200) fail(`server returned HTTP ${response.statusCode}`);
        if (response.headers["content-type"] !== "application/json")
          fail("response content type is invalid");
        declared = contentLength(response.headers["content-length"], config.endpoint.maxBodyBytes);
      } catch (error) {
        response.resume();
        reject(error);
        return;
      }
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > declared || received > config.endpoint.maxBodyBytes)
          response.destroy(new Error("response exceeds its declared or configured bound"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        if (received !== declared) return reject(new Error("response body is truncated"));
        const text = Buffer.concat(chunks).toString("utf8");
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          return reject(new Error("response is not valid JSON"));
        }
        if (`${canonicalJson(value)}\n` !== text)
          return reject(new Error("response is not canonical JSON"));
        try {
          finish(resolvePromise, validateHead(value, query));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end(bytes);
  });
}

export async function createExternalAnchorLogAdapter(configInput) {
  validateExternalAnchorLogConfig(configInput);
  const config = Object.freeze({
    ...configInput,
    endpoint: Object.freeze({ ...configInput.endpoint }),
  });
  const [ca, certificate, key] = await Promise.all([
    secureBytes(config.serverCaCertificatePath, false, "server CA certificate"),
    secureBytes(config.tlsCertificatePath, false, "client certificate"),
    secureBytes(config.tlsPrivateKeyPath, true, "client TLS key"),
  ]);
  let caCertificate;
  let clientCertificate;
  let privateKey;
  try {
    caCertificate = new X509Certificate(ca);
    clientCertificate = new X509Certificate(certificate);
    privateKey = createPrivateKey(key);
  } catch {
    fail("CA, client certificate, or client TLS key is invalid");
  }
  if (!caCertificate.ca) fail("server CA certificate is not a CA");
  const certificateKey = clientCertificate.publicKey.export({ format: "der", type: "spki" });
  const privatePublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!certificateKey.equals(privatePublicKey))
    fail("client TLS key does not match the client certificate");
  const now = Date.now();
  for (const [parsed, field] of [[caCertificate, "server CA"], [clientCertificate, "client certificate"]]) {
    const start = Date.parse(parsed.validFrom);
    const end = Date.parse(parsed.validTo);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now)
      fail(`${field} is not currently valid`);
  }
  const credentials = Object.freeze({
    ca,
    certificate,
    key,
    pin: fingerprint(config.serverCertificateSha256, "server certificate fingerprint"),
  });
  return Object.freeze({
    readLatestHead(queryInput) {
      return requestOnce(config, credentials, validateQuery(queryInput));
    },
  });
}
