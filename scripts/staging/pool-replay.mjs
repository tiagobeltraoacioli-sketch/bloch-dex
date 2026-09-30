import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectPilotPool,
  validatePoolInspectionRequest,
} from "./pool-inspector.mjs";
import { stableJson, sha256 } from "./manifest.mjs";

const DOMAIN = "postern.dex.pilot-pool-rpc-capture.v1";
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_CALLS = 48;
const HASH = /^0x[0-9a-f]{64}$/;
const METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_call",
]);

function required(condition, message) {
  if (!condition) throw new Error(`pilot pool replay: ${message}`);
}

function exact(value, keys, label) {
  required(
    value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${label} fields are invalid`,
  );
}

function digest(value) {
  return `0x${sha256(stableJson(value))}`;
}

function hash(value, label) {
  required(
    typeof value === "string" &&
      HASH.test(value) &&
      value !== `0x${"0".repeat(64)}`,
    `${label} must be a nonzero lowercase hash`,
  );
}

function boundedCanonical(value) {
  const canonical = stableJson(value);
  required(
    Buffer.byteLength(canonical, "utf8") + 1 <= MAX_CAPTURE_BYTES,
    "capture exceeds the byte limit",
  );
  return canonical;
}

function validateEntry(entry) {
  exact(entry, ["method", "params", "result"], "transcript entry");
  required(
    METHODS.has(entry.method),
    "transcript contains an unsupported RPC method",
  );
  required(
    Array.isArray(entry.params) &&
      Buffer.byteLength(stableJson(entry.params)) <= 1024,
    "transcript parameters are invalid or overlong",
  );
  if (entry.method === "eth_getBlockByNumber") {
    exact(entry.result, ["number", "hash"], "block result");
    required(
      typeof entry.result.number === "string" &&
        entry.result.number.length <= 66 &&
        typeof entry.result.hash === "string" &&
        entry.result.hash.length === 66,
      "block result is invalid",
    );
  } else {
    required(
      typeof entry.result === "string" &&
        entry.result.length <= MAX_RESULT_BYTES,
      "RPC result is invalid or overlong",
    );
  }
}

export async function capturePilotPool(config, options, request) {
  validatePoolInspectionRequest(config, options);
  required(typeof request === "function", "RPC request function is required");
  const retainedConfig = structuredClone(config);
  const retainedOptions = structuredClone(options);
  const transcript = [];
  let transcriptBytes = 0;
  const observation = await inspectPilotPool(
    retainedConfig,
    retainedOptions,
    async (method, params) => {
      required(
        transcript.length < MAX_TRANSCRIPT_CALLS,
        "transcript exceeds the call limit",
      );
      const original = await request(method, structuredClone(params));
      // The inspector consumes only number/hash from block objects. Retain these
      // actual response fields and omit irrelevant block metadata and transactions.
      const result =
        method === "eth_getBlockByNumber" &&
        original &&
        typeof original === "object"
          ? { number: original.number, hash: original.hash }
          : original;
      const entry = {
        method,
        params: structuredClone(params),
        result: structuredClone(result),
      };
      validateEntry(entry);
      transcriptBytes += Buffer.byteLength(stableJson(entry));
      required(
        transcriptBytes <= MAX_CAPTURE_BYTES - 64 * 1024,
        "transcript exceeds the byte limit",
      );
      transcript.push(entry);
      return structuredClone(result);
    },
  );
  const body = {
    schemaVersion: 1,
    domain: DOMAIN,
    configurationSha256: digest(retainedConfig),
    request: retainedOptions,
    transcript,
    observation,
  };
  const capture = { ...body, captureSha256: digest(body) };
  boundedCanonical(capture);
  return capture;
}

export async function replayPilotPool(config, options, capture) {
  validatePoolInspectionRequest(config, options);
  // Isolate the opened evidence from mutation while the async inspector runs.
  const retained = JSON.parse(boundedCanonical(capture));
  exact(
    retained,
    [
      "schemaVersion",
      "domain",
      "configurationSha256",
      "request",
      "transcript",
      "observation",
      "captureSha256",
    ],
    "capture",
  );
  required(
    retained.schemaVersion === 1 && retained.domain === DOMAIN,
    "capture schema is unsupported; a v1 observation without a transcript cannot be replayed",
  );
  hash(retained.captureSha256, "capture digest");
  const { captureSha256, ...body } = retained;
  required(digest(body) === captureSha256, "capture digest mismatch");
  required(
    retained.configurationSha256 === digest(config),
    "capture binds another configuration",
  );
  required(
    stableJson(retained.request) === stableJson(options),
    "capture does not match the independently selected block and runtime hash",
  );
  required(
    Array.isArray(retained.transcript) &&
      retained.transcript.length > 0 &&
      retained.transcript.length <= MAX_TRANSCRIPT_CALLS,
    "transcript call count is invalid",
  );
  for (const entry of retained.transcript) validateEntry(entry);
  let cursor = 0;
  const derived = await inspectPilotPool(
    structuredClone(config),
    structuredClone(options),
    async (method, params) => {
      const entry = retained.transcript[cursor++];
      required(entry, "transcript is missing a required RPC response");
      required(
        entry.method === method &&
          stableJson(entry.params) === stableJson(params),
        "transcript RPC order or parameters do not match the inspector",
      );
      return structuredClone(entry.result);
    },
  );
  required(
    cursor === retained.transcript.length,
    "transcript contains unused RPC responses",
  );
  required(
    stableJson(derived) === stableJson(retained.observation),
    "recorded observation does not match replayed evidence",
  );
  return {
    schemaVersion: 1,
    domain: "postern.dex.pilot-pool-offline-replay.v1",
    captureSha256,
    configurationSha256: derived.configurationSha256,
    observationSha256: derived.observationSha256,
    request: structuredClone(options),
    transcriptCallsReplayed: cursor,
    transcriptComplete: true,
    observationReproduced: true,
    authentication: {
      sourceRpcAuthenticated: false,
      finalityAuthenticated: false,
      poolInspectionAuthenticated: false,
      capApprovalAuthenticated: false,
    },
    controls: {
      pilotLiquidityCeremonyAuthorized: false,
      liquidityEnabled: false,
      activationPerformed: false,
      broadcastPerformed: false,
    },
  };
}

export async function readPoolCapture(path, expectedFileSha256) {
  hash(expectedFileSha256, "expected capture file SHA-256");
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  required(
    (await realpath(absolute)) === absolute &&
      before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size > 0n &&
      before.size <= BigInt(MAX_CAPTURE_BYTES) &&
      Number(before.mode & 0o022n) === 0,
    "capture file must be a bounded canonical-path regular file without shared write permission",
  );
  const handle = await open(
    absolute,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
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
  try {
    const opened = await handle.stat({ bigint: true });
    required(
      opened.isFile() && fields.every((key) => opened[key] === before[key]),
      "capture file changed before reading",
    );
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(absolute, { bigint: true });
    required(
      size === Number(opened.size) &&
        fields.every(
          (key) => opened[key] === after[key] && after[key] === named[key],
        ),
      "capture file changed while reading",
    );
    const retained = bytes.subarray(0, size);
    required(
      `0x${sha256(retained)}` === expectedFileSha256,
      "capture file hash mismatch",
    );
    let value;
    try {
      value = JSON.parse(retained.toString("utf8"));
    } catch {
      throw new Error("pilot pool replay: capture is invalid JSON");
    }
    required(
      retained.toString("utf8") === `${boundedCanonical(value)}\n`,
      "capture file is not canonical JSON",
    );
    return value;
  } finally {
    await handle.close();
  }
}
