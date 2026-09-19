import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJson,
  canonicalSha256,
  describeKey,
  signEnvelope,
} from "./live-auth/envelope.mjs";
import { CUSTODY_REQUEST_DOMAIN } from "./publication-quorum-witness-custody.mjs";
import {
  activateOperationsStore,
  buildClientPreflight,
  initializeOperationsStore,
  inspectOperationsStore,
  prepareOperationsAnchorStatement,
  signOperationsAnchorStatement,
} from "./publication-quorum-transport-operations.mjs";

const execute = promisify(execFile);
const custodyCli = resolve("scripts/publication-quorum-witness-custody.mjs");
const transportCli = resolve("scripts/publication-quorum-witness-transport.mjs");
const anchorAdapters = new Map();

async function run(cli, ...args) {
  if (cli === transportCli && args[0] === "request" &&
      !args.includes("--external-anchor-log-adapter")) {
    const storeIndex = args.indexOf("--operations-store");
    const anchor = storeIndex >= 0 ? anchorAdapters.get(args[storeIndex + 1]) : null;
    if (anchor) args.push(
      "--external-anchor-log-adapter", anchor.adapter,
      "--external-anchor-log-config", anchor.config,
    );
  }
  return execute(process.execPath, [cli, ...args], { cwd: resolve(".") });
}

async function privateKey(path, key) {
  await writeFile(path, key.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function certificate(root, name) {
  const key = join(root, `${name}.tls.key`);
  const cert = join(root, `${name}.tls.crt`);
  await execute("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key,
    "-out", cert,
    "-subj", `/CN=${name}`,
    "-addext", name === "server"
      ? "subjectAltName=IP:127.0.0.1"
      : `subjectAltName=DNS:${name}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-days", "1",
  ]);
  await chmod(key, 0o600);
  await chmod(cert, 0o444);
  const parsed = new X509Certificate(await readFile(cert));
  return {
    key,
    cert,
    fingerprint: parsed.fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function startServer(configPath) {
  const child = spawn(process.execPath, [transportCli, "serve", "--config", configPath], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`transport server did not start: ${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        const report = JSON.parse(stdout.split("\n", 1)[0]);
        if (!report.listening) rejectPromise(new Error("server did not listen"));
        else resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`transport server exited ${code}: ${stderr}`));
    });
  });
  return child;
}

test("mTLS transport pins both peers and performs a create-once custody CAS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "postern-custody-transport-"));
  const witnessKeys = generateKeyPairSync("ed25519");
  const clientKeys = generateKeyPairSync("ed25519");
  const witnessIdentity = describeKey(witnessKeys.publicKey);
  const clientIdentity = describeKey(clientKeys.publicKey);
  const witnessConfig = {
    schemaVersion: 1,
    storeId: "1".repeat(64),
    witnessId: "external-witness",
    keyId: witnessIdentity.keyId,
    keyGeneration: 1,
    publicKeyBase64Url: witnessIdentity.publicKeyBase64Url,
  };
  const custodyConfig = {
    schemaVersion: 1,
    custodyId: "independent-custody",
    witness: witnessConfig,
    authorizedClient: {
      clientId: "quorum-collector",
      keyId: clientIdentity.keyId,
      keyGeneration: 1,
      publicKeyBase64Url: clientIdentity.publicKeyBase64Url,
    },
  };
  const witnessConfigPath = join(root, "witness.json");
  const custodyConfigPath = join(root, "custody.json");
  const witnessPrivatePath = join(root, "witness.private.pem");
  await writeFile(witnessConfigPath, JSON.stringify(witnessConfig));
  await writeFile(custodyConfigPath, JSON.stringify(custodyConfig));
  await privateKey(witnessPrivatePath, witnessKeys.privateKey);

  const initialCheckpoint = "a".repeat(64);
  const custodyStore = join(root, "custody-store");
  await run(
    custodyCli,
    "init",
    "--store", custodyStore,
    "--config", custodyConfigPath,
    "--initial-checkpoint-sha256", initialCheckpoint,
  );
  const payload = {
    schemaVersion: 1,
    storeId: witnessConfig.storeId,
    witnessId: witnessConfig.witnessId,
    witnessSequence: 1,
    previousWitnessReceiptSha256: null,
    priorCheckpointSha256: initialCheckpoint,
    nextCheckpointSha256: "b".repeat(64),
    transitionRecordSha256: "c".repeat(64),
    transitionKind: "publication-quorum-advance",
  };
  const authenticatedRequest = signEnvelope(
    payload,
    clientKeys.privateKey,
    CUSTODY_REQUEST_DOMAIN,
    1,
  );
  const authenticatedPath = join(root, "authenticated-request.json");
  await writeFile(authenticatedPath, JSON.stringify(authenticatedRequest));

  const serverTls = await certificate(root, "server");
  const clientTls = await certificate(root, "client");
  const rogueTls = await certificate(root, "rogue");
  const port = await availablePort();
  const endpoint = {
    host: "127.0.0.1",
    port,
    path: "/v1/authorize",
    timeoutMs: 5_000,
    maxBodyBytes: 65_536,
  };
  const serverConfigPath = join(root, "server-config.json");
  await writeFile(serverConfigPath, JSON.stringify({
    schemaVersion: 1,
    endpoint,
    maxConnections: 4,
    clientCertificateSha256: clientTls.fingerprint,
    tlsCertificatePath: serverTls.cert,
    tlsPrivateKeyPath: serverTls.key,
    clientCaCertificatePath: clientTls.cert,
    custodyStorePath: custodyStore,
    custodyConfigPath,
    witnessPrivateKeyPath: witnessPrivatePath,
  }));
  const clientConfig = {
    schemaVersion: 1,
    endpoint,
    serverCertificateSha256: serverTls.fingerprint,
    serverCaCertificatePath: serverTls.cert,
    tlsCertificatePath: clientTls.cert,
    tlsPrivateKeyPath: clientTls.key,
  };
  const clientConfigPath = join(root, "client-config.json");
  await writeFile(clientConfigPath, JSON.stringify(clientConfig));

  async function operationsStore(name, selectedConfig = clientConfig, head = "genesis") {
    const store = join(root, name);
    const manifest = await buildClientPreflight(selectedConfig, witnessConfig);
    const manifestSha256 = canonicalSha256(manifest);
    await initializeOperationsStore(store, manifest, manifestSha256, head);
    const authorityKeys = generateKeyPairSync("ed25519");
    const authority = describeKey(authorityKeys.publicKey);
    const authorization = {
      schemaVersion: 1,
      authorizationId: `${name}-approval`,
      manifestSha256,
      expectedHeadSha256: head,
      enabled: true,
      authorityKeyId: authority.keyId,
      authorityKeyGeneration: 1,
      authorityPublicKeyBase64Url: authority.publicKeyBase64Url,
    };
    await activateOperationsStore(store, authorization, canonicalSha256(authorization));
    const statement = await prepareOperationsAnchorStatement(store);
    const evidence = signOperationsAnchorStatement(statement, authorityKeys.privateKey, 1);
    const externalHead = {
      schemaVersion: 1,
      kind: "operations-anchor-log-head",
      streamId: statement.streamId,
      logSequence: 1,
      evidenceSha256: canonicalSha256(evidence),
      evidence,
    };
    const adapter = join(root, `${name}-external-anchor-adapter.mjs`);
    const adapterConfig = join(root, `${name}-external-anchor-config.json`);
    await writeFile(
      adapter,
      `export async function createExternalAnchorLogAdapter(config) {
  if (Object.keys(config).length !== 0) throw new Error("unexpected test config");
  return { async readLatestHead() { return ${JSON.stringify(externalHead)}; } };
}\n`,
      { mode: 0o444 },
    );
    await writeFile(adapterConfig, "{}\n", { mode: 0o444 });
    await chmod(adapter, 0o444);
    await chmod(adapterConfig, 0o444);
    anchorAdapters.set(store, { adapter, config: adapterConfig });
    return store;
  }

  const server = await startServer(serverConfigPath);
  t.after(async () => {
    server.kill("SIGTERM");
    await new Promise((resolvePromise) => server.once("exit", resolvePromise));
  });

  const wrongPinPath = join(root, "wrong-pin-client.json");
  await writeFile(wrongPinPath, JSON.stringify({
    ...clientConfig,
    serverCertificateSha256: "0".repeat(64),
  }));
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", wrongPinPath,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("wrong-pin-operations", {
        ...clientConfig,
        serverCertificateSha256: "0".repeat(64),
      }),
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "wrong-pin-receipt.json"),
    ),
    /server certificate pin mismatch|outcome may be ambiguous/,
  );

  const rogueClientPath = join(root, "rogue-client.json");
  await writeFile(rogueClientPath, JSON.stringify({
    ...clientConfig,
    tlsCertificatePath: rogueTls.cert,
    tlsPrivateKeyPath: rogueTls.key,
  }));
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", rogueClientPath,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("rogue-operations", {
        ...clientConfig,
        tlsCertificatePath: rogueTls.cert,
        tlsPrivateKeyPath: rogueTls.key,
      }),
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "rogue-receipt.json"),
    ),
    /outcome may be ambiguous|certificate/,
  );

  const wrongPathClient = join(root, "wrong-path-client.json");
  await writeFile(wrongPathClient, JSON.stringify({
    ...clientConfig,
    endpoint: { ...endpoint, path: "/v1/wrong" },
  }));
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", wrongPathClient,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("wrong-path-operations", {
        ...clientConfig,
        endpoint: { ...endpoint, path: "/v1/wrong" },
      }),
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "wrong-path-receipt.json"),
    ),
    /outcome may be ambiguous.*do not retry.*inspect custody head/,
  );

  const oversizedRequest = join(root, "oversized-request.json");
  await writeFile(
    oversizedRequest,
    JSON.stringify({ padding: "x".repeat(2_000) }),
  );
  const boundedClient = join(root, "bounded-client.json");
  await writeFile(boundedClient, JSON.stringify({
    ...clientConfig,
    endpoint: { ...endpoint, maxBodyBytes: 1_024 },
  }));
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", boundedClient,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("bounded-operations", {
        ...clientConfig,
        endpoint: { ...endpoint, maxBodyBytes: 1_024 },
      }),
      "--authenticated-request", oversizedRequest,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "oversized-receipt.json"),
    ),
    /exceeds configured body limit|input size is invalid/,
  );

  const maliciousPort = await availablePort();
  const maliciousServer = createHttpsServer({
    cert: await readFile(serverTls.cert),
    key: await readFile(serverTls.key),
    ca: await readFile(clientTls.cert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    handshakeTimeout: 5_000,
  }, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const invalidReceipt = {};
      const value = {
        schemaVersion: 1,
        status: "authorized",
        requestId: received.requestId,
        receiptSha256: canonicalSha256(invalidReceipt),
        checkpointSha256: "b".repeat(64),
        witnessSequence: 1,
        receipt: invalidReceipt,
      };
      const bytes = Buffer.from(`${canonicalJson(value)}\n`);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": bytes.length,
        connection: "close",
      });
      response.end(bytes);
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    maliciousServer.once("error", rejectPromise);
    maliciousServer.listen(maliciousPort, "127.0.0.1", resolvePromise);
  });
  t.after(async () => {
    await new Promise((resolvePromise) => maliciousServer.close(resolvePromise));
  });
  const maliciousClient = join(root, "malicious-response-client.json");
  await writeFile(maliciousClient, JSON.stringify({
    ...clientConfig,
    endpoint: { ...endpoint, port: maliciousPort },
  }));
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", maliciousClient,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("malicious-operations", {
        ...clientConfig,
        endpoint: { ...endpoint, port: maliciousPort },
      }),
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "invalid-200-receipt.json"),
    ),
    /custody may have advanced, do not retry, inspect custody head and export/,
  );

  const occupied = join(root, "occupied.json");
  await writeFile(occupied, "occupied\n");
  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", clientConfigPath,
      "--witness-config", witnessConfigPath,
      "--operations-store", await operationsStore("occupied-operations"),
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", occupied,
    ),
    /output already exists/,
  );

  const receiptPath = join(root, "receipt.json");
  const liveOperations = await operationsStore("live-operations");
  const accepted = JSON.parse((await run(
    transportCli,
    "request",
    "--config", clientConfigPath,
    "--witness-config", witnessConfigPath,
    "--operations-store", liveOperations,
    "--authenticated-request", authenticatedPath,
    "--expected-head-sha256", "genesis",
    "--output", receiptPath,
  )).stdout);
  assert.equal(accepted.authorized, true);
  assert.equal(accepted.witnessSequence, 1);
  assert.equal(
    accepted.receiptSha256,
    canonicalSha256(JSON.parse(await readFile(receiptPath, "utf8"))),
  );
  const advancedOperations = await inspectOperationsStore(liveOperations);
  assert.equal(advancedOperations.status, "ready");
  assert.equal(advancedOperations.expectedHeadSha256, accepted.receiptSha256);

  await assert.rejects(
    run(
      transportCli,
      "request",
      "--config", clientConfigPath,
      "--witness-config", witnessConfigPath,
      "--operations-store", liveOperations,
      "--authenticated-request", authenticatedPath,
      "--expected-head-sha256", "genesis",
      "--output", join(root, "duplicate-receipt.json"),
    ),
    /expected custody head is stale or rolled back/,
  );
});
