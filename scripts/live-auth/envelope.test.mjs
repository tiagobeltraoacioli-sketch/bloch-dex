import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
const KEY_GENERATION = "7";

function contract(suffix) {
  return { address: `0x${"00".repeat(19)}${suffix}`, runtimeCodeHash: H2 };
}

function configuration() {
  return {
    schemaVersion: 5,
    environment: "staging",
    host: "bloch-dex",
    frontendMode: "preview",
    liquidityEnabled: false,
    activation: {
      chainIdentityQualified: false,
      finalityQualified: false,
      deploymentQualified: false,
      executionEnabled: false,
      liquidityEnabled: false,
    },
    chain: { id: 700771, genesisHash: H1, rpcUrl: "https://rpc.invalid/" },
    deployment: {
      blockNumber: 12,
      blockHash: H2,
      pairInitCodeHash: H1,
      factory: contract("01"),
      router: contract("02"),
      lens: contract("03"),
      collector: contract("04"),
      wrappedNative: contract("05"),
      feeAuthority: contract("07"),
      treasury: contract("08"),
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
        symbol: "bUSDC",
        name: "Bridged USDC",
        decimals: 6,
        wrappedNative: false,
        policy: { feeOnTransfer: false, rebasing: false },
      },
    ],
    assetPlan: {
      blochL1: {
        nativeSymbol: "BLCH",
        evmExecution: false,
        authorizationBoundary: "external-post-quantum",
      },
      bridgeAsset: {
        sourceChain: "ethereum-mainnet",
        sourceChainId: 1,
        sourceSymbol: "USDC",
        sourceTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        destinationSymbol: "bUSDC",
        destinationTokenAddress: contract("06").address,
      },
      pilotPool: {
        baseSymbol: "BLCH",
        onchainBaseSymbol: "WBLCH",
        quoteSymbol: "bUSDC",
        liquidityEnabled: false,
        maxBaseBaseUnits: "10000000000000000000",
        maxQuoteBaseUnits: "10000000",
        policyCapApproval: { path: "approvals/pilot-cap.json", sha256: H1 },
        requiresSeparateApproval: true,
      },
    },
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
      executionEnabled: false,
      liquidityEnabled: false,
    },
    sourceRevision: revision,
    deploymentConfiguration,
    configurationSha256: sha256(stableJson(deploymentConfiguration)),
    capApprovalVerified: false,
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
  const witnessKeys = generateKeyPairSync("ed25519");
  const publicationKeys = generateKeyPairSync("ed25519");
  const nextPublicationKeys = generateKeyPairSync("ed25519");
  const privatePath = join(root, "private.pem");
  const publicPath = join(root, "public.pem");
  const manifestPath = join(root, "manifest.json");
  const gatePath = join(root, "gate.json");
  const witnessPrivatePath = join(root, "witness-private.pem");
  const witnessPublicPath = join(root, "witness-public.pem");
  const witnessInputPath = join(root, "witness.json");
  const witnessPath = join(root, "witness.signed.json");
  const publicationPrivatePath = join(root, "publication-private.pem");
  const publicationPublicPath = join(root, "publication-public.pem");
  const nextPublicationPrivatePath = join(root, "next-publication-private.pem");
  const nextPublicationPublicPath = join(root, "next-publication-public.pem");
  await writeFile(
    privatePath,
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await writeFile(
    witnessPrivatePath,
    witnessKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await writeFile(
    witnessPublicPath,
    witnessKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  await writeFile(
    publicationPrivatePath,
    publicationKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await writeFile(
    publicationPublicPath,
    publicationKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  await writeFile(
    nextPublicationPrivatePath,
    nextPublicationKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  await writeFile(
    nextPublicationPublicPath,
    nextPublicationKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  await writeFile(
    publicPath,
    publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o644 },
  );
  await writeFile(manifestPath, JSON.stringify(manifest()));
  await writeFile(gatePath, JSON.stringify(gate()));
  const inspected = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        "inspect-key",
        "--public-key",
        publicPath,
      ])
    ).stdout,
  );
  await writeFile(
    witnessInputPath,
    JSON.stringify({
      schemaVersion: 1,
      liveReadKeyId: inspected.keyId,
      minimumLiveReadKeyGeneration: Number(KEY_GENERATION),
      issuedAt: NOW - 30,
      expiresAt: NOW + 600,
    }),
  );
  await execute(process.execPath, [
    cli,
    "sign-witness",
    "--private-key",
    witnessPrivatePath,
    "--key-generation",
    KEY_GENERATION,
    "--input",
    witnessInputPath,
    "--at",
    String(NOW),
    "--output",
    witnessPath,
  ]);
  return {
    root,
    privatePath,
    publicPath,
    manifestPath,
    gatePath,
    witnessPrivatePath,
    witnessPublicPath,
    witnessInputPath,
    witnessPath,
    publicationPrivatePath,
    publicationPublicPath,
    nextPublicationPrivatePath,
    nextPublicationPublicPath,
  };
}

function witnessArgs(files) {
  return [
    "--witness-public-key",
    files.witnessPublicPath,
    "--witness-key-generation",
    KEY_GENERATION,
    "--witness",
    files.witnessPath,
  ];
}

function bundleArgs(files, signedGate, signedManifest) {
  return [
    "--public-key",
    files.publicPath,
    "--key-generation",
    KEY_GENERATION,
    "--gate",
    signedGate,
    "--manifest",
    signedManifest,
    ...witnessArgs(files),
  ];
}

async function run(...args) {
  const [command, ...rest] = args;
  const generationArgs =
    command === "inspect-key" ? [] : ["--key-generation", KEY_GENERATION];
  return execute(process.execPath, [cli, command, ...generationArgs, ...rest], {
    cwd: resolve("."),
  });
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
    ...witnessArgs(files),
    "--at",
    String(NOW),
  );
  assert.equal(JSON.parse(verified.stdout).verified, true);
  assert.equal(
    JSON.parse(verified.stdout).keyGeneration,
    Number(KEY_GENERATION),
  );
  const inspected = JSON.parse(
    (await run("inspect-key", "--public-key", files.publicPath)).stdout,
  );
  assert.match(inspected.publicKeyBase64Url, /^[A-Za-z0-9_-]{43}$/);
  assert.match(inspected.keyId, /^[0-9a-f]{64}$/);
});

test("publishes an immutable chained receipt and advances a retained checkpoint", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "release-manifest.signed.json");
  const signedGate = join(files.root, "release-gate.signed.json");
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
  const checkpoint0 = join(files.root, "checkpoint-0.json");
  await execute(process.execPath, [
    cli,
    "init-publication",
    "--publication-public-key",
    files.publicationPublicPath,
    "--publication-key-generation",
    "3",
    "--output-checkpoint",
    checkpoint0,
  ]);
  const entry1 = join(files.root, "publication-1.json");
  const publicationArgs = [
    cli,
    "publish-release",
    ...bundleArgs(files, signedGate, signedManifest),
    "--publication-private-key",
    files.publicationPrivatePath,
    "--publication-key-generation",
    "3",
  ];
  await execute(process.execPath, [
    ...publicationArgs,
    "--previous",
    "genesis",
    "--at",
    String(NOW),
    "--output",
    entry1,
  ]);
  if (process.platform !== "win32")
    assert.equal((await stat(entry1)).mode & 0o777, 0o444);

  const checkpoint1 = join(files.root, "checkpoint-1.json");
  const verificationArgs = [
    cli,
    "verify-release",
    ...bundleArgs(files, signedGate, signedManifest),
    "--publication-public-key",
    files.publicationPublicPath,
    "--publication-key-generation",
    "3",
  ];
  const verified1 = await execute(process.execPath, [
    ...verificationArgs,
    "--entry",
    entry1,
    "--checkpoint",
    checkpoint0,
    "--at",
    String(NOW),
    "--output-checkpoint",
    checkpoint1,
  ]);
  assert.equal(JSON.parse(verified1.stdout).sequence, 1);
  assert.equal(JSON.parse(await readFile(checkpoint1, "utf8")).sequence, 1);

  const checkpoint1Late = join(files.root, "checkpoint-1-late.json");
  await execute(process.execPath, [
    ...verificationArgs,
    "--entry",
    entry1,
    "--checkpoint",
    checkpoint1,
    "--at",
    String(NOW + 10_000),
    "--output-checkpoint",
    checkpoint1Late,
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(checkpoint1Late, "utf8")),
    JSON.parse(await readFile(checkpoint1, "utf8")),
  );

  const entry2 = join(files.root, "publication-2.json");
  await assert.rejects(
    execute(process.execPath, [
      ...publicationArgs,
      "--previous",
      entry1,
      "--at",
      String(NOW - 1),
      "--output",
      join(files.root, "backdated-publication.json"),
    ]),
    /publication time must not move backwards/,
  );
  await execute(process.execPath, [
    ...publicationArgs,
    "--previous",
    entry1,
    "--at",
    String(NOW + 1),
    "--output",
    entry2,
  ]);
  const checkpoint2 = join(files.root, "checkpoint-2.json");
  await execute(process.execPath, [
    ...verificationArgs,
    "--entry",
    entry2,
    "--checkpoint",
    checkpoint1,
    "--at",
    String(NOW + 1),
    "--output-checkpoint",
    checkpoint2,
  ]);
  await assert.rejects(
    execute(process.execPath, [
      ...verificationArgs,
      "--entry",
      entry2,
      "--checkpoint",
      checkpoint1,
      "--at",
      String(NOW - 1_000),
      "--output-checkpoint",
      join(files.root, "future-checkpoint.json"),
    ]),
    /publication time is in the future/,
  );

  await assert.rejects(
    execute(process.execPath, [
      ...verificationArgs,
      "--entry",
      entry1,
      "--checkpoint",
      checkpoint2,
      "--at",
      String(NOW + 1),
      "--output-checkpoint",
      join(files.root, "rolled-back.json"),
    ]),
    /not the retained checkpoint or its successor/,
  );

  const fork = join(files.root, "publication-2-fork.json");
  await execute(process.execPath, [
    ...publicationArgs,
    "--previous",
    entry1,
    "--at",
    String(NOW + 2),
    "--output",
    fork,
  ]);
  await assert.rejects(
    execute(process.execPath, [
      ...verificationArgs,
      "--entry",
      fork,
      "--checkpoint",
      checkpoint2,
      "--at",
      String(NOW + 2),
      "--output-checkpoint",
      join(files.root, "forked.json"),
    ]),
    /not the retained checkpoint or its successor/,
  );

  const tampered = JSON.parse(await readFile(entry2, "utf8"));
  tampered.payload.sourceRevision = "f".repeat(40);
  const tamperedPath = join(files.root, "publication-tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    execute(process.execPath, [
      ...verificationArgs,
      "--entry",
      tamperedPath,
      "--checkpoint",
      checkpoint1,
      "--at",
      String(NOW + 1),
      "--output-checkpoint",
      join(files.root, "tampered-checkpoint.json"),
    ]),
    /signature is invalid/,
  );
});

test("rotates the offline publication key with a dual-signed chained entry", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "rotation-manifest.signed.json");
  const signedGate = join(files.root, "rotation-gate.signed.json");
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
  const bundle = bundleArgs(files, signedGate, signedManifest);
  const checkpoint0 = join(files.root, "rotation-checkpoint-0.json");
  await execute(process.execPath, [
    cli,
    "init-publication",
    "--publication-public-key",
    files.publicationPublicPath,
    "--publication-key-generation",
    "3",
    "--output-checkpoint",
    checkpoint0,
  ]);
  const entry1 = join(files.root, "before-rotation.json");
  await execute(process.execPath, [
    cli,
    "publish-release",
    ...bundle,
    "--publication-private-key",
    files.publicationPrivatePath,
    "--publication-key-generation",
    "3",
    "--previous",
    "genesis",
    "--at",
    String(NOW),
    "--output",
    entry1,
  ]);
  const checkpoint1 = join(files.root, "rotation-checkpoint-1.json");
  await execute(process.execPath, [
    cli,
    "verify-release",
    ...bundle,
    "--publication-public-key",
    files.publicationPublicPath,
    "--publication-key-generation",
    "3",
    "--entry",
    entry1,
    "--checkpoint",
    checkpoint0,
    "--at",
    String(NOW),
    "--output-checkpoint",
    checkpoint1,
  ]);

  const rotation = join(files.root, "publication-rotation.json");
  const rotateArgs = [
    cli,
    "rotate-publication",
    ...bundle,
    "--prior-publication-private-key",
    files.publicationPrivatePath,
    "--prior-publication-key-generation",
    "3",
    "--next-publication-private-key",
    files.nextPublicationPrivatePath,
    "--next-publication-key-generation",
    "4",
    "--previous",
    entry1,
    "--at",
    String(NOW + 1),
  ];
  await execute(process.execPath, [...rotateArgs, "--output", rotation]);
  const checkpoint2 = join(files.root, "rotation-checkpoint-2.json");
  const verifyRotationArgs = [
    cli,
    "verify-rotation",
    ...bundle,
    "--prior-publication-public-key",
    files.publicationPublicPath,
    "--prior-publication-key-generation",
    "3",
    "--next-publication-public-key",
    files.nextPublicationPublicPath,
    "--next-publication-key-generation",
    "4",
    "--rotation",
    rotation,
  ];
  const verified = await execute(process.execPath, [
    ...verifyRotationArgs,
    "--checkpoint",
    checkpoint1,
    "--at",
    String(NOW + 1),
    "--output-checkpoint",
    checkpoint2,
  ]);
  assert.equal(JSON.parse(verified.stdout).rotated, true);
  const checkpoint2Value = JSON.parse(await readFile(checkpoint2, "utf8"));
  assert.equal(checkpoint2Value.sequence, 2);
  const nextIdentity = JSON.parse(
    (
      await execute(process.execPath, [
        cli,
        "inspect-key",
        "--public-key",
        files.nextPublicationPublicPath,
      ])
    ).stdout,
  );
  assert.equal(checkpoint2Value.publicationKeyId, nextIdentity.keyId);
  assert.equal(checkpoint2Value.publicationKeyGeneration, 4);

  await assert.rejects(
    execute(process.execPath, [
      ...verifyRotationArgs,
      "--checkpoint",
      checkpoint2,
      "--at",
      String(NOW + 1),
      "--output-checkpoint",
      join(files.root, "reused-rotation.json"),
    ]),
    /checkpoint key does not match prior rotation key/,
  );

  await assert.rejects(
    execute(process.execPath, [
      cli,
      "verify-release",
      ...bundle,
      "--publication-public-key",
      files.publicationPublicPath,
      "--publication-key-generation",
      "3",
      "--entry",
      entry1,
      "--checkpoint",
      checkpoint2,
      "--at",
      String(NOW + 1),
      "--output-checkpoint",
      join(files.root, "rolled-back-before-rotation.json"),
    ]),
    /publication checkpoint key does not match/,
  );

  const fork = join(files.root, "publication-rotation-fork.json");
  await execute(process.execPath, [
    ...rotateArgs.slice(0, -1),
    String(NOW + 2),
    "--output",
    fork,
  ]);
  await assert.rejects(
    execute(process.execPath, [
      ...verifyRotationArgs.slice(0, -1),
      fork,
      "--checkpoint",
      checkpoint2,
      "--at",
      String(NOW + 2),
      "--output-checkpoint",
      join(files.root, "forked-rotation.json"),
    ]),
    /checkpoint key does not match prior rotation key/,
  );

  const entry3 = join(files.root, "after-rotation.json");
  await execute(process.execPath, [
    cli,
    "publish-after-rotation",
    ...bundle,
    "--prior-publication-public-key",
    files.publicationPublicPath,
    "--prior-publication-key-generation",
    "3",
    "--publication-private-key",
    files.nextPublicationPrivatePath,
    "--publication-key-generation",
    "4",
    "--previous-rotation",
    rotation,
    "--at",
    String(NOW + 2),
    "--output",
    entry3,
  ]);
  const checkpoint3 = join(files.root, "rotation-checkpoint-3.json");
  const verified3 = await execute(process.execPath, [
    cli,
    "verify-release",
    ...bundle,
    "--publication-public-key",
    files.nextPublicationPublicPath,
    "--publication-key-generation",
    "4",
    "--entry",
    entry3,
    "--checkpoint",
    checkpoint2,
    "--at",
    String(NOW + 2),
    "--output-checkpoint",
    checkpoint3,
  ]);
  assert.equal(JSON.parse(verified3.stdout).sequence, 3);

  await assert.rejects(
    execute(process.execPath, [
      ...rotateArgs.slice(0, -6),
      "--next-publication-key-generation",
      "3",
      "--previous",
      entry1,
      "--at",
      String(NOW + 1),
      "--output",
      join(files.root, "generation-reuse.json"),
    ]),
    /generation must increase/,
  );

  const sameKeyArgs = [...rotateArgs];
  sameKeyArgs[sameKeyArgs.indexOf("--next-publication-private-key") + 1] =
    files.publicationPrivatePath;
  await assert.rejects(
    execute(process.execPath, [
      ...sameKeyArgs,
      "--output",
      join(files.root, "same-key-rotation.json"),
    ]),
    /rotation must change the key/,
  );

  const tampered = JSON.parse(await readFile(rotation, "utf8"));
  tampered.nextAcceptance.payload.publishedAt += 1;
  const tamperedPath = join(files.root, "tampered-rotation.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    execute(process.execPath, [
      ...verifyRotationArgs.slice(0, -1),
      tamperedPath,
      "--checkpoint",
      checkpoint1,
      "--at",
      String(NOW + 2),
      "--output-checkpoint",
      join(files.root, "tampered-rotation-checkpoint.json"),
    ]),
    /signature is invalid/,
  );
});

test("refuses to reuse a bundle key as the publication key", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "same-key-manifest.signed.json");
  const signedGate = join(files.root, "same-key-gate.signed.json");
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
  await assert.rejects(
    execute(process.execPath, [
      cli,
      "publish-release",
      ...bundleArgs(files, signedGate, signedManifest),
      "--publication-private-key",
      files.privatePath,
      "--publication-key-generation",
      KEY_GENERATION,
      "--previous",
      "genesis",
      "--at",
      String(NOW),
      "--output",
      join(files.root, "same-key-publication.json"),
    ]),
    /publication key must be independent/,
  );
});

test("binds the generation into signatures and rejects downgrade or relabeling", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "generation-7.signed.json");
  await run(
    "sign-manifest",
    "--private-key",
    files.privatePath,
    "--input",
    files.manifestPath,
    "--output",
    signedManifest,
  );
  const envelope = JSON.parse(await readFile(signedManifest, "utf8"));
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.signature.keyGeneration, 7);

  const relabeled = join(files.root, "relabeled.signed.json");
  envelope.signature.keyGeneration = 8;
  await writeFile(relabeled, JSON.stringify(envelope));
  await assert.rejects(
    execute(
      process.execPath,
      [
        cli,
        "verify-bundle",
        "--key-generation",
        "8",
        "--public-key",
        files.publicPath,
        "--gate",
        relabeled,
        "--manifest",
        relabeled,
        ...witnessArgs(files),
        "--at",
        String(NOW),
      ],
      { cwd: resolve(".") },
    ),
    /signature is invalid/,
  );

  await assert.rejects(
    execute(
      process.execPath,
      [
        cli,
        "verify-bundle",
        "--key-generation",
        "8",
        "--public-key",
        files.publicPath,
        "--gate",
        signedManifest,
        "--manifest",
        signedManifest,
        ...witnessArgs(files),
        "--at",
        String(NOW),
      ],
      { cwd: resolve(".") },
    ),
    /signature key identity does not match/,
  );
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
      ...witnessArgs(files),
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
      ...witnessArgs(files),
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
      ...witnessArgs(files),
      "--at",
      String(NOW),
    ),
    /signature key identity does not match/,
  );
});

test("rejects a witness floor above the bundle generation", async () => {
  const files = await fixture();
  const signedManifest = join(files.root, "floor-manifest.signed.json");
  const signedGate = join(files.root, "floor-gate.signed.json");
  const witnessInput = join(files.root, "higher-floor.json");
  const witness = join(files.root, "higher-floor.signed.json");
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
  const input = JSON.parse(await readFile(files.witnessInputPath, "utf8"));
  input.minimumLiveReadKeyGeneration = 8;
  await writeFile(witnessInput, JSON.stringify(input));
  await run(
    "sign-witness",
    "--private-key",
    files.witnessPrivatePath,
    "--input",
    witnessInput,
    "--at",
    String(NOW),
    "--output",
    witness,
  );
  await assert.rejects(
    run(
      "verify-bundle",
      "--public-key",
      files.publicPath,
      "--gate",
      signedGate,
      "--manifest",
      signedManifest,
      "--witness-public-key",
      files.witnessPublicPath,
      "--witness-key-generation",
      KEY_GENERATION,
      "--witness",
      witness,
      "--at",
      String(NOW),
    ),
    /witness does not authorize/,
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
