import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:https";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { sha256, stableJson } from "../staging/manifest.mjs";

const execute = promisify(execFile);
const repository = resolve(".");
const nodeBin = process.execPath;
const cli = resolve("scripts/live-auth.mjs");
const vite = resolve("frontend/node_modules/vite/bin/vite.js");
const chromeCandidates = [
  process.env.POSTERN_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const H1 = `0x${"11".repeat(32)}`;
const H2 = `0x${"22".repeat(32)}`;

async function existingChrome() {
  for (const path of chromeCandidates) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Try the next explicit candidate.
    }
  }
  return null;
}

function contract(suffix) {
  return { address: `0x${"00".repeat(19)}${suffix}`, runtimeCodeHash: H2 };
}

function manifest(rpcUrl) {
  const deploymentConfiguration = {
    schemaVersion: 2,
    environment: "staging",
    host: "bloch-dex",
    frontendMode: "preview",
    liquidityEnabled: false,
    chain: { id: 31337, genesisHash: H1, rpcUrl },
    deployment: {
      blockNumber: 12,
      blockHash: H2,
      pairInitCodeHash: H1,
      factory: contract("01"),
      router: contract("02"),
      lens: contract("03"),
      collector: contract("04"),
      wrappedNative: contract("05"),
    },
    tokens: [
      {
        ...contract("05"),
        symbol: "WBLCH",
        name: "Wrapped BLCH",
        decimals: 18,
        wrappedNative: true,
        policy: { feeOnTransfer: false, rebasing: false },
      },
      {
        ...contract("06"),
        symbol: "ASSET",
        name: "Asset",
        decimals: 6,
        wrappedNative: false,
        policy: { feeOnTransfer: false, rebasing: false },
      },
    ],
  };
  return {
    schemaVersion: 1,
    target: {
      environment: "staging",
      host: "bloch-dex",
      frontendMode: "preview",
      liquidityEnabled: false,
    },
    sourceRevision: "a".repeat(40),
    deploymentConfiguration,
    configurationSha256: sha256(stableJson(deploymentConfiguration)),
    frontendLockSha256: "b".repeat(64),
    files: [{ path: "index.html", bytes: 5, sha256: "c".repeat(64) }],
  };
}

async function keyFiles(root, name) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = join(root, `${name}-private.pem`);
  const publicPath = join(root, `${name}-public.pem`);
  await writeFile(
    privatePath,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await chmod(privatePath, 0o600);
  await writeFile(
    publicPath,
    publicKey.export({ format: "pem", type: "spki" }),
  );
  const inspected = JSON.parse(
    (
      await execute(nodeBin, [cli, "inspect-key", "--public-key", publicPath], {
        cwd: repository,
      })
    ).stdout,
  );
  return {
    privatePath,
    publicPath,
    pin: inspected.publicKeyBase64Url,
    keyId: inspected.keyId,
  };
}

async function runCli(...args) {
  await runCliAtGeneration("7", ...args);
}

async function runCliAtGeneration(generation, ...args) {
  const [command, ...rest] = args;
  await execute(
    nodeBin,
    [cli, command, "--key-generation", generation, ...rest],
    { cwd: repository },
  );
}

function gate(origin, issuedAt, expiresAt) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "read-only",
    registryUrl: "/artifact.signed.json",
    issuedAt,
    expiresAt,
    allowedRpcOrigins: [origin],
    timeoutMs: 2_000,
  };
}

function injectGate(index, envelope) {
  const gated = envelope
    ? index.replace(
        "</head>",
        `<script id="postern-live-read-config" type="application/json">${JSON.stringify(envelope).replaceAll("<", "\\u003c")}</script></head>`,
      )
    : index;
  // Hold the load event long enough for WebCrypto, fetch and React effects to settle.
  return gated.replace(
    "</body>",
    '<img hidden src="/acceptance-wait" alt="" /></body>',
  );
}

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

test("CLI-signed bundles pass real Chrome WebCrypto and remain read-only", async (t) => {
  const chrome = await existingChrome();
  if (!chrome) return t.skip("Chrome/Chromium is not installed");
  const root = await mkdtemp(join(tmpdir(), "postern-browser-auth-"));
  const certificate = join(root, "certificate.pem");
  const certificateKey = join(root, "certificate-key.pem");
  await execute("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    certificateKey,
    "-out",
    certificate,
  ]);
  const requests = [];
  const witnessRequests = [];
  let indexHtml = "";
  let signedManifest = "";
  let signedWitness = "";
  const site = join(root, "site");
  const witnessServer = createServer(
    { cert: await readFile(certificate), key: await readFile(certificateKey) },
    (request, response) => {
      witnessRequests.push({
        method: request.method,
        path: request.url,
        cookie: request.headers.cookie,
        referer: request.headers.referer,
      });
      if (request.method !== "GET" || request.url !== "/current.json") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": request.headers.origin ?? "null",
        "cache-control": "no-store",
      });
      response.end(signedWitness);
    },
  );
  await new Promise((resolveListen) =>
    witnessServer.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise((resolveClose) => {
        witnessServer.closeAllConnections();
        witnessServer.close(resolveClose);
      }),
  );
  const witnessAddress = witnessServer.address();
  assert(witnessAddress && typeof witnessAddress === "object");
  const witnessOrigin = `https://127.0.0.1:${witnessAddress.port}`;
  const server = createServer(
    { cert: await readFile(certificate), key: await readFile(certificateKey) },
    async (request, response) => {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const rpc = JSON.parse(body);
        requests.push({
          method: "POST",
          path: "/",
          rpc: rpc.method,
          cookie: request.headers.cookie,
          referer: request.headers.referer,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "0x1" }),
        );
        return;
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        cookie: request.headers.cookie,
      });
      if (url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "browser_acceptance=1; Secure; SameSite=Strict",
        });
        response.end(indexHtml);
        return;
      }
      if (url.pathname === "/artifact.signed.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(signedManifest);
        return;
      }
      if (url.pathname === "/acceptance-wait") {
        setTimeout(() => response.writeHead(204).end(), 1_500);
        return;
      }
      const path = resolve(site, `.${url.pathname}`);
      if (!path.startsWith(`${resolve(site)}${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.writeHead(200, {
          "content-type":
            contentTypes[extname(path)] ?? "application/octet-stream",
        });
        response.end(await readFile(path));
      } catch {
        response.writeHead(404).end();
      }
    },
  );
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(resolveClose);
      }),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `https://127.0.0.1:${address.port}`;
  const primary = await keyFiles(root, "primary");
  const secondary = await keyFiles(root, "secondary");
  const witness = await keyFiles(root, "witness");
  await execute(nodeBin, [vite, "build", "--outDir", site, "--emptyOutDir"], {
    cwd: resolve("frontend"),
    env: {
      ...process.env,
      VITE_POSTERN_LIVE_READ_PUBLIC_KEY: primary.pin,
      VITE_POSTERN_LIVE_READ_KEY_GENERATION: "7",
      VITE_POSTERN_LIVE_WITNESS_URL: `${witnessOrigin}/current.json`,
      VITE_POSTERN_LIVE_WITNESS_PUBLIC_KEY: witness.pin,
      VITE_POSTERN_LIVE_WITNESS_KEY_GENERATION: "7",
    },
  });
  const baseIndex = await readFile(join(site, "index.html"), "utf8");
  const payloadPath = join(root, "manifest.json");
  const signedManifestPath = join(root, "manifest.signed.json");
  await writeFile(payloadPath, JSON.stringify(manifest(`${origin}/`)));
  await runCli(
    "sign-manifest",
    "--private-key",
    primary.privatePath,
    "--input",
    payloadPath,
    "--output",
    signedManifestPath,
  );
  signedManifest = await readFile(signedManifestPath, "utf8");
  const now = Math.floor(Date.now() / 1_000);
  const witnessInput = join(root, "witness.json");
  const witnessOutput = join(root, "witness.signed.json");
  await writeFile(
    witnessInput,
    JSON.stringify({
      schemaVersion: 1,
      liveReadKeyId: primary.keyId,
      minimumLiveReadKeyGeneration: 7,
      issuedAt: now - 30,
      expiresAt: now + 600,
    }),
  );
  await runCli(
    "sign-witness",
    "--private-key",
    witness.privatePath,
    "--input",
    witnessInput,
    "--at",
    String(now),
    "--output",
    witnessOutput,
  );
  signedWitness = await readFile(witnessOutput, "utf8");

  async function signedGate(
    name,
    keys,
    payload,
    at,
    manifestPath = signedManifestPath,
    generation = "7",
  ) {
    const input = join(root, `${name}.json`);
    const output = join(root, `${name}.signed.json`);
    await writeFile(input, JSON.stringify(payload));
    await runCliAtGeneration(
      generation,
      "sign-gate",
      "--private-key",
      keys.privatePath,
      "--input",
      input,
      "--manifest",
      manifestPath,
      "--at",
      String(at),
      "--output",
      output,
    );
    return JSON.parse(await readFile(output, "utf8"));
  }

  const validGate = await signedGate(
    "valid-gate",
    primary,
    gate(origin, now - 30, now + 600),
    now,
  );
  const expiredGate = await signedGate(
    "expired-gate",
    primary,
    gate(origin, now - 7_000, now - 100),
    now - 6_000,
  );
  const secondaryManifest = join(root, "secondary-manifest.signed.json");
  await runCli(
    "sign-manifest",
    "--private-key",
    secondary.privatePath,
    "--input",
    payloadPath,
    "--output",
    secondaryManifest,
  );
  const wrongKeyGate = await signedGate(
    "wrong-key-gate",
    secondary,
    gate(origin, now - 30, now + 600),
    now,
    secondaryManifest,
  );
  const priorManifest = join(root, "prior-manifest.signed.json");
  await runCliAtGeneration(
    "6",
    "sign-manifest",
    "--private-key",
    primary.privatePath,
    "--input",
    payloadPath,
    "--output",
    priorManifest,
  );
  const priorGenerationGate = await signedGate(
    "prior-generation-gate",
    primary,
    gate(origin, now - 30, now + 600),
    now,
    priorManifest,
    "6",
  );

  async function chromeDom(envelope, name) {
    requests.length = 0;
    witnessRequests.length = 0;
    indexHtml = injectGate(baseIndex, envelope);
    const profile = join(root, `profile-${name}`);
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--ignore-certificate-errors",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-pings",
      "--proxy-server=direct://",
      "--proxy-bypass-list=*",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const browser = spawn(chrome, args, { stdio: "ignore" });
    try {
      const activePort = join(profile, "DevToolsActivePort");
      let port;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          port = Number((await readFile(activePort, "utf8")).split("\n", 1)[0]);
          if (Number.isSafeInteger(port) && port > 0) break;
        } catch {
          // Chrome creates the file only after its debugging server is ready.
        }
        await delay(50);
      }
      assert(
        Number.isSafeInteger(port) && port > 0,
        "Chrome debugging endpoint did not start",
      );
      const targetResponse = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" },
      );
      assert.equal(targetResponse.ok, true);
      const target = await targetResponse.json();
      assert.equal(typeof target.webSocketDebuggerUrl, "string");
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolveOpen, rejectOpen) => {
        socket.addEventListener("open", resolveOpen, { once: true });
        socket.addEventListener("error", rejectOpen, { once: true });
      });
      let nextId = 1;
      const pending = new Map();
      let loaded;
      const loadEvent = new Promise((resolveLoad) => {
        loaded = resolveLoad;
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.method === "Page.loadEventFired") loaded();
        if (message.id && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        }
      });
      const send = (method, params = {}) =>
        new Promise((resolveSend, rejectSend) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveSend, reject: rejectSend });
          socket.send(JSON.stringify({ id, method, params }));
        });
      await send("Page.enable");
      await send("Page.navigate", { url: `${origin}/#/live-pools` });
      await Promise.race([
        loadEvent,
        delay(10_000).then(() => {
          throw new Error("Chrome page load timed out");
        }),
      ]);
      const evaluated = await send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      });
      socket.close();
      return evaluated.result.value;
    } finally {
      browser.kill("SIGKILL");
    }
  }

  const validDom = await chromeDom(validGate, "valid");
  assert.match(
    validDom,
    /reviewed deployment registry or RPC provider is unavailable/i,
  );
  assert.doesNotMatch(
    validDom,
    /Connect wallet|Review demo swap|Preview adding liquidity/,
  );
  const dataRequests = requests.filter(
    (entry) =>
      entry.path === "/artifact.signed.json" || entry.method === "POST",
  );
  assert.deepEqual(
    dataRequests.map(({ method, path, rpc }) => ({ method, path, rpc })),
    [
      { method: "GET", path: "/artifact.signed.json", rpc: undefined },
      { method: "POST", path: "/", rpc: "eth_chainId" },
    ],
  );
  assert.equal(dataRequests[0].cookie, "browser_acceptance=1");
  assert.equal(dataRequests[1].cookie, undefined);
  assert.equal(dataRequests[1].referer, undefined);
  assert.deepEqual(witnessRequests, [
    {
      method: "GET",
      path: "/current.json",
      cookie: undefined,
      referer: undefined,
    },
  ]);
  assert(
    dataRequests.every((entry) => !/^eth_(?:send|sign)/.test(entry.rpc ?? "")),
  );
  assert.equal(
    requests.some((entry) => /publication|checkpoint|receipt/.test(entry.path)),
    false,
    "the browser must not treat the offline publication log as authority",
  );

  const rejectingWitnessInput = join(root, "rejecting-witness.json");
  const rejectingWitnessOutput = join(root, "rejecting-witness.signed.json");
  await writeFile(
    rejectingWitnessInput,
    JSON.stringify({
      schemaVersion: 1,
      liveReadKeyId: primary.keyId,
      minimumLiveReadKeyGeneration: 8,
      issuedAt: now - 30,
      expiresAt: now + 600,
    }),
  );
  await runCli(
    "sign-witness",
    "--private-key",
    witness.privatePath,
    "--input",
    rejectingWitnessInput,
    "--at",
    String(now),
    "--output",
    rejectingWitnessOutput,
  );
  signedWitness = await readFile(rejectingWitnessOutput, "utf8");
  const rejectedByWitness = await chromeDom(validGate, "witness-floor");
  assert.match(rejectedByWitness, /could not be authenticated/i);
  assert.equal(
    requests.some(
      (entry) =>
        entry.path === "/artifact.signed.json" || entry.method === "POST",
    ),
    false,
  );
  assert.equal(witnessRequests.length, 1);
  signedWitness = await readFile(witnessOutput, "utf8");

  for (const [name, envelope, copy] of [
    ["expired", expiredGate, /did not pass validation/i],
    ["wrong-key", wrongKeyGate, /could not be authenticated/i],
    ["prior-generation", priorGenerationGate, /could not be authenticated/i],
    ["missing", null, /did not provide a reviewed/i],
  ]) {
    const dom = await chromeDom(envelope, name);
    assert.match(dom, copy);
    assert.equal(
      requests.some(
        (entry) =>
          entry.path === "/artifact.signed.json" || entry.method === "POST",
      ),
      false,
    );
  }
});
