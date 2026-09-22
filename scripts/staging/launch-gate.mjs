import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stableJson } from "./manifest.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const MAX_GATE_BYTES = 16 * 1024;
const MAX_FRESHNESS_SECONDS = 15 * 60;

function refuse(condition, message) {
  if (!condition) throw new Error(`launch gate: ${message}`);
}

function exactKeys(value, keys, field) {
  refuse(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${field} fields are invalid`,
  );
}

function optionalHash(value, field) {
  refuse(
    value === null || (HASH.test(value) && !/^0x0{64}$/.test(value)),
    `${field} is invalid`,
  );
}

function optionalPositiveInteger(value, field) {
  refuse(
    value === null || (Number.isSafeInteger(value) && value > 0),
    `${field} is invalid`,
  );
}

function sameNullness(values, field) {
  refuse(
    values.every((value) => value === null) ||
      values.every((value) => value !== null),
    `${field} must be entirely absent or complete`,
  );
}

export function evaluateLaunchGate(gate, options = {}) {
  const nowUnixSeconds =
    options.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  refuse(
    Number.isSafeInteger(nowUnixSeconds) && nowUnixSeconds > 0,
    "evaluation time is invalid",
  );
  exactKeys(
    gate,
    [
      "schemaVersion",
      "domain",
      "selectedChainId",
      "chainIdentity",
      "finality",
      "bridge",
      "deployment",
      "liquidity",
      "controls",
    ],
    "document",
  );
  refuse(
    gate.schemaVersion === 3 && gate.domain === "postern.dex.launch-gate.v3",
    "schema is unsupported",
  );
  refuse(gate.selectedChainId === 700771, "selected chain must be 700771");

  exactKeys(gate.chainIdentity, ["genesisHash"], "chainIdentity");
  optionalHash(gate.chainIdentity.genesisHash, "chainIdentity.genesisHash");
  exactKeys(
    gate.finality,
    [
      "rpcObservationSha256",
      "finalizedBlockNumber",
      "finalizedBlockHash",
      "observedAtUnixSeconds",
      "validUntilUnixSeconds",
    ],
    "finality",
  );
  optionalHash(
    gate.finality.rpcObservationSha256,
    "finality.rpcObservationSha256",
  );
  optionalPositiveInteger(
    gate.finality.finalizedBlockNumber,
    "finality.finalizedBlockNumber",
  );
  optionalHash(gate.finality.finalizedBlockHash, "finality.finalizedBlockHash");
  optionalPositiveInteger(
    gate.finality.observedAtUnixSeconds,
    "finality.observedAtUnixSeconds",
  );
  optionalPositiveInteger(
    gate.finality.validUntilUnixSeconds,
    "finality.validUntilUnixSeconds",
  );
  sameNullness(Object.values(gate.finality), "finality evidence");

  exactKeys(gate.bridge, ["readinessVerificationSha256"], "bridge");
  optionalHash(
    gate.bridge.readinessVerificationSha256,
    "bridge.readinessVerificationSha256",
  );
  exactKeys(
    gate.deployment,
    ["configurationSha256", "rpcObservationSha256"],
    "deployment",
  );
  optionalHash(
    gate.deployment.configurationSha256,
    "deployment.configurationSha256",
  );
  optionalHash(
    gate.deployment.rpcObservationSha256,
    "deployment.rpcObservationSha256",
  );
  sameNullness(Object.values(gate.deployment), "deployment evidence");
  exactKeys(gate.liquidity, ["pilotReadinessVerificationSha256"], "liquidity");
  optionalHash(
    gate.liquidity.pilotReadinessVerificationSha256,
    "liquidity.pilotReadinessVerificationSha256",
  );
  exactKeys(
    gate.controls,
    [
      "liquidityEnabled",
      "liquidityAdded",
      "aggregatorExecutionEnabled",
      "activationAuthorized",
    ],
    "controls",
  );
  refuse(
    Object.values(gate.controls).every((value) => value === false),
    "all execution and activation controls must remain false",
  );

  const evidenceValues = [
    gate.chainIdentity.genesisHash,
    ...Object.values(gate.finality),
    gate.bridge.readinessVerificationSha256,
    ...Object.values(gate.deployment),
    gate.liquidity.pilotReadinessVerificationSha256,
  ];
  const evidenceAbsent = evidenceValues.every((value) => value === null);
  const evidencePresent = evidenceValues.every((value) => value !== null);
  refuse(evidenceAbsent || evidencePresent, "evidence package is partial");
  if (evidencePresent) {
    refuse(
      gate.deployment.rpcObservationSha256 ===
        gate.finality.rpcObservationSha256,
      "deployment and finality must use the same RPC observation",
    );
    refuse(
      gate.finality.observedAtUnixSeconds <= nowUnixSeconds &&
        nowUnixSeconds <= gate.finality.validUntilUnixSeconds &&
        gate.finality.validUntilUnixSeconds -
          gate.finality.observedAtUnixSeconds <=
          MAX_FRESHNESS_SECONDS,
      "finality evidence is stale, future-dated or overlong",
    );
  }

  const gateSha256 = `0x${createHash("sha256")
    .update(stableJson(gate))
    .digest("hex")}`;
  return Object.freeze({
    schemaVersion: 3,
    domain: "postern.dex.launch-gate-preflight.v3",
    selectedChainId: 700771,
    gateSha256,
    referencesOpaque: true,
    opaqueReferencesComplete: evidencePresent,
    declaredCrossBindingsConsistent: evidencePresent,
    artifactContentsOpened: false,
    semanticEvidenceVerified: false,
    readyForReviewedActivation: false,
    liquidityEnabled: false,
    liquidityAdded: false,
    aggregatorExecutionEnabled: false,
    activationAuthorized: false,
  });
}

export async function readLaunchGate(repository, relativePath) {
  refuse(
    typeof relativePath === "string" &&
      relativePath.length > 0 &&
      !isAbsolute(relativePath),
    "path must be repository-relative",
  );
  const root = resolve(repository);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  refuse(
    fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`),
    "path escapes the repository",
  );
  let before;
  try {
    before = await lstat(path, { bigint: true });
    refuse((await realpath(path)) === path, "path contains a symbolic link");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("launch gate:"))
      throw error;
    throw new Error(`launch gate: cannot inspect document: ${error.message}`);
  }
  refuse(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_GATE_BYTES) &&
      Number(before.mode & 0o022n) === 0,
    "document is unsafe",
  );
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const fields = [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs",
    ];
    refuse(
      opened.isFile() &&
        opened.nlink === 1n &&
        fields.every((field) => opened[field] === before[field]),
      "document changed before reading",
    );
    const bounded = Buffer.alloc(MAX_GATE_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    refuse(offset > 0 && offset <= MAX_GATE_BYTES, "document is unsafe");
    const after = await handle.stat({ bigint: true });
    refuse(
      fields.every((field) => after[field] === opened[field]),
      "document changed while reading",
    );
    const text = bounded.subarray(0, offset).toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("launch gate: document is invalid JSON");
    }
    refuse(
      text === `${stableJson(parsed)}\n`,
      "document is not canonical JSON",
    );
    return parsed;
  } finally {
    await handle.close();
  }
}
