import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, canonicalSha256 } from "./live-auth/envelope.mjs";
import {
  createExternalAnchorLogAdapter,
  validateExternalAnchorLogConfig,
} from "./publication-quorum-anchor-log-mtls.mjs";

const execute = promisify(execFile);

async function certificate(root, name) {
  const key = join(root, `${name}.key`);
  const cert = join(root, `${name}.crt`);
  await execute("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-subj", `/CN=${name}`,
    "-addext", "basicConstraints=critical,CA:true",
    "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1",
  ]);
  await chmod(key, 0o600);
  await chmod(cert, 0o444);
  return { key, cert };
}

async function fixture(handler) {
  const root = await mkdtemp(join(tmpdir(), "postern-anchor-log-mtls-"));
  const serverIdentity = await certificate(root, "anchor-log-server");
  const clientIdentity = await certificate(root, "anchor-log-client");
  const serverCertificate = await readFile(serverIdentity.cert);
  const server = createServer({
    cert: serverCertificate,
    key: await readFile(serverIdentity.key),
    ca: await readFile(clientIdentity.cert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  }, handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const config = {
    schemaVersion: 1,
    endpoint: {
      host: "127.0.0.1",
      port: server.address().port,
      path: "/v1/latest-head",
      timeoutMs: 1_000,
      maxBodyBytes: 1_024,
    },
    serverCertificateSha256: new X509Certificate(serverCertificate)
      .fingerprint256.replaceAll(":", "").toLowerCase(),
    serverCaCertificatePath: serverIdentity.cert,
    tlsCertificatePath: clientIdentity.cert,
    tlsPrivateKeyPath: clientIdentity.key,
  };
  return { root, server, config, clientIdentity };
}

function query() {
  return {
    schemaVersion: 1,
    kind: "operations-anchor-log-query",
    streamId: "a".repeat(64),
    checkpointSha256: "b".repeat(64),
    checkpointGeneration: 7,
  };
}

function head() {
  const evidence = { signed: "anchor-evidence" };
  return {
    schemaVersion: 1,
    kind: "operations-anchor-log-head",
    streamId: "a".repeat(64),
    logSequence: 19,
    evidenceSha256: canonicalSha256(evidence),
    evidence,
  };
}

function send(response, statusCode, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": bytes.length,
    connection: "close",
  });
  response.end(bytes);
}

test("latest-head adapter uses pinned mutual TLS and canonical bounded messages", async (t) => {
  let calls = 0;
  const value = await fixture((request, response) => {
    calls += 1;
    assert.equal(request.socket.authorized, true);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/latest-head");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(Buffer.concat(chunks).toString("utf8"), `${canonicalJson(query())}\n`);
      send(response, 200, head());
    });
  });
  t.after(() => new Promise((resolve) => value.server.close(resolve)));
  const adapter = await createExternalAnchorLogAdapter(value.config);
  assert.deepEqual(await adapter.readLatestHead(query()), head());
  assert.equal(calls, 1);
});

test("latest-head adapter refuses DNS, unsafe keys, and certificate substitution", async (t) => {
  const value = await fixture((_request, response) => send(response, 200, head()));
  t.after(() => new Promise((resolve) => value.server.close(resolve)));
  assert.throws(
    () => validateExternalAnchorLogConfig({
      ...value.config,
      endpoint: { ...value.config.endpoint, host: "anchor-log.example" },
    }),
    /numeric IP/,
  );
  await chmod(value.clientIdentity.key, 0o644);
  await assert.rejects(
    createExternalAnchorLogAdapter(value.config),
    /client TLS key permissions are unsafe/,
  );
  await chmod(value.clientIdentity.key, 0o600);
  const adapter = await createExternalAnchorLogAdapter({
    ...value.config,
    serverCertificateSha256: "f".repeat(64),
  });
  await assert.rejects(adapter.readLatestHead(query()), /server certificate pin mismatch.*no retry/);
});

test("latest-head adapter enforces one absolute deadline and never retries", async (t) => {
  let calls = 0;
  const value = await fixture((_request, response) => {
    calls += 1;
    setTimeout(() => send(response, 200, head()), 750);
  });
  t.after(() => new Promise((resolve) => value.server.close(resolve)));
  const adapter = await createExternalAnchorLogAdapter({
    ...value.config,
    endpoint: { ...value.config.endpoint, timeoutMs: 500 },
  });
  await assert.rejects(adapter.readLatestHead(query()), /absolute request deadline exceeded.*no retry/);
  assert.equal(calls, 1);
});

test("latest-head adapter rejects noncanonical, unbounded, and unsuccessful responses once", async (t) => {
  const modes = ["unbounded", "noncanonical", "failure"];
  let calls = 0;
  const value = await fixture((_request, response) => {
    const mode = modes[calls++];
    if (mode === "unbounded") {
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end("{}\n");
    } else if (mode === "noncanonical") {
      const bytes = Buffer.from(`${JSON.stringify(head(), null, 2)}\n`);
      response.writeHead(200, {
        "content-type": "application/json", "content-length": bytes.length, connection: "close",
      });
      response.end(bytes);
    } else send(response, 503, { error: "unavailable" });
  });
  t.after(() => new Promise((resolve) => value.server.close(resolve)));
  const adapter = await createExternalAnchorLogAdapter(value.config);
  await assert.rejects(adapter.readLatestHead(query()), /content length is missing.*no retry/);
  await assert.rejects(adapter.readLatestHead(query()), /not canonical JSON.*no retry/);
  await assert.rejects(adapter.readLatestHead(query()), /HTTP 503.*no retry/);
  assert.equal(calls, 3);
});
