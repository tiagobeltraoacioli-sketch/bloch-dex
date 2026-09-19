import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256, stableJson } from "../staging/manifest.mjs";
import { canonicalJson } from "./envelope.mjs";

const execute = promisify(execFile);
const cli = resolve("scripts/live-auth.mjs");
const H1 = `0x${"11".repeat(32)}`;
const H2 = `0x${"22".repeat(32)}`;
const NOW = 2_000_000_000;

function contract(suffix) {
  return { address: `0x${"00".repeat(19)}${suffix}`, runtimeCodeHash: H2 };
}

function configuration() {
  return {
    schemaVersion: 2,
    environment: "staging",
    host: "bloch-dex",
    frontendMode: "preview",
    liquidityEnabled: false,
    chain: { id: 31337, genesisHash: H1, rpcUrl: "https://rpc.invalid/" },
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
}

function manifest(revision = "a".repeat(40)) {
  const deploymentConfiguration = configuration();
  return {
    schemaVersion: 1,
    target: {
      environment: "staging",
      host: "bloch-dex",
      frontendMode: "preview",
      liquidityEnabled: false,
    },
    sourceRevision: revision,
    deploymentConfiguration,
    configurationSha256: sha256(stableJson(deploymentConfiguration)),
    frontendLockSha256: "b".repeat(64),
    files: [{ path: "index.html", bytes: 5, sha256: "c".repeat(64) }],
  };
}

function gate() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "read-only",
    registryUrl: "/deployment/artifact.signed.json",
    issuedAt: NOW - 60,
    expiresAt: NOW + 3_600,
    allowedRpcOrigins: ["https://rpc.invalid"],
    timeoutMs: 8_000,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "postern-live-auth-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = join(root, "private.pem");
  const publicPath = join(root, "public.pem");
  const manifestPath = join(root, "manifest.json");
  const gatePath = join(root, "gate.json");
  await writeFile(
    privatePath,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await writeFile(
    publicPath,
    publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o644 },
  );
  await writeFile(manifestPath, JSON.stringify(manifest()));
  await writeFile(gatePath, JSON.stringify(gate()));
  return { root, privatePath, publicPath, manifestPath, gatePath };
}

async function run(...args) {
  return execute(process.execPath, [cli, ...args], { cwd: resolve(".") });
}

test("canonical JSON matches the browser signing format", () => {
  assert.equal(
    canonicalJson({ z: [true, null, "é"], a: { n: 7 } }),
    '{"a":{"n":7},"z":[true,null,"é"]}',
  );
  assert.throws(() => canonicalJson({ unsafe: 1.5 }), /safe integers/);
  assert.throws(() => canonicalJson({ negativeZero: -0 }), /safe integers/);
});

test("creates deterministic signed envelopes and verifies their exact bundle", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "manifest.signed.json");
  const signedManifest2 = join(files.root, "manifest.signed-2.json");
  const signedGate = join(files.root, "gate.signed.json");
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    files.manifestPath,
    "--output",
    signedManifest,
  );
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    files.manifestPath,
    "--output",
    signedManifest2,
  );
  assert.equal(
    await readFile(signedManifest, "utf8"),
    await readFile(signedManifest2, "utf8"),
  );
  await run(
    "sign-gate",
    "--private-key",
    files.privatePath,
    "--input",
    files.gatePath,
    "--manifest",
    signedManifest,
    "--at",
    String(NOW),
    "--output",
    signedGate,
  );
  const verified = await run(
    "verify-bundle",
    "--public-key",
    files.publicPath,
    "--gate",
    signedGate,
    "--manifest",
    signedManifest,
    "--at",
    String(NOW),
  );
  assert.equal(JSON.parse(verified.stdout).verified, true);
  const inspected = JSON.parse(
    (await run("inspect-key", "--public-key", files.publicPath)).stdout,
  );
  assert.match(inspected.publicKeyBase64Url, /^[A-Za-z0-9_-]{43}$/);
  assert.match(inspected.keyId, /^[0-9a-f]{64}$/);
});

test("rejects tampering, a substituted signed manifest and a different key", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "manifest.signed.json");
  const signedGate = join(files.root, "gate.signed.json");
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    files.manifestPath,
    "--output",
    signedManifest,
  );
  await run(
    "sign-gate",
    "--private-key",
    files.privatePath,
    "--input",
    files.gatePath,
    "--manifest",
    signedManifest,
    "--at",
    String(NOW),
    "--output",
    signedGate,
  );

  const tampered = JSON.parse(await readFile(signedManifest, "utf8"));
  tampered.payload.sourceRevision = "f".repeat(40);
  const tamperedPath = join(files.root, "tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    run(
      "verify-bundle",
      "--public-key",
      files.publicPath,
      "--gate",
      signedGate,
      "--manifest",
      tamperedPath,
      "--at",
      String(NOW),
    ),
    /signature is invalid/,
  );

  const alternativePayload = join(files.root, "alternative.json");
  const alternativeSigned = join(files.root, "alternative.signed.json");
  await writeFile(alternativePayload, JSON.stringify(manifest("d".repeat(40))));
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    alternativePayload,
    "--output",
    alternativeSigned,
  );
  await assert.rejects(
    run(
      "verify-bundle",
      "--public-key",
      files.publicPath,
      "--gate",
      signedGate,
      "--manifest",
      alternativeSigned,
      "--at",
      String(NOW),
    ),
    /manifest pin does not match/,
  );

  const other = await fixture();
  await assert.rejects(
    run(
      "verify-bundle",
      "--public-key",
      other.publicPath,
      "--gate",
      signedGate,
      "--manifest",
      signedManifest,
      "--at",
      String(NOW),
    ),
    /signature key identity does not match/,
  );
});

test("refuses unsafe private-key permissions, expired gates and output overwrite", async () => {
  const files = await fixture();
  const output = join(files.root, "signed.json");
  await chmod(files.privatePath, 0o644);
  await assert.rejects(
    run(
      "sign-manifest",
      "--private-key",
      files.privatePath,
      "--input",
      files.manifestPath,
      "--output",
      output,
    ),
    /private key permissions/,
  );
  await chmod(files.privatePath, 0o600);
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    files.manifestPath,
    "--output",
    output,
  );
  await assert.rejects(
    run(
      "sign-manifest",
      "--private-key",
      files.privatePath,
      "--input",
      files.manifestPath,
      "--output",
      output,
    ),
    /EEXIST/,
  );
  const expired = gate();
  expired.issuedAt = NOW - 1_000;
  expired.expiresAt = NOW - 1;
  await writeFile(files.gatePath, JSON.stringify(expired));
  await assert.rejects(
    run(
      "sign-gate",
      "--private-key",
      files.privatePath,
      "--input",
      files.gatePath,
      "--manifest",
      output,
      "--at",
      String(NOW),
      "--output",
      join(files.root, "expired.json"),
    ),
    /gate policy is invalid/,
  );
});
