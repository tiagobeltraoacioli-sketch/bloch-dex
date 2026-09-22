import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "./manifest.mjs";
import { verifySemanticLaunchPackage } from "./semantic-launch-package.mjs";

const hash = (byte) => `0x${byte.repeat(64)}`;
const revision = (byte) => byte.repeat(40);
const templateUrl = new URL(
  "../../deployments/semantic-launch-package.template.json",
  import.meta.url,
);
const repository = resolve(dirname(fileURLToPath(templateUrl)), "..");
const cli = fileURLToPath(
  new URL("./check-semantic-launch-package.mjs", import.meta.url),
);

async function canonicalWrite(root, path, value) {
  const text = `${stableJson(value)}\n`;
  await writeFile(join(root, path), text, { mode: 0o600 });
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}

const provenance = (repositoryName, byte, artifactPath) => ({
  repository: repositoryName,
  revision: revision(byte),
  artifactPath,
});

async function buildComplete(root, mutate = () => {}) {
  const values = {};
  const hashes = {};
  values.l2 = {
    schema: "postern.dex.l2-finality-evidence.v1",
    provenance: provenance("bloch-l2-evm", "1", "evidence/finality.json"),
    chainId: 700771,
    genesisHash: hash("a"),
    finalizedBlockNumber: 91,
    finalizedBlockHash: hash("b"),
    rpcObservationSha256: hash("c"),
    finalityVerified: true,
  };
  mutate("l2", values.l2);
  hashes.l2 = await canonicalWrite(root, "l2.json", values.l2);

  values.bridge = {
    schema: "postern.dex.bridge-readiness-evidence.v1",
    provenance: provenance("bloch-l2-bridge", "2", "evidence/readiness.json"),
    chainId: values.l2.chainId,
    genesisHash: values.l2.genesisHash,
    l2ObservationSha256: values.l2.rpcObservationSha256,
    readinessVerificationSha256: hash("d"),
    settlementVerified: true,
    custodyAuthoritiesVerified: true,
    pausedDeploymentVerified: true,
    disposableCycleVerified: true,
    activationAuthorized: false,
    broadcastPerformed: false,
  };
  mutate("bridge", values.bridge);
  hashes.bridge = await canonicalWrite(root, "bridge.json", values.bridge);

  values.deployment = {
    schema: "postern.dex.deployment-evidence.v1",
    provenance: provenance("postern-dex", "3", "evidence/deployment.json"),
    chainId: values.l2.chainId,
    genesisHash: values.l2.genesisHash,
    configurationSha256: hash("e"),
    rpcObservationSha256: values.l2.rpcObservationSha256,
    bridgeArtifactSha256: hashes.bridge,
    contractsVerified: true,
    deploymentEnabled: false,
  };
  mutate("deployment", values.deployment);
  hashes.deployment = await canonicalWrite(
    root,
    "deployment.json",
    values.deployment,
  );

  values.pilot = {
    schema: "postern.dex.pilot-evidence.v2",
    provenance: provenance("postern-dex", "4", "evidence/pilot.json"),
    chainId: values.l2.chainId,
    genesisHash: values.l2.genesisHash,
    bridgeArtifactSha256: hashes.bridge,
    deploymentArtifactSha256: hashes.deployment,
    maxBaseBaseUnits: "100000000000000000",
    maxQuoteBaseUnits: "1000000",
    capApprovalSha256: hash("6"),
    pilotVerified: true,
    liquidityEnabled: false,
    liquidityAdded: false,
  };
  mutate("pilot", values.pilot);
  hashes.pilot = await canonicalWrite(root, "pilot.json", values.pilot);

  values.aggregator = {
    schema: "postern.dex.aggregator-evidence.v1",
    provenance: provenance("postern-wallet", "5", "evidence/aggregator.json"),
    chainId: values.l2.chainId,
    genesisHash: values.l2.genesisHash,
    deploymentArtifactSha256: hashes.deployment,
    pilotArtifactSha256: hashes.pilot,
    routesVerified: true,
    executionEnabled: false,
    broadcastPerformed: false,
  };
  mutate("aggregator", values.aggregator);
  hashes.aggregator = await canonicalWrite(
    root,
    "aggregator.json",
    values.aggregator,
  );

  const pkg = {
    schemaVersion: 1,
    domain: "postern.dex.semantic-launch-package.v1",
    selectedChainId: 700771,
    artifacts: Object.fromEntries(
      ["l2", "bridge", "deployment", "pilot", "aggregator"].map(
        (name, index) => [
          name,
          {
            path: `${name}.json`,
            sha256: hashes[name],
            sourceRevision: revision(String(index + 1)),
          },
        ],
      ),
    ),
    controls: {
      liquidityEnabled: false,
      liquidityAdded: false,
      aggregatorExecutionEnabled: false,
      activationAuthorized: false,
    },
  };
  mutate("package", pkg);
  await canonicalWrite(root, "package.json", pkg);
  return { pkg, values, hashes };
}

async function writeTrustRoots(root, complete, mutate = () => {}) {
  const trustRoots = {
    schemaVersion: 1,
    domain: "postern.dex.semantic-launch-trust-roots.v1",
    selectedChainId: 700771,
    artifacts: Object.fromEntries(
      ["l2", "bridge", "deployment", "pilot", "aggregator"].map((name) => [
        name,
        {
          ...complete.values[name].provenance,
          sha256: complete.hashes[name],
        },
      ]),
    ),
  };
  mutate(trustRoots);
  const sha256 = await canonicalWrite(root, "trust-roots.json", trustRoots);
  return { trustRoots, sha256 };
}

test("checked-in package is canonical, pending and non-authorizing", async () => {
  const text = await readFile(templateUrl, "utf8");
  const value = JSON.parse(text);
  assert.equal(text, `${stableJson(value)}\n`);
  const report = await verifySemanticLaunchPackage(
    repository,
    "deployments/semantic-launch-package.template.json",
  );
  assert.equal(report.artifactContentsOpened, false);
  assert.equal(report.semanticStructureVerified, false);
  assert.equal(report.artifactContentAuthenticated, false);
  assert.equal(report.provenanceAuthenticated, false);
  assert.equal(report.semanticEvidenceAuthenticated, false);
  assert.equal(report.declaredPilotCapBounded, false);
  assert.equal(report.pilotCapApprovalAuthenticated, false);
  assert.equal(report.pilotCap, null);
  assert.equal(report.activationApprovalAuthenticated, false);
  for (const field of [
    "readyForReviewedActivation",
    "liquidityEnabled",
    "liquidityAdded",
    "aggregatorExecutionEnabled",
    "activationAuthorized",
  ])
    assert.equal(report[field], false);
});

test("a self-created structurally valid package cannot authenticate or authorize itself", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-semantic-complete-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await buildComplete(root);
  const report = await verifySemanticLaunchPackage(root, "package.json");
  assert.equal(report.artifactContentsOpened, true);
  assert.equal(report.contentHashesMatched, true);
  assert.equal(report.declaredProvenanceConsistent, true);
  assert.equal(report.declaredCrossBindingsConsistent, true);
  assert.equal(report.semanticStructureVerified, true);
  assert.equal(report.artifactContentAuthenticated, false);
  assert.equal(report.provenanceAuthenticated, false);
  assert.equal(report.semanticEvidenceAuthenticated, false);
  assert.equal(report.declaredPilotCapBounded, true);
  assert.equal(report.pilotCapApprovalAuthenticated, false);
  assert.deepEqual(report.pilotCap, {
    maxBaseBaseUnits: "100000000000000000",
    maxQuoteBaseUnits: "1000000",
    capApprovalSha256: hash("6"),
  });
  assert.equal(report.readyForReviewedActivation, false);
  assert.equal(report.liquidityEnabled, false);
  assert.equal(report.aggregatorExecutionEnabled, false);
  assert.equal(report.activationAuthorized, false);
});

test("external roots authenticate artifact content and provenance, never approval", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-semantic-authenticated-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const complete = await buildComplete(root);
  const roots = await writeTrustRoots(root, complete);
  const report = await verifySemanticLaunchPackage(root, "package.json", {
    trustRootsPath: "trust-roots.json",
    expectedTrustRootsSha256: roots.sha256,
  });
  assert.equal(report.semanticStructureVerified, true);
  assert.equal(report.artifactContentAuthenticated, true);
  assert.equal(report.provenanceAuthenticated, true);
  assert.equal(report.semanticEvidenceAuthenticated, true);
  assert.equal(report.declaredPilotCapBounded, true);
  assert.equal(report.pilotCapApprovalAuthenticated, false);
  assert.equal(report.trustRootsSha256, roots.sha256);
  assert.equal(report.activationApprovalAuthenticated, false);
  assert.equal(report.readyForReviewedActivation, false);
  for (const field of [
    "liquidityEnabled",
    "liquidityAdded",
    "aggregatorExecutionEnabled",
    "activationAuthorized",
  ])
    assert.equal(report[field], false);
});

test("trust roots cannot self-select, mismatch, substitute provenance or approve controls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-semantic-trust-attacks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const complete = await buildComplete(root);
  const roots = await writeTrustRoots(root, complete);
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json", {
      trustRootsPath: "trust-roots.json",
    }),
    /supplied together/,
  );
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json", {
      trustRootsPath: "trust-roots.json",
      expectedTrustRootsSha256: hash("9"),
    }),
    /externally expected SHA-256/,
  );

  const replacement = await writeTrustRoots(root, complete, (value) => {
    value.artifacts.bridge.revision = revision("9");
  });
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json", {
      trustRootsPath: "trust-roots.json",
      expectedTrustRootsSha256: replacement.sha256,
    }),
    /bridge provenance does not match/,
  );
  const wrongContent = await writeTrustRoots(root, complete, (value) => {
    value.artifacts.aggregator.sha256 = hash("9");
  });
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json", {
      trustRootsPath: "trust-roots.json",
      expectedTrustRootsSha256: wrongContent.sha256,
    }),
    /aggregator content does not match/,
  );
  const wrongRepository = await writeTrustRoots(root, complete, (value) => {
    value.artifacts.l2.repository = "lookalike-l2";
  });
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json", {
      trustRootsPath: "trust-roots.json",
      expectedTrustRootsSha256: wrongRepository.sha256,
    }),
    /l2 trust root repository is not canonical/,
  );
});

test("refuses semantic lies even when every descriptor hash is recomputed", async (context) => {
  const attacks = [
    [
      "l2",
      (v) => {
        v.finalizedBlockNumber = 0;
      },
    ],
    [
      "l2",
      (v) => {
        v.finalityVerified = false;
      },
    ],
    [
      "bridge",
      (v) => {
        v.genesisHash = hash("9");
      },
    ],
    [
      "bridge",
      (v) => {
        v.custodyAuthoritiesVerified = false;
      },
    ],
    [
      "bridge",
      (v) => {
        v.activationAuthorized = true;
      },
    ],
    [
      "deployment",
      (v) => {
        v.rpcObservationSha256 = hash("9");
      },
    ],
    [
      "deployment",
      (v) => {
        v.bridgeArtifactSha256 = hash("9");
      },
    ],
    [
      "deployment",
      (v) => {
        v.deploymentEnabled = true;
      },
    ],
    [
      "pilot",
      (v) => {
        v.maxBaseBaseUnits = "10000000000000000001";
      },
    ],
    [
      "pilot",
      (v) => {
        v.maxQuoteBaseUnits = "10000001";
      },
    ],
    [
      "pilot",
      (v) => {
        v.capApprovalSha256 = hash("0");
      },
    ],
    [
      "pilot",
      (v) => {
        v.liquidityAdded = true;
      },
    ],
    [
      "aggregator",
      (v) => {
        v.pilotArtifactSha256 = hash("9");
      },
    ],
    [
      "aggregator",
      (v) => {
        v.executionEnabled = true;
      },
    ],
    [
      "aggregator",
      (v) => {
        v.provenance.repository = "postern-dex";
      },
    ],
  ];
  for (const [index, [stage, attack]] of attacks.entries()) {
    const root = await mkdtemp(
      join(tmpdir(), `postern-semantic-attack-${index}-`),
    );
    context.after(() => rm(root, { recursive: true, force: true }));
    await buildComplete(root, (name, value) => {
      if (name === stage) attack(value);
    });
    await assert.rejects(
      verifySemanticLaunchPackage(root, "package.json"),
      /semantic launch package:/,
    );
  }
});

test("refuses descriptor substitution, partial packages and enabling controls", async (context) => {
  for (const attack of [
    (pkg) => {
      pkg.artifacts.l2.sha256 = hash("8");
    },
    (pkg) => {
      pkg.artifacts.bridge.sourceRevision = revision("8");
    },
    (pkg) => {
      pkg.artifacts.pilot = null;
    },
    (pkg) => {
      pkg.controls.liquidityEnabled = true;
    },
    (pkg) => {
      pkg.selectedChainId = 84001;
    },
  ]) {
    const root = await mkdtemp(
      join(tmpdir(), "postern-semantic-package-attack-"),
    );
    context.after(() => rm(root, { recursive: true, force: true }));
    await buildComplete(root, (name, value) => {
      if (name === "package") attack(value);
    });
    await assert.rejects(
      verifySemanticLaunchPackage(root, "package.json"),
      /semantic launch package:/,
    );
  }
});

test("bounded reader refuses symlinks, noncanonical JSON and writable evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "postern-semantic-files-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await buildComplete(root);
  await symlink(join(root, "package.json"), join(root, "link.json"));
  await assert.rejects(
    verifySemanticLaunchPackage(root, "link.json"),
    /symbolic link/,
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(root, "pretty.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    verifySemanticLaunchPackage(root, "pretty.json"),
    /not canonical/,
  );
  await chmod(join(root, "package.json"), 0o622);
  await assert.rejects(
    verifySemanticLaunchPackage(root, "package.json"),
    /unsafe/,
  );
  await assert.rejects(
    verifySemanticLaunchPackage(root, "../package.json"),
    /path is invalid/,
  );
});

test("CLI reports pending as exit one and invalid usage as exit two", () => {
  const pending = spawnSync(
    process.execPath,
    [cli, "--package", "deployments/semantic-launch-package.template.json"],
    {
      cwd: repository,
      encoding: "utf8",
    },
  );
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).semanticEvidenceAuthenticated, false);
  assert.equal(pending.stderr, "");
  const usage = spawnSync(process.execPath, [cli], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
});
